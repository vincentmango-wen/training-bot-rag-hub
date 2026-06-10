import { estimateCostUsd } from '../openai/openai-pricing'

describe('estimateCostUsd', () => {
  it('computes gpt-4o-mini cost as a decimal string', () => {
    // 1,000,000 input * 0.15/1M + 0 = 0.15
    expect(estimateCostUsd('gpt-4o-mini', 1_000_000, 0)).toBe('0.15000000')
    // 1M output * 0.6/1M = 0.6
    expect(estimateCostUsd('gpt-4o-mini', 0, 1_000_000)).toBe('0.60000000')
  })

  it('computes embedding cost (output rate 0)', () => {
    expect(estimateCostUsd('text-embedding-3-small', 1_000_000, 0)).toBe(
      '0.02000000',
    )
  })

  it('returns a string (Decimal Safe), never a number', () => {
    const v = estimateCostUsd('gpt-4o', 1234, 567)
    expect(typeof v).toBe('string')
  })

  it('returns undefined for unknown model', () => {
    expect(estimateCostUsd('unknown-model', 100, 100)).toBeUndefined()
  })

  it('returns 0.00000000 for zero tokens', () => {
    expect(estimateCostUsd('gpt-4o-mini', 0, 0)).toBe('0.00000000')
  })
})
