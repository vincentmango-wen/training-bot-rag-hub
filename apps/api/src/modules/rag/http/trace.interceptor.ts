/**
 * TraceInterceptor — リクエストごとに trace_id / request_id を発行して req に貫通させる
 * （10 §3.4.1 / B4）。
 *
 * - trace_id / request_id は **サーバ発行**。X-Correlation-Id は監査併記としてのみ保持し、
 *   trace_id の代わりにはしない（10 §3.3 注記 / クライアント指定不可）。
 * - controller / orchestrator は `getTraceContext(req)` でこのコンテキストを読み、
 *   レスポンス meta（+ 必要な data）に転記する。
 * - レスポンスヘッダにも X-Trace-Id / X-Request-Id を付け、HTTP レベルでも追跡可能にする。
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import type { Observable } from 'rxjs'
import {
  TRACE_CONTEXT_KEY,
  createTraceContext,
} from './trace-context'

const CORRELATION_HEADER = 'x-correlation-id'

@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const req = http.getRequest() as Record<string, unknown> & {
      headers?: Record<string, string | string[] | undefined>
    }
    const res = http.getResponse() as {
      setHeader: (name: string, value: string) => void
    }

    const correlationId = headerValue(req.headers, CORRELATION_HEADER)
    const ctx = createTraceContext(correlationId)
    req[TRACE_CONTEXT_KEY] = ctx

    res.setHeader('X-Trace-Id', ctx.trace_id)
    res.setHeader('X-Request-Id', ctx.request_id)

    return next.handle()
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const raw = headers?.[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}
