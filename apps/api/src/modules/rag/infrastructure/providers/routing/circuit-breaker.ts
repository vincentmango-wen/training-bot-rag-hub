/**
 * Provider 単位の circuit breaker（24 §9 Health Check / §10 Fallback）。
 *
 * 3 状態（CLOSED / OPEN / HALF_OPEN）の素朴な実装:
 *   - CLOSED: 通常。連続失敗が閾値に達したら OPEN へ。
 *   - OPEN: 一定時間（cooldown）呼び出しを即拒否（fast-fail → Router は fallback）。
 *   - HALF_OPEN: cooldown 経過後 1 回だけ試行を許可。成功で CLOSED、失敗で再 OPEN。
 *
 * health() は 24 §9 の Provider 状態（HEALTHY/DEGRADED/UNAVAILABLE）へ写像する:
 *   - OPEN              → UNAVAILABLE
 *   - 連続失敗あり(>0)   → DEGRADED
 *   - それ以外          → HEALTHY
 *
 * 時刻は注入可能（now()）でテスト時に固定する。
 */
import type { ProviderHealth } from '../provider.types'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerOptions {
  /** 連続失敗が何回で OPEN にするか。 */
  failureThreshold: number
  /** OPEN を維持する時間（ms）。経過後に HALF_OPEN を許可。 */
  cooldownMs: number
  /** 時刻ソース（テスト用に注入可能 / 既定 Date.now）。 */
  now?: () => number
}

export const DEFAULT_CIRCUIT_OPTIONS: Omit<CircuitBreakerOptions, 'now'> = {
  failureThreshold: 5,
  cooldownMs: 30_000,
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private consecutiveFailures = 0
  private openedAt = 0
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? (() => Date.now())
  }

  /** 呼び出しを許可するか。OPEN かつ cooldown 未経過なら false（fast-fail）。 */
  canAttempt(): boolean {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'HALF_OPEN'
        return true
      }
      return false
    }
    return true
  }

  onSuccess(): void {
    this.consecutiveFailures = 0
    this.state = 'CLOSED'
  }

  onFailure(): void {
    this.consecutiveFailures += 1
    if (
      this.state === 'HALF_OPEN' ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = 'OPEN'
      this.openedAt = this.now()
    }
  }

  getState(): CircuitState {
    // OPEN の cooldown 経過を反映（読み取り時点の状態を正確にする）
    if (
      this.state === 'OPEN' &&
      this.now() - this.openedAt >= this.cooldownMs
    ) {
      return 'HALF_OPEN'
    }
    return this.state
  }

  health(): ProviderHealth {
    const state = this.getState()
    if (state === 'OPEN') return 'UNAVAILABLE'
    if (this.consecutiveFailures > 0) return 'DEGRADED'
    return 'HEALTHY'
  }
}
