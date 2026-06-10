import { OrderPermissionGuard } from '../order-permission.guard'

describe('OrderPermissionGuard (Guard a)', () => {
  const guard = new OrderPermissionGuard()

  it('always returns order_permission literal false even when LLM claims true', () => {
    const result = guard.enforce(true)
    expect(result.order_permission).toBe(false)
    expect(result.action_permission).toBe(false)
    expect(result.action_policy).toBe('ORDER_NOT_ALLOWED_BY_RAG')
  })

  it('marks overridden + CRITICAL violation when LLM claims true', () => {
    const result = guard.enforce(true)
    expect(result.overridden).toBe(true)
    expect(result.violation).toBeDefined()
    expect(result.violation?.type).toBe('order_permission')
    expect(result.violation?.severity).toBe('CRITICAL')
    // 値は安全に上書き済みなので BLOCK ではない（二次防御）。
    expect(result.violation?.blocking).toBe(false)
  })

  it('treats string "true" / "1" / "yes" as executable claim', () => {
    for (const v of ['true', 'TRUE', ' 1 ', 'yes']) {
      const r = guard.enforce(v)
      expect(r.order_permission).toBe(false)
      expect(r.violation).toBeDefined()
    }
  })

  it('treats non-zero number as executable claim', () => {
    const r = guard.enforce(1)
    expect(r.order_permission).toBe(false)
    expect(r.violation).toBeDefined()
  })

  it('treats arbitrary object as executable claim (fail-safe)', () => {
    const r = guard.enforce({ order_permission: true })
    expect(r.order_permission).toBe(false)
    expect(r.violation).toBeDefined()
  })

  it('does not flag a violation when LLM correctly reports false', () => {
    const r = guard.enforce(false)
    expect(r.order_permission).toBe(false)
    expect(r.overridden).toBe(false)
    expect(r.violation).toBeUndefined()
  })

  it('does not flag a violation when order_permission is omitted (undefined)', () => {
    const r = guard.enforce(undefined)
    expect(r.order_permission).toBe(false)
    // undefined は false と異なるので overridden=true だが executable 主張ではない。
    expect(r.overridden).toBe(true)
    expect(r.violation).toBeUndefined()
  })
})
