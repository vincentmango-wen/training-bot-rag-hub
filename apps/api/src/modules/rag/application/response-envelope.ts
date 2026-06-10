/**
 * 成功レスポンスの共通エンベロープ組み立て（10 §3.4 Success / meta）。
 *
 * meta には常に trace_id / request_id / timestamp を入れ、POST では idempotency_key と
 * idempotency_replayed を併載する（10 §3.4 / B1）。
 */
import type { ResponseMeta } from '@pmtp/shared'
import type { TraceContext } from '../http/trace-context'

export interface BuildMetaArgs {
  trace: TraceContext
  /** POST のみ（GET では undefined）。 */
  idempotencyKey?: string
  /** POST のみ。replay なら true（再課金なし / 10 §3.4）。 */
  idempotencyReplayed?: boolean
}

export function buildMeta(args: BuildMetaArgs): ResponseMeta {
  const meta: ResponseMeta = {
    trace_id: args.trace.trace_id,
    request_id: args.trace.request_id,
    timestamp: new Date().toISOString(),
  }
  if (args.idempotencyKey !== undefined) {
    meta.idempotency_key = args.idempotencyKey
    meta.idempotency_replayed = args.idempotencyReplayed ?? false
  }
  return meta
}

/** success エンベロープ（success:true + data + meta）。 */
export function successEnvelope<T>(
  data: T,
  meta: ResponseMeta,
): { success: true; data: T; meta: ResponseMeta } {
  return { success: true, data, meta }
}
