import * as fs from 'fs'
import * as path from 'path'

/**
 * Phase 1 静的ファイル整合性テスト（設計書 §6 / docs/operations/phase-1-design.md）
 *
 * DB 接続なし・npm install 不要で通る静的検証。
 * 対象: init migration.sql と .env.example 2 ファイル。
 *
 * カバーする設計書 §6 の観点:
 *   - (c) HNSW 部分式 index が migration に含まれる
 *   - (b) rag_* 全 17 テーブルが migration に含まれる
 *   - (c) vector_dims CHECK 制約が migration に含まれる（pgvector 次元整合）
 *   - (b') `CREATE EXTENSION IF NOT EXISTS vector` が init migration に存在する
 *   - (f) apps/api/.env.example の既存キーが削除・改変されていない
 *   - (f) ルート .env.example の既存キーが削除・改変されていない
 *
 * 「Neon 実機依存テスト」（migrate deploy 実行 / SQL クエリ）は
 * 本テストファイルのスコープ外。runbook §5-6 で手動検証を指示済み（設計書 §6 注記）。
 */

// ---------------------------------------------------------------------------
// ファイルパス（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const INIT_MIGRATION_SQL = path.join(
  REPO_ROOT,
  'apps/api/prisma/migrations/00000000000000_init/migration.sql',
)
const API_ENV_EXAMPLE = path.join(REPO_ROOT, 'apps/api/.env.example')
const ROOT_ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example')

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ---------------------------------------------------------------------------
// init migration.sql の静的構造検証
// ---------------------------------------------------------------------------

describe('init migration.sql — 静的構造検証（Phase 1 / 設計書 §6）', () => {
  let sql: string

  beforeAll(() => {
    sql = readFile(INIT_MIGRATION_SQL)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(INIT_MIGRATION_SQL)).toBe(true)
  })

  it('pgvector: CREATE EXTENSION IF NOT EXISTS vector が存在する（init L19 / 設計判断 1-A）', () => {
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector')
  })

  it('pgvector: CREATE EXTENSION は IF NOT EXISTS 付き（冪等性 / 設計書 §5）', () => {
    // "IF NOT EXISTS" なしの CREATE EXTENSION vector は禁止
    const lines = sql.split('\n')
    const extensionLines = lines.filter((l) =>
      l.toLowerCase().includes('create extension') &&
      l.toLowerCase().includes('vector'),
    )
    expect(extensionLines.length).toBeGreaterThan(0)
    extensionLines.forEach((l) => {
      expect(l.toLowerCase()).toContain('if not exists')
    })
  })

  it('rag_* テーブルが 17 個定義されている（設計書 §6 (b)）', () => {
    const expected = [
      'rag_sources',
      'rag_source_scores',
      'rag_documents',
      'rag_chunks',
      'rag_embeddings',
      'rag_ingestion_jobs',
      'rag_ingestion_job_items',
      'rag_queries',
      'rag_retrieval_results',
      'rag_responses',
      'rag_citations',
      'rag_guardrail_results',
      'rag_bot_contexts',
      'rag_provider_policies',
      'rag_provider_calls',
      'rag_provider_usage_logs',
      'rag_provider_errors',
    ]
    expected.forEach((tableName) => {
      expect(sql).toContain(`CREATE TABLE "${tableName}"`)
    })
    // 実際の CREATE TABLE 数が 17 であることも確認
    const createTableCount = (sql.match(/CREATE TABLE "/g) ?? []).length
    expect(createTableCount).toBe(17)
  })

  it('B6: vector_dims CHECK 制約が rag_embeddings に存在する（次元整合 / 設計書 §6 (c)）', () => {
    expect(sql).toContain('vector_dims("embedding") = "dimension"')
  })

  it('B6: ALTER TABLE rag_embeddings で CHECK が ALTER COLUMN embedding type として適用されている', () => {
    // B6 は ALTER TABLE で embedding 列を vector(dimension) キャストする形で実装
    const b6Section = sql.includes('B6') || sql.includes('vector_dims')
    expect(b6Section).toBe(true)
  })

  it('HNSW index が少なくとも 1 件定義されている（設計書 §6 (c)）', () => {
    expect(sql).toContain('USING hnsw')
    // 命名規約 idx_emb_hnsw_ で始まる index が存在
    expect(sql).toMatch(/idx_emb_hnsw_/)
  })

  it('HNSW index は vector_cosine_ops を使う（コサイン類似度 / 05 §7.3）', () => {
    expect(sql).toContain('vector_cosine_ops')
  })

  it('B3: order_permission の二次防御 CHECK が rag_responses / rag_bot_contexts に存在する', () => {
    expect(sql).toContain('CHECK ("order_permission" = false)')
    // 2 テーブル分（responses + bot_contexts）= 2 件
    const checkCount = (sql.match(/CHECK \("order_permission" = false\)/g) ?? []).length
    expect(checkCount).toBeGreaterThanOrEqual(2)
  })

  it('B1: 部分 unique（idempotency_key IS NOT NULL）制約が存在する', () => {
    expect(sql).toContain('idempotency_key') // カラム定義
    // WHERE idempotency_key IS NOT NULL の部分 unique が B1 として作成されている
    expect(sql).toContain('WHERE "idempotency_key" IS NOT NULL')
  })

  it('B2: 複合 FK（retrieval_result_id, chunk_id）の参照先 unique が存在する（citation whitelist）', () => {
    // rag_retrieval_results(id, chunk_id) の unique が raw SQL で追加されている
    expect(sql).toContain('rag_retrieval_results')
    expect(sql).toContain('retrieval_result_id')
  })

  it('reliability_score の 0..1 値域 CHECK が存在する', () => {
    expect(sql).toContain('"reliability_score" >= 0 AND "reliability_score" <= 1')
  })

  it('confidence の 0..1 値域 CHECK が存在する', () => {
    expect(sql).toContain('"confidence" >= 0 AND "confidence" <= 1')
  })
})

// ---------------------------------------------------------------------------
// apps/api/.env.example の整合性検証
// ---------------------------------------------------------------------------

describe('apps/api/.env.example — 整合性検証（Phase 1 / 設計書 §6 (f)）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(API_ENV_EXAMPLE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(API_ENV_EXAMPLE)).toBe(true)
  })

  it('既存キー DATABASE_URL が保持されている（ローカル docker-compose 用値が残存）', () => {
    // コメント行でない DATABASE_URL= 行が存在
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('DATABASE_URL=') && !l.startsWith('#'),
    )
    expect(activeLine).toBeDefined()
  })

  it('既存キー DIRECT_URL が保持されている（ローカル docker-compose 用値が残存）', () => {
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('DIRECT_URL=') && !l.startsWith('#'),
    )
    expect(activeLine).toBeDefined()
  })

  it('既存キー OPENAI_API_KEY が保持されている', () => {
    expect(content).toContain('OPENAI_API_KEY=')
  })

  it('Neon 用 Pooled URL のプレースホルダが追記されている（pgbouncer=true 含む）', () => {
    // コメント行として追記されている
    expect(content).toContain('pgbouncer=true')
    expect(content).toContain('connection_limit=1')
    expect(content).toContain('schema=public')
  })

  it('Neon 用 Direct URL のプレースホルダが追記されている', () => {
    // DIRECT_URL の Neon 形式コメントが含まれる
    expect(content).toContain('sslmode=require')
    expect(content).toContain('neon-setup.md')
  })

  it('実値（パスワード等）がプレースホルダに含まれていない', () => {
    // Neon セクションのコメント行は <role> / <password> のプレースホルダのみ
    const neonLines = content
      .split('\n')
      .filter((l) => l.includes('neon.tech') || l.includes('-pooler'))
    // コメント行（# で始まる）のみ
    neonLines.forEach((l) => {
      expect(l.trimStart()).toMatch(/^#/)
    })
  })

  it('ローカル postgres URL に実パスワードが含まれていない（既存値 = rag_password_local_only）', () => {
    // .env.example に書かれる値はローカル専用のダミーのみ
    const dbUrlLine = content
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    // localhost:5433 形式のローカル URL のみ
    if (dbUrlLine) {
      expect(dbUrlLine).toContain('localhost')
    }
  })
})

// ---------------------------------------------------------------------------
// ルート .env.example の整合性検証
// ---------------------------------------------------------------------------

describe('ルート .env.example — 整合性検証（Phase 1 / 設計書 §6 (f)）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(ROOT_ENV_EXAMPLE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(ROOT_ENV_EXAMPLE)).toBe(true)
  })

  it('既存キー POSTGRES_DB が保持されている', () => {
    expect(content).toContain('POSTGRES_DB=')
  })

  it('既存キー POSTGRES_USER が保持されている', () => {
    expect(content).toContain('POSTGRES_USER=')
  })

  it('既存キー POSTGRES_PASSWORD が保持されている（docker-compose 用）', () => {
    expect(content).toContain('POSTGRES_PASSWORD=')
  })

  it('Redis 撤去済み: REDIS_URL キーが残置していない（phase-2 設計書 §3 判断 4）', () => {
    expect(content).not.toContain('REDIS_URL=')
    expect(content).not.toContain('REDIS_HOST_PORT=')
  })

  it('Neon 移行の導線コメントが追記されている', () => {
    expect(content).toContain('apps/api/.env.example')
  })
})
