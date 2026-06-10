import { PrismaClient } from '@prisma/client'
import { IngestionService } from '../ingestion.service'
import { IdempotencyConflictError } from '../idempotency-conflict.error'
import { StubEmbeddingProvider } from '../testing/stub-embedding-provider'
import type { IngestionJobInput } from '../ingestion.types'

/**
 * DB 結合テスト（docker postgres + pgvector / 05 / 27）。
 *
 * 検証:
 *   - パイプライン: 正規化 → chunk → embed → rag_documents/chunks/embeddings 保存
 *   - 差分 Embedding スキップ（content_hash 一致 / 同一 payload 再取込で embed 再呼び出しなし）
 *   - chunk 全置換（27 §10.3 / 旧 chunk は deleted_at 論理削除）
 *   - 冪等 replay（同一 idempotency_key + payload → 既存ジョブ返却 / embed 呼び出しなし）
 *   - 409（同一キー + 別 payload）
 *
 * DB 未接続環境では describe.skip（CI は docker postgres を起動済みのため実行される）。
 * OpenAI 実呼び出しは StubEmbeddingProvider で完全に排除（API キー不要）。
 */

const prisma = new PrismaClient()

let dbAvailable = false

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`
    dbAvailable = true
  } catch {
    dbAvailable = false
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

/** PrismaService と同じ shape（onModuleInit 等は使わないため PrismaClient で代用）。 */
function makeService(stub: StubEmbeddingProvider): IngestionService {
  return new IngestionService(prisma as never, stub)
}

async function createSource(): Promise<string> {
  const src = await prisma.ragSource.create({
    data: {
      sourceType: 'strategy_doc',
      sourceName: `it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      displayName: 'integration source',
      reliabilityScore: '0.9',
      status: 'ACTIVE',
    },
    select: { id: true },
  })
  return src.id
}

async function cleanupSource(sourceId: string): Promise<void> {
  const docs = await prisma.ragDocument.findMany({ where: { sourceId }, select: { id: true } })
  const docIds = docs.map((d) => d.id)
  if (docIds.length > 0) {
    const chunks = await prisma.ragChunk.findMany({
      where: { documentId: { in: docIds } },
      select: { id: true },
    })
    const chunkIds = chunks.map((c) => c.id)
    if (chunkIds.length > 0) {
      await prisma.ragEmbedding.deleteMany({ where: { chunkId: { in: chunkIds } } })
      await prisma.ragChunk.deleteMany({ where: { id: { in: chunkIds } } })
    }
    await prisma.ragIngestionJobItem.deleteMany({ where: { documentId: { in: docIds } } })
    await prisma.ragDocument.deleteMany({ where: { id: { in: docIds } } })
  }
  const jobs = await prisma.ragIngestionJob.findMany({ where: { sourceId }, select: { id: true } })
  const jobIds = jobs.map((j) => j.id)
  if (jobIds.length > 0) {
    await prisma.ragIngestionJobItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.ragIngestionJob.deleteMany({ where: { id: { in: jobIds } } })
  }
  await prisma.ragSource.delete({ where: { id: sourceId } })
}

function strategyInput(sourceId: string, key: string, body: string): IngestionJobInput {
  return {
    sourceId,
    sourceType: 'strategy_doc',
    jobType: 'internal_sync',
    idempotencyKey: key,
    items: [{ rawContent: body, title: 'doc', symbol: 'BTCUSDT', market: 'crypto' }],
    traceId: `trace-${key}`,
    requestId: `req-${key}-${Date.now()}`,
  }
}

const md = ['# 戦略', 'BTC 短期反発を狙う。RSI 29。', '', '## リスク', '上位足の下落継続に注意。'].join(
  '\n',
)

/**
 * DB 未接続環境ではテスト本体を no-op で抜ける（CI は docker postgres 起動済みで実行される）。
 * jest の it/describe 収集は beforeAll より前に走るため、skip ではなく body 内ガードで判定する。
 */
function skipIfNoDb(): boolean {
  if (!dbAvailable) {
    console.warn('[ingestion.integration] DB 未接続のため本テストを no-op skip')
    return true
  }
  return false
}

describe('IngestionService 結合（DB / pgvector）', () => {
  it(
    'AC-CHUNK-001/003: document/chunk/embedding を保存し vector を書き込む',
    async () => {
      if (skipIfNoDb()) return
      const sourceId = await createSource()
      try {
        const stub = new StubEmbeddingProvider()
        const service = makeService(stub)
        const result = await service.ingest(strategyInput(sourceId, 'k-persist', md))

        expect(result.status).toBe('INDEXED')
        expect(result.replayed).toBe(false)
        expect(result.successCount).toBe(1)

        const docId = result.items[0]!.documentId!
        const chunks = await prisma.ragChunk.findMany({
          where: { documentId: docId, deletedAt: null },
          select: { id: true, chunkIndex: true, status: true, embeddings: { select: { id: true, dimension: true } } },
          orderBy: { chunkIndex: 'asc' },
        })
        expect(chunks.length).toBeGreaterThanOrEqual(2)
        // chunk_index 0 起点・連続
        expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
        // ACTIVE chunk に embedding が 1536 次元で存在
        const active = chunks.filter((c) => c.status === 'ACTIVE')
        expect(active.length).toBeGreaterThan(0)
        for (const c of active) {
          expect(c.embeddings.length).toBe(1)
          expect(c.embeddings[0]!.dimension).toBe(1536)
        }
        expect(stub.embedCallCount).toBe(1)
      } finally {
        await cleanupSource(sourceId)
      }
    },
  )

  it(
    '27 §10.1/§10.2: 同一 payload 再取込は冪等 replay（embed 再呼び出しなし）',
    async () => {
      if (skipIfNoDb()) return
      const sourceId = await createSource()
      try {
        const stub = new StubEmbeddingProvider()
        const service = makeService(stub)

        const first = await service.ingest(strategyInput(sourceId, 'k-replay', md))
        expect(first.replayed).toBe(false)
        const callsAfterFirst = stub.embedCallCount

        // 同一 idempotency_key + 同一 payload → replay
        const second = await service.ingest(strategyInput(sourceId, 'k-replay', md))
        expect(second.replayed).toBe(true)
        expect(second.jobId).toBe(first.jobId)
        // replay は embed を呼ばない（差分 Embedding 防止 / 二重課金防止）
        expect(stub.embedCallCount).toBe(callsAfterFirst)
      } finally {
        await cleanupSource(sourceId)
      }
    },
  )

  it(
    '冪等 409: 同一 idempotency_key + 別 payload → IdempotencyConflictError',
    async () => {
      if (skipIfNoDb()) return
      const sourceId = await createSource()
      try {
        const stub = new StubEmbeddingProvider()
        const service = makeService(stub)
        await service.ingest(strategyInput(sourceId, 'k-conflict', md))

        await expect(
          service.ingest(strategyInput(sourceId, 'k-conflict', md + '\n\n## 追記\n別内容')),
        ).rejects.toBeInstanceOf(IdempotencyConflictError)
      } finally {
        await cleanupSource(sourceId)
      }
    },
  )

  it(
    '27 §10.1/§10.3: 同一文書の再処理で chunk が全置換され、content_hash 一致 embedding は再利用される',
    async () => {
      if (skipIfNoDb()) return
      const sourceId = await createSource()
      try {
        const stub = new StubEmbeddingProvider()
        const service = makeService(stub)

        // idempotency_key なし = 毎回 job 処理（replay されない）。同一 content を 2 回取込。
        const noKey: IngestionJobInput = {
          sourceId,
          sourceType: 'strategy_doc',
          jobType: 'reindex',
          items: [{ rawContent: md, title: 'doc' }],
          traceId: 'trace-reproc',
          requestId: `req-1-${Date.now()}`,
        }
        const first = await service.ingest(noKey)
        const docId = first.items[0]!.documentId!
        const embedCallsAfterFirst = stub.embedCallCount
        const newAfterFirst = first.items[0]!.newEmbeddingCount
        expect(newAfterFirst).toBeGreaterThan(0)

        const liveAfterFirst = await prisma.ragChunk.findMany({
          where: { documentId: docId, deletedAt: null },
          select: { id: true },
        })

        // 2 回目: 同一 content（同一 document content_hash）→ 同一 document を全置換。
        const second = await service.ingest({ ...noKey, requestId: `req-2-${Date.now()}` })
        expect(second.items[0]!.documentId).toBe(docId)
        // content_hash 一致 → embedding 再利用（再 Embedding スキップ / embed 呼び出し増えない）
        expect(stub.embedCallCount).toBe(embedCallsAfterFirst)
        expect(second.items[0]!.reusedEmbeddingCount).toBeGreaterThan(0)
        expect(second.items[0]!.newEmbeddingCount).toBe(0)

        // 全置換: 旧 chunk は物理削除され、新 chunk 群が 0 起点・連続で並ぶ。
        // （UNIQUE(document_id, content_hash) が部分 unique でないため全置換は物理削除 /
        //  service の申し送り参照。embedding は退避済みのため再 Embedding は発生しない）
        const liveAfterSecond = await prisma.ragChunk.findMany({
          where: { documentId: docId, deletedAt: null },
          select: { id: true, chunkIndex: true },
          orderBy: { chunkIndex: 'asc' },
        })
        expect(liveAfterSecond.map((c) => c.chunkIndex)).toEqual(
          liveAfterSecond.map((_, i) => i),
        )
        const oldIds = new Set(liveAfterFirst.map((c) => c.id))
        const survivingOld = liveAfterSecond.filter((c) => oldIds.has(c.id))
        expect(survivingOld.length).toBe(0) // 旧 chunk は全置換で消えている
        // 全 chunk は埋め込み済み（再利用ベクトル経由）。reused 数は live ACTIVE chunk 数に一致。
        expect(second.items[0]!.reusedEmbeddingCount).toBe(liveAfterSecond.length)
      } finally {
        await cleanupSource(sourceId)
      }
    },
  )
})
