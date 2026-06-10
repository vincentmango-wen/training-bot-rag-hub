/**
 * Training Bot RAG Hub — MVP 4 エンドポイントの I/O Zod schema
 *
 * 対象（16_MVP仕様書 / 10 §5.1）:
 *   - POST /api/v1/rag/query          … §6.1
 *   - POST /api/v1/rag/bot-context    … §6.2
 *   - POST /api/v1/rag/similar-cases  … §6.3
 *   - GET  /api/v1/rag/history        … §6.4
 *
 * 金融数値（atr / funding_rate / *_pct / 金額）は string（10 §2.1 Decimal Safe）。
 * similarity / confidence / retrieval_score / rsi はスコア値のため number。
 * enum はすべて ./rag-enums の SSoT を参照する（値リテラルを再宣言しない）。
 */

import { z } from 'zod'
import {
  sourceTypeSchema,
  botSignalSchema,
  riskLevelSchema,
  marketSchema,
  languageSchema,
} from './rag-enums'
import {
  uuidSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  scoreSchema,
  citationSchema,
  guardrailResultSchema,
  llmUsageSchema,
  successResponseSchema,
} from './common'

/* ========================================================================== */
/* 6.1 RAG Query API — POST /rag/query                                        */
/* ========================================================================== */

/** top_k の上限（retrieval / oversample 暴走防止 / 05 §8.1 既定 20 に対する安全上限）。 */
export const MAX_TOP_K = 50

export const queryRequestSchema = z.object({
  query: z.string().min(1),
  symbol: z.string().optional(),
  market: marketSchema.optional(),
  /** 自由文字列許容（"1m"/"5m"/"1h"/"1d" 等）。代表値以外も受けるため string。 */
  timeframe: z.string().optional(),
  /** 検索対象ソース種別（SourceType SSoT / 10 §6.1） */
  source_types: z.array(sourceTypeSchema).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  language: languageSchema.optional(),
  // top_k 上限 50（Minor: 上限なしだと巨大値で retrieval / oversample が暴走するため schema で固定）。
  top_k: z.number().int().positive().max(MAX_TOP_K).optional(),
  provider_policy: z.string().optional(),
})
export type QueryRequest = z.infer<typeof queryRequestSchema>

export const queryResponseDataSchema = z.object({
  query_id: uuidSchema,
  /** data 併載（呼出側が自レコードへ刻印 / 10 §3.4.2） */
  trace_id: z.string(),
  summary: z.string(),
  supporting_factors: z.array(z.string()),
  opposing_factors: z.array(z.string()),
  risk_level: riskLevelSchema,
  confidence: scoreSchema,
  citations: z.array(citationSchema),
  llm: llmUsageSchema,
  guardrail: guardrailResultSchema,
})
export type QueryResponseData = z.infer<typeof queryResponseDataSchema>

export const queryResponseSchema = successResponseSchema(queryResponseDataSchema)
export type QueryResponse = z.infer<typeof queryResponseSchema>

/* ========================================================================== */
/* 6.2 Bot Context API — POST /rag/bot-context                                */
/* ========================================================================== */

/**
 * features: テクニカル指標等の自由 JSON。
 * atr / funding_rate 等の金融数値は string（10 §6.2）。rsi 等のスコアは number。
 * 値の混在を許容する record（個別キー検証は API 層の責務）。
 */
export const botContextFeaturesSchema = z.record(z.string(), z.unknown())

export const botContextRequestSchema = z.object({
  bot_id: uuidSchema,
  strategy_id: uuidSchema.optional(),
  symbol: z.string().optional(),
  market: marketSchema.optional(),
  timeframe: z.string().optional(),
  bot_signal: botSignalSchema,
  features: botContextFeaturesSchema.optional(),
  provider_policy: z.string().optional(),
})
export type BotContextRequest = z.infer<typeof botContextRequestSchema>

/** similar_cases[] の 1 件（金融数値 *_pct は string / 10 §6.2）。 */
export const botContextSimilarCaseSchema = z.object({
  case_id: uuidSchema,
  period_from: isoDateTimeSchema,
  period_to: isoDateTimeSchema,
  similarity: z.number(),
  outcome: z.string(),
  max_drawdown_pct: moneyStringSchema,
  max_favorable_excursion_pct: moneyStringSchema,
})
export type BotContextSimilarCase = z.infer<typeof botContextSimilarCaseSchema>

export const botContextResponseDataSchema = z.object({
  context_id: uuidSchema,
  trace_id: z.string(),
  bot_id: uuidSchema,
  strategy_id: uuidSchema.optional(),
  symbol: z.string().optional(),
  bot_signal: botSignalSchema,
  explanation: z.string(),
  supporting_factors: z.array(z.string()),
  opposing_factors: z.array(z.string()),
  similar_cases: z.array(botContextSimilarCaseSchema),
  risk_level: riskLevelSchema,
  confidence: scoreSchema,
  /** 常に literal false（二次防御 / Bot は破棄してよい契約） */
  order_permission: z.literal(false),
  action_policy: z.string(),
  llm: llmUsageSchema,
})
export type BotContextResponseData = z.infer<
  typeof botContextResponseDataSchema
>

export const botContextResponseSchema = successResponseSchema(
  botContextResponseDataSchema,
)
export type BotContextResponse = z.infer<typeof botContextResponseSchema>

/* ========================================================================== */
/* 6.3 Similar Cases API — POST /rag/similar-cases                            */
/* ========================================================================== */

export const similarCasesRequestSchema = z.object({
  symbol: z.string().optional(),
  market: marketSchema.optional(),
  timeframe: z.string().optional(),
  /** price_change_pct_24h 等の金融数値は string（10 §6.3） */
  features: z.record(z.string(), z.unknown()).optional(),
  lookback_days: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
})
export type SimilarCasesRequest = z.infer<typeof similarCasesRequestSchema>

/** cases[] の 1 件（after_move_*_pct / max_drawdown_pct は string / 10 §6.3）。 */
export const similarCaseSchema = z.object({
  case_id: uuidSchema,
  symbol: z.string(),
  period_from: isoDateTimeSchema,
  period_to: isoDateTimeSchema,
  similarity: z.number(),
  matched_features: z.array(z.string()),
  after_move_4h_pct: moneyStringSchema,
  after_move_24h_pct: moneyStringSchema,
  max_drawdown_pct: moneyStringSchema,
  risk_notes: z.array(z.string()),
})
export type SimilarCase = z.infer<typeof similarCaseSchema>

export const similarCasesResponseDataSchema = z.object({
  cases: z.array(similarCaseSchema),
})
export type SimilarCasesResponseData = z.infer<
  typeof similarCasesResponseDataSchema
>

export const similarCasesResponseSchema = successResponseSchema(
  similarCasesResponseDataSchema,
)
export type SimilarCasesResponse = z.infer<typeof similarCasesResponseSchema>

/* ========================================================================== */
/* 6.4 RAG History API — GET /rag/history                                     */
/* ========================================================================== */

/**
 * Query Parameters（10 §6.4）。GET のクエリ文字列由来のため数値は coerce する。
 */
export const historyQuerySchema = z.object({
  symbol: z.string().optional(),
  bot_id: uuidSchema.optional(),
  risk_level: riskLevelSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
})
export type HistoryQuery = z.infer<typeof historyQuerySchema>

export const historyItemSchema = z.object({
  query_id: uuidSchema,
  created_at: isoDateTimeSchema,
  symbol: z.string().optional(),
  query: z.string(),
  risk_level: riskLevelSchema,
  confidence: scoreSchema,
  provider: z.string(),
  model: z.string(),
  guardrail_status: z.string(),
})
export type HistoryItem = z.infer<typeof historyItemSchema>

export const paginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
})
export type Pagination = z.infer<typeof paginationSchema>

export const historyResponseDataSchema = z.object({
  items: z.array(historyItemSchema),
  pagination: paginationSchema,
})
export type HistoryResponseData = z.infer<typeof historyResponseDataSchema>

export const historyResponseSchema = successResponseSchema(
  historyResponseDataSchema,
)
export type HistoryResponse = z.infer<typeof historyResponseSchema>
