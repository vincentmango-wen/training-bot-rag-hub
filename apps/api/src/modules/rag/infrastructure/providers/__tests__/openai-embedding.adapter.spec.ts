import { OpenAIEmbeddingAdapter } from '../embedding/openai-embedding.adapter'
import { ProviderError } from '../provider.types'
import { FakeOpenAIClient, zeroVectors } from './fake-openai-client'

describe('OpenAIEmbeddingAdapter', () => {
  it('embeds texts and returns 1536-dim vectors with usage meta', async () => {
    const client = new FakeOpenAIClient({
      embed: async (p) => ({
        embeddings: zeroVectors(p.input.length),
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 12 },
      }),
    })
    const adapter = new OpenAIEmbeddingAdapter(client)

    const res = await adapter.embed({ texts: ['a', 'b'] })

    expect(res.embeddings).toHaveLength(2)
    expect(res.dimensions).toBe(1536)
    expect(res.meta.provider).toBe('openai')
    expect(res.meta.model).toBe('text-embedding-3-small')
    expect(res.meta.input_tokens).toBe(12)
    expect(res.meta.output_tokens).toBe(0)
    expect(res.meta.fallback_used).toBe(false)
    // estimated_cost は string（Decimal Safe）
    expect(typeof res.meta.estimated_cost).toBe('string')
  })

  it('rejects empty texts with non-retryable ProviderError', async () => {
    const adapter = new OpenAIEmbeddingAdapter(new FakeOpenAIClient())
    await expect(adapter.embed({ texts: [] })).rejects.toMatchObject({
      kind: 'api_error',
      retryable: false,
    })
  })

  it('throws schema_invalid when dimension mismatches (HNSW guard)', async () => {
    const client = new FakeOpenAIClient({
      embed: async () => ({
        embeddings: [new Array(768).fill(0)],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 1 },
      }),
    })
    const adapter = new OpenAIEmbeddingAdapter(client)
    await expect(adapter.embed({ texts: ['x'] })).rejects.toMatchObject({
      kind: 'schema_invalid',
    })
  })

  it('throws schema_invalid when vector count mismatches', async () => {
    const client = new FakeOpenAIClient({
      embed: async () => ({
        embeddings: zeroVectors(1),
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 1 },
      }),
    })
    const adapter = new OpenAIEmbeddingAdapter(client)
    await expect(
      adapter.embed({ texts: ['x', 'y'] }),
    ).rejects.toMatchObject({ kind: 'schema_invalid' })
  })

  it('maps a thrown 429 to retryable rate_limit ProviderError', async () => {
    const client = new FakeOpenAIClient({
      embed: async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 })
      },
    })
    const adapter = new OpenAIEmbeddingAdapter(client)
    await expect(adapter.embed({ texts: ['x'] })).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    })
  })

  it('maps an abort (timeout) to retryable timeout ProviderError', async () => {
    const client = new FakeOpenAIClient({
      embed: async (p) => {
        // signal が abort 済みになるまで待ち、abort されたら throw
        await new Promise((r) => setTimeout(r, 5))
        if (p.signal?.aborted) {
          throw new Error('aborted')
        }
        return {
          embeddings: zeroVectors(p.input.length),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 0 },
        }
      },
    })
    const adapter = new OpenAIEmbeddingAdapter(client)
    await expect(
      adapter.embed({ texts: ['x'], timeoutMs: 1 }),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('passes provider error instances through unchanged', async () => {
    const original = new ProviderError({
      kind: 'safety_block',
      provider: 'openai',
      message: 'blocked',
    })
    const client = new FakeOpenAIClient({
      embed: async () => {
        throw original
      },
    })
    const adapter = new OpenAIEmbeddingAdapter(client)
    await expect(adapter.embed({ texts: ['x'] })).rejects.toBe(original)
  })
})
