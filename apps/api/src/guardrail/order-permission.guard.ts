/**
 * Guard (a): order_permission 固定（横断規約5 / 10 §9.1 / 30 §6）。
 *
 * LLM が出力 JSON に `order_permission: true` を入れて返してきても、本 Guard が
 * **無条件で literal false に上書き**する。型レベルでも `false` literal に固定し、
 * true を返す分岐をコード上に存在させない（分岐の存在自体が将来の事故面になるため
 * 30 §6 が禁止）。
 *
 * - 一次防御は DB ロール物理遮断（RAG 用 DB ユーザに Order 系 GRANT を付与しない / インフラ側）。
 * - 本 Guard は二次防御。決定的（LLM 非依存）。
 */
import { Injectable } from '@nestjs/common'
import {
  ORDER_PERMISSION,
  ACTION_PERMISSION,
  ACTION_POLICY_ORDER_NOT_ALLOWED,
  type OrderPermission,
  type ActionPermission,
} from './guardrail.enums'
import type { GuardrailViolation } from './guardrail.types'

export type OrderPermissionEnforcement = {
  /** 常に false（literal）。 */
  order_permission: OrderPermission
  /** generic 語彙（30 §6）。常に false。 */
  action_permission: ActionPermission
  /** 30 §6: PTP 向け action_policy。 */
  action_policy: typeof ACTION_POLICY_ORDER_NOT_ALLOWED
  /** LLM が true 等を主張していて上書きした場合に立つ（監査用）。 */
  overridden: boolean
  violation?: GuardrailViolation
}

@Injectable()
export class OrderPermissionGuard {
  /**
   * LLM 出力に含まれる order_permission を読み、何が来ても false に固定する。
   * @param claimedOrderPermission LLM 出力が主張した order_permission（unknown 許容）
   */
  enforce(claimedOrderPermission?: unknown): OrderPermissionEnforcement {
    // LLM が false 以外（true / "true" / 1 / undefined 等）を主張したかを監査記録する。
    // 判定は厳密: literal false 以外はすべて「上書きした」とみなす。
    const overridden = claimedOrderPermission !== false

    const base: OrderPermissionEnforcement = {
      order_permission: ORDER_PERMISSION,
      action_permission: ACTION_PERMISSION,
      action_policy: ACTION_POLICY_ORDER_NOT_ALLOWED,
      overridden,
    }

    // LLM が「実行可能」を主張した場合（true 系）のみ violation を残す。
    // undefined（未申告）は通常運用なので violation にしない。
    if (this.claimsExecutable(claimedOrderPermission)) {
      return {
        ...base,
        violation: {
          type: 'order_permission',
          severity: 'CRITICAL',
          // BLOCK しない: 値は強制 false に上書き済みで安全（30 §6 二次防御）。
          // ただし CRITICAL violation として必ず監査ログに残す。
          blocking: false,
          message:
            'LLM output claimed an executable order permission; forcibly overridden to false (secondary defense).',
          field: 'order_permission',
        },
      }
    }

    return base
  }

  /** literal false / undefined / null 以外（true や "true" 等）を「実行主張」とみなす。 */
  private claimsExecutable(value: unknown): boolean {
    if (value === false || value === undefined || value === null) {
      return false
    }
    if (value === true) {
      return true
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      return normalized === 'true' || normalized === '1' || normalized === 'yes'
    }
    if (typeof value === 'number') {
      return value !== 0
    }
    // オブジェクト等の想定外型も「false ではない」ため実行主張扱い（fail-safe）。
    return true
  }
}
