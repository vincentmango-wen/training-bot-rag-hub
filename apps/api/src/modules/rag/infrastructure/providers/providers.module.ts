/**
 * ProvidersModule — Provider 層の DI 配線（24 §17 MVP 実装範囲）。
 *
 * 公開（exports）:
 *   - ProviderRouter（RAG 本体が使う唯一の入口 / 選定・fallback・usage 記録）
 *   - LLM_PROVIDER / EMBEDDING_PROVIDER（必要なら直接注入も可能）
 *
 * 注入構成:
 *   - OPENAI_CLIENT: OPENAI_API_KEY があれば実 SDK Client、無ければ起動時に
 *     「未設定」を明示する throw client（テストは本 module を使わず mock 注入）。
 *   - LLM_PROVIDER / EMBEDDING_PROVIDER は配列で提供（Router が provider 名で解決）。
 *     MVP は OpenAI のみ。将来 provider 追加時はここに adapter を足すだけ。
 *   - PROVIDER_USAGE_RECORDER: 既定 Noop（永続化は別チケットで Prisma 実装に差替）。
 */
import { Module } from '@nestjs/common'
import {
  OPENAI_CLIENT,
  type OpenAIClientPort,
} from './openai/openai-client.port'
import { OpenAiSdkClient } from './openai/openai-client.openai-sdk'
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding/embedding-provider.interface'
import { OpenAIEmbeddingAdapter } from './embedding/openai-embedding.adapter'
import {
  LLM_PROVIDER,
  type LlmProvider,
} from './llm/llm-provider.interface'
import { OpenAILlmAdapter } from './llm/openai-llm.adapter'
import {
  NoopProviderUsageRecorder,
  PROVIDER_USAGE_RECORDER,
} from './usage/provider-usage-recorder.interface'
import { ProviderRouter } from './routing/provider-router'

/**
 * OPENAI_API_KEY 未設定でも DI 解決自体は成功させ、実呼び出し時にだけ失敗させる
 * lazy client（起動 = 設定検証の強制にしない / 健全性は health endpoint で見る）。
 */
function createOpenAiClient(): OpenAIClientPort {
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    const fail = (): never => {
      throw new Error(
        'OPENAI_API_KEY is not set. Configure it before calling OpenAI providers.',
      )
    }
    return {
      createChatCompletion: fail,
      createEmbeddings: fail,
    }
  }
  return new OpenAiSdkClient(apiKey)
}

@Module({
  providers: [
    {
      provide: OPENAI_CLIENT,
      useFactory: createOpenAiClient,
    },
    OpenAIEmbeddingAdapter,
    OpenAILlmAdapter,
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (openai: OpenAIEmbeddingAdapter): EmbeddingProvider[] => [
        openai,
      ],
      inject: [OpenAIEmbeddingAdapter],
    },
    {
      provide: LLM_PROVIDER,
      useFactory: (openai: OpenAILlmAdapter): LlmProvider[] => [openai],
      inject: [OpenAILlmAdapter],
    },
    {
      provide: PROVIDER_USAGE_RECORDER,
      useClass: NoopProviderUsageRecorder,
    },
    ProviderRouter,
  ],
  exports: [ProviderRouter, LLM_PROVIDER, EMBEDDING_PROVIDER],
})
export class ProvidersModule {}
