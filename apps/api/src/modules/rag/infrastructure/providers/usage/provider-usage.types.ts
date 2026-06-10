/**
 * Provider 利用量レコード（24 §15 監査ログ要件 / 05 §5.15 rag_provider_calls）。
 *
 * Router は per-call で本レコードを生成し、Recorder へ渡す（at-least-once）。
 * 永続化（Prisma 書き込み）は別チケットの repository 実装に委譲し、本層は
 * 「記録要求」までを責務とする（疎結合 / 30 境界定義）。
 */
import type {
  ProviderCallStatus,
  ProviderCallType,
} from '@pmtp/shared'
import type {
  ProviderName,
  RagTaskType,
} from '../provider.types'

export interface ProviderUsageRecord {
  /** 同一論理操作の相関 ID（PMTP↔RAG 横断 / 10 §3.4.2）。 */
  trace_id: string
  /** 1 HTTP 実行ごとの ID（10 §3.4.2）。 */
  request_id: string
  task_type: RagTaskType
  call_type: ProviderCallType
  provider: ProviderName
  model: string
  status: ProviderCallStatus
  /** Primary 失敗 → Fallback 成功で true。 */
  fallback_used: boolean
  input_tokens: number
  output_tokens: number
  /** 金額（string / Decimal Safe）。算出不能時は省略。 */
  estimated_cost?: string
  latency_ms: number
  /** 失敗時のエラー分類（05 §5.17）。成功時は省略。 */
  error_type?: string
  /** 失敗時のメッセージ（Secret は含めない / 13 Secret 送信禁止）。 */
  error_message?: string
  /** 呼び出し開始時刻（ISO8601）。 */
  started_at: string
}
