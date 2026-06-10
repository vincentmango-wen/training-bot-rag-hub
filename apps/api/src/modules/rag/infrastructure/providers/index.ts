/**
 * Provider 層の公開バレル（RAG 本体・他モジュールが import する入口）。
 *
 * 直接 import 推奨は ProviderRouter / 各 interface / 型。adapter 実体は DI 経由で
 * 解決するため通常は import 不要（24 PP-002 Lock-in 禁止 / interface 経由利用）。
 */
export * from './provider.types'

// interfaces + tokens
export * from './embedding/embedding-provider.interface'
export * from './embedding/embedding.types'
export * from './llm/llm-provider.interface'
export * from './llm/llm.types'
export * from './usage/provider-usage.types'
export * from './usage/provider-usage-recorder.interface'

// openai port（mock 注入のため公開）
export * from './openai/openai-client.port'

// routing
export { ProviderRouter } from './routing/provider-router'
export type {
  RouteContext,
  RetryOptions,
} from './routing/provider-router'
export {
  DEFAULT_RETRY_OPTIONS,
  PROVIDER_RETRY_OPTIONS,
} from './routing/provider-router'
export {
  CircuitBreaker,
  DEFAULT_CIRCUIT_OPTIONS,
} from './routing/circuit-breaker'
export type {
  CircuitState,
  CircuitBreakerOptions,
} from './routing/circuit-breaker'
export {
  MVP_PROVIDER_POLICY,
  getTaskPolicy,
} from './routing/provider-policy'
export type {
  ProviderChoice,
  TaskProviderPolicy,
} from './routing/provider-policy'

// adapters（テスト・明示配線用）
export { OpenAIEmbeddingAdapter } from './embedding/openai-embedding.adapter'
export { OpenAILlmAdapter } from './llm/openai-llm.adapter'
export { zodToOpenAiJsonSchema } from './llm/zod-to-openai-schema'
export type { JsonSchemaNode } from './llm/zod-to-openai-schema'
export { estimateCostUsd } from './openai/openai-pricing'

// module
export { ProvidersModule } from './providers.module'
