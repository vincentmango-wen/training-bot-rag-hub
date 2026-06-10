/**
 * Embedding 層の補助型。MVP モデルの次元・identifier を SSoT 化する。
 */
import type { ProviderName } from '../provider.types'

/** Embedding を提供しうる Provider 名（ProviderName のサブ集合）。 */
export type EmbeddingProviderName = ProviderName

/**
 * MVP の埋め込みモデル仕様（16 / 24 §6.1 EMBEDDING = OpenAI Small）。
 * 次元数は HNSW 部分式 index（A1 基盤の migration）と一致させる。
 */
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small' as const
export const OPENAI_EMBEDDING_DIMENSIONS = 1536 as const
