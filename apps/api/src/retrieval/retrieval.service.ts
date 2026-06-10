import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../modules/rag/infrastructure/prisma/prisma.service'
import { resolveVisibilityParams } from './chunk-visibility.where'
import { resolveWeights } from './composite-score'
import {
  buildRetrievalSql,
  type RetrievalSqlRow,
} from './retrieval-sql'
import {
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_HNSW_EF_SEARCH,
  DEFAULT_OVERSAMPLE_FACTOR,
  DEFAULT_PER_DOCUMENT_CAP,
  DEFAULT_TOP_K,
  type RetrievedChunk,
  type RetrieveInput,
  type RetrieveResult,
} from './retrieval.types'

/**
 * Retrieval サービス（公開 API）。
 *
 * 責務:
 *   1. query embedding を受け取り HNSW ANN 検索を実行（embedding 生成は呼ばない / Provider 層の責務）
 *   2. 不足時は oversample 係数を上げて 1 回 fallback（§8.1 「不足時 oversample 係数 up」）
 *   3. 検索時動的計算した recency_score / final_score を rag_retrieval_results にスナップショット保存
 *      （§5.9 / 監査再現の正本 / citation whitelist 複合 FK の参照先集合）
 *
 * 可視性 WHERE は buildChunkVisibilityWhere() SSoT 経由でのみ注入（§9.4）。
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 検索を実行し、結果を rag_retrieval_results に永続化して返す。
   *
   * fallback: 取得件数が topK 未満の場合、oversample 係数を 2 倍にして 1 回だけ再検索する
   * （ANN の oversample が dedup / 足切りで削れて不足するケースの救済 / §8.1）。
   */
  async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    const provider = input.provider ?? DEFAULT_EMBEDDING_PROVIDER
    const model = input.model ?? DEFAULT_EMBEDDING_MODEL
    const dimension = input.dimension ?? DEFAULT_EMBEDDING_DIMENSION
    const topK = input.topK ?? DEFAULT_TOP_K
    const filters = input.filters ?? {}
    const visibility = resolveVisibilityParams(input.visibility)
    const weights = resolveWeights(input.weights)
    const perDocumentCap = DEFAULT_PER_DOCUMENT_CAP

    // recall 重視（§7.3 運用規約 3）。トランザクション内 SET LOCAL でセッション汚染を避ける。
    const runSearch = async (
      oversampleFactor: number,
    ): Promise<RetrievalSqlRow[]> => {
      const sql = buildRetrievalSql({
        embedding: input.embedding,
        provider,
        model,
        dimension,
        topK,
        oversampleFactor,
        perDocumentCap,
        filters,
        visibility,
        weights,
      })
      return this.prisma.$transaction(async (tx) => {
        // Major8: prepared statement の generic plan だと §7.3 HNSW 部分式 index の述語
        // （provider/model/dimension/status のパラメータ）を planner が証明できず全走査に
        // silent degrade する恐れがある。custom plan を強制し、毎回パラメータ値を見て
        // 部分 index 述語を証明させる（リテラル埋め込みによる SQL injection 面を作らずに是正）。
        // SET LOCAL のためトランザクション内に閉じセッションを汚染しない。
        await tx.$executeRaw`set local plan_cache_mode = force_custom_plan`
        await tx.$executeRaw`set local hnsw.ef_search = ${Prisma.raw(
          String(DEFAULT_HNSW_EF_SEARCH),
        )}`
        return tx.$queryRaw<RetrievalSqlRow[]>(sql)
      })
    }

    let oversampleFactor: number = DEFAULT_OVERSAMPLE_FACTOR
    let rows = await runSearch(oversampleFactor)
    let fallbackApplied = false

    if (rows.length < topK) {
      // fallback: oversample 係数を上げて 1 回だけ再試行（§8.1 不足時 oversample up）
      const boostedFactor = oversampleFactor * 2
      const boosted = await runSearch(boostedFactor)
      if (boosted.length > rows.length) {
        rows = boosted
        oversampleFactor = boostedFactor
        fallbackApplied = true
      }
    }

    const chunks = rows.map((row, idx) => this.toRetrievedChunk(row, idx + 1))
    await this.persistRetrievalResults(input.queryId, chunks)

    return {
      queryId: input.queryId,
      chunks,
      oversampleLimit: topK * oversampleFactor,
      fallbackApplied,
    }
  }

  /** SQL 行 → 公開型。スコアは number に正規化（pg numeric が string で返る場合に備える）。 */
  private toRetrievedChunk(row: RetrievalSqlRow, rankOrder: number): RetrievedChunk {
    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      content: row.content,
      metadata: row.metadata,
      similarityScore: toNumber(row.similarity_score),
      reliabilityScore: toNumber(row.reliability_score),
      recencyScore: toNumber(row.recency_score),
      finalScore: toNumber(row.final_score),
      rankOrder,
    }
  }

  /**
   * rag_retrieval_results へスナップショット保存（§5.9）。
   *
   * - unique(query_id, chunk_id) を尊重し、再検索時は createMany skipDuplicates で冪等化。
   * - recency_score / final_score を保存（経年再計算不要・監査再現の正本）。
   * - used_in_answer は retrieval 時点では false（回答生成段で更新される）。
   */
  private async persistRetrievalResults(
    queryId: string,
    chunks: readonly RetrievedChunk[],
  ): Promise<void> {
    if (chunks.length === 0) {
      this.logger.debug(`retrieval produced 0 chunks for query ${queryId}`)
      return
    }
    const data: Prisma.RagRetrievalResultCreateManyInput[] = chunks.map(
      (chunk) => ({
        queryId,
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        rankOrder: chunk.rankOrder,
        similarityScore: new Prisma.Decimal(chunk.similarityScore),
        recencyScore: new Prisma.Decimal(chunk.recencyScore),
        finalScore: new Prisma.Decimal(chunk.finalScore),
        usedInAnswer: false,
      }),
    )
    await this.prisma.ragRetrievalResult.createMany({
      data,
      skipDuplicates: true,
    })
  }
}

/** pg numeric は driver 設定により string で返ることがあるため number へ正規化。 */
function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value)
}
