/**
 * OpenAI クライアントの **port**（DI 注入境界 / 24 PP-002 Lock-in 禁止）。
 *
 * OpenAI SDK の生インスタンスを adapter から直接 import せず、本 port 経由で
 * 注入する。これにより:
 *   - テストで mock 差し替え可能（API キー・ネットワーク不要 / 課題要件）
 *   - SDK バージョン差・呼び出し形の差を 1 箇所に封じ込め
 *   - 将来の provider 追加時も adapter は port に依存（実装非依存）
 *
 * 本 port は「OpenAI が提供する 2 操作」だけを最小公開する:
 *   - createChatCompletion（structured output 強制 / JSON schema）
 *   - createEmbeddings（text-embedding-3-small）
 *
 * 実 SDK を包む実装は `openai-client.openai-sdk.ts`（任意 / runtime のみ）。
 */

/** chat completion の 1 メッセージ。 */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** structured output（JSON schema）強制のための指定（21 §出力 Schema 固定）。 */
export interface OpenAIResponseFormatJsonSchema {
  type: 'json_schema'
  json_schema: {
    name: string
    /** JSON Schema（draft 2020-12 サブセット）。adapter が Zod から変換して渡す。 */
    schema: Record<string, unknown>
    /** 追加プロパティ禁止・全項目 required を強制（OpenAI strict mode）。 */
    strict: true
  }
}

export interface OpenAIChatCompletionParams {
  model: string
  messages: OpenAIChatMessage[]
  /** 24 PP-003 安全性優先 + 再現性のため温度固定（既定 0）。 */
  temperature: number
  /** 再現性のための seed 固定（24 温度/seed 固定）。 */
  seed: number
  /** structured output 強制（必須 / 21 出力 JSON Schema 固定）。 */
  response_format: OpenAIResponseFormatJsonSchema
  /** per-call の上限トークン（任意）。 */
  max_tokens?: number
  /** AbortSignal による per-call timeout（Router が付与）。 */
  signal?: AbortSignal
}

export interface OpenAIChatCompletionResult {
  /** structured output の生 JSON 文字列（adapter が parse + Zod 検証）。 */
  content: string
  model: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
  }
  /** provider 側が safety で停止した場合の理由（'content_filter' 等）。 */
  finish_reason?: string
}

export interface OpenAIEmbeddingParams {
  model: string
  input: string[]
  signal?: AbortSignal
}

export interface OpenAIEmbeddingResult {
  /** input と同順の埋め込みベクトル群。 */
  embeddings: number[][]
  model: string
  usage: {
    prompt_tokens: number
  }
}

/**
 * adapter が依存する OpenAI 抽象。実 SDK / mock いずれもこの形を満たす。
 */
export interface OpenAIClientPort {
  createChatCompletion(
    params: OpenAIChatCompletionParams,
  ): Promise<OpenAIChatCompletionResult>

  createEmbeddings(
    params: OpenAIEmbeddingParams,
  ): Promise<OpenAIEmbeddingResult>
}

/** Nest DI トークン（interface は実体を持たないため文字列トークンで注入）。 */
export const OPENAI_CLIENT = Symbol('OPENAI_CLIENT')
