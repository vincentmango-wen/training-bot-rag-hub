/**
 * 決定的 UUID（RFC 4122 v5 風）生成ヘルパ。
 *
 * 同一入力から常に同一 UUID を導出する。similar-cases の case_id を retrieval_result_id +
 * chunk_id から決定的に作るために使う（Minor: randomUUID() 非決定 → replay 不一致の是正）。
 *
 * 実装は SHA-256 ベース（namespace UUID は使わず文字列を直接ハッシュ）。version nibble を 5、
 * variant bits を RFC 4122（10xx）に固定するため `z.string().uuid()` を満たす。
 */
import { createHash } from 'node:crypto'

/** 任意文字列から決定的 UUID（小文字 8-4-4-4-12）を導出する。 */
export function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex')
  // 先頭 32 桁（16 バイト）を UUID に整形する。
  const bytes = hex.slice(0, 32).split('')

  // version = 5（13 桁目を 5 に固定）。
  bytes[12] = '5'
  // variant = RFC 4122（17 桁目を 8/9/a/b に固定）。
  const variantNibble = parseInt(bytes[16] as string, 16)
  bytes[16] = ((variantNibble & 0x3) | 0x8).toString(16)

  const h = bytes.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
