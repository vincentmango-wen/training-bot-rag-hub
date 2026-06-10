/**
 * リクエスト由来のメタを controller 引数で受け取る param decorator 群。
 *
 * - `@TraceCtx()` … TraceInterceptor が発行した TraceContext（trace_id / request_id）。
 * - `@ClientType()` … X-Client-Type ヘッダ（citation audience 出し分け / 10 §6.1）。
 *   未指定・不正値は 'system' に倒す（excerpt を返さない安全側 / training_bot と同等の最小開示）。
 * - `@RequesterId()` … 冪等性スコープ + 履歴所有権の主体（rag_queries.requester_id）。
 *   MVP は JWT mock（10 §3.2）。本番は JWT subject claim に差し替える（本 decorator 1 箇所変更で済む）。
 *
 * audience 別出し分けは「ui / admin 系のみ excerpt 含むフル形、それ以外は excerpt 省略」。
 */
import {
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'
import { CLIENT_TYPES, type ClientType as ClientTypeValue } from '@pmtp/shared'
import {
  getTraceContext,
  type TraceContext,
} from './trace-context'

export const TraceCtx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TraceContext => {
    return getTraceContext(context.switchToHttp().getRequest())
  },
)

/** excerpt を含むフル citation を返してよい audience（10 §6.1）。 */
export const FULL_CITATION_AUDIENCES: readonly ClientTypeValue[] = ['ui'] as const

export const ClientType = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ClientTypeValue => {
    return resolveClientType(context.switchToHttp().getRequest())
  },
)

export function resolveClientType(req: unknown): ClientTypeValue {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> })
    ?.headers
  const raw = headers?.['x-client-type']
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (value !== undefined && (CLIENT_TYPES as readonly string[]).includes(value)) {
    return value as ClientTypeValue
  }
  // 未指定・不正は最小開示側（system = excerpt 省略）に倒す。
  return 'system'
}

/**
 * RequesterId — 冪等性スコープ + 履歴所有権の主体。
 *
 * MVP は Authorization の JWT を mock 運用（10 §3.2）。subject claim が無い場合は
 * X-Client-Type と body の bot_id 等で代替せず、固定の dev requester に倒す。
 * 本番では本関数を JWT subject 検証へ差し替える（IDOR 防御 / 10 §10.1.1）。
 */
export const RequesterId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    return resolveRequesterId(context.switchToHttp().getRequest())
  },
)

/** MVP mock: 開発用の固定 requester（UUID 形式 / rag_queries.requester_id は uuid）。 */
export const MVP_DEV_REQUESTER_ID = '00000000-0000-4000-8000-000000000001'

export function resolveRequesterId(req: unknown): string {
  // 本番差し替え点: JWT subject claim を検証して bot_id / user_id を解決する。
  const holder = req as { user?: { requesterId?: unknown } } | null
  const fromAuth = holder?.user?.requesterId
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth
  }
  return MVP_DEV_REQUESTER_ID
}
