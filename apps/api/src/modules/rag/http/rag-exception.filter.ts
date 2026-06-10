/**
 * RagExceptionFilter — 全例外を 10 §3.4 Error 共通形へ写像する。
 *
 * 写像対象:
 *   - RagApiException → 自身の code/httpStatus/details（正規ルート）
 *   - ZodError（ZodValidationPipe 経由）→ RAG_VALIDATION_ERROR(400) + [{field,code,message}]
 *   - IdempotencyConflictError（ingestion / claim）→ RAG_IDEMPOTENCY_CONFLICT(409)
 *   - ProviderError（providers 層）→ kind で 502/504 に振り分け
 *   - その他（想定外）→ RAG_INTERNAL_ERROR(500)
 *
 * いずれの場合も `meta.trace_id` / `meta.request_id` を必ず返す（10 §3.4 注記 / 障害調査の突合キー）。
 * 429 系は Retry-After ヘッダを必須付与する（10 §4.1）。
 */
import {
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import { ZodError } from 'zod'
import type { ErrorCode, ErrorDetail, ErrorResponse } from '@pmtp/shared'
import { ProviderError } from '../infrastructure/providers/provider.types'
import { IdempotencyConflictError } from '../../../ingestion/idempotency-conflict.error'
import { getTraceContext } from './trace-context'
import {
  ERROR_CODE_HTTP_STATUS,
  RagApiException,
} from './rag-api.exception'

interface NormalizedError {
  code: ErrorCode
  httpStatus: number
  message: string
  details?: ErrorDetail[]
  retryAfterSeconds?: number
}

@Catch()
export class RagExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RagExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const req = http.getRequest()
    const res = http.getResponse()
    const ctx = getTraceContext(req)

    const normalized = this.normalize(exception)

    // 5xx は調査のため stack を含めてログ（4xx は運用ノイズになるため warn 1 行）。
    if (normalized.httpStatus >= 500) {
      this.logger.error(
        `[${ctx.trace_id}] ${normalized.code}: ${normalized.message}`,
        exception instanceof Error ? exception.stack : undefined,
      )
    } else {
      this.logger.warn(`[${ctx.trace_id}] ${normalized.code}: ${normalized.message}`)
    }

    const body: ErrorResponse = {
      success: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined
          ? { details: normalized.details }
          : {}),
      },
      meta: {
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
        timestamp: new Date().toISOString(),
      },
    }

    if (normalized.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(normalized.retryAfterSeconds))
    }

    res.status(normalized.httpStatus).json(body)
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof RagApiException) {
      return {
        code: exception.code,
        httpStatus: exception.httpStatus,
        message: exception.message,
        ...(exception.details !== undefined
          ? { details: exception.details }
          : {}),
        ...(exception.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: exception.retryAfterSeconds }
          : {}),
      }
    }

    if (exception instanceof ZodError || isZodErrorShaped(exception)) {
      return {
        code: 'RAG_VALIDATION_ERROR',
        httpStatus: ERROR_CODE_HTTP_STATUS.RAG_VALIDATION_ERROR,
        message: 'Invalid request payload',
        details: zodIssuesToDetails(exception as ZodError),
      }
    }

    if (exception instanceof IdempotencyConflictError) {
      return {
        code: 'RAG_IDEMPOTENCY_CONFLICT',
        httpStatus: ERROR_CODE_HTTP_STATUS.RAG_IDEMPOTENCY_CONFLICT,
        message: exception.message,
        details: [
          {
            field: 'Idempotency-Key',
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: exception.message,
          },
        ],
      }
    }

    if (exception instanceof ProviderError) {
      const code: ErrorCode =
        exception.kind === 'timeout'
          ? 'RAG_PROVIDER_TIMEOUT'
          : 'RAG_PROVIDER_ERROR'
      return {
        code,
        httpStatus: ERROR_CODE_HTTP_STATUS[code],
        message: `LLM provider failure (${exception.kind})`,
      }
    }

    return {
      code: 'RAG_INTERNAL_ERROR',
      httpStatus: ERROR_CODE_HTTP_STATUS.RAG_INTERNAL_ERROR,
      message: 'Internal server error',
    }
  }
}

/** ZodError の issue を 10 §3.4 の details[{field,code,message}] へ写像する。 */
export function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    code: mapZodIssueCode(issue.code),
    message: issue.message,
  }))
}

function mapZodIssueCode(code: string): ErrorDetail['code'] {
  switch (code) {
    case 'invalid_enum_value':
      return 'INVALID_ENUM'
    case 'invalid_type':
      return 'TYPE_MISMATCH'
    case 'too_small':
    case 'too_big':
      return 'OUT_OF_RANGE'
    default:
      // required / その他は REQUIRED に丸める（invalid_type+undefined も含む実務上の落とし所）。
      return 'REQUIRED'
  }
}

/**
 * ZodError の duck-type 判定。
 *
 * `instanceof ZodError` は packages/shared 内の nested zod インスタンスと apps/api の
 * zod インスタンスが物理的に異なる場合（モノレポ / e2e テスト環境）に false を返す。
 * name + issues 配列でシェイプ判定することで複数 zod インスタンス混在環境にも対応する。
 */
function isZodErrorShaped(exception: unknown): boolean {
  return (
    exception !== null &&
    typeof exception === 'object' &&
    (exception as Record<string, unknown>)['name'] === 'ZodError' &&
    Array.isArray((exception as Record<string, unknown>)['issues'])
  )
}
