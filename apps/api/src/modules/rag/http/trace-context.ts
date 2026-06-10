/**
 * trace_id / request_id の発行・保持（10 §3.4.1 識別子の発行責務 / B4）。
 *
 * - trace_id: **RAG サーバ発行**。1 論理処理（API → Retrieval → LLM → Guardrail → 保存）で不変。
 *   X-Correlation-Id を受領しても trace_id の代わりにはせず、監査併記としてのみ保持する
 *   （偽装・衝突防止 / 10 §3.3 注記「X-Trace-Id 廃止」）。
 * - request_id: **RAG サーバ発行**。1 HTTP 実行ごと（リトライで変わる）。
 *
 * TraceInterceptor が request ごとに 1 つ生成して req に載せ、controller / orchestrator が
 * これを meta + 必要な data に貫通させる（10 §3.4.2 data 併載契約）。
 */
import { randomUUID } from 'node:crypto'

/** 1 リクエストの相関コンテキスト。req オブジェクトに添付して貫通させる。 */
export interface TraceContext {
  /** RAG サーバ発行 / 論理処理で不変。 */
  trace_id: string
  /** RAG サーバ発行 / 1 HTTP 実行ごと。 */
  request_id: string
  /** 呼出側の相関 ID（X-Correlation-Id / 監査併記のみ / 任意）。 */
  correlation_id?: string
}

/** req に TraceContext を添付するためのキー。 */
export const TRACE_CONTEXT_KEY = '__ragTraceContext' as const

export function createTraceContext(correlationId?: string): TraceContext {
  const ctx: TraceContext = {
    trace_id: randomUUID(),
    request_id: randomUUID(),
  }
  if (correlationId !== undefined && correlationId.length > 0) {
    ctx.correlation_id = correlationId
  }
  return ctx
}

/** req から TraceContext を取り出す（未設定時は防御的に新規生成）。 */
export function getTraceContext(req: unknown): TraceContext {
  const holder = req as Record<string, unknown> | null
  const existing = holder?.[TRACE_CONTEXT_KEY]
  if (isTraceContext(existing)) return existing
  return createTraceContext()
}

function isTraceContext(value: unknown): value is TraceContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TraceContext).trace_id === 'string' &&
    typeof (value as TraceContext).request_id === 'string'
  )
}
