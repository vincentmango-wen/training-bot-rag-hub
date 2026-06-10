export const RAG_HUB_SERVICE_NAME = 'training-bot-rag-hub' as const

/**
 * RAG enum SSoT。RiskLevel / GuardrailStatus 等は rag-enums.ts に一本化した。
 * （旧 index.ts の手書き union 型はこちらに統合 / enum SSoT 規約）
 */
export * from './rag-enums'

/** 共通プリミティブ（金融数値 string / meta / error model / citation / guardrail）。 */
export * from './common'

/** MVP 4 エンドポイントの I/O Zod schema（query / bot-context / similar-cases / history）。 */
export * from './api'

import type { GuardrailStatus, OrderPermission } from './rag-enums'

/**
 * Bot へ返すガードレール結果の最小形。
 * order_permission は常に literal false（横断規約 §5 / 二次防御）。
 */
export type RagGuardrail = {
  orderPermission: OrderPermission
  status: GuardrailStatus
  reason?: string
}
