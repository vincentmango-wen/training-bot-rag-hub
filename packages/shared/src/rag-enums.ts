/**
 * RAG enum SSoT（Single Source of Truth）
 *
 * 値集合の正本は 05_DB_ER設計書 §6 / 10_API設計書 §3.4.3。
 * 本ファイルが TS / Zod / Prisma migration が参照する唯一の正本であり、
 * 値リテラルを各所で再宣言・部分列挙してはならない（FE/BE enum SSoT 規約同型）。
 *
 * パターン: `as const` 配列 → `satisfies` で集合検証 → `z.enum` で Zod schema →
 * `(typeof X)[number]` で型導出。配列・型・Zod を 1 箇所から導出する。
 */
import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* source_type — 05 §6.1（全 12 値） / 10 §3.4.3 SourceType                    */
/* ◎ = MVP 実投入（4 値） / △ = enum 定義済・投入は Phase2 以降                */
/* -------------------------------------------------------------------------- */
export const SOURCE_TYPES = [
  'market_data', // ◎ MVP
  'bot_log', // ◎ MVP
  'order_history', // ◎ MVP
  'strategy_doc', // ◎ MVP
  'execution_history', // △ Phase2+
  'position_history', // △ Phase2+
  'audit_log', // △ Phase2+
  'news', // △ Phase2+
  'sns', // △ Phase2+
  'prediction_market', // △ Phase2+
  'macro_event', // △ Phase2+
  'manual_note', // △ Phase2+
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]
export const sourceTypeSchema = z.enum(SOURCE_TYPES)

/** MVP で実データ投入する 4 値（検索・取込のデフォルト対象） */
export const MVP_SOURCE_TYPES = [
  'market_data',
  'bot_log',
  'order_history',
  'strategy_doc',
] as const satisfies readonly SourceType[]
export type MvpSourceType = (typeof MVP_SOURCE_TYPES)[number]

/* -------------------------------------------------------------------------- */
/* query_type — 05 §6.2（全 8 値）                                            */
/* -------------------------------------------------------------------------- */
export const QUERY_TYPES = [
  'market_context',
  'bot_signal_explanation',
  'similar_case',
  'external_sentiment',
  'risk_review',
  'backtest_report',
  'history_review',
  'provider_eval',
] as const
export type QueryType = (typeof QUERY_TYPES)[number]
export const queryTypeSchema = z.enum(QUERY_TYPES)

/* -------------------------------------------------------------------------- */
/* BotSignal — 10 §3.4.3（4 値）                                              */
/* BUY / SELL / HOLD / NONE はいずれも投資指示ではなく Bot の仮シグナルラベル   */
/* -------------------------------------------------------------------------- */
export const BOT_SIGNALS = ['BUY', 'SELL', 'HOLD', 'NONE'] as const
export type BotSignal = (typeof BOT_SIGNALS)[number]
export const botSignalSchema = z.enum(BOT_SIGNALS)

/* -------------------------------------------------------------------------- */
/* risk_level — 05 §6.3                                                       */
/* -------------------------------------------------------------------------- */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]
export const riskLevelSchema = z.enum(RISK_LEVELS)

/* -------------------------------------------------------------------------- */
/* guardrail_status — 05 §6.4                                                 */
/* -------------------------------------------------------------------------- */
export const GUARDRAIL_STATUSES = ['PASS', 'WARNING', 'BLOCKED'] as const
export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number]
export const guardrailStatusSchema = z.enum(GUARDRAIL_STATUSES)

/** guardrail_type — 05 §5.12 */
export const GUARDRAIL_TYPES = [
  'prompt_injection',
  'schema_validation',
  'prohibited_expression',
  'secret_masking',
  'order_permission',
] as const
export type GuardrailType = (typeof GUARDRAIL_TYPES)[number]
export const guardrailTypeSchema = z.enum(GUARDRAIL_TYPES)

/* -------------------------------------------------------------------------- */
/* status ステートマシン群（テーブル別 / 05 各 §5.x）                          */
/* -------------------------------------------------------------------------- */

/** rag_sources.status — 05 §5.1 */
export const SOURCE_STATUSES = ['ACTIVE', 'DISABLED', 'BLOCKED'] as const
export type SourceStatus = (typeof SOURCE_STATUSES)[number]
export const sourceStatusSchema = z.enum(SOURCE_STATUSES)

/** rag_documents.status — 05 §5.3 */
export const DOCUMENT_STATUSES = [
  'PENDING',
  'NORMALIZED',
  'INDEXED',
  'FAILED',
  'BLOCKED',
  'DISABLED',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES)

/** rag_chunks.status — 05 §5.4（旧 BLOCKED → QUARANTINED にリネーム / B5・B7） */
export const CHUNK_STATUSES = ['ACTIVE', 'QUARANTINED', 'DISABLED'] as const
export type ChunkStatus = (typeof CHUNK_STATUSES)[number]
export const chunkStatusSchema = z.enum(CHUNK_STATUSES)

/** rag_embeddings.status — 05 §5.5 */
export const EMBEDDING_STATUSES = ['ACTIVE', 'STALE', 'FAILED'] as const
export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number]
export const embeddingStatusSchema = z.enum(EMBEDDING_STATUSES)

/** ingestion_status（rag_ingestion_jobs.status）— 05 §6.5 */
export const INGESTION_STATUSES = [
  'PENDING',
  'FETCHING',
  'NORMALIZED',
  'INDEXING',
  'INDEXED',
  'FAILED',
  'BLOCKED',
] as const
export type IngestionStatus = (typeof INGESTION_STATUSES)[number]
export const ingestionStatusSchema = z.enum(INGESTION_STATUSES)

/** rag_ingestion_job_items.status — 05 §5.7 */
export const INGESTION_ITEM_STATUSES = [
  'PENDING',
  'SUCCESS',
  'FAILED',
  'SKIPPED',
  'BLOCKED',
] as const
export type IngestionItemStatus = (typeof INGESTION_ITEM_STATUSES)[number]
export const ingestionItemStatusSchema = z.enum(INGESTION_ITEM_STATUSES)

/** rag_queries.status — 05 §5.8 */
export const QUERY_STATUSES = [
  'RECEIVED',
  'VALIDATED',
  'RETRIEVED',
  'GENERATED',
  'VALIDATED_OUTPUT',
  'SAVED',
  'RETURNED',
  'FAILED',
  'BLOCKED',
] as const
export type QueryStatus = (typeof QUERY_STATUSES)[number]
export const queryStatusSchema = z.enum(QUERY_STATUSES)

/** rag_responses.status — 05 §5.10 */
export const RESPONSE_STATUSES = [
  'GENERATED',
  'VALIDATED',
  'BLOCKED',
  'RETURNED',
] as const
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number]
export const responseStatusSchema = z.enum(RESPONSE_STATUSES)

/** rag_citations.quality_status — 05 §5.11（10 §6.1 と一致） */
export const CITATION_QUALITY_STATUSES = [
  'ACTIVE',
  'QUARANTINED',
  'DISABLED',
  'STALE',
  'LOW_RELIABILITY',
] as const
export type CitationQualityStatus = (typeof CITATION_QUALITY_STATUSES)[number]
export const citationQualityStatusSchema = z.enum(CITATION_QUALITY_STATUSES)

/** provider_call_status（rag_provider_calls.status）— 05 §6.6 */
export const PROVIDER_CALL_STATUSES = [
  'PENDING',
  'CALLING',
  'SUCCESS',
  'FAILED',
  'FALLBACK_USED',
  'BLOCKED',
] as const
export type ProviderCallStatus = (typeof PROVIDER_CALL_STATUSES)[number]
export const providerCallStatusSchema = z.enum(PROVIDER_CALL_STATUSES)

/** rag_provider_calls.call_type — 05 §5.15 */
export const PROVIDER_CALL_TYPES = ['chat', 'embedding', 'rerank', 'eval'] as const
export type ProviderCallType = (typeof PROVIDER_CALL_TYPES)[number]
export const providerCallTypeSchema = z.enum(PROVIDER_CALL_TYPES)

/** rag_provider_errors.error_type — 05 §5.17 */
export const PROVIDER_ERROR_TYPES = [
  'api_error',
  'timeout',
  'rate_limit',
  'schema_invalid',
  'safety_block',
] as const
export type ProviderErrorType = (typeof PROVIDER_ERROR_TYPES)[number]
export const providerErrorTypeSchema = z.enum(PROVIDER_ERROR_TYPES)

/**
 * order_permission は常に literal false（二次防御 / 横断規約 §5）。
 * 一次防御は DB ロール物理遮断（インフラ側）。コードでは前提にしない。
 */
export const ORDER_PERMISSION = false as const
export type OrderPermission = typeof ORDER_PERMISSION

/* -------------------------------------------------------------------------- */
/* severity — 05 §5.12 rag_guardrail_results.severity                         */
/* RiskLevel と同語彙だが別ドメイン（guardrail 重大度）のため別 enum で公開      */
/* -------------------------------------------------------------------------- */
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]
export const severitySchema = z.enum(SEVERITIES)

/* -------------------------------------------------------------------------- */
/* Provider Evaluation Job 状態 — 10 §8.4                                     */
/* -------------------------------------------------------------------------- */
export const PROVIDER_EVALUATION_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const
export type ProviderEvaluationJobStatus =
  (typeof PROVIDER_EVALUATION_JOB_STATUSES)[number]
export const providerEvaluationJobStatusSchema = z.enum(
  PROVIDER_EVALUATION_JOB_STATUSES,
)

/* -------------------------------------------------------------------------- */
/* エラーモデル — 10 §4 エラーコード定義 / §3.4 Error                          */
/* -------------------------------------------------------------------------- */
export const ERROR_CODES = [
  'RAG_VALIDATION_ERROR',
  'RAG_UNAUTHORIZED',
  'RAG_FORBIDDEN',
  'RAG_NOT_FOUND',
  'RAG_IDEMPOTENCY_CONFLICT',
  'RAG_GUARDRAIL_BLOCKED',
  'RAG_RATE_LIMITED',
  'RAG_COST_LIMIT_EXCEEDED',
  'RAG_INTERNAL_ERROR',
  'RAG_PROVIDER_ERROR',
  'RAG_PROVIDER_TIMEOUT',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
export const errorCodeSchema = z.enum(ERROR_CODES)

/** error.details[].code の機械可読サブコード — 10 §3.4 Error */
export const ERROR_DETAIL_CODES = [
  'INVALID_ENUM',
  'REQUIRED',
  'OUT_OF_RANGE',
  'TYPE_MISMATCH',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
] as const
export type ErrorDetailCode = (typeof ERROR_DETAIL_CODES)[number]
export const errorDetailCodeSchema = z.enum(ERROR_DETAIL_CODES)

/* -------------------------------------------------------------------------- */
/* X-Client-Type ヘッダ — 10 §3.3                                             */
/* -------------------------------------------------------------------------- */
export const CLIENT_TYPES = ['ui', 'training_bot', 'system', 'worker'] as const
export type ClientType = (typeof CLIENT_TYPES)[number]
export const clientTypeSchema = z.enum(CLIENT_TYPES)

/* -------------------------------------------------------------------------- */
/* リクエスト共通の絞り込み語彙（market / language / timeframe）               */
/* 05 各テーブル comment / 10 §6.1 Request 項目より                            */
/* -------------------------------------------------------------------------- */
export const MARKETS = ['crypto', 'stock', 'fx'] as const
export type Market = (typeof MARKETS)[number]
export const marketSchema = z.enum(MARKETS)

export const LANGUAGES = ['ja', 'en', 'zh'] as const
export type Language = (typeof LANGUAGES)[number]
export const languageSchema = z.enum(LANGUAGES)

/** 代表的な timeframe 値（API では自由文字列も許容するため検証は緩め） */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]
export const timeframeSchema = z.enum(TIMEFRAMES)
