/**
 * テスト用の OpenAIClientPort 実装（mock 差し替え / API キー・ネットワーク不要）。
 * 各 create* の挙動を関数で差し込めるよう構成する。
 */
import type {
  OpenAIChatCompletionParams,
  OpenAIChatCompletionResult,
  OpenAIClientPort,
  OpenAIEmbeddingParams,
  OpenAIEmbeddingResult,
} from '../openai/openai-client.port'

export class FakeOpenAIClient implements OpenAIClientPort {
  chatImpl: (
    p: OpenAIChatCompletionParams,
  ) => Promise<OpenAIChatCompletionResult>
  embedImpl: (p: OpenAIEmbeddingParams) => Promise<OpenAIEmbeddingResult>

  /** 受け取った最後のパラメータ（呼び出し検証用）。 */
  lastChatParams?: OpenAIChatCompletionParams
  lastEmbedParams?: OpenAIEmbeddingParams
  chatCalls = 0
  embedCalls = 0

  constructor(opts?: {
    chat?: (
      p: OpenAIChatCompletionParams,
    ) => Promise<OpenAIChatCompletionResult>
    embed?: (p: OpenAIEmbeddingParams) => Promise<OpenAIEmbeddingResult>
  }) {
    this.chatImpl =
      opts?.chat ??
      (async () => ({
        content: '{}',
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }))
    this.embedImpl =
      opts?.embed ??
      (async (p) => ({
        embeddings: p.input.map(() => new Array(1536).fill(0)),
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 0 },
      }))
  }

  async createChatCompletion(
    p: OpenAIChatCompletionParams,
  ): Promise<OpenAIChatCompletionResult> {
    this.chatCalls += 1
    this.lastChatParams = p
    return this.chatImpl(p)
  }

  async createEmbeddings(
    p: OpenAIEmbeddingParams,
  ): Promise<OpenAIEmbeddingResult> {
    this.embedCalls += 1
    this.lastEmbedParams = p
    return this.embedImpl(p)
  }
}

/** 指定次元の 0 ベクトルを n 本作る。 */
export function zeroVectors(count: number, dims = 1536): number[][] {
  return Array.from({ length: count }, () => new Array(dims).fill(0))
}
