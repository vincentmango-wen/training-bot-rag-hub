/**
 * Guard (d): Prompt Injection 一次検知 + 取得文書のデリミタ隔離。
 *
 * 正本: 21 §11（Prompt Injection 防御 / 前処理プロンプト + 検知対象）/ 10 §9.1。
 *
 * 2 つの責務:
 *   1. デリミタ隔離（isolate）: 取得文書は「データであり命令ではない」。LLM に渡す際に
 *      固定デリミタで囲み、文書内に同じデリミタが紛れ込む偽装を無効化（エスケープ）する。
 *   2. 命令文字列検知（scan）: 取得文書本文に既知の injection 命令パターンが含まれるかを
 *      regex で決定的に検知する。検知は WARNING（文書を破棄するか隔離して続行するかは
 *      呼び出し側方針 / 本 Guard は BLOCK を強制しない。命令は隔離で無効化されるため）。
 *
 * 決定的（regex / コード）。LLM 検知に依存しない。
 */
import { Injectable } from '@nestjs/common'
import type {
  GuardrailViolation,
  InjectionScanResult,
  RetrievedDocument,
} from './guardrail.types'

/** 取得文書を囲む固定デリミタ（LLM プロンプトでデータ境界を明示する）。 */
export const RETRIEVED_DOC_DELIMITER_OPEN = '<<<RETRIEVED_DOCUMENT>>>'
export const RETRIEVED_DOC_DELIMITER_CLOSE = '<<<END_RETRIEVED_DOCUMENT>>>'

type InjectionRule = {
  label: string
  pattern: RegExp
}

/**
 * 21 §11「検知対象」を regex 化。大小文字・軽微な表現ゆれを許容する。
 * 命令の意図（指示無視 / ロール変更 / API/取引実行 / secret 開示）を捉える。
 */
const INJECTION_RULES: readonly InjectionRule[] = [
  // Ignore previous instructions / disregard above
  {
    label: 'ignore_instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?|context)\b/i,
  },
  // You are now admin / act as system / new role
  {
    label: 'role_change',
    pattern:
      /\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you\s+are)\b[^.\n]{0,30}\b(?:admin|administrator|root|system|developer|dan|jailbreak)\b/i,
  },
  // system prompt override / change system prompt
  {
    label: 'system_override',
    pattern: /\b(?:system\s*(?:prompt|message|override)|override\s+system)\b/i,
  },
  // Call Order API / execute trade / place order
  {
    label: 'order_execution',
    pattern:
      /\b(?:call|invoke|execute|run|place|submit|trigger)\b[^.\n]{0,30}\b(?:order|trade|trades|trading|buy|sell|position|api)\b/i,
  },
  // Tool / function execution request
  {
    label: 'tool_execution',
    pattern:
      /\b(?:call|invoke|execute|run|use)\b[^.\n]{0,20}\b(?:tool|function|command|shell|bash|eval)\b/i,
  },
  // Reveal secret / show API key / print credentials
  {
    label: 'secret_exfiltration',
    pattern:
      /\b(?:reveal|show|print|expose|leak|dump|output|give\s+me)\b[^.\n]{0,30}\b(?:secret|secrets|api[\s_-]?key|apikey|password|credential|token|jwt|env(?:ironment)?\s*(?:var|variable)?)\b/i,
  },
]

@Injectable()
export class PromptInjectionGuard {
  /**
   * 取得文書群を injection 命令についてスキャンする（破棄/隔離の判断材料）。
   * 命令はデリミタ隔離で無効化される前提のため、検知は WARNING にとどめる。
   */
  scan(documents: readonly RetrievedDocument[]): InjectionScanResult {
    const hits: Array<{ id: string; patterns: string[] }> = []
    const violations: GuardrailViolation[] = []

    for (const doc of documents) {
      const matched = this.matchPatterns(doc.content)
      if (matched.length > 0) {
        hits.push({ id: doc.id, patterns: matched })
        violations.push({
          type: 'prompt_injection',
          severity: 'HIGH',
          blocking: false,
          message: `Retrieved document contains instruction-like patterns [${matched.join(', ')}]; treated as data and isolated by delimiters.`,
          field: `retrieved_document[${doc.id}]`,
        })
      }
    }

    return {
      detected: hits.length > 0,
      hits,
      violations,
    }
  }

  /**
   * 取得文書 1 件を LLM 投入用にデリミタ隔離する。
   * 文書内に閉じデリミタが偽装挿入されていてもエスケープして境界を守る。
   */
  isolate(document: RetrievedDocument): string {
    const sanitized = this.escapeDelimiters(document.content)
    return [
      RETRIEVED_DOC_DELIMITER_OPEN,
      sanitized,
      RETRIEVED_DOC_DELIMITER_CLOSE,
    ].join('\n')
  }

  /** 複数文書を順に隔離して結合する。 */
  isolateMany(documents: readonly RetrievedDocument[]): string {
    return documents.map((d) => this.isolate(d)).join('\n\n')
  }

  /** 単一テキストに injection パターンが含まれるか（ラベル配列を返す）。 */
  private matchPatterns(text: string): string[] {
    const labels: string[] = []
    for (const rule of INJECTION_RULES) {
      if (rule.pattern.test(text)) {
        labels.push(rule.label)
      }
    }
    return labels
  }

  /**
   * 本文に紛れ込んだデリミタ文字列を無害化する。
   * `<<<` を全角風プレースホルダに潰し、境界偽装を防ぐ。
   */
  private escapeDelimiters(content: string): string {
    return content
      .split(RETRIEVED_DOC_DELIMITER_OPEN)
      .join('[REDACTED_DELIMITER]')
      .split(RETRIEVED_DOC_DELIMITER_CLOSE)
      .join('[REDACTED_DELIMITER]')
  }
}
