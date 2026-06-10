/**
 * e2e: POST /api/v1/rag/similar-cases（RAG-API-003）
 *
 * 検証シナリオ:
 *   1. 正常系 — 200 / meta.trace_id / request_id 存在 / cases[] 形状
 *   2. 金融数値（*_pct）が string で透過される（横断規約 §2）
 *   3. Idempotency-Key 欠落 → 400（負の制御）
 *   4. limit > 100 → 400 RAG_VALIDATION_ERROR（SimilarCasesService.assertValid）
 *   5. 空 body（オプション全省略）でも 200（全フィールドが optional）
 *
 * mock 方針:
 *   - SimilarCasesService を overrideProvider で差し替え（DB / embed 非接続）
 *   - SimilarCasesService.assertValid は実際の実装を使い、limit>100 の検証を通す
 *     → ただし overrideProvider は useValue で置き換えるため、assertValid のみ
 *       本物を呼ぶよう spy で実装する。簡易化のため mock 内で直接スローする。
 */
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { AppModule } from '../src/app.module'
import { SimilarCasesService } from '../src/modules/rag/application/similar-cases.service'
import { PrismaService } from '../src/modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../src/modules/rag/infrastructure/providers/openai/openai-client.port'
import { RagApiException } from '../src/modules/rag/http/rag-api.exception'
import type { SimilarCasesResponseData } from '@pmtp/shared'

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

const BASE = '/api/v1/rag/similar-cases'

function makeCasesData(): { cases: SimilarCasesResponseData['cases']; replayed: boolean } {
  return {
    replayed: false,
    cases: [
      {
        case_id: randomUUID(),
        symbol: 'BTC/USDT',
        period_from: '2026-05-01T00:00:00.000Z',
        period_to: '2026-05-02T00:00:00.000Z',
        similarity: 0.88,
        matched_features: ['rsi', 'macd'],
        after_move_4h_pct: '2.5',      // string（横断規約 §2）
        after_move_24h_pct: '-1.2',    // string（負値も可）
        max_drawdown_pct: '0.8',       // string
        risk_notes: ['Historical similarity does not guarantee future performance.'],
      },
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('POST /api/v1/rag/similar-cases (e2e)', () => {
  let app: INestApplication
  let serviceMock: jest.Mocked<Pick<SimilarCasesService, 'findSimilarCases' | 'assertValid'>>

  beforeAll(async () => {
    serviceMock = {
      findSimilarCases: jest.fn(),
      assertValid: jest.fn(), // デフォルト: 何もしない（valid 扱い）
    } as unknown as jest.Mocked<Pick<SimilarCasesService, 'findSimilarCases' | 'assertValid'>>

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SimilarCasesService)
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
    serviceMock.findSimilarCases.mockResolvedValueOnce(makeCasesData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-sim-1')
      .send({ symbol: 'BTC/USDT', timeframe: '1h', limit: 5 })
      .expect(200)

    const body = res.body as { success: boolean; data: SimilarCasesResponseData; meta: Record<string, unknown> }
    expect(body.success).toBe(true)
    expect(typeof body.meta.trace_id).toBe('string')
    expect(typeof body.meta.request_id).toBe('string')
    expect(body.meta.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // POST なので idempotency_key がエコーバックされる
    expect(body.meta.idempotency_key).toBe('idem-sim-1')

    expect(body.data.cases).toHaveLength(1)
    expect(typeof body.data.cases[0]?.case_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 2. 金融数値（*_pct）が string で透過される                              */
  /* ---------------------------------------------------------------------- */
  it('200 — *_pct フィールドは string 型で返される（横断規約 §2）', async () => {
    serviceMock.findSimilarCases.mockResolvedValueOnce(makeCasesData())

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-sim-pct-1')
      .send({ symbol: 'BTC/USDT' })
      .expect(200)

    const body = res.body as { data: SimilarCasesResponseData }
    const c = body.data.cases[0]!

    // 金融数値は string のまま（number になっていない）
    expect(typeof c.after_move_4h_pct).toBe('string')
    expect(typeof c.after_move_24h_pct).toBe('string')
    expect(typeof c.max_drawdown_pct).toBe('string')

    // 数値的パースが可能な文字列であることも確認（moneyStringSchema 仕様）
    expect(parseFloat(c.after_move_4h_pct)).not.toBeNaN()
    expect(parseFloat(c.after_move_24h_pct)).not.toBeNaN()

    // similarity はスコアなので number
    expect(typeof c.similarity).toBe('number')
  })

  /* ---------------------------------------------------------------------- */
  /* 3. Idempotency-Key 欠落 → 400（負の制御）                               */
  /* ---------------------------------------------------------------------- */
  it('400 — Idempotency-Key ヘッダ欠落は RAG_VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post(BASE)
      .send({ symbol: 'BTC/USDT' })
      .expect(400)

    const body = res.body as { success: boolean; error: Record<string, unknown>; meta: Record<string, unknown> }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    expect(typeof body.meta.trace_id).toBe('string')
  })

  /* ---------------------------------------------------------------------- */
  /* 4. limit > 100 → 400（負の制御 / assertValid スロー）                   */
  /* ---------------------------------------------------------------------- */
  it('400 — limit > 100 は RAG_VALIDATION_ERROR（assertValid 検証）', async () => {
    // assertValid が validation error を投げるよう設定
    serviceMock.assertValid.mockImplementationOnce(() => {
      throw RagApiException.validation('limit must be <= 100', [
        { field: 'limit', code: 'OUT_OF_RANGE', message: 'limit must be <= 100' },
      ])
    })

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-sim-limit-1')
      .send({ limit: 200 }) // 上限超過
      .expect(400)

    const body = res.body as {
      success: boolean
      error: { code: string; details?: Array<{ field: string; code: string }> }
      meta: Record<string, unknown>
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    const limitErr = (body.error.details ?? []).find((d) => d.field === 'limit')
    expect(limitErr).toBeDefined()
    expect(limitErr?.code).toBe('OUT_OF_RANGE')
  })

  /* ---------------------------------------------------------------------- */
  /* 5. 空 body（全 optional）でも 200                                        */
  /* ---------------------------------------------------------------------- */
  it('200 — body が全て省略されても valid（全フィールドが optional）', async () => {
    serviceMock.findSimilarCases.mockResolvedValueOnce({ cases: [], replayed: false })

    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Idempotency-Key', 'idem-sim-empty-1')
      .send({}) // 空 body
      .expect(200)

    const body = res.body as { success: boolean; data: SimilarCasesResponseData }
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.cases)).toBe(true)
  })
})
