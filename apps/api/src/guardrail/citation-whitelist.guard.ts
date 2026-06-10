/**
 * Guard (b) + (e): citation whitelist 検証 + quality_status ACTIVE 限定。
 *
 * 正本: 10 §6.1（chunk_id whitelist 検証 / B2）+ §9.1（Citation 品質検証）/ 30 §4.8。
 *
 * 検証ロジック（決定的 / LLM 非依存）:
 *   1. whitelist 集合 = 当該クエリの retrieval 結果集合（rag_retrieval_results の chunk_id）。
 *      LLM が返した citation の chunk_id がこの集合に **実在するものだけ許可**。
 *      集合外 ID（LLM の捏造）は citation ごと除去（B2 核心）。
 *   2. quality_status は DB 側（retrieval 集合）の真値で判定する。LLM 申告値は信用しない。
 *      ACTIVE 以外（QUARANTINED / DISABLED / STALE / LOW_RELIABILITY）の chunk を引用した
 *      citation は除去（§9.1 Citation 品質検証）。
 *   3. 除去の結果 citations が空 → `block: true`。呼び出し側は 422 RAG_GUARDRAIL_BLOCKED
 *      を返す（04 NFR-LLM-006「根拠なし回答は返却しない」）。
 *
 * DB 層でも複合 FK (retrieval_result_id, chunk_id)→rag_retrieval_results(id, chunk_id) で
 * 物理強制される（05）。本 Guard はアプリ層の決定的 fail-fast。
 */
import { Injectable } from '@nestjs/common'
import { CITATION_ACTIVE_STATUS } from './guardrail.enums'
import type {
  CitationCandidate,
  CitationFilterInput,
  CitationFilterOutput,
  GuardrailViolation,
  RetrievalResultRef,
} from './guardrail.types'

@Injectable()
export class CitationWhitelistGuard {
  /**
   * citation 配列を whitelist + ACTIVE で絞り込む。
   * 入力 citation は変更せず、許可されたものだけを新配列で返す（純関数的）。
   */
  filter<C extends CitationCandidate>(
    input: CitationFilterInput<C>,
  ): CitationFilterOutput<C> {
    const { citations, retrievalResults } = input

    // whitelist 集合: chunk_id -> DB 側 quality_status（真値）。
    const whitelist = this.buildWhitelist(retrievalResults)

    const allowed: C[] = []
    const removedNotInWhitelist: string[] = []
    const removedNonActive: string[] = []
    const violations: GuardrailViolation[] = []

    citations.forEach((citation, index) => {
      const chunkId = citation.chunk_id
      const dbStatus = whitelist.get(chunkId)

      // 1. whitelist 集合外 = 捏造 ID → 除去（B2 核心）。
      if (dbStatus === undefined) {
        removedNotInWhitelist.push(chunkId)
        violations.push({
          type: 'citation_whitelist',
          severity: 'CRITICAL',
          blocking: false, // 個別除去は BLOCK ではない（空になったら集約で BLOCK）。
          message: `Citation chunk_id is not in the query retrieval set (fabricated/hallucinated); removed.`,
          field: `citations[${index}].chunk_id`,
        })
        return
      }

      // 2. quality_status は DB 側の真値で判定（LLM 申告は無視）。
      if (dbStatus !== CITATION_ACTIVE_STATUS) {
        removedNonActive.push(chunkId)
        violations.push({
          type: 'citation_quality',
          severity: 'HIGH',
          blocking: false,
          message: `Citation chunk quality_status is "${dbStatus}" (not ACTIVE); removed.`,
          field: `citations[${index}].chunk_id`,
        })
        return
      }

      allowed.push(citation)
    })

    // 3. 残存 0 件 = 根拠なし回答 → BLOCK シグナル。
    const block = allowed.length === 0
    if (block) {
      violations.push({
        type: 'citation_whitelist',
        severity: 'CRITICAL',
        blocking: true,
        message:
          'No valid citations remain after whitelist/quality filtering; response must be blocked (422 RAG_GUARDRAIL_BLOCKED).',
        field: 'citations',
      })
    }

    return {
      allowed,
      removedNotInWhitelist,
      removedNonActive,
      violations,
      block,
    }
  }

  /**
   * retrieval 集合から chunk_id -> quality_status の map を構築する（whitelist 正本）。
   * 同一 chunk_id が重複した場合は、より厳しい（ACTIVE でない）方を優先する fail-safe。
   */
  private buildWhitelist(
    retrievalResults: RetrievalResultRef[],
  ): Map<string, string> {
    const map = new Map<string, string>()
    for (const ref of retrievalResults) {
      const existing = map.get(ref.chunk_id)
      if (existing === undefined) {
        map.set(ref.chunk_id, ref.quality_status)
        continue
      }
      // 既存が ACTIVE で新規が非 ACTIVE なら、非 ACTIVE を採用（厳しい方優先）。
      if (
        existing === CITATION_ACTIVE_STATUS &&
        ref.quality_status !== CITATION_ACTIVE_STATUS
      ) {
        map.set(ref.chunk_id, ref.quality_status)
      }
    }
    return map
  }
}
