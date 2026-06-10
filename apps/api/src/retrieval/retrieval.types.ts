import type { SourceType } from '@pmtp/shared'

/**
 * Retrieval モジュールの公開型。
 *
 * 設計正本: 05_DB_ER設計書 §8.1（合成スコア検索 SQL）/ §5.4（chunk 可視性）/
 * §5.9（rag_retrieval_results スナップショット）/ §7.3（HNSW 部分式 index）。
 *
 * 金融数値方針（05 §2.4.5 / 横断規約 §2）: similarity / reliability / recency /
 * final はいずれも「RAG 内部の順位付け・確信度スコア」であり金融数値ではないため
 * `number` で扱う（30 §IF契約 の number 判定基準に一致）。price / qty 等の金融数値は
 * 本モジュールでは扱わない（chunk.content / metadata の string として素通し）。
 */

/** MVP の埋め込み Provider 既定（OpenAI のみ / 16_MVP仕様書）。 */
export const DEFAULT_EMBEDDING_PROVIDER = 'openai' as const
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small' as const
export const DEFAULT_EMBEDDING_DIMENSION = 1536 as const

/** 検索パラメータの既定値（05 §8.1 のパラメータ注記に一致）。 */
export const DEFAULT_TOP_K = 20 as const
export const DEFAULT_RELIABILITY_FLOOR = 0.4 as const
/** staleness hard cap（05 §8.1 $11 default '90 days'）。 */
export const DEFAULT_MAX_STALENESS_DAYS = 90 as const
/** oversample 係数（05 §8.1: ANN は top_k の 5 倍を取る）。 */
export const DEFAULT_OVERSAMPLE_FACTOR = 5 as const
/** 1 document あたりの最大採用 chunk 数（05 §8.1 段B: 単一文書の文脈占有防止）。 */
export const DEFAULT_PER_DOCUMENT_CAP = 2 as const
/** HNSW recall 設定（05 §7.3 運用規約 3）。 */
export const DEFAULT_HNSW_EF_SEARCH = 100 as const

/**
 * 検索可視性パラメータ（05 §5.4 / §8.1）。
 * `buildChunkVisibilityWhere()` がこれを唯一の入力として WHERE を組み立てる。
 */
export type ChunkVisibilityParams = {
  /** ソース信頼度の足切り（s.reliability_score >= floor）。 */
  reliabilityFloor: number
  /** staleness hard cap（日数 / coalesce(event_time, ingested_at) >= now() - N days）。 */
  maxStalenessDays: number
}

/**
 * Metadata Filter（05 §8.1 $5〜$9）。未指定（undefined）はフィルタ無効。
 */
export type RetrievalFilters = {
  symbol?: string
  timeframe?: string
  /** 検索対象 source_type の絞り込み（未指定 = 全 source_type）。 */
  sourceTypes?: readonly SourceType[]
  /** c.event_time >= from（ISO 文字列 or Date）。 */
  eventTimeFrom?: Date
  /** c.event_time <= to。 */
  eventTimeTo?: Date
}

/** 合成スコア重み（05 §8.1: w_sim=0.55 / w_rel=0.20 / w_rec=0.25）。 */
export type CompositeScoreWeights = {
  similarity: number
  reliability: number
  recency: number
}

/**
 * Retrieval 入力。
 * embedding は呼び出し側（Provider 層）が生成済みの query ベクトル（float[]）を渡す。
 * 本モジュールは embedding を生成しない（責務分離 / 24_Provider Policy）。
 */
export type RetrieveInput = {
  /** 永続化先 rag_queries.id（保存スコープ）。 */
  queryId: string
  /** query embedding（dimension と長さ一致が前提 / CHECK で物理担保）。 */
  embedding: readonly number[]
  /** 埋め込み Provider（既定 openai）。HNSW 部分 index の WHERE 述語に一致させる。 */
  provider?: string
  /** 埋め込み model（既定 text-embedding-3-small）。 */
  model?: string
  /** 埋め込み次元（既定 1536）。キャスト式 `embedding::vector(N)` の N に一致させる。 */
  dimension?: number
  /** 取得チャンク数（既定 20）。 */
  topK?: number
  filters?: RetrievalFilters
  visibility?: Partial<ChunkVisibilityParams>
  weights?: Partial<CompositeScoreWeights>
}

/**
 * 検索された 1 チャンク（rag_retrieval_results に保存する前のスコア付き候補）。
 * スコアは全て number（金融数値ではない）。
 */
export type RetrievedChunk = {
  chunkId: string
  documentId: string
  sourceId: string
  content: string
  metadata: unknown
  similarityScore: number
  reliabilityScore: number
  /** 検索時動的計算した鮮度（カラム保持せず / 05 §5.4 設計裁定 2）。 */
  recencyScore: number
  /** 合成スコア（§8.1 / sim*w1 + rel*w2 + rec*w3）。 */
  finalScore: number
  /** 1 始まりの検索順位。 */
  rankOrder: number
}

/** Retrieval 結果（呼び出し側が response 生成・citation whitelist に使う集合）。 */
export type RetrieveResult = {
  queryId: string
  chunks: RetrievedChunk[]
  /** 実際に適用された oversample 件数（fallback で増えた場合の監査用）。 */
  oversampleLimit: number
  /** fallback（oversample 係数 up）が発火したか。 */
  fallbackApplied: boolean
}
