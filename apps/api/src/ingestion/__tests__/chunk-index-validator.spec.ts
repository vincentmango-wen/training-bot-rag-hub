import { validateChunkIndexContinuity } from '../chunk-index-validator'

describe('validateChunkIndexContinuity（27 §10.3 / AC-CHUNK-012）', () => {
  it('0 起点・連続・重複なし → valid', () => {
    const r = validateChunkIndexContinuity([
      { chunkIndex: 0 },
      { chunkIndex: 1 },
      { chunkIndex: 2 },
    ])
    expect(r.valid).toBe(true)
  })

  it('0 起点でない → invalid', () => {
    const r = validateChunkIndexContinuity([{ chunkIndex: 1 }, { chunkIndex: 2 }])
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/start at 0/)
  })

  it('欠番あり → invalid', () => {
    const r = validateChunkIndexContinuity([
      { chunkIndex: 0 },
      { chunkIndex: 1 },
      { chunkIndex: 3 },
    ])
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/gap|duplicate/)
  })

  it('重複あり → invalid', () => {
    const r = validateChunkIndexContinuity([
      { chunkIndex: 0 },
      { chunkIndex: 1 },
      { chunkIndex: 1 },
    ])
    expect(r.valid).toBe(false)
  })

  it('chunk 0 件 → invalid', () => {
    const r = validateChunkIndexContinuity([])
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/no chunks/)
  })
})
