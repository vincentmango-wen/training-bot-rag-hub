/**
 * GuardrailModule — Guardrail 系 guard / service の DI 束ね。
 *
 * 他モジュール（rag query / bot-context / similar-cases）が GuardrailService を
 * inject して利用する。各 guard 単体も provider として export し、必要なら個別 inject 可。
 */
import { Module } from '@nestjs/common'
import { GuardrailService } from './guardrail.service'
import { OrderPermissionGuard } from './order-permission.guard'
import { CitationWhitelistGuard } from './citation-whitelist.guard'
import { SecretMaskingGuard } from './secret-masking.guard'
import { PromptInjectionGuard } from './prompt-injection.guard'

@Module({
  providers: [
    GuardrailService,
    OrderPermissionGuard,
    CitationWhitelistGuard,
    SecretMaskingGuard,
    PromptInjectionGuard,
  ],
  exports: [
    GuardrailService,
    OrderPermissionGuard,
    CitationWhitelistGuard,
    SecretMaskingGuard,
    PromptInjectionGuard,
  ],
})
export class GuardrailModule {}
