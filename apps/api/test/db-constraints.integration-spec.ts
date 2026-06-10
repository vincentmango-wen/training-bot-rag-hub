/**
 * DB 制約統合テスト — pgvector 実 DB（docker / port 5433）
 *
 * 目的:
 *   Stage2 e2e は DB を全 mock しており、migration で定義した複合FK / CHECK /
 *   部分 unique / HNSW 部分 index が一度も実行されていない。
 *   本スイートは「DB 制約が物理強制する」設計主張を negative control で担保する。
 *
 * 環境変数ガード（必須1 修正 / 2026-06-10）:
 *   DATABASE_URL 未設定 → 全テスト it.skip（明示 skip ログ）。
 *   DATABASE_URL 設定済みだが接続失敗 → beforeAll が throw してスイート fail。
 *   *** 空虚 pass（`if (!prisma) return` で暗黙 PASS）は禁止 ***。
 *
 * 検証対象:
 *   1. 複合 FK negative control: 別クエリの retrieval_result_id で citation INSERT → 拒否
 *      + 複合FK の AND 性質: 実在する集合外 chunk（retrieval 結合外）を使った検証
 *   2. CHECK negative control: order_permission=true で responses/bot_contexts INSERT → 拒否
 *   3. 部分 unique negative control: 同一 (requester_id, idempotency_key) 二重 INSERT → 拒否
 *   4. vector_dims CHECK: 次元不一致 embedding INSERT → 拒否
 *   5. HNSW index scan (Major8): buildRetrievalSql の CTE + EXPLAIN で
 *      idx_emb_hnsw_openai_small_1536 が選択されることを hard assert
 *
 * HNSW テスト戦略（必須2 修正）:
 *   pgvector HNSW の planner コスト計算では、少量データでは Seq Scan が優位と判断される
 *   (設計書 §7.3 「1万チャンク未満では Seq Scan でも動作確認可能」記載と一致)。
 *   本テストでは enable_seqscan=off / enable_bitmapscan=off / enable_indexscan=off を
 *   tx LOCAL スコープで設定し、HNSW index が存在して ANN 検索クエリで使用可能であることを
 *   hard assert する（「index が正しく定義・使用可能か」を確認する目的）。
 *   enable_seqscan=off 依存は最終手段であり、理由をコメントで明記する（§7.3 方針に従う）。
 *   検索クエリは本番 buildRetrievalSql の ann_candidates CTE 構造を直接使用する。
 *
 * 複合FK negative control 精度（推奨5 修正）:
 *   differentChunkId に「実在する集合外 chunk」を使い、拒否が複合FK由来か
 *   単純 chunk FK 由来かを区別して AND 性質を証明する。
 *
 * クリーンアップ:
 *   各テストが作成したデータは FK 順で確実に削除（afterEach / finally ブロック）。
 *   テスト失敗時も orphan 行が残らないよう CASCADE 順を守る。
 *
 * コミット禁止: 作業ツリー残置（横断規約 §8）。
 */

import { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

// 本番の検索 SQL ビルダーを直接 import して EXPLAIN する（必須2(b) / Fable5 Stage4 指摘）。
// テスト独自のリテラル述語ではなく、本番と同一の「パラメータ化述語」を演習する。
import { buildRetrievalSql } from '../src/retrieval/retrieval-sql'
import { DEFAULT_COMPOSITE_WEIGHTS } from '../src/retrieval/composite-score'
import {
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_TOP_K,
  DEFAULT_OVERSAMPLE_FACTOR,
  DEFAULT_PER_DOCUMENT_CAP,
  DEFAULT_RELIABILITY_FLOOR,
  DEFAULT_MAX_STALENESS_DAYS,
} from '../src/retrieval/retrieval.types'

/* -------------------------------------------------------------------------- */
/* 環境変数ガード（必須1）                                                     */
/* -------------------------------------------------------------------------- */

const DB_URL = process.env['DATABASE_URL']

/**
 * DATABASE_URL 未設定時のスキップ用ヘルパー。
 * 「設定済みだが接続失敗」は beforeAll が throw するため本関数は未設定のみ判定する。
 */
function makeSkipSuite(reason: string) {
  if (!DB_URL) {
    console.warn(`[db-constraints.integration] SKIP (DATABASE_URL not set): ${reason}`)
    return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Prisma クライアント（テスト専用 / NestApp 不使用）                         */
/* -------------------------------------------------------------------------- */

let prisma: PrismaClient

beforeAll(async () => {
  // DATABASE_URL 未設定の場合はスキップ（各 describe の it.skip に委任）
  if (!DB_URL) return

  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } })
  try {
    await prisma.$connect()
  } catch (e) {
    // DATABASE_URL が設定されているにもかかわらず接続に失敗した場合は
    // 空虚 pass を作らず throw して beforeAll ごとスイートを fail にする。
    // （必須1: 暗黙 pass = `if (!prisma) return` パターンを排除）
    await prisma.$disconnect().catch(() => undefined)
    throw new Error(
      `[db-constraints.integration] DB connection failed (DATABASE_URL is set but unreachable): ${(e as Error).message}`,
    )
  }
})

afterAll(async () => {
  if (prisma) {
    await prisma.$disconnect()
  }
})

/* -------------------------------------------------------------------------- */
/* テストデータ工場: 最小限の親行を作成して ID を返す                         */
/* -------------------------------------------------------------------------- */

/**
 * rag_sources に 1 行挿入して id を返す。
 * reliability_score は CHECK(0..1) を満たす値を使う。
 */
async function createSource(): Promise<string> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO rag_sources (id, source_type, source_name, display_name, reliability_score, status, updated_at)
    VALUES (${id}::uuid, 'market_data', ${'src-' + id}, ${'Source ' + id}, 0.8, 'ACTIVE', now())
  `
  return id
}

/** rag_documents に 1 行挿入して id を返す。 */
async function createDocument(sourceId: string): Promise<string> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO rag_documents (id, source_id, document_type, raw_content, normalized_content, language, content_hash, metadata, status, updated_at)
    VALUES (${id}::uuid, ${sourceId}::uuid, 'news', 'raw', 'normalized', 'ja', ${'hash-' + id}, '{}', 'INDEXED', now())
  `
  return id
}

/**
 * rag_chunks に 1 行挿入して id を返す。
 * chunkIndex は (document_id, chunk_index) の UNIQUE 制約があるため、
 * 同一 document に複数 chunk を作る場合は呼び出し側が異なる値を指定すること。
 */
async function createChunk(documentId: string, sourceId: string, chunkIndex = 0): Promise<string> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO rag_chunks (id, document_id, source_id, chunk_index, content, content_hash, metadata, source_type, language, status, updated_at)
    VALUES (${id}::uuid, ${documentId}::uuid, ${sourceId}::uuid, ${chunkIndex}, 'chunk content', ${'ch-' + id}, '{}', 'market_data', 'ja', 'ACTIVE', now())
  `
  return id
}

/** rag_queries に 1 行挿入して id を返す（idempotency_key は省略可 / NULL なら部分 unique 対象外）。 */
async function createQuery(requesterId: string, idempotencyKey?: string): Promise<string> {
  const id = randomUUID()
  const iKey = idempotencyKey ?? null
  await prisma.$executeRaw`
    INSERT INTO rag_queries (id, requester_id, query_type, query_text, filters, provider_policy, status, trace_id, request_id, idempotency_key, updated_at)
    VALUES (${id}::uuid, ${requesterId}::uuid, 'GENERAL', 'test query', '{}', 'default', 'RECEIVED', ${'tr-' + id}, ${'req-' + id}, ${iKey}, now())
  `
  return id
}

/** rag_retrieval_results に 1 行挿入して id を返す。 */
async function createRetrievalResult(queryId: string, chunkId: string, documentId: string, sourceId: string): Promise<string> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO rag_retrieval_results (id, query_id, chunk_id, document_id, source_id, rank_order, used_in_answer)
    VALUES (${id}::uuid, ${queryId}::uuid, ${chunkId}::uuid, ${documentId}::uuid, ${sourceId}::uuid, 1, false)
  `
  return id
}

/** rag_responses に 1 行挿入して id を返す（order_permission は常に false）。 */
async function createResponse(queryId: string): Promise<string> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO rag_responses (id, query_id, summary, response_json, risk_level, confidence, order_permission, status, updated_at)
    VALUES (${id}::uuid, ${queryId}::uuid, 'summary', '{}', 'LOW', 0.8, false, 'COMPLETED', now())
  `
  return id
}

/** 1536 次元のダミーベクトルリテラル文字列を生成する。 */
function makeVec1536(seed = 0.01): string {
  return '[' + new Array(1536).fill(seed.toFixed(4)).join(',') + ']'
}

/* -------------------------------------------------------------------------- */
/* 1. 複合 FK negative control（推奨5 精度修正込み）                          */
/* -------------------------------------------------------------------------- */

describe('1. 複合FK negative control: citation whitelist', () => {
  if (makeSkipSuite('複合FK test requires live DB')) {
    it.skip('DATABASE_URL not set — skip', () => undefined)
    return
  }

  it('存在しない retrieval_result_id での citation INSERT は FK 違反で拒否される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkId = await createChunk(documentId, sourceId)
    const requesterIdB = randomUUID()
    const queryIdB = await createQuery(requesterIdB)
    const responseIdB = await createResponse(queryIdB)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_citations WHERE response_id = ${responseIdB}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_responses WHERE id = ${responseIdB}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id = ${queryIdB}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      // 存在しない retrieval_result_id → 複合 FK 拒否
      const nonExistentRetrievalId = randomUUID()
      await expect(
        prisma.$executeRaw`
          INSERT INTO rag_citations
            (id, response_id, retrieval_result_id, source_id, document_id, chunk_id,
             citation_order, used_reason, excerpt, quality_status)
          VALUES
            (${randomUUID()}::uuid, ${responseIdB}::uuid, ${nonExistentRetrievalId}::uuid,
             ${sourceId}::uuid, ${documentId}::uuid, ${chunkId}::uuid,
             1, 'test', 'excerpt text', 'ACTIVE')
        `,
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  /**
   * 推奨5: 複合FK の AND 性質を「実在する集合外 chunk」で検証。
   *
   * 設計: retrieval_result_A は (queryA, chunkA) を保持。
   * outsideChunk は rag_chunks に実在するが、retrieval_result_A の chunk_id とは別物。
   * (retrieval_result_A.id, outsideChunk.id) の組み合わせは
   * fk_rag_citations_retrieval_whitelist の参照先 rag_retrieval_results(id, chunk_id) に
   * 存在しないため複合FK拒否される。
   * outsideChunk は rag_chunks に実在するので「単純 chunk FK 違反」ではなく、
   * 複合FK の AND 性質（retrieval_result_id AND chunk_id の両方が一致する行が必要）に
   * より拒否されることが確認できる。
   */
  it('実在する集合外 chunk との (retrieval_result_id, chunk_id) 組み合わせは複合FK AND 性質で拒否される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)

    // chunkA: queryA の retrieval 集合に含まれる chunk (chunk_index=0)
    const chunkA = await createChunk(documentId, sourceId, 0)

    // outsideChunk: rag_chunks に実在するが queryA の retrieval 集合には含まれない chunk
    // ← これが推奨5の肝: 単純 chunk FK（rag_citations_chunk_id_fkey）は通過できる
    // chunk_index=1 を使い、同一 document 内の (document_id, chunk_index) UNIQUE 制約を回避する
    const outsideChunk = await createChunk(documentId, sourceId, 1)

    const requesterIdA = randomUUID()
    const queryIdA = await createQuery(requesterIdA)
    // retrieval_result_A は (queryA, chunkA) のペア
    const retrievalResultIdA = await createRetrievalResult(queryIdA, chunkA, documentId, sourceId)

    const requesterIdB = randomUUID()
    const queryIdB = await createQuery(requesterIdB)
    const responseIdB = await createResponse(queryIdB)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_citations WHERE response_id = ${responseIdB}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_responses WHERE id = ${responseIdB}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_retrieval_results WHERE id = ${retrievalResultIdA}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id IN (${queryIdA}::uuid, ${queryIdB}::uuid)`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id IN (${chunkA}::uuid, ${outsideChunk}::uuid)`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      // negative control: retrieval_result_A.id は実在するが、chunk_id に outsideChunk を指定。
      // outsideChunk は rag_chunks に実在（単純 chunk FK は通過可能）だが、
      // (retrieval_result_A.id, outsideChunk.id) のペアが
      // rag_retrieval_results(id, chunk_id) に存在しないため複合FK拒否。
      // → これにより「複合FK は retrieval_result_id だけでなく chunk_id の AND も強制する」
      //   ことが証明される（単純 chunk FK 拒否との混同を排除）。
      await expect(
        prisma.$executeRaw`
          INSERT INTO rag_citations
            (id, response_id, retrieval_result_id, source_id, document_id, chunk_id,
             citation_order, used_reason, excerpt, quality_status)
          VALUES
            (${randomUUID()}::uuid, ${responseIdB}::uuid, ${retrievalResultIdA}::uuid,
             ${sourceId}::uuid, ${documentId}::uuid, ${outsideChunk}::uuid,
             2, 'test', 'excerpt text', 'ACTIVE')
        `,
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 2. CHECK negative control: order_permission                                */
/* -------------------------------------------------------------------------- */

describe('2. CHECK negative control: order_permission = false', () => {
  if (makeSkipSuite('CHECK constraint test requires live DB')) {
    it.skip('DATABASE_URL not set — skip', () => undefined)
    return
  }

  it('rag_responses に order_permission=true を INSERT すると CHECK 違反で拒否される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkId = await createChunk(documentId, sourceId)
    const requesterId = randomUUID()
    const queryId = await createQuery(requesterId)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id = ${queryId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      await expect(
        prisma.$executeRaw`
          INSERT INTO rag_responses
            (id, query_id, summary, response_json, risk_level, confidence, order_permission, status, updated_at)
          VALUES
            (${randomUUID()}::uuid, ${queryId}::uuid, 'summary', '{}', 'LOW', 0.8, true, 'COMPLETED', now())
        `,
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('rag_bot_contexts に order_permission=true を INSERT すると CHECK 違反で拒否される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkId = await createChunk(documentId, sourceId)
    const requesterId = randomUUID()
    const botId = randomUUID()
    const queryId = await createQuery(requesterId)
    const responseId = await createResponse(queryId)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_responses WHERE id = ${responseId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id = ${queryId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      await expect(
        prisma.$executeRaw`
          INSERT INTO rag_bot_contexts
            (id, requester_id, bot_id, query_id, response_id, context_json, order_permission)
          VALUES
            (${randomUUID()}::uuid, ${requesterId}::uuid, ${botId}::uuid,
             ${queryId}::uuid, ${responseId}::uuid, '{}', true)
        `,
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 3. 部分 unique negative control: idempotency                               */
/* -------------------------------------------------------------------------- */

describe('3. 部分 unique negative control: idempotency', () => {
  if (makeSkipSuite('partial unique test requires live DB')) {
    it.skip('DATABASE_URL not set — skip', () => undefined)
    return
  }

  it('同一 (requester_id, idempotency_key) の二重 INSERT は unique 違反で拒否される', async () => {
    const requesterId = randomUUID()
    const iKey = 'idem-test-' + randomUUID()
    const queryId1 = await createQuery(requesterId, iKey)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id = ${queryId1}::uuid`
    }

    try {
      await expect(
        createQuery(requesterId, iKey),
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('idempotency_key=NULL は部分 unique 対象外（同一 requester の複数 NULL は許容される）', async () => {
    const requesterId = randomUUID()
    // NULL 行は部分 unique の WHERE "idempotency_key IS NOT NULL" 対象外 → 複数 INSERT 可能
    const queryId1 = await createQuery(requesterId, undefined)
    const queryId2 = await createQuery(requesterId, undefined)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_queries WHERE id IN (${queryId1}::uuid, ${queryId2}::uuid)`
    }

    try {
      // ここまで例外が発生しなければ NULL の複数 INSERT が許容されていることが確認できる
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM rag_queries WHERE id IN (${queryId1}::uuid, ${queryId2}::uuid)
      `
      expect(rows).toHaveLength(2)
    } finally {
      await cleanup()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 4. vector_dims CHECK: 次元不一致 embedding INSERT → 拒否                  */
/* -------------------------------------------------------------------------- */

describe('4. vector_dims CHECK: 次元不一致は拒否される', () => {
  if (makeSkipSuite('vector_dims CHECK test requires live DB')) {
    it.skip('DATABASE_URL not set — skip', () => undefined)
    return
  }

  it('dimension=1536 に対して 3 次元 embedding を INSERT すると CHECK 違反で拒否される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkId = await createChunk(documentId, sourceId)

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_embeddings WHERE chunk_id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      // dimension=1536 と宣言しながら 3 次元ベクトルを渡す → CHECK(vector_dims(embedding) = dimension)
      await expect(
        prisma.$executeRaw`
          INSERT INTO rag_embeddings
            (id, chunk_id, provider, model, dimension, embedding, content_hash, status, embedded_at)
          VALUES
            (${randomUUID()}::uuid, ${chunkId}::uuid, 'openai', 'text-embedding-3-small',
             1536, '[0.1, 0.2, 0.3]'::vector, ${'hash-emb-' + chunkId}, 'ACTIVE', now())
        `,
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('dimension=1536 に対して 1536 次元 embedding は正常に INSERT される', async () => {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkId = await createChunk(documentId, sourceId)
    const embId = randomUUID()

    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_embeddings WHERE id = ${embId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE id = ${chunkId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      const vec1536 = makeVec1536(0.01)
      await prisma.$executeRaw`
        INSERT INTO rag_embeddings
          (id, chunk_id, provider, model, dimension, embedding, content_hash, status, embedded_at)
        VALUES
          (${embId}::uuid, ${chunkId}::uuid, 'openai', 'text-embedding-3-small',
           1536, ${vec1536}::vector, ${'hash-ok-' + chunkId}, 'ACTIVE', now())
      `
      // 挿入成功を確認
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM rag_embeddings WHERE id = ${embId}::uuid
      `
      expect(rows).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 5. HNSW index scan (Major8 / 必須2): buildRetrievalSql 経由 hard assert   */
/* -------------------------------------------------------------------------- */

describe('5. HNSW index scan (Major8): ann_candidates CTE + EXPLAIN でインデックスを hard assert', () => {
  if (makeSkipSuite('HNSW index scan test requires live DB with embeddings')) {
    it.skip('DATABASE_URL not set — skip', () => undefined)
    return
  }

  /**
   * HNSW index scan hard assert（必須2）。
   *
   * 戦略:
   * 1. 数十行の seed（source/document/chunks/embeddings を openai/text-embedding-3-small/1536 で作成）。
   *    多様なベクトルを seed することで ann_candidates CTE が実際に ANN 検索する状態を作る。
   *
   * 2. ann_candidates CTE（buildRetrievalSql の検索コア / 05 §8.1）を使って EXPLAIN を取得。
   *    本番コードで使われる同一 CTE 構造・同一 WHERE 述語・同一キャスト式を使うことで、
   *    「本番クエリが HNSW index を使用可能か」を直接検証する。
   *
   * 3. TX LOCAL スコープで enable_seqscan=off / enable_bitmapscan=off / enable_indexscan=off
   *    を設定して HNSW index scan を強制選択させ、idx_emb_hnsw_openai_small_1536 が
   *    プランに出現することを hard assert する。
   *
   *    enable_seqscan=off 依存の理由（§7.3 準拠）:
   *    pgvector HNSW の planner コスト計算は少量データでは Seq Scan を優先する仕様。
   *    設計書 §7.3 も「1万チャンク未満では index なし seq scan でも動作確認は可能」と記載。
   *    本テストの目的は「index が正しく定義・使用可能か（ANN クエリで index scan できるか）」の
   *    確認であり、enable_seqscan=off での強制選択はその目的に適合する。
   *    テストデータが 1万行を超える環境では自然に HNSW が選ばれ、この設定は不要になる。
   */
  it('ann_candidates CTE 構造で idx_emb_hnsw_openai_small_1536 の Index Scan が使用可能（hard assert）', async () => {
    // テストデータ作成: source/document/chunks/embeddings を 30 件 seed
    // 多様なベクトルは PostgreSQL の random() で生成（完全固定値だと dedup されるため変化を持たせる）
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkIds: string[] = []

    // 30 件の chunk + embedding を作成
    // chunk_index は UNIQUE 制約（document_id, chunk_index）があるため連番を使う
    for (let i = 0; i < 30; i++) {
      const chunkId = randomUUID()
      await prisma.$executeRaw`
        INSERT INTO rag_chunks
          (id, document_id, source_id, chunk_index, content, content_hash, metadata, source_type, language, status, updated_at)
        VALUES
          (${chunkId}::uuid, ${documentId}::uuid, ${sourceId}::uuid,
           ${i}, ${'content-' + i}, ${'ch-' + i + '-' + chunkId}, '{}', 'market_data', 'ja', 'ACTIVE', now())
      `
      // 各 embedding に微妙に異なるベクトル値を使う（シード値を変えた固定値 / 全数同一だと近傍距離が0になる）
      const val = (0.0001 * (i + 1)).toFixed(6)
      const vec = '[' + new Array(1536).fill(val).join(',') + ']'
      await prisma.$executeRaw`
        INSERT INTO rag_embeddings
          (id, chunk_id, provider, model, dimension, embedding, content_hash, status, embedded_at)
        VALUES
          (${randomUUID()}::uuid, ${chunkId}::uuid, 'openai', 'text-embedding-3-small',
           1536, ${vec}::vector, ${'emb-' + chunkId}, 'ACTIVE', now())
      `
      chunkIds.push(chunkId)
    }

    const cleanup = async () => {
      // FK 順: embeddings → chunks → documents → sources
      await prisma.$executeRaw`DELETE FROM rag_embeddings WHERE chunk_id = ANY(${chunkIds.map(id => `${id}`)}::uuid[])`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE document_id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }

    try {
      // クエリベクトル（検索用 / 1536 次元 / 中間値）
      const queryVec = makeVec1536(0.005)

      // ann_candidates CTE の EXPLAIN を TX LOCAL スコープで取得。
      // 本番 buildRetrievalSql（05 §8.1）の ANN コア部分と同一構造・同一 WHERE 述語を使う。
      //
      // TX LOCAL で設定する理由:
      //   - plan_cache_mode = force_custom_plan: パラメータ化述語に対して generic plan ではなく
      //     custom plan（実行時バインド値依存プラン）を強制し、HNSW 部分 index の WHERE 述語が
      //     適用されることを保証する（Major8 の核心 / 05 §9.4 設計注記）
      //   - enable_seqscan=off / enable_bitmapscan=off / enable_indexscan=off:
      //     HNSW ANN index は通常の B-tree index scan とは異なり、ANN 演算子 <=> の
      //     ORDER BY + LIMIT の組み合わせでのみ使用される。少量データでは planner が
      //     コスト優位性から Seq Scan や B-tree を選ぶため、HNSW 固有の Index Scan を
      //     検証するには他のスキャン方式を無効化する必要がある。
      //     本設定は TX LOCAL スコープに限定されているため、他のテストへの影響はない。
      type ExplainRow = { 'QUERY PLAN': string }
      const explainRows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`
        await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`

        // ann_candidates CTE（buildRetrievalSql §8.1 の ANN コア / 本番と同一 WHERE 述語）
        return tx.$queryRaw<ExplainRow[]>`
          EXPLAIN (ANALYZE false, FORMAT TEXT)
          WITH ann_candidates AS (
            SELECT
              e.chunk_id,
              1 - (e.embedding::vector(1536) <=> ${queryVec}::vector(1536)) AS similarity_score
            FROM rag_embeddings e
            WHERE e.provider = 'openai'
              AND e.model = 'text-embedding-3-small'
              AND e.dimension = 1536
              AND e.status = 'ACTIVE'
            ORDER BY e.embedding::vector(1536) <=> ${queryVec}::vector(1536)
            LIMIT 100
          )
          SELECT chunk_id, similarity_score FROM ann_candidates
        `
      })

      const plan = explainRows.map((r) => r['QUERY PLAN']).join('\n')
      console.log('[HNSW EXPLAIN output (enable_seqscan=off / bitmapscan=off / indexscan=off)]\n' + plan)

      // hard assert: idx_emb_hnsw_openai_small_1536 を使った Index Scan がプランに存在する
      // Seq Scan / B-tree による代替スキャンではないことを構造的に保証する。
      const hasHnswIndexScan = plan.includes('idx_emb_hnsw_openai_small_1536')

      if (!hasHnswIndexScan) {
        console.error('[HNSW] FAIL: expected idx_emb_hnsw_openai_small_1536 in EXPLAIN plan but not found.\n' +
          'Actual plan:\n' + plan)
      }

      // hard assert — Seq Scan のままなら FAIL（警告 + pass の旧挙動を廃止）
      expect(hasHnswIndexScan).toBe(true)
    } finally {
      await cleanup()
    }
  })

  /**
   * 正常動作確認: force 設定なしで EXPLAIN が正常に返ること（SQL 合法性の確認）。
   * HNSW index scan を強制しない素の EXPLAIN として force_custom_plan のみ設定する。
   * データ量が少ない場合は Seq Scan になるが、SQL 自体のパース・プランニングが
   * 正常であることを確認する（対照テスト）。
   */
  it('force_custom_plan のみ（seqscan=on）: EXPLAIN が正常に返る（SQL 合法性の対照）', async () => {
    const queryVec = makeVec1536(0.003)

    type ExplainRow = { 'QUERY PLAN': string }
    const explainRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`

      return tx.$queryRaw<ExplainRow[]>`
        EXPLAIN (ANALYZE false, FORMAT TEXT)
        WITH ann_candidates AS (
          SELECT
            e.chunk_id,
            1 - (e.embedding::vector(1536) <=> ${queryVec}::vector(1536)) AS similarity_score
          FROM rag_embeddings e
          WHERE e.provider = 'openai'
            AND e.model = 'text-embedding-3-small'
            AND e.dimension = 1536
            AND e.status = 'ACTIVE'
          ORDER BY e.embedding::vector(1536) <=> ${queryVec}::vector(1536)
          LIMIT 20
        )
        SELECT chunk_id, similarity_score FROM ann_candidates
      `
    })

    const plan = explainRows.map((r) => r['QUERY PLAN']).join('\n')
    console.log('[HNSW EXPLAIN (no seqscan override, force_custom_plan only)]\n' + plan)

    // SQL が正常にプランニングされることを確認（Seq Scan / Index Scan どちらでも可）
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.includes('Seq Scan') || plan.includes('Index Scan')).toBe(true)
  })

  /* ------------------------------------------------------------------------ */
  /* 必須2(b) 修正（Fable5 Stage4 指摘 / 2026-06-10）:                         */
  /*   既存テストは ann_candidates の述語を *リテラル* 直書きしており、本番の    */
  /*   buildRetrievalSql（provider/model/dimension/status を *バインドパラメータ*）*/
  /*   を経由していなかった。Fable5 の実機プローブで「パラメータ化述語 ×        */
  /*   generic plan では HNSW 部分 index が証明できず B-tree+Sort に silent     */
  /*   degrade する」ことが確認された。本番 retrieval.service.ts の             */
  /*   `set local plan_cache_mode = force_custom_plan` が Major8 防御の荷重壁    */
  /*   であり、それを守る回帰テストが 0 件だった。以下 2 テストで構造化する。     */
  /* ------------------------------------------------------------------------ */

  /** 30 件の source/document/chunks/embeddings を seed し cleanup を返す。 */
  async function seedEmbeddings(): Promise<{ cleanup: () => Promise<void> }> {
    const sourceId = await createSource()
    const documentId = await createDocument(sourceId)
    const chunkIds: string[] = []
    for (let i = 0; i < 30; i++) {
      const chunkId = randomUUID()
      await prisma.$executeRaw`
        INSERT INTO rag_chunks
          (id, document_id, source_id, chunk_index, content, content_hash, metadata, source_type, language, status, updated_at)
        VALUES
          (${chunkId}::uuid, ${documentId}::uuid, ${sourceId}::uuid,
           ${i}, ${'content-' + i}, ${'bsql-' + i + '-' + chunkId}, '{}', 'market_data', 'ja', 'ACTIVE', now())
      `
      const val = (0.0001 * (i + 1)).toFixed(6)
      const vec = '[' + new Array(1536).fill(val).join(',') + ']'
      await prisma.$executeRaw`
        INSERT INTO rag_embeddings
          (id, chunk_id, provider, model, dimension, embedding, content_hash, status, embedded_at)
        VALUES
          (${randomUUID()}::uuid, ${chunkId}::uuid, 'openai', 'text-embedding-3-small',
           1536, ${vec}::vector, ${'bsqlemb-' + chunkId}, 'ACTIVE', now())
      `
      chunkIds.push(chunkId)
    }
    const cleanup = async () => {
      await prisma.$executeRaw`DELETE FROM rag_embeddings WHERE chunk_id = ANY(${chunkIds.map((id) => `${id}`)}::uuid[])`
      await prisma.$executeRaw`DELETE FROM rag_chunks WHERE document_id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_documents WHERE id = ${documentId}::uuid`
      await prisma.$executeRaw`DELETE FROM rag_sources WHERE id = ${sourceId}::uuid`
    }
    return { cleanup }
  }

  /** 本番 buildRetrievalSql の出力（パラメータ化述語）を生成する。 */
  function buildProductionSql(): Prisma.Sql {
    return buildRetrievalSql({
      embedding: new Array(1536).fill(0.005) as number[],
      provider: DEFAULT_EMBEDDING_PROVIDER,
      model: DEFAULT_EMBEDDING_MODEL,
      dimension: DEFAULT_EMBEDDING_DIMENSION,
      topK: DEFAULT_TOP_K,
      oversampleFactor: DEFAULT_OVERSAMPLE_FACTOR,
      perDocumentCap: DEFAULT_PER_DOCUMENT_CAP,
      filters: {},
      visibility: {
        reliabilityFloor: DEFAULT_RELIABILITY_FLOOR,
        maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
      },
      weights: DEFAULT_COMPOSITE_WEIGHTS,
    })
  }

  type ExplainRow = { 'QUERY PLAN': string }

  /**
   * 必須2(b): 本番 buildRetrievalSql（バインドパラメータ述語）× force_custom_plan で
   * HNSW 部分 index が選択されることを hard assert。
   * 既存テストはリテラル述語だったため generic-plan degrade 経路を演習できていなかった。
   */
  it('本番 buildRetrievalSql（パラメータ化述語）+ force_custom_plan で HNSW index scan を hard assert', async () => {
    const { cleanup } = await seedEmbeddings()
    try {
      const sql = buildProductionSql()
      const explainRows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`
        await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`
        return tx.$queryRaw<ExplainRow[]>(
          Prisma.sql`EXPLAIN (ANALYZE false, FORMAT TEXT) ${sql}`,
        )
      })
      const plan = explainRows.map((r) => r['QUERY PLAN']).join('\n')
      console.log('[buildRetrievalSql EXPLAIN / force_custom_plan]\n' + plan)
      // hard assert: 本番 SQL でも HNSW 部分 index が選ばれる。
      expect(plan.includes('idx_emb_hnsw_openai_small_1536')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  /**
   * 必須2(b) negative control: 部分 index 述語（provider/model/dimension）を
   * バインドパラメータ化した PREPARE 文を force_generic_plan で実行すると HNSW 部分 index が
   * 選ばれず degrade することを assert（force_custom_plan では HNSW が選ばれる対照付き）。
   *
   * なぜ PREPARE か（Fable5 Stage4 実機プローブの忠実再現）:
   *   Prisma の $queryRaw 経由（単発実行）では plan_cache_mode が generic plan を
   *   トリガーせず degrade が再現しなかった。Major8 の核心「generic plan ではバインド値が
   *   見えず部分 index の WHERE 述語が証明できない」を演習するには、PREPARE した文を
   *   force_generic_plan で EXECUTE する必要がある（Fable5 のプローブと同形）。
   *   これにより本番 retrieval.service.ts の force_custom_plan が「荷重壁」であること
   *   （剥がすと Major8 が再発すること）が SQL/プロトコル層で構造的に証明される。
   */
  it('negative control: force_generic_plan では HNSW が選ばれず force_custom_plan で選ばれる（荷重壁の証明）', async () => {
    const { cleanup } = await seedEmbeddings()
    // 部分 index 述語をバインドパラメータ化（本番 retrieval-sql と同形）。
    // クエリベクトルはリテラル埋め込み（本番 buildRetrievalSql も toVectorLiteral でリテラル）。
    const queryVec = makeVec1536(0.005)
    const prepareSql =
      `PREPARE ann_neg(text, text, int) AS ` +
      `SELECT e.chunk_id ` +
      `FROM rag_embeddings e ` +
      `WHERE e.provider = $1 AND e.model = $2 AND e.dimension = $3 AND e.status = 'ACTIVE' ` +
      `ORDER BY e.embedding::vector(1536) <=> '${queryVec}'::vector(1536) ` +
      `LIMIT 20`

    async function explainExecute(planMode: 'force_generic_plan' | 'force_custom_plan'): Promise<string> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode = ${planMode}`)
        await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 100`)
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`)
        await tx.$executeRawUnsafe(prepareSql)
        const rows = await tx.$queryRawUnsafe<ExplainRow[]>(
          `EXPLAIN (ANALYZE false, FORMAT TEXT) EXECUTE ann_neg('openai', 'text-embedding-3-small', 1536)`,
        )
        await tx.$executeRawUnsafe(`DEALLOCATE ann_neg`)
        return rows.map((r) => r['QUERY PLAN']).join('\n')
      })
    }

    try {
      const generic = await explainExecute('force_generic_plan')
      const custom = await explainExecute('force_custom_plan')
      console.log('[PREPARE EXPLAIN / force_generic_plan]\n' + generic)
      console.log('[PREPARE EXPLAIN / force_custom_plan]\n' + custom)
      // generic plan: バインド値が見えず部分 index 述語を証明できない → HNSW 不使用（degrade）。
      expect(generic.includes('idx_emb_hnsw_openai_small_1536')).toBe(false)
      // custom plan: バインド値が確定し部分 index 述語が証明される → HNSW 使用。
      expect(custom.includes('idx_emb_hnsw_openai_small_1536')).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
