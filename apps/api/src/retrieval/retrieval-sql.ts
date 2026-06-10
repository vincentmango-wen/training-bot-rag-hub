import { Prisma } from '@prisma/client'

import {
  buildChunkVisibilityWhere,
} from './chunk-visibility.where'
import { recencyScoreSqlExpression } from './recency'
import {
  type ChunkVisibilityParams,
  type CompositeScoreWeights,
  type RetrievalFilters,
} from './retrieval.types'

/**
 * ANN 検索 SQL ($queryRaw 固定 / 05 §9.4) の組み立て。§8.1 の合成スコア正本 SQL を 1 ファイルに集約。
 *
 * パイプライン（§8.1）:
 *   ann_candidates : HNSW で oversample（top_k × oversampleFactor）
 *   scored         : chunk/document/source join + 可視性 helper WHERE + Metadata Filter
 *                    + recency 動的計算（§5.4 設計裁定 2）
 *   deduped 段A    : 同一 content_hash は final_score 最良の 1 件（near-dup 除去）
 *   capped  段B    : 1 document あたり最大 perDocumentCap chunk（文脈占有防止）
 *   最終           : final_score 降順 limit top_k
 *
 * キャスト式 `embedding::vector(N)` と部分 index 述語（provider/model/dimension/status）は
 * §7.3 の HNSW 部分式 index と **完全一致** させる（planner がインデックスを使う条件）。
 */

/** SQL から 1 行で返るレコード（snake_case / pg の生カラム名）。 */
export type RetrievalSqlRow = {
  chunk_id: string
  document_id: string
  source_id: string
  content: string
  metadata: unknown
  similarity_score: number
  reliability_score: number
  recency_score: number
  final_score: number
}

export type BuildRetrievalSqlArgs = {
  /** query embedding（dimension と長さ一致）。 */
  embedding: readonly number[]
  provider: string
  model: string
  dimension: number
  topK: number
  oversampleFactor: number
  perDocumentCap: number
  filters: RetrievalFilters
  visibility: Partial<ChunkVisibilityParams>
  weights: CompositeScoreWeights
}

/**
 * pgvector のベクトルリテラル文字列（`[1,2,3]`）を生成する。
 * NaN / Infinity は拒否（不正ベクトルでの planner 破壊・SQL エラーを早期に止める）。
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length === 0) {
    throw new Error('embedding must not be empty')
  }
  for (const v of embedding) {
    if (!Number.isFinite(v)) {
      throw new Error('embedding contains non-finite value')
    }
  }
  return `[${embedding.join(',')}]`
}

/**
 * §8.1 の合成スコア検索 SQL を `Prisma.Sql` として組み立てる。
 * embedding / 次元 / Metadata Filter / 重みは全てパラメータ化。
 * 可視性 WHERE は {@link buildChunkVisibilityWhere}（SSoT）経由でのみ注入する。
 */
export function buildRetrievalSql(args: BuildRetrievalSqlArgs): Prisma.Sql {
  const {
    embedding,
    provider,
    model,
    dimension,
    topK,
    oversampleFactor,
    perDocumentCap,
    filters,
    visibility,
    weights,
  } = args

  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`invalid dimension: ${dimension}`)
  }
  if (embedding.length !== dimension) {
    throw new Error(
      `embedding length (${embedding.length}) !== dimension (${dimension})`,
    )
  }

  const vectorLiteral = toVectorLiteral(embedding)
  // キャスト式の次元 N は §7.3 部分 index と一致させる。dimension は整数検証済みのため raw 可。
  const dimLiteral = Prisma.raw(String(dimension))
  const oversampleLimit = topK * oversampleFactor

  // ANN 距離式（cosine）。candidate CTE と similarity_score の両方で同一キャスト式を使う。
  const annOrder = Prisma.sql`e.embedding::vector(${dimLiteral}) <=> ${vectorLiteral}::vector(${dimLiteral})`
  const similarityExpr = Prisma.sql`1 - (e.embedding::vector(${dimLiteral}) <=> ${vectorLiteral}::vector(${dimLiteral}))`

  const visibilityWhere = buildChunkVisibilityWhere(visibility)
  const metadataWhere = buildMetadataFilterWhere(filters)
  const recencyExpr = Prisma.raw(recencyScoreSqlExpression('c'))

  return Prisma.sql`
    with ann_candidates as (
      select
        e.chunk_id,
        ${similarityExpr} as similarity_score
      from rag_embeddings e
      where e.provider = ${provider}
        and e.model = ${model}
        and e.dimension = ${dimension}
        and e.status = 'ACTIVE'
      order by ${annOrder}
      limit ${oversampleLimit}
    ),
    scored as (
      select
        c.id as chunk_id,
        c.document_id,
        c.source_id,
        c.content,
        c.content_hash,
        c.metadata,
        a.similarity_score,
        s.reliability_score,
        ${recencyExpr} as recency_score
      from ann_candidates a
      join rag_chunks    c on c.id = a.chunk_id
      join rag_documents d on d.id = c.document_id
      join rag_sources   s on s.id = c.source_id
      where ${visibilityWhere}
        ${metadataWhere}
    ),
    deduped as (
      select distinct on (content_hash) *
      from (
        select *,
          (similarity_score * ${weights.similarity}
           + reliability_score * ${weights.reliability}
           + recency_score * ${weights.recency}) as final_score
        from scored
      ) x
      order by content_hash, final_score desc
    ),
    capped as (
      select *,
        row_number() over (partition by document_id order by final_score desc) as doc_rank
      from deduped
    )
    select chunk_id, document_id, source_id, content, metadata,
           similarity_score, reliability_score, recency_score, final_score
    from capped
    where doc_rank <= ${perDocumentCap}
    order by final_score desc
    limit ${topK}
  `
}

/**
 * Metadata Filter の WHERE 断片（05 §8.1 $5〜$9）。
 * 各条件は「指定がある時のみ」AND される。未指定はフィルタ無効（NULL 同等）。
 * 戻り値は先頭に ` and ` を含む（scored CTE の visibility WHERE に続けて連結する形）。
 */
export function buildMetadataFilterWhere(
  filters: RetrievalFilters,
): Prisma.Sql {
  const parts: Prisma.Sql[] = []

  if (filters.symbol !== undefined) {
    parts.push(Prisma.sql`c.symbol = ${filters.symbol}`)
  }
  if (filters.timeframe !== undefined) {
    parts.push(Prisma.sql`c.timeframe = ${filters.timeframe}`)
  }
  if (filters.sourceTypes !== undefined && filters.sourceTypes.length > 0) {
    parts.push(
      Prisma.sql`c.source_type in (${Prisma.join([...filters.sourceTypes])})`,
    )
  }
  if (filters.eventTimeFrom !== undefined) {
    parts.push(Prisma.sql`c.event_time >= ${filters.eventTimeFrom}`)
  }
  if (filters.eventTimeTo !== undefined) {
    parts.push(Prisma.sql`c.event_time <= ${filters.eventTimeTo}`)
  }

  if (parts.length === 0) {
    return Prisma.empty
  }
  return Prisma.sql` and ${Prisma.join(parts, ' and ')}`
}
