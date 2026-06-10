import {
  DEFAULT_TAU_DAYS,
  RECENCY_TAU_DAYS,
  recencyScoreSqlExpression,
  tauDaysFor,
} from '../recency'

/**
 * recency τ マップと SQL 式の整合テスト（05 §8.1）。
 * TS 定数マップと SQL CASE 式の drift を防ぐ（両者の値・分岐を固定）。
 */
describe('recency τ map', () => {
  it.each([
    ['news', 7],
    ['sns', 7],
    ['prediction_market', 7],
    ['market_data', 30],
    ['strategy_doc', 365],
    ['bot_log', 90],
    ['order_history', 90],
  ])('source_type=%s の τ は %i 日', (sourceType, expected) => {
    expect(tauDaysFor(sourceType)).toBe(expected)
  })

  it('マップ外 source_type は既定 90 日（else 分岐）', () => {
    expect(tauDaysFor('execution_history')).toBe(DEFAULT_TAU_DAYS)
    expect(tauDaysFor('macro_event')).toBe(90)
    expect(DEFAULT_TAU_DAYS).toBe(90)
  })

  it('マップは正本値（§8.1 注記）と一致', () => {
    expect(RECENCY_TAU_DAYS).toMatchObject({
      news: 7,
      sns: 7,
      prediction_market: 7,
      market_data: 30,
      strategy_doc: 365,
      bot_log: 90,
      order_history: 90,
    })
  })
})

describe('recencyScoreSqlExpression', () => {
  it('exp(-Δt/τ) の指数減衰式 + coalesce(event_time, ingested_at) を含む', () => {
    const sql = recencyScoreSqlExpression('c')
    expect(sql).toContain('exp(')
    expect(sql).toContain('coalesce(c.event_time, c.ingested_at)')
    expect(sql).toContain('now()')
  })

  it('CASE 分岐の interval が τ マップと一致する', () => {
    const sql = recencyScoreSqlExpression('c')
    expect(sql).toContain("when 'news' then interval '7 days'")
    expect(sql).toContain("when 'market_data' then interval '30 days'")
    expect(sql).toContain("when 'strategy_doc' then interval '365 days'")
    expect(sql).toContain("else interval '90 days'")
  })

  it('別名を反映する', () => {
    const sql = recencyScoreSqlExpression('ch')
    expect(sql).toContain('coalesce(ch.event_time, ch.ingested_at)')
    expect(sql).toContain('case ch.source_type')
  })
})
