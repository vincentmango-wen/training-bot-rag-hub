/**
 * SimilarCasesService — POST /rag/similar-cases（10 §6.3 / RAG-API-003）。
 *
 * LLM 生成を伴わない **retrieval ベース**の類似ケース検索（10 §5.4 Audit=Retrieval のみ /
 * Guardrail=「類似ケースを将来保証として扱わない」= risk_notes 注記で表現）。
 *
 * 金融数値（after_move_*_pct / max_drawdown_pct / similarity）の扱い（横断規約 §2）:
 *   - *_pct は chunk.metadata の string をそのまま透過。number 化しない。
 *   - 欠落・不正は黙って "0" にせず null を返し、欠落であることを risk_notes に明示する
 *     （Minor: 欠落の 0 偽装をやめる / moneyStringSchema は必須のため "0" 透過時は注記で補う）。
 *   - similarity はスコア値のため number（10 §6.3 注記）。
 *
 * 冪等性（Major3: 規約3違反の是正）:
 *   本 API は POST だが「副作用なし」ではない（rag_queries INSERT + retrieval スナップショット +
 *   OpenAI embedding 課金が毎回発生）。query / bot-context と同じ claim-first 冪等を適用し、
 *   同一 Idempotency-Key + 同一 payload の再送は replay（再課金なし）/ 別 payload は 409。
 *   replay 時は永続済みの retrieval スナップショット（rag_retrieval_results + chunk.metadata）から
 *   cases[] を決定的に再構成する（case_id も retrieval_result_id+chunk_id 由来の決定的 UUID）。
 */
import { Injectable } from '@nestjs/common'
import type { MoneyString, SimilarCase, SimilarCasesRequest } from '@pmtp/shared'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../infrastructure/prisma/prisma.service'
import { ProviderRouter } from '../infrastructure/providers/routing/provider-router'
import { RetrievalService } from '../../../retrieval/retrieval.service'
import type { RetrievalFilters } from '../../../retrieval/retrieval.types'
import { RagApiException } from '../http/rag-api.exception'
import { stableHashOfJson } from '../../../ingestion/content-hash'
import { claimIdempotentQuery } from './idempotent-query-claim'
import { deterministicUuid } from './deterministic-id'

const MONEY_ZERO: MoneyString = '0'
const DEFAULT_LIMIT = 10
const MISSING_NOTE_PREFIX = 'Outcome metric unavailable in source metadata: '

export interface SimilarCasesResult {
  cases: SimilarCase[]
  /** 同一 Idempotency-Key + payload の再送（再課金なし）。controller の meta に転記する。 */
  replayed: boolean
}

@Injectable()
export class SimilarCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly router: ProviderRouter,
    private readonly retrieval: RetrievalService,
  ) {}

  async findSimilarCases(params: {
    request: SimilarCasesRequest
    requesterId: string
    idempotencyKey: string
    trace: { trace_id: string; request_id: string }
  }): Promise<SimilarCasesResult> {
    const { request, requesterId, idempotencyKey, trace } = params
    const payloadHash = stableHashOfJson({ kind: 'similar-cases', request })

    // --- 1. claim-first 冪等（query / bot-context と同一規律 / Major3）---
    const claim = await claimIdempotentQuery(this.prisma, {
      requesterId,
      idempotencyKey,
      payloadHash,
      queryType: 'similar_case',
      queryText: this.pseudoQuery(request),
      ...(request.symbol !== undefined ? { symbol: request.symbol } : {}),
      ...(request.market !== undefined ? { market: request.market } : {}),
      ...(request.timeframe !== undefined ? { timeframe: request.timeframe } : {}),
      sourceTypes: [],
      filters: this.filters(request) as Prisma.InputJsonValue,
      ...(request.features !== undefined
        ? { features: request.features as Prisma.InputJsonValue }
        : {}),
      providerPolicy: 'default',
      trace,
    })

    if (claim.replayed) {
      // RETURNED のみ replay。retrieval 中（in-flight）/ 失敗は明示挙動へ（C2 と同型）。
      if (claim.status === 'RETURNED') {
        const cases = await this.rebuildCases(claim.queryId, request)
        return { cases, replayed: true }
      }
      if (claim.status === 'FAILED') {
        throw RagApiException.internal(
          `Previous similar-cases request for this Idempotency-Key failed (query ${claim.queryId}). Retry with the same Idempotency-Key.`,
        )
      }
      // RECEIVED / RETRIEVED 等 = in-flight。
      throw RagApiException.idempotencyConflict(
        'Same Idempotency-Key is already being processed (in-flight). Retry after it completes.',
      )
    }

    const queryId = claim.queryId
    try {
      const embedResult = await this.router.embed([this.pseudoQuery(request)], trace)
      const embedding = embedResult.embeddings[0] ?? []

      const limit = request.limit ?? DEFAULT_LIMIT
      const retrieved = await this.retrieval.retrieve({
        queryId,
        embedding,
        topK: limit,
        filters: this.retrievalFilters(request),
      })
      await this.prisma.ragQuery.update({
        where: { id: queryId },
        data: { status: 'RETRIEVED' },
      })

      const matchedFeatures = request.features ? Object.keys(request.features) : []

      // retrieval スナップショット（rag_retrieval_results）から retrieval_result_id を引いて
      // case_id を決定的にする（replay 時に同一 ID を再現するため）。
      const retrievalRows = await this.prisma.ragRetrievalResult.findMany({
        where: { queryId, chunkId: { in: retrieved.chunks.map((c) => c.chunkId) } },
        select: { id: true, chunkId: true },
      })
      const retrievalIdByChunk = new Map(
        retrievalRows.map((r) => [r.chunkId, r.id] as const),
      )

      const cases: SimilarCase[] = retrieved.chunks.map((chunk) => {
        const meta = asRecord(chunk.metadata)
        const period = this.derivePeriod(meta)
        const retrievalResultId = retrievalIdByChunk.get(chunk.chunkId) ?? chunk.chunkId
        return this.buildCase({
          retrievalResultId,
          chunkId: chunk.chunkId,
          symbol: request.symbol ?? readString(meta, 'symbol') ?? 'UNKNOWN',
          period,
          similarity: chunk.similarityScore,
          matchedFeatures,
          meta,
        })
      })

      await this.prisma.ragQuery.update({
        where: { id: queryId },
        data: { status: 'RETURNED' },
      })

      return { cases, replayed: false }
    } catch (err) {
      await this.markFailed(queryId)
      throw err
    }
  }

  /**
   * replay: 永続済みの retrieval スナップショット + chunk.metadata から cases[] を決定的に再構成。
   * request は payload_hash 一致が保証済みのため matched_features 等は初回と同値になる。
   */
  private async rebuildCases(
    queryId: string,
    request: SimilarCasesRequest,
  ): Promise<SimilarCase[]> {
    const rows = await this.prisma.ragRetrievalResult.findMany({
      where: { queryId },
      orderBy: { rankOrder: 'asc' },
      select: {
        id: true,
        chunkId: true,
        similarityScore: true,
        chunk: { select: { metadata: true } },
      },
    })
    const matchedFeatures = request.features ? Object.keys(request.features) : []

    return rows.map((row) => {
      const meta = asRecord(row.chunk.metadata)
      const period = this.derivePeriod(meta)
      return this.buildCase({
        retrievalResultId: row.id,
        chunkId: row.chunkId,
        symbol: request.symbol ?? readString(meta, 'symbol') ?? 'UNKNOWN',
        period,
        similarity: row.similarityScore ? Number(row.similarityScore) : 0,
        matchedFeatures,
        meta,
      })
    })
  }

  /** 1 件の SimilarCase を組む（live / replay 共通 / case_id は決定的）。 */
  private buildCase(args: {
    retrievalResultId: string
    chunkId: string
    symbol: string
    period: { from: string; to: string }
    similarity: number
    matchedFeatures: string[]
    meta: Record<string, unknown>
  }): SimilarCase {
    const move4h = readMoneyOrNull(args.meta, 'after_move_4h_pct')
    const move24h = readMoneyOrNull(args.meta, 'after_move_24h_pct')
    const drawdown = readMoneyOrNull(args.meta, 'max_drawdown_pct')

    const riskNotes = [
      'Historical similarity does not guarantee future performance.',
    ]
    // 欠落を黙って "0" 偽装にせず、欠落である事実を risk_notes に明示する（Minor）。
    const missing: string[] = []
    if (move4h === null) missing.push('after_move_4h_pct')
    if (move24h === null) missing.push('after_move_24h_pct')
    if (drawdown === null) missing.push('max_drawdown_pct')
    if (missing.length > 0) {
      riskNotes.push(`${MISSING_NOTE_PREFIX}${missing.join(', ')}.`)
    }

    return {
      // case_id は retrieval_result_id + chunk_id 由来の決定的 UUID（Minor: randomUUID 非決定の是正）。
      case_id: deterministicUuid(`${args.retrievalResultId}:${args.chunkId}`),
      symbol: args.symbol,
      period_from: args.period.from,
      period_to: args.period.to,
      similarity: args.similarity,
      matched_features: args.matchedFeatures,
      after_move_4h_pct: move4h ?? MONEY_ZERO,
      after_move_24h_pct: move24h ?? MONEY_ZERO,
      max_drawdown_pct: drawdown ?? MONEY_ZERO,
      risk_notes: riskNotes,
    }
  }

  private async markFailed(queryId: string): Promise<void> {
    try {
      await this.prisma.ragQuery.update({
        where: { id: queryId },
        data: { status: 'FAILED' },
      })
    } catch {
      // status 更新の失敗は元エラーを優先するため握り潰す。
    }
  }

  private pseudoQuery(request: SimilarCasesRequest): string {
    const head = [
      request.symbol ? `${request.symbol}` : 'market',
      request.timeframe ? `${request.timeframe}` : '',
      'similar historical cases',
    ]
      .filter((s) => s.length > 0)
      .join(' ')
    const features = request.features
      ? ` features=${JSON.stringify(request.features)}`
      : ''
    return `${head}.${features}`
  }

  private filters(request: SimilarCasesRequest): Record<string, unknown> {
    return {
      symbol: request.symbol ?? null,
      market: request.market ?? null,
      timeframe: request.timeframe ?? null,
      lookback_days: request.lookback_days ?? null,
      limit: request.limit ?? null,
    }
  }

  private retrievalFilters(request: SimilarCasesRequest): RetrievalFilters {
    const filters: RetrievalFilters = {}
    if (request.symbol !== undefined) filters.symbol = request.symbol
    if (request.timeframe !== undefined) filters.timeframe = request.timeframe
    if (request.lookback_days !== undefined) {
      const from = new Date()
      from.setDate(from.getDate() - request.lookback_days)
      filters.eventTimeFrom = from
    }
    return filters
  }

  private derivePeriod(meta: Record<string, unknown>): { from: string; to: string } {
    const from = readString(meta, 'period_from') ?? readString(meta, 'event_time')
    const to = readString(meta, 'period_to') ?? from
    const now = new Date().toISOString()
    return { from: from ?? now, to: to ?? now }
  }

  /** lookback / limit が異常値なら検証エラー（10 §5.4 異常系 features空 等）。 */
  assertValid(request: SimilarCasesRequest): void {
    if (request.limit !== undefined && request.limit > 100) {
      throw RagApiException.validation('limit must be <= 100', [
        { field: 'limit', code: 'OUT_OF_RANGE', message: 'limit must be <= 100' },
      ])
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function readString(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * 金融数値は string で透過。欠落・不正（number/undefined/非数値文字列）は **null** を返す
 * （横断規約 §2 / number 化しない。Minor: 欠落の "0" 偽装をやめ、欠落を呼出側で明示させる）。
 */
function readMoneyOrNull(
  meta: Record<string, unknown>,
  key: string,
): MoneyString | null {
  const v = meta[key]
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return v
  return null
}
