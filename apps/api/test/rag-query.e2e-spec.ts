/**
 * e2e: POST /api/v1/rag/query（RAG-API-001）
 *
 * AppModule をそのまま起動し、RagOrchestrator だけを jest.fn() 注入で差し替える。
 * TraceInterceptor / RagExceptionFilter / globalPrefix が全て実動することを確認。
 *
 * 検証シナリオ:
 *   1. 正常系 — 200 レスポンスの I/O 契約（meta.trace_id / meta.request_id 存在）
 *   2. citation 検証メタ（data.guardrail / data.citations[].quality_status）
 *   3. Idempotency-Key 必須 — 欠落は 400 RAG_VALIDATION_ERROR
 *   4. 同一キー + 同一 payload の 2 回目は idempotency_replayed=true（replay: LLM 非再呼出）
 *   5. 同一キー + 別 payload は 409 RAG_IDEMPOTENCY_CONFLICT
 *   6. 不正 body（query 欠落）は 400 RAG_VALIDATION_ERROR
 *   7. guardrail blocked（捏造 citation）→ 422 RAG_GUARDRAIL_BLOCKED（負の制御）
 *   8. X-Client-Type: ui → data.citations[].excerpt あり / training_bot → excerpt なし
 *
 * mock 方針:
 *   - RagOrchestrator を overrideProvider で jest mock に差し替え（DB / OpenAI 呼出なし）
 *   - PrismaService を noop mock（$connect / $disconnect のみ）でオーバーライド（DB 不要）
 *   - OPENAI_CLIENT を noop mock（key 検証エラーを防ぐ）
 *   - Idempotency replay / conflict / guardrail_blocked は orchestrator.runQuery の戻り値 / throw で制御
 */
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { RagOrchestrator } from '../src/modules/rag/application/rag-orchestrator.service'
import { PrismaService } from '../src/modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../src/modules/rag/infrastructure/providers/openai/openai-client.port'
import { RagApiException } from '../src/modules/rag/http/rag-api.exception'
import type { QueryResponseData } from '@pmtp/shared'

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const BASE = '/api/v1/rag/query'
const IDEM_KEY = 'idem-query-e2e-1'
const BOT_ID = '11111111-1111-4111-8111-111111111111'

/** 最小の合法 query body。 */
const VALID_BODY = { query: 'BTC market context', symbol: 'BTC/USDT' }

/** orchestrator.runQuery の標準正常戻り値。 */
function makeQueryData(opts?: { excerpt?: string }): { data: QueryResponseData; replayed: boolean } {
  const citation: QueryResponseData['citations'][number] = {
    source_id: randomUUID(),
    document_id: randomUUID(),
    chunk_id: randomUUID(),
    source_type: 'market_data',
    used_reason: 'directly relevant',
    event_time: '2026-06-09T00:00:00.000Z',
    ingested_at: '2026-06-09T01:00:00.000Z',
    retrieval_score: 0.85,
    quality_status: 'ACTIVE',
  }
  if (opts?.excerpt !== undefined) citation.excerpt = opts.excerpt

  return {
    data: {
      query_id: randomUUID(),
      trace_id: 'trace-from-orchestrator',
      summary: 'Market looks bullish.',
      supporting_factors: ['strong volume'],
      opposing_factors: ['high funding rate'],
      risk_level: 'MEDIUM',
      confidence: 0.72,
      citations: [citation],
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        fallback_used: false,
        input_tokens: 120,
        output_tokens: 60,
        latency_ms: 800,
      },
      guardrail: {
        status: 'PASS',
        order_permission: false,
      },
    },
    replayed: false,
  }
}

/* -------------------------------------------------------------------------- */
/* test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/rag/query (e2e)', () => {
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
  it('200 — meta.trace_id / meta.request_id が UUID 形式で存在する', async () => {
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', IDEM_KEY)
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { success: boolean; data: QueryResponseData; meta: Record<string, unknown> }
    expect(body.success).toBe(true)

    // meta: trace_id / request_id は サーバ発行の UUID（TraceInterceptor）
    expect(typeof body.meta.trace_id).toBe('string')
    expect(typeof body.meta.request_id).toBe('string')
    expect(body.meta.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(body.meta.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )

    // meta: POST なので idempotency_key がエコーバックされる
    expect(body.meta.idempotency_key).toBe(IDEM_KEY)
    expect(body.meta.idempotency_replayed).toBe(false)

    // data コア
    expect(body.data.summary).toBe('Market looks bullish.')
    expect(body.data.risk_level).toBe('MEDIUM')
    expect(body.data.confidence).toBeCloseTo(0.72)
  })

  /* ---------------------------------------------------------------------- */
  /* 2. citation 検証メタ                                                     */
  /* ---------------------------------------------------------------------- */
  it('200 — guardrail / citation の検証メタが契約通り', async () => {
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', IDEM_KEY + '-2')
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { data: QueryResponseData }

    // guardrail: order_permission は常に false（横断規約5）
    expect(body.data.guardrail.order_permission).toBe(false)
    expect(body.data.guardrail.status).toBe('PASS')

    // citation: 最低限のフィールド存在確認
    expect(body.data.citations).toHaveLength(1)
    const c = body.data.citations[0]!
    expect(typeof c.chunk_id).toBe('string')
    expect(typeof c.source_id).toBe('string')
    expect(typeof c.source_type).toBe('string')
    expect(c.quality_status).toBe('ACTIVE')
  })

  /* ---------------------------------------------------------------------- */
  /* 3. Idempotency-Key 欠落 → 400（負の制御）                               */
  /* ---------------------------------------------------------------------- */
  it('400 — Idempotency-Key ヘッダ欠落は RAG_VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .send(VALID_BODY) // Idempotency-Key ヘッダなし
      .expect(400)

    const body = res.body as { success: boolean; error: Record<string, unknown>; meta: Record<string, unknown> }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    // エラーでも meta.trace_id / request_id を必ず返す（10 §3.4 注記）
    expect(typeof body.meta.trace_id).toBe('string')
    expect(typeof body.meta.request_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 4. 冪等 replay（同一キー + 同一 payload）                               */
  /* ---------------------------------------------------------------------- */
  it('200 — 同一キー + 同一 payload の 2 回目は idempotency_replayed=true', async () => {
    const replayKey = 'idem-replay-test-' + randomUUID()
    // 1 回目: replayed=false
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData())
    await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', replayKey)
      .send(VALID_BODY)
      .expect(200)

    // 2 回目: orchestrator が replayed=true を返す（LLM 再呼出なし）
    orchestratorMock.runQuery.mockResolvedValueOnce({ ...makeQueryData(), replayed: true })
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', replayKey)
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { meta: Record<string, unknown> }
    expect(body.meta.idempotency_replayed).toBe(true)
    // orchestrator が 2 回呼ばれていること（replay の判断は orchestrator 内部で行う）
    expect(orchestratorMock.runQuery).toHaveBeenCalledTimes(2)
  })

  /* ---------------------------------------------------------------------- */
  /* 5. 冪等 conflict（同一キー + 別 payload）→ 409（負の制御）              */
  /* ---------------------------------------------------------------------- */
  it('409 — 同一キー + 別 payload は RAG_IDEMPOTENCY_CONFLICT', async () => {
    const conflictKey = 'idem-conflict-test-' + randomUUID()
    // 1 回目は成功
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData())
    await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', conflictKey)
      .send(VALID_BODY)
      .expect(200)

    // 2 回目は orchestrator が 409 例外を投げる
    orchestratorMock.runQuery.mockRejectedValueOnce(
      RagApiException.idempotencyConflict(
        'Same Idempotency-Key reused with a different payload.',
      ),
    )
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', conflictKey)
      .send({ query: 'COMPLETELY DIFFERENT' })
      .expect(409)

    const body = res.body as { success: boolean; error: Record<string, unknown>; meta: Record<string, unknown> }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_IDEMPOTENCY_CONFLICT')
    expect(typeof body.meta.trace_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 6. 不正 body（query 欠落）→ 400                                         */
  /* ---------------------------------------------------------------------- */
  it('400 — query フィールド欠落は RAG_VALIDATION_ERROR + details[].field=query', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-bad-body-1')
      .send({}) // query なし
      .expect(400)

    const body = res.body as {
      success: boolean
      error: { code: string; details?: Array<{ field: string; code: string }> }
      meta: Record<string, unknown>
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    // Zod エラーが details に写像されている
    const fields = (body.error.details ?? []).map((d) => d.field)
    expect(fields).toContain('query')
    expect(typeof body.meta.trace_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 7. guardrail blocked → 422（負の制御）                                  */
  /* ---------------------------------------------------------------------- */
  it('422 — 捏造 citation で guardrail blocked は RAG_GUARDRAIL_BLOCKED', async () => {
    orchestratorMock.runQuery.mockRejectedValueOnce(
      RagApiException.guardrailBlocked(
        'No grounded citations remain after whitelist/quality filtering.',
        ['chunk_id not in retrieval results'],
      ),
    )

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-guardrail-blocked-1')
      .send(VALID_BODY)
      .expect(422)

    const body = res.body as { success: boolean; error: Record<string, unknown>; meta: Record<string, unknown> }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_GUARDRAIL_BLOCKED')
    expect(typeof body.meta.trace_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 8. audience 別 excerpt 出し分け                                          */
  /* ---------------------------------------------------------------------- */
  it('ui audience は citation.excerpt あり / training_bot は excerpt なし', async () => {
    // ui: orchestrator が excerpt 込みで返す
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData({ excerpt: 'some context' }))
    const uiRes = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-audience-ui-1')
      .set('X-Client-Type', 'ui')
      .send(VALID_BODY)
      .expect(200)

    const uiBody = uiRes.body as { data: QueryResponseData }
    expect(uiBody.data.citations[0]?.excerpt).toBe('some context')

    // training_bot: orchestrator が excerpt なしで返す
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData()) // excerpt undefined
    const botRes = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-audience-bot-1')
      .set('X-Client-Type', 'training_bot')
      .send(VALID_BODY)
      .expect(200)

    const botBody = botRes.body as { data: QueryResponseData }
    expect(botBody.data.citations[0]?.excerpt).toBeUndefined()
  })

  /* ---------------------------------------------------------------------- */
  /* 9. order_permission は常に false（LLM 出力に関わらず）                  */
  /* ---------------------------------------------------------------------- */
  it('guardrail.order_permission は常に false（Guardrail 二次防御 / 横断規約5）', async () => {
    orchestratorMock.runQuery.mockResolvedValueOnce(makeQueryData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-orderperm-1')
      .send(VALID_BODY)
      .expect(200)

    const body = res.body as { data: QueryResponseData }
    expect(body.data.guardrail.order_permission).toBe(false)
  })
})
