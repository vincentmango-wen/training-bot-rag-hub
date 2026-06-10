/**
 * GuardrailService — 全 guard を集約する出力ガード（OutputGuard）。
 *
 * 正本: 10 §9（ガードレール仕様）/ 21 §2.1（RAG は注文しない / 根拠を提示）/ 30 §6。
 *
 * LLM 生成後・レスポンス返却前に呼ぶ唯一のエントリポイント。各 guard は決定的
 * （regex / コード）であり、LLM 検証に依存しない。
 *
 * 集約ルール:
 *   - 1 つでも blocking violation があれば status = BLOCKED、order_permission は常に false。
 *   - blocking でない violation（強制 false 上書き / injection 隔離 / 個別 citation 除去）は
 *     warnings に積み、status は WARNING（BLOCK が無い限り）。
 *   - citation が全除去で空 → block=true（422 RAG_GUARDRAIL_BLOCKED を呼び出し側が返す）。
 */
import { Injectable } from '@nestjs/common'
import { ORDER_PERMISSION } from './guardrail.enums'
import { OrderPermissionGuard } from './order-permission.guard'
import { CitationWhitelistGuard } from './citation-whitelist.guard'
import { SecretMaskingGuard } from './secret-masking.guard'
import { PromptInjectionGuard } from './prompt-injection.guard'
import type {
  CitationCandidate,
  CitationFilterOutput,
  GuardrailResult,
  GuardrailViolation,
  RetrievalResultRef,
  RetrievedDocument,
} from './guardrail.types'

/** LLM 出力検証の入力（生成後・返却前）。 */
export type ValidateOutputInput<C extends CitationCandidate = CitationCandidate> = {
  /** LLM 出力が主張した order_permission（unknown / 何が来ても false に固定）。 */
  claimedOrderPermission?: unknown
  /** LLM が返した citation 配列。 */
  citations: C[]
  /** 当該クエリの retrieval 集合（citation whitelist の正本）。 */
  retrievalResults: RetrievalResultRef[]
}

/** LLM 出力検証の結果。 */
export type ValidateOutputResult<C extends CitationCandidate = CitationCandidate> = {
  guardrail: GuardrailResult
  /** whitelist + ACTIVE を通過した citation のみ（除去後）。 */
  allowedCitations: C[]
  /** 常に false（横断規約5 / literal 固定）。 */
  order_permission: typeof ORDER_PERMISSION
  citationFilter: CitationFilterOutput<C>
}

@Injectable()
export class GuardrailService {
  constructor(
    private readonly orderPermissionGuard: OrderPermissionGuard,
    private readonly citationWhitelistGuard: CitationWhitelistGuard,
    private readonly secretMaskingGuard: SecretMaskingGuard,
    private readonly promptInjectionGuard: PromptInjectionGuard,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* 入力前処理（取得文書 → LLM 投入前）                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * 取得文書を LLM へ渡す前に: (c) secret masking → (d) injection scan + デリミタ隔離。
   * masking は隔離前に行い、隔離後の文字列にも secret が残らないことを保証する。
   */
  prepareRetrievedDocuments(documents: readonly RetrievedDocument[]): {
    /** デリミタ隔離 + secret masking 済みの結合プロンプト断片。 */
    isolatedPrompt: string
    /** masking 済みの個別文書（content 差し替え後）。 */
    sanitizedDocuments: RetrievedDocument[]
    violations: GuardrailViolation[]
    secretKinds: string[]
    injectionDetected: boolean
  } {
    const violations: GuardrailViolation[] = []

    // (c) secret masking を先に適用。
    const secretKinds = new Set<string>()
    const sanitizedDocuments: RetrievedDocument[] = documents.map((doc) => {
      const r = this.secretMaskingGuard.mask(doc.content)
      if (r.maskedAny) {
        for (const k of r.kinds) {
          secretKinds.add(k)
        }
        violations.push({
          type: 'secret_masking',
          severity: 'HIGH',
          blocking: false,
          message: `Secret(s) [${r.kinds.join(', ')}] masked in retrieved document before LLM submission.`,
          field: `retrieved_document[${doc.id}]`,
        })
      }
      return { id: doc.id, content: r.masked }
    })

    // (d) injection scan は masking 後の本文に対して行う。
    const scan = this.promptInjectionGuard.scan(sanitizedDocuments)
    violations.push(...scan.violations)

    // デリミタ隔離（命令を無効化してデータとして渡す）。
    const isolatedPrompt = this.promptInjectionGuard.isolateMany(sanitizedDocuments)

    return {
      isolatedPrompt,
      sanitizedDocuments,
      violations,
      secretKinds: [...secretKinds],
      injectionDetected: scan.detected,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 出力検証（LLM 生成後 → 返却前 / OutputGuard 本体）                        */
  /* ---------------------------------------------------------------------- */

  validateOutput<C extends CitationCandidate>(
    input: ValidateOutputInput<C>,
  ): ValidateOutputResult<C> {
    const violations: GuardrailViolation[] = []

    // (a) order_permission を literal false に固定（何が来ても上書き）。
    const orderEnforcement = this.orderPermissionGuard.enforce(
      input.claimedOrderPermission,
    )
    if (orderEnforcement.violation) {
      violations.push(orderEnforcement.violation)
    }

    // (b)+(e) citation whitelist + quality_status ACTIVE 限定。
    const citationFilter = this.citationWhitelistGuard.filter<C>({
      citations: input.citations,
      retrievalResults: input.retrievalResults,
    })
    violations.push(...citationFilter.violations)

    const guardrail = this.aggregate(violations)

    return {
      guardrail,
      allowedCitations: citationFilter.allowed,
      order_permission: ORDER_PERMISSION,
      citationFilter,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 集約                                                                    */
  /* ---------------------------------------------------------------------- */

  /** violation 群を GuardrailResult に集約する。order_permission は常に false。 */
  private aggregate(violations: GuardrailViolation[]): GuardrailResult {
    const blocked_reasons: string[] = []
    const warnings: string[] = []

    for (const v of violations) {
      if (v.blocking) {
        blocked_reasons.push(v.message)
      } else {
        warnings.push(v.message)
      }
    }

    const status =
      blocked_reasons.length > 0
        ? 'BLOCKED'
        : warnings.length > 0
          ? 'WARNING'
          : 'PASS'

    return {
      status,
      order_permission: ORDER_PERMISSION,
      blocked_reasons,
      warnings,
      violations,
    }
  }
}
