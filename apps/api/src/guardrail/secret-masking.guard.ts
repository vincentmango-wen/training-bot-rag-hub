/**
 * Guard (c): Secret Masking（10 §9.1 / 21 §5「You must NEVER access secrets」）。
 *
 * 送信前（LLM へ渡す前）・保存前（citation.excerpt 等のスナップショット保存前）の
 * **マスク処理の SSoT を本ファイル 1 箇所に集約**する。各所で個別 regex を書かない。
 *
 * 決定的（regex / コード）。LLM 検証に依存しない。
 *
 * マスク対象（API Key / JWT / 個人情報の代表パターン）:
 *   - OpenAI API key: sk-... / sk-proj-... / sk-svcacct-...
 *   - Anthropic API key: sk-ant-...
 *   - 汎用 Bearer トークン / Authorization ヘッダ値
 *   - AWS Access Key ID: AKIA... / ASIA...
 *   - Google API key: AIza...
 *   - GitHub token: ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_
 *   - Slack token: xox[baprs]-...
 *   - JWT: 3 セグメントの base64url（eyJ で始まる header）
 *   - Email アドレス（個人情報）
 *   - クレジットカード番号（13〜16 桁 / 区切り許容）
 *
 * マスク後は固定トークン `***MASKED:<kind>***` に置換し、原文の長さ・内容を漏らさない。
 */
import { Injectable } from '@nestjs/common'
import type { SecretMaskResult } from './guardrail.types'

type MaskRule = {
  kind: string
  pattern: RegExp
}

/**
 * SSoT のマスクルール表。順序が意味を持つ（より特異的なパターンを先に置く）。
 * 例: OpenAI/Anthropic key を汎用 Bearer より先に評価する。
 */
const MASK_RULES: readonly MaskRule[] = [
  // Anthropic（sk-ant- は OpenAI の sk- より特異的なので先）
  { kind: 'anthropic_api_key', pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI（sk-proj- / sk-svcacct- / sk-）
  {
    kind: 'openai_api_key',
    pattern: /sk-(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{20,}/g,
  },
  // GitHub tokens
  {
    kind: 'github_token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g,
  },
  // Slack tokens
  { kind: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // AWS Access Key ID
  { kind: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Google API key
  { kind: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // JWT（eyJ で始まる 3 セグメント base64url）
  {
    kind: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  // Authorization: Bearer <token> / Bearer トークン単体
  {
    kind: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  // クレジットカード番号（区切り許容 / 13〜16 桁）
  {
    kind: 'credit_card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
  },
  // Email アドレス（個人情報）
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
]

@Injectable()
export class SecretMaskingGuard {
  /**
   * 入力文字列中の secret / 個人情報をマスクする（SSoT エントリポイント）。
   * @param input マスク対象（取得文書本文 / LLM プロンプト / excerpt 等）
   */
  mask(input: string): SecretMaskResult {
    if (input.length === 0) {
      return { masked: input, maskedAny: false, kinds: [] }
    }

    let masked = input
    const kinds = new Set<string>()

    for (const rule of MASK_RULES) {
      // global フラグの lastIndex 汚染を避けるため都度生成する。
      const re = new RegExp(rule.pattern.source, rule.pattern.flags)
      masked = masked.replace(re, () => {
        kinds.add(rule.kind)
        return `***MASKED:${rule.kind}***`
      })
    }

    return {
      masked,
      maskedAny: kinds.size > 0,
      kinds: [...kinds],
    }
  }

  /**
   * 複数文字列を一括マスクする利便メソッド（取得文書群の前処理用）。
   * 個々の結果を返さず、結合後の集約のみ返す（呼び出し側で配列再構築するときは mask を使う）。
   */
  maskMany(inputs: readonly string[]): { masked: string[]; kinds: string[] } {
    const allKinds = new Set<string>()
    const masked = inputs.map((s) => {
      const r = this.mask(s)
      for (const k of r.kinds) {
        allKinds.add(k)
      }
      return r.masked
    })
    return { masked, kinds: [...allKinds] }
  }
}
