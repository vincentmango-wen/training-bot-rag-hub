/**
 * API I/O schema の parse テスト（正常 / 異常）。
 * 10_API設計書 §6.1〜§6.4 の代表 payload を検証する。
 * 金融数値が string であること / number を弾くことを重点的に確認する。
 */
import {
  queryRequestSchema,
  queryResponseSchema,
  botContextRequestSchema,
  similarCaseSchema,
  historyQuerySchema,
} from '../api'
import {
  moneyStringSchema,
  errorResponseSchema,
  citationSchema,
} from '../common'

const UUID = '11111111-1111-4111-8111-111111111111'
const ISO = '2026-06-09T00:00:00Z'

describe('moneyStringSchema（金融数値 string / Decimal Safe）', () => {
  it('decimal string を通す', () => {
    expect(moneyStringSchema.parse('65000.50')).toBe('65000.50')
  })
  it('負値 string を通す', () => {
    expect(moneyStringSchema.parse('-1.8')).toBe('-1.8')
  })
  it('number は弾く（string 型でないため）', () => {
    expect(moneyStringSchema.safeParse(65000.5).success).toBe(false)
  })
  it('非数値文字列は弾く', () => {
    expect(moneyStringSchema.safeParse('abc').success).toBe(false)
  })
})

describe('queryRequestSchema（POST /rag/query）', () => {
  it('最小 payload（query のみ）を通す', () => {
    expect(queryRequestSchema.safeParse({ query: 'BTCの相場は？' }).success).toBe(
      true,
    )
  })
  it('source_types に SSoT 外の値を弾く', () => {
    const r = queryRequestSchema.safeParse({
      query: 'x',
      source_types: ['money'],
    })
    expect(r.success).toBe(false)
  })
  it('query 空文字を弾く', () => {
    expect(queryRequestSchema.safeParse({ query: '' }).success).toBe(false)
  })
})

describe('botContextRequestSchema（POST /rag/bot-context）', () => {
  it('bot_signal=BUY + features を通す', () => {
    const r = botContextRequestSchema.safeParse({
      bot_id: UUID,
      bot_signal: 'BUY',
      features: { rsi: 29, atr: '0.034', funding_rate: '0.012' },
    })
    expect(r.success).toBe(true)
  })
  it('bot_signal が enum 外なら弾く', () => {
    const r = botContextRequestSchema.safeParse({
      bot_id: UUID,
      bot_signal: 'LONG',
    })
    expect(r.success).toBe(false)
  })
  it('bot_id が uuid でないなら弾く', () => {
    const r = botContextRequestSchema.safeParse({
      bot_id: 'not-uuid',
      bot_signal: 'HOLD',
    })
    expect(r.success).toBe(false)
  })
})

describe('similarCaseSchema（金融数値は string）', () => {
  it('*_pct が string なら通す', () => {
    const r = similarCaseSchema.safeParse({
      case_id: UUID,
      symbol: 'BTCUSDT',
      period_from: ISO,
      period_to: ISO,
      similarity: 0.87,
      matched_features: ['rsi'],
      after_move_4h_pct: '2.4',
      after_move_24h_pct: '-0.8',
      max_drawdown_pct: '-2.1',
      risk_notes: [],
    })
    expect(r.success).toBe(true)
  })
  it('max_drawdown_pct を number にすると弾く', () => {
    const r = similarCaseSchema.safeParse({
      case_id: UUID,
      symbol: 'BTCUSDT',
      period_from: ISO,
      period_to: ISO,
      similarity: 0.87,
      matched_features: [],
      after_move_4h_pct: '2.4',
      after_move_24h_pct: '-0.8',
      max_drawdown_pct: -2.1,
      risk_notes: [],
    })
    expect(r.success).toBe(false)
  })
})

describe('citationSchema（10 §6.1 / B2）', () => {
  const base = {
    source_id: UUID,
    document_id: UUID,
    chunk_id: UUID,
    source_type: 'market_data',
    used_reason: '出来高増加の根拠',
    event_time: ISO,
    ingested_at: ISO,
    retrieval_score: 0.82,
    quality_status: 'ACTIVE',
  }
  it('excerpt 省略（training_bot 向け）でも通す', () => {
    expect(citationSchema.safeParse(base).success).toBe(true)
  })
  it('event_time null を許容する', () => {
    expect(citationSchema.safeParse({ ...base, event_time: null }).success).toBe(
      true,
    )
  })
  it('quality_status enum 外を弾く', () => {
    expect(
      citationSchema.safeParse({ ...base, quality_status: 'OK' }).success,
    ).toBe(false)
  })
})

describe('historyQuerySchema（GET クエリの coerce）', () => {
  it('page/limit を文字列から number に coerce する', () => {
    const r = historyQuerySchema.parse({ page: '2', limit: '20' })
    expect(r.page).toBe(2)
    expect(r.limit).toBe(20)
  })
  it('risk_level enum 外を弾く', () => {
    expect(historyQuerySchema.safeParse({ risk_level: 'EXTREME' }).success).toBe(
      false,
    )
  })
})

describe('queryResponseSchema（success ラッパ + meta）', () => {
  it('full success payload を通す', () => {
    const payload = {
      success: true,
      data: {
        query_id: UUID,
        trace_id: 'trace-1',
        summary: '要約',
        supporting_factors: ['a'],
        opposing_factors: ['b'],
        risk_level: 'MEDIUM',
        confidence: 0.68,
        citations: [],
        llm: {
          provider: 'openai',
          model: 'gpt-5.4-mini',
          fallback_used: false,
          estimated_cost: '0.0061',
        },
        guardrail: {
          status: 'PASS',
          order_permission: false,
          reason: 'RAG has no trading permission',
        },
      },
      meta: {
        trace_id: 'trace-1',
        request_id: 'req-1',
        idempotency_key: 'k',
        idempotency_replayed: false,
        timestamp: ISO,
      },
    }
    expect(queryResponseSchema.safeParse(payload).success).toBe(true)
  })
  it('guardrail.order_permission を true にすると弾く（literal false 固定）', () => {
    const r = queryResponseSchema.safeParse({
      success: true,
      data: {
        query_id: UUID,
        trace_id: 't',
        summary: 's',
        supporting_factors: [],
        opposing_factors: [],
        risk_level: 'LOW',
        confidence: 0.5,
        citations: [],
        llm: { provider: 'openai', model: 'm', fallback_used: false },
        guardrail: { status: 'PASS', order_permission: true },
      },
      meta: { trace_id: 't', request_id: 'r', timestamp: ISO },
    })
    expect(r.success).toBe(false)
  })
})

describe('errorResponseSchema（10 §3.4 Error）', () => {
  it('details 構造化配列を通す', () => {
    const r = errorResponseSchema.safeParse({
      success: false,
      error: {
        code: 'RAG_VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: [
          { field: 'timeframe', code: 'INVALID_ENUM', message: 'bad' },
        ],
      },
      meta: { trace_id: 't', request_id: 'r', timestamp: ISO },
    })
    expect(r.success).toBe(true)
  })
  it('error.code enum 外を弾く', () => {
    const r = errorResponseSchema.safeParse({
      success: false,
      error: { code: 'WHATEVER', message: 'x' },
      meta: { trace_id: 't', request_id: 'r', timestamp: ISO },
    })
    expect(r.success).toBe(false)
  })
})
