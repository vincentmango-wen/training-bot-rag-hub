import {
  DEFAULT_COMPOSITE_WEIGHTS,
  computeFinalScore,
  resolveWeights,
} from '../composite-score'

/**
 * 合成スコア重み・式テスト（05 §8.1: final = sim*0.55 + rel*0.20 + rec*0.25）。
 */
describe('composite score weights', () => {
  it('既定重みは §8.1 の正本値', () => {
    expect(DEFAULT_COMPOSITE_WEIGHTS).toEqual({
      similarity: 0.55,
      reliability: 0.2,
      recency: 0.25,
    })
  })

  it('既定重みの合計は 1.0', () => {
    const sum =
      DEFAULT_COMPOSITE_WEIGHTS.similarity +
      DEFAULT_COMPOSITE_WEIGHTS.reliability +
      DEFAULT_COMPOSITE_WEIGHTS.recency
    expect(sum).toBeCloseTo(1.0, 10)
  })

  it('resolveWeights は部分上書きをマージする（policy 上書き / §8.1 設計注記）', () => {
    expect(resolveWeights({ similarity: 0.7 })).toEqual({
      similarity: 0.7,
      reliability: 0.2,
      recency: 0.25,
    })
  })

  it('resolveWeights は未指定で既定を返す', () => {
    expect(resolveWeights()).toEqual(DEFAULT_COMPOSITE_WEIGHTS)
  })
})

describe('computeFinalScore', () => {
  it('既定重みで sim*0.55 + rel*0.20 + rec*0.25 を計算する', () => {
    // 0.8*0.55 + 0.9*0.20 + 0.5*0.25 = 0.44 + 0.18 + 0.125 = 0.745
    expect(computeFinalScore(0.8, 0.9, 0.5)).toBeCloseTo(0.745, 10)
  })

  it('カスタム重みを反映する', () => {
    const w = { similarity: 1, reliability: 0, recency: 0 }
    expect(computeFinalScore(0.42, 0.99, 0.99, w)).toBeCloseTo(0.42, 10)
  })
})
