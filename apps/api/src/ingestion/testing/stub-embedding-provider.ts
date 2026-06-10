import type {
  EmbeddingProvider,
  EmbedRequest,
  EmbeddingResult,
} from '../../modules/rag/infrastructure/providers/embedding/embedding-provider.interface'

/**
 * テスト / ローカル dev 用の決定的 EmbeddingProvider スタブ。
 *
 * - OpenAI 実呼び出しを一切しない（API キー不要 / 課題要件「テストで必ず mock」）。
 * - 同一テキスト → 同一ベクトルを返す（content_hash 差分・再利用テストの再現性確保）。
 * - 次元は OpenAI text-embedding-3-small と同じ 1536（HNSW index と整合）。
 *
 * 本番では providers の OpenAIEmbeddingAdapter を EMBEDDING_PROVIDER に束縛する。
 * 本スタブは ingestion の単体・結合テストと、API キー未設定時の dev フォールバック用。
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const
  readonly model = 'text-embedding-3-small'
  readonly dimensions = 1536

  /** embed 呼び出し回数（再 Embedding スキップ検証用）。 */
  public embedCallCount = 0
  /** 直近 embed に渡されたテキスト数の履歴。 */
  public readonly embeddedBatchSizes: number[] = []

  async embed(request: EmbedRequest): Promise<EmbeddingResult> {
    this.embedCallCount += 1
    this.embeddedBatchSizes.push(request.texts.length)
    const embeddings = request.texts.map((t) => this.deterministicVector(t))
    return Promise.resolve({
      embeddings,
      dimensions: this.dimensions,
      meta: {
        provider: 'openai',
        model: this.model,
        fallback_used: false,
        input_tokens: request.texts.reduce((sum, t) => sum + t.length, 0),
        output_tokens: 0,
        latency_ms: 0,
      },
    })
  }

  /** テキストから決定的に擬似ベクトルを作る（seed = 文字コード和）。 */
  private deterministicVector(text: string): number[] {
    let seed = 0
    for (let i = 0; i < text.length; i += 1) {
      seed = (seed * 31 + text.charCodeAt(i)) >>> 0
    }
    const vec = new Array<number>(this.dimensions)
    let state = seed || 1
    for (let i = 0; i < this.dimensions; i += 1) {
      // xorshift で 0..1 の擬似乱数を生成（決定的）。
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      vec[i] = (state / 0xffffffff) * 2 - 1
    }
    return vec
  }
}
