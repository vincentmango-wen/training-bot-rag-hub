import { z } from 'zod'
import {
  zodToOpenAiJsonSchema,
  type JsonSchemaNode,
} from '../llm/zod-to-openai-schema'

describe('zodToOpenAiJsonSchema', () => {
  it('emits strict object (additionalProperties=false, all keys required)', () => {
    const schema = z.object({ a: z.string(), b: z.number() })
    const json = zodToOpenAiJsonSchema(schema)
    expect(json.type).toBe('object')
    expect(json.additionalProperties).toBe(false)
    expect(json.required).toEqual(['a', 'b'])
    expect(json.properties?.a).toEqual({ type: 'string' })
    expect(json.properties?.b).toEqual({ type: 'number' })
  })

  it('maps z.enum to string + enum values', () => {
    const json = zodToOpenAiJsonSchema(z.enum(['LOW', 'HIGH']))
    expect(json).toEqual({ type: 'string', enum: ['LOW', 'HIGH'] })
  })

  it('maps z.literal(false) to const', () => {
    expect(zodToOpenAiJsonSchema(z.literal(false))).toEqual({ const: false })
  })

  it('maps arrays with item schema', () => {
    const json = zodToOpenAiJsonSchema(z.array(z.string()))
    expect(json.type).toBe('array')
    expect(json.items).toEqual({ type: 'string' })
  })

  it('keeps optional/nullable keys required by widening to null', () => {
    const schema = z.object({
      maybe: z.string().optional(),
      nullable: z.string().nullable(),
    })
    const json = zodToOpenAiJsonSchema(schema)
    // strict mode: optional でも required に残し null 許容で表現
    expect(json.required).toEqual(['maybe', 'nullable'])
    const maybe = json.properties?.maybe as JsonSchemaNode
    const nullable = json.properties?.nullable as JsonSchemaNode
    expect(maybe.type).toEqual(['string', 'null'])
    expect(nullable.type).toEqual(['string', 'null'])
  })

  it('handles nested objects recursively', () => {
    const schema = z.object({
      inner: z.object({ x: z.number() }),
    })
    const json = zodToOpenAiJsonSchema(schema)
    const inner = json.properties?.inner as JsonSchemaNode
    expect(inner.type).toBe('object')
    expect(inner.additionalProperties).toBe(false)
    expect(inner.required).toEqual(['x'])
  })

  it('throws on unsupported zod types (no silent loosening)', () => {
    expect(() => zodToOpenAiJsonSchema(z.record(z.string()))).toThrow(
      /unsupported Zod type/,
    )
  })
})
