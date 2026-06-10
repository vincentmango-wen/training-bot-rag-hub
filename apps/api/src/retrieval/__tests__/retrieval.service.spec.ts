import { Prisma } from '@prisma/client'

import type { PrismaService } from '../../modules/rag/infrastructure/prisma/prisma.service'
import { RetrievalService } from '../retrieval.service'
import type { RetrievalSqlRow } from '../retrieval-sql'

/**
 * RetrievalService の振る舞いテスト（OpenAI / DB 非依存 / Prisma を全 mock）。
 *  - fallback（不足時 oversample up）の発火条件
 *  - rag_retrieval_results へのスナップショット保存（recency/final）
 *  - rankOrder の採番
 */

const row = (i: number): RetrievalSqlRow => ({
  chunk_id: `chunk-${i}`,
  document_id: `doc-${i}`,
  source_id: `src-${i}`,
  content: `content ${i}`,
  metadata: { i },
  similarity_score: 0.9,
  reliability_score: 0.8,
  recency_score: 0.5,
  final_score: 0.7,
})

type MockTx = {
  $executeRaw: jest.Mock
  $queryRaw: jest.Mock
}

function makeService(queryResults: RetrievalSqlRow[][]): {
  service: RetrievalService
  createMany: jest.Mock
  queryRaw: jest.Mock
} {
  const queryRaw = jest.fn()
  for (const result of queryResults) {
    queryRaw.mockResolvedValueOnce(result)
  }
  const createMany = jest.fn().mockResolvedValue({ count: 0 })

  const tx: MockTx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: queryRaw,
  }

  const prisma = {
    $transaction: jest.fn(async (cb: (t: MockTx) => unknown) => cb(tx)),
    ragRetrievalResult: { createMany },
  } as unknown as PrismaService

  return { service: new RetrievalService(prisma), createMany, queryRaw }
}

const embedding = new Array(1536).fill(0.01)

describe('RetrievalService.retrieve', () => {
  it('topK を満たせば fallback せず 1 回検索する', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i))
    const { service, queryRaw } = makeService([rows])

    const result = await service.retrieve({
      queryId: 'q1',
      embedding,
      topK: 20,
    })

    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(result.fallbackApplied).toBe(false)
    expect(result.chunks).toHaveLength(20)
    expect(result.oversampleLimit).toBe(100) // 20 * 5
  })

  it('topK 未満なら oversample 係数を上げて 1 回 fallback する', async () => {
    const first = Array.from({ length: 5 }, (_, i) => row(i))
    const second = Array.from({ length: 12 }, (_, i) => row(i))
    const { service, queryRaw } = makeService([first, second])

    const result = await service.retrieve({
      queryId: 'q2',
      embedding,
      topK: 20,
    })

    expect(queryRaw).toHaveBeenCalledTimes(2)
    expect(result.fallbackApplied).toBe(true)
    expect(result.chunks).toHaveLength(12)
    expect(result.oversampleLimit).toBe(200) // 20 * (5*2)
  })

  it('fallback しても件数が増えなければ初回結果を採用（fallbackApplied=false）', async () => {
    const first = Array.from({ length: 5 }, (_, i) => row(i))
    const second = Array.from({ length: 5 }, (_, i) => row(i))
    const { service } = makeService([first, second])

    const result = await service.retrieve({ queryId: 'q3', embedding, topK: 20 })

    expect(result.fallbackApplied).toBe(false)
    expect(result.chunks).toHaveLength(5)
  })

  it('rag_retrieval_results に recency/final をスナップショット保存し rankOrder を採番する', async () => {
    const rows = [row(0), row(1)]
    const { service, createMany } = makeService([rows])

    await service.retrieve({ queryId: 'q4', embedding, topK: 2 })

    expect(createMany).toHaveBeenCalledTimes(1)
    const callArg = createMany.mock.calls[0][0] as {
      data: Prisma.RagRetrievalResultCreateManyInput[]
      skipDuplicates: boolean
    }
    expect(callArg.skipDuplicates).toBe(true)
    expect(callArg.data).toHaveLength(2)
    const first = callArg.data[0]
    const second = callArg.data[1]
    if (first === undefined || second === undefined) {
      throw new Error('expected 2 persisted rows')
    }
    expect(first).toMatchObject({
      queryId: 'q4',
      chunkId: 'chunk-0',
      rankOrder: 1,
      usedInAnswer: false,
    })
    expect(second.rankOrder).toBe(2)
    // Decimal でスナップショット保存（金融数値ではないがスコア精度保持）
    expect(first.recencyScore).toBeInstanceOf(Prisma.Decimal)
    expect(first.finalScore).toBeInstanceOf(Prisma.Decimal)
  })

  it('0 件なら createMany を呼ばない（fallback も 0 件）', async () => {
    // 初回 0 件 < topK → fallback が走るため fallback 用の空結果も用意する
    const { service, createMany } = makeService([[], []])
    const result = await service.retrieve({ queryId: 'q5', embedding, topK: 5 })
    expect(result.chunks).toHaveLength(0)
    expect(createMany).not.toHaveBeenCalled()
  })

  it('pg numeric が string で返っても number へ正規化する', async () => {
    const stringRow = {
      ...row(0),
      similarity_score: '0.91' as unknown as number,
      final_score: '0.73' as unknown as number,
    }
    const { service } = makeService([[stringRow]])
    const result = await service.retrieve({ queryId: 'q6', embedding, topK: 1 })
    const chunk = result.chunks[0]
    if (chunk === undefined) {
      throw new Error('expected 1 chunk')
    }
    expect(chunk.similarityScore).toBe(0.91)
    expect(chunk.finalScore).toBe(0.73)
  })
})
