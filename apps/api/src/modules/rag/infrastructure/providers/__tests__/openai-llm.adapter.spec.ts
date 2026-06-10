import { z } from 'zod'
import { OpenAILlmAdapter } from '../llm/openai-llm.adapter'
import { LLM_FIXED_SEED, LLM_FIXED_TEMPERATURE } from '../llm/llm.types'
import { FakeOpenAIClient } from './fake-openai-client'

const ragSchema = z.object({
  summary: z.string(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  confidence: z.number(),
  order_permission: z.literal(false),
  citations: z.array(z.string()),
})

const validOutput = {
  summary: 'ok',
  risk_level: 'LOW',
  confidence: 0.4,
  order_permission: false,
  citations: ['c1'],
}

const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'q' },
]

describe('OpenAILlmAdapter', () => {
  it('returns schema-validated structured output with usage meta', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        content: JSON.stringify(validOutput),
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }),
    })
    const adapter = new OpenAILlmAdapter(client)

    const res = await adapter.generateStructured({
      messages,
      schema: ragSchema,
      schemaName: 'rag_market_context',
    })

    expect(res.data.risk_level).toBe('LOW')
    expect(res.data.order_permission).toBe(false)
    expect(res.meta.input_tokens).toBe(100)
    expect(res.meta.output_tokens).toBe(30)
    expect(typeof res.meta.estimated_cost).toBe('string')
  })

  it('enforces fixed temperature/seed and strict json_schema response_format', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        content: JSON.stringify(validOutput),
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    })
    const adapter = new OpenAILlmAdapter(client)
    await adapter.generateStructured({
      messages,
      schema: ragSchema,
      schemaName: 'rag_market_context',
    })

    const sent = client.lastChatParams!
    expect(sent.temperature).toBe(LLM_FIXED_TEMPERATURE)
    expect(sent.seed).toBe(LLM_FIXED_SEED)
    expect(sent.response_format.type).toBe('json_schema')
    expect(sent.response_format.json_schema.strict).toBe(true)
    expect(sent.response_format.json_schema.name).toBe('rag_market_context')
    // strict mode: object は additionalProperties=false + 全 key required
    const schema = sent.response_format.json_schema.schema as {
      additionalProperties: boolean
      required: string[]
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(
      expect.arrayContaining(['summary', 'risk_level', 'order_permission']),
    )
  })

  it('throws schema_invalid when output is not valid JSON', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        content: 'not json',
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    })
    const adapter = new OpenAILlmAdapter(client)
    await expect(
      adapter.generateStructured({
        messages,
        schema: ragSchema,
        schemaName: 's',
      }),
    ).rejects.toMatchObject({ kind: 'schema_invalid', retryable: false })
  })

  it('throws schema_invalid when output violates the schema', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        // order_permission: true は literal(false) 違反 → 弾く（13 / 横断規約5）
        content: JSON.stringify({ ...validOutput, order_permission: true }),
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    })
    const adapter = new OpenAILlmAdapter(client)
    await expect(
      adapter.generateStructured({
        messages,
        schema: ragSchema,
        schemaName: 's',
      }),
    ).rejects.toMatchObject({ kind: 'schema_invalid' })
  })

  it('maps content_filter finish_reason to safety_block', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        content: '{}',
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1, completion_tokens: 0 },
        finish_reason: 'content_filter',
      }),
    })
    const adapter = new OpenAILlmAdapter(client)
    await expect(
      adapter.generateStructured({
        messages,
        schema: ragSchema,
        schemaName: 's',
      }),
    ).rejects.toMatchObject({ kind: 'safety_block', retryable: false })
  })

  it('rejects empty messages', async () => {
    const adapter = new OpenAILlmAdapter(new FakeOpenAIClient())
    await expect(
      adapter.generateStructured({
        messages: [],
        schema: ragSchema,
        schemaName: 's',
      }),
    ).rejects.toMatchObject({ kind: 'api_error' })
  })

  it('honors an explicit temperature override', async () => {
    const client = new FakeOpenAIClient({
      chat: async () => ({
        content: JSON.stringify(validOutput),
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    })
    const adapter = new OpenAILlmAdapter(client)
    await adapter.generateStructured({
      messages,
      schema: ragSchema,
      schemaName: 's',
      temperature: 0.7,
    })
    expect(client.lastChatParams!.temperature).toBe(0.7)
  })
})
