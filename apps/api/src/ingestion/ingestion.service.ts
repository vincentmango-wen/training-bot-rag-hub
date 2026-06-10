import { Inject, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../modules/rag/infrastructure/prisma/prisma.service'
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../modules/rag/infrastructure/providers/embedding/embedding-provider.interface'
import { chunkItem } from './chunker'
import { validateChunkIndexContinuity } from './chunk-index-validator'
import { sha256Hex, stableHashOfJson } from './content-hash'
import { parseVectorText, upsertEmbedding } from './embedding-writer'
import { IdempotencyConflictError } from './idempotency-conflict.error'
import { normalizeText } from './normalizer'
import type {
  ChunkDraft,
  IngestionItemInput,
  IngestionItemResult,
  IngestionJobInput,
  IngestionJobResult,
} from './ingestion.types'

/**
 * Ingestion / Chunking / Embedding パイプラインのオーケストレータ。
 *
 * パイプライン段（27 §6 フロー）:
 *   1. 冪等ジョブ claim（idempotency_key + payload_hash / claim-first / 横断規約 §3）
 *   2. item ごとに: 正規化 + Secret/PII マスク（normalizer）
 *   3. Prompt Injection scan（chunker 内 / 疑い chunk は QUARANTINED）
 *   4. source_type 別 chunk 分割（chunker / 表・コード atomic / chunk_index 連続性）
 *   5. content_hash 差分判定（27 §10.1: 既存 chunk と一致なら再 Embedding スキップ）
 *   6. document / chunk 全置換保存（27 §10.3: 部分更新禁止 / 旧 chunk は deleted_at 論理削除）
 *   7. Embedding 生成（EmbeddingProvider DI / OpenAI のみ / 差分のみ）
 *   8. rag_embeddings へ vector 書き込み（embedding-writer / ::vector）
 *   9. chunk_index 連続性の完了時検証（違反は item FAILED → 文書全体再処理）
 *
 * 金融数値（横断規約 §2）: price/qty は chunk.content / metadata の string として素通し。
 * order_permission（横断規約 §5）: 本モジュールは注文系テーブルに一切触れない（取込のみ）。
 */
@Injectable()
export class IngestionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async ingest(input: IngestionJobInput): Promise<IngestionJobResult> {
    const payloadHash = this.computePayloadHash(input)

    // --- 1. 冪等 claim（claim-first / 横断規約 §3）---------------------------
    const claim = await this.claimJob(input, payloadHash)
    if (claim.replayed) {
      return this.buildReplayResult(claim.jobId)
    }
    const jobId = claim.jobId

    // --- 2〜9. item ごとに処理 ----------------------------------------------
    const itemResults: IngestionItemResult[] = []
    let successCount = 0
    let failedCount = 0

    await this.updateJobStatus(jobId, 'INDEXING', { startedAt: new Date() })

    for (const item of input.items) {
      const result = await this.processItem(input, jobId, item)
      itemResults.push(result)
      if (result.status === 'SUCCESS' || result.status === 'SKIPPED') {
        successCount += 1
      } else if (result.status === 'FAILED' || result.status === 'BLOCKED') {
        failedCount += 1
      }
    }

    const finalStatus = failedCount > 0 && successCount === 0 ? 'FAILED' : 'INDEXED'
    await this.updateJobStatus(jobId, finalStatus, {
      finishedAt: new Date(),
      totalCount: input.items.length,
      successCount,
      failedCount,
    })

    return {
      jobId,
      status: finalStatus,
      replayed: false,
      totalCount: input.items.length,
      successCount,
      failedCount,
      items: itemResults,
      traceId: input.traceId,
      requestId: input.requestId,
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 1. 冪等 claim                                                            */
  /* ------------------------------------------------------------------------ */

  private async claimJob(
    input: IngestionJobInput,
    payloadHash: string,
  ): Promise<{ jobId: string; replayed: boolean }> {
    // idempotency_key なし（UI 等）: 常に新規ジョブ（冪等性保証なし）。
    if (input.idempotencyKey === undefined) {
      const created = await this.createJob(input, null)
      return { jobId: created.id, replayed: false }
    }

    // 既存ジョブ確認（同一 source_id + idempotency_key）。
    const existing = await this.findExistingJob(input.sourceId, input.idempotencyKey)
    if (existing) {
      return this.resolveExisting(existing, input, payloadHash)
    }

    // 未登録 → claim INSERT（部分 unique がレースを物理遮断）。
    try {
      const created = await this.createJob(input, payloadHash)
      return { jobId: created.id, replayed: false }
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // 並行 claim が先着 → 再読込して replay / conflict 判定。
        const winner = await this.findExistingJob(input.sourceId, input.idempotencyKey)
        if (winner) {
          return this.resolveExisting(winner, input, payloadHash)
        }
      }
      throw err
    }
  }

  private resolveExisting(
    existing: { id: string; payloadHash: string | null },
    input: IngestionJobInput,
    payloadHash: string,
  ): { jobId: string; replayed: boolean } {
    // payload_hash 一致 → replay（再課金しない / 既存ジョブ返却）。
    if (existing.payloadHash === payloadHash) {
      return { jobId: existing.id, replayed: true }
    }
    // payload_hash 不一致 → 409（同一キーで別 payload = キー使い回しバグ）。
    throw new IdempotencyConflictError({
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey as string,
    })
  }

  private async findExistingJob(
    sourceId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; payloadHash: string | null } | null> {
    const job = await this.prisma.ragIngestionJob.findFirst({
      where: { sourceId, idempotencyKey },
      select: { id: true, payloadHash: true },
    })
    return job
  }

  private async createJob(
    input: IngestionJobInput,
    payloadHash: string | null,
  ): Promise<{ id: string }> {
    return this.prisma.ragIngestionJob.create({
      data: {
        sourceId: input.sourceId,
        jobType: input.jobType,
        status: 'PENDING',
        totalCount: input.items.length,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadHash,
        traceId: input.traceId,
        requestId: input.requestId,
      },
      select: { id: true },
    })
  }

  /* ------------------------------------------------------------------------ */
  /* 2〜9. item 処理                                                          */
  /* ------------------------------------------------------------------------ */

  private async processItem(
    input: IngestionJobInput,
    jobId: string,
    item: IngestionItemInput,
  ): Promise<IngestionItemResult> {
    // job item を先に作成（trace 連動 / 05 §5.7）。
    const rawPayload = this.toJson(item.metadata)
    const jobItem = await this.prisma.ragIngestionJobItem.create({
      data: {
        jobId,
        externalId: item.externalId ?? null,
        status: 'PENDING',
        ...(rawPayload !== undefined ? { rawPayload } : {}),
        traceId: input.traceId,
      },
      select: { id: true },
    })

    try {
      // 2. 正規化 + マスク
      const { normalized } = normalizeText(item.rawContent)
      const docContentHash = sha256Hex(normalized)

      // 3〜4. chunk 分割（injection scan + atomic + chunk_index 採番は chunker 内）
      const drafts = chunkItem({ ...item, rawContent: normalized }, input.sourceType)

      // 9.（前倒し）chunk_index 連続性検証（27 §10.3 / AC-CHUNK-012）
      const continuity = validateChunkIndexContinuity(drafts)
      if (!continuity.valid) {
        const reason = continuity.reason ?? 'chunk_index continuity violation'
        await this.markItem(jobItem.id, 'FAILED', reason)
        return this.failedItem(jobItem.id, item, reason)
      }

      // 5〜8. document / chunk 全置換 + 差分 embedding（1 文書 1 トランザクション）
      const persisted = await this.persistDocumentAndChunks(
        input,
        item,
        normalized,
        docContentHash,
        drafts,
      )

      await this.markItem(jobItem.id, 'SUCCESS', null, persisted.documentId)
      return {
        itemId: jobItem.id,
        documentId: persisted.documentId,
        externalId: item.externalId ?? null,
        status: 'SUCCESS',
        chunkCount: drafts.length,
        reusedEmbeddingCount: persisted.reusedEmbeddingCount,
        newEmbeddingCount: persisted.newEmbeddingCount,
        errorMessage: null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ingestion item failed'
      await this.markItem(jobItem.id, 'FAILED', message)
      return this.failedItem(jobItem.id, item, message)
    }
  }

  /**
   * 5〜8. document upsert（content_hash で差分）+ chunk 全置換 + 差分 embedding。
   *
   * - document: UNIQUE(source_id, content_hash)。同一 hash の文書が既存なら再利用。
   * - chunk: 27 §10.3 全置換。既存 chunk を deleted_at 論理削除 → 新 chunk を INSERT。
   *   content_hash 一致 chunk の embedding は再利用（27 §10.1/§10.2 差分）。
   */
  private async persistDocumentAndChunks(
    input: IngestionJobInput,
    item: IngestionItemInput,
    normalized: string,
    docContentHash: string,
    drafts: ChunkDraft[],
  ): Promise<{ documentId: string; reusedEmbeddingCount: number; newEmbeddingCount: number }> {
    const provider = this.embeddingProvider

    // まず差分判定のため、既存 chunk の content_hash → embedding 存在を引く。
    return this.prisma.$transaction(async (tx) => {
      // --- document upsert（content_hash 差分）-----------------------------
      const existingDoc = await tx.ragDocument.findFirst({
        where: { sourceId: input.sourceId, contentHash: docContentHash, deletedAt: null },
        select: { id: true },
      })

      let documentId: string
      if (existingDoc) {
        documentId = existingDoc.id
        await tx.ragDocument.update({
          where: { id: documentId },
          data: { status: 'INDEXED', updatedAt: new Date() },
        })
      } else {
        const doc = await tx.ragDocument.create({
          data: {
            sourceId: input.sourceId,
            externalId: item.externalId ?? null,
            documentType: this.documentTypeFor(input.sourceType),
            title: item.title ?? null,
            rawContent: item.rawContent,
            normalizedContent: normalized,
            language: item.language ?? 'ja',
            contentHash: docContentHash,
            metadata: this.toJson(item.metadata) ?? Prisma.JsonNull,
            eventTime: item.eventTime ?? null,
            status: 'INDEXED',
          },
          select: { id: true },
        })
        documentId = doc.id
      }

      // --- 既存 chunk の content_hash → ACTIVE embedding ベクトルを退避（差分判定）---
      // 27 §10.1: content_hash 一致 chunk は再 Embedding しない。全置換前に再利用可能な
      // ベクトルを pgvector リテラルとして退避しておき、新 chunk へ再付与する。
      const reusableVectors = await this.snapshotReusableEmbeddings(tx, documentId)

      // --- chunk 全置換（27 §10.3）------------------------------------------
      // 注: 05 正本は「旧 chunk を deleted_at 論理削除」だが、現行 migration の
      // UNIQUE(document_id, content_hash) は部分 unique（WHERE deleted_at IS NULL）でないため、
      // 論理削除した旧 chunk と同一 content_hash の新 chunk が unique 衝突する。
      // 全置換セマンティクスを保つため、旧 chunk・旧 embedding は **物理削除** する
      // （embedding は退避済みのため再 Embedding は発生しない）。申し送り: A1 migration が
      // 部分 unique を張れば論理削除へ戻せる。
      await tx.ragEmbedding.deleteMany({
        where: { chunk: { documentId } },
      })
      await tx.ragChunk.deleteMany({ where: { documentId } })

      let reusedEmbeddingCount = 0
      let newEmbeddingCount = 0
      const toEmbed: { chunkId: string; content: string; contentHash: string }[] = []
      const reuseInserts: { chunkId: string; contentHash: string }[] = []

      for (const draft of drafts) {
        const chunk = await tx.ragChunk.create({
          data: {
            documentId,
            sourceId: input.sourceId,
            chunkIndex: draft.chunkIndex,
            content: draft.content,
            contentHash: draft.contentHash,
            tokenCount: draft.tokenCount,
            metadata: (this.toJson(draft.metadata) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            sourceType: draft.sourceType,
            symbol: draft.symbol,
            market: draft.market,
            timeframe: draft.timeframe,
            eventTime: draft.eventTime,
            language: draft.language,
            riskTags: draft.riskTags,
            status: draft.status,
          },
          select: { id: true },
        })

        // QUARANTINED chunk は埋め込まない（検索対象外 / 27 §6）。
        if (draft.status !== 'ACTIVE') continue

        // 27 §10.1 差分: content_hash 一致 + 退避済みベクトルあり → 再利用。
        if (reusableVectors.has(draft.contentHash)) {
          reuseInserts.push({ chunkId: chunk.id, contentHash: draft.contentHash })
          reusedEmbeddingCount += 1
        } else {
          toEmbed.push({ chunkId: chunk.id, content: draft.content, contentHash: draft.contentHash })
        }
      }

      // --- 再利用ベクトルの再付与（再 Embedding なし / 27 §10.2）------------
      for (const reuse of reuseInserts) {
        const snapshot = reusableVectors.get(reuse.contentHash)
        if (!snapshot) continue
        await upsertEmbedding(tx, {
          chunkId: reuse.chunkId,
          provider: provider.provider,
          model: provider.model,
          dimension: snapshot.dimension,
          vector: snapshot.vector,
          contentHash: reuse.contentHash,
          status: 'ACTIVE',
        })
      }

      // --- 7〜8. 差分のみ Embedding 生成 + 書き込み -------------------------
      if (toEmbed.length > 0) {
        const batch = await provider.embed({ texts: toEmbed.map((t) => t.content) })
        if (batch.embeddings.length !== toEmbed.length) {
          throw new Error(
            `embedding count mismatch: expected ${toEmbed.length}, got ${batch.embeddings.length}`,
          )
        }
        for (let i = 0; i < toEmbed.length; i += 1) {
          const target = toEmbed[i]!
          const vector = batch.embeddings[i]!
          await upsertEmbedding(tx, {
            chunkId: target.chunkId,
            // provider / model は呼び出し時の EmbeddingProvider 設定を正本とする
            // （HNSW 部分 index の WHERE 述語と一致させる / batch.meta も同値）。
            provider: provider.provider,
            model: provider.model,
            dimension: batch.dimensions,
            vector,
            contentHash: target.contentHash,
            status: 'ACTIVE',
          })
          newEmbeddingCount += 1
        }
      }

      return { documentId, reusedEmbeddingCount, newEmbeddingCount }
    })
  }

  /**
   * 全置換前に、document 配下の ACTIVE embedding を content_hash → ベクトルで退避する
   * （27 §10.1: content_hash 一致 chunk は再 Embedding しないための再利用ソース）。
   *
   * vector 列は Prisma 型で読めないため `$queryRaw` でテキスト化（`embedding::text` =
   * `[1,2,3]` 形式）して number[] に復元する。複数 chunk が同一 content_hash を持つ場合は
   * 先勝ち（同一ベクトルなので任意）。
   */
  private async snapshotReusableEmbeddings(
    tx: Prisma.TransactionClient,
    documentId: string,
  ): Promise<Map<string, { vector: number[]; dimension: number }>> {
    const rows = await tx.$queryRaw<
      Array<{ content_hash: string; dimension: number; embedding_text: string }>
    >`
      SELECT e."content_hash" AS content_hash,
             e."dimension" AS dimension,
             e."embedding"::text AS embedding_text
      FROM "rag_embeddings" e
      JOIN "rag_chunks" c ON c."id" = e."chunk_id"
      WHERE c."document_id" = ${documentId}::uuid
        AND e."provider" = ${this.embeddingProvider.provider}
        AND e."model" = ${this.embeddingProvider.model}
        AND e."status" = 'ACTIVE'
    `
    const map = new Map<string, { vector: number[]; dimension: number }>()
    for (const row of rows) {
      if (map.has(row.content_hash)) continue
      map.set(row.content_hash, {
        vector: parseVectorText(row.embedding_text),
        dimension: row.dimension,
      })
    }
    return map
  }

  /* ------------------------------------------------------------------------ */
  /* ヘルパ                                                                   */
  /* ------------------------------------------------------------------------ */

  private computePayloadHash(input: IngestionJobInput): string {
    // trace_id / request_id（実行ごとに変わる）は payload に含めない。
    // 取込内容（source / items）だけを安定ハッシュする。
    return stableHashOfJson({
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      jobType: input.jobType,
      items: input.items.map((it) => ({
        externalId: it.externalId ?? null,
        title: it.title ?? null,
        rawContent: it.rawContent,
        records: it.records ?? null,
        language: it.language ?? null,
        symbol: it.symbol ?? null,
        market: it.market ?? null,
        timeframe: it.timeframe ?? null,
        eventTime: it.eventTime ? it.eventTime.toISOString() : null,
        metadata: it.metadata ?? null,
      })),
    })
  }

  private async updateJobStatus(
    jobId: string,
    status: string,
    extra: {
      startedAt?: Date
      finishedAt?: Date
      totalCount?: number
      successCount?: number
      failedCount?: number
    } = {},
  ): Promise<void> {
    await this.prisma.ragIngestionJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(extra.startedAt ? { startedAt: extra.startedAt } : {}),
        ...(extra.finishedAt ? { finishedAt: extra.finishedAt } : {}),
        ...(extra.totalCount !== undefined ? { totalCount: extra.totalCount } : {}),
        ...(extra.successCount !== undefined ? { successCount: extra.successCount } : {}),
        ...(extra.failedCount !== undefined ? { failedCount: extra.failedCount } : {}),
      },
    })
  }

  private async markItem(
    itemId: string,
    status: string,
    errorMessage: string | null,
    documentId?: string,
  ): Promise<void> {
    await this.prisma.ragIngestionJobItem.update({
      where: { id: itemId },
      data: {
        status,
        errorMessage,
        ...(documentId ? { documentId } : {}),
      },
    })
  }

  private failedItem(
    itemId: string,
    item: IngestionItemInput,
    message: string,
  ): IngestionItemResult {
    return {
      itemId,
      documentId: null,
      externalId: item.externalId ?? null,
      status: 'FAILED',
      chunkCount: 0,
      reusedEmbeddingCount: 0,
      newEmbeddingCount: 0,
      errorMessage: message,
    }
  }

  private async buildReplayResult(jobId: string): Promise<IngestionJobResult> {
    const job = await this.prisma.ragIngestionJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        id: true,
        status: true,
        totalCount: true,
        successCount: true,
        failedCount: true,
        traceId: true,
        requestId: true,
        items: {
          select: {
            id: true,
            documentId: true,
            externalId: true,
            status: true,
            errorMessage: true,
          },
        },
      },
    })
    return {
      jobId: job.id,
      status: job.status as IngestionJobResult['status'],
      replayed: true,
      totalCount: job.totalCount,
      successCount: job.successCount,
      failedCount: job.failedCount,
      items: job.items.map((it) => ({
        itemId: it.id,
        documentId: it.documentId,
        externalId: it.externalId,
        status: it.status as IngestionItemResult['status'],
        chunkCount: 0,
        reusedEmbeddingCount: 0,
        newEmbeddingCount: 0,
        errorMessage: it.errorMessage,
      })),
      traceId: job.traceId,
      requestId: job.requestId,
    }
  }

  private documentTypeFor(sourceType: string): string {
    switch (sourceType) {
      case 'strategy_doc':
        return 'strategy_rule'
      case 'bot_log':
        return 'log'
      case 'order_history':
        return 'log'
      case 'market_data':
        return 'market_snapshot'
      default:
        return 'article'
    }
  }

  private toJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined
    return value as Prisma.InputJsonValue
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    )
  }
}
