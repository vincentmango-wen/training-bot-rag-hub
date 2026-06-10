/**
 * OpenAILlmAdapter — structured output 強制（21 §出力 Schema / 24 §6.1）。
 *
 * - OpenAIClientPort を DI 注入（実 SDK / mock 差し替え可能 / 課題要件）。
 * - 温度・seed 固定（24 温度/seed 固定 / 再現性）。request.temperature 明示時のみ上書き。
 * - response_format = json_schema(strict) を必須付与。返り JSON を JSON.parse →
 *   Zod schema で再検証し、不適合は ProviderError(schema_invalid)（21 §12 出力検証）。
 * - finish_reason='content_filter' は safety_block（13 セキュリティ Policy）。
 * - per-call timeout は AbortController（Router 既定 or request 上書き）。
 */
import { Inject, Injectable } from '@nestjs/common'
import type { ZodTypeAny, infer as ZodInfer } from 'zod'
import {
  OPENAI_CLIENT,
  type OpenAIClientPort,
} from '../openai/openai-client.port'
import { estimateCostUsd } from '../openai/openai-pricing'
import { ProviderError } from '../provider.types'
import type { ProviderCallMeta } from '../provider.types'
import {
  type LlmGenerateRequest,
  type LlmGenerateResult,
  type LlmProvider,
} from './llm-provider.interface'
import {
  LLM_FIXED_SEED,
  LLM_FIXED_TEMPERATURE,
  OPENAI_LLM_MODEL_DEFAULT,
} from './llm.types'
import { zodToOpenAiJsonSchema } from './zod-to-openai-schema'

const DEFAULT_LLM_TIMEOUT_MS = 10_000

@Injectable()
export class OpenAILlmAdapter implements LlmProvider {
  readonly provider = 'openai' as const
  /** 既定モデル。task 別の上書きは generateStructured の request.model で行う。 */
  readonly model = OPENAI_LLM_MODEL_DEFAULT

  constructor(
    @Inject(OPENAI_CLIENT) private readonly client: OpenAIClientPort,
  ) {}

  async generateStructured<TSchema extends ZodTypeAny>(
    request: LlmGenerateRequest<TSchema>,
  ): Promise<LlmGenerateResult<TSchema>> {
    if (request.messages.length === 0) {
      throw new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: 'generateStructured: messages must not be empty',
        retryable: false,
      })
    }

    const jsonSchema = zodToOpenAiJsonSchema(request.schema)
    const timeoutMs = request.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    try {
      const res = await this.client.createChatCompletion({
        model: request.model ?? this.model,
        messages: request.messages,
        temperature: request.temperature ?? LLM_FIXED_TEMPERATURE,
        seed: LLM_FIXED_SEED,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: request.schemaName,
            schema: jsonSchema as unknown as Record<string, unknown>,
            strict: true,
          },
        },
        ...(request.maxTokens !== undefined
          ? { max_tokens: request.maxTokens }
          : {}),
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt

      if (res.finish_reason === 'content_filter') {
        throw new ProviderError({
          kind: 'safety_block',
          provider: 'openai',
          message: 'generateStructured: blocked by provider safety filter',
          retryable: false,
        })
      }

      const parsed = this.parseAndValidate(request.schema, res.content)

      const meta: ProviderCallMeta = {
        provider: 'openai',
        model: res.model,
        fallback_used: false,
        input_tokens: res.usage.prompt_tokens,
        output_tokens: res.usage.completion_tokens,
        latency_ms: latencyMs,
      }
      const cost = estimateCostUsd(
        res.model,
        res.usage.prompt_tokens,
        res.usage.completion_tokens,
      )
      if (cost !== undefined) meta.estimated_cost = cost

      return { data: parsed, meta }
    } catch (err) {
      throw this.toProviderError(err, controller.signal.aborted)
    } finally {
      clearTimeout(timer)
    }
  }

  private parseAndValidate<TSchema extends ZodTypeAny>(
    schema: TSchema,
    raw: string,
  ): ZodInfer<TSchema> {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (cause) {
      throw new ProviderError({
        kind: 'schema_invalid',
        provider: 'openai',
        message: 'generateStructured: response is not valid JSON',
        retryable: false,
        cause,
      })
    }
    const result = schema.safeParse(json)
    if (!result.success) {
      throw new ProviderError({
        kind: 'schema_invalid',
        provider: 'openai',
        message: `generateStructured: output failed schema validation: ${result.error.message}`,
        retryable: false,
        cause: result.error,
      })
    }
    return result.data
  }

  private toProviderError(err: unknown, aborted: boolean): ProviderError {
    if (err instanceof ProviderError) return err
    if (aborted) {
      return new ProviderError({
        kind: 'timeout',
        provider: 'openai',
        message: 'generateStructured: provider call timed out',
        retryable: true,
        cause: err,
      })
    }
    const status = extractStatus(err)
    return new ProviderError({
      kind: status === 429 ? 'rate_limit' : 'api_error',
      provider: 'openai',
      message:
        err instanceof Error
          ? err.message
          : 'generateStructured: provider error',
      retryable: status === 429 || status === undefined || status >= 500,
      ...(status !== undefined ? { statusCode: status } : {}),
      cause: err,
    })
  }
}

function extractStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object') {
    const status = (err as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}
