/**
 * e2e: GET /api/v1/rag/history（RAG-API-004）
 *
 * 検証シナリオ:
 *   1. 正常系 — 200 / meta.trace_id / request_id 存在
 *   2. ページネーション構造（items[] + pagination.{page,limit,total}）
 *   3. page / limit クエリパラメータが反映される
 *   4. items が空の場合も 200（空配列 + pagination）
 *   5. 不正な page（文字列 / 負数）→ 400 RAG_VALIDATION_ERROR（Zod coerce）
 *   6. GET のため Idempotency-Key 不要（meta に idempotency_* フィールドなし）
 *
 * mock 方針: HistoryService を overrideProvider で差し替え（DB 非接続）。
 */
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { HistoryService } from '../src/modules/rag/application/history.service'
import { PrismaService } from '../src/modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../src/modules/rag/infrastructure/providers/openai/openai-client.port'
import type { HistoryResponseData } from '@pmtp/shared'

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const BASE = '/api/v1/rag/history'

function makeItem(n = 0): HistoryResponseData['items'][number] {
  return {
    query_id: randomUUID(),
    created_at: `2026-06-0${(n % 9) + 1}T00:00:00.000Z`,
    query: `What is the market trend for BTC? (${n})`,
    risk_level: 'MEDIUM',
    confidence: 0.7,
    provider: 'openai',
    model: 'gpt-4o-mini',
    guardrail_status: 'PASS',
  }
}

function makeHistoryData(
  opts: { page?: number; limit?: number; total?: number; count?: number } = {},
): HistoryResponseData {
  const page = opts.page ?? 1
  const limit = opts.limit ?? 20
  const total = opts.total ?? opts.count ?? 1
  const count = opts.count ?? 1
  return {
    items: Array.from({ length: count }, (_, i) => makeItem(i)),
    pagination: { page, limit, total },
  }
}

/* -------------------------------------------------------------------------- */
/* test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('GET /api/v1/rag/history (e2e)', () => {
  let app: INestApplication
  let serviceMock: jest.Mocked<Pick<HistoryService, 'list'>>

  beforeAll(async () => {
    serviceMock = {
      list: jest.fn(),
    } as unknown as jest.Mocked<Pick<HistoryService, 'list'>>

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HistoryService)
      .useValue(serviceMock)
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
    serviceMock.list.mockResolvedValueOnce(makeHistoryData({ count: 2, total: 2 }))

    const res = await request(app.getHttpServer())
      .get(BASE)
      .expect(200)

    const body = res.body as { success: boolean; data: HistoryResponseData; meta: Record<string, unknown> }
    expect(body.success).toBe(true)
    expect(typeof body.meta.trace_id).toBe('string')
    expect(typeof body.meta.request_id).toBe('string')
    expect(body.meta.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // GET のため idempotency_key は返らない
    expect(body.meta.idempotency_key).toBeUndefined()
  })

  /* ---------------------------------------------------------------------- */
  /* 2. ページネーション構造                                                  */
  /* ---------------------------------------------------------------------- */
  it('200 — pagination.{page,limit,total} が正しく返される', async () => {
    serviceMock.list.mockResolvedValueOnce(
      makeHistoryData({ page: 2, limit: 5, total: 12, count: 5 }),
    )

    const res = await request(app.getHttpServer())
      .get(BASE)
      .query({ page: '2', limit: '5' })
      .expect(200)

    const body = res.body as { data: HistoryResponseData }
    expect(body.data.pagination.page).toBe(2)
    expect(body.data.pagination.limit).toBe(5)
    expect(body.data.pagination.total).toBe(12)
    expect(body.data.items).toHaveLength(5)
  })

  /* ---------------------------------------------------------------------- */
  /* 3. page / limit クエリパラメータが HistoryService に渡される             */
  /* ---------------------------------------------------------------------- */
  it('service.list に page / limit / symbol が正しく渡される', async () => {
    serviceMock.list.mockResolvedValueOnce(makeHistoryData({ count: 1 }))

    await request(app.getHttpServer())
      .get(BASE)
      .query({ page: '3', limit: '10', symbol: 'ETH/USDT' })
      .expect(200)

    expect(serviceMock.list).toHaveBeenCalledTimes(1)
    const callArg = serviceMock.list.mock.calls[0]![0]!
    expect(callArg.query.page).toBe(3)
    expect(callArg.query.limit).toBe(10)
    expect(callArg.query.symbol).toBe('ETH/USDT')
  })

  /* ---------------------------------------------------------------------- */
  /* 4. items が空の場合も 200                                                */
  /* ---------------------------------------------------------------------- */
  it('200 — items が空配列でも valid', async () => {
    serviceMock.list.mockResolvedValueOnce(
      makeHistoryData({ count: 0, total: 0 }),
    )

    const res = await request(app.getHttpServer())
      .get(BASE)
      .expect(200)

    const body = res.body as { success: boolean; data: HistoryResponseData }
    expect(body.success).toBe(true)
    expect(body.data.items).toEqual([])
    expect(body.data.pagination.total).toBe(0)
  })

  /* ---------------------------------------------------------------------- */
  /* 5. 不正な page → 400（負の制御）                                         */
  /* ---------------------------------------------------------------------- */
  it('400 — page=0 は RAG_VALIDATION_ERROR（Zod coerce + positive 制約）', async () => {
    // page=0 は z.coerce.number().int().positive() で弾かれる
    const res = await request(app.getHttpServer())
      .get(BASE)
      .query({ page: '0' })
      .expect(400)

    const body = res.body as {
      success: boolean
      error: { code: string }
      meta: Record<string, unknown>
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    // エラーでも meta.trace_id を返す
    expect(typeof body.meta.trace_id).toBe('string')
  })

  it('400 — limit=0 は RAG_VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .get(BASE)
      .query({ limit: '0' })
      .expect(400)

    const body = res.body as { success: boolean; error: { code: string } }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
  })

  /* ---------------------------------------------------------------------- */
  /* 6. GET に Idempotency-Key は不要（ヘッダなしで 200）                     */
  /* ---------------------------------------------------------------------- */
  it('200 — GET は Idempotency-Key ヘッダなしで正常', async () => {
    serviceMock.list.mockResolvedValueOnce(makeHistoryData({ count: 1 }))

    // Idempotency-Key なしでリクエスト（guard は POST のみ適用）
    const res = await request(app.getHttpServer())
      .get(BASE)
      .expect(200)

    const body = res.body as { success: boolean; meta: Record<string, unknown> }
    expect(body.success).toBe(true)
    // GET レスポンス meta には idempotency_* フィールドを含まない
    expect(body.meta.idempotency_key).toBeUndefined()
    expect(body.meta.idempotency_replayed).toBeUndefined()
  })

  /* ---------------------------------------------------------------------- */
  /* 7. items の構造確認（HistoryItem 契約）                                  */
  /* ---------------------------------------------------------------------- */
  it('200 — items の各フィールド型が HistoryItem 契約通り', async () => {
    serviceMock.list.mockResolvedValueOnce(makeHistoryData({ count: 1 }))

    const res = await request(app.getHttpServer())
      .get(BASE)
      .expect(200)

    const body = res.body as { data: HistoryResponseData }
    const item = body.data.items[0]!
    expect(typeof item.query_id).toBe('string')
    expect(typeof item.created_at).toBe('string')
    expect(typeof item.query).toBe('string')
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(item.risk_level)
    expect(typeof item.confidence).toBe('number')
    expect(typeof item.provider).toBe('string')
    expect(typeof item.model).toBe('string')
    expect(typeof item.guardrail_status).toBe('string')
  })
})
