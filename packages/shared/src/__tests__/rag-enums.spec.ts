/**
 * enum SSoT の不変条件テスト（要素数 + 値集合）。
 * 値集合の正本は 05_DB_ER設計書 §6 / 10_API設計書 §3.4.3。
 * doc の値数とコード配列がズレたら即落ちる（Prisma migrate 後の取りこぼし検出）。
 */
import {
  SOURCE_TYPES,
  MVP_SOURCE_TYPES,
  QUERY_TYPES,
  BOT_SIGNALS,
  RISK_LEVELS,
  SEVERITIES,
  GUARDRAIL_STATUSES,
  GUARDRAIL_TYPES,
  SOURCE_STATUSES,
  DOCUMENT_STATUSES,
  CHUNK_STATUSES,
  EMBEDDING_STATUSES,
  INGESTION_STATUSES,
  INGESTION_ITEM_STATUSES,
  QUERY_STATUSES,
  RESPONSE_STATUSES,
  CITATION_QUALITY_STATUSES,
  PROVIDER_CALL_STATUSES,
  PROVIDER_CALL_TYPES,
  PROVIDER_ERROR_TYPES,
  PROVIDER_EVALUATION_JOB_STATUSES,
  ERROR_CODES,
  ERROR_DETAIL_CODES,
  CLIENT_TYPES,
  MARKETS,
  LANGUAGES,
  TIMEFRAMES,
  ORDER_PERMISSION,
  sourceTypeSchema,
  botSignalSchema,
  citationQualityStatusSchema,
} from '../rag-enums'

describe('enum 要素数（doc 正本との一致）', () => {
  it('SOURCE_TYPES = 12 値（05 §6.1 / 10 §3.4.3）', () => {
    expect(SOURCE_TYPES).toHaveLength(12)
  })
  it('MVP_SOURCE_TYPES = 4 値（◎）', () => {
    expect(MVP_SOURCE_TYPES).toHaveLength(4)
  })
  it('QUERY_TYPES = 8 値（05 §6.2）', () => {
    expect(QUERY_TYPES).toHaveLength(8)
  })
  it('BOT_SIGNALS = 4 値（BUY/SELL/HOLD/NONE / 10 §3.4.3）', () => {
    expect(BOT_SIGNALS).toEqual(['BUY', 'SELL', 'HOLD', 'NONE'])
  })
  it('RISK_LEVELS = 4 値（05 §6.3）', () => {
    expect(RISK_LEVELS).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  })
  it('SEVERITIES = 4 値（05 §5.12）', () => {
    expect(SEVERITIES).toHaveLength(4)
  })
  it('GUARDRAIL_STATUSES = 3 値（05 §6.4）', () => {
    expect(GUARDRAIL_STATUSES).toEqual(['PASS', 'WARNING', 'BLOCKED'])
  })
  it('GUARDRAIL_TYPES = 5 値（05 §5.12）', () => {
    expect(GUARDRAIL_TYPES).toHaveLength(5)
  })
  it('SOURCE_STATUSES = 3 値（05 §5.1）', () => {
    expect(SOURCE_STATUSES).toEqual(['ACTIVE', 'DISABLED', 'BLOCKED'])
  })
  it('DOCUMENT_STATUSES = 6 値（05 §5.3）', () => {
    expect(DOCUMENT_STATUSES).toHaveLength(6)
  })
  it('CHUNK_STATUSES = 3 値（ACTIVE/QUARANTINED/DISABLED / 05 §5.4）', () => {
    expect(CHUNK_STATUSES).toEqual(['ACTIVE', 'QUARANTINED', 'DISABLED'])
  })
  it('EMBEDDING_STATUSES = 3 値（05 §5.5）', () => {
    expect(EMBEDDING_STATUSES).toEqual(['ACTIVE', 'STALE', 'FAILED'])
  })
  it('INGESTION_STATUSES = 7 値（05 §6.5）', () => {
    expect(INGESTION_STATUSES).toHaveLength(7)
  })
  it('INGESTION_ITEM_STATUSES = 5 値（05 §5.7）', () => {
    expect(INGESTION_ITEM_STATUSES).toHaveLength(5)
  })
  it('QUERY_STATUSES = 9 値（05 §5.8）', () => {
    expect(QUERY_STATUSES).toHaveLength(9)
  })
  it('RESPONSE_STATUSES = 4 値（05 §5.10）', () => {
    expect(RESPONSE_STATUSES).toHaveLength(4)
  })
  it('CITATION_QUALITY_STATUSES = 5 値（05 §5.11 / 10 §6.1）', () => {
    expect(CITATION_QUALITY_STATUSES).toEqual([
      'ACTIVE',
      'QUARANTINED',
      'DISABLED',
      'STALE',
      'LOW_RELIABILITY',
    ])
  })
  it('PROVIDER_CALL_STATUSES = 6 値（05 §6.6）', () => {
    expect(PROVIDER_CALL_STATUSES).toHaveLength(6)
  })
  it('PROVIDER_CALL_TYPES = 4 値（05 §5.15）', () => {
    expect(PROVIDER_CALL_TYPES).toEqual(['chat', 'embedding', 'rerank', 'eval'])
  })
  it('PROVIDER_ERROR_TYPES = 5 値（05 §5.17）', () => {
    expect(PROVIDER_ERROR_TYPES).toHaveLength(5)
  })
  it('PROVIDER_EVALUATION_JOB_STATUSES = 5 値（10 §8.4）', () => {
    expect(PROVIDER_EVALUATION_JOB_STATUSES).toHaveLength(5)
  })
  it('ERROR_CODES = 11 値（10 §4）', () => {
    expect(ERROR_CODES).toHaveLength(11)
  })
  it('ERROR_DETAIL_CODES = 5 値（10 §3.4）', () => {
    expect(ERROR_DETAIL_CODES).toHaveLength(5)
  })
  it('CLIENT_TYPES = 4 値（10 §3.3）', () => {
    expect(CLIENT_TYPES).toEqual(['ui', 'training_bot', 'system', 'worker'])
  })
  it('MARKETS = 3 値', () => {
    expect(MARKETS).toEqual(['crypto', 'stock', 'fx'])
  })
  it('LANGUAGES = 3 値', () => {
    expect(LANGUAGES).toEqual(['ja', 'en', 'zh'])
  })
  it('TIMEFRAMES は代表値を含む', () => {
    expect(TIMEFRAMES).toContain('1h')
  })
})

describe('MVP_SOURCE_TYPES は SOURCE_TYPES の部分集合', () => {
  it('全 MVP 値が SOURCE_TYPES に存在する', () => {
    for (const v of MVP_SOURCE_TYPES) {
      expect(SOURCE_TYPES).toContain(v)
    }
  })
})

describe('order_permission は literal false 固定（横断規約 §5）', () => {
  it('ORDER_PERMISSION === false', () => {
    expect(ORDER_PERMISSION).toBe(false)
  })
})

describe('enum Zod parse（正常 / 異常）', () => {
  it('sourceTypeSchema は有効値を通す', () => {
    expect(sourceTypeSchema.parse('market_data')).toBe('market_data')
  })
  it('sourceTypeSchema は無効値を弾く', () => {
    expect(sourceTypeSchema.safeParse('money').success).toBe(false)
  })
  it('botSignalSchema は NONE を通す', () => {
    expect(botSignalSchema.parse('NONE')).toBe('NONE')
  })
  it('botSignalSchema は小文字 buy を弾く', () => {
    expect(botSignalSchema.safeParse('buy').success).toBe(false)
  })
  it('citationQualityStatusSchema は LOW_RELIABILITY を通す', () => {
    expect(citationQualityStatusSchema.safeParse('LOW_RELIABILITY').success).toBe(
      true,
    )
  })
})
