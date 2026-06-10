import { CircuitBreaker } from '../routing/circuit-breaker'

describe('CircuitBreaker', () => {
  function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
    let t = start
    return { now: () => t, advance: (ms) => (t += ms) }
  }

  it('starts CLOSED and HEALTHY', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 })
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.health()).toBe('HEALTHY')
    expect(cb.canAttempt()).toBe(true)
  })

  it('opens after consecutive failures reach threshold', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      now: clock.now,
    })
    cb.onFailure()
    expect(cb.health()).toBe('DEGRADED')
    cb.onFailure()
    cb.onFailure()
    expect(cb.getState()).toBe('OPEN')
    expect(cb.health()).toBe('UNAVAILABLE')
    expect(cb.canAttempt()).toBe(false)
  })

  it('transitions OPEN -> HALF_OPEN after cooldown and allows one attempt', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    })
    cb.onFailure()
    expect(cb.canAttempt()).toBe(false)
    clock.advance(1000)
    expect(cb.canAttempt()).toBe(true)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('HALF_OPEN success closes the circuit', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    })
    cb.onFailure()
    clock.advance(1000)
    cb.canAttempt() // -> HALF_OPEN
    cb.onSuccess()
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.health()).toBe('HEALTHY')
  })

  it('HALF_OPEN failure re-opens the circuit', () => {
    const clock = makeClock()
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    })
    cb.onFailure()
    clock.advance(1000)
    cb.canAttempt() // -> HALF_OPEN
    cb.onFailure()
    expect(cb.getState()).toBe('OPEN')
  })

  it('success resets consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 })
    cb.onFailure()
    cb.onFailure()
    cb.onSuccess()
    expect(cb.health()).toBe('HEALTHY')
    cb.onFailure()
    cb.onFailure()
    expect(cb.getState()).toBe('CLOSED') // 2 < threshold 3
  })
})
