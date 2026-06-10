import type { ExecutionContext } from '@nestjs/common'
import { z } from 'zod'
import { IdempotencyKeyGuard } from '../idempotency.guard'
import { ZodValidationPipe } from '../zod-validation.pipe'
import { RagApiException } from '../rag-api.exception'
import { resolveClientType, resolveRequesterId, MVP_DEV_REQUESTER_ID } from '../request-context'

function ctxWithHeaders(headers: Record<string, string>): {
  ctx: ExecutionContext
  req: Record<string, unknown>
} {
  const req: Record<string, unknown> = { headers }
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('IdempotencyKeyGuard', () => {
  const guard = new IdempotencyKeyGuard()

  it('Idempotency-Key があれば通し、req にキーを載せる', () => {
    const { ctx, req } = ctxWithHeaders({ 'idempotency-key': '  key-123 ' })
    expect(guard.canActivate(ctx)).toBe(true)
    expect(req['__ragIdempotencyKey']).toBe('key-123') // trim 済み
  })

  it('Idempotency-Key 欠落は RAG_VALIDATION_ERROR(400)', () => {
    const { ctx } = ctxWithHeaders({})
    expect(() => guard.canActivate(ctx)).toThrow(RagApiException)
    try {
      guard.canActivate(ctx)
    } catch (e) {
      expect((e as RagApiException).code).toBe('RAG_VALIDATION_ERROR')
      expect((e as RagApiException).httpStatus).toBe(400)
    }
  })

  it('空文字の Idempotency-Key も欠落として弾く', () => {
    const { ctx } = ctxWithHeaders({ 'idempotency-key': '   ' })
    expect(() => guard.canActivate(ctx)).toThrow(RagApiException)
  })
})

describe('ZodValidationPipe', () => {
  const schema = z.object({ query: z.string().min(1) })
  const pipe = new ZodValidationPipe(schema)

  it('妥当な値はパースして返す', () => {
    expect(pipe.transform({ query: 'hi' })).toEqual({ query: 'hi' })
  })

  it('不正な値は ZodError を投げる（filter が 400 に写像）', () => {
    expect(() => pipe.transform({ query: '' })).toThrow()
  })
})

describe('request-context resolvers', () => {
  it('X-Client-Type の正当値を返し、不正/未指定は system に倒す', () => {
    expect(resolveClientType({ headers: { 'x-client-type': 'ui' } })).toBe('ui')
    expect(resolveClientType({ headers: { 'x-client-type': 'training_bot' } })).toBe(
      'training_bot',
    )
    expect(resolveClientType({ headers: { 'x-client-type': 'evil' } })).toBe('system')
    expect(resolveClientType({ headers: {} })).toBe('system')
  })

  it('RequesterId は JWT subject が無ければ MVP dev requester に倒す', () => {
    expect(resolveRequesterId({})).toBe(MVP_DEV_REQUESTER_ID)
    expect(
      resolveRequesterId({ user: { requesterId: 'abc' } }),
    ).toBe('abc')
  })
})
