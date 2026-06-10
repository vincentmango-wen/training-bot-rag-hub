/**
 * Guardrail モジュール barrel export。
 * 消費側（rag query / bot-context / similar-cases controller・service）はここから import する。
 */
export { GuardrailModule } from './guardrail.module'
export { GuardrailService } from './guardrail.service'
export type {
  ValidateOutputInput,
  ValidateOutputResult,
} from './guardrail.service'

export { OrderPermissionGuard } from './order-permission.guard'
export type { OrderPermissionEnforcement } from './order-permission.guard'

export { CitationWhitelistGuard } from './citation-whitelist.guard'
export { SecretMaskingGuard } from './secret-masking.guard'
export {
  PromptInjectionGuard,
  RETRIEVED_DOC_DELIMITER_OPEN,
  RETRIEVED_DOC_DELIMITER_CLOSE,
} from './prompt-injection.guard'

export * from './guardrail.enums'
export type {
  GuardrailViolation,
  GuardrailResult,
  CitationCandidate,
  RetrievalResultRef,
  CitationFilterInput,
  CitationFilterOutput,
  RetrievedDocument,
  InjectionScanResult,
  SecretMaskResult,
} from './guardrail.types'
