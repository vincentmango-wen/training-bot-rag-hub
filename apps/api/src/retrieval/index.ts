/**
 * Retrieval モジュール公開 API バレル。
 *
 * 設計正本: 05_DB_ER設計書 §8.1（合成スコア検索）/ §5.4（chunk 可視性）/
 * §5.9（rag_retrieval_results スナップショット）/ §7.3（HNSW 部分式 index）/ §9.4（helper SSoT）。
 */
export { RetrievalModule } from './retrieval.module'
export { RetrievalService } from './retrieval.service'

// SSoT helper / SQL ビルダー（消費側・テストから参照可能に公開）
export {
  buildChunkVisibilityWhere,
  resolveVisibilityParams,
} from './chunk-visibility.where'
export {
  buildRetrievalSql,
  buildMetadataFilterWhere,
  toVectorLiteral,
  type RetrievalSqlRow,
  type BuildRetrievalSqlArgs,
} from './retrieval-sql'
export {
  DEFAULT_COMPOSITE_WEIGHTS,
  resolveWeights,
  computeFinalScore,
} from './composite-score'
export {
  RECENCY_TAU_DAYS,
  DEFAULT_TAU_DAYS,
  tauDaysFor,
  recencyScoreSqlExpression,
} from './recency'

export type {
  ChunkVisibilityParams,
  RetrievalFilters,
  CompositeScoreWeights,
  RetrieveInput,
  RetrievedChunk,
  RetrieveResult,
} from './retrieval.types'
export {
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_TOP_K,
  DEFAULT_RELIABILITY_FLOOR,
  DEFAULT_MAX_STALENESS_DAYS,
  DEFAULT_OVERSAMPLE_FACTOR,
  DEFAULT_PER_DOCUMENT_CAP,
  DEFAULT_HNSW_EF_SEARCH,
} from './retrieval.types'
