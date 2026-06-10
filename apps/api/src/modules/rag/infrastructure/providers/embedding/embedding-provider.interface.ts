/**
 * EmbeddingProvider 抽象（24 PP-002 / 要件 EmbeddingProvider Mandatory）。
 *
 * RAG 本体（ingestion / 検索）はこの interface 経由でのみ埋め込みを取得する。
 * OpenAI 直結を禁止し、Provider 切替時に RAG 本体改修不要（PP-AC-002）を担保する。
 */
import type { EmbeddingProviderName } from './embedding.types'
import type { ProviderCallMeta } from '../provider.types'

export interface EmbedRequest {
  /** 埋め込み対象テキスト群（chunk 本文など）。空配列は呼び出し側で弾く。 */
  texts: string[]
  /** per-call timeout（ms）。Router 既定を上書きする場合のみ指定。 */
  timeoutMs?: number
}

export interface EmbeddingResult {
  /** texts と同順・同数の埋め込みベクトル。 */
  embeddings: number[][]
  /** 1 ベクトルの次元数（MVP は 1536 / text-embedding-3-small）。 */
  dimensions: number
  /** 呼び出しメタ（usage 記録・監査用）。 */
  meta: ProviderCallMeta
}

export interface EmbeddingProvider {
  /** この provider の識別子（usage 記録 / fallback 判定に使う）。 */
  readonly provider: EmbeddingProviderName
  /** 利用モデル名（例: text-embedding-3-small）。 */
  readonly model: string
  /** 出力次元数（HNSW index と一致させる / 05 §5.5）。 */
  readonly dimensions: number

  embed(request: EmbedRequest): Promise<EmbeddingResult>
}

/** Nest DI トークン。 */
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER')
