/**
 * OpenAIEmbeddingAdapter — text-embedding-3-small（16 / 24 §6.1 EMBEDDING）。
 *
 * - OpenAIClientPort を DI 注入（実 SDK / mock 差し替え可能 / 課題要件）。
 * - per-call timeout は AbortController で付与（Router 既定 or request 上書き）。
 * - 出力次元は 1536 固定。万一 provider が異次元を返したら schema_invalid で弾く
 *   （05 §5.5 HNSW index 次元一致の構造防御）。
 * - usage / cost を ProviderCallMeta に詰めて返す（24 §15 監査ログ）。
 */
import { Inject, Injectable } from '@nestjs/common'
import {
  OPENAI_CLIENT,
  type OpenAIClientPort,
} from '../openai/openai-client.port'
import { estimateCostUsd } from '../openai/openai-pricing'
import { ProviderError } from '../provider.types'
import type { ProviderCallMeta } from '../provider.types'
import {
  type EmbeddingProvider,
  type EmbedRequest,
  type EmbeddingResult,
} from './embedding-provider.interface'
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
} from './embedding.types'

/** per-call timeout 既定（24 §6.1 max_latency / §9 latency 閾値より保守的に）。 */
const DEFAULT_EMBED_TIMEOUT_MS = 10_000

@Injectable()
export class OpenAIEmbeddingAdapter implements EmbeddingProvider {
  readonly provider = 'openai' as const
  readonly model = OPENAI_EMBEDDING_MODEL
  readonly dimensions = OPENAI_EMBEDDING_DIMENSIONS

  constructor(
    @Inject(OPENAI_CLIENT) private readonly client: OpenAIClientPort,
  ) {}

  async embed(request: EmbedRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      throw new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: 'embed: texts must not be empty',
        retryable: false,
      })
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    try {
      const res = await this.client.createEmbeddings({
        model: this.model,
        input: request.texts,
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt

      if (res.embeddings.length !== request.texts.length) {
        throw new ProviderError({
          kind: 'schema_invalid',
          provider: 'openai',
          message: `embed: expected ${request.texts.length} vectors, got ${res.embeddings.length}`,
          retryable: false,
        })
      }
      for (const vec of res.embeddings) {
        if (vec.length !== this.dimensions) {
          throw new ProviderError({
            kind: 'schema_invalid',
            provider: 'openai',
            message: `embed: expected ${this.dimensions} dims, got ${vec.length}`,
            retryable: false,
          })
        }
      }

      const inputTokens = res.usage.prompt_tokens
      const meta: ProviderCallMeta = {
        provider: 'openai',
        model: res.model,
        fallback_used: false,
        input_tokens: inputTokens,
        output_tokens: 0,
        latency_ms: latencyMs,
      }
      const cost = estimateCostUsd(res.model, inputTokens, 0)
      if (cost !== undefined) meta.estimated_cost = cost

      return {
        embeddings: res.embeddings,
        dimensions: this.dimensions,
        meta,
      }
    } catch (err) {
      throw this.toProviderError(err, controller.signal.aborted)
    } finally {
      clearTimeout(timer)
    }
  }

  /** SDK/任意エラーを型付き ProviderError に正規化。 */
  private toProviderError(err: unknown, aborted: boolean): ProviderError {
    if (err instanceof ProviderError) return err
    if (aborted) {
      return new ProviderError({
        kind: 'timeout',
        provider: 'openai',
        message: 'embed: provider call timed out',
        retryable: true,
        cause: err,
      })
    }
    const status = extractStatus(err)
    // DEBUG: 一時的に actual error を logs に吐く（diagnosis 後に revert すること）
    // eslint-disable-next-line no-console
    console.error('[OpenAI Embedding debug]', {
      status,
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      code: (err as { code?: unknown })?.code,
      type: (err as { type?: unknown })?.type,
    })
    return new ProviderError({
      kind: status === 429 ? 'rate_limit' : 'api_error',
      provider: 'openai',
      message: err instanceof Error ? err.message : 'embed: provider error',
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
