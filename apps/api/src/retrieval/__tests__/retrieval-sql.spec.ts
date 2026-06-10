import {
  buildMetadataFilterWhere,
  buildRetrievalSql,
  toVectorLiteral,
  type BuildRetrievalSqlArgs,
} from '../retrieval-sql'
import { DEFAULT_COMPOSITE_WEIGHTS } from '../composite-score'

const baseArgs = (
  override?: Partial<BuildRetrievalSqlArgs>,
): BuildRetrievalSqlArgs => ({
  embedding: new Array(1536).fill(0.1),
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimension: 1536,
  topK: 20,
  oversampleFactor: 5,
  perDocumentCap: 2,
  filters: {},
  visibility: {},
  weights: DEFAULT_COMPOSITE_WEIGHTS,
  ...override,
})

describe('toVectorLiteral', () => {
  it('pgvector リテラル [a,b,c] を生成する', () => {
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]')
  })

  it('空配列は拒否', () => {
    expect(() => toVectorLiteral([])).toThrow(/must not be empty/)
  })

  it('NaN / Infinity は拒否（planner 破壊・SQL エラーの早期遮断）', () => {
    expect(() => toVectorLiteral([1, NaN, 3])).toThrow(/non-finite/)
    expect(() => toVectorLiteral([Infinity])).toThrow(/non-finite/)
  })
})

describe('buildRetrievalSql', () => {
  it('HNSW 部分 index と同一キャスト式 embedding::vector(1536) を使う（§7.3 planner 一致）', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.sql).toContain('e.embedding::vector(1536)')
    // cosine 距離演算子
    expect(sql.sql).toContain('<=>')
  })

  it('部分 index 述語（provider/model/dimension/status=ACTIVE）をパラメータ化して持つ', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.sql).toContain('e.provider =')
    expect(sql.sql).toContain('e.model =')
    expect(sql.sql).toContain('e.dimension =')
    expect(sql.sql).toContain("e.status = 'ACTIVE'")
    expect(sql.values).toContain('openai')
    expect(sql.values).toContain('text-embedding-3-small')
    expect(sql.values).toContain(1536)
  })

  it('oversample limit は topK * oversampleFactor', () => {
    const sql = buildRetrievalSql(baseArgs({ topK: 20, oversampleFactor: 5 }))
    expect(sql.values).toContain(100) // 20 * 5
  })

  it('合成スコア重み（0.55/0.20/0.25）がパラメータとして埋め込まれる', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.values).toContain(0.55)
    expect(sql.values).toContain(0.2)
    expect(sql.values).toContain(0.25)
  })

  it('可視性 helper の WHERE（status/deleted_at/reliability/staleness）を内包する', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.sql).toContain('c.status =')
    expect(sql.sql).toContain('c.deleted_at is null')
    expect(sql.sql).toContain('d.status =')
    expect(sql.sql).toContain('s.reliability_score >=')
    expect(sql.sql).toContain('make_interval(days =>')
  })

  it('dedup 段A（distinct on content_hash）と cap 段B（row_number per document）を含む', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.sql).toContain('distinct on (content_hash)')
    expect(sql.sql).toContain('row_number() over (partition by document_id')
    expect(sql.sql).toContain('doc_rank <=')
  })

  it('recency 動的計算（CASE source_type の τ）を SQL に含む（カラム保持しない）', () => {
    const sql = buildRetrievalSql(baseArgs())
    expect(sql.sql).toContain('case c.source_type')
    expect(sql.sql).toContain("interval '7 days'")
    expect(sql.sql).toContain("interval '365 days'")
  })

  it('embedding 長と dimension 不一致は拒否（CHECK 物理担保の前段ガード）', () => {
    expect(() =>
      buildRetrievalSql(baseArgs({ embedding: [0.1, 0.2], dimension: 1536 })),
    ).toThrow(/!==/)
  })

  it('不正な dimension は拒否', () => {
    expect(() =>
      buildRetrievalSql(baseArgs({ dimension: 0, embedding: [] })),
    ).toThrow(/invalid dimension/)
  })

  it('1024 次元 provider でもキャスト式が次元に追従する（Phase2 拡張余地）', () => {
    const sql = buildRetrievalSql(
      baseArgs({
        embedding: new Array(1024).fill(0.1),
        dimension: 1024,
        provider: 'voyage',
        model: 'voyage-3',
      }),
    )
    expect(sql.sql).toContain('e.embedding::vector(1024)')
    expect(sql.values).toContain('voyage')
  })
})

describe('buildMetadataFilterWhere', () => {
  it('フィルタ未指定は空（Prisma.empty）', () => {
    expect(buildMetadataFilterWhere({}).sql).toBe('')
  })

  it('symbol / timeframe をパラメータ化して AND する', () => {
    const sql = buildMetadataFilterWhere({ symbol: 'BTCUSDT', timeframe: '1h' })
    expect(sql.sql).toContain('c.symbol =')
    expect(sql.sql).toContain('c.timeframe =')
    expect(sql.values).toContain('BTCUSDT')
    expect(sql.values).toContain('1h')
    expect(sql.sql.startsWith(' and ')).toBe(true)
  })

  it('sourceTypes を IN リストでパラメータ化する', () => {
    const sql = buildMetadataFilterWhere({
      sourceTypes: ['bot_log', 'market_data'],
    })
    expect(sql.sql).toContain('c.source_type in (')
    expect(sql.values).toEqual(expect.arrayContaining(['bot_log', 'market_data']))
  })

  it('空 sourceTypes 配列はフィルタ無効（全 source_type）', () => {
    expect(buildMetadataFilterWhere({ sourceTypes: [] }).sql).toBe('')
  })

  it('eventTimeFrom / eventTimeTo を範囲条件にする', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const to = new Date('2026-06-01T00:00:00Z')
    const sql = buildMetadataFilterWhere({ eventTimeFrom: from, eventTimeTo: to })
    expect(sql.sql).toContain('c.event_time >=')
    expect(sql.sql).toContain('c.event_time <=')
    expect(sql.values).toContain(from)
    expect(sql.values).toContain(to)
  })
})
