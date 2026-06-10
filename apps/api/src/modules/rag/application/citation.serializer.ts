/**
 * Citation 組み立て + audience 別出し分け（10 §6.1 citation / B2 whitelist / audience）。
 *
 * - LLM が返した chunk_id（whitelist 通過済み）を retrieval 集合のメタで補完して
 *   API citation（common.ts citationSchema 準拠）を組む。
 * - quality_status は **DB 側の真値**（retrieval 集合）を使う（LLM 申告は信用しない）。
 * - excerpt は ui / admin 系のみ。training_bot / system / worker は省略（トークン・帯域節約 +
 *   Secret 二次流出面の最小化 / 10 §6.1 audience 別出し分け）。エンドポイントは分けない。
 */
import type { Citation, CitationQualityStatus } from '@pmtp/shared'
import { FULL_CITATION_AUDIENCES } from '../http/request-context'
import type { ClientType } from '@pmtp/shared'

/** retrieval 集合 1 件 + citation 組み立てに必要な DB メタ（chunk/document/source 由来）。 */
export interface CitationContext {
  chunkId: string
  sourceId: string
  documentId: string
  sourceType: string
  title?: string
  /** Secret Masking 済みの本文先頭（excerpt 候補 / ui 向けのみ出力）。 */
  excerpt: string
  eventTime: string | null
  ingestedAt: string
  /** rerank 後検索スコア（retrieval 集合スナップショット）。 */
  retrievalScore: number
  /** DB 側真値の品質ステータス。 */
  qualityStatus: CitationQualityStatus
}

/** LLM が返した citation のうち whitelist + ACTIVE を通過した 1 件（used_reason 保持）。 */
export interface AllowedLlmCitation {
  chunk_id: string
  used_reason: string
}

/**
 * 通過 citation を API citation 配列へ組み立てる。
 * audience が full 対象でなければ excerpt を省略する。
 */
export function buildCitations(
  allowed: AllowedLlmCitation[],
  contextByChunkId: ReadonlyMap<string, CitationContext>,
  audience: ClientType,
): Citation[] {
  const includeExcerpt = FULL_CITATION_AUDIENCES.includes(audience)
  const citations: Citation[] = []

  for (const item of allowed) {
    const ctx = contextByChunkId.get(item.chunk_id)
    // whitelist 通過済みのため通常 ctx は存在するが、防御的に skip（捏造は既に除去済み）。
    if (ctx === undefined) continue

    const citation: Citation = {
      source_id: ctx.sourceId,
      document_id: ctx.documentId,
      chunk_id: ctx.chunkId,
      source_type: ctx.sourceType as Citation['source_type'],
      used_reason: item.used_reason,
      event_time: ctx.eventTime,
      ingested_at: ctx.ingestedAt,
      retrieval_score: ctx.retrievalScore,
      quality_status: ctx.qualityStatus,
    }
    if (ctx.title !== undefined) citation.title = ctx.title
    if (includeExcerpt) citation.excerpt = ctx.excerpt

    citations.push(citation)
  }

  return citations
}
