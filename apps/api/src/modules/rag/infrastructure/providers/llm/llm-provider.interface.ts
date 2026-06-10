/**
 * LlmProvider 抽象（24 PP-002 / 要件 LlmProvider Mandatory）。
 *
 * - 出力は **必ず structured output（JSON Schema 強制）**（21 §出力 Schema 固定）。
 *   呼び出し側は Zod schema を渡し、provider は schema 適合した値だけを返す。
 *   schema 不適合は `ProviderError(kind: 'schema_invalid')` を投げる。
 * - 温度・seed は固定（24 温度/seed 固定 / PP-003 安全性優先）。adapter 既定を
 *   使い、呼び出し側は原則上書きしない（再現性のため）。
 * - prompt の組み立て（System/Task/Context/Query）は呼び出し側の責務。本層は
 *   「messages を受けて schema 適合 JSON を返す」までを担う。
 */
import type { ZodTypeAny, infer as ZodInfer } from 'zod'
import type { LlmProviderName } from './llm.types'
import type { ProviderCallMeta } from '../provider.types'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmGenerateRequest<TSchema extends ZodTypeAny> {
  /** System / Task / Context / Query を組み立てたメッセージ列（21 §3 構成）。 */
  messages: LlmMessage[]
  /**
   * 出力 JSON の Zod schema（structured output 強制 / citation・risk_level 等）。
   * provider はこの schema 名と JSON Schema を OpenAI strict mode に渡す。
   */
  schema: TSchema
  /** structured output の論理名（OpenAI json_schema.name に使う）。 */
  schemaName: string
  /**
   * 利用モデルの明示指定（policy が task 別に上書きする / 24 §6.1）。
   * 未指定なら provider 既定モデル。
   */
  model?: string
  /** per-call timeout（ms）。Router 既定を上書きする場合のみ。 */
  timeoutMs?: number
  /** 出力上限トークン（任意）。 */
  maxTokens?: number
  /**
   * 温度の明示上書き（**非推奨** / 再現性を崩す）。未指定なら adapter 既定（0）。
   * 評価ジョブ等で意図的に変える場合のみ使用。
   */
  temperature?: number
}

export interface LlmGenerateResult<TSchema extends ZodTypeAny> {
  /** schema 検証を通過した構造化出力。 */
  data: ZodInfer<TSchema>
  /** 呼び出しメタ（usage 記録・監査用）。 */
  meta: ProviderCallMeta
}

export interface LlmProvider {
  readonly provider: LlmProviderName
  /** 既定モデル（例: gpt-4o-mini 系）。Router が task 別に上書き可能。 */
  readonly model: string

  /**
   * structured output を 1 回生成する。schema 不適合・timeout・api error は
   * ProviderError を throw（Router が fallback/retry を判断）。
   */
  generateStructured<TSchema extends ZodTypeAny>(
    request: LlmGenerateRequest<TSchema>,
  ): Promise<LlmGenerateResult<TSchema>>
}

/** Nest DI トークン。 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER')
