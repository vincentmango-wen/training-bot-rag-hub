/**
 * RAG API のドメイン例外（10 §4 エラーコード定義 / §3.4 Error）。
 *
 * controller / orchestrator はこの例外を throw し、RagExceptionFilter が
 * `{ success:false, error:{code,message,details}, meta }` の共通 Error 形へ写像する。
 *
 * code → HTTP の対応は ERROR_CODE_HTTP_STATUS（10 §4 の表）で 1 箇所に固定する。
 */
import type { ErrorCode, ErrorDetail } from '@pmtp/shared'

/** 10 §4: エラーコード → HTTP status の正本マップ。 */
export const ERROR_CODE_HTTP_STATUS: Record<ErrorCode, number> = {
  RAG_VALIDATION_ERROR: 400,
  RAG_UNAUTHORIZED: 401,
  RAG_FORBIDDEN: 403,
  RAG_NOT_FOUND: 404,
  RAG_IDEMPOTENCY_CONFLICT: 409,
  RAG_GUARDRAIL_BLOCKED: 422,
  RAG_RATE_LIMITED: 429,
  RAG_COST_LIMIT_EXCEEDED: 429,
  RAG_INTERNAL_ERROR: 500,
  RAG_PROVIDER_ERROR: 502,
  RAG_PROVIDER_TIMEOUT: 504,
}

export interface RagApiExceptionOptions {
  details?: ErrorDetail[]
  /** 429 系で必須（10 §4.1 / Retry-After ヘッダに転記される秒数）。 */
  retryAfterSeconds?: number
  cause?: unknown
}

/**
 * RAG API 共通例外。filter が共通 Error 形へ写像する。
 * HTTP status は code から ERROR_CODE_HTTP_STATUS で決まる（個別指定不可 = 一貫性担保）。
 */
export class RagApiException extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly details?: ErrorDetail[]
  readonly retryAfterSeconds?: number

  constructor(
    code: ErrorCode,
    message: string,
    options: RagApiExceptionOptions = {},
  ) {
    super(message)
    this.name = 'RagApiException'
    this.code = code
    this.httpStatus = ERROR_CODE_HTTP_STATUS[code]
    if (options.details !== undefined) this.details = options.details
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds
    }
    if (options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }

  /* ---- 代表的な生成ヘルパ（呼び出し側の記述を短く保つ） ---- */

  static validation(message: string, details?: ErrorDetail[]): RagApiException {
    return new RagApiException('RAG_VALIDATION_ERROR', message, {
      ...(details !== undefined ? { details } : {}),
    })
  }

  static idempotencyConflict(message: string): RagApiException {
    return new RagApiException('RAG_IDEMPOTENCY_CONFLICT', message, {
      details: [
        {
          field: 'Idempotency-Key',
          code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
          message,
        },
      ],
    })
  }

  static guardrailBlocked(
    message: string,
    blockedReasons: string[],
  ): RagApiException {
    return new RagApiException('RAG_GUARDRAIL_BLOCKED', message, {
      details: blockedReasons.map((reason) => ({
        field: 'guardrail',
        code: 'OUT_OF_RANGE',
        message: reason,
      })),
    })
  }

  static notFound(message: string): RagApiException {
    return new RagApiException('RAG_NOT_FOUND', message)
  }

  static internal(message: string, cause?: unknown): RagApiException {
    return new RagApiException('RAG_INTERNAL_ERROR', message, { cause })
  }

  static providerError(message: string, cause?: unknown): RagApiException {
    return new RagApiException('RAG_PROVIDER_ERROR', message, { cause })
  }

  static providerTimeout(message: string, cause?: unknown): RagApiException {
    return new RagApiException('RAG_PROVIDER_TIMEOUT', message, { cause })
  }
}
