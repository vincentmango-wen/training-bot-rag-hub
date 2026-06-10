/**
 * ProviderRouter — Provider 選定 + fallback + retry + circuit-breaker + usage 記録。
 *
 * 24 §7 Provider 選択アルゴリズム / §10 Fallback / §15 監査ログ を実装する。
 *
 * 責務:
 *   1. task_type から policy（primary + fallbacks）を引く（provider-policy）。
 *   2. 各候補 provider を順に試す。circuit breaker が OPEN の provider は skip。
 *   3. 各 provider 呼び出しに per-call timeout（adapter 側）+ retry（rate_limit/
 *      timeout/一過性 api_error のみ / exponential backoff + jitter / 10 §3.2）。
 *   4. 成功/失敗を breaker と usage recorder に反映（at-least-once / PP-AC-004）。
 *   5. 全 provider 失敗時は ProviderError を throw（API 層が 502/504 + retrieval-only
 *      フォールバック判断 / 24 §10.4）。
 *
 * 本 Router は LLM と Embedding 双方を扱う（task_type=EMBEDDING は埋め込み経路）。
 * 未実装 provider（MVP=openai 以外）は registry に存在しないため自動 skip される。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import type { ZodTypeAny } from 'zod'
import {
  ProviderError,
  type ProviderCallMeta,
  type ProviderHealth,
  type ProviderName,
  type RagTaskType,
} from '../provider.types'
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '../embedding/embedding-provider.interface'
import {
  LLM_PROVIDER,
  type LlmGenerateRequest,
  type LlmGenerateResult,
  type LlmProvider,
} from '../llm/llm-provider.interface'
import {
  PROVIDER_USAGE_RECORDER,
  type ProviderUsageRecorder,
} from '../usage/provider-usage-recorder.interface'
import type { ProviderUsageRecord } from '../usage/provider-usage.types'
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_OPTIONS,
} from './circuit-breaker'
import { getTaskPolicy, type ProviderChoice } from './provider-policy'

/** retry/backoff の既定（10 §3.2 推奨: 初回 1s / 最大 30s / 最大 3 回 + jitter）。 */
export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** jitter ソース（テスト用に注入可 / 既定 Math.random）。 */
  random?: () => number
  /** sleep 実装（テスト用に注入可 / 既定 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
}

/** RetryOptions の DI トークン（未提供時は DEFAULT_RETRY_OPTIONS を使う / @Optional）。 */
export const PROVIDER_RETRY_OPTIONS = Symbol('PROVIDER_RETRY_OPTIONS')

/** trace/request 相関（24 §15 / 10 §3.4.2）。呼び出し側が発行して渡す。 */
export interface RouteContext {
  trace_id: string
  request_id: string
}

@Injectable()
export class ProviderRouter {
  private readonly logger = new Logger(ProviderRouter.name)
  /** provider 単位の circuit breaker（lazy 生成）。 */
  private readonly breakers = new Map<ProviderName, CircuitBreaker>()
  private readonly retry: RetryOptions

  constructor(
    @Inject(LLM_PROVIDER)
    private readonly llmProviders: LlmProvider[],
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProviders: EmbeddingProvider[],
    @Inject(PROVIDER_USAGE_RECORDER)
    private readonly usageRecorder: ProviderUsageRecorder,
    @Optional()
    @Inject(PROVIDER_RETRY_OPTIONS)
    retry?: RetryOptions,
  ) {
    this.retry = retry ?? DEFAULT_RETRY_OPTIONS
  }

  /* ----------------------------------------------------------------------- */
  /* Public: LLM structured generation（fallback 込み）                       */
  /* ----------------------------------------------------------------------- */
  async generateStructured<TSchema extends ZodTypeAny>(
    taskType: Exclude<RagTaskType, 'EMBEDDING'>,
    request: LlmGenerateRequest<TSchema>,
    ctx: RouteContext,
  ): Promise<LlmGenerateResult<TSchema>> {
    const policy = getTaskPolicy(taskType)
    const chain = [policy.primary, ...policy.fallbacks]
    const startedAtIso = new Date().toISOString()
    let lastError: ProviderError | undefined

    for (let i = 0; i < chain.length; i++) {
      const choice = chain[i]!
      const provider = this.findLlmProvider(choice)
      if (provider === undefined) continue // 未実装 provider は skip

      const breaker = this.breakerFor(choice.provider)
      if (!breaker.canAttempt()) {
        this.logger.warn(
          `circuit OPEN for ${choice.provider}; skipping (task=${taskType})`,
        )
        continue
      }

      const fallbackUsed = i > 0
      const reqForChoice = {
        ...request,
        // policy が task 別に決めたモデルを使う（request.model 明示時はそちら優先）
        model: request.model ?? choice.model,
        timeoutMs: request.timeoutMs ?? policy.maxLatencyMs,
      }

      try {
        const result = await this.withRetry(choice.provider, () =>
          provider.generateStructured(reqForChoice),
        )
        breaker.onSuccess()
        const meta = { ...result.meta, fallback_used: fallbackUsed }
        await this.recordSuccess(taskType, 'chat', meta, ctx, startedAtIso)
        return { data: result.data, meta }
      } catch (err) {
        const provErr = asProviderError(err, choice.provider)
        breaker.onFailure()
        await this.recordFailure(
          taskType,
          'chat',
          choice,
          provErr,
          fallbackUsed,
          ctx,
          startedAtIso,
        )
        lastError = provErr
        // safety_block は fallback しても同じ入力で再ブロックされるため打ち切り
        if (provErr.kind === 'safety_block') throw provErr
      }
    }

    throw (
      lastError ??
      new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: `no available LLM provider for task ${taskType}`,
        retryable: false,
      })
    )
  }

  /* ----------------------------------------------------------------------- */
  /* Public: Embedding（fallback 込み）                                       */
  /* ----------------------------------------------------------------------- */
  async embed(
    texts: string[],
    ctx: RouteContext,
  ): Promise<EmbeddingResult> {
    const policy = getTaskPolicy('EMBEDDING')
    const chain = [policy.primary, ...policy.fallbacks]
    const startedAtIso = new Date().toISOString()
    let lastError: ProviderError | undefined

    for (let i = 0; i < chain.length; i++) {
      const choice = chain[i]!
      const provider = this.findEmbeddingProvider(choice)
      if (provider === undefined) continue

      const breaker = this.breakerFor(choice.provider)
      if (!breaker.canAttempt()) continue

      const fallbackUsed = i > 0
      try {
        const result = await this.withRetry(choice.provider, () =>
          provider.embed({ texts, timeoutMs: policy.maxLatencyMs }),
        )
        breaker.onSuccess()
        const meta = { ...result.meta, fallback_used: fallbackUsed }
        await this.recordSuccess('EMBEDDING', 'embedding', meta, ctx, startedAtIso)
        return { ...result, meta }
      } catch (err) {
        const provErr = asProviderError(err, choice.provider)
        breaker.onFailure()
        await this.recordFailure(
          'EMBEDDING',
          'embedding',
          choice,
          provErr,
          fallbackUsed,
          ctx,
          startedAtIso,
        )
        lastError = provErr
      }
    }

    throw (
      lastError ??
      new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: 'no available embedding provider',
        retryable: false,
      })
    )
  }

  /* ----------------------------------------------------------------------- */
  /* Public: Provider health（24 §9 / health endpoint 用）                    */
  /* ----------------------------------------------------------------------- */
  health(provider: ProviderName): ProviderHealth {
    return this.breakerFor(provider).health()
  }

  /* ----------------------------------------------------------------------- */
  /* Internal                                                                */
  /* ----------------------------------------------------------------------- */

  private breakerFor(provider: ProviderName): CircuitBreaker {
    let breaker = this.breakers.get(provider)
    if (breaker === undefined) {
      breaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT_OPTIONS })
      this.breakers.set(provider, breaker)
    }
    return breaker
  }

  private findLlmProvider(
    choice: ProviderChoice,
  ): LlmProvider | undefined {
    return this.llmProviders.find((p) => p.provider === choice.provider)
  }

  private findEmbeddingProvider(
    choice: ProviderChoice,
  ): EmbeddingProvider | undefined {
    return this.embeddingProviders.find((p) => p.provider === choice.provider)
  }

  /** per-provider の retry（retryable な ProviderError のみ / exponential backoff + jitter）。 */
  private async withRetry<T>(
    provider: ProviderName,
    fn: () => Promise<T>,
  ): Promise<T> {
    const random = this.retry.random ?? Math.random
    const sleep =
      this.retry.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

    let lastError: ProviderError | undefined
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const provErr = asProviderError(err, provider)
        lastError = provErr
        const canRetry =
          provErr.retryable && attempt < this.retry.maxAttempts
        if (!canRetry) throw provErr
        const backoff = Math.min(
          this.retry.maxDelayMs,
          this.retry.baseDelayMs * 2 ** (attempt - 1),
        )
        const jittered = backoff * (0.5 + random() * 0.5)
        this.logger.warn(
          `retry ${attempt}/${this.retry.maxAttempts} for ${provider} after ${Math.round(jittered)}ms (kind=${provErr.kind})`,
        )
        await sleep(jittered)
      }
    }
    // maxAttempts に達して全て retryable で失敗した場合（理論上ここに到達）
    throw (
      lastError ??
      new ProviderError({
        kind: 'api_error',
        provider,
        message: 'retry exhausted',
        retryable: false,
      })
    )
  }

  private async recordSuccess(
    taskType: RagTaskType,
    callType: ProviderUsageRecord['call_type'],
    meta: ProviderCallMeta,
    ctx: RouteContext,
    startedAtIso: string,
  ): Promise<void> {
    const record: ProviderUsageRecord = {
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
      task_type: taskType,
      call_type: callType,
      provider: meta.provider,
      model: meta.model,
      status: meta.fallback_used ? 'FALLBACK_USED' : 'SUCCESS',
      fallback_used: meta.fallback_used,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      latency_ms: meta.latency_ms,
      started_at: startedAtIso,
    }
    if (meta.estimated_cost !== undefined) {
      record.estimated_cost = meta.estimated_cost
    }
    await this.safeRecord(record)
  }

  private async recordFailure(
    taskType: RagTaskType,
    callType: ProviderUsageRecord['call_type'],
    choice: ProviderChoice,
    err: ProviderError,
    fallbackUsed: boolean,
    ctx: RouteContext,
    startedAtIso: string,
  ): Promise<void> {
    await this.safeRecord({
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
      task_type: taskType,
      call_type: callType,
      provider: choice.provider,
      model: choice.model,
      status: 'FAILED',
      fallback_used: fallbackUsed,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      error_type: err.kind,
      error_message: err.message,
      started_at: startedAtIso,
    })
  }

  /** record の失敗で本処理を落とさない（at-least-once / 記録失敗はログのみ）。 */
  private async safeRecord(record: ProviderUsageRecord): Promise<void> {
    try {
      await this.usageRecorder.record(record)
    } catch (err) {
      this.logger.error(
        `usage record failed (provider=${record.provider} status=${record.status}): ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      )
    }
  }
}

function asProviderError(err: unknown, provider: ProviderName): ProviderError {
  if (err instanceof ProviderError) return err
  return new ProviderError({
    kind: 'api_error',
    provider,
    message: err instanceof Error ? err.message : 'unknown provider error',
    retryable: false,
    cause: err,
  })
}
