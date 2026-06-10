import { createHash } from 'node:crypto'

/**
 * content_hash / payload_hash 算出（sha256 hex / 05 §5.3・§5.4・§5.6 / 横断規約 §3）。
 *
 * - chunk / document の重複排除・差分判定（27 §10.1: content_hash 一致なら再 Embedding しない）
 * - 冪等性の payload_hash（同一 idempotency_key で別 payload の再送を 409 判定する材料）
 *
 * 安定性のため、payload はキー順を正規化した JSON にしてからハッシュする
 * （プロパティ順の違いで別ハッシュになる事故を防ぐ）。
 */

/** 文字列（chunk.content / document.normalizedContent）の sha256 hex。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 任意 JSON 値を **キー順安定化** した上で sha256 する（payload_hash 用）。
 * 配列順は意味を持つため保持し、オブジェクトのキーのみ昇順整列する。
 */
export function stableHashOfJson(value: unknown): string {
  return sha256Hex(stableStringify(value))
}

/** キー順を安定化した JSON 文字列化（payload_hash 安定性のため）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const out: Record<string, unknown> = {}
    for (const [k, v] of entries) {
      out[k] = sortKeysDeep(v)
    }
    return out
  }
  return value
}
