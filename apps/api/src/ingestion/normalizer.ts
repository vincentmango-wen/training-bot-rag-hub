/**
 * 正規化 + Secret / PII マスキング骨子（27 §6 Normalize / §12 Guardrail 連携）。
 *
 * Chunking 前段で必ず通す。目的:
 *   1. 改行コード・空白の正規化（CRLF→LF / 全角空白 / 連続空行の圧縮）→ content_hash 安定化
 *   2. Secret マスキング（API Key / JWT / Bearer / よくある秘匿トークン）→ 13 Secret 送信禁止
 *   3. PII マスキング（メールアドレス等の最小骨子）
 *
 * MVP は内部データのみ（16）。外部由来の高度なマスキングは Phase2。本モジュールは
 * 「Embedding / DB に Secret を残さない」最小防御に限定する。
 */

export interface NormalizeResult {
  /** 正規化 + マスク済み本文。 */
  readonly normalized: string
  /** マスクした項目数（secret + pii）。監査・テスト用。 */
  readonly maskedCount: number
}

const SECRET_PLACEHOLDER = '«SECRET»'
const PII_EMAIL_PLACEHOLDER = '«EMAIL»'

/**
 * Secret 検出パターン（13 / 27 §12）。
 * - OpenAI / generic sk- 系キー
 * - GitHub PAT（ghp_ / gho_ 等）
 * - AWS Access Key ID
 * - Bearer / Authorization ヘッダ値
 * - JWT（3 セグメントの base64url）
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / generic secret keys
  /\b(gh[pousr])_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS Access Key ID
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}\b/g, // Bearer tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
]

/** PII（最小骨子）: メールアドレス。 */
const PII_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
]

/**
 * テキストを正規化し、Secret / PII をマスクする。
 */
export function normalizeText(raw: string): NormalizeResult {
  let maskedCount = 0

  // 1. 改行・空白の正規化
  let text = raw
    .replace(/\r\n?/g, '\n') // CRLF / CR → LF
    .replace(/ /g, ' ') // NBSP → 半角空白
    .replace(/　/g, ' ') // 全角空白 → 半角空白
    .replace(/[ \t]+\n/g, '\n') // 行末空白除去
    .replace(/\n{3,}/g, '\n\n') // 3 連以上の空行を 2 行に圧縮

  // 2. Secret マスキング（行・コードブロック内も対象）
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      maskedCount += 1
      return SECRET_PLACEHOLDER
    })
  }

  // 3. PII マスキング
  for (const pattern of PII_PATTERNS) {
    text = text.replace(pattern, () => {
      maskedCount += 1
      return PII_EMAIL_PLACEHOLDER
    })
  }

  return { normalized: text.trim(), maskedCount }
}
