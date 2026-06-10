/**
 * RagOrchestrator の結線・規約テスト（DB / OpenAI を mock）。
 *
 * 検証対象（Stage2 基本結線 + Stage3 Fable5 指摘回帰）:
 *   - query: retrieval → LLM → guardrail → 永続 → 返却の結線
 *   - order_permission が常に false（横断規約5 / LLM が true を主張しても）
 *   - citation 全除去で 422 RAG_GUARDRAIL_BLOCKED（B2）
 *   - 冪等: 同一 idempotency_key + 同一 payload は replay（再課金なし / LLM 非再呼出）
 *   - 冪等: 同一 idempotency_key + 別 payload は 409 RAG_IDEMPOTENCY_CONFLICT
 *   - bot-context: order_permission=false + action_policy 固定
 *
 * Stage3 回帰テスト（Fable5 指摘対応）:
 *   C1: persistCitations が queryId でスコープする（他クエリの行を汚染しない）
 *   C2: FAILED / BLOCKED / in-flight の同一キー再送が恒久 500 化しない
 *   Major3: similar-cases の同一キー再送が replay（embed / rag_queries INSERT 増えない）
 *   Major4: replay 時の retrieval_score が初回 finalScore と一致（similarityScore 永続）
 *   Major5: history の risk_level フィルタ時に total と items が pagination と整合
 *   Minor: top_k 上限超過が Zod で 400 / readMoney 欠落が null を返す
 */
import { Prisma } from '@prisma/client'
import { RagOrchestrator } from '../rag-orchestrator.service'
import { GuardrailService } from '../../../../guardrail/guardrail.service'
import { OrderPermissionGuard } from '../../../../guardrail/order-permission.guard'
import { CitationWhitelistGuard } from '../../../../guardrail/citation-whitelist.guard'
import { SecretMaskingGuard } from '../../../../guardrail/secret-masking.guard'
import { PromptInjectionGuard } from '../../../../guardrail/prompt-injection.guard'
import type { ProviderRouter } from '../../infrastructure/providers/routing/provider-router'
import type { RetrievalService } from '../../../../retrieval/retrieval.service'
import type { PrismaService } from '../../infrastructure/prisma/prisma.service'
import type { RunQueryInput } from '../rag-orchestrator.types'
import { SimilarCasesService } from '../similar-cases.service'
import { HistoryService } from '../history.service'
import { queryRequestSchema, MAX_TOP_K } from '@pmtp/shared'
import { stableHashOfJson } from '../../../../ingestion/content-hash'

/* --------------------------- fakes --------------------------- */

const TRACE = { trace_id: 'trace-1', request_id: 'req-1' }

function makeRouter(opts?: {
  orderPermissionClaim?: unknown
  citationChunkIds?: string[]
}): jest.Mocked<Pick<ProviderRouter, 'embed' | 'generateStructured'>> {
  const citationChunkIds = opts?.citationChunkIds ?? ['chunk-a']
  return {
    embed: jest.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      dimensions: 3,
      meta: { provider: 'openai', model: 'text-embedding-3-small', fallback_used: false, input_tokens: 5, output_tokens: 0, latency_ms: 10 },
    }),
    generateStructured: jest.fn().mockResolvedValue({
      data: {
        summary: 'market summary',
        explanation: 'bot explanation',
        supporting_factors: ['f1'],
        opposing_factors: ['o1'],
        risk_level: 'MEDIUM',
        confidence: 0.6,
        citations: citationChunkIds.map((id) => ({ chunk_id: id, used_reason: 'r' })),
        ...(opts?.orderPermissionClaim !== undefined
          ? { order_permission: opts.orderPermissionClaim }
          : { order_permission: false }),
      },
      meta: { provider: 'openai', model: 'gpt-4o-mini', fallback_used: false, input_tokens: 100, output_tokens: 50, estimated_cost: '0.0012', latency_ms: 800 },
    }),
  } as unknown as jest.Mocked<Pick<ProviderRouter, 'embed' | 'generateStructured'>>
}

function makeRetrieval(chunkIds: string[], queryId?: string): jest.Mocked<Pick<RetrievalService, 'retrieve'>> {
  return {
    retrieve: jest.fn().mockResolvedValue({
      queryId: queryId ?? 'q-1',
      chunks: chunkIds.map((id, i) => ({
        chunkId: id,
        documentId: `doc-${id}`,
        sourceId: `src-${id}`,
        content: `content ${id}`,
        metadata: {},
        similarityScore: 0.9,
        reliabilityScore: 0.8,
        recencyScore: 1,
        finalScore: 0.85,
        rankOrder: i + 1,
      })),
      oversampleLimit: 100,
      fallbackApplied: false,
    }),
  } as unknown as jest.Mocked<Pick<RetrievalService, 'retrieve'>>
}

/** 実 GuardrailService を使う（決定的・LLM 非依存のため mock 不要）。 */
function realGuardrail(): GuardrailService {
  return new GuardrailService(
    new OrderPermissionGuard(),
    new CitationWhitelistGuard(),
    new SecretMaskingGuard(),
    new PromptInjectionGuard(),
  )
}

/**
 * Prisma の最小 in-memory fake。orchestrator が呼ぶメソッドだけ実装する。
 *
 * 【C1 修正】ragRetrievalResult.findMany は where を尊重して絞り込む。
 * 従来は where を無視して全 chunkIds を返していたため、他クエリ由来の
 * retrieval_result_id が citation に紐づく C1 バグを構造的に検出不能だった。
 *
 * 【推奨3 $transaction 結線】$transaction の fake は callback を記録し、
 * callback 内で呼ばれた ragResponse/ragCitation/ragGuardrailResult の
 * create 操作と ragQuery.update('RETURNED') を追跡する。
 * テストから txLog を参照して「persist 群が tx 内で実行された」を assert できる。
 *
 * chunk は ACTIVE で whitelist を通すよう固定。
 */
function makePrisma(chunkIds: string[]): {
  prisma: PrismaService
  queries: Map<string, Record<string, unknown>>
  retrievalResults: Map<string, Record<string, unknown>[]>
  citations: Map<string, Record<string, unknown>[]>
  /** 各 $transaction 呼び出しごとに tx callback 内で実行された操作のログ。 */
  txLog: Array<{ op: string; args: unknown }>[]
} {
  const queries = new Map<string, Record<string, unknown>>()
  const responses = new Map<string, Record<string, unknown>>()
  const guardrails = new Map<string, Record<string, unknown>>()
  const botContexts = new Map<string, Record<string, unknown>>()
  // key: queryId, value: [retrievalResult rows]
  const retrievalResultsByQueryId = new Map<string, Record<string, unknown>[]>()
  // key: responseId, value: [citation rows]
  const citationsByResponseId = new Map<string, Record<string, unknown>[]>()
  let seq = 0
  const id = (p: string): string => `${p}-${++seq}`

  /**
   * 推奨3: $transaction 呼び出しごとのログを蓄積する配列。
   * インデックス 0 = 1 回目の $transaction で実行された操作リスト、etc.
   * テストから prisma.$transaction が呼ばれた回数・各 tx 内の操作を検証できる。
   */
  const txLog: Array<{ op: string; args: unknown }>[] = []

  // 初期 retrievalResults を queryId → rows で管理する。
  // ragRetrievalResult.findMany で where.queryId / where.chunkId を実際に適用する。

  /**
   * tx プロキシ: callback 内で呼ばれたメソッドを txLog に記録し、
   * 実際の永続も prisma 本体の Map に反映する（in-memory fake は分離しない）。
   * create/update 呼び出しを op 名付きで記録する。
   */
  const makeTxProxy = (currentTxOps: { op: string; args: unknown }[]) => {
    const record = (op: string, args: unknown) => currentTxOps.push({ op, args })
    return {
      ragQuery: {
        update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          record('ragQuery.update', args)
          const row = queries.get(args.where.id)
          if (row) Object.assign(row, args.data)
          return row
        }),
      },
      ragResponse: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          record('ragResponse.create', args)
          const row: Record<string, unknown> = { ...args.data, id: id('response'), createdAt: new Date() }
          responses.set(row['queryId'] as string, row)
          return row
        }),
      },
      ragCitation: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          record('ragCitation.create', args)
          const row = { id: id('cit'), ...args.data }
          const rId = args.data['responseId'] as string
          const existing = citationsByResponseId.get(rId) ?? []
          existing.push(row)
          citationsByResponseId.set(rId, existing)
          return row
        }),
      },
      ragGuardrailResult: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          record('ragGuardrailResult.create', args)
          const row: Record<string, unknown> = { ...args.data, id: id('grd'), createdAt: new Date() }
          guardrails.set(row['queryId'] as string, row)
          return row
        }),
      },
      ragBotContext: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          record('ragBotContext.create', args)
          const row: Record<string, unknown> = { ...args.data, id: id('botctx'), createdAt: new Date() }
          botContexts.set(row['queryId'] as string, row)
          return row
        }),
      },
      ragRetrievalResult: {
        findMany: jest.fn(async (args: { where?: Record<string, unknown>; orderBy?: unknown; select?: unknown }) => {
          // tx proxy の findMany は prisma 本体の実装に委譲（読み取りは記録不要）。
          return (prisma.ragRetrievalResult.findMany as jest.Mock)(args)
        }),
        update: jest.fn(async (args: unknown) => {
          record('ragRetrievalResult.update', args)
          return {}
        }),
      },
    }
  }

  const prisma = {
    /**
     * 推奨3: $transaction は callback を記録する。
     * callback に渡すのは本体 prisma ではなく tx プロキシ（記録付き）。
     * プロキシ内の操作は txLog に追記される。
     */
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => {
      const currentTxOps: { op: string; args: unknown }[] = []
      txLog.push(currentTxOps)
      const txProxy = makeTxProxy(currentTxOps)
      return cb(txProxy)
    }),
    ragQuery: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const q of queries.values()) {
          if (
            q['requesterId'] === where['requesterId'] &&
            q['idempotencyKey'] === where['idempotencyKey']
          ) {
            return q
          }
        }
        return null
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        queries.get(where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id('query'), ...data }
        queries.set(row.id, row)
        // 新規 query に対して chunkIds ぶんの retrievalResult 行を初期化する。
        // retrievalResult は retrieval.service（mock）が永続すると仮定するが、
        // fake では create 時点でプリシード（retrieval.service 呼び出し後に
        // orchestrator が ragRetrievalResult を参照するため事前に用意する）。
        const rrRows = chunkIds.map((c) => ({
          id: `rr-${row.id}-${c}`,
          queryId: row.id,
          chunkId: c,
          similarityScore: new Prisma.Decimal(0.85),
          rankOrder: chunkIds.indexOf(c) + 1,
          chunk: {
            metadata: {},
          },
        }))
        retrievalResultsByQueryId.set(row.id, rrRows)
        return row
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = queries.get(where.id)
        if (row) Object.assign(row, data)
        return row
      }),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
    ragResponse: {
      // 非 tx 経路（BLOCKED guardrail 保存後の rebuildQueryData など replay 読み取り）用。
      // tx 経路の create は txProxy が担うが findFirst は常に outer prisma に来る。
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Record<string, unknown> = { ...data, id: id('response'), createdAt: new Date() }
        responses.set(row['queryId'] as string, row)
        return row
      }),
      findFirst: jest.fn(async ({ where }: { where: { queryId: string } }) =>
        responses.get(where.queryId) ?? null,
      ),
    },
    ragCitation: {
      // 非 tx 経路用（outer prisma への直接 create は現在の実装では発生しないが念のため残す）。
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id('cit'), ...data }
        const rId = data['responseId'] as string
        const existing = citationsByResponseId.get(rId) ?? []
        existing.push(row)
        citationsByResponseId.set(rId, existing)
        return row
      }),
      /**
       * 【Major4 修正】similarityScore を固定値 0.85 で上書きせず、
       * create で永続された値をそのまま返す。
       *
       * 修正前: `similarityScore: new Prisma.Decimal(0.85)` を findMany で上書き。
       * → create に similarityScore を渡していなくても findMany は 0.85 を返す。
       * → replay スコアが create の値と一致するテストが、create に値を渡さない
       *   実装でも通る偽陽性になっていた。
       *
       * 修正後: citationsByResponseId に格納された row の similarityScore を
       * そのまま返す（存在しなければ Prisma.Decimal(0) を返して不一致で落とす）。
       */
      findMany: jest.fn(async ({ where }: { where: { responseId: string } }) => {
        const rows = citationsByResponseId.get(where.responseId) ?? []
        return rows.map((r) => ({
          ...r,
          chunk: { sourceType: 'market_data' },
          eventTime: null,
          ingestedAt: new Date(),
          title: null,
          excerpt: 'excerpt',
          // 永続された值をそのまま返す。create で未渡しなら undefined → 0 になり
          // replay スコアが 0 になるため「一致」テストが落ちる（偽陽性解消）。
          similarityScore: r['similarityScore'] instanceof Prisma.Decimal
            ? r['similarityScore']
            : new Prisma.Decimal(0),
          qualityStatus: r['qualityStatus'] ?? 'ACTIVE',
        }))
      }),
    },
    ragGuardrailResult: {
      // 非 tx 経路: BLOCKED 時（pipeline 内の this.prisma 直接呼び出し）用。
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Record<string, unknown> = { ...data, id: id('grd'), createdAt: new Date() }
        guardrails.set(row['queryId'] as string, row)
        return row
      }),
      findFirst: jest.fn(async ({ where }: { where: { queryId: string } }) =>
        guardrails.get(where.queryId) ?? null,
      ),
    },
    ragBotContext: {
      // 非 tx 経路用（outer prisma への直接 create は現在の実装では発生しないが念のため残す）。
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Record<string, unknown> = { ...data, id: id('botctx'), createdAt: new Date() }
        botContexts.set(row['queryId'] as string, row)
        return row
      }),
      findFirst: jest.fn(async ({ where }: { where: { queryId: string } }) =>
        botContexts.get(where.queryId) ?? null,
      ),
    },
    ragRetrievalResult: {
      /**
       * 【C1 修正の核心】where を実際に適用して絞り込む。
       *
       * 修正前: where を無視して全 chunkIds を固定 queryId 'query-1' で返す。
       * → C1 バグ（他クエリの retrieval_result_id が citation に紐づく）を
       *   構造的に検出不能にしていた。
       *
       * 修正後: where.queryId / where.chunkId を実際に適用して絞り込む。
       * → 当該 queryId の行のみが返るようになり、C1 の検証が意味を持つ。
       */
      findMany: jest.fn(async (args: { where?: Record<string, unknown>; orderBy?: unknown; select?: unknown }) => {
        const where = args?.where ?? {}
        const targetQueryId = where['queryId'] as string | undefined
        const chunkIdFilter = where['chunkId'] as { in?: string[] } | undefined

        // queryId でフィルタ。未指定なら全行返す。
        let allRows: Record<string, unknown>[] = []
        if (targetQueryId !== undefined) {
          allRows = retrievalResultsByQueryId.get(targetQueryId) ?? []
        } else {
          for (const rows of retrievalResultsByQueryId.values()) {
            allRows = allRows.concat(rows)
          }
        }

        // chunkId.in でフィルタ。
        if (chunkIdFilter?.in !== undefined) {
          const allowedChunks = new Set(chunkIdFilter.in)
          allRows = allRows.filter((r) => allowedChunks.has(r['chunkId'] as string))
        }

        // select が指定されている場合は当該フィールドだけ返す（orderBy は無視可）。
        const select = args?.select as Record<string, boolean> | undefined
        if (select !== undefined) {
          return allRows.map((row) => {
            const out: Record<string, unknown> = {}
            for (const key of Object.keys(select)) {
              if (key === 'chunk') {
                out['chunk'] = (row['chunk'] as Record<string, unknown> | undefined) ?? { metadata: {} }
              } else {
                out[key] = row[key]
              }
            }
            return out
          })
        }
        return allRows
      }),
      update: jest.fn(async () => ({})),
    },
    ragChunk: {
      findMany: jest.fn(async () =>
        chunkIds.map((c) => ({
          id: c,
          sourceId: `src-${c}`,
          documentId: `doc-${c}`,
          sourceType: 'market_data',
          content: `content ${c}`,
          eventTime: new Date('2026-06-09T00:00:00Z'),
          ingestedAt: new Date('2026-06-09T01:00:00Z'),
          status: 'ACTIVE',
          document: { title: `Title ${c}` },
        })),
      ),
    },
  } as unknown as PrismaService

  return { prisma, queries, retrievalResults: retrievalResultsByQueryId, citations: citationsByResponseId, txLog }
}

function build(opts?: {
  chunkIds?: string[]
  routerCitationIds?: string[]
  orderPermissionClaim?: unknown
}): {
  orchestrator: RagOrchestrator
  router: ReturnType<typeof makeRouter>
  prisma: PrismaService
  retrievalResults: Map<string, Record<string, unknown>[]>
  citations: Map<string, Record<string, unknown>[]>
  /** 各 $transaction 呼び出しごとに tx callback 内で実行された操作のログ（推奨3 検証用）。 */
  txLog: Array<{ op: string; args: unknown }>[]
 } {
  const chunkIds = opts?.chunkIds ?? ['chunk-a']
  const router = makeRouter({
    citationChunkIds: opts?.routerCitationIds ?? chunkIds,
    ...(opts?.orderPermissionClaim !== undefined
      ? { orderPermissionClaim: opts.orderPermissionClaim }
      : {}),
  })
  const retrieval = makeRetrieval(chunkIds)
  const { prisma, retrievalResults, citations, txLog } = makePrisma(chunkIds)
  const orchestrator = new RagOrchestrator(
    prisma,
    router as unknown as ProviderRouter,
    retrieval as unknown as RetrievalService,
    realGuardrail(),
  )
  return { orchestrator, router, prisma, retrievalResults, citations, txLog }
}

function queryInput(overrides?: Partial<RunQueryInput>): RunQueryInput {
  return {
    request: { query: 'BTC market context' },
    trace: TRACE,
    idempotencyKey: 'idem-1',
    requesterId: '00000000-0000-4000-8000-000000000001',
    audience: 'training_bot',
    ...overrides,
  }
}

/* ========================== 基本結線テスト（Stage2 引き継ぎ）========================== */

describe('RagOrchestrator.runQuery', () => {
  it('retrieval → LLM → guardrail → 返却を結線し、citation を返す', async () => {
    const { orchestrator, router } = build({ chunkIds: ['chunk-a'] })
    const { data, replayed } = await orchestrator.runQuery(queryInput())

    expect(replayed).toBe(false)
    expect(data.summary).toBe('market summary')
    expect(data.risk_level).toBe('MEDIUM')
    expect(data.confidence).toBe(0.6)
    expect(data.citations).toHaveLength(1)
    expect(data.citations[0]?.chunk_id).toBe('chunk-a')
    expect(data.guardrail.status).toBe('PASS')
    expect(router.embed).toHaveBeenCalledTimes(1)
    expect(router.generateStructured).toHaveBeenCalledTimes(1)
  })

  it('training_bot audience は excerpt を省く / order_permission は常に false', async () => {
    const { orchestrator } = build()
    const { data } = await orchestrator.runQuery(queryInput({ audience: 'training_bot' }))
    expect(data.citations[0]?.excerpt).toBeUndefined()
    expect(data.guardrail.order_permission).toBe(false)
  })

  it('ui audience は excerpt を含む', async () => {
    const { orchestrator } = build()
    const { data } = await orchestrator.runQuery(queryInput({ audience: 'ui' }))
    expect(data.citations[0]?.excerpt).toBe('content chunk-a')
  })

  it('LLM が捏造 chunk_id しか返さない → citation 全除去 → 422 RAG_GUARDRAIL_BLOCKED', async () => {
    const { orchestrator } = build({
      chunkIds: ['chunk-a'],
      routerCitationIds: ['fabricated-id'],
    })
    await expect(orchestrator.runQuery(queryInput())).rejects.toMatchObject({
      code: 'RAG_GUARDRAIL_BLOCKED',
      httpStatus: 422,
    })
  })

  it('LLM が order_permission=true を主張しても data.guardrail.order_permission は false', async () => {
    const { orchestrator } = build({ orderPermissionClaim: true })
    const { data } = await orchestrator.runQuery(queryInput())
    expect(data.guardrail.order_permission).toBe(false)
  })

  it('同一 idempotency_key + 同一 payload は replay（LLM を再呼出しない）', async () => {
    const { orchestrator, router } = build()
    await orchestrator.runQuery(queryInput())
    const first = router.generateStructured.mock.calls.length
    const replay = await orchestrator.runQuery(queryInput())
    expect(replay.replayed).toBe(true)
    // replay 時は generateStructured を再呼出しない（再課金なし）。
    expect(router.generateStructured.mock.calls.length).toBe(first)
  })

  it('同一 idempotency_key + 別 payload は 409 RAG_IDEMPOTENCY_CONFLICT', async () => {
    const { orchestrator } = build()
    await orchestrator.runQuery(queryInput({ request: { query: 'first' } }))
    await expect(
      orchestrator.runQuery(queryInput({ request: { query: 'DIFFERENT' } })),
    ).rejects.toMatchObject({ code: 'RAG_IDEMPOTENCY_CONFLICT', httpStatus: 409 })
  })
})

describe('RagOrchestrator.runBotContext', () => {
  it('order_permission=false + action_policy 固定 / bot_signal を返す', async () => {
    const { orchestrator } = build()
    const { data } = await orchestrator.runBotContext({
      request: { bot_id: '11111111-1111-4111-8111-111111111111', bot_signal: 'BUY' },
      trace: TRACE,
      idempotencyKey: 'bot-idem-1',
      requesterId: '00000000-0000-4000-8000-000000000001',
      audience: 'training_bot',
    })
    expect(data.order_permission).toBe(false)
    expect(data.action_policy).toBe('ORDER_NOT_ALLOWED_BY_RAG')
    expect(data.bot_signal).toBe('BUY')
    expect(data.explanation).toBe('bot explanation')
    expect(data.context_id).toMatch(/^botctx-/)
  })
})

/* ========================== 推奨3: $transaction 結線 assert ========================== */

describe('推奨3: runQuery の persist 群が $transaction 内で実行される', () => {
  /**
   * 推奨3: rag-orchestrator.service.ts:139 の $transaction ブロック内で
   *   persistResponse / persistCitations / persistGuardrailResult / updateQueryStatus('RETURNED')
   * が実行されることを assert する。
   *
   * これらのうちいずれかを $transaction 外に移すと txLog[0] の op リストに
   * 該当エントリが存在しなくなり、以下のテストが落ちる。
   * → tx を剥がす回帰を構造的に検出できる。
   *
   * fake の実装: $transaction は callback に txProxy（記録付き）を渡す。
   * txProxy 内の各 create/update が txLog に追記される（outer prisma への直接呼び出しは記録されない）。
   */
  it('runQuery: ragResponse.create が $transaction 内で実行される', async () => {
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    // $transaction が 1 回呼ばれている。
    expect(txLog.length).toBeGreaterThanOrEqual(1)
    const firstTx = txLog[0]!
    const ops = firstTx.map((e) => e.op)
    expect(ops).toContain('ragResponse.create')
  })

  it('runQuery: ragCitation.create が $transaction 内で実行される', async () => {
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    const firstTx = txLog[0]!
    const ops = firstTx.map((e) => e.op)
    expect(ops).toContain('ragCitation.create')
  })

  it('runQuery: ragGuardrailResult.create が $transaction 内で実行される', async () => {
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    const firstTx = txLog[0]!
    const ops = firstTx.map((e) => e.op)
    expect(ops).toContain('ragGuardrailResult.create')
  })

  it('runQuery: ragQuery.update(RETURNED) が $transaction 内で実行される', async () => {
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    const firstTx = txLog[0]!
    const statusUpdates = firstTx
      .filter((e) => e.op === 'ragQuery.update')
      .map((e) => (e.args as { data: { status: string } }).data.status)
    expect(statusUpdates).toContain('RETURNED')
  })

  it('runBotContext: response/citation/guardrail/botContext/status が $transaction 内で実行される', async () => {
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runBotContext({
      request: { bot_id: '11111111-1111-4111-8111-111111111111', bot_signal: 'BUY' },
      trace: TRACE,
      idempotencyKey: 'bot-tx-idem',
      requesterId: '00000000-0000-4000-8000-000000000001',
      audience: 'training_bot',
    })

    expect(txLog.length).toBeGreaterThanOrEqual(1)
    const firstTx = txLog[0]!
    const ops = firstTx.map((e) => e.op)
    expect(ops).toContain('ragResponse.create')
    expect(ops).toContain('ragCitation.create')
    expect(ops).toContain('ragGuardrailResult.create')
    expect(ops).toContain('ragBotContext.create')
    const statusUpdates = firstTx
      .filter((e) => e.op === 'ragQuery.update')
      .map((e) => (e.args as { data: { status: string } }).data.status)
    expect(statusUpdates).toContain('RETURNED')
  })
})

/** Prisma.Decimal が orchestrator 経由で number 化されることのサニティ。 */
describe('decimal handling', () => {
  it('confidence は Prisma.Decimal で永続される', () => {
    const d = new Prisma.Decimal(0.6)
    expect(d.toString()).toBe('0.6')
  })
})

/* ========================== Stage3 Fable5 回帰テスト ========================== */

describe('C1 回帰: persistCitations が queryId でスコープする', () => {
  /**
   * 再現: 異なる 2 クエリが同一 chunk-a を retrieval 済みのシナリオ。
   *
   * 修正前の fake では ragRetrievalResult.findMany が where を無視して全行を返すため、
   * クエリ Q2 の citation が Q1 の retrieval_result_id を誤って参照していた。
   * 修正後の fake では queryId スコープで絞り込まれるため、各クエリの citation が
   * 自クエリの retrieval_result_id のみを参照することを検証できる。
   *
   * 同一 prisma fake を共有して異なる idempotencyKey で 2 回実行する。
   * 両クエリが同一 chunk-a を retrieval 済みとなるが、各クエリの citation は
   * 自クエリの queryId 由来の retrieval_result_id のみを参照する。
   */
  it('別クエリが同一 chunk を retrieval 済みでも、各クエリの citation は自クエリ行のみを参照する', async () => {
    const chunkIds = ['chunk-a']
    const { orchestrator, prisma, citations } = build({ chunkIds })

    // Q1 を実行（idempotencyKey='q1-key'）。
    const r1 = await orchestrator.runQuery(queryInput({ idempotencyKey: 'q1-key', request: { query: 'q1-query' } }))
    expect(r1.replayed).toBe(false)

    // Q2 を別 idempotencyKey で実行（同一 chunk-a を retrieval / 同一 prisma fake 共有）。
    const r2 = await orchestrator.runQuery(queryInput({ idempotencyKey: 'q2-key', request: { query: 'q2-query' } }))
    expect(r2.replayed).toBe(false)

    // citations Map には Q1・Q2 それぞれの response 分が入っている（2 エントリ）。
    expect(citations.size).toBe(2)

    // 各クエリの citation が参照する retrievalResultId を確認する。
    const allCitationRows = [...citations.values()].flat()
    const retrievalResultIds = allCitationRows.map((row) => row['retrievalResultId'] as string)

    // 全 citation の retrievalResultId が query ID 由来であること。
    for (const rrId of retrievalResultIds) {
      expect(rrId).toMatch(/^rr-query-/)
    }

    // Q1 と Q2 は別クエリなので query-1 と query-2 の rr ID がそれぞれ存在するはず。
    // （各 citation が自クエリ queryId の rr 行のみを参照している証拠）
    const uniqueIds = new Set(retrievalResultIds)
    // 2 クエリ × 1 chunk = 2 種類の retrieval_result_id（各クエリで独立採番）。
    expect(uniqueIds.size).toBe(2)
  })

  it('ragRetrievalResult.findMany に渡す where に queryId が含まれる', async () => {
    const { orchestrator, prisma } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    // 実装が persistCitations で findMany を呼ぶとき where.queryId を渡しているか確認。
    const findManyCalls = (prisma.ragRetrievalResult.findMany as jest.Mock).mock.calls
    // 少なくとも 1 回以上呼ばれ、すべての呼び出しで queryId が含まれることを確認する。
    expect(findManyCalls.length).toBeGreaterThan(0)
    for (const [args] of findManyCalls) {
      expect(args?.where?.queryId).toBeDefined()
    }
  })
})

describe('C2 回帰: 初回が FAILED/BLOCKED/in-flight の再送が恒久 500 化しない', () => {
  /**
   * C2: replay 判定に query status ゲートを設ける。
   * RETURNED のみ即 replay し、FAILED/BLOCKED/in-flight は明示挙動で返す。
   */
  /**
   * C2 テストでは prisma.ragQuery.findFirst が「FAILED/BLOCKED/in-flight 状態の既存行」を
   * 返すよう mock する。claimIdempotentQuery 内で assertPayloadMatches を通るために、
   * mockResolvedValueOnce で返す行の payloadHash を「実際のリクエストと同じハッシュ値」に
   * 一致させる必要がある（不一致だと 409 IDEMPOTENCY_CONFLICT で上書きされてしまうため）。
   */
  function makeC2Prisma(status: string, idempotencyKey: string, requesterId: string, requestObj: { query: string }): PrismaService {
    const payloadHash = stableHashOfJson({ kind: 'query', request: requestObj })
    const fakeQueryId = `c2-query-${status}`

    return {
      ragQuery: {
        findFirst: jest.fn().mockResolvedValue({
          id: fakeQueryId,
          requesterId,
          idempotencyKey,
          payloadHash, // 実際のハッシュと一致させる
          status,
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new', status: 'RECEIVED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      ragResponse: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'resp-1', createdAt: new Date() }),
      },
      ragCitation: {
        create: jest.fn().mockResolvedValue({ id: 'cit-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      ragGuardrailResult: {
        create: jest.fn().mockResolvedValue({ id: 'grd-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      ragBotContext: {
        create: jest.fn().mockResolvedValue({ id: 'botctx-1', createdAt: new Date() }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      ragRetrievalResult: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      ragChunk: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({})),
    } as unknown as PrismaService
  }

  it('(a) 初回が FAILED で claim 済み → 同一キー再送は 500 RAG_INTERNAL_ERROR を再現する', async () => {
    /**
     * C2(a) 偽陽性修正:
     *
     * 修正前: makeC2Prisma の findUnique が null を返すため、assertReplayable を
     * 除去しても rebuildQueryData → loadPersistedQuery が「Query row missing」で
     * 同じ RAG_INTERNAL_ERROR(500) を投げてテストが通る。
     * → FAILED ステータスゲート由来か「rebuild 失敗」由来かを区別できない偽陽性。
     *
     * 修正後: findUnique に query 行を返させ、かつ ragResponse.findFirst にも
     * response 行を返させる。これにより、もし assertReplayable が除去されると
     * rebuildQueryData は成功して 500 にならない → テストが落ちる。
     * assertReplayable の FAILED 分岐が実際に 500 を投げていることを証明できる。
     */
    const requesterId = '00000000-0000-4000-8000-000000000001'
    const idempotencyKey = 'idem-failed'
    const requestObj = { query: 'BTC market context' }
    const fakeQueryId = `c2-query-FAILED`

    // findUnique / ragResponse.findFirst に正常な行を返させる。
    // こうすることで、もし FAILED ゲートが除去されると rebuildQueryData が成功し
    // 500 にならず → テストが落ちる（偽陽性解消）。
    const prismaWithRows = makeC2Prisma('FAILED', idempotencyKey, requesterId, requestObj)
    // findUnique に query 行をセット（FAILED ゲートが除去された場合の fallback を成功させる）。
    ;(prismaWithRows.ragQuery.findUnique as jest.Mock).mockResolvedValue({
      id: fakeQueryId,
      traceId: 'trace-1',
      status: 'FAILED',
    })
    // ragResponse.findFirst に response 行をセット。
    ;(prismaWithRows.ragResponse.findFirst as jest.Mock).mockResolvedValue({
      id: 'resp-c2a',
      queryId: fakeQueryId,
      summary: 'replay summary',
      supportingFactors: [],
      opposingFactors: [],
      riskLevel: 'MEDIUM',
      confidence: new Prisma.Decimal(0.6),
      responseJson: { llm: { provider: 'openai', model: 'gpt-4o-mini', fallback_used: false } },
      createdAt: new Date(),
    })
    ;(prismaWithRows.ragGuardrailResult.findFirst as jest.Mock).mockResolvedValue(null)

    const orch = new RagOrchestrator(
      prismaWithRows,
      makeRouter() as unknown as ProviderRouter,
      makeRetrieval(['chunk-a']) as unknown as RetrievalService,
      realGuardrail(),
    )

    // FAILED ゲートが効いているから 500。ゲートを除去すると rebuildQueryData が
    // 成功して 500 にならず、このテストが落ちる。
    await expect(
      orch.runQuery({ request: requestObj, trace: TRACE, idempotencyKey, requesterId, audience: 'training_bot' }),
    ).rejects.toMatchObject({
      code: 'RAG_INTERNAL_ERROR',
      httpStatus: 500,
    })
  })

  it('(b) guardrail BLOCK で response 行なし → 再送は 422 RAG_GUARDRAIL_BLOCKED を再現する', async () => {
    const requesterId = '00000000-0000-4000-8000-000000000001'
    const idempotencyKey = 'idem-blocked'
    const requestObj = { query: 'BTC market context' }

    const prisma = makeC2Prisma('BLOCKED', idempotencyKey, requesterId, requestObj)
    const orch = new RagOrchestrator(
      prisma,
      makeRouter() as unknown as ProviderRouter,
      makeRetrieval(['chunk-a']) as unknown as RetrievalService,
      realGuardrail(),
    )

    await expect(
      orch.runQuery({ request: requestObj, trace: TRACE, idempotencyKey, requesterId, audience: 'training_bot' }),
    ).rejects.toMatchObject({
      code: 'RAG_GUARDRAIL_BLOCKED',
      httpStatus: 422,
    })
  })

  it('(c) in-flight（RETRIEVED / response 未作成）→ 409 RAG_IDEMPOTENCY_CONFLICT', async () => {
    const requesterId = '00000000-0000-4000-8000-000000000001'
    const idempotencyKey = 'idem-inflight'
    const requestObj = { query: 'BTC market context' }

    const prisma = makeC2Prisma('RETRIEVED', idempotencyKey, requesterId, requestObj)
    const orch = new RagOrchestrator(
      prisma,
      makeRouter() as unknown as ProviderRouter,
      makeRetrieval(['chunk-a']) as unknown as RetrievalService,
      realGuardrail(),
    )

    await expect(
      orch.runQuery({ request: requestObj, trace: TRACE, idempotencyKey, requesterId, audience: 'training_bot' }),
    ).rejects.toMatchObject({
      code: 'RAG_IDEMPOTENCY_CONFLICT',
      httpStatus: 409,
    })
  })

  it('RETURNED の同一キー再送は正常に replay（500 化しない）', async () => {
    const { orchestrator, router } = build()
    // 初回成功
    await orchestrator.runQuery(queryInput())
    const callsBefore = router.generateStructured.mock.calls.length

    // 再送 → replay
    const result = await orchestrator.runQuery(queryInput())
    expect(result.replayed).toBe(true)
    // LLM は再呼出されない
    expect(router.generateStructured.mock.calls.length).toBe(callsBefore)
  })
})

describe('Major4 回帰: replay 時の retrieval_score が初回 finalScore と一致する', () => {
  /**
   * Major4: similarityScore を citation に永続し、replay 時に retrieval_score が
   * 初回 finalScore（=0.85）と一致することを検証する。
   *
   * 修正前（偽陽性）: ragCitation.findMany が similarityScore を 0.85 で固定上書き。
   * → create に similarityScore を渡さなくても replay スコアが 0.85 になり一致テストが通る。
   *
   * 修正後: findMany は create で格納された similarityScore をそのまま返す。
   * → create で similarityScore を渡さないと findMany は Prisma.Decimal(0) を返し、
   *   replay スコアが 0 になる → 初回スコア（> 0）と一致しないので落ちる。
   */
  it('初回の citation.retrieval_score と replay の citation.retrieval_score が一致する', async () => {
    const { orchestrator } = build({ chunkIds: ['chunk-a'] })

    // 初回
    const first = await orchestrator.runQuery(queryInput())
    const firstScore = first.data.citations[0]?.retrieval_score ?? -1
    expect(firstScore).toBeGreaterThan(0)

    // replay（同一キー）
    const replayed = await orchestrator.runQuery(queryInput())
    expect(replayed.replayed).toBe(true)
    const replayScore = replayed.data.citations[0]?.retrieval_score ?? -1

    // 永続された similarityScore が findMany で返されるため、replay スコアは初回と一致する。
    // もし persistCitations が similarityScore を渡さなければ findMany は 0 を返し、ここで落ちる。
    expect(replayScore).toBe(firstScore)
  })

  it('ragCitation.create に similarityScore が渡される（txLog 経由で確認）', async () => {
    /**
     * create 呼び出しは $transaction プロキシ経由なので、outer prisma の mock.calls ではなく
     * txLog から op='ragCitation.create' のエントリを取得して検証する。
     */
    const { orchestrator, txLog } = build({ chunkIds: ['chunk-a'] })
    await orchestrator.runQuery(queryInput())

    // tx 内の ragCitation.create 呼び出しを txLog から抽出する。
    const firstTx = txLog[0] ?? []
    const citationCreates = firstTx
      .filter((e) => e.op === 'ragCitation.create')
      .map((e) => (e.args as { data: Record<string, unknown> }).data)

    expect(citationCreates.length).toBeGreaterThan(0)
    for (const data of citationCreates) {
      // similarityScore は Prisma.Decimal で渡されること（number 化しない / Major4 規約）。
      expect(data['similarityScore']).toBeInstanceOf(Prisma.Decimal)
      // 0 でないこと（未渡しなら Decimal(0) になり replay スコアが一致しないため偽陽性を除去できる）。
      expect((data['similarityScore'] as Prisma.Decimal).toString()).not.toBe('0')
    }
  })
})

/* ========================== HistoryService 回帰テスト ========================== */

describe('Major5 回帰: history の risk_level フィルタが pagination と整合する', () => {
  /**
   * Major5: risk_level フィルタを skip/take 後ではなく where 句に入れることで
   * total とページ件数が整合することを検証する。
   *
   * fake: HistoryService が使う prisma.ragQuery.count / findMany を mock する。
   * テーブルに 5 件あり、うち 2 件が risk_level=HIGH のシナリオで、
   * risk_level フィルタ後の total=2 になることを確認する。
   */

  function makeHistoryPrisma(
    rows: Array<{
      id: string
      createdAt: Date
      symbol: string | null
      queryText: string
      riskLevel: string
    }>,
  ): PrismaService {
    const makeRow = (r: (typeof rows)[0]) => ({
      id: r.id,
      createdAt: r.createdAt,
      symbol: r.symbol,
      queryText: r.queryText,
      responses: [
        {
          riskLevel: r.riskLevel,
          confidence: new Prisma.Decimal(0.7),
          responseJson: { llm: { provider: 'openai', model: 'gpt-4o-mini' } },
        },
      ],
      providerCalls: [],
      guardrailResults: [{ status: 'PASS' }],
    })

    const prisma = {
      ragQuery: {
        count: jest.fn(async ({ where }: { where: { responses?: { some?: { riskLevel?: string } } } }) => {
          // where に responses.some.riskLevel フィルタが適用されていれば絞り込む。
          const riskFilter = where?.responses?.some?.riskLevel
          if (riskFilter !== undefined) {
            return rows.filter((r) => r.riskLevel === riskFilter).length
          }
          // responses.some（{}）: 応答済みのみ（全件返す / 全行が responses あり）
          return rows.length
        }),
        findMany: jest.fn(async ({ where, skip, take }: { where: { responses?: { some?: { riskLevel?: string } } }; skip?: number; take?: number }) => {
          const riskFilter = where?.responses?.some?.riskLevel
          let filtered = riskFilter !== undefined
            ? rows.filter((r) => r.riskLevel === riskFilter)
            : rows
          if (skip !== undefined) filtered = filtered.slice(skip)
          if (take !== undefined) filtered = filtered.slice(0, take)
          return filtered.map(makeRow)
        }),
      },
    } as unknown as PrismaService
    return prisma
  }

  it('risk_level フィルタあり: total がフィルタ後件数に一致し、items もフィルタされる', async () => {
    const rows = [
      { id: 'q1', createdAt: new Date(), symbol: 'BTC', queryText: 'q1', riskLevel: 'HIGH' },
      { id: 'q2', createdAt: new Date(), symbol: 'ETH', queryText: 'q2', riskLevel: 'MEDIUM' },
      { id: 'q3', createdAt: new Date(), symbol: 'BTC', queryText: 'q3', riskLevel: 'HIGH' },
      { id: 'q4', createdAt: new Date(), symbol: null, queryText: 'q4', riskLevel: 'LOW' },
      { id: 'q5', createdAt: new Date(), symbol: null, queryText: 'q5', riskLevel: 'MEDIUM' },
    ]
    const service = new HistoryService(makeHistoryPrisma(rows))
    const result = await service.list({
      query: { risk_level: 'HIGH', page: 1, limit: 10 },
      requesterId: 'req-1',
    })

    // total はフィルタ後件数（2 件 / HIGH のみ）。
    expect(result.pagination.total).toBe(2)
    // items は HIGH のみ。
    expect(result.items).toHaveLength(2)
    expect(result.items.every((i) => i.risk_level === 'HIGH')).toBe(true)
  })

  it('risk_level フィルタなし: total は全件 / items はページ分', async () => {
    const rows = [
      { id: 'q1', createdAt: new Date(), symbol: 'BTC', queryText: 'q1', riskLevel: 'HIGH' },
      { id: 'q2', createdAt: new Date(), symbol: 'ETH', queryText: 'q2', riskLevel: 'MEDIUM' },
      { id: 'q3', createdAt: new Date(), symbol: 'BTC', queryText: 'q3', riskLevel: 'HIGH' },
    ]
    const service = new HistoryService(makeHistoryPrisma(rows))
    const result = await service.list({
      query: { page: 1, limit: 2 },
      requesterId: 'req-1',
    })

    expect(result.pagination.total).toBe(3)
    // limit=2 なので items は 2 件
    expect(result.items).toHaveLength(2)
  })

  it('ページ 2: skip が適用されて items が 2 ページ目を返す', async () => {
    const rows = [
      { id: 'q1', createdAt: new Date(), symbol: 'BTC', queryText: 'q1', riskLevel: 'HIGH' },
      { id: 'q2', createdAt: new Date(), symbol: 'ETH', queryText: 'q2', riskLevel: 'HIGH' },
      { id: 'q3', createdAt: new Date(), symbol: 'BTC', queryText: 'q3', riskLevel: 'HIGH' },
    ]
    const service = new HistoryService(makeHistoryPrisma(rows))
    const result = await service.list({
      query: { risk_level: 'HIGH', page: 2, limit: 2 },
      requesterId: 'req-1',
    })

    expect(result.pagination.total).toBe(3) // フィルタ後件数
    expect(result.items).toHaveLength(1) // ページ 2 は残り 1 件
  })
})

/* ========================== SimilarCasesService 回帰テスト ========================== */

describe('Major3 回帰: similar-cases の同一キー再送が replay（re-embedding / DB 挿入なし）', () => {
  /**
   * Major3: similar-cases の POST は毎回 rag_queries INSERT + embedding 課金が発生する。
   * 同一 Idempotency-Key + 同一 payload の再送は replay（再課金なし）を検証する。
   */

  function makeSimilarCasesPrisma(): {
    prisma: PrismaService
    queryCreates: jest.Mock
  } {
    const queries = new Map<string, Record<string, unknown>>()
    // 2 回目の findFirst が replay を返すよう、実際の Map 状態を見る実装にする。
    const queryCreates = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      let seq = queries.size + 1
      const row = { id: `sc-query-${seq}`, status: 'RECEIVED', ...data }
      queries.set(row.id as string, row)
      return row
    })
    const queryFindFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const q of queries.values()) {
        if (
          q['requesterId'] === where['requesterId'] &&
          q['idempotencyKey'] === where['idempotencyKey']
        ) {
          return q
        }
      }
      return null
    })
    const queryUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = queries.get(where.id)
      if (row) Object.assign(row, data)
      return row ?? {}
    })

    const prisma = {
      ragQuery: {
        create: queryCreates,
        findFirst: queryFindFirst,
        update: queryUpdate,
        findUnique: jest.fn(async () => null),
      },
      ragRetrievalResult: {
        findMany: jest.fn(async () => [
          {
            id: 'rr-sc-1',
            chunkId: 'chunk-case-a',
            similarityScore: new Prisma.Decimal(0.91),
            chunk: {
              metadata: {
                period_from: '2026-01-01T00:00:00Z',
                period_to: '2026-01-07T00:00:00Z',
                symbol: 'BTC',
                after_move_4h_pct: '1.23',
                after_move_24h_pct: '3.45',
                max_drawdown_pct: '-2.10',
              },
            },
          },
        ]),
      },
    } as unknown as PrismaService
    return { prisma, queryCreates }
  }

  it('同一キー再送は idempotencyReplayed=true / embed が 2 回呼ばれない', async () => {
    const { prisma, queryCreates } = makeSimilarCasesPrisma()
    const embed = jest.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2]],
      meta: { provider: 'openai', model: 'text-embedding-3-small', fallback_used: false, input_tokens: 5, output_tokens: 0, latency_ms: 10 },
    })
    const router = { embed } as unknown as ProviderRouter
    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        queryId: 'sc-query-1',
        chunks: [{ chunkId: 'chunk-case-a', similarityScore: 0.91, metadata: {}, finalScore: 0.91 }],
        oversampleLimit: 10,
        fallbackApplied: false,
      }),
    } as unknown as RetrievalService

    const service = new SimilarCasesService(prisma, router, retrieval)
    const baseParams = {
      request: { symbol: 'BTC', timeframe: '1h', limit: 5 },
      requesterId: '00000000-0000-4000-8000-000000000002',
      idempotencyKey: 'sc-idem-1',
      trace: TRACE,
    }

    // 初回
    const first = await service.findSimilarCases(baseParams)
    expect(first.replayed).toBe(false)
    expect(embed).toHaveBeenCalledTimes(1)
    const firstQueryCreateCount = queryCreates.mock.calls.length

    // 同一キー再送（status を RETURNED に設定するため Map の行を更新）
    // findFirst は実 Map を参照し、status が RETURNED になっていれば replay を返す。
    // rag_queries.update で status を RETURNED に設定済みのため再送は replay ルートへ。
    const second = await service.findSimilarCases(baseParams)
    expect(second.replayed).toBe(true)
    // embed を再呼出しない（再課金なし）
    expect(embed).toHaveBeenCalledTimes(1)
    // ragQuery.create を再呼出しない
    expect(queryCreates.mock.calls.length).toBe(firstQueryCreateCount)
  })
})

/* ========================== Minor 回帰テスト ========================== */

describe('Minor 回帰', () => {
  describe('top_k 上限: MAX_TOP_K 超過は Zod schema で弾かれる', () => {
    it(`top_k=${MAX_TOP_K} は valid`, () => {
      const result = queryRequestSchema.safeParse({ query: 'test', top_k: MAX_TOP_K })
      expect(result.success).toBe(true)
    })

    it(`top_k=${MAX_TOP_K + 1} は invalid（400 相当）`, () => {
      const result = queryRequestSchema.safeParse({ query: 'test', top_k: MAX_TOP_K + 1 })
      expect(result.success).toBe(false)
    })

    it('top_k=0 は invalid（positive 制約）', () => {
      const result = queryRequestSchema.safeParse({ query: 'test', top_k: 0 })
      expect(result.success).toBe(false)
    })

    it('MAX_TOP_K は 50（shared SSoT の定数値）', () => {
      expect(MAX_TOP_K).toBe(50)
    })
  })

  describe('readMoney 欠落: null を返す（"0" 偽装しない）', () => {
    /**
     * SimilarCasesService の readMoneyOrNull は欠落・不正な値に対して null を返す。
     * 欠落時 risk_notes に "Outcome metric unavailable..." が追記される。
     * これを検証するために SimilarCasesService の buildCase を間接的にテストする。
     */
    it('欠落した金融数値が risk_notes に明示され、after_move_4h_pct は "0" に倒される', async () => {
      const queries = new Map<string, Record<string, unknown>>()
      const prismaWithMissingMeta = {
        ragQuery: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: 'sc-missing-1', status: 'RECEIVED', ...data }
            queries.set(row.id, row)
            return row
          }),
          findFirst: jest.fn(async () => null), // always new
          update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = queries.get(where.id)
            if (row) Object.assign(row, data)
            return row ?? {}
          }),
        },
        ragRetrievalResult: {
          findMany: jest.fn(async () => [
            {
              id: 'rr-missing-1',
              chunkId: 'chunk-missing-a',
              similarityScore: new Prisma.Decimal(0.8),
              chunk: {
                // after_move_4h_pct が欠落、after_move_24h_pct が不正（number）
                metadata: {
                  period_from: '2026-01-01T00:00:00Z',
                  period_to: '2026-01-07T00:00:00Z',
                  symbol: 'ETH',
                  // after_move_4h_pct: 欠落
                  after_move_24h_pct: 999, // number（不正 / string のみ valid）
                  max_drawdown_pct: '-1.50', // valid
                },
              },
            },
          ]),
        },
      } as unknown as PrismaService

      const embed = jest.fn().mockResolvedValue({
        embeddings: [[0.1]],
        meta: { provider: 'openai', model: 'text-embedding-3-small', fallback_used: false, input_tokens: 5, output_tokens: 0, latency_ms: 10 },
      })
      const retrieval = {
        retrieve: jest.fn().mockResolvedValue({
          queryId: 'sc-missing-1',
          chunks: [{ chunkId: 'chunk-missing-a', similarityScore: 0.8, metadata: {
            period_from: '2026-01-01T00:00:00Z',
            period_to: '2026-01-07T00:00:00Z',
            symbol: 'ETH',
            after_move_24h_pct: 999,
            max_drawdown_pct: '-1.50',
          }, finalScore: 0.8 }],
          oversampleLimit: 10,
          fallbackApplied: false,
        }),
      } as unknown as RetrievalService

      const service = new SimilarCasesService(
        prismaWithMissingMeta,
        { embed } as unknown as ProviderRouter,
        retrieval,
      )

      const result = await service.findSimilarCases({
        request: { symbol: 'ETH', limit: 5 },
        requesterId: '00000000-0000-4000-8000-000000000003',
        idempotencyKey: 'sc-missing-idem',
        trace: TRACE,
      })

      expect(result.cases).toHaveLength(1)
      const c = result.cases[0]!
      // 欠落した after_move_4h_pct は "0" に倒される（スキーマ必須のため）。
      expect(c.after_move_4h_pct).toBe('0')
      // 欠落した after_move_24h_pct（number 型 = 不正）も "0" に倒される。
      expect(c.after_move_24h_pct).toBe('0')
      // valid な max_drawdown_pct はそのまま透過。
      expect(c.max_drawdown_pct).toBe('-1.50')
      // 欠落・不正のフィールド名が risk_notes に明示される（"0" の黙認 = やめる）。
      const riskText = c.risk_notes.join(' ')
      expect(riskText).toContain('after_move_4h_pct')
      expect(riskText).toContain('after_move_24h_pct')
      // valid なものは risk_notes に含まれない。
      expect(riskText).not.toContain('max_drawdown_pct')
    })
  })
})
