/**
 * IdempotencyKeyGuard — 全 POST API で Idempotency-Key ヘッダを必須化する（10 §3.3 / B1）。
 *
 * ヘッダ欠落・空文字は RAG_VALIDATION_ERROR(400)（10 §4: 「Idempotency-Key 欠落含む」）。
 * 検証通過したキーは req に載せ、`@IdempotencyKey()` param decorator で取り出す。
 *
 * payload_hash 比較による replay/409 判定は orchestrator 内（claim-first / 横断規約 §3）。
 * 本 guard は「キーが存在すること」だけを保証する入口ゲート。
 */
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  createParamDecorator,
} from '@nestjs/common'
import { RagApiException } from './rag-api.exception'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const IDEMPOTENCY_KEY_REQ = '__ragIdempotencyKey' as const

@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest() as Record<string, unknown> & {
      headers?: Record<string, string | string[] | undefined>
    }
    const raw = req.headers?.[IDEMPOTENCY_HEADER]
    const key = Array.isArray(raw) ? raw[0] : raw

    if (key === undefined || key.trim().length === 0) {
      throw RagApiException.validation('Idempotency-Key header is required for POST requests', [
        {
          field: 'Idempotency-Key',
          code: 'REQUIRED',
          message: 'Idempotency-Key header is required (ボット/呼出側採番)',
        },
      ])
    }

    req[IDEMPOTENCY_KEY_REQ] = key.trim()
    return true
  }
}

/** controller の引数で検証済み Idempotency-Key を受け取る param decorator。 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest() as Record<string, unknown>
    const key = req[IDEMPOTENCY_KEY_REQ]
    if (typeof key !== 'string') {
      // guard が先に走る前提。防御的に検証エラーへ倒す。
      throw RagApiException.validation('Idempotency-Key missing from request context')
    }
    return key
  },
)
