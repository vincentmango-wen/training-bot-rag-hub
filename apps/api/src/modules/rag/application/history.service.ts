/**
 * HistoryService — GET /rag/history（10 §6.4 / RAG-API-004）。
 *
 * read-only。requester（JWT subject）が所有する query のみ返す（所有権検証 / 10 §10.1.1
 * 「他人の履歴403」を requester_id 照合で機械化）。bot_id 指定時は requester に紐づく
 * bot のみへ絞る（IDOR 防御）。
 *
 * 1 query につき最新 response + 最新 provider_call + 最新 guardrail を結合して 1 行に畳む。
 * provider/model は rag_provider_calls（無ければ response_json.llm）から取得する。
 */
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  HistoryItem,
  HistoryQuery,
  HistoryResponseData,
  RiskLevel,
} from '@pmtp/shared'
import { PrismaService } from '../infrastructure/prisma/prisma.service'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    query: HistoryQuery
    requesterId: string
  }): Promise<HistoryResponseData> {
    const { query, requesterId } = params
    const page = Math.max(query.page ?? DEFAULT_PAGE, 1)
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

    // Major5: risk_level フィルタを where 句（responses.some）へ移す。
    // skip/take 後の 1 ページに対する後段 filter だと「ページ件数が欠ける + total がフィルタ前」で
    // pagination が破綻するため、count / findMany と同一 where に乗せて整合させる。
    //
    // history は「回答済み query の履歴」を表すため responses.some（最低 1 応答あり）を必須にする。
    // これにより toHistoryItem で response 不在時の MEDIUM/PASS/0 捏造（Minor）が構造的に消える。
    const where: Prisma.RagQueryWhereInput = {
      requesterId, // 所有権: 自分の query のみ（10 §10.1.1）。
      ...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
      ...(query.bot_id !== undefined ? { botId: query.bot_id } : {}),
      ...(query.from !== undefined || query.to !== undefined
        ? {
            createdAt: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      responses:
        query.risk_level !== undefined
          ? { some: { riskLevel: query.risk_level } }
          : { some: {} },
    }

    const total = await this.prisma.ragQuery.count({ where })
    const queries = await this.prisma.ragQuery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        createdAt: true,
        symbol: true,
        queryText: true,
        responses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            riskLevel: true,
            confidence: true,
            responseJson: true,
          },
        },
        providerCalls: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { provider: true, model: true },
        },
        guardrailResults: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    })

    const items: HistoryItem[] = queries.map((q) => this.toHistoryItem(q))

    return {
      items,
      pagination: { page, limit, total },
    }
  }

  private toHistoryItem(q: {
    id: string
    createdAt: Date
    symbol: string | null
    queryText: string
    responses: Array<{
      riskLevel: string
      confidence: Prisma.Decimal
      responseJson: Prisma.JsonValue
    }>
    providerCalls: Array<{ provider: string; model: string }>
    guardrailResults: Array<{ status: string }>
  }): HistoryItem {
    // where に responses.some を課しているため response は必ず存在する。
    // Minor: 欠損時の MEDIUM/PASS/0 捏造をやめ、欠損は欠損として扱う（理論上来ないが防御的に throw）。
    const response = q.responses[0]
    if (response === undefined) {
      throw new Error(
        `history query ${q.id} has no response despite responses.some filter`,
      )
    }
    const call = q.providerCalls[0]
    const llm = this.llmFromJson(response.responseJson)

    const item: HistoryItem = {
      query_id: q.id,
      created_at: q.createdAt.toISOString(),
      query: q.queryText,
      risk_level: response.riskLevel as RiskLevel,
      confidence: Number(response.confidence.toString()),
      provider: call?.provider ?? llm.provider,
      model: call?.model ?? llm.model,
      // guardrail は応答済み query では必ず存在する（永続トランザクションで response と同時保存）。
      // 万一不在なら捏造せず、未評価であることを 'UNKNOWN' で明示する（'PASS' に倒さない）。
      guardrail_status: q.guardrailResults[0]?.status ?? 'UNKNOWN',
    }
    if (q.symbol !== null) item.symbol = q.symbol
    return item
  }

  private llmFromJson(json: Prisma.JsonValue | undefined): {
    provider: string
    model: string
  } {
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      const llm = (json as Record<string, unknown>)['llm']
      if (llm !== null && typeof llm === 'object') {
        const rec = llm as Record<string, unknown>
        return {
          provider: typeof rec['provider'] === 'string' ? (rec['provider'] as string) : 'openai',
          model: typeof rec['model'] === 'string' ? (rec['model'] as string) : 'gpt-4o-mini',
        }
      }
    }
    return { provider: 'openai', model: 'gpt-4o-mini' }
  }
}
