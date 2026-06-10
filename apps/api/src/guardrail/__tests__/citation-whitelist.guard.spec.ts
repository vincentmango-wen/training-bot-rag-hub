import { CitationWhitelistGuard } from '../citation-whitelist.guard'
import type {
  CitationCandidate,
  RetrievalResultRef,
} from '../guardrail.types'

describe('CitationWhitelistGuard (Guard b + e)', () => {
  const guard = new CitationWhitelistGuard()

  const retrieval: RetrievalResultRef[] = [
    { chunk_id: 'chunk-active-1', quality_status: 'ACTIVE' },
    { chunk_id: 'chunk-active-2', quality_status: 'ACTIVE' },
    { chunk_id: 'chunk-quarantined', quality_status: 'QUARANTINED' },
    { chunk_id: 'chunk-stale', quality_status: 'STALE' },
  ]

  const cite = (chunk_id: string): CitationCandidate => ({ chunk_id })

  it('keeps citations whose chunk_id is in the retrieval set and ACTIVE', () => {
    const out = guard.filter({
      citations: [cite('chunk-active-1'), cite('chunk-active-2')],
      retrievalResults: retrieval,
    })
    expect(out.allowed.map((c) => c.chunk_id)).toEqual([
      'chunk-active-1',
      'chunk-active-2',
    ])
    expect(out.block).toBe(false)
    expect(out.removedNotInWhitelist).toEqual([])
    expect(out.removedNonActive).toEqual([])
  })

  it('removes fabricated chunk_id not in the retrieval set (whitelist)', () => {
    const out = guard.filter({
      citations: [cite('chunk-active-1'), cite('chunk-FABRICATED')],
      retrievalResults: retrieval,
    })
    expect(out.allowed.map((c) => c.chunk_id)).toEqual(['chunk-active-1'])
    expect(out.removedNotInWhitelist).toEqual(['chunk-FABRICATED'])
    expect(out.block).toBe(false)
    const v = out.violations.find((x) => x.type === 'citation_whitelist')
    expect(v?.severity).toBe('CRITICAL')
  })

  it('removes citations whose DB quality_status is not ACTIVE (Guard e)', () => {
    const out = guard.filter({
      citations: [cite('chunk-active-1'), cite('chunk-quarantined'), cite('chunk-stale')],
      retrievalResults: retrieval,
    })
    expect(out.allowed.map((c) => c.chunk_id)).toEqual(['chunk-active-1'])
    expect(out.removedNonActive.sort()).toEqual(['chunk-quarantined', 'chunk-stale'])
    expect(out.block).toBe(false)
    const v = out.violations.find((x) => x.type === 'citation_quality')
    expect(v?.severity).toBe('HIGH')
  })

  it('uses DB quality_status, NOT the LLM-claimed quality_status', () => {
    // LLM が ACTIVE と偽っても DB が QUARANTINED なら除去する。
    const lying: CitationCandidate = {
      chunk_id: 'chunk-quarantined',
      quality_status: 'ACTIVE',
    }
    const out = guard.filter({
      citations: [lying],
      retrievalResults: retrieval,
    })
    expect(out.allowed).toEqual([])
    expect(out.removedNonActive).toEqual(['chunk-quarantined'])
    expect(out.block).toBe(true)
  })

  it('sets block=true when all citations are removed (no grounding → 422)', () => {
    const out = guard.filter({
      citations: [cite('chunk-FABRICATED'), cite('chunk-quarantined')],
      retrievalResults: retrieval,
    })
    expect(out.allowed).toEqual([])
    expect(out.block).toBe(true)
    const blocking = out.violations.find((v) => v.blocking)
    expect(blocking?.type).toBe('citation_whitelist')
    expect(blocking?.severity).toBe('CRITICAL')
  })

  it('sets block=true for an empty citation array', () => {
    const out = guard.filter({ citations: [], retrievalResults: retrieval })
    expect(out.block).toBe(true)
  })

  it('prefers the stricter status when retrieval set has duplicate chunk_id', () => {
    const dup: RetrievalResultRef[] = [
      { chunk_id: 'dup', quality_status: 'ACTIVE' },
      { chunk_id: 'dup', quality_status: 'DISABLED' },
    ]
    const out = guard.filter({ citations: [cite('dup')], retrievalResults: dup })
    expect(out.allowed).toEqual([])
    expect(out.removedNonActive).toEqual(['dup'])
    expect(out.block).toBe(true)
  })

  it('does not mutate the input citations array', () => {
    const input = [cite('chunk-active-1'), cite('chunk-FABRICATED')]
    const snapshot = input.map((c) => c.chunk_id)
    guard.filter({ citations: input, retrievalResults: retrieval })
    expect(input.map((c) => c.chunk_id)).toEqual(snapshot)
  })
})
