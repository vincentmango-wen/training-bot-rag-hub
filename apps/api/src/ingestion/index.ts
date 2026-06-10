/**
 * Ingestion / Chunking / Embedding モジュール公開バレル。
 *
 * 設計正本: 27_Chunking設計書 / 05_DB_ER設計書 §5.3〜§5.7 / 横断規約 §2・§3・§5。
 */
export { IngestionModule } from './ingestion.module'
export { IngestionService } from './ingestion.service'
export { IdempotencyConflictError } from './idempotency-conflict.error'
export type {
  IngestionJobInput,
  IngestionJobResult,
  IngestionItemInput,
  IngestionItemResult,
  ChunkDraft,
  MvpIngestSourceType,
} from './ingestion.types'

// 純関数（テスト・他モジュールからの再利用用）
export { chunkItem, chunkStrategyDoc, chunkRecords, chunkMarketData, CHUNK_LIMITS } from './chunker'
export { normalizeText } from './normalizer'
export { scanForInjection } from './injection-scanner'
export { sha256Hex, stableHashOfJson } from './content-hash'
export { estimateTokens } from './token-estimator'
export { validateChunkIndexContinuity } from './chunk-index-validator'
export { StubEmbeddingProvider } from './testing/stub-embedding-provider'
