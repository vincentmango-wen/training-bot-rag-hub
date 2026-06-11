import * as fs from 'fs'
import * as path from 'path'

/**
 * Phase 2 静的ファイル整合性テスト（設計書 §6 / docs/operations/phase-2-design.md）
 *
 * DB 接続なし・npm install 不要で通る静的検証。
 * phase1-migration-static.spec.ts と同型のスタイルを踏襲する。
 *
 * カバーする設計書 §6 の観点:
 *   - vercel.json が JSON として parse でき builds[0].src / use / routes catch-all が正しい
 *   - docker-compose.yml に redis / rag_redis_data が残存しない / postgres と rag_local は残る
 *   - ルート package.json に redis:cli が残存しない / docker:up 等の既存 scripts は保持
 *   - apps/api/package.json に @pmtp/shared (file: プロトコル) と postinstall: prisma generate が存在
 *
 * 「Vercel 実機 / supertest を使った HTTP 検証」はスコープ外（設計書 §6 注記）。
 */

// ---------------------------------------------------------------------------
// ファイルパス（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const VERCEL_JSON = path.join(REPO_ROOT, 'vercel.json')
const DOCKER_COMPOSE = path.join(REPO_ROOT, 'docker-compose.yml')
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json')
const API_PACKAGE_JSON = path.join(REPO_ROOT, 'apps/api/package.json')

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readJson<T = unknown>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ---------------------------------------------------------------------------
// vercel.json の静的構造検証
// ---------------------------------------------------------------------------

describe('vercel.json — 静的構造検証（Phase 2 / 設計書 §6）', () => {
  type Route = { src: string; dest: string }
  type VercelJson = {
    version: number
    builds: Array<{ src: string; use: string; config?: Record<string, unknown> }>
    routes: Route[]
  }

  let config: VercelJson

  beforeAll(() => {
    config = readJson<VercelJson>(VERCEL_JSON)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(VERCEL_JSON)).toBe(true)
  })

  it('JSON として parse できる', () => {
    expect(config).toBeDefined()
    expect(typeof config).toBe('object')
  })

  it('version が 2 である', () => {
    expect(config.version).toBe(2)
  })

  it('builds[0].src が "apps/api/api/index.ts" である（設計書 §6 / 判断 1 案 A）', () => {
    expect(config.builds).toHaveLength(1)
    expect(config.builds[0]!.src).toBe('apps/api/api/index.ts')
  })

  it('builds[0].use が "@vercel/node" である', () => {
    expect(config.builds[0]!.use).toBe('@vercel/node')
  })

  it('routes に catch-all が存在する（全パスをハンドラへ委譲 / 設計書 §4-4）', () => {
    const catchAll = config.routes.find(
      (r) => r.src === '/(.*)',
    )
    expect(catchAll).toBeDefined()
    expect(catchAll?.dest).toBe('/apps/api/api/index.ts')
  })

  it('routes に /health の明示ルートが存在する（prefix 除外パス）', () => {
    const healthRoute = config.routes.find((r) => r.src === '/health')
    expect(healthRoute).toBeDefined()
    expect(healthRoute?.dest).toBe('/apps/api/api/index.ts')
  })

  it('routes に /api/v1/(.*) の明示ルートが存在する', () => {
    const apiRoute = config.routes.find((r) => r.src === '/api/v1/(.*)')
    expect(apiRoute).toBeDefined()
    expect(apiRoute?.dest).toBe('/apps/api/api/index.ts')
  })

  it('serverless-express を依存に持っていない（判断 1 案 A 採用 = Lambda 変換層不要）', () => {
    // vercel.json の builds config に @vendia/serverless-express の言及がないこと
    const buildsStr = JSON.stringify(config.builds)
    expect(buildsStr).not.toContain('serverless-express')
  })

  it('apps/api/api/index.ts ファイルが実際に存在する（vercel.json のエントリ参照先）', () => {
    const build = config.builds[0]
    expect(build).toBeDefined()
    const entryPath = path.join(REPO_ROOT, build!.src)
    expect(fs.existsSync(entryPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// docker-compose.yml の静的構造検証（Redis 撤去確認）
// ---------------------------------------------------------------------------

describe('docker-compose.yml — Redis 撤去確認（Phase 2 / 設計書 §3 判断 4）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(DOCKER_COMPOSE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(DOCKER_COMPOSE)).toBe(true)
  })

  it('services.redis が残存しない（撤去済み）', () => {
    // "redis:" という service キーが存在しないこと
    // postgres サービスと区別するため "  redis:" の形を見る
    expect(content).not.toMatch(/^\s{2}redis:\s*$/m)
  })

  it('rag_redis_data volume が残存しない（撤去済み）', () => {
    expect(content).not.toContain('rag_redis_data')
  })

  it('services.postgres が保持されている（ローカル開発用）', () => {
    expect(content).toContain('postgres:')
  })

  it('networks.rag_local が保持されている（postgres が参照中）', () => {
    expect(content).toContain('rag_local')
  })

  it('rag_postgres_data volume が保持されている', () => {
    expect(content).toContain('rag_postgres_data')
  })
})

// ---------------------------------------------------------------------------
// ルート package.json の整合性検証
// ---------------------------------------------------------------------------

describe('ルート package.json — Redis 残置物撤去確認（Phase 2 / 設計書 §4-6）', () => {
  type Scripts = Record<string, string>
  type PackageJson = { scripts: Scripts }

  let pkg: PackageJson

  beforeAll(() => {
    pkg = readJson<PackageJson>(ROOT_PACKAGE_JSON)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(ROOT_PACKAGE_JSON)).toBe(true)
  })

  it('redis:cli が残存しない（撤去済み / 設計書 §4-6）', () => {
    expect(pkg.scripts).not.toHaveProperty('redis:cli')
  })

  it('docker:up が保持されている（postgres 操作用）', () => {
    expect(pkg.scripts).toHaveProperty('docker:up')
  })

  it('docker:down が保持されている', () => {
    expect(pkg.scripts).toHaveProperty('docker:down')
  })

  it('db:psql が保持されている（postgres 接続用）', () => {
    expect(pkg.scripts).toHaveProperty('db:psql')
  })

  it('test script が保持されている', () => {
    expect(pkg.scripts).toHaveProperty('test')
  })
})

// ---------------------------------------------------------------------------
// apps/api/package.json の整合性検証
// ---------------------------------------------------------------------------

describe('apps/api/package.json — serverless 対応依存確認（Phase 2 / 設計書 §4-3）', () => {
  type PackageJson = {
    scripts: Record<string, string>
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  let pkg: PackageJson

  beforeAll(() => {
    pkg = readJson<PackageJson>(API_PACKAGE_JSON)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(API_PACKAGE_JSON)).toBe(true)
  })

  it('@pmtp/shared が file: プロトコルで dependencies に存在する（設計書 §3 判断 3 案 A）', () => {
    expect(pkg.dependencies).toHaveProperty('@pmtp/shared')
    expect(pkg.dependencies['@pmtp/shared']).toMatch(/^file:/)
  })

  it('@pmtp/shared の file: パスが ../../packages/shared を指している', () => {
    expect(pkg.dependencies['@pmtp/shared']).toBe('file:../../packages/shared')
  })

  it('postinstall に "prisma generate" が設定されている（Vercel build 時の Prisma client 生成）', () => {
    expect(pkg.scripts).toHaveProperty('postinstall')
    expect(pkg.scripts['postinstall']).toContain('prisma generate')
  })

  it('typecheck:vercel が scripts に存在する（api/tsconfig.json を使う型検証）', () => {
    expect(pkg.scripts).toHaveProperty('typecheck:vercel')
    expect(pkg.scripts['typecheck:vercel']).toContain('api/tsconfig.json')
  })

  it('@vendia/serverless-express が dependencies に存在しない（判断 1 案 A / 依存追加ゼロ）', () => {
    expect(pkg.dependencies).not.toHaveProperty('@vendia/serverless-express')
  })

  it('NestJS コア依存が保持されている', () => {
    expect(pkg.dependencies).toHaveProperty('@nestjs/core')
    expect(pkg.dependencies).toHaveProperty('@nestjs/common')
    expect(pkg.dependencies).toHaveProperty('@nestjs/platform-express')
  })
})

// ---------------------------------------------------------------------------
// api/tsconfig.json の静的構造検証
// ---------------------------------------------------------------------------

describe('apps/api/api/tsconfig.json — typecheck:vercel 用設定確認（Phase 2 / 設計書 §4-2）', () => {
  type TsConfigJson = {
    extends?: string
    compilerOptions: {
      rootDir?: string
      noEmit?: boolean
    }
    include?: string[]
  }

  const API_TSCONFIG = path.join(REPO_ROOT, 'apps/api/api/tsconfig.json')
  let tsconfig: TsConfigJson

  beforeAll(() => {
    tsconfig = readJson<TsConfigJson>(API_TSCONFIG)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(API_TSCONFIG)).toBe(true)
  })

  it('rootDir が ".." に設定されている（TS6059 回避 / api/ が src/ 外にあるため）', () => {
    expect(tsconfig.compilerOptions.rootDir).toBe('..')
  })

  it('noEmit が true である（Vercel がコンパイルするため emit 不要）', () => {
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
  })

  it('include に api/ 配下の TS が含まれている', () => {
    const include = tsconfig.include ?? []
    const hasApiDir = include.some((p) => p.startsWith('./**') || p.startsWith('./'))
    expect(hasApiDir).toBe(true)
  })

  it('include に src/ 配下の TS が含まれている（create-app.ts 等を型解決するため）', () => {
    const include = tsconfig.include ?? []
    const hasSrcDir = include.some((p) => p.includes('src'))
    expect(hasSrcDir).toBe(true)
  })
})
