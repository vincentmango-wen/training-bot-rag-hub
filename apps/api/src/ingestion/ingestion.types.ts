import type {
  ChunkStatus,
  DocumentStatus,
  IngestionItemStatus,
  IngestionStatus,
  Language,
  Market,
  MvpSourceType,
  SourceType,
} from '@pmtp/shared'

/**
 * Ingestion / Chunking / Embedding モジュールの公開型。
 *
 * 設計正本:
 *   - 27_Chunking設計書（分割戦略 / atomic / chunk_index 連続性）
 *   - 05_DB_ER設計書 §5.3〜§5.7（rag_documents / rag_chunks / rag_embeddings /
 *     rag_ingestion_jobs / rag_ingestion_job_items の DDL・制約）
 *   - 横断規約 §3（冪等性 idempotency_key + payload_hash + 部分 unique / claim-first）
 *   - 16_MVP仕様書（内部データのみ / OpenAI のみ）
 *
 * 金融数値方針（横断規約 §2 / 05 §2.4.5）: price/quantity 等の金融数値は
 * 本モジュールでは「素材として埋め込む文字列」であり計算しないため、chunk.content /
 * metadata の **string として素通し** する（number 化しない）。
 */

/** MVP で取込対象とする内部 source_type（news/sns/polymarket は Phase2 / 16）。 */
export type MvpIngestSourceType = MvpSourceType

/** 1 件の取込対象アイテム（job 内の 1 document に対応）。 */
export interface IngestionItemInput {
  /** 外部側 ID（重複判定の補助 / rag_ingestion_job_items.external_id）。任意。 */
  readonly externalId?: string
  /** 文書タイトル（任意 / strategy_doc 等）。 */
  readonly title?: string
  /**
   * 原文。
   * - strategy_doc: Markdown テキスト
   * - bot_log / order_history / market_data: 構造化レコードを呼び出し側が
   *   テキスト化したもの、または下記 records を渡す（どちらか）。
   */
  readonly rawContent: string
  /**
   * 構造化レコード（bot_log / order_history / market_data 用 / 任意）。
   * 与えられた場合、chunker はレコード単位（bot_log/order_history）または
   * window 単位（market_data）で分割する。未指定なら rawContent をテキスト分割。
   */
  readonly records?: ReadonlyArray<Record<string, unknown>>
  /** 言語（既定 'ja'）。 */
  readonly language?: Language
  /** 銘柄（任意 / metadata + chunk カラム）。 */
  readonly symbol?: string
  /** 市場（任意）。 */
  readonly market?: Market
  /** 時間足（任意 / market_data の window 分割キー）。 */
  readonly timeframe?: string
  /** イベント発生時刻（任意 / recency 計算の基準）。 */
  readonly eventTime?: Date
  /** 追加メタデータ（任意 / metadata にマージ）。 */
  readonly metadata?: Record<string, unknown>
}

/** Ingestion ジョブ 1 回分の入力（呼び出し側が組み立てる）。 */
export interface IngestionJobInput {
  /** 取込先ソース（rag_sources.id）。 */
  readonly sourceId: string
  /** ソース種別（MVP 内部 4 種のいずれか）。 */
  readonly sourceType: MvpIngestSourceType
  /** ジョブ種別（rag_ingestion_jobs.job_type）。 */
  readonly jobType:
    | 'manual_upload'
    | 'scheduled_fetch'
    | 'internal_sync'
    | 'reindex'
  /**
   * 冪等キー（ボット採番 / 横断規約 §3）。
   * NULL（undefined）= 冪等性保証なし呼び出し（UI 等 / 部分 unique 対象外）。
   */
  readonly idempotencyKey?: string
  /** 取込対象アイテム群。 */
  readonly items: ReadonlyArray<IngestionItemInput>
  /** PMTP 横断追跡 ID（サーバ発行 / リトライ間で不変 / 05 §2.4.2）。 */
  readonly traceId: string
  /** 1 実行ごとの ID（サーバ発行 / リトライで変わる）。 */
  readonly requestId: string
}

/** 1 chunk の永続化前中間表現（chunker 出力）。 */
export interface ChunkDraft {
  /** 0 起点・連続・重複なしの文書内順序（27 §10.3）。 */
  readonly chunkIndex: number
  /** chunk 本文（正規化済み）。 */
  readonly content: string
  /** sha256（差分判定 / 重複排除）。 */
  readonly contentHash: string
  /** トークン概算数。 */
  readonly tokenCount: number
  /** 検索フィルタ用メタデータ。 */
  readonly metadata: Record<string, unknown>
  readonly sourceType: SourceType
  readonly symbol: string | null
  readonly market: string | null
  readonly timeframe: string | null
  readonly eventTime: Date | null
  readonly language: Language
  readonly riskTags: string[]
  /**
   * chunk の隔離状態。injection 疑い等で QUARANTINED になると検索除外される。
   * 通常は ACTIVE。
   */
  readonly status: ChunkStatus
}

/** 1 document の取込結果（item 単位）。 */
export interface IngestionItemResult {
  readonly itemId: string
  readonly documentId: string | null
  readonly externalId: string | null
  readonly status: IngestionItemStatus
  /** 生成 chunk 数（SKIPPED / FAILED 時は 0）。 */
  readonly chunkCount: number
  /** content_hash 一致で再 Embedding を省略した chunk 数（差分更新 / 27 §10.2）。 */
  readonly reusedEmbeddingCount: number
  /** 新規生成した Embedding 数。 */
  readonly newEmbeddingCount: number
  readonly errorMessage: string | null
}

/** Ingestion ジョブ 1 回分の結果。 */
export interface IngestionJobResult {
  readonly jobId: string
  readonly status: IngestionStatus
  /** 冪等 replay（既存ジョブをそのまま返した）か。横断規約 §3。 */
  readonly replayed: boolean
  readonly totalCount: number
  readonly successCount: number
  readonly failedCount: number
  readonly items: IngestionItemResult[]
  readonly traceId: string
  readonly requestId: string
}

/** 文書ステータス遷移（rag_documents.status / 05 §5.3）。 */
export type IngestDocumentStatus = DocumentStatus
