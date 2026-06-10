/**
 * Provider 層の共通型定義（24_Provider Policy 設計書）。
 *
 * - Provider 抽象（EmbeddingProvider / LlmProvider）と Router が共有する型。
 * - enum 値（ProviderName / RagTaskType）は本ファイルに SSoT として集約し、
 *   各 adapter / router で再宣言しない（横断規約 §1 enum SSoT と同型）。
 * - 金融数値ではないトークン数・latency は number、推定コスト（金額）は string
 *   保持（横断規約 §2 / 10 §6.1 `estimated_cost` は string）。
 */
import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* ProviderName — 24 §3.1 管理対象 Provider（MVP は openai のみ実装）          */
/* Claude / Gemini / Mistral / Local は interface 拡張余地として enum に残すが、  */
/* MVP では adapter を実装しない（16 MVP スコープ / OpenAI のみ）。              */
/* -------------------------------------------------------------------------- */
export const PROVIDER_NAMES = [
  'openai',
  'claude',
  'gemini',
  'mistral',
  'local',
] as const
export type ProviderName = (typeof PROVIDER_NAMES)[number]
export const providerNameSchema = z.enum(PROVIDER_NAMES)

/** MVP で実装済みの Provider（adapter が存在する集合）。 */
export const MVP_PROVIDER_NAMES = ['openai'] as const satisfies readonly ProviderName[]
export type MvpProviderName = (typeof MVP_PROVIDER_NAMES)[number]

/* -------------------------------------------------------------------------- */
/* RagTaskType — 24 §5 Task 分類                                              */
/* Provider 選定（Primary/Fallback）はこの Task 単位で決まる（24 §6.1）。       */
/* -------------------------------------------------------------------------- */
export const RAG_TASK_TYPES = [
  'MARKET_SUMMARY',
  'BOT_EXPLANATION',
  'RISK_REVIEW',
  'SIMILAR_CASE_ANALYSIS',
  'EXTERNAL_NEWS_SUMMARY',
  'BACKTEST_REPORT',
  'PROVIDER_EVALUATION',
  'EMBEDDING',
  'HIGH_CONFIDENTIAL_ANALYSIS',
] as const
export type RagTaskType = (typeof RAG_TASK_TYPES)[number]
export const ragTaskTypeSchema = z.enum(RAG_TASK_TYPES)

/* -------------------------------------------------------------------------- */
/* ProviderHealth — 24 §9 Health Check Policy                                 */
/* -------------------------------------------------------------------------- */
export const PROVIDER_HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE'] as const
export type ProviderHealth = (typeof PROVIDER_HEALTH_STATES)[number]

/* -------------------------------------------------------------------------- */
/* Token 使用量・コスト（24 §15 監査ログ要件 / 10 §6.1 llm）                    */
/* -------------------------------------------------------------------------- */

/** トークン使用量。トークン数は金融数値ではないため number。 */
export interface ProviderTokenUsage {
  input_tokens: number
  output_tokens: number
}

/**
 * Provider 呼び出し 1 回ぶんの結果メタ（成功時）。
 * estimated_cost は金額のため string（横断規約 §2 / 10 §6.1）。
 */
export interface ProviderCallMeta {
  provider: ProviderName
  model: string
  /** Primary が失敗し Fallback で成功した場合 true（24 §10）。 */
  fallback_used: boolean
  input_tokens: number
  output_tokens: number
  /** 金額（string / Decimal Safe）。算出不能時は省略。 */
  estimated_cost?: string
  latency_ms: number
}

/* -------------------------------------------------------------------------- */
/* Provider 層エラー分類（10 §4 / 05 §5.17 rag_provider_errors.error_type）     */
/* -------------------------------------------------------------------------- */
export const PROVIDER_FAILURE_KINDS = [
  'api_error', // 一般 API エラー（5xx 等） → RAG_PROVIDER_ERROR(502)
  'timeout', // per-call timeout 超過 → RAG_PROVIDER_TIMEOUT(504)
  'rate_limit', // 429 → リトライ対象
  'schema_invalid', // structured output が schema 不適合 → RAG_PROVIDER_ERROR
  'safety_block', // provider 側 safety で拒否 → RAG_GUARDRAIL_BLOCKED 相当
] as const
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]

/**
 * Provider 呼び出しの失敗を表す型付きエラー。
 * Router はこの kind を見て fallback / retry / abort を決める。
 */
export class ProviderError extends Error {
  readonly kind: ProviderFailureKind
  readonly provider: ProviderName
  /** リトライ可能か（rate_limit / timeout / 一過性 api_error は true）。 */
  readonly retryable: boolean
  /** HTTP 由来の場合のステータス（任意）。 */
  readonly statusCode?: number
  override readonly cause?: unknown

  constructor(params: {
    kind: ProviderFailureKind
    provider: ProviderName
    message: string
    retryable?: boolean
    statusCode?: number
    cause?: unknown
  }) {
    super(params.message)
    this.name = 'ProviderError'
    this.kind = params.kind
    this.provider = params.provider
    this.retryable =
      params.retryable ??
      (params.kind === 'timeout' || params.kind === 'rate_limit')
    if (params.statusCode !== undefined) this.statusCode = params.statusCode
    if (params.cause !== undefined) this.cause = params.cause
  }
}
