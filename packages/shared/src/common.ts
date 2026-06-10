/**
 * Training Bot RAG Hub — 共通プリミティブ Zod schema
 *
 * - 金融数値は string 保持（10 §2.1 Decimal Safe / 05 §2.4.5）。number 化しない。
 * - meta / error model / citation は 10 §3.4 / §6.1 の正本。
 * - enum はすべて ./rag-enums の SSoT を参照する（値リテラルを再宣言しない）。
 *
 * 金融数値 vs スコア値の区別（重要 / 10 §6 各 API 注記）:
 *   - 金融数値（price / qty / drawdown / runup / funding_rate / atr / 金額 / *_pct）
 *       → `moneyStringSchema`（string）。IEEE 754 誤差防止。
 *   - スコア値（similarity / confidence / reliability / retrieval_score / rsi）
 *       → number のまま可（金融数値ではない）。
 */

import { z } from 'zod'
import {
  errorCodeSchema,
  errorDetailCodeSchema,
  sourceTypeSchema,
  citationQualityStatusSchema,
  guardrailStatusSchema,
} from './rag-enums'

/* -------------------------------------------------------------------------- */
/* 金融数値（string）/ スコア / 共通プリミティブ                               */
/* -------------------------------------------------------------------------- */

/**
 * 金融数値を表す string。number ではない（Decimal Safe）。
 * 数値としてパース可能な文字列（符号・小数許容）のみを受け付ける。
 * 例: "65000.50" / "-1.8" / "0.012" / "4.2"
 */
export const moneyStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string (e.g. "65000.50")')
export type MoneyString = z.infer<typeof moneyStringSchema>

/** 0〜1 のスコア値（similarity / confidence / reliability 等 / number 許容）。 */
export const scoreSchema = z.number().min(0).max(1)

export const uuidSchema = z.string().uuid()
export const isoDateTimeSchema = z.string().datetime()

/* -------------------------------------------------------------------------- */
/* 共通 meta（10 §3.4 Success / Error 共通）                                   */
/* -------------------------------------------------------------------------- */

export const responseMetaSchema = z.object({
  /** サーバ発行。PMTP↔RAG 横断追跡（リトライ跨ぎで不変） */
  trace_id: z.string(),
  /** サーバ発行。1 HTTP 実行ごと（リトライで変わる） */
  request_id: z.string(),
  /** POST のみエコーバック（クライアント採番キー） */
  idempotency_key: z.string().optional(),
  /** true = 過去結果の再返却（再課金なし） */
  idempotency_replayed: z.boolean().optional(),
  timestamp: isoDateTimeSchema,
})
export type ResponseMeta = z.infer<typeof responseMetaSchema>

/* -------------------------------------------------------------------------- */
/* エラーモデル（10 §3.4 Error / §4）                                          */
/* -------------------------------------------------------------------------- */

/** error.details[] の構造化要素（10 §3.4: [{field, code, message}]）。 */
export const errorDetailSchema = z.object({
  /** リクエスト JSON のパス（ネストは dot 記法: "features.rsi"）。全体エラーは "" */
  field: z.string(),
  code: errorDetailCodeSchema,
  message: z.string(),
})
export type ErrorDetail = z.infer<typeof errorDetailSchema>

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.array(errorDetailSchema).optional(),
})
export type ApiError = z.infer<typeof apiErrorSchema>

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: apiErrorSchema,
  meta: responseMetaSchema,
})
export type ErrorResponse = z.infer<typeof errorResponseSchema>

/**
 * 成功レスポンスのラッパ。data 部分の schema を受け取って合成する。
 * 使用例: `const queryResponseSchema = successResponseSchema(queryResponseDataSchema)`
 */
export function successResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: responseMetaSchema,
  })
}

/* -------------------------------------------------------------------------- */
/* Citation（10 §6.1 citation オブジェクト定義 / B2 whitelist）                */
/* -------------------------------------------------------------------------- */

/**
 * citation オブジェクト（10 §6.1 / 05 §5.11）。
 * excerpt は UI 向けのみ（Secret Masking 通過後）。training_bot 向けは省略される
 * （audience 別出し分け / 10 §6.1）ため optional。
 * whitelist 検証（chunk_id が当該クエリの retrieval 集合に実在）は API 層 + DB 複合 FK で強制。
 */
export const citationSchema = z.object({
  source_id: uuidSchema,
  document_id: uuidSchema,
  chunk_id: uuidSchema,
  source_type: sourceTypeSchema,
  title: z.string().optional(),
  used_reason: z.string(),
  /** UI 向けのみ。先頭 ~300 字 / Secret Masking 済み。 */
  excerpt: z.string().optional(),
  /** chunk.event_time のスナップショット（nullable） */
  event_time: isoDateTimeSchema.nullable(),
  /** 取込時点のスナップショット（鮮度検証用） */
  ingested_at: isoDateTimeSchema,
  /** rerank 後の検索スコア（金融数値ではないため number） */
  retrieval_score: z.number(),
  /** ACTIVE 以外は Guardrail BLOCK 対象 */
  quality_status: citationQualityStatusSchema,
})
export type Citation = z.infer<typeof citationSchema>

/* -------------------------------------------------------------------------- */
/* Guardrail / LLM usage（レスポンス内に共通で現れるサブオブジェクト）          */
/* -------------------------------------------------------------------------- */

/** レスポンス data 内の guardrail サブオブジェクト（10 §6.1 / §9.2）。 */
export const guardrailResultSchema = z.object({
  status: guardrailStatusSchema,
  /** 常に literal false（一次防御は DB ロール物理遮断 / 本フィールドは二次防御）。 */
  order_permission: z.literal(false),
  reason: z.string().optional(),
  blocked_reasons: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
})
export type GuardrailResult = z.infer<typeof guardrailResultSchema>

/** Provider 利用情報（10 §6.1 llm）。estimated_cost は金額=string。 */
export const llmUsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  fallback_used: z.boolean(),
  input_tokens: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
  /** 金額（string / Decimal Safe） */
  estimated_cost: moneyStringSchema.optional(),
  latency_ms: z.number().int().optional(),
})
export type LlmUsage = z.infer<typeof llmUsageSchema>
