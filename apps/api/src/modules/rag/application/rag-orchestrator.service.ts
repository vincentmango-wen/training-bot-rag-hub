/**
 * RagOrchestrator — RAG 1 問い合わせの全工程を束ねる service（10 §6.1 / §6.2 / B1・B2・B4）。
 *
 * フロー（query / bot-context 共通）:
 *   1. payload_hash 算出 → 冪等 claim-first（横断規約 §3 / B1）
 *        - 既存 (requester_id, idempotency_key) + payload_hash 一致 = replay（再課金なし / 200）
 *        - 既存だが payload_hash 不一致 = 409 RAG_IDEMPOTENCY_CONFLICT
 *        - 未登録 = rag_queries に claim INSERT（部分 unique がレース物理遮断）
 *   2. query embedding 生成（ProviderRouter.embed / OpenAI のみ / 16・24）
 *   3. retrieval（RetrievalService / HNSW + 合成スコア + rag_retrieval_results 永続）
 *   4. Guardrail 入力前処理（secret masking + injection 隔離）→ prompt 組み立て
 *   5. LLM structured output（ProviderRouter.generateStructured / schema 強制）
 *   6. Guardrail 出力検証（order_permission 固定 + citation whitelist/quality / B2）
 *        - citation 全除去 = 422 RAG_GUARDRAIL_BLOCKED
 *   7. 永続（rag_responses / rag_citations / rag_guardrail_results / bot-context は rag_bot_contexts）
 *   8. API citation を audience で出し分けて返却（10 §6.1）
 *
 * order_permission（横断規約 §5）: 出力は常に literal false（Guardrail が二次防御で固定）。
 * 金融数値（横断規約 §2）: estimated_cost / *_pct は string のまま扱う。
 */
import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  BotContextResponseData,
  Citation,
  CitationQualityStatus,
  GuardrailResult as ApiGuardrailResult,
  LlmUsage,
  QueryResponseData,
  QueryStatus,
  QueryType,
  RiskLevel,
  SourceType as SourceTypeValue,
  ClientType as ClientTypeValue,
} from '@pmtp/shared'
import { PrismaService } from '../infrastructure/prisma/prisma.service'
import { ProviderRouter } from '../infrastructure/providers/routing/provider-router'
import type { ProviderCallMeta } from '../infrastructure/providers/provider.types'
import { RetrievalService } from '../../../retrieval/retrieval.service'
import type {
  RetrievalFilters,
  RetrievedChunk,
} from '../../../retrieval/retrieval.types'
import {
  GuardrailService,
  type ValidateOutputResult,
} from '../../../guardrail/guardrail.service'
import { stableHashOfJson } from '../../../ingestion/content-hash'
import { RagApiException } from '../http/rag-api.exception'
import { claimIdempotentQuery } from './idempotent-query-claim'
import {
  buildCitations,
  type CitationContext,
} from './citation.serializer'
import {
  buildMessages,
  TASK_PROMPT_BOT_EXPLANATION,
  TASK_PROMPT_MARKET_CONTEXT,
} from './prompt-builder'
import {
  llmBotContextOutputSchema,
  llmQueryOutputSchema,
  type LlmCitation,
} from './llm-output.schema'
import type {
  RunBotContextInput,
  RunBotContextResult,
  RunQueryInput,
  RunQueryResult,
} from './rag-orchestrator.types'

const EXCERPT_MAX = 300

@Injectable()
export class RagOrchestrator {
  private readonly logger = new Logger(RagOrchestrator.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: ProviderRouter,
    private readonly retrieval: RetrievalService,
    private readonly guardrail: GuardrailService,
  ) {}

  /* ====================================================================== */
  /* POST /rag/query                                                        */
  /* ====================================================================== */
  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { request, trace, idempotencyKey, requesterId, audience } = input
    const payloadHash = stableHashOfJson({ kind: 'query', request })

    // --- 1. 冪等 claim ---
    const claim = await this.claimQuery({
      requesterId,
      idempotencyKey,
      payloadHash,
      queryType: 'market_context',
      queryText: request.query,
      symbol: request.symbol,
      market: request.market,
      timeframe: request.timeframe,
      sourceTypes: request.source_types ?? [],
      filters: this.queryFilters(request),
      providerPolicy: request.provider_policy ?? 'default',
      trace,
    })
    if (claim.replayed) {
      // C2: status ゲート。RETURNED のみ即 replay。それ以外（in-flight / FAILED / BLOCKED）は
      // 「行が存在するから replay」ではなく status に応じた明示挙動へ振り分ける。
      this.assertReplayable(claim.status, claim.queryId)
      const data = await this.rebuildQueryData(claim.queryId, trace, audience)
      return { data, replayed: true }
    }
    const queryId = claim.queryId

    let pipeline: Awaited<ReturnType<typeof this.runGenerationPipeline>>
    try {
      // --- 2〜6. 検索 → LLM → Guardrail ---
      pipeline = await this.runGenerationPipeline({
        queryId,
        queryText: request.query,
        language: request.language,
        topK: request.top_k,
        sourceTypes: request.source_types,
        symbol: request.symbol,
        timeframe: request.timeframe,
        from: request.from,
        to: request.to,
        taskPrompt: TASK_PROMPT_MARKET_CONTEXT,
        llmSchema: llmQueryOutputSchema,
        schemaName: 'rag_market_context_output',
        taskType: 'MARKET_SUMMARY',
        audience,
        trace,
      })

      // --- 7. 永続（Major6: response/citations/guardrail/status を 1 トランザクションで原子化）---
      const summaryText = pipeline.output.summary ?? ''
      await this.prisma.$transaction(async (tx) => {
        const responseId = await this.persistResponse(tx, {
          queryId,
          summary: summaryText,
          supportingFactors: pipeline.output.supporting_factors,
          opposingFactors: pipeline.output.opposing_factors,
          similarCases: undefined,
          riskLevel: pipeline.output.risk_level,
          confidence: pipeline.output.confidence,
          responseJson: { ...pipeline.output, llm: pipeline.llm },
        })
        // C1: queryId スコープで citation の retrieval_result を解決する（複合 FK 素通り防止）。
        await this.persistCitations(
          tx,
          queryId,
          responseId,
          pipeline.citations,
          pipeline.citationContexts,
        )
        await this.persistGuardrailResult(tx, queryId, responseId, pipeline.guardrail)
        await this.updateQueryStatus(tx, queryId, 'RETURNED')
      })
    } catch (err) {
      // BLOCKED は pipeline 内で status 設定済み（意図的 terminal）→ 上書きしない。
      // それ以外（embedding/LLM/永続の一過性障害）は FAILED に倒し C2 の再送契約に乗せる。
      if (!(err instanceof RagApiException && err.code === 'RAG_GUARDRAIL_BLOCKED')) {
        await this.markFailed(queryId)
      }
      throw err
    }

    const summary = pipeline.output.summary ?? ''

    // --- 8. 返却 data ---
    const data: QueryResponseData = {
      query_id: queryId,
      trace_id: trace.trace_id,
      summary,
      supporting_factors: pipeline.output.supporting_factors,
      opposing_factors: pipeline.output.opposing_factors,
      risk_level: pipeline.output.risk_level,
      confidence: pipeline.output.confidence,
      citations: pipeline.citations,
      llm: pipeline.llm,
      guardrail: this.toApiGuardrail(pipeline.guardrail),
    }
    return { data, replayed: false }
  }

  /* ====================================================================== */
  /* POST /rag/bot-context                                                  */
  /* ====================================================================== */
  async runBotContext(input: RunBotContextInput): Promise<RunBotContextResult> {
    const { request, trace, idempotencyKey, requesterId, audience } = input
    const payloadHash = stableHashOfJson({ kind: 'bot-context', request })

    // --- 1. 冪等 claim（query 行 + bot_context 行は同一 idempotency スコープを共有）---
    const claim = await this.claimQuery({
      requesterId,
      idempotencyKey,
      payloadHash,
      queryType: 'bot_signal_explanation',
      queryText: this.botSignalPseudoQuery(request),
      symbol: request.symbol,
      market: request.market,
      timeframe: request.timeframe,
      sourceTypes: [],
      filters: this.botContextFilters(request),
      features: request.features as Prisma.InputJsonValue | undefined,
      botId: request.bot_id,
      strategyId: request.strategy_id,
      providerPolicy: request.provider_policy ?? 'default',
      trace,
    })
    if (claim.replayed) {
      // C2: status ゲート（query と共通スコープ）。RETURNED のみ即 replay。
      this.assertReplayable(claim.status, claim.queryId)
      const data = await this.rebuildBotContextData(claim.queryId, trace)
      return { data, replayed: true }
    }
    const queryId = claim.queryId

    try {
      // --- 2〜6. 検索 → LLM → Guardrail ---
      const pipeline = await this.runGenerationPipeline({
        queryId,
        queryText: this.botSignalPseudoQuery(request),
        language: undefined,
        topK: undefined,
        sourceTypes: undefined,
        symbol: request.symbol,
        timeframe: request.timeframe,
        from: undefined,
        to: undefined,
        taskPrompt: TASK_PROMPT_BOT_EXPLANATION,
        llmSchema: llmBotContextOutputSchema,
        schemaName: 'rag_bot_explanation_output',
        taskType: 'BOT_EXPLANATION',
        audience,
        trace,
      })

      // --- 7. 永続（Major6: response/citations/guardrail/bot_context/status を 1 トランザクションで原子化）---
      const explanation = pipeline.output.explanation ?? ''

      const botContextData: BotContextResponseData = {
        context_id: '', // 後で埋める
        trace_id: trace.trace_id,
        bot_id: request.bot_id,
        bot_signal: request.bot_signal,
        explanation,
        supporting_factors: pipeline.output.supporting_factors,
        opposing_factors: pipeline.output.opposing_factors,
        similar_cases: [],
        risk_level: pipeline.output.risk_level,
        confidence: pipeline.output.confidence,
        // 常に literal false（Guardrail 二次防御 / 横断規約5）。LLM 出力値は読まない。
        order_permission: false,
        action_policy: 'ORDER_NOT_ALLOWED_BY_RAG',
        llm: pipeline.llm,
      }
      if (request.strategy_id !== undefined) botContextData.strategy_id = request.strategy_id
      if (request.symbol !== undefined) botContextData.symbol = request.symbol

      const contextId = await this.prisma.$transaction(async (tx) => {
        const responseId = await this.persistResponse(tx, {
          queryId,
          summary: explanation,
          supportingFactors: pipeline.output.supporting_factors,
          opposingFactors: pipeline.output.opposing_factors,
          similarCases: undefined,
          riskLevel: pipeline.output.risk_level,
          confidence: pipeline.output.confidence,
          responseJson: { ...pipeline.output, llm: pipeline.llm },
        })
        // C1: queryId スコープで citation の retrieval_result を解決する。
        await this.persistCitations(
          tx,
          queryId,
          responseId,
          pipeline.citations,
          pipeline.citationContexts,
        )
        await this.persistGuardrailResult(tx, queryId, responseId, pipeline.guardrail)

        // contextJson は context_id 埋め込み前のスナップショット。replay 時に context_id /
        // trace_id を上書きするため、ここで context_id を含めなくても契約は満たす。
        const newContextId = await this.persistBotContext(tx, {
          requesterId,
          idempotencyKey,
          payloadHash,
          queryId,
          responseId,
          request,
          contextJson: botContextData,
        })
        await this.updateQueryStatus(tx, queryId, 'RETURNED')
        return newContextId
      })
      botContextData.context_id = contextId

      return { data: botContextData, replayed: false }
    } catch (err) {
      // C2: BLOCKED は pipeline 内 terminal 設定済み。それ以外は FAILED に倒す。
      if (!(err instanceof RagApiException && err.code === 'RAG_GUARDRAIL_BLOCKED')) {
        await this.markFailed(queryId)
      }
      throw err
    }
  }

  /* ====================================================================== */
  /* 共通生成パイプライン（検索 → LLM → Guardrail）                          */
  /* ====================================================================== */
  private async runGenerationPipeline(args: {
    queryId: string
    queryText: string
    language?: string | undefined
    topK?: number | undefined
    sourceTypes?: readonly string[] | undefined
    symbol?: string | undefined
    timeframe?: string | undefined
    from?: string | undefined
    to?: string | undefined
    taskPrompt: string
    llmSchema: typeof llmQueryOutputSchema | typeof llmBotContextOutputSchema
    schemaName: string
    taskType: 'MARKET_SUMMARY' | 'BOT_EXPLANATION'
    audience: ClientTypeValue
    trace: { trace_id: string; request_id: string }
  }): Promise<{
    output: {
      summary?: string
      explanation?: string
      supporting_factors: string[]
      opposing_factors: string[]
      risk_level: RiskLevel
      confidence: number
      citations: LlmCitation[]
    } & Record<string, unknown>
    citations: Citation[]
    citationContexts: Map<string, CitationContext>
    guardrail: ValidateOutputResult['guardrail']
    llm: LlmUsage
  }> {
    // 進捗ステータス更新は段階的可視性が必要なため非トランザクション（Major6 の原子化対象外）。
    await this.updateQueryStatus(this.prisma, args.queryId, 'VALIDATED')

    // 2. query embedding（Provider 層 / OpenAI のみ）。
    const embedResult = await this.router.embed([args.queryText], {
      trace_id: args.trace.trace_id,
      request_id: args.trace.request_id,
    })
    const queryEmbedding = embedResult.embeddings[0] ?? []

    // 3. retrieval。
    const retrieved = await this.retrieval.retrieve({
      queryId: args.queryId,
      embedding: queryEmbedding,
      ...(args.topK !== undefined ? { topK: args.topK } : {}),
      filters: this.buildRetrievalFilters(args),
    })
    await this.updateQueryStatus(this.prisma, args.queryId, 'RETRIEVED')

    // citation 補完用の chunk メタを DB から読む（whitelist の DB 真値 quality_status 込み）。
    const citationContexts = await this.loadCitationContexts(retrieved.chunks)

    // 4. Guardrail 入力前処理（secret masking + injection 隔離）→ prompt。
    const prep = this.guardrail.prepareRetrievedDocuments(
      retrieved.chunks.map((c) => ({
        id: `${c.chunkId}`,
        content: `chunk_id=${c.chunkId}\n${c.content}`,
      })),
    )
    const messages = buildMessages({
      taskPrompt: args.taskPrompt,
      isolatedContext: prep.isolatedPrompt,
      userQuery: args.queryText,
      ...(args.language !== undefined ? { language: args.language } : {}),
    })

    // 5. LLM structured output。
    const llmResult = await this.router.generateStructured(
      args.taskType,
      { messages, schema: args.llmSchema, schemaName: args.schemaName },
      { trace_id: args.trace.trace_id, request_id: args.trace.request_id },
    )
    await this.updateQueryStatus(this.prisma, args.queryId, 'GENERATED')
    const output = llmResult.data as {
      summary?: string
      explanation?: string
      supporting_factors: string[]
      opposing_factors: string[]
      risk_level: RiskLevel
      confidence: number
      citations: LlmCitation[]
    } & Record<string, unknown>

    // 6. Guardrail 出力検証（order_permission 固定 + citation whitelist/quality）。
    const retrievalRefs = [...citationContexts.values()].map((ctx) => ({
      chunk_id: ctx.chunkId,
      quality_status: ctx.qualityStatus,
    }))
    const validated = this.guardrail.validateOutput<LlmCitation>({
      claimedOrderPermission: (output as { order_permission?: unknown }).order_permission,
      citations: output.citations,
      retrievalResults: retrievalRefs,
    })
    await this.updateQueryStatus(this.prisma, args.queryId, 'VALIDATED_OUTPUT')

    // citation 全除去 = 根拠なし回答 → 422（10 §6.1 / 04 NFR-LLM-006）。
    if (validated.citationFilter.block) {
      await this.persistGuardrailResult(this.prisma, args.queryId, undefined, validated.guardrail)
      await this.updateQueryStatus(this.prisma, args.queryId, 'BLOCKED')
      throw RagApiException.guardrailBlocked(
        'No grounded citations remain after whitelist/quality filtering.',
        validated.guardrail.blocked_reasons,
      )
    }

    // citation を API 形へ。excerpt は audience で出し分け（10 §6.1 / ui のみフル）。
    const citations = buildCitations(
      validated.allowedCitations.map((c) => ({
        chunk_id: c.chunk_id,
        used_reason: c.used_reason,
      })),
      citationContexts,
      args.audience,
    )

    return {
      output,
      citations,
      citationContexts,
      guardrail: validated.guardrail,
      llm: this.toLlmUsage(llmResult.meta),
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 冪等 claim（rag_queries）                                               */
  /* ---------------------------------------------------------------------- */
  private async claimQuery(params: {
    requesterId: string
    idempotencyKey: string
    payloadHash: string
    queryType: QueryType
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
  }): Promise<{ queryId: string; replayed: boolean; status?: string }> {
    // claim-first 共通 helper に委譲（Major3 で similar-cases と共有）。
    return claimIdempotentQuery(this.prisma, params)
  }

  /**
   * C2: replay status ゲート。
   *
   * 初回実行が LLM/embedding 障害・in-flight・guardrail BLOCK だった場合、response 行が無い /
   * 不完全なため、「行が存在する＝replay」とすると rebuild* が恒久 500 化する。status で分岐する:
   *
   * - RETURNED            : 完了済み → 即 replay（rebuild が成立する唯一の状態）
   * - in-flight（RECEIVED..VALIDATED_OUTPUT/SAVED）
   *                       : 別 HTTP 実行が処理中 → 409 RAG_IDEMPOTENCY_CONFLICT（リトライ不可。
   *                         クライアントは Retry-After 系ではなく「処理中なので待つ」を意図するが、
   *                         本契約には専用コードが無いため 409 で「同一キーが別状態」を表現する）。
   * - BLOCKED             : 初回が guardrail BLOCK → 同一入力の再送は同一結果（10 §4 / 422 は
   *                         「BLOCK をリスクなしと解釈しない」契約）。422 を再現する。
   * - FAILED              : 初回が一過性障害で未完 → 500 RAG_INTERNAL_ERROR を再現し、
   *                         「同一 Idempotency-Key で 1 回まで再送可」（10 §4.1）の契約に委ねる。
   *                         claim 行は残すため、再送はこの分岐を再度通る（自動再実行はしない=
   *                         二重課金リスク回避 / lease 再取得は別チケット）。
   *
   * 設計判断の理由: rag_responses が無い状態を replay として返さないことが C2 の核心。
   * in-flight を 409 にするのは「同一キーで状態が違う」= payload 競合と同じく「不可」カテゴリ
   * （10 §4.1 リトライ不可エラー）に属するため。FAILED は本契約で 500 が 1 回再送可のため再現に倒す。
   */
  private assertReplayable(status: string | undefined, queryId: string): void {
    if (status === 'RETURNED') return

    if (status === 'BLOCKED') {
      throw RagApiException.guardrailBlocked(
        'Previous request for this Idempotency-Key was blocked by guardrail.',
        ['Original guardrail block is reproduced for the same Idempotency-Key.'],
      )
    }
    if (status === 'FAILED') {
      throw RagApiException.internal(
        `Previous request for this Idempotency-Key failed (query ${queryId}). Retry with the same Idempotency-Key.`,
      )
    }
    // RECEIVED / VALIDATED / RETRIEVED / GENERATED / VALIDATED_OUTPUT / SAVED = in-flight。
    throw RagApiException.idempotencyConflict(
      'Same Idempotency-Key is already being processed (in-flight). Retry after the in-flight request completes.',
    )
  }

  /**
   * C2 補完: pipeline / 永続が一過性障害で落ちたとき query を FAILED に倒す。
   *
   * これにより、同一 Idempotency-Key 再送時に assertReplayable が in-flight ではなく FAILED 分岐に
   * 入り、500 を再現して「同一キーで 1 回再送可」（10 §4.1）の契約に乗せられる。BLOCKED 等の
   * 意図的な terminal 状態（既に status 設定済み）は上書きしないよう、best-effort で握り潰す。
   */
  private async markFailed(queryId: string): Promise<void> {
    try {
      await this.updateQueryStatus(this.prisma, queryId, 'FAILED')
    } catch {
      // status 更新自体の失敗は元エラーを優先するため握り潰す（in-flight のまま残る）。
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 永続ヘルパ                                                              */
  /* ---------------------------------------------------------------------- */
  private async persistResponse(
    tx: PrismaTx,
    params: {
    queryId: string
    summary: string
    supportingFactors: string[]
    opposingFactors: string[]
    similarCases: unknown[] | undefined
    riskLevel: RiskLevel
    confidence: number
    responseJson: Record<string, unknown>
    },
  ): Promise<string> {
    const created = await tx.ragResponse.create({
      data: {
        queryId: params.queryId,
        summary: params.summary,
        responseJson: params.responseJson as Prisma.InputJsonValue,
        supportingFactors: params.supportingFactors as Prisma.InputJsonValue,
        opposingFactors: params.opposingFactors as Prisma.InputJsonValue,
        ...(params.similarCases !== undefined
          ? { similarCases: params.similarCases as Prisma.InputJsonValue }
          : {}),
        riskLevel: params.riskLevel,
        confidence: new Prisma.Decimal(params.confidence),
        orderPermission: false, // 常に false（CHECK は raw migration / 横断規約5）。
        status: 'RETURNED',
      },
    })
    return created.id
  }

  private async persistCitations(
    tx: PrismaTx,
    queryId: string,
    responseId: string,
    citations: Citation[],
    contexts: Map<string, CitationContext>,
  ): Promise<void> {
    if (citations.length === 0) return
    // C1: retrieval_result_id を「当該 queryId の集合」だけで解決する（複合 FK の参照先 / B2）。
    // chunk_id はグローバル一意でないため queryId スコープ無しだと、同一 chunk を retrieval した
    // 過去の別クエリの retrieval_result_id が紐づく（複合 FK は chunk_id 一致で素通り）。
    const chunkIds = citations.map((c) => c.chunk_id)
    const retrievalRows = await tx.ragRetrievalResult.findMany({
      where: { queryId, chunkId: { in: chunkIds } },
      select: { id: true, chunkId: true },
    })
    const retrievalIdByChunk = new Map(
      retrievalRows.map((r) => [r.chunkId, r.id] as const),
    )

    let order = 0
    for (const citation of citations) {
      const ctx = contexts.get(citation.chunk_id)
      const retrievalResultId = retrievalIdByChunk.get(citation.chunk_id)
      if (ctx === undefined || retrievalResultId === undefined) continue
      order += 1
      await tx.ragCitation.create({
        data: {
          responseId,
          retrievalResultId,
          sourceId: ctx.sourceId,
          documentId: ctx.documentId,
          chunkId: ctx.chunkId,
          citationOrder: order,
          ...(ctx.title !== undefined ? { title: ctx.title } : {}),
          usedReason: citation.used_reason,
          excerpt: ctx.excerpt, // DB には常に保存（API では audience で出し分け / B2 監査固定値）。
          // Major4: replay 時に retrieval_score を初回と一致させるため finalScore を永続化。
          // API citation.retrieval_score は live 経路で ctx.retrievalScore(=finalScore) を返すため、
          // replay の rebuild が同値を再現できるよう similarity_score 列に保存する。
          similarityScore: new Prisma.Decimal(ctx.retrievalScore),
          ...(ctx.eventTime !== null ? { eventTime: new Date(ctx.eventTime) } : {}),
          ingestedAt: new Date(ctx.ingestedAt),
          qualityStatus: ctx.qualityStatus,
        },
      })
      // retrieval 結果に used_in_answer を立てる（履歴詳細の使用フラグ）。
      await tx.ragRetrievalResult.update({
        where: { id: retrievalResultId },
        data: { usedInAnswer: true },
      })
    }
  }

  private async persistGuardrailResult(
    txOrPrisma: PrismaTx,
    queryId: string,
    responseId: string | undefined,
    guardrail: ApiGuardrailLike,
  ): Promise<void> {
    const blocked = guardrail.status === 'BLOCKED'
    const severity = blocked ? 'HIGH' : guardrail.status === 'WARNING' ? 'MEDIUM' : 'LOW'
    await txOrPrisma.ragGuardrailResult.create({
      data: {
        queryId,
        ...(responseId !== undefined ? { responseId } : {}),
        guardrailType: 'schema_validation',
        status: guardrail.status,
        severity,
        detectedItems: {
          blocked_reasons: guardrail.blocked_reasons,
          warnings: guardrail.warnings,
        } as Prisma.InputJsonValue,
        ...(guardrail.blocked_reasons.length > 0
          ? { reason: guardrail.blocked_reasons.join('; ') }
          : {}),
        blocked,
      },
    })
  }

  private async persistBotContext(
    tx: PrismaTx,
    params: {
      requesterId: string
      idempotencyKey: string
      payloadHash: string
      queryId: string
      responseId: string
      request: RunBotContextInput['request']
      contextJson: Record<string, unknown>
    },
  ): Promise<string> {
    const created = await tx.ragBotContext.create({
      data: {
        requesterId: params.requesterId,
        idempotencyKey: params.idempotencyKey,
        payloadHash: params.payloadHash,
        botId: params.request.bot_id,
        ...(params.request.strategy_id !== undefined
          ? { strategyId: params.request.strategy_id }
          : {}),
        queryId: params.queryId,
        responseId: params.responseId,
        ...(params.request.symbol !== undefined ? { symbol: params.request.symbol } : {}),
        ...(params.request.timeframe !== undefined
          ? { timeframe: params.request.timeframe }
          : {}),
        botSignal: params.request.bot_signal,
        ...(params.request.features !== undefined
          ? { features: params.request.features as Prisma.InputJsonValue }
          : {}),
        contextJson: params.contextJson as Prisma.InputJsonValue,
        orderPermission: false, // 常に false（横断規約5）。
      },
    })
    return created.id
  }

  private async updateQueryStatus(
    txOrPrisma: PrismaTx,
    queryId: string,
    status: QueryStatus,
  ): Promise<void> {
    await txOrPrisma.ragQuery.update({
      where: { id: queryId },
      data: { status },
    })
  }

  /* ---------------------------------------------------------------------- */
  /* citation 補完: retrieval chunk のメタを DB から読む                     */
  /* ---------------------------------------------------------------------- */
  private async loadCitationContexts(
    chunks: RetrievedChunk[],
  ): Promise<Map<string, CitationContext>> {
    const map = new Map<string, CitationContext>()
    if (chunks.length === 0) return map

    const chunkIds = chunks.map((c) => c.chunkId)
    const rows = await this.prisma.ragChunk.findMany({
      where: { id: { in: chunkIds } },
      select: {
        id: true,
        sourceId: true,
        documentId: true,
        sourceType: true,
        content: true,
        eventTime: true,
        ingestedAt: true,
        status: true,
        document: { select: { title: true } },
      },
    })
    const scoreByChunk = new Map(chunks.map((c) => [c.chunkId, c.finalScore] as const))

    for (const row of rows) {
      // chunk.status → citation quality_status へ写像（ACTIVE/QUARANTINED/DISABLED）。
      const qualityStatus = this.chunkStatusToQuality(row.status)
      const ctx: CitationContext = {
        chunkId: row.id,
        sourceId: row.sourceId,
        documentId: row.documentId,
        sourceType: row.sourceType,
        excerpt: row.content.slice(0, EXCERPT_MAX),
        eventTime: row.eventTime ? row.eventTime.toISOString() : null,
        ingestedAt: row.ingestedAt.toISOString(),
        retrievalScore: scoreByChunk.get(row.id) ?? 0,
        qualityStatus,
      }
      if (row.document?.title != null) ctx.title = row.document.title
      map.set(row.id, ctx)
    }
    return map
  }

  /** chunk.status（ACTIVE/QUARANTINED/DISABLED）→ citation quality_status。 */
  private chunkStatusToQuality(status: string): CitationQualityStatus {
    if (status === 'ACTIVE') return 'ACTIVE'
    if (status === 'QUARANTINED') return 'QUARANTINED'
    return 'DISABLED'
  }

  /* ---------------------------------------------------------------------- */
  /* replay: 永続済み行から data を再構築（再課金なし）                       */
  /* ---------------------------------------------------------------------- */
  private async rebuildQueryData(
    queryId: string,
    trace: { trace_id: string },
    audience: ClientTypeValue,
  ): Promise<QueryResponseData> {
    const { query, response, guardrail } = await this.loadPersistedQuery(queryId)
    const citations = await this.loadPersistedCitations(response.id, audience)
    const json = response.responseJson as Record<string, unknown>
    return {
      query_id: query.id,
      trace_id: query.traceId || trace.trace_id,
      summary: response.summary,
      supporting_factors: asStringArray(response.supportingFactors),
      opposing_factors: asStringArray(response.opposingFactors),
      risk_level: response.riskLevel as RiskLevel,
      confidence: decimalToScore(response.confidence),
      citations,
      llm: this.llmFromJson(json),
      guardrail: this.toApiGuardrail({
        status: (guardrail?.status ?? 'PASS') as ApiGuardrailLike['status'],
        blocked_reasons: extractReasons(guardrail?.detectedItems, 'blocked_reasons'),
        warnings: extractReasons(guardrail?.detectedItems, 'warnings'),
      }),
    }
  }

  private async rebuildBotContextData(
    queryId: string,
    trace: { trace_id: string },
  ): Promise<BotContextResponseData> {
    const botContext = await this.prisma.ragBotContext.findFirst({
      where: { queryId },
      orderBy: { createdAt: 'desc' },
    })
    if (botContext === null) {
      throw RagApiException.internal('Bot context row missing for replayed query.')
    }
    // contextJson が API data の正本スナップショット。trace_id だけ現リクエスト値で更新。
    const data = botContext.contextJson as unknown as BotContextResponseData
    return { ...data, context_id: botContext.id, trace_id: trace.trace_id }
  }

  private async loadPersistedQuery(queryId: string): Promise<{
    query: { id: string; traceId: string }
    response: {
      id: string
      summary: string
      supportingFactors: Prisma.JsonValue
      opposingFactors: Prisma.JsonValue
      riskLevel: string
      confidence: Prisma.Decimal
      responseJson: Prisma.JsonValue
    }
    guardrail: { status: string; detectedItems: Prisma.JsonValue } | null
  }> {
    const query = await this.prisma.ragQuery.findUnique({
      where: { id: queryId },
      select: { id: true, traceId: true },
    })
    if (query === null) throw RagApiException.internal('Query row missing on replay.')
    const response = await this.prisma.ragResponse.findFirst({
      where: { queryId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        summary: true,
        supportingFactors: true,
        opposingFactors: true,
        riskLevel: true,
        confidence: true,
        responseJson: true,
      },
    })
    if (response === null) throw RagApiException.internal('Response row missing on replay.')
    const guardrail = await this.prisma.ragGuardrailResult.findFirst({
      where: { queryId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, detectedItems: true },
    })
    return { query, response, guardrail }
  }

  private async loadPersistedCitations(
    responseId: string,
    audience: ClientTypeValue,
  ): Promise<Citation[]> {
    const rows = await this.prisma.ragCitation.findMany({
      where: { responseId },
      orderBy: { citationOrder: 'asc' },
      select: {
        sourceId: true,
        documentId: true,
        chunkId: true,
        title: true,
        usedReason: true,
        excerpt: true,
        eventTime: true,
        ingestedAt: true,
        qualityStatus: true,
        similarityScore: true,
        chunk: { select: { sourceType: true } },
      },
    })
    const includeExcerpt = audience === 'ui'
    return rows.map((row) => {
      const citation: Citation = {
        source_id: row.sourceId,
        document_id: row.documentId,
        chunk_id: row.chunkId,
        source_type: row.chunk.sourceType as Citation['source_type'],
        used_reason: row.usedReason,
        event_time: row.eventTime ? row.eventTime.toISOString() : null,
        ingested_at: row.ingestedAt ? row.ingestedAt.toISOString() : new Date(0).toISOString(),
        retrieval_score: row.similarityScore ? Number(row.similarityScore) : 0,
        quality_status: row.qualityStatus as CitationQualityStatus,
      }
      if (row.title != null) citation.title = row.title
      if (includeExcerpt) citation.excerpt = row.excerpt
      return citation
    })
  }

  /* ---------------------------------------------------------------------- */
  /* 変換ヘルパ                                                              */
  /* ---------------------------------------------------------------------- */
  private toLlmUsage(meta: ProviderCallMeta): LlmUsage {
    const usage: LlmUsage = {
      provider: meta.provider,
      model: meta.model,
      fallback_used: meta.fallback_used,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      latency_ms: meta.latency_ms,
    }
    if (meta.estimated_cost !== undefined) usage.estimated_cost = meta.estimated_cost
    return usage
  }

  private llmFromJson(json: Record<string, unknown>): LlmUsage {
    const llm = json['llm']
    if (llm !== null && typeof llm === 'object') {
      return llm as LlmUsage
    }
    return { provider: 'openai', model: 'gpt-4o-mini', fallback_used: false }
  }

  private toApiGuardrail(g: ApiGuardrailLike): ApiGuardrailResult {
    const result: ApiGuardrailResult = {
      status: g.status,
      order_permission: false,
    }
    if (g.blocked_reasons.length > 0) result.blocked_reasons = g.blocked_reasons
    if (g.warnings.length > 0) result.warnings = g.warnings
    return result
  }

  /* ---------------------------------------------------------------------- */
  /* request → filter / pseudo-query                                        */
  /* ---------------------------------------------------------------------- */
  private queryFilters(request: RunQueryInput['request']): Prisma.InputJsonValue {
    return {
      symbol: request.symbol ?? null,
      market: request.market ?? null,
      timeframe: request.timeframe ?? null,
      source_types: request.source_types ?? [],
      from: request.from ?? null,
      to: request.to ?? null,
      language: request.language ?? null,
      top_k: request.top_k ?? null,
    } as Prisma.InputJsonValue
  }

  private botContextFilters(request: RunBotContextInput['request']): Prisma.InputJsonValue {
    return {
      symbol: request.symbol ?? null,
      market: request.market ?? null,
      timeframe: request.timeframe ?? null,
      bot_signal: request.bot_signal,
    } as Prisma.InputJsonValue
  }

  private buildRetrievalFilters(args: {
    sourceTypes?: readonly string[] | undefined
    symbol?: string | undefined
    timeframe?: string | undefined
    from?: string | undefined
    to?: string | undefined
  }): RetrievalFilters {
    const filters: RetrievalFilters = {}
    if (args.symbol !== undefined) filters.symbol = args.symbol
    if (args.timeframe !== undefined) filters.timeframe = args.timeframe
    if (args.sourceTypes !== undefined && args.sourceTypes.length > 0) {
      filters.sourceTypes = args.sourceTypes as readonly SourceTypeValue[]
    }
    if (args.from !== undefined) filters.eventTimeFrom = new Date(args.from)
    if (args.to !== undefined) filters.eventTimeTo = new Date(args.to)
    return filters
  }

  private botSignalPseudoQuery(request: RunBotContextInput['request']): string {
    const parts = [
      `Explain bot signal ${request.bot_signal}`,
      request.symbol ? `for ${request.symbol}` : '',
      request.timeframe ? `on ${request.timeframe}` : '',
    ].filter((s) => s.length > 0)
    const features = request.features
      ? ` features=${JSON.stringify(request.features)}`
      : ''
    return `${parts.join(' ')}.${features}`
  }
}

/* ======================================================================== */
/* module-private helpers                                                   */
/* ======================================================================== */

/**
 * 永続ヘルパが受ける Prisma クライアント（$transaction の tx クライアント or PrismaService 本体）。
 * Prisma.TransactionClient は $transaction / $connect 等を持たない interactive tx 型。
 * 非トランザクション経路（進捗 status 更新 / BLOCKED guardrail 保存）では this.prisma を渡す。
 */
type PrismaTx = Prisma.TransactionClient

/** guardrail の最小形（service の出力 + replay 再構築の双方を受ける）。 */
interface ApiGuardrailLike {
  status: 'PASS' | 'WARNING' | 'BLOCKED'
  blocked_reasons: string[]
  warnings: string[]
}

function asStringArray(value: Prisma.JsonValue): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

function decimalToScore(value: Prisma.Decimal): number {
  return Number(value.toString())
}

function extractReasons(
  detectedItems: Prisma.JsonValue | undefined,
  key: 'blocked_reasons' | 'warnings',
): string[] {
  if (detectedItems !== null && typeof detectedItems === 'object' && !Array.isArray(detectedItems)) {
    const arr = (detectedItems as Record<string, unknown>)[key]
    if (Array.isArray(arr)) return arr.filter((v): v is string => typeof v === 'string')
  }
  return []
}
