import { z, type ZodError } from 'zod'
import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common'
import { RagExceptionFilter, zodIssuesToDetails } from '../rag-exception.filter'
import { RagApiException } from '../rag-api.exception'
import { ProviderError } from '../../infrastructure/providers/provider.types'
import { IdempotencyConflictError } from '../../../../ingestion/idempotency-conflict.error'
import { TRACE_CONTEXT_KEY } from '../trace-context'

interface FakeRes {
  status: jest.Mock
  json: jest.Mock
  setHeader: jest.Mock
  _status: number | undefined
  _body: unknown
}

/** ArgumentsHost を最小モックする。 */
function makeHost(): {
  host: ArgumentsHost
  res: FakeRes
} {
  const res: FakeRes = {
    _status: undefined,
    _body: undefined,
    status: jest.fn((code: number) => {
      res._status = code
      return res
    }),
    json: jest.fn((body: unknown) => {
      res._body = body
      return res
    }),
    setHeader: jest.fn(),
  }
  const req = { [TRACE_CONTEXT_KEY]: { trace_id: 't-1', request_id: 'r-1' } }
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost
  return { host, res }
}

describe('RagExceptionFilter', () => {
  const filter = new RagExceptionFilter()

  it('RagApiException を code/httpStatus/details で写像し、meta に trace/request を必ず入れる', () => {
    const { host, res } = makeHost()
    filter.catch(
      RagApiException.guardrailBlocked('blocked', ['no citation']),
      host,
    )
    expect(res._status).toBe(422)
    const body = res._body as {
      success: boolean
      error: { code: string; details: unknown[] }
      meta: { trace_id: string; request_id: string; timestamp: string }
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_GUARDRAIL_BLOCKED')
    expect(body.error.details).toHaveLength(1)
    expect(body.meta.trace_id).toBe('t-1')
    expect(body.meta.request_id).toBe('r-1')
    expect(typeof body.meta.timestamp).toBe('string')
  })

  it('ZodError は 400 RAG_VALIDATION_ERROR + details[{field,code,message}]', () => {
    const { host, res } = makeHost()
    const schema = z.object({ timeframe: z.enum(['1m', '1h']) })
    let zodErr: ZodError | undefined
    try {
      schema.parse({ timeframe: 'bad' })
    } catch (e) {
      zodErr = e as ZodError
    }
    filter.catch(zodErr, host)
    expect(res._status).toBe(400)
    const body = res._body as { error: { code: string; details: Array<{ field: string; code: string }> } }
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
    expect(body.error.details[0]?.field).toBe('timeframe')
    expect(body.error.details[0]?.code).toBe('INVALID_ENUM')
  })

  it('IdempotencyConflictError は 409 RAG_IDEMPOTENCY_CONFLICT', () => {
    const { host, res } = makeHost()
    filter.catch(
      new IdempotencyConflictError({ sourceId: 's', idempotencyKey: 'k' }),
      host,
    )
    expect(res._status).toBe(409)
    const body = res._body as { error: { code: string } }
    expect(body.error.code).toBe('RAG_IDEMPOTENCY_CONFLICT')
  })

  it('ProviderError(timeout) は 504、その他 kind は 502', () => {
    const t = makeHost()
    filter.catch(
      new ProviderError({ kind: 'timeout', provider: 'openai', message: 'x' }),
      t.host,
    )
    expect(t.res._status).toBe(504)

    const a = makeHost()
    filter.catch(
      new ProviderError({ kind: 'api_error', provider: 'openai', message: 'x' }),
      a.host,
    )
    expect(a.res._status).toBe(502)
  })

  // NestJS HttpException 分岐（Guard / Pipe / 内部 throw を 500 に潰さない / B-3 fix）
  it('UnauthorizedException は 401 RAG_UNAUTHORIZED に写像（500 に潰さない）', () => {
    const { host, res } = makeHost()
    filter.catch(new UnauthorizedException('Invalid or missing bearer token'), host)
    expect(res._status).toBe(401)
    const body = res._body as {
      success: boolean
      error: { code: string; message: string }
      meta: { trace_id: string }
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_UNAUTHORIZED')
    expect(body.error.message).toContain('bearer')
    expect(body.meta.trace_id).toBe('t-1')
  })

  it('ServiceUnavailableException は 503 を保持（status を 500 に潰さない）', () => {
    const { host, res } = makeHost()
    filter.catch(
      new ServiceUnavailableException('API authentication is not configured'),
      host,
    )
    expect(res._status).toBe(503)
    const body = res._body as {
      success: boolean
      error: { code: string; message: string }
    }
    // 503 は ERROR_CODES に専用コードが無いため RAG_INTERNAL_ERROR に寄せる仕様
    // （httpStatus 503 を保つことが smoke-test T6 の判定で重要）
    expect(body.error.code).toBe('RAG_INTERNAL_ERROR')
    expect(body.error.message).toContain('not configured')
  })

  it('想定外例外は 500 RAG_INTERNAL_ERROR', () => {
    const { host, res } = makeHost()
    filter.catch(new Error('boom'), host)
    expect(res._status).toBe(500)
    const body = res._body as { error: { code: string } }
    expect(body.error.code).toBe('RAG_INTERNAL_ERROR')
  })

  it('429 系は Retry-After ヘッダを付与する', () => {
    const { host, res } = makeHost()
    filter.catch(
      new RagApiException('RAG_RATE_LIMITED', 'slow down', { retryAfterSeconds: 30 }),
      host,
    )
    expect(res._status).toBe(429)
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30')
  })

  it('zodIssuesToDetails は too_small を OUT_OF_RANGE に写像', () => {
    const schema = z.object({ q: z.string().min(1) })
    let err: ZodError | undefined
    try {
      schema.parse({ q: '' })
    } catch (e) {
      err = e as ZodError
    }
    const details = zodIssuesToDetails(err as ZodError)
    expect(details[0]?.code).toBe('OUT_OF_RANGE')
  })
})
