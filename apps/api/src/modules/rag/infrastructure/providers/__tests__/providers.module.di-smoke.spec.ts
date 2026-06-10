import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { ProvidersModule } from '../providers.module'
import { ProviderRouter } from '../routing/provider-router'
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../embedding/embedding-provider.interface'
import {
  LLM_PROVIDER,
  type LlmProvider,
} from '../llm/llm-provider.interface'

describe('ProvidersModule (DI smoke)', () => {
  it('resolves ProviderRouter with openai LLM + embedding providers wired', async () => {
    const mod = await Test.createTestingModule({
      imports: [ProvidersModule],
    }).compile()

    const router = mod.get(ProviderRouter)
    const llms = mod.get<LlmProvider[]>(LLM_PROVIDER)
    const embs = mod.get<EmbeddingProvider[]>(EMBEDDING_PROVIDER)

    expect(router).toBeInstanceOf(ProviderRouter)
    expect(llms.map((p) => p.provider)).toEqual(['openai'])
    expect(embs.map((p) => p.provider)).toEqual(['openai'])
    expect(router.health('openai')).toBe('HEALTHY')

    await mod.close()
  })
})
