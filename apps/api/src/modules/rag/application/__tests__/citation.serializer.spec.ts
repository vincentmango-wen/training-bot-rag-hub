import { buildCitations, type CitationContext } from '../citation.serializer'

function ctx(chunkId: string, overrides: Partial<CitationContext> = {}): CitationContext {
  return {
    chunkId,
    sourceId: `src-${chunkId}`,
    documentId: `doc-${chunkId}`,
    sourceType: 'market_data',
    title: `Title ${chunkId}`,
    excerpt: `excerpt of ${chunkId}`,
    eventTime: '2026-06-09T00:00:00.000Z',
    ingestedAt: '2026-06-09T01:00:00.000Z',
    retrievalScore: 0.8,
    qualityStatus: 'ACTIVE',
    ...overrides,
  }
}

describe('buildCitations — audience 別 excerpt 出し分け（10 §6.1）', () => {
  const allowed = [{ chunk_id: 'c1', used_reason: 'reason-1' }]
  const map = new Map<string, CitationContext>([['c1', ctx('c1')]])

  it('ui は excerpt を含むフル形', () => {
    const [c] = buildCitations(allowed, map, 'ui')
    expect(c?.excerpt).toBe('excerpt of c1')
    expect(c?.source_type).toBe('market_data')
    expect(c?.used_reason).toBe('reason-1')
    expect(c?.quality_status).toBe('ACTIVE')
  })

  it('training_bot は excerpt を省略する', () => {
    const [c] = buildCitations(allowed, map, 'training_bot')
    expect(c?.excerpt).toBeUndefined()
    // ID / score / quality / 時刻は残す
    expect(c?.chunk_id).toBe('c1')
    expect(c?.retrieval_score).toBe(0.8)
    expect(c?.event_time).toBe('2026-06-09T00:00:00.000Z')
  })

  it('system / worker も excerpt を省略する（最小開示）', () => {
    expect(buildCitations(allowed, map, 'system')[0]?.excerpt).toBeUndefined()
    expect(buildCitations(allowed, map, 'worker')[0]?.excerpt).toBeUndefined()
  })

  it('context に存在しない chunk_id は防御的に skip する', () => {
    const result = buildCitations(
      [{ chunk_id: 'ghost', used_reason: 'x' }],
      map,
      'ui',
    )
    expect(result).toHaveLength(0)
  })

  it('title が無い context では title フィールドを付けない', () => {
    const base = ctx('c1')
    delete (base as { title?: string }).title
    const m = new Map([['c1', base]])
    const [c] = buildCitations(allowed, m, 'ui')
    expect(c && 'title' in c).toBe(false)
  })
})
