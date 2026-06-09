export const RAG_HUB_SERVICE_NAME = 'training-bot-rag-hub' as const

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type GuardrailStatus = 'PASS' | 'WARNING' | 'BLOCKED'

export type RagGuardrail = {
  orderPermission: false
  status: GuardrailStatus
  reason?: string
}