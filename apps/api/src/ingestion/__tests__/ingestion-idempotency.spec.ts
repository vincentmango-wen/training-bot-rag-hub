import { Prisma } from '@prisma/client'
import { IngestionService } from '../ingestion.service'
import { IdempotencyConflictError } from '../idempotency-conflict.error'
import { StubEmbeddingProvider } from '../testing/stub-embedding-provider'
import { stableHashOfJson } from '../content-hash'
import type { IngestionJobInput } from '../ingestion.types'

/**
 * 冪等ガード（横断規約 §3）の単体テスト。
 * Prisma を mock し、claim-first の replay / 409 / 新規 / レース解決を検証する。
 * OpenAI 実呼び出しは StubEmbeddingProvider で完全に排除する（API キー不要）。
 */

/**
 * @param overrides 上書き（idempotencyKey は string のみ）。
 * @param omitIdempotencyKey true なら idempotencyKey を付けない（冪等性なし呼び出し）。
 */
function baseInput(
  overrides: Partial<Omit<IngestionJobInput, 'idempotencyKey'>> & { idempotencyKey?: string } = {},
  omitIdempotencyKey = false,
): IngestionJobInput {
  const base: IngestionJobInput = {
    sourceId: '11111111-1111-1111-1111-111111111111',
    sourceType: 'strategy_doc',
    jobType: 'internal_sync',
    idempotencyKey: 'key-1',
    items: [],
    traceId: 'trace-1',
    requestId: 'req-1',
  }
  const merged = { ...base, ...overrides }
  if (omitIdempotencyKey) {
    const { idempotencyKey: _omit, ...rest } = merged
    void _omit
    return rest
  }
  return merged
}

/** payload_hash は service と同じロジックで再現する（test の期待値計算用）。 */
function expectedPayloadHash(input: IngestionJobInput): string {
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

function makeService(prismaMock: unknown): {
  service: IngestionService
  stub: StubEmbeddingProvider
} {
  const stub = new StubEmbeddingProvider()
  const service = new IngestionService(
    prismaMock as never,
    stub,
  )
  return { service, stub }
}

describe('IngestionService — 冪等 claim（横断規約 §3）', () => {
  it('idempotency_key なし → 常に新規ジョブ（replayed=false）', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'job-new' })
    const prisma = {
      ragIngestionJob: {
        create,
        update: jest.fn().mockResolvedValue({}),
      },
    }
    const input = baseInput({}, true)
    const { service } = makeService(prisma)

    const result = await service.ingest(input)

    expect(result.replayed).toBe(false)
    expect(result.jobId).toBe('job-new')
    // idempotency_key なしは payload_hash も null で INSERT。
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: null, payloadHash: null }),
      }),
    )
  })

  it('同一キー + payload_hash 一致 → replay（既存ジョブを 200 返却 / 再課金なし）', async () => {
    const input = baseInput()
    const hash = expectedPayloadHash(input)
    const prisma = {
      ragIngestionJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-existing', payloadHash: hash }),
        create: jest.fn(),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'job-existing',
          status: 'INDEXED',
          totalCount: 0,
          successCount: 0,
          failedCount: 0,
          traceId: 'trace-1',
          requestId: 'req-1',
          items: [],
        }),
      },
    }
    const { service } = makeService(prisma)

    const result = await service.ingest(input)

    expect(result.replayed).toBe(true)
    expect(result.jobId).toBe('job-existing')
    // replay は新規 INSERT しない。
    expect(prisma.ragIngestionJob.create).not.toHaveBeenCalled()
  })

  it('同一キー + payload_hash 不一致 → 409 IdempotencyConflictError', async () => {
    const input = baseInput()
    const prisma = {
      ragIngestionJob: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'job-existing', payloadHash: 'DIFFERENT_HASH' }),
        create: jest.fn(),
      },
    }
    const { service } = makeService(prisma)

    await expect(service.ingest(input)).rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(prisma.ragIngestionJob.create).not.toHaveBeenCalled()
  })

  it('claim レース（INSERT が P2002）→ 再読込して replay 判定に倒す', async () => {
    const input = baseInput()
    const hash = expectedPayloadHash(input)
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    })
    const prisma = {
      ragIngestionJob: {
        // 1 回目: 未登録 → null。2 回目（レース後の再読込）: winner を返す。
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'job-winner', payloadHash: hash }),
        create: jest.fn().mockRejectedValue(p2002),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'job-winner',
          status: 'INDEXED',
          totalCount: 0,
          successCount: 0,
          failedCount: 0,
          traceId: 'trace-1',
          requestId: 'req-1',
          items: [],
        }),
      },
    }
    const { service } = makeService(prisma)

    const result = await service.ingest(input)

    expect(result.replayed).toBe(true)
    expect(result.jobId).toBe('job-winner')
    expect(prisma.ragIngestionJob.findFirst).toHaveBeenCalledTimes(2)
  })
})
