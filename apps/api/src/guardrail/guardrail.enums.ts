/**
 * Guardrail モジュールが参照する enum / 定数。
 *
 * enum SSoT の正本は `@pmtp/shared`（packages/shared/src/rag-enums.ts）。本ファイルは
 * その SSoT を **再 export** し、guardrail 内でしか意味を持たない少数の補助ラベルだけを
 * 追加で定義する（値リテラルを各所で再宣言しない / 横断規約1 §enum SSoT）。
 *
 * 補助ラベルの位置づけ:
 *   - GuardrailType を guardrail 内部では 2 値（citation_whitelist / citation_quality）
 *     細分化する。DB 保存（05 §5.12 の 5 値 enum）へは `toPersistedGuardrailType()` で
 *     上位 type（schema_validation / prohibited_expression）に丸めてから永続化する。
 */
import {
  ORDER_PERMISSION as SHARED_ORDER_PERMISSION,
  GUARDRAIL_STATUSES as SHARED_GUARDRAIL_STATUSES,
  GUARDRAIL_TYPES as SHARED_GUARDRAIL_TYPES,
  SEVERITIES as SHARED_SEVERITIES,
  CITATION_QUALITY_STATUSES as SHARED_CITATION_QUALITY_STATUSES,
  ERROR_CODES as SHARED_ERROR_CODES,
  type OrderPermission as SharedOrderPermission,
  type GuardrailStatus as SharedGuardrailStatus,
  type GuardrailType as SharedGuardrailType,
  type Severity as SharedSeverity,
  type CitationQualityStatus as SharedCitationQualityStatus,
} from '@pmtp/shared'

/* --------------------------- SSoT 再 export -------------------------------- */

/** order_permission は常に literal false（横断規約5 / 10 §9.1 / 30 §6）。 */
export const ORDER_PERMISSION = SHARED_ORDER_PERMISSION
export type OrderPermission = SharedOrderPermission

/** guardrail_status — 05 §6.4 / 10 §9.2（PASS / WARNING / BLOCKED）。 */
export const GUARDRAIL_STATUSES = SHARED_GUARDRAIL_STATUSES
export type GuardrailStatus = SharedGuardrailStatus

/** severity — 05 §5.12 rag_guardrail_results.severity。 */
export const GUARDRAIL_SEVERITIES = SHARED_SEVERITIES
export type GuardrailSeverity = SharedSeverity

/** citation.quality_status 合成 5 値（05 §5.11 / 10 §6.1）。 */
export const CITATION_QUALITY_STATUSES = SHARED_CITATION_QUALITY_STATUSES
export type CitationQualityStatus = SharedCitationQualityStatus

/* ----------------------- guardrail 内部の補助ラベル ------------------------- */

/** rag_chunks.status の許可値（ACTIVE 以外は検索対象外・引用不可 / 05 §5.4）。 */
export const CHUNK_ACTIVE_STATUS = 'ACTIVE' as const

/** 引用として許可される唯一の quality_status（10 §9.1 Citation 品質検証）。 */
export const CITATION_ACTIVE_STATUS = 'ACTIVE' as const

/**
 * guardrail 内部での違反分類。SSoT の GUARDRAIL_TYPES（5 値）に
 * citation 検証の細分ラベル 2 値を足した superset。
 */
export const GUARDRAIL_TYPES = [
  ...SHARED_GUARDRAIL_TYPES,
  'citation_whitelist',
  'citation_quality',
] as const
export type GuardrailType =
  | SharedGuardrailType
  | 'citation_whitelist'
  | 'citation_quality'

/**
 * guardrail 内部の細分 type を DB 永続用（05 §5.12 の 5 値）に丸める。
 * citation 系はいずれも「根拠の妥当性」検証なので schema_validation に集約する。
 */
export function toPersistedGuardrailType(
  type: GuardrailType,
): SharedGuardrailType {
  if (type === 'citation_whitelist' || type === 'citation_quality') {
    return 'schema_validation'
  }
  return type
}

/** Bot 向け generic 語彙（30 §6: action_permission(false) + action_policy）。 */
export const ACTION_PERMISSION = false as const
export type ActionPermission = typeof ACTION_PERMISSION
export const ACTION_POLICY_ORDER_NOT_ALLOWED = 'ORDER_NOT_ALLOWED_BY_RAG' as const

/** Guardrail BLOCK 時に呼び出し側へ通知するエラーコード（10 §4 / 422）。 */
export const ERROR_CODE_GUARDRAIL_BLOCKED = (() => {
  const code = 'RAG_GUARDRAIL_BLOCKED'
  // SSoT の ERROR_CODES に確実に存在することをロード時に保証（typo 防止）。
  if (!SHARED_ERROR_CODES.includes(code)) {
    throw new Error('RAG_GUARDRAIL_BLOCKED missing from @pmtp/shared ERROR_CODES')
  }
  return code
})()
