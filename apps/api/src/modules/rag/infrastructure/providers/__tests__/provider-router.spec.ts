import { z } from 'zod'
import {
  ProviderRouter,
  type RetryOptions,
  type RouteContext,
} from '../routing/provider-router'
import {
  ProviderError,
  type ProviderName,
} from '../provider.types'
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../embedding/embedding-provider.interface'
import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../llm/llm-provider.interface'
import type { ProviderUsageRecorder } from '../usage/provider-usage-recorder.interface'
import type { ProviderUsageRecord } from '../usage/provider-usage.types'

/* --------------------------- test doubles ------------------------------- */

const schema = z.object({ ok: z.boolean() })

class FakeLlm implements LlmProvider {
  readonly model = 'gpt-4o-mini'
  calls = 0
  constructor(
    readonly provider: ProviderName,
    private readonly behavior: () => Promise<LlmGenerateResult<typeof schema>>,
  ) {}
  async generateStructured<TSchema extends z.ZodTypeAny>(
    _req: LlmGenerateRequest<TSchema>,
  ): Promise<LlmGenerateResult<TSchema>> {
    this.calls += 1
    return this.behavior() as unknown as Promise<LlmGenerateResult<TSchema>>
  }
}

class FakeEmbedding implements EmbeddingProvider {
  readonly model = 'text-embedding-3-small'
  readonly dimensions = 1536
  calls = 0
  constructor(
    readonly provider: ProviderName,
    private readonly behavior: () => Promise<EmbeddingResult>,
  ) {}
  async embed(): Promise<EmbeddingResult> {
    this.calls += 1
    return this.behavior()
  }
}

class RecordingRecorder implements ProviderUsageRecorder {
  records: ProviderUsageRecord[] = []
  failNext = false
  async record(usage: ProviderUsageRecord): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('record sink down')
    }
    this.records.push(usage)
  }
}

const ctx: RouteContext = { trace_id: 'trace-1', request_id: 'req-1' }

const llmOk = (provider: ProviderName): LlmGenerateResult<typeof schema> => ({
  data: { ok: true },
  meta: {
    provider,
    model: 'gpt-4o-mini',
    fallback_used: false,
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 1,
    estimated_cost: '0.00000123',
  },
})

const llmReq: LlmGenerateRequest<typeof schema> = {
  messages: [{ role: 'user', content: 'q' }],
  schema,
  schemaName: 's',
}

/** retry を即時化（sleep を no-op、jitter 固定）してテストを速くする。 */
const fastRetry: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 5,
  random: () => 0,
  sleep: async () => {},
}

/* ------------------------------- tests ---------------------------------- */

describe('ProviderRouter — LLM', () => {
  it('routes to primary openai and records SUCCESS usage', async () => {
    const openai = new FakeLlm('openai', async () => llmOk('openai'))
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai], [], recorder, fastRetry)

    const res = await router.generateStructured('BOT_EXPLANATION', llmReq, ctx)

    expect(res.data.ok).toBe(true)
    expect(res.meta.fallback_used).toBe(false)
    expect(openai.calls).toBe(1)
    expect(recorder.records).toHaveLength(1)
    expect(recorder.records[0]).toMatchObject({
      status: 'SUCCESS',
      provider: 'openai',
      task_type: 'BOT_EXPLANATION',
      call_type: 'chat',
      trace_id: 'trace-1',
      request_id: 'req-1',
      estimated_cost: '0.00000123',
    })
  })

  it('retries retryable errors with backoff then succeeds', async () => {
    let n = 0
    const openai = new FakeLlm('openai', async () => {
      n += 1
      if (n < 3) {
        throw new ProviderError({
          kind: 'rate_limit',
          provider: 'openai',
          message: '429',
          retryable: true,
        })
      }
      return llmOk('openai')
    })
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai], [], recorder, fastRetry)

    const res = await router.generateStructured('MARKET_SUMMARY', llmReq, ctx)
    expect(res.data.ok).toBe(true)
    expect(openai.calls).toBe(3)
    // 成功 1 件のみ（retry 中の失敗は最終的に成功扱いで record しない設計）
    expect(recorder.records.filter((r) => r.status === 'SUCCESS')).toHaveLength(
      1,
    )
  })

  it('does NOT retry non-retryable errors and records FAILED', async () => {
    const openai = new FakeLlm('openai', async () => {
      throw new ProviderError({
        kind: 'schema_invalid',
        provider: 'openai',
        message: 'bad',
        retryable: false,
      })
    })
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai], [], recorder, fastRetry)

    await expect(
      router.generateStructured('BOT_EXPLANATION', llmReq, ctx),
    ).rejects.toMatchObject({ kind: 'schema_invalid' })
    expect(openai.calls).toBe(1)
    expect(recorder.records.some((r) => r.status === 'FAILED')).toBe(true)
  })

  it('falls back to secondary provider and marks fallback_used + FALLBACK_USED', async () => {
    const openai = new FakeLlm('openai', async () => {
      throw new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: 'down',
        retryable: false,
      })
    })
    // RISK_REVIEW の fallback は claude（policy）。fake claude を登録して fallback を発火。
    const claude = new FakeLlm('claude', async () => llmOk('claude'))
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai, claude], [], recorder, fastRetry)

    const res = await router.generateStructured('RISK_REVIEW', llmReq, ctx)
    expect(res.meta.fallback_used).toBe(true)
    expect(res.meta.provider).toBe('claude')
    expect(openai.calls).toBe(1)
    expect(claude.calls).toBe(1)
    expect(recorder.records.some((r) => r.status === 'FAILED')).toBe(true)
    expect(recorder.records.some((r) => r.status === 'FALLBACK_USED')).toBe(true)
  })

  it('aborts the chain on safety_block (no fallback)', async () => {
    const openai = new FakeLlm('openai', async () => {
      throw new ProviderError({
        kind: 'safety_block',
        provider: 'openai',
        message: 'blocked',
        retryable: false,
      })
    })
    const claude = new FakeLlm('claude', async () => llmOk('claude'))
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai, claude], [], recorder, fastRetry)

    await expect(
      router.generateStructured('RISK_REVIEW', llmReq, ctx),
    ).rejects.toMatchObject({ kind: 'safety_block' })
    expect(claude.calls).toBe(0) // safety では fallback しない
  })

  it('skips a provider whose circuit is OPEN', async () => {
    const openai = new FakeLlm('openai', async () => {
      throw new ProviderError({
        kind: 'api_error',
        provider: 'openai',
        message: 'down',
        retryable: false,
      })
    })
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([openai], [], recorder, fastRetry)

    // 既定 failureThreshold=5。5 回失敗させて breaker を OPEN にする。
    for (let i = 0; i < 5; i++) {
      await expect(
        router.generateStructured('BOT_EXPLANATION', llmReq, ctx),
      ).rejects.toBeInstanceOf(ProviderError)
    }
    const callsAfterOpen = openai.calls
    // 6 回目: breaker OPEN なので openai は呼ばれず即 throw
    await expect(
      router.generateStructured('BOT_EXPLANATION', llmReq, ctx),
    ).rejects.toBeInstanceOf(ProviderError)
    expect(openai.calls).toBe(callsAfterOpen) // 呼び出し回数が増えない = skip
    expect(router.health('openai')).toBe('UNAVAILABLE')
  })

  it('does not throw when usage recorder itself fails (at-least-once / best effort)', async () => {
    const openai = new FakeLlm('openai', async () => llmOk('openai'))
    const recorder = new RecordingRecorder()
    recorder.failNext = true
    const router = new ProviderRouter([openai], [], recorder, fastRetry)

    const res = await router.generateStructured('BOT_EXPLANATION', llmReq, ctx)
    expect(res.data.ok).toBe(true) // 記録失敗で本処理は落ちない
  })
})

describe('ProviderRouter — Embedding', () => {
  it('routes embedding to openai and records usage', async () => {
    const emb = new FakeEmbedding('openai', async () => ({
      embeddings: [new Array(1536).fill(0)],
      dimensions: 1536,
      meta: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        fallback_used: false,
        input_tokens: 4,
        output_tokens: 0,
        latency_ms: 1,
        estimated_cost: '0.00000008',
      },
    }))
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([], [emb], recorder, fastRetry)

    const res = await router.embed(['hello'], ctx)
    expect(res.embeddings).toHaveLength(1)
    expect(res.meta.provider).toBe('openai')
    expect(recorder.records[0]).toMatchObject({
      task_type: 'EMBEDDING',
      call_type: 'embedding',
      status: 'SUCCESS',
    })
  })

  it('throws when no embedding provider is registered', async () => {
    const recorder = new RecordingRecorder()
    const router = new ProviderRouter([], [], recorder, fastRetry)
    await expect(router.embed(['x'], ctx)).rejects.toBeInstanceOf(ProviderError)
  })
})
