/**
 * e2e: POST /api/v1/rag/bot-context（RAG-API-002）
 *
 * 検証シナリオ:
 *   1. 正常系 — 200 / meta.trace_id / request_id 存在
 *   2. order_permission が常に literal false（横断規約5）
 *   3. action_policy = ORDER_NOT_ALLOWED_BY_RAG（10 §6.2）
 *   4. Idempotency-Key 欠落 → 400（負の制御）
 *   5. bot_id 欠落（必須フィールド）→ 400 + details[].field=bot_id
 *   6. bot_signal が不正 enum → 400 INVALID_ENUM
 *   7. 冪等 replay（同一キー + 同一 payload）→ idempotency_replayed=true
 *
 * mock 方針: RagOrchestrator を jest.fn() で差し替え（DB / OpenAI 非接続）。
 */
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { RagOrchestrator } from '../src/modules/rag/application/rag-orchestrator.service'
import { PrismaService } from '../src/modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../src/modules/rag/infrastructure/providers/openai/openai-client.port'
import type { BotContextResponseData } from '@pmtp/shared'

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const BASE = '/api/v1/rag/bot-context'

const VALID_BODY = {
  bot_id: '11111111-1111-4111-8111-111111111111',
  bot_signal: 'BUY',
  symbol: 'BTC/USDT',
  timeframe: '1h',
}

function makeBotContextData(): { data: BotContextResponseData; replayed: boolean } {
  return {
    data: {
      context_id: randomUUID(),
      trace_id: 'trace-from-orchestrator',
      bot_id: VALID_BODY.bot_id,
      bot_signal: 'BUY',
      explanation: 'BUY signal supported by strong momentum.',
      supporting_factors: ['RSI > 60', 'MACD cross'],
      opposing_factors: ['high funding rate'],
      similar_cases: [],
      risk_level: 'MEDIUM',
      confidence: 0.65,
      // 常に literal false（横断規約5 / 二次防御）
      order_permission: false,
      action_policy: 'ORDER_NOT_ALLOWED_BY_RAG',
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        fallback_used: false,
        input_tokens: 100,
        output_tokens: 50,
        latency_ms: 700,
      },
    },
    replayed: false,
  }
}

/* -------------------------------------------------------------------------- */
/* test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/rag/bot-context (e2e)', () => {
  let app: INestApplication
  let orchestratorMock: jest.Mocked<Pick<RagOrchestrator, 'runQuery' | 'runBotContext'>>

  beforeAll(async () => {
    orchestratorMock = {
      runQuery: jest.fn(),
      runBotContext: jest.fn(),
    } as unknown as jest.Mocked<Pick<RagOrchestrator, 'runQuery' | 'runBotContext'>>

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RagOrchestrator)
      .useValue(orchestratorMock)
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(OPENAI_CLIENT)
      .useValue({ createChatCompletion: jest.fn(), createEmbeddings: jest.fn() })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api/v1', { exclude: ['health'] })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  /* ---------------------------------------------------------------------- */
  /* 1. 正常系 — I/O 契約                                                    */
  /* ---------------------------------------------------------------------- */
  it('200 — meta.trace_id / request_id が UUID 形式で存在する', async () => {
    orchestratorMock.runBotContext.mockResolvedValueOnce(makeBotContextData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bot-ctx-1')
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { success: boolean; data: BotContextResponseData; meta: Record<string, unknown> }
    expect(body.success).toBe(true)
    expect(typeof body.meta.trace_id).toBe('string')
    expect(typeof body.meta.request_id).toBe('string')
    expect(body.meta.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(body.meta.idempotency_key).toBe('idem-bot-ctx-1')
    expect(body.meta.idempotency_replayed).toBe(false)
    expect(body.data.explanation).toBe('BUY signal supported by strong momentum.')
  })

  /* ---------------------------------------------------------------------- */
  /* 2. order_permission は常に false                                         */
  /* ---------------------------------------------------------------------- */
  it('data.order_permission は常に literal false（横断規約5）', async () => {
    orchestratorMock.runBotContext.mockResolvedValueOnce(makeBotContextData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bot-orderperm-1')
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { data: BotContextResponseData }
    // Zod literal(false) で型保証 / e2e では JSON value を検証
    expect(body.data.order_permission).toBe(false)
    expect(body.data.order_permission).not.toBe(true)
  })

  /* ---------------------------------------------------------------------- */
  /* 3. action_policy 固定値                                                  */
  /* ---------------------------------------------------------------------- */
  it('data.action_policy = ORDER_NOT_ALLOWED_BY_RAG（10 §6.2）', async () => {
    orchestratorMock.runBotContext.mockResolvedValueOnce(makeBotContextData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bot-policy-1')
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { data: BotContextResponseData }
    expect(body.data.action_policy).toBe('ORDER_NOT_ALLOWED_BY_RAG')
  })

  /* ---------------------------------------------------------------------- */
  /* 4. Idempotency-Key 欠落 → 400（負の制御）                               */
  /* ---------------------------------------------------------------------- */
  it('400 — Idempotency-Key ヘッダ欠落は RAG_VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .send(VALID_BODY)
      .expect(400)

    const body = res.body as { success: boolean; error: Record<string, unknown>; meta: Record<string, unknown> }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    // エラーでも meta.trace_id を返す（10 §3.4 注記）
    expect(typeof body.meta.trace_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 5. bot_id 欠落 → 400（負の制御）                                        */
  /* ---------------------------------------------------------------------- */
  it('400 — bot_id 欠落は RAG_VALIDATION_ERROR + details[].field=bot_id', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bot-no-botid-1')
      .send({ bot_signal: 'BUY' }) // bot_id なし
      .expect(400)

    const body = res.body as {
      success: boolean
      error: { code: string; details?: Array<{ field: string }> }
      meta: Record<string, unknown>
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    const fields = (body.error.details ?? []).map((d) => d.field)
    expect(fields).toContain('bot_id')
  })

  /* ---------------------------------------------------------------------- */
  /* 6. bot_signal 不正 enum → 400                                            */
  /* ---------------------------------------------------------------------- */
  it('400 — bot_signal に不正な enum 値は RAG_VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bot-bad-signal-1')
      .send({ ...VALID_BODY, bot_signal: 'INVALID_SIGNAL' })
      .expect(400)

    const body = res.body as {
      success: boolean
      error: { code: string; details?: Array<{ field: string; code: string }> }
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    const enumErr = (body.error.details ?? []).find((d) => d.field === 'bot_signal')
    expect(enumErr).toBeDefined()
  })

  /* ---------------------------------------------------------------------- */
  /* 7. 冪等 replay                                                           */
  /* ---------------------------------------------------------------------- */
  it('200 — 同一キー + 同一 payload の 2 回目は idempotency_replayed=true', async () => {
    const replayKey = 'idem-bot-replay-' + randomUUID()
    orchestratorMock.runBotContext.mockResolvedValueOnce(makeBotContextData())
    await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', replayKey)
      .send(VALID_BODY)
      .expect(200)

    orchestratorMock.runBotContext.mockResolvedValueOnce({ ...makeBotContextData(), replayed: true })
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', replayKey)
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { meta: Record<string, unknown> }
    expect(body.meta.idempotency_replayed).toBe(true)
  })
})
