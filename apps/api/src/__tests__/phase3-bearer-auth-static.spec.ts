import * as fs from 'fs'
import * as path from 'path'

/**
 * Phase 3 静的ファイル整合性テスト（設計書 §6 / docs/operations/phase-3-design.md）
 *
 * DB 接続なし・npm install 不要で通る静的検証。
 * phase1-migration-static.spec.ts / phase2-serverless-static.spec.ts と同型のスタイル。
 *
 * カバーする設計書 §6 の観点:
 *   - ケース 10（静的パート）: APP_GUARD が app.module.ts に登録済みであること
 *     （BearerTokenGuard が全ルートに効く構造になっているか）
 *   - common/guards/ ディレクトリと guard ファイルが存在すること
 *     （guardrail/ との誤配置がないこと / 設計書 §7 architecture 観点）
 *   - .env.example ×2 に API_BEARER_TOKEN が追記されていること
 *     （設計書 §4-4 / §7 quality 観点）
 *   - apps/api/.env.example の API_BEARER_TOKEN に実値らしき文字列が入っていないこと
 *     （設計書 §7 quality 観点 / 情報漏れ防止）
 *   - ルート .env.example の API_BEARER_TOKEN に実値らしき文字列が入っていないこと
 *   - create-app.ts / api/index.ts が Phase 3 で無改変であること
 *     （設計書 §7 architecture 観点 / 判断 1 案 A の確認）
 *   - app.module.ts が create-app.ts / api/index.ts 以外の起点ファイルに setGlobalPrefix
 *     や bootstrap 処理を持ち込んでいないこと（Phase 3 スコープの閉じ確認）
 *
 * 「Vercel 実機 / supertest を使った HTTP 検証」はスコープ外（設計書 §6 統合テスト観点は
 * create-app.spec.ts の HTTP 層テストでカバー済み）。
 */

// ---------------------------------------------------------------------------
// ファイルパス（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const APP_MODULE = path.join(REPO_ROOT, 'apps/api/src/app.module.ts')
const GUARD_FILE = path.join(REPO_ROOT, 'apps/api/src/common/guards/bearer-token.guard.ts')
const GUARD_SPEC_FILE = path.join(REPO_ROOT, 'apps/api/src/common/guards/bearer-token.guard.spec.ts')
const GUARDS_DIR = path.join(REPO_ROOT, 'apps/api/src/common/guards')
const COMMON_DIR = path.join(REPO_ROOT, 'apps/api/src/common')
const API_ENV_EXAMPLE = path.join(REPO_ROOT, 'apps/api/.env.example')
const ROOT_ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example')
const CREATE_APP_PATH = path.join(REPO_ROOT, 'apps/api/src/create-app.ts')
const HANDLER_PATH = path.join(REPO_ROOT, 'apps/api/api/index.ts')

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ---------------------------------------------------------------------------
// app.module.ts — APP_GUARD 登録確認（設計書 §4-3 / ケース 10 静的パート）
// ---------------------------------------------------------------------------

describe('app.module.ts — APP_GUARD 登録確認（Phase 3 / 設計書 §4-3）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(APP_MODULE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(APP_MODULE)).toBe(true)
  })

  it('APP_GUARD を @nestjs/core から import している', () => {
    // グローバル guard の DI 登録に必要
    expect(content).toMatch(/from ['"]@nestjs\/core['"]/)
    expect(content).toContain('APP_GUARD')
  })

  it('BearerTokenGuard を common/guards から import している', () => {
    // guardrail/ との誤配置チェック（設計書 §7 architecture 観点）
    expect(content).toMatch(/from ['"]\.\/common\/guards\/bearer-token\.guard['"]/)
    expect(content).toContain('BearerTokenGuard')
  })

  it('providers に APP_GUARD + BearerTokenGuard の組み合わせが存在する（グローバル登録）', () => {
    // { provide: APP_GUARD, useClass: BearerTokenGuard } の形を静的に確認
    expect(content).toContain('APP_GUARD')
    expect(content).toContain('BearerTokenGuard')
    // providers 配列内での利用（コメントアウトされていないこと）
    const uncommentedProviders = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    expect(uncommentedProviders).toContain('APP_GUARD')
    expect(uncommentedProviders).toContain('BearerTokenGuard')
  })

  it('providers セクションに useClass: BearerTokenGuard が含まれる', () => {
    expect(content).toContain('useClass: BearerTokenGuard')
  })

  it('BearerTokenGuard import が guardrail/ からではない（誤配置でないこと）', () => {
    // guardrail/ 配下からの import がないことを確認
    const lines = content.split('\n')
    const guardImport = lines.find((l) => l.includes('BearerTokenGuard'))
    expect(guardImport).toBeDefined()
    expect(guardImport).not.toContain('guardrail')
  })
})

// ---------------------------------------------------------------------------
// common/guards/ — ファイル構造確認（設計書 §3 / §7 architecture 観点）
// ---------------------------------------------------------------------------

describe('common/guards/ — ファイル構造確認（Phase 3 / 設計書 §4-1）', () => {
  it('apps/api/src/common/ ディレクトリが存在する', () => {
    expect(fs.existsSync(COMMON_DIR)).toBe(true)
    expect(fs.statSync(COMMON_DIR).isDirectory()).toBe(true)
  })

  it('apps/api/src/common/guards/ ディレクトリが存在する', () => {
    expect(fs.existsSync(GUARDS_DIR)).toBe(true)
    expect(fs.statSync(GUARDS_DIR).isDirectory()).toBe(true)
  })

  it('bearer-token.guard.ts が common/guards/ に存在する', () => {
    expect(fs.existsSync(GUARD_FILE)).toBe(true)
  })

  it('bearer-token.guard.spec.ts が common/guards/ に存在する', () => {
    expect(fs.existsSync(GUARD_SPEC_FILE)).toBe(true)
  })

  it('bearer-token.guard.ts が guardrail/ に存在しない（誤配置でないこと）', () => {
    const guardrailGuard = path.join(
      REPO_ROOT,
      'apps/api/src/guardrail/bearer-token.guard.ts',
    )
    expect(fs.existsSync(guardrailGuard)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// bearer-token.guard.ts — 実装の静的構造確認（設計書 §4-1 / §7 quality 観点）
// ---------------------------------------------------------------------------

describe('bearer-token.guard.ts — 実装静的確認（Phase 3 / 設計書 §4-1）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(GUARD_FILE)
  })

  it('CanActivate を実装している', () => {
    expect(content).toContain('CanActivate')
    expect(content).toContain('canActivate')
  })

  it('@Injectable() デコレータが付与されている（DI 対応 / 設計書 §3 判断 1 APP_GUARD 方式）', () => {
    expect(content).toContain('@Injectable()')
  })

  it('node:crypto から timingSafeEqual を import している（判断 3 案 C）', () => {
    expect(content).toContain('timingSafeEqual')
    expect(content).toMatch(/from ['"]node:crypto['"]/)
  })

  it('createHash を使って SHA-256 ダイジェスト化している（長さ正規化 / 判断 3 案 C）', () => {
    expect(content).toContain("createHash('sha256')")
  })

  it('ServiceUnavailableException を throw する（fail-closed / 判断 4）', () => {
    expect(content).toContain('ServiceUnavailableException')
  })

  it('UnauthorizedException を throw する', () => {
    expect(content).toContain('UnauthorizedException')
  })

  it('トークン値・ヘッダ値をログ出力していない（情報漏れ防止 / 設計書 §7 quality 観点）', () => {
    // Logger.error の引数に headers.authorization / API_BEARER_TOKEN の参照変数名が
    // ログ文字列として渡されていないこと（変数名として登場する事自体は許容）
    const loggerCalls = content.match(/this\.logger\.error\([^)]+\)/gs) ?? []
    loggerCalls.forEach((call) => {
      // 'Authorization' / 'Bearer' 等の値を logger 引数に文字列リテラルで渡していない
      expect(call).not.toContain("'Bearer")
      expect(call).not.toContain('"Bearer')
      expect(call).not.toContain('authorization')
      expect(call).not.toContain('providedToken')
      expect(call).not.toContain('expectedToken')
    })
  })

  it('scheme 比較が "Bearer " 固定の厳格一致（RFC 7235 大文字小文字非依存は非実装 / 設計書 §4-1）', () => {
    // startsWith('Bearer ') でのチェックが存在する
    expect(content).toContain("'Bearer '")
    // toLower() / toLowerCase() による scheme 正規化がない（厳格一致）
    expect(content).not.toContain('.toLowerCase()')
  })
})

// ---------------------------------------------------------------------------
// apps/api/.env.example — Phase 3 追記確認（設計書 §4-4）
// ---------------------------------------------------------------------------

describe('apps/api/.env.example — API_BEARER_TOKEN 追記確認（Phase 3 / 設計書 §4-4）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(API_ENV_EXAMPLE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(API_ENV_EXAMPLE)).toBe(true)
  })

  it('API_BEARER_TOKEN= が存在する（Phase 3 追記）', () => {
    expect(content).toContain('API_BEARER_TOKEN=')
  })

  it('API_BEARER_TOKEN= の行（コメント外）が存在する', () => {
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('API_BEARER_TOKEN=') && !l.startsWith('#'),
    )
    expect(activeLine).toBeDefined()
  })

  it('API_BEARER_TOKEN に実値らしき文字列が設定されていない（プレースホルダのみ）', () => {
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('API_BEARER_TOKEN=') && !l.startsWith('#'),
    )
    // 値部分が空（= の後ろが空またはなし）
    expect(activeLine).toMatch(/^API_BEARER_TOKEN=\s*$/)
  })

  it('openssl rand -hex 32 の生成方法コメントが存在する（設計書 §4-4）', () => {
    expect(content).toContain('openssl rand -hex 32')
  })

  it('既存キー DATABASE_URL が保持されている（Phase 3 で既存設定を壊していない）', () => {
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('DATABASE_URL=') && !l.startsWith('#'),
    )
    expect(activeLine).toBeDefined()
  })

  it('既存キー OPENAI_API_KEY が保持されている', () => {
    expect(content).toContain('OPENAI_API_KEY=')
  })
})

// ---------------------------------------------------------------------------
// ルート .env.example — Phase 3 追記確認（設計書 §4-4）
// ---------------------------------------------------------------------------

describe('ルート .env.example — API_BEARER_TOKEN 追記確認（Phase 3 / 設計書 §4-4）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(ROOT_ENV_EXAMPLE)
  })

  it('ファイルが存在する', () => {
    expect(fs.existsSync(ROOT_ENV_EXAMPLE)).toBe(true)
  })

  it('API_BEARER_TOKEN= が存在する（Phase 3 追記）', () => {
    expect(content).toContain('API_BEARER_TOKEN=')
  })

  it('API_BEARER_TOKEN に実値らしき文字列が設定されていない（プレースホルダのみ）', () => {
    const lines = content.split('\n')
    const activeLine = lines.find(
      (l) => l.startsWith('API_BEARER_TOKEN=') && !l.startsWith('#'),
    )
    expect(activeLine).toBeDefined()
    expect(activeLine).toMatch(/^API_BEARER_TOKEN=\s*$/)
  })

  it('正本 apps/api/.env.example への導線コメントが存在する（設計書 §4-4）', () => {
    expect(content).toContain('apps/api/.env.example')
  })

  it('既存キー POSTGRES_DB が保持されている（Phase 3 で既存設定を壊していない）', () => {
    expect(content).toContain('POSTGRES_DB=')
  })
})

// ---------------------------------------------------------------------------
// create-app.ts / api/index.ts — Phase 3 無改変確認（設計書 §3 判断 1 案 A / §7 architecture）
// ---------------------------------------------------------------------------

describe('create-app.ts / api/index.ts — Phase 3 無改変確認（設計書 §3 判断 1 案 A）', () => {
  it('create-app.ts に BearerTokenGuard の import / 登録がない（guard は app.module.ts に閉じる）', () => {
    const content = readFile(CREATE_APP_PATH)
    // APP_GUARD / BearerTokenGuard がこのファイルに持ち込まれていない
    expect(content).not.toContain('BearerTokenGuard')
    expect(content).not.toContain('APP_GUARD')
  })

  it('api/index.ts に BearerTokenGuard の import / 登録がない（guard は app.module.ts に閉じる）', () => {
    const content = readFile(HANDLER_PATH)
    expect(content).not.toContain('BearerTokenGuard')
    expect(content).not.toContain('APP_GUARD')
  })

  it('create-app.ts の setGlobalPrefix が Phase 3 以前から変化していない（exclude: health 保持）', () => {
    const content = readFile(CREATE_APP_PATH)
    // setGlobalPrefix は create-app.ts 内に 1 箇所のみ（SSoT）
    const matches = content.match(/setGlobalPrefix/g) ?? []
    expect(matches.length).toBe(1)
    expect(content).toContain("exclude: ['health']")
    expect(content).toContain("'api/v1'")
  })

  it('api/index.ts が create-app.ts を引き続き import している（Phase 3 で差し替えなし）', () => {
    const content = readFile(HANDLER_PATH)
    expect(content).toMatch(/from ['"]\.\.\/src\/create-app['"]/)
  })
})
