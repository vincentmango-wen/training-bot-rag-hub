import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * deploy ブロッカー B-1〜B-4 の修正が「指摘の真因」を解消したかを検証する静的テスト。
 *
 * DB 接続なし・外部 URL 疎通なし・npm install 不要。
 * 修正ファイルの静的内容を fs.readFileSync / fs.existsSync で検証する。
 * phase1〜5 の static spec と同スタイル。
 *
 * カバーするブロッカー:
 *   B-1: apps/api/package.json の postinstall が shared build → prisma generate の順を保証
 *   B-2: docs/operations/vercel-deploy.md に lockfile 同期の明示手順（§1.5）が存在する
 *   B-3: RagExceptionFilter が HttpException を 500 に潰さず httpStatus を保持する
 *        - UnauthorizedException (401) → 401 透過
 *        - ServiceUnavailableException (503) → 503 透過
 *        - 普通の Error → 500（既存挙動の保持）
 *   B-4: ptp-client-cutover.md §9 の「実機検証済」虚偽記載が除去され
 *        「未検証」警告ブロックが存在する
 */

// ---------------------------------------------------------------------------
// パス定義（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const API_PACKAGE_JSON = path.join(REPO_ROOT, 'apps/api/package.json')
const VERCEL_DEPLOY_MD = path.join(REPO_ROOT, 'docs/operations/vercel-deploy.md')
const CUTOVER_MD = path.join(REPO_ROOT, 'docs/operations/ptp-client-cutover.md')
const EXCEPTION_FILTER_TS = path.join(
  REPO_ROOT,
  'apps/api/src/modules/rag/http/rag-exception.filter.ts',
)
const EXCEPTION_FILTER_SPEC_TS = path.join(
  REPO_ROOT,
  'apps/api/src/modules/rag/http/__tests__/rag-exception.filter.spec.ts',
)

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFile(filePath)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// B-1: apps/api/package.json の postinstall が shared build → prisma generate 順
// ---------------------------------------------------------------------------

describe('B-1: postinstall が shared build → prisma generate の順を保証する', () => {
  let pkg: Record<string, unknown>
  let postinstall: string

  beforeAll(() => {
    pkg = readJson(API_PACKAGE_JSON)
    const scripts = pkg['scripts'] as Record<string, string>
    postinstall = scripts['postinstall'] ?? ''
  })

  it('apps/api/package.json が存在する', () => {
    expect(fs.existsSync(API_PACKAGE_JSON)).toBe(true)
  })

  it('postinstall スクリプトが存在する', () => {
    expect(postinstall.length).toBeGreaterThan(0)
  })

  it('postinstall に packages/shared の build コマンドが含まれる', () => {
    // npm --prefix ../../packages/shared run build 相当が含まれること
    expect(postinstall).toMatch(/packages\/shared.*build|build.*packages\/shared/)
  })

  it('postinstall に prisma generate が含まれる', () => {
    expect(postinstall).toContain('prisma generate')
  })

  it('postinstall で shared build が prisma generate より先に実行される（順序保証）', () => {
    const buildPos = postinstall.indexOf('build')
    const prismaPos = postinstall.indexOf('prisma generate')
    // build が先（インデックスが小さい）
    expect(buildPos).toBeGreaterThanOrEqual(0)
    expect(prismaPos).toBeGreaterThan(buildPos)
  })

  it('postinstall が shared install を build より先に含む（dist 生成前提）', () => {
    // shared の node_modules がないと tsc が失敗するため install が先に来る
    // 注: indexOf('install') は --no-audit の直前の install を取得する
    //     buildPos は "run build" の位置で判定（packages/shared.*build は install 行も拾うため）
    const installPos = postinstall.indexOf('install')
    const buildPos = postinstall.search(/run build/)
    expect(installPos).toBeGreaterThanOrEqual(0)
    expect(buildPos).toBeGreaterThan(installPos)
  })

  it('@pmtp/shared が file: プロトコルで dependencies に存在する（B-2 前提）', () => {
    const deps = pkg['dependencies'] as Record<string, string>
    const sharedVersion = deps['@pmtp/shared'] ?? ''
    expect(sharedVersion).toMatch(/^file:/)
  })

  it('packages/shared/package.json に build スクリプトが存在する（dist/ 生成スクリプト）', () => {
    const sharedPkg = readJson(path.join(REPO_ROOT, 'packages/shared/package.json'))
    const sharedScripts = sharedPkg['scripts'] as Record<string, string>
    expect(sharedScripts['build']).toBeDefined()
    // tsc を使っていること（dist/ を生成する標準的な方法）
    expect(sharedScripts['build']).toContain('tsc')
  })
})

// ---------------------------------------------------------------------------
// B-2: vercel-deploy.md に lockfile 同期の明示手順が存在する
// ---------------------------------------------------------------------------

describe('B-2: vercel-deploy.md に lockfile 同期の明示手順（§1.5）が存在する', () => {
  let content: string

  beforeAll(() => {
    content = readFile(VERCEL_DEPLOY_MD)
  })

  it('vercel-deploy.md が存在する', () => {
    expect(fs.existsSync(VERCEL_DEPLOY_MD)).toBe(true)
  })

  it('§1.5 または同等の lockfile 同期セクションが存在する', () => {
    // B-2 に対応するセクション（番号・タイトル問わず lockfile 同期の文脈）
    const hasSection =
      content.includes('1.5') ||
      content.includes('lockfile') ||
      content.includes('lock file')
    expect(hasSection).toBe(true)
  })

  it('packages/shared への npm install 手順が記載されている', () => {
    // shared パッケージの install を先に実行する手順
    const hasSharedInstall =
      content.includes('packages/shared') && content.includes('npm install')
    expect(hasSharedInstall).toBe(true)
  })

  it('apps/api への npm install 手順が記載されている', () => {
    // apps/api の lockfile 更新手順
    const hasApiInstall =
      content.includes('apps/api') && content.includes('npm install')
    expect(hasApiInstall).toBe(true)
  })

  it('lockfile の変更を git add する手順が記載されている（コミット必須化）', () => {
    expect(content).toContain('git add')
    // lockfile への言及が近傍にある
    const hasLockfileAdd =
      content.includes('package-lock.json') || content.includes('lockfile')
    expect(hasLockfileAdd).toBe(true)
  })

  it('@pmtp/shared の resolved パスが lockfile に記録されることへの言及がある', () => {
    // B-2 の真因: @pmtp/shared が lockfile に反映されていないこと
    expect(content).toContain('@pmtp/shared')
  })

  it('SMB マウント上で並列 install を禁止する旨の注意書きが存在する', () => {
    // memory: feedback_smb_worktree_parallel_install 規約に沿ったガイダンス
    const hasSmbNote =
      content.includes('SMB') || content.includes('並列') || content.includes('直列')
    expect(hasSmbNote).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B-3: RagExceptionFilter — 実装の静的確認（HttpException 分岐が正しく追加されているか）
// ---------------------------------------------------------------------------

describe('B-3（静的）: RagExceptionFilter に HttpException 分岐が追加されている', () => {
  let content: string

  beforeAll(() => {
    content = readFile(EXCEPTION_FILTER_TS)
  })

  it('rag-exception.filter.ts が存在する', () => {
    expect(fs.existsSync(EXCEPTION_FILTER_TS)).toBe(true)
  })

  it('HttpException が @nestjs/common から import されている', () => {
    expect(content).toMatch(/HttpException/)
    expect(content).toMatch(/from ['"]@nestjs\/common['"]/)
  })

  it('normalize() 内に instanceof HttpException 分岐が存在する', () => {
    expect(content).toContain('instanceof HttpException')
  })

  it('HttpException.getStatus() を呼んで httpStatus を取得する', () => {
    expect(content).toContain('getStatus()')
  })

  it('HttpException.getResponse() を呼んで message を抽出する', () => {
    expect(content).toContain('getResponse()')
  })

  it('mapHttpStatusToErrorCode helper 関数が存在する', () => {
    expect(content).toContain('mapHttpStatusToErrorCode')
  })

  it('mapHttpStatusToErrorCode が 401 → RAG_UNAUTHORIZED を返すケースを含む', () => {
    // 401 と RAG_UNAUTHORIZED が同じ switch 内に存在することを静的に確認
    const switchMatch = content.match(/function mapHttpStatusToErrorCode[\s\S]*?^}/m)
    expect(switchMatch).not.toBeNull()
    if (switchMatch) {
      expect(switchMatch[0]).toContain('401')
      expect(switchMatch[0]).toContain('RAG_UNAUTHORIZED')
    }
  })

  it('mapHttpStatusToErrorCode が 503 を RAG_INTERNAL_ERROR にフォールバックする（503 専用コードなし）', () => {
    // 503 case は存在しない（default = RAG_INTERNAL_ERROR / httpStatus は保持する設計）
    const switchMatch = content.match(/function mapHttpStatusToErrorCode[\s\S]*?^}/m)
    if (switchMatch) {
      // 503 の明示的な case がなく、default で RAG_INTERNAL_ERROR に fallback する
      expect(switchMatch[0]).not.toContain("case 503")
      expect(switchMatch[0]).toContain('RAG_INTERNAL_ERROR')
    }
  })

  it('HttpException 分岐が RagApiException 分岐の直後（ZodError より前）に配置されている', () => {
    const ragApiPos = content.indexOf('instanceof RagApiException')
    const httpExPos = content.indexOf('instanceof HttpException')
    const zodPos = content.indexOf('instanceof ZodError')
    expect(ragApiPos).toBeGreaterThanOrEqual(0)
    expect(httpExPos).toBeGreaterThan(ragApiPos)
    expect(zodPos).toBeGreaterThan(httpExPos)
  })

  it('spec ファイルに UnauthorizedException (401) のテストが追加されている', () => {
    const specContent = readFile(EXCEPTION_FILTER_SPEC_TS)
    expect(specContent).toContain('UnauthorizedException')
    expect(specContent).toContain('401')
    expect(specContent).toContain('RAG_UNAUTHORIZED')
  })

  it('spec ファイルに ServiceUnavailableException (503) のテストが追加されている', () => {
    const specContent = readFile(EXCEPTION_FILTER_SPEC_TS)
    expect(specContent).toContain('ServiceUnavailableException')
    expect(specContent).toContain('503')
  })

  it('spec ファイルに「想定外例外は 500」の既存テストが保持されている（regression 確認）', () => {
    const specContent = readFile(EXCEPTION_FILTER_SPEC_TS)
    expect(specContent).toContain('想定外例外')
    expect(specContent).toContain('500')
  })
})

// ---------------------------------------------------------------------------
// B-3（unit）: RagExceptionFilter — インスタンスを使った unit テスト
//              HttpException の分岐を実際に呼んで status 透過を確認する
// ---------------------------------------------------------------------------

import {
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common'
import { RagExceptionFilter } from '../modules/rag/http/rag-exception.filter'
import { TRACE_CONTEXT_KEY } from '../modules/rag/http/trace-context'

interface FakeRes {
  _status: number | undefined
  _body: unknown
  status: jest.Mock
  json: jest.Mock
  setHeader: jest.Mock
}

function makeHost(): { host: ArgumentsHost; res: FakeRes } {
  const res: FakeRes = {
    _status: undefined,
    _body: undefined,
    status: jest.fn((code: number) => {
      res._status = code
      return res
    }),
    json: jest.fn((body: unknown) => {
      res._body = body
      return res
    }),
    setHeader: jest.fn(),
  }
  const req = { [TRACE_CONTEXT_KEY]: { trace_id: 'b3-test', request_id: 'r-b3' } }
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost
  return { host, res }
}

describe('B-3（unit）: RagExceptionFilter — HttpException の status 透過', () => {
  const filter = new RagExceptionFilter()

  it('UnauthorizedException (401) は 401 で透過する（500 に潰れない）', () => {
    const { host, res } = makeHost()
    filter.catch(new UnauthorizedException('Invalid or missing bearer token'), host)
    expect(res._status).toBe(401)
    const body = res._body as {
      success: boolean
      error: { code: string; message: string }
      meta: { trace_id: string }
    }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('RAG_UNAUTHORIZED')
    expect(body.error.message).toBeTruthy()
    // meta.trace_id が必ず付く（障害調査の突合キー）
    expect(body.meta.trace_id).toBe('b3-test')
  })

  it('ServiceUnavailableException (503) は 503 で透過する（500 に潰れない）', () => {
    const { host, res } = makeHost()
    filter.catch(
      new ServiceUnavailableException('API authentication is not configured'),
      host,
    )
    expect(res._status).toBe(503)
    const body = res._body as {
      success: boolean
      error: { code: string; message: string }
    }
    expect(body.success).toBe(false)
    // 503 は ERROR_CODES に専用コードが無いため RAG_INTERNAL_ERROR に寄せる仕様
    // ただし httpStatus は 503 を保持する（smoke-test T6 の判定に重要）
    expect(body.error.code).toBe('RAG_INTERNAL_ERROR')
    expect(body.error.message).toContain('not configured')
  })

  it('普通の Error は 500 に落ちる（既存挙動の regression なし）', () => {
    const { host, res } = makeHost()
    filter.catch(new Error('unexpected internal error'), host)
    expect(res._status).toBe(500)
    const body = res._body as { error: { code: string } }
    expect(body.error.code).toBe('RAG_INTERNAL_ERROR')
  })

  it('HttpException(422) は 422 で透過する（Guard 以外からの HttpException も拾う）', () => {
    const { host, res } = makeHost()
    filter.catch(new HttpException('guardrail blocked', 422), host)
    expect(res._status).toBe(422)
    const body = res._body as { error: { code: string } }
    expect(body.error.code).toBe('RAG_GUARDRAIL_BLOCKED')
  })

  it('HttpException(400) は 400 + RAG_VALIDATION_ERROR で透過する', () => {
    const { host, res } = makeHost()
    filter.catch(new HttpException('bad request', 400), host)
    expect(res._status).toBe(400)
    const body = res._body as { error: { code: string } }
    expect(body.error.code).toBe('RAG_VALIDATION_ERROR')
  })

  it('HttpException で meta.trace_id / meta.request_id が必ず付く', () => {
    const { host, res } = makeHost()
    filter.catch(new UnauthorizedException('test'), host)
    const body = res._body as { meta: { trace_id: string; request_id: string } }
    expect(body.meta.trace_id).toBe('b3-test')
    expect(body.meta.request_id).toBe('r-b3')
  })
})

// ---------------------------------------------------------------------------
// B-4: ptp-client-cutover.md §9 の「実機検証済」虚偽記載が除去されている
// ---------------------------------------------------------------------------

describe('B-4: ptp-client-cutover.md §9 の虚偽記載除去と警告ブロック存在確認', () => {
  let content: string

  beforeAll(() => {
    content = readFile(CUTOVER_MD)
  })

  it('ptp-client-cutover.md が存在する', () => {
    expect(fs.existsSync(CUTOVER_MD)).toBe(true)
  })

  it('旧テキスト「事前にローカル docker + Stub provider 構成で実機検証された動作です」が除去されている', () => {
    // B-4 の真因: 虚偽の「実機検証済」記載が §9 に存在したこと
    expect(content).not.toContain('事前にローカル docker + Stub provider 構成で実機検証された動作')
  })

  it('「実機検証済」という記述が改訂注記なしに存在しない', () => {
    // 「実機検証済」が登場する場合は「過去ドラフトに〜と記載していたのは誤り」の形でのみ許容
    const lines = content.split('\n')
    const suspiciousLines = lines.filter(
      (l) =>
        l.includes('実機検証済') &&
        !l.includes('過去ドラフトに') &&
        !l.includes('誤り') &&
        !l.includes('訂正'),
    )
    expect(suspiciousLines).toHaveLength(0)
  })

  it('「未検証」または「未完了」という表現が §9 付近に存在する（B-4 訂正の証拠）', () => {
    const hasUnverified =
      content.includes('未検証') || content.includes('未完了')
    expect(hasUnverified).toBe(true)
  })

  it('「実機検証ステータス」見出しが存在する', () => {
    expect(content).toContain('実機検証ステータス')
  })

  it('「重要」または「警告」ブロックが §9 付近に存在する', () => {
    // 警告ブロックの callout
    const hasWarning =
      content.includes('**重要**') ||
      content.includes('> **重要**')
    expect(hasWarning).toBe(true)
  })

  it('「手順書ではなく実機の挙動が真」原則の記載がある（盲点 8 対策の根拠）', () => {
    expect(content).toContain('実機の挙動が真')
  })

  it('「PTP リポは別リポ + 別環境で未アクセス」の事実記載がある', () => {
    const hasFact =
      content.includes('PTP リポは別リポ') ||
      content.includes('アクセスしていません') ||
      content.includes('未アクセス')
    expect(hasFact).toBe(true)
  })

  it('cutover 当日の検証チェックリストが存在する（smoke-test を基準にする旨）', () => {
    // 検証チェックリスト（markdown チェックボックス）が §9 付近に存在する
    expect(content).toContain('cutover-smoke-test.sh')
    // チェックリスト項目
    const checkboxLines = content.split('\n').filter((l) => l.trimStart().startsWith('- [ ]'))
    expect(checkboxLines.length).toBeGreaterThan(0)
  })

  it('idempotency_replayed フィールドの確認がチェックリストに含まれる', () => {
    expect(content).toContain('idempotency_replayed')
  })
})
