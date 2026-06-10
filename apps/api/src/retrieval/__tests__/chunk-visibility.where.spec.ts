import { buildChunkVisibilityWhere, resolveVisibilityParams } from '../chunk-visibility.where'
import {
  DEFAULT_MAX_STALENESS_DAYS,
  DEFAULT_RELIABILITY_FLOOR,
} from '../retrieval.types'

/**
 * buildChunkVisibilityWhere() の不変条件テスト（05 §5.4 / §8.1 / §9.4）。
 *
 * 本 helper は検索可視性条件の唯一の組み立て口（SSoT）。1 つでも条件が欠けると
 * QUARANTINED / 論理削除 / 低信頼 / 古すぎる情報が検索結果に混入するため、
 * 「6 条件すべての存在」と「パラメータ化」を構造的に固定する。
 */
describe('buildChunkVisibilityWhere (visibility SSoT)', () => {
  it('chunk 隔離除外: c.status = ACTIVE を含む（QUARANTINED/DISABLED 一括遮断）', () => {
    const sql = buildChunkVisibilityWhere()
    // status は固定リテラル（SQL テキストに直接出る / パラメータ化しない）
    expect(sql.sql).toContain("c.status = 'ACTIVE'")
  })

  it('chunk 論理削除除外: c.deleted_at is null を含む', () => {
    const sql = buildChunkVisibilityWhere()
    expect(sql.sql).toContain('c.deleted_at is null')
  })

  it('document: status = INDEXED かつ deleted_at is null を含む', () => {
    const sql = buildChunkVisibilityWhere()
    expect(sql.sql).toContain("d.status = 'INDEXED'")
    expect(sql.sql).toContain('d.deleted_at is null')
  })

  it('source: status = ACTIVE かつ deleted_at is null を含む', () => {
    const sql = buildChunkVisibilityWhere()
    expect(sql.sql).toContain("s.status = 'ACTIVE'")
    expect(sql.sql).toContain('s.deleted_at is null')
  })

  it('信頼度足切り: s.reliability_score >= floor がパラメータ化されている', () => {
    const sql = buildChunkVisibilityWhere()
    expect(sql.sql).toContain('s.reliability_score >=')
    expect(sql.values).toContain(DEFAULT_RELIABILITY_FLOOR)
  })

  it('staleness hard cap: coalesce(event_time, ingested_at) >= now() - interval をパラメータ化', () => {
    const sql = buildChunkVisibilityWhere()
    expect(sql.sql).toContain('coalesce(c.event_time, c.ingested_at) >=')
    expect(sql.sql).toContain('make_interval(days =>')
    expect(sql.values).toContain(DEFAULT_MAX_STALENESS_DAYS)
  })

  it('全6カテゴリの条件が AND 結合されている（条件数 >= 8 述語）', () => {
    const sql = buildChunkVisibilityWhere()
    // status x3 / deleted_at x3 / reliability x1 / staleness x1 = 8 述語
    const andCount = (sql.sql.match(/ and /g) ?? []).length
    expect(andCount).toBeGreaterThanOrEqual(7)
  })

  it('呼び出し側が渡した reliabilityFloor / maxStalenessDays を反映する', () => {
    const sql = buildChunkVisibilityWhere({
      reliabilityFloor: 0.7,
      maxStalenessDays: 30,
    })
    expect(sql.values).toContain(0.7)
    expect(sql.values).toContain(30)
    expect(sql.values).not.toContain(DEFAULT_RELIABILITY_FLOOR)
  })

  it('別名指定（chunk=ch / document=doc / source=src）が SQL に反映される', () => {
    const sql = buildChunkVisibilityWhere(undefined, {
      chunk: 'ch',
      document: 'doc',
      source: 'src',
    })
    expect(sql.sql).toContain('ch.status =')
    expect(sql.sql).toContain('doc.status =')
    expect(sql.sql).toContain('src.status =')
  })

  it('不正な別名（injection 試行）は例外で拒否する', () => {
    expect(() =>
      buildChunkVisibilityWhere(undefined, { chunk: 'c; drop table' }),
    ).toThrow(/invalid SQL alias/)
    expect(() =>
      buildChunkVisibilityWhere(undefined, { source: 'S' }),
    ).toThrow(/invalid SQL alias/)
  })

  it('SQL リテラル文字列に生の数値が現れない（パラメータ化の確認）', () => {
    const sql = buildChunkVisibilityWhere({ reliabilityFloor: 0.9 })
    // 値はプレースホルダ ? として現れ、SQL テキストには 0.9 が出ない
    expect(sql.sql).not.toContain('0.9')
    expect(sql.values).toContain(0.9)
  })
})

describe('resolveVisibilityParams', () => {
  it('未指定時は既定値を返す', () => {
    expect(resolveVisibilityParams()).toEqual({
      reliabilityFloor: DEFAULT_RELIABILITY_FLOOR,
      maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
    })
  })

  it('部分指定をマージする', () => {
    expect(resolveVisibilityParams({ reliabilityFloor: 0.6 })).toEqual({
      reliabilityFloor: 0.6,
      maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
    })
  })
})
