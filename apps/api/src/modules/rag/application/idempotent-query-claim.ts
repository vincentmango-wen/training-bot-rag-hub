/**
 * 冪等 claim-first の共有 helper（横断規約 §3 / B1）。
 *
 * rag_queries を (requester_id, idempotency_key) 部分 unique でレース物理遮断しつつ claim する
 * 共通ロジック。orchestrator（query / bot-context）と similar-cases が **同一の claim 規律**を
 * 使うために抽出（Major3 / 重複実装の排除）。
 *
 * 契約:
 *   - 既存行あり + payload_hash 一致 = replay（再課金なし / status を返す）
 *   - 既存行あり + payload_hash 不一致 = 409 RAG_IDEMPOTENCY_CONFLICT
 *   - 既存行なし = create（部分 unique のレースは P2002 を捕捉して再読込）
 *
 * status による replay 振り分け（RETURNED 即 replay / in-flight 409 / FAILED 500 / BLOCKED 422）は
 * 呼び出し側の責務（C2）。本 helper は claim 行の存在判定と payload 一致のみを担保する。
 */
import { Prisma } from '@prisma/client'
import type { PrismaService } from './../infrastructure/prisma/prisma.service'
import { RagApiException } from '../http/rag-api.exception'

export interface QueryClaimData {
  requesterId: string
  idempotencyKey: string
  payloadHash: string
  queryType: string
  queryText: string
  symbol?: string | undefined
  market?: string | undefined
  timeframe?: string | undefined
  sourceTypes: string[]
  filters: Prisma.InputJsonValue
  features?: Prisma.InputJsonValue | undefined
  botId?: string | undefined
  strategyId?: string | undefined
  providerPolicy: string
  trace: { trace_id: string; request_id: string }
}

export interface QueryClaimResult {
  queryId: string
  replayed: boolean
  /** 既存行の rag_queries.status（replay 時の挙動振り分け用 / C2）。新規 claim では undefined。 */
  status?: string
}

/**
 * (requester_id, idempotency_key) スコープで claim-first する。
 *
 * Idempotency-Key が空文字（= read-only API で guard が必須化していない経路）の場合は
 * claim をスキップし、呼び出し側が必ず新規 query を作る前提（呼び出し側で空チェック済み）。
 */
export async function claimIdempotentQuery(
  prisma: PrismaService,
  data: QueryClaimData,
): Promise<QueryClaimResult> {
  const existing = await prisma.ragQuery.findFirst({
    where: {
      requesterId: data.requesterId,
      idempotencyKey: data.idempotencyKey,
    },
  })
  if (existing) {
    assertPayloadMatches(existing.payloadHash, data.payloadHash)
    return { queryId: existing.id, replayed: true, status: existing.status }
  }

  try {
    const created = await prisma.ragQuery.create({
      data: {
        requesterId: data.requesterId,
        idempotencyKey: data.idempotencyKey,
        payloadHash: data.payloadHash,
        queryType: data.queryType,
        queryText: data.queryText,
        ...(data.symbol !== undefined ? { symbol: data.symbol } : {}),
        ...(data.market !== undefined ? { market: data.market } : {}),
        ...(data.timeframe !== undefined ? { timeframe: data.timeframe } : {}),
        sourceTypes: data.sourceTypes,
        filters: data.filters,
        ...(data.features !== undefined ? { features: data.features } : {}),
        ...(data.botId !== undefined ? { botId: data.botId } : {}),
        ...(data.strategyId !== undefined ? { strategyId: data.strategyId } : {}),
        providerPolicy: data.providerPolicy,
        status: 'RECEIVED',
        traceId: data.trace.trace_id,
        requestId: data.trace.request_id,
      },
    })
    return { queryId: created.id, replayed: false }
  } catch (err) {
    // 部分 unique のレース: 別 HTTP 実行が先に claim 済み → 再読込して replay/409。
    if (isUniqueViolation(err)) {
      const raced = await prisma.ragQuery.findFirst({
        where: {
          requesterId: data.requesterId,
          idempotencyKey: data.idempotencyKey,
        },
      })
      if (raced) {
        assertPayloadMatches(raced.payloadHash, data.payloadHash)
        return { queryId: raced.id, replayed: true, status: raced.status }
      }
    }
    throw err
  }
}

function assertPayloadMatches(stored: string | null, incoming: string): void {
  if (stored !== incoming) {
    throw RagApiException.idempotencyConflict(
      'Same Idempotency-Key reused with a different payload.',
    )
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  )
}
