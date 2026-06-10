/**
 * Prompt Injection スキャナ（27 §6 / §12 / §14 / AC-CHUNK-006）。
 *
 * 取込テキストに「LLM への命令文」が混入していないかを検知する。疑いを検出した
 * chunk は `status='QUARANTINED'` で保存し、検索対象から除外する（検索 WHERE は
 * `status='ACTIVE'` のみ通すため、隔離 chunk は context に載らない）。
 *
 * MVP は内部データのみ（16）のため誤検知の実害は小さいが、strategy_doc は外部設計
 * 文書を貼り付ける可能性があるため最小限のパターン検知を入れる。高度な検知（多言語・
 * 難読化）は Phase2。
 *
 * 設計判断: 「BLOCK（取込拒否）」ではなく「QUARANTINE（隔離保存）」を既定とする。
 * 監査のため原文は残し、検索からのみ除外する（27 §6 フロー注記 / 05 status ステートマシン）。
 */

export interface InjectionScanResult {
  /** 疑いを検出したか。true なら呼び出し側は chunk を QUARANTINED にする。 */
  readonly suspected: boolean
  /** マッチした理由（監査・テスト用 / detected_items 相当）。 */
  readonly matchedPatterns: string[]
}

/**
 * Injection 疑いパターン（日本語 + 英語の典型命令文）。
 * 「これまでの指示を無視」「あなたは〜として振る舞え」「system prompt を出力」等。
 */
const INJECTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'ignore_previous_instructions',
    re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)/i,
  },
  {
    name: 'disregard_instructions',
    re: /disregard\s+(all\s+)?(previous|prior|the\s+above)\s+(instructions|rules)/i,
  },
  { name: 'reveal_system_prompt', re: /(reveal|print|output|show)\s+(the\s+)?(system|developer)\s+prompt/i },
  { name: 'you_are_now', re: /you\s+are\s+now\s+(a|an|the)\b/i },
  { name: 'act_as_jailbreak', re: /\bact\s+as\s+(a\s+)?(dan|jailbroken|unrestricted)\b/i },
  { name: 'ja_ignore_instructions', re: /(これまで|以前|上記|先ほど)の(指示|命令|プロンプト)を(無視|忘れ)/ },
  { name: 'ja_act_as', re: /(あなたは)(今|これから)(から)?[^\n。]{0,20}(として(振る舞|動作|応答))/ },
  { name: 'ja_reveal_prompt', re: /(システム|開発者)(プロンプト|指示)を(表示|出力|教え)/ },
  { name: 'order_execution_injection', re: /(execute|place|submit|送信|発注|実行)\s*(an?\s+)?(order|trade|注文|取引)/i },
]

/**
 * テキストを走査し injection 疑いを検出する。
 * @param text 正規化済みテキスト（normalizer 通過後）。
 */
export function scanForInjection(text: string): InjectionScanResult {
  const matched: string[] = []
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      matched.push(name)
    }
  }
  return { suspected: matched.length > 0, matchedPatterns: matched }
}
