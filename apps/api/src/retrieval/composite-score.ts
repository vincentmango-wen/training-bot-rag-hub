import type { CompositeScoreWeights } from './retrieval.types'

/**
 * 合成スコア重みの正本（05_DB_ER設計書 §8.1）。
 *
 *   final_score = similarity*0.55 + reliability*0.20 + recency*0.25
 *
 * staleness は別途減点しない（recency_score の指数減衰が同役割 / §8.1 設計注記の
 * 「二重減点を避ける」）。staleness 要求は WHERE hard cap として可視性 helper 側で実装。
 *
 * 重みの真の正本は `rag_provider_policies`（jsonb）であり、SQL リテラルはデフォルト値
 * （§8.1 設計注記）。本定数は MVP 初期値であり、policy 指定時は上書きする。
 */
export const DEFAULT_COMPOSITE_WEIGHTS: Readonly<CompositeScoreWeights> = {
  similarity: 0.55,
  reliability: 0.2,
  recency: 0.25,
}

/**
 * 渡された部分重みを既定値とマージする。
 * 重み合計の正規化は行わない（§8.1 の SQL も生の係数を使うため）。
 */
export function resolveWeights(
  override?: Partial<CompositeScoreWeights>,
): CompositeScoreWeights {
  return {
    similarity: override?.similarity ?? DEFAULT_COMPOSITE_WEIGHTS.similarity,
    reliability: override?.reliability ?? DEFAULT_COMPOSITE_WEIGHTS.reliability,
    recency: override?.recency ?? DEFAULT_COMPOSITE_WEIGHTS.recency,
  }
}

/**
 * 合成スコアを TS 側で再計算するための関数（テスト・検証用 / 監査再現の二次確認）。
 * SQL 側の `final_score` 算出（§8.1 deduped CTE）と同一式であること。
 */
export function computeFinalScore(
  similarity: number,
  reliability: number,
  recency: number,
  weights: CompositeScoreWeights = DEFAULT_COMPOSITE_WEIGHTS,
): number {
  return (
    similarity * weights.similarity +
    reliability * weights.reliability +
    recency * weights.recency
  )
}
