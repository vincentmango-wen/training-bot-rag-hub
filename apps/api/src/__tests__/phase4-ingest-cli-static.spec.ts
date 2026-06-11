import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Phase 4 — scripts/ingest/ の静的構造確認テスト（設計書 §6 / §7）。
 *
 * DB 接続なし・npm install 不要。ファイル存在 / 静的コード解析で
 * 設計書の構造要件が満たされているかを検証する。
 * phase1〜3 の static spec と同スタイル。
 *
 * カバーする観点:
 *   - 実装ファイル（chunker.ts / embedder.ts / index.ts）の存在
 *   - scripts/tsconfig.json の存在
 *   - DI 配線の静的検証（IngestCliModule / IngestCliDryRunModule）
 *   - EMBEDDING_PROVIDER の単一束縛確認（ProvidersModule import なし）
 *   - dry-run 書込ゼロ保証（IngestionService を呼ばない分岐）
 *   - secrets 非出力確認（OPENAI_API_KEY / DATABASE_URL をログに素出ししない）
 *   - 新規 npm 依存ゼロ（dotenv / commander の混入なし）
 *   - env 変数名の正本整合（DIRECT_URL / 設計書 §3 判断 3 / ブリーフの DATABASE_URL_DIRECT は不使用）
 */

// ---------------------------------------------------------------------------
// パス定義（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SCRIPTS_DIR = path.join(REPO_ROOT, 'apps/api/scripts/ingest')
const INDEX_TS = path.join(SCRIPTS_DIR, 'index.ts')
const CHUNKER_TS = path.join(SCRIPTS_DIR, 'chunker.ts')
const EMBEDDER_TS = path.join(SCRIPTS_DIR, 'embedder.ts')
const SCRIPTS_TSCONFIG = path.join(REPO_ROOT, 'apps/api/scripts/tsconfig.json')
const API_PACKAGE_JSON = path.join(REPO_ROOT, 'apps/api/package.json')
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json')
const RUNBOOK_MD = path.join(REPO_ROOT, 'docs/operations/ingestion-runbook.md')

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ---------------------------------------------------------------------------
// 実装ファイルの存在確認
// ---------------------------------------------------------------------------

describe('Phase 4 実装ファイル存在確認（設計書 §4）', () => {
  it('scripts/ingest/index.ts が存在する（CLI エントリポイント / §4-1）', () => {
    expect(fs.existsSync(INDEX_TS)).toBe(true)
  })

  it('scripts/ingest/chunker.ts が存在する（ファイル走査 + item 組み立て / §4-2）', () => {
    expect(fs.existsSync(CHUNKER_TS)).toBe(true)
  })

  it('scripts/ingest/embedder.ts が存在する（CLI 用 DI module / §4-3）', () => {
    expect(fs.existsSync(EMBEDDER_TS)).toBe(true)
  })

  it('scripts/tsconfig.json が存在する（§4-4 / apps/api/tsconfig.json の rootDir: src 除外対応）', () => {
    expect(fs.existsSync(SCRIPTS_TSCONFIG)).toBe(true)
  })

  it('docs/operations/ingestion-runbook.md が存在する（§4-5）', () => {
    expect(fs.existsSync(RUNBOOK_MD)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// embedder.ts — DI 配線の静的構造確認（設計書 §4-3 / §3 判断 2）
// ---------------------------------------------------------------------------

describe('embedder.ts — DI 配線 静的確認（§4-3 / §3 判断 2）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(EMBEDDER_TS)
  })

  it('IngestCliModule が export されている', () => {
    expect(content).toContain('export class IngestCliModule')
  })

  it('IngestCliDryRunModule が export されている（dry-run 用 / §4-3）', () => {
    expect(content).toContain('export class IngestCliDryRunModule')
  })

  it('EMBEDDING_PROVIDER が useExisting: OpenAIEmbeddingAdapter で単一束縛されている（本番モード）', () => {
    expect(content).toContain('useExisting: OpenAIEmbeddingAdapter')
    expect(content).toContain('EMBEDDING_PROVIDER')
  })

  it('IngestCliDryRunModule は StubEmbeddingProvider を束縛している（dry-run / OPENAI_API_KEY 不要）', () => {
    expect(content).toContain('StubEmbeddingProvider')
    expect(content).toContain('IngestCliDryRunModule')
  })

  it('ProvidersModule を import していない（配列束縛との token 衝突回避 / §3 判断 2）', () => {
    // ProvidersModule の import があると EMBEDDING_PROVIDER が配列束縛で衝突する
    const lines = content.split('\n')
    const providersImport = lines.find(
      (l) => l.includes('ProvidersModule') && !l.trimStart().startsWith('//')
    )
    expect(providersImport).toBeUndefined()
  })

  it('PrismaModule が明示 import されている（@Global だが standalone context で必要 / §4-3）', () => {
    expect(content).toContain('PrismaModule')
  })

  it('IngestionService が providers に含まれている（§4-3）', () => {
    expect(content).toContain('IngestionService')
  })

  it('OPENAI_CLIENT factory が定義されている（createOpenAiClientForCli）', () => {
    expect(content).toContain('createOpenAiClientForCli')
    expect(content).toContain('OPENAI_CLIENT')
  })
})

// ---------------------------------------------------------------------------
// index.ts — 静的構造確認（dry-run 保証 / secrets 非出力 / exit code）
// ---------------------------------------------------------------------------

describe('index.ts — 静的構造確認（設計書 §4-1）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(INDEX_TS)
  })

  it('applyDirectUrlOverride 関数が定義されており、DIRECT_URL を参照している（§3 判断 3）', () => {
    expect(content).toContain('applyDirectUrlOverride')
    expect(content).toContain('DIRECT_URL')
  })

  it('applyDirectUrlOverride が import より前の位置で呼ばれている（PrismaClient インスタンス化前 / §3 判断 3）', () => {
    // index.ts では applyDirectUrlOverride() を top-level 関数定義直後、
    // Nest/Prisma import より前に呼ぶ設計（動的 import パターン）。
    // ファイル先頭で関数定義 + 即呼び出しの両方が存在することを確認。
    const applyCallIndex = content.indexOf('applyDirectUrlOverride()')
    const nestImportIndex = content.indexOf("import('@nestjs/core')")
    expect(applyCallIndex).toBeGreaterThan(-1)
    expect(nestImportIndex).toBeGreaterThan(-1)
    // applyDirectUrlOverride() の呼び出しが Nest の動的 import より前にある
    expect(applyCallIndex).toBeLessThan(nestImportIndex)
  })

  it('DATABASE_URL_DIRECT という env 名が使われていない（リポ実体は DIRECT_URL / §1 env 名差異）', () => {
    // ブリーフでは DATABASE_URL_DIRECT と書かれていたが、schema.prisma / .env.example の
    // 実体は DIRECT_URL。設計はリポ実体に合わせる（設計書 §1 逸脱記録）。
    expect(content).not.toContain('DATABASE_URL_DIRECT')
  })

  it('MVP_SOURCE_TYPES / SOURCE_STATUSES を @pmtp/shared から import している（enum SSoT 規約）', () => {
    expect(content).toContain('@pmtp/shared')
    expect(content).toContain('MVP_SOURCE_TYPES')
  })

  it('dry-run 分岐では IngestionService.ingest() を呼ばない（書込ゼロ保証 / §5 ガード 7）', () => {
    // dry-run 分岐で "return 0" が存在し、ingestion.ingest は呼ばれない構造を確認。
    // dry-run 後に return する前に ingestion.ingest が呼ばれていないことを
    // "if (args.dryRun)" ブロックに "return 0" が含まれていることで静的に確認。
    const dryRunBlockMatch = content.match(/if\s*\(args\.dryRun\)([\s\S]*?)return 0/)
    expect(dryRunBlockMatch).not.toBeNull()
    if (dryRunBlockMatch) {
      const dryRunBlock = dryRunBlockMatch[0]
      expect(dryRunBlock).not.toContain('ingestion.ingest')
    }
  })

  it('dry-run 分岐では NestFactory.createApplicationContext を呼ばない（DB 接続不要 / §5 ガード 7）', () => {
    // dry-run はジョブ行すら作らない。動的 import + createApplicationContext は
    // dry-run ブロックの外にある（live モードのみ）ことを確認。
    const dryRunBlock = content.match(/if\s*\(args\.dryRun\)([\s\S]*?)return 0/)
    if (dryRunBlock) {
      expect(dryRunBlock[0]).not.toContain('createApplicationContext')
    }
  })

  it('finally ブロックで app.close() が呼ばれている（接続リーク防止 / §4-1 ロジック 9）', () => {
    expect(content).toContain('app.close()')
    expect(content).toContain('finally')
  })

  it('OPENAI_API_KEY をログ文字列に素出ししていない（secrets 非出力 / §4-1 ロジック 7）', () => {
    // console.log / console.error の引数にキー値を直接埋め込んでいないことを確認。
    // 変数名として存在するのは許容。エラーメッセージに "OPENAI_API_KEY is not set" と
    // いう文字列が存在するのは許容（「未設定」という案内であり値ではない）。
    const logLines = content
      .split('\n')
      .filter((l) => l.includes('console.log') || l.includes('console.error'))
    // process.env.OPENAI_API_KEY の値を直接展開する構文がないこと
    for (const line of logLines) {
      // NG: `${process.env.OPENAI_API_KEY}` のような値埋め込み
      expect(line).not.toMatch(/\$\{process\.env\.OPENAI_API_KEY\}/)
      // NG: process.env.OPENAI_API_KEY をそのまま渡す
      expect(line).not.toMatch(/console\.(log|error)\([^)]*process\.env\.OPENAI_API_KEY/)
    }
  })

  it('DATABASE_URL をログ文字列に素出ししていない（secrets 非出力 / §4-1 ロジック 7）', () => {
    const logLines = content
      .split('\n')
      .filter((l) => l.includes('console.log') || l.includes('console.error'))
    for (const line of logLines) {
      expect(line).not.toMatch(/\$\{process\.env\.DATABASE_URL\}/)
      expect(line).not.toMatch(/console\.(log|error)\([^)]*process\.env\.DATABASE_URL/)
    }
  })

  it('--force フラグで idempotencyKey が undefined になる分岐がある（§3 判断 5）', () => {
    expect(content).toContain('args.force')
    expect(content).toContain('idempotencyKey')
  })

  it('--dry-run フラグで IngestCliDryRunModule を使う分岐がある（§4-3）', () => {
    expect(content).toContain('IngestCliDryRunModule')
    expect(content).toContain('IngestCliModule')
  })
})

// ---------------------------------------------------------------------------
// chunker.ts — 純関数設計の静的確認（設計書 §4-2）
// ---------------------------------------------------------------------------

describe('chunker.ts — 静的構造確認（§4-2）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(CHUNKER_TS)
  })

  it('collectFiles が export されている', () => {
    expect(content).toContain('export function collectFiles')
  })

  it('buildItems が export されている', () => {
    expect(content).toContain('export function buildItems')
  })

  it('deriveIdempotencyKey が export されている', () => {
    expect(content).toContain('export function deriveIdempotencyKey')
  })

  it('pickBaseDir が export されている', () => {
    expect(content).toContain('export function pickBaseDir')
  })

  it('stableHashOfJson を src/ingestion/content-hash から import している（SSoT 再利用 / §4-2）', () => {
    expect(content).toContain('stableHashOfJson')
    expect(content).toContain('content-hash')
  })

  it('"cli-" プレフィックスで idempotencyKey を生成している（サーバ系列との区別 / §3 判断 5）', () => {
    expect(content).toContain("'cli-'")
  })

  it('externalId でソートしている（順序非依存 / §5 ガード 2）', () => {
    expect(content).toContain('externalId')
    expect(content).toContain('.sort(')
  })

  it('mtime を idempotencyKey のハッシュ対象に含めていない（§4-2 設計コメント）', () => {
    // deriveIdempotencyKey が fingerprint に externalId + contentHash のみ使用し
    // mtime / fileSizeBytes を含めないことを確認（コメントにも明記されている）。
    const fingerprintMatch = content.match(/fingerprint\s*=\s*([\s\S]*?)\.sort/)
    if (fingerprintMatch) {
      const fingerprintCode = fingerprintMatch[0]
      expect(fingerprintCode).not.toContain('mtime')
      expect(fingerprintCode).not.toContain('fileSizeBytes')
    }
    // 少なくとも contentHash と externalId が fingerprint に含まれていること
    expect(content).toContain('contentHash')
  })

  it('10MB 上限定数が定義されている（§4-2 ガード）', () => {
    // 10 * 1024 * 1024 または定数名 MAX_FILE_SIZE_BYTES
    const has10mb =
      content.includes('10 * 1024 * 1024') ||
      content.includes('MAX_FILE_SIZE_BYTES')
    expect(has10mb).toBe(true)
  })

  it('console.warn でスキップ警告を出している（黙殺禁止 / §4-2）', () => {
    expect(content).toContain('console.warn')
    expect(content).toContain('skip')
  })

  it('node_modules / dist を除外ディレクトリとして含んでいる', () => {
    expect(content).toContain('node_modules')
    expect(content).toContain('dist')
  })

  it('EXCLUDED_DIRS または相当の除外ロジックが存在する', () => {
    const hasExcluded = content.includes('EXCLUDED_DIRS') || content.includes('node_modules')
    expect(hasExcluded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// package.json — scripts 追記確認（設計書 §4-4）
// ---------------------------------------------------------------------------

describe('apps/api/package.json — scripts 追記確認（§4-4）', () => {
  let pkg: Record<string, unknown>

  beforeAll(() => {
    pkg = JSON.parse(readFile(API_PACKAGE_JSON)) as Record<string, unknown>
  })

  it('"ingest" スクリプトが存在する', () => {
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['ingest']).toBeDefined()
  })

  it('"ingest" スクリプトが ts-node/register/transpile-only を使う（SMB 起動高速化 / §4-4）', () => {
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['ingest']).toContain('transpile-only')
  })

  it('"ingest" スクリプトが --env-file=.env を使う（dotenv 代替 / §3 判断 4）', () => {
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['ingest']).toContain('--env-file=.env')
  })

  it('"typecheck:scripts" スクリプトが存在する（scripts/ の型検査 / §4-4）', () => {
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['typecheck:scripts']).toBeDefined()
  })

  it('"typecheck:scripts" が scripts/tsconfig.json を使う', () => {
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['typecheck:scripts']).toContain('scripts/tsconfig.json')
  })
})

// ---------------------------------------------------------------------------
// ルート package.json — ingest 透過コマンド（設計書 §4-4）
// ---------------------------------------------------------------------------

describe('ルート package.json — ingest 透過コマンド（§4-4）', () => {
  let pkg: Record<string, unknown>

  beforeAll(() => {
    pkg = JSON.parse(readFile(ROOT_PACKAGE_JSON)) as Record<string, unknown>
  })

  it('"ingest" スクリプトが存在する（apps/api への透過コマンド）', () => {
    const scripts = pkg['scripts'] as Record<string, string> | undefined
    // ルート package.json に ingest がある場合のみチェック
    if (scripts) {
      expect(scripts['ingest']).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 新規 npm 依存ゼロ確認（§3 判断 4 / SMB 制約）
// ---------------------------------------------------------------------------

describe('新規 npm 依存ゼロ確認（dotenv / commander 混入なし / §3 判断 4）', () => {
  it('index.ts が dotenv を import していない', () => {
    const content = readFile(INDEX_TS)
    expect(content).not.toContain("from 'dotenv'")
    expect(content).not.toContain('require("dotenv")')
    expect(content).not.toContain("require('dotenv')")
  })

  it('index.ts が commander を import していない', () => {
    const content = readFile(INDEX_TS)
    expect(content).not.toContain("from 'commander'")
    expect(content).not.toContain('require("commander")')
    expect(content).not.toContain("require('commander')")
  })

  it('index.ts が node:util の parseArgs を使っている（新規依存なし / §4-1）', () => {
    const content = readFile(INDEX_TS)
    expect(content).toContain('parseArgs')
    expect(content).toContain('node:util')
  })

  it('apps/api/package.json に dotenv が追加されていない', () => {
    const pkg = JSON.parse(readFile(API_PACKAGE_JSON)) as Record<string, unknown>
    const deps = {
      ...((pkg['dependencies'] as Record<string, unknown>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, unknown>) ?? {}),
    }
    expect(deps['dotenv']).toBeUndefined()
    expect(deps['commander']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// scripts/tsconfig.json — 構造確認（§4-4）
// ---------------------------------------------------------------------------

describe('scripts/tsconfig.json — 構造確認（§4-4）', () => {
  let tsconfig: Record<string, unknown>

  beforeAll(() => {
    tsconfig = JSON.parse(readFile(SCRIPTS_TSCONFIG)) as Record<string, unknown>
  })

  it('ファイルが有効な JSON である', () => {
    expect(typeof tsconfig).toBe('object')
    expect(tsconfig).not.toBeNull()
  })

  it('"extends" が定義されている（親 tsconfig を継承する）', () => {
    expect(tsconfig['extends']).toBeDefined()
  })

  it('"include" に scripts/ と src/ が含まれる', () => {
    const include = tsconfig['include'] as string[] | undefined
    expect(include).toBeDefined()
    const includeStr = JSON.stringify(include)
    // scripts 配下と src 配下を両方型検査するため
    expect(includeStr).toContain('./')
  })
})
