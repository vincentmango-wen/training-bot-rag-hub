/**
 * OpenAIClientPort の実 SDK 実装（runtime 専用 / テストでは使わない）。
 *
 * - `openai` パッケージを **遅延 require** する。未インストール時は実行時に明示エラー。
 *   これにより openai 依存が無くても typecheck / build / test（mock 経由）が通る
 *   （課題要件: OpenAI 実呼び出しはテストで必ず mock / API キー前提にしない）。
 * - API キーは環境変数 OPENAI_API_KEY（13 Secret 送信禁止 / コードに焼かない）。
 * - structured output / embeddings の 2 操作のみを port 形に正規化する。
 *
 * 本ファイルは ProvidersModule の factory から「OPENAI_API_KEY が存在する時のみ」
 * 生成される。テスト・キー無し起動では Noop/モックに差し替わる。
 */
import type {
  OpenAIChatCompletionParams,
  OpenAIChatCompletionResult,
  OpenAIClientPort,
  OpenAIEmbeddingParams,
  OpenAIEmbeddingResult,
} from './openai-client.port'

/** openai SDK v5+ の RequestOptions（必要分のみ抽出）。`signal` 等は body と分離して第 2 引数で渡す。 */
interface OpenAiSdkRequestOptions {
  signal?: AbortSignal
}

/** openai SDK の必要最小サーフェスのみを構造的に型付け（パッケージ型に非依存）。 */
interface OpenAiSdkLike {
  chat: {
    completions: {
      create(
        args: Record<string, unknown>,
        options?: OpenAiSdkRequestOptions,
      ): Promise<{
        model: string
        choices: Array<{
          message: { content: string | null }
          finish_reason: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }>
    }
  }
  embeddings: {
    create(
      args: Record<string, unknown>,
      options?: OpenAiSdkRequestOptions,
    ): Promise<{
      model: string
      data: Array<{ embedding: number[] }>
      usage?: { prompt_tokens?: number }
    }>
  }
}

export class OpenAiSdkClient implements OpenAIClientPort {
  private readonly sdk: OpenAiSdkLike

  constructor(apiKey: string) {
    // 遅延 require: openai 未インストールでも本ファイルを import するモジュールは壊れない。
    let OpenAICtor: new (opts: { apiKey: string }) => OpenAiSdkLike
    try {
      const mod = require('openai') as
        | { default: new (opts: { apiKey: string }) => OpenAiSdkLike }
        | (new (opts: { apiKey: string }) => OpenAiSdkLike)
      OpenAICtor =
        typeof mod === 'function'
          ? mod
          : (mod.default as new (opts: { apiKey: string }) => OpenAiSdkLike)
    } catch (cause) {
      throw new Error(
        "OpenAiSdkClient: 'openai' package is not installed. Run `npm i openai` " +
          'in apps/api, or inject a mock OpenAIClientPort for tests.',
        { cause },
      )
    }
    this.sdk = new OpenAICtor({ apiKey })
  }

  async createChatCompletion(
    params: OpenAIChatCompletionParams,
  ): Promise<OpenAIChatCompletionResult> {
    // openai SDK v5+ では signal は body ではなく第 2 引数 RequestOptions に渡す
    // （v4 互換で body に混ぜると "400 Unrecognized request argument supplied: signal"）。
    const res = await this.sdk.chat.completions.create(
      {
        model: params.model,
        messages: params.messages,
        temperature: params.temperature,
        seed: params.seed,
        response_format: params.response_format,
        ...(params.max_tokens !== undefined
          ? { max_tokens: params.max_tokens }
          : {}),
      },
      params.signal !== undefined ? { signal: params.signal } : undefined,
    )
    const choice = res.choices[0]
    return {
      content: choice?.message.content ?? '',
      model: res.model,
      usage: {
        prompt_tokens: res.usage?.prompt_tokens ?? 0,
        completion_tokens: res.usage?.completion_tokens ?? 0,
      },
      ...(choice?.finish_reason != null
        ? { finish_reason: choice.finish_reason }
        : {}),
    }
  }

  async createEmbeddings(
    params: OpenAIEmbeddingParams,
  ): Promise<OpenAIEmbeddingResult> {
    // openai SDK v5+ では signal は body ではなく第 2 引数 RequestOptions に渡す。
    const res = await this.sdk.embeddings.create(
      {
        model: params.model,
        input: params.input,
      },
      params.signal !== undefined ? { signal: params.signal } : undefined,
    )
    return {
      embeddings: res.data.map((d) => d.embedding),
      model: res.model,
      usage: { prompt_tokens: res.usage?.prompt_tokens ?? 0 },
    }
  }
}
