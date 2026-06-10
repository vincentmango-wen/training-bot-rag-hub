/**
 * 最小 Zod → JSON Schema 変換（OpenAI structured output strict mode 用）。
 *
 * OpenAI の `response_format: json_schema (strict: true)` は以下を要求する:
 *   - object は `additionalProperties: false`
 *   - object の全 key が `required`（optional 不可 / nullable で表現）
 *
 * RAG 出力 schema（21 §出力 Schema）で使う最小サブセットだけを変換する:
 *   object / string / number / boolean / array / enum / literal / nullable / optional。
 * 未対応構造は明示的に throw して「サイレントに緩い schema を投げる」事故を防ぐ。
 *
 * 依存追加（zod-to-json-schema 等）を避け、strict 要件を確実に満たすため自前実装。
 */
import type { z, ZodTypeAny } from 'zod'

export interface JsonSchemaNode {
  type?: string | string[]
  enum?: readonly unknown[]
  const?: unknown
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

/** Zod の内部 typeName を安全に取り出す。 */
function typeNameOf(schema: ZodTypeAny): string {
  return (schema._def as { typeName: string }).typeName
}

function withNull(node: JsonSchemaNode): JsonSchemaNode {
  if (Array.isArray(node.type)) {
    if (!node.type.includes('null')) node.type = [...node.type, 'null']
    return node
  }
  if (typeof node.type === 'string') {
    return { ...node, type: [node.type, 'null'] }
  }
  // enum / const などで type 無しの場合は anyOf 風にできないため、null 許容を type で表現
  return { ...node, type: ['null'] }
}

/**
 * Zod schema を OpenAI strict JSON Schema に変換する。
 * @throws 未対応の Zod 構造を検出した場合（明示失敗）。
 */
export function zodToOpenAiJsonSchema(schema: ZodTypeAny): JsonSchemaNode {
  const typeName = typeNameOf(schema)

  switch (typeName) {
    case 'ZodString':
      return { type: 'string' }

    case 'ZodNumber':
      return { type: 'number' }

    case 'ZodBoolean':
      return { type: 'boolean' }

    case 'ZodLiteral': {
      const value = (schema._def as { value: unknown }).value
      return { const: value }
    }

    case 'ZodEnum': {
      const values = (schema._def as { values: readonly string[] }).values
      return { type: 'string', enum: values }
    }

    case 'ZodNativeEnum': {
      const values = Object.values(
        (schema._def as { values: Record<string, unknown> }).values,
      )
      return { enum: values }
    }

    case 'ZodArray': {
      const element = (schema._def as { type: ZodTypeAny }).type
      return { type: 'array', items: zodToOpenAiJsonSchema(element) }
    }

    case 'ZodObject': {
      const shape = (
        schema as z.ZodObject<z.ZodRawShape>
      ).shape as Record<string, ZodTypeAny>
      const properties: Record<string, JsonSchemaNode> = {}
      // strict mode: 全 key を required にする。optional は null 許容で表現。
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenAiJsonSchema(value)
        required.push(key)
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      }
    }

    case 'ZodNullable': {
      const inner = (schema._def as { innerType: ZodTypeAny }).innerType
      return withNull(zodToOpenAiJsonSchema(inner))
    }

    case 'ZodOptional': {
      // strict mode に optional は無い。null 許容に倒して required を維持する。
      const inner = (schema._def as { innerType: ZodTypeAny }).innerType
      return withNull(zodToOpenAiJsonSchema(inner))
    }

    case 'ZodDefault': {
      const inner = (schema._def as { innerType: ZodTypeAny }).innerType
      return zodToOpenAiJsonSchema(inner)
    }

    case 'ZodEffects': {
      // .refine / .transform 等。内側 schema を変換（JSON Schema は緩めで OK / 厳密検証は Zod 側）。
      const inner = (schema._def as { schema: ZodTypeAny }).schema
      return zodToOpenAiJsonSchema(inner)
    }

    default:
      throw new Error(
        `zodToOpenAiJsonSchema: unsupported Zod type "${typeName}". ` +
          'Add explicit handling before using this schema for structured output.',
      )
  }
}
