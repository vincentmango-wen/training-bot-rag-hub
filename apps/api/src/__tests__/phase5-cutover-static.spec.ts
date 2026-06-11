import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Phase 5 — cutover-smoke-test.sh / ptp-client-cutover.md の静的構造確認テスト
 * （設計書 §6 / docs/operations/phase-5-design.md）
 *
 * DB 接続なし・外部 URL 疎通なし・npm install 不要。
 * ファイル存在 + 静的コード解析で設計書の構造要件が満たされているかを検証する。
 * phase1〜4 の static spec と同スタイル。
 *
 * カバーする観点（設計書 §6）:
 *   - 構文・静的: bash -n 相当の構文チェック（スクリプト存在 + set -x 不在）
 *   - env ガード: 未設定変数名のみ表示（値・ヒントが出ない構造）
 *   - secret 非出力: 出力経路に RAG_API_TOKEN / VERCEL_BYPASS_SECRET の値が現れない構造
 *   - exit code 契約: 0/1/2 の分岐が実装されている
 *   - read-only 保証 (ガード 1): 既定モードで POST が飛ばない構造
 *   - T6 Idempotency-Key 安定性 (ガード 2): タイムスタンプ非含有の確認
 *   - negative control: T1 で status=200 を FAIL と判定する実装の存在
 *   - 一時ファイル: mktemp + trap cleanup EXIT の実装
 *   - 手順書: secret プレースホルダ / grep コマンド構文 / curl コマンド存在
 *   - 新規依存ゼロ: jq 不使用
 */

// ---------------------------------------------------------------------------
// パス定義（リポジトリルート基準）
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SMOKE_SCRIPT = path.join(REPO_ROOT, 'docs/operations/cutover-smoke-test.sh')
const CUTOVER_MD = path.join(REPO_ROOT, 'docs/operations/ptp-client-cutover.md')
const README = path.join(REPO_ROOT, 'README.md')

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

// ---------------------------------------------------------------------------
// ファイル存在確認（設計書 §4）
// ---------------------------------------------------------------------------

describe('Phase 5 成果物ファイル存在確認（設計書 §4）', () => {
  it('docs/operations/cutover-smoke-test.sh が存在する（§4-2）', () => {
    expect(fs.existsSync(SMOKE_SCRIPT)).toBe(true)
  })

  it('docs/operations/ptp-client-cutover.md が存在する（§4-1）', () => {
    expect(fs.existsSync(CUTOVER_MD)).toBe(true)
  })

  it('README.md が存在する（§4-3）', () => {
    expect(fs.existsSync(README)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — 静的構文・構造確認（設計書 §6 構文・静的）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — 静的構文確認（§6 / 設計書 §4-2）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('#!/usr/bin/env bash で始まる（bash スクリプトであること）', () => {
    expect(content.startsWith('#!/usr/bin/env bash')).toBe(true)
  })

  it('set -u が含まれる（未設定変数の即エラー化 / §4-2 ロジック 1）', () => {
    expect(content).toContain('set -u')
  })

  it('set -x がコード行として存在しない（secret 漏洩防止 / §4-2 / §5 ガード）', () => {
    // コメント行（# で始まる行）に言及があるのは許容
    // コード行に set -x が存在しないことを確認
    const codeLines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
    const setxLine = codeLines.find((l) => /\bset\s+-x\b/.test(l))
    expect(setxLine).toBeUndefined()
  })

  it('set -e が含まれない（curl 非 2xx で死なないため / §4-2 ロジック 1）', () => {
    const codeLines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
    const seteLines = codeLines.filter((l) => /\bset\s+-[a-z]*e[a-z]*\b/.test(l))
    // set -e が単独で含まれていないこと（set -u は許容）
    const hasStandaloneE = seteLines.some((l) => /\bset\s+-e\b/.test(l))
    expect(hasStandaloneE).toBe(false)
  })

  it('--with-query フラグのパース分岐が存在する（§3 判断 3 / opt-in）', () => {
    expect(content).toContain('--with-query')
    expect(content).toContain('WITH_QUERY')
  })

  it('不明引数で exit 2 する分岐がある（§6 exit code 契約）', () => {
    // unknown argument のケース
    expect(content).toContain('unknown argument')
    // exit 2 が存在する
    expect(content).toContain('exit 2')
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — env ガード（§6 env ガード / 値・ヒントが出ない）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — env ガード静的確認（§6 / §4-2 ロジック）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('BASE_URL の未設定チェックが存在する', () => {
    expect(content).toContain('BASE_URL')
    // missing 変数に追加する構造
    expect(content).toContain('missing')
  })

  it('RAG_API_TOKEN の未設定チェックが存在する', () => {
    expect(content).toContain('RAG_API_TOKEN')
  })

  it('VERCEL_BYPASS_SECRET の未設定チェックが存在する', () => {
    expect(content).toContain('VERCEL_BYPASS_SECRET')
  })

  it('未設定時に変数名のみを表示する構造になっている（値を echo しない）', () => {
    // missing 配列のループで変数名のみ出力する実装
    expect(content).toContain('missing[@]')
    // 値を echo する形（"${BASE_URL}" を echo する等）がないこと
    // env ガードセクション内で変数の値を展開する行がないことを確認
    const envCheckSection = (() => {
      const start = content.indexOf('missing=()')
      const end = content.indexOf('BASE_URL="${BASE_URL%/}"')
      if (start === -1 || end === -1) return content
      return content.slice(start, end)
    })()
    // 値展開 ${BASE_URL} / ${RAG_API_TOKEN} / ${VERCEL_BYPASS_SECRET} を echo しない
    expect(envCheckSection).not.toMatch(/echo.*\$\{BASE_URL\}/)
    expect(envCheckSection).not.toMatch(/echo.*\$\{RAG_API_TOKEN\}/)
    expect(envCheckSection).not.toMatch(/echo.*\$\{VERCEL_BYPASS_SECRET\}/)
  })

  it('未設定時に exit 2 で終了する', () => {
    // missing 配列のチェック後に exit 2
    const missingBlock = content.match(/if \[ \$\{#missing\[@\]\} -gt 0 \]([\s\S]*?)fi/)
    expect(missingBlock).not.toBeNull()
    if (missingBlock) {
      expect(missingBlock[0]).toContain('exit 2')
    }
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — secret 非出力（§6 / §4-2 ロジック / 設計書 §5 ガード）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — secret 非出力静的確認（§6）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('record 関数が secret 値を展開しない（PASS/FAIL 表示は status と ct のみ）', () => {
    const recordFn = content.match(/record\(\)([\s\S]*?)^}/m)
    if (recordFn) {
      const body = recordFn[0]
      expect(body).not.toContain('RAG_API_TOKEN')
      expect(body).not.toContain('VERCEL_BYPASS_SECRET')
    }
    // record 関数の存在を確認
    expect(content).toContain('record()')
  })

  it('curl コマンドの -H ヘッダ値が環境変数経由（リテラル値直書きなし）', () => {
    // Authorization ヘッダに ${RAG_API_TOKEN} を使っていること（リテラルトークンでないこと）
    expect(content).toContain('${RAG_API_TOKEN}')
    expect(content).toContain('${VERCEL_BYPASS_SECRET}')
  })

  it('printf / echo で RAG_API_TOKEN / VERCEL_BYPASS_SECRET の値を直接出力していない', () => {
    const outputLines = content
      .split('\n')
      .filter((l) => /printf|echo/.test(l) && !l.trimStart().startsWith('#'))
    for (const line of outputLines) {
      // ${RAG_API_TOKEN} や ${VERCEL_BYPASS_SECRET} を echo/printf で出力していない
      expect(line).not.toMatch(/\$\{RAG_API_TOKEN\}/)
      expect(line).not.toMatch(/\$\{VERCEL_BYPASS_SECRET\}/)
    }
  })

  it('T6 の Idempotency-Key に $(date) / date +%s 等のタイムスタンプが含まれない（§5 ガード 2）', () => {
    // idem_key の組み立て部分に date コマンドが使われていないこと
    // タイムスタンプを含むと毎回新規実行 = 毎回 LLM 課金
    const t6Section = (() => {
      const start = content.indexOf('WITH_QUERY')
      // --with-query ブロック全体を取得
      const withQueryBlock = content.slice(start)
      const idemStart = withQueryBlock.indexOf('idem_key=')
      if (idemStart === -1) return ''
      return withQueryBlock.slice(idemStart, idemStart + 300)
    })()
    expect(t6Section).not.toContain('$(date')
    expect(t6Section).not.toContain('date +%s')
    expect(t6Section).not.toContain('date +%N')
    // 安定値として -v1 サフィックスがある（固定値）
    expect(t6Section).toContain('v1')
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — exit code 契約（§6 exit code 契約）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — exit code 契約静的確認（§6）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('exit 0 が存在する（全 PASS ケース）', () => {
    expect(content).toContain('exit 0')
  })

  it('exit 1 が存在する（1 件以上 FAIL ケース）', () => {
    expect(content).toContain('exit 1')
  })

  it('exit 2 が存在する（env 不備ケース）', () => {
    expect(content).toContain('exit 2')
  })

  it('FAILED カウンタが 0 より大きい場合に exit 1 する分岐がある', () => {
    // FAILED > 0 → exit 1 の構造
    expect(content).toContain('FAILED')
    const failCheck = content.match(/if \[ "\$FAILED" -gt 0 \][\s\S]*?exit 1/)
    expect(failCheck).not.toBeNull()
  })

  it('curl 失敗（status=000）を FAIL と判定する分岐がある（fail-closed / §4-2 ロジック 2）', () => {
    // 000 の場合を FAIL に倒す実装
    expect(content).toContain('000')
    // T1 の 000 ケースを FAIL として記録する
    const zeroCase = content.match(/000\)([\s\S]*?)record.*FAIL/)
    expect(zeroCase).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — read-only 保証 (§5 ガード 1 / §6 read-only 保証)
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — read-only 保証静的確認（§5 ガード 1）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('T1〜T5 が GET メソッドのみを使う（POST は既定モードに存在しない）', () => {
    // T1: GET /health (ヘッダなし)
    // T2: GET /health (bypass のみ)
    // T3: GET /health (bypass + 不正 Bearer)
    // T4: GET /health (full auth)
    // T5: GET /api/v1/rag/history
    // T6 のみ POST — WITH_QUERY 条件内に閉じる

    // WITH_QUERY ブロックの外に POST が存在しないこと
    // WITH_QUERY の前後でファイルを分割して確認
    const withQueryStart = content.indexOf('if [ "$WITH_QUERY" = "1" ]')
    if (withQueryStart === -1) {
      // WITH_QUERY ガードが存在することを前提にテストする
      fail('WITH_QUERY ガードブロックが見つからない')
      return
    }
    const beforeWithQuery = content.slice(0, withQueryStart)
    // WITH_QUERY ブロック前のコードに POST メソッドがないこと
    expect(beforeWithQuery).not.toContain('-X POST')
    expect(beforeWithQuery).not.toContain('-X "POST"')
  })

  it('T6（POST）が WITH_QUERY=1 の条件内にのみ存在する（§3 判断 3）', () => {
    expect(content).toContain('WITH_QUERY')
    // POST /api/v1/rag/query が WITH_QUERY ガードの中にある
    const withQueryBlock = content.match(/if \[ "\$WITH_QUERY" = "1" \]([\s\S]*?)fi/)
    expect(withQueryBlock).not.toBeNull()
    if (withQueryBlock) {
      expect(withQueryBlock[0]).toContain('/api/v1/rag/query')
      expect(withQueryBlock[0]).toContain('POST')
    }
  })

  it('T1〜T5 は /health と /api/v1/rag/history のみを呼ぶ（書込・課金経路に到達しない）', () => {
    const withQueryStart = content.indexOf('if [ "$WITH_QUERY" = "1" ]')
    const beforeWithQuery = withQueryStart !== -1 ? content.slice(0, withQueryStart) : content
    // 書込エンドポイントが既定モードに存在しない
    expect(beforeWithQuery).not.toContain('/api/v1/rag/query')
    expect(beforeWithQuery).not.toContain('/api/v1/rag/bot-context')
    expect(beforeWithQuery).not.toContain('/api/v1/rag/similar-cases')
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — negative control (§6 / T1 で 200 を FAIL と判定)
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — negative control 静的確認（§6）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('T1 で status=200 を FAIL として記録する分岐がある（外側ロック消失の検出 / §7 quality 観点）', () => {
    // T1 の case 文で 200) → FAIL の分岐
    const t1Section = (() => {
      const marker = 'T1'
      const start = content.indexOf(marker)
      if (start === -1) return ''
      // T1 セクションを T2 開始前まで抽出
      const t2Start = content.indexOf('T2', start + 1)
      return content.slice(start, t2Start !== -1 ? t2Start : start + 500)
    })()
    // 200 → FAIL の判定が存在する
    expect(t1Section).toContain('200')
    expect(t1Section).toContain('FAIL')
    // "200 = FAIL" の意味: 200 ケースで record FAIL が呼ばれる
    expect(t1Section).toMatch(/200\)[\s\S]*?FAIL/)
  })

  it('T1 の正常ケース（401 / 403 / 30x）が PASS として記録される', () => {
    const t1Section = (() => {
      const marker = 'T1'
      const start = content.indexOf(marker)
      if (start === -1) return ''
      const t2Start = content.indexOf('T2', start + 1)
      return content.slice(start, t2Start !== -1 ? t2Start : start + 500)
    })()
    // 401 ケースが PASS
    expect(t1Section).toContain('PASS')
    expect(t1Section).toMatch(/401/)
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — 一時ファイル管理（§4-2 ロジック 4 / §6 一時ファイル）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — 一時ファイル管理静的確認（§6）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('mktemp を使って一時ディレクトリを作成している', () => {
    expect(content).toContain('mktemp')
  })

  it('trap で cleanup 関数が EXIT / INT / TERM に登録されている', () => {
    expect(content).toContain('trap')
    expect(content).toContain('EXIT')
    // cleanup 関数の定義
    expect(content).toContain('cleanup()')
  })

  it('cleanup 関数が rm -rf で一時ディレクトリを削除する', () => {
    const cleanupFn = content.match(/cleanup\(\)([\s\S]*?)\}/)
    expect(cleanupFn).not.toBeNull()
    if (cleanupFn) {
      expect(cleanupFn[0]).toContain('rm -rf')
    }
  })
})

// ---------------------------------------------------------------------------
// cutover-smoke-test.sh — 新規依存ゼロ確認（§3 判断 4 / §6 / §7 両 reviewer）
// ---------------------------------------------------------------------------

describe('cutover-smoke-test.sh — 新規依存ゼロ確認（§3 判断 4）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(SMOKE_SCRIPT)
  })

  it('jq コマンドを使っていない（PTP ホストで保証できないため / §3 判断 4）', () => {
    const codeLines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
    const jqLine = codeLines.find((l) => /\bjq\b/.test(l))
    expect(jqLine).toBeUndefined()
  })

  it('curl + grep のみで JSON/HTML 種別判定している（標準ツールのみ / §3 判断 4）', () => {
    expect(content).toContain('curl')
    expect(content).toContain('grep')
    // classify_body 関数が存在する
    expect(content).toContain('classify_body')
  })

  it('curl -w "%{http_code}" でステータスコードを取得している（§4-2 ロジック 2）', () => {
    expect(content).toContain('%{http_code}')
  })
})

// ---------------------------------------------------------------------------
// ptp-client-cutover.md — 静的内容確認（§6 手順書 / §4-1）
// ---------------------------------------------------------------------------

describe('ptp-client-cutover.md — 静的内容確認（§6 手順書）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(CUTOVER_MD)
  })

  it('secret プレースホルダ形式（<...>）を使っている（実値を含まない）', () => {
    // 実値らしきものが含まれないこと
    // sk- で始まる OpenAI キー形式
    expect(content).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
    // 64 桁 hex（bearer token / bypass secret の典型形式）
    expect(content).not.toMatch(/\b[0-9a-f]{64}\b/)
    // プレースホルダ形式の存在確認
    expect(content).toContain('<')
    expect(content).toContain('>')
  })

  it('discovery grep コマンドが含まれている（PTP リポの変数名を推測しない / §4-1 §2）', () => {
    // grep コマンドで PTP リポを検索する手順
    expect(content).toContain('grep')
    expect(content).toContain('rag-api')
  })

  it('BASE_URL / RAG_HUB_BASE_URL 相当の変数名が推奨名として記載されている（§4-1 §3）', () => {
    // env 変数名の推奨名（discovery 結果に合わせる旨も含む）
    const hasBaseUrl =
      content.includes('RAG_HUB_BASE_URL') ||
      content.includes('BASE_URL') ||
      content.includes('base URL')
    expect(hasBaseUrl).toBe(true)
  })

  it('x-vercel-protection-bypass ヘッダへの言及がある（§4-1 §4(b)）', () => {
    expect(content).toContain('x-vercel-protection-bypass')
  })

  it('Authorization: Bearer の記載がある（§4-1 §4(b)）', () => {
    expect(content).toContain('Authorization')
    expect(content).toContain('Bearer')
  })

  it('Neon auto-suspend / cold start への言及がある（§2 隠れコスト / §4-1 §6）', () => {
    const hasColdStart =
      content.includes('cold start') ||
      content.includes('auto-suspend') ||
      content.includes('resume') ||
      content.includes('cold-start')
    expect(hasColdStart).toBe(true)
  })

  it('切り戻し手順が含まれている（§4-1 §7）', () => {
    const hasRollback =
      content.includes('切り戻し') ||
      content.includes('rollback') ||
      content.includes('ロールバック')
    expect(hasRollback).toBe(true)
  })

  it('トラブルシュートセクションがある（§4-1 §8）', () => {
    const hasTroubleshoot =
      content.includes('トラブルシュート') ||
      content.includes('troubleshoot') ||
      content.includes('障害') ||
      content.includes('401') // 判別表
    expect(hasTroubleshoot).toBe(true)
  })

  it('JWT ではなく静的トークンである旨の記載がある（契約差異 / §1 / §0）', () => {
    const hasStaticToken =
      content.includes('静的') ||
      content.includes('static') ||
      content.includes('JWT') // JWT への言及で区別を明示している
    expect(hasStaticToken).toBe(true)
  })

  it('IF 契約 (Idempotency-Key / timeout 10 秒) への言及がある（§4-1 §4(d)）', () => {
    const hasIdempotency =
      content.includes('Idempotency-Key') ||
      content.includes('idempotency')
    expect(hasIdempotency).toBe(true)
  })

  it('docs/operations/cutover-smoke-test.sh への参照がある（§4-1 §5）', () => {
    expect(content).toContain('cutover-smoke-test.sh')
  })
})

// ---------------------------------------------------------------------------
// README.md — Phase 5 追記確認（§4-3 / §6 / §7 両 reviewer）
// ---------------------------------------------------------------------------

describe('README.md — Phase 5 cutover セクション追記確認（§4-3）', () => {
  let content: string

  beforeAll(() => {
    content = readFile(README)
  })

  it('cutover / PTP 切替への言及がある（§4-3 追記）', () => {
    const hasCutover =
      content.includes('cutover') ||
      content.includes('切替') ||
      content.includes('PTP')
    expect(hasCutover).toBe(true)
  })

  it('ptp-client-cutover.md への参照がある（§4-3）', () => {
    expect(content).toContain('ptp-client-cutover.md')
  })

  it('cutover-smoke-test.sh への参照がある（§4-3）', () => {
    expect(content).toContain('cutover-smoke-test.sh')
  })

  it('--with-query への言及がある（read-only 既定 / opt-in の案内 / §4-3）', () => {
    expect(content).toContain('--with-query')
  })
})

// ---------------------------------------------------------------------------
// フェーズスコープの閉じ確認（§6 / §7 両 reviewer — diff がスコープ内に閉じるか）
// ---------------------------------------------------------------------------

describe('Phase 5 スコープ閉じ確認（設計書 §7 両 reviewer 共通）', () => {
  it('cutover-smoke-test.sh に新規 npm/pip 依存の require/import がない（bash のみ）', () => {
    const content = readFile(SMOKE_SCRIPT)
    // bash スクリプトに require / import が含まれないこと
    expect(content).not.toContain('require(')
    expect(content).not.toContain('import(')
  })

  it('cutover-smoke-test.sh に python / node / ruby 等の他言語インタプリタ呼び出しがない', () => {
    const content = readFile(SMOKE_SCRIPT)
    const codeLines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
    const otherLang = codeLines.find((l) =>
      /^\s*(python3?|node|ruby|perl)\b/.test(l)
    )
    expect(otherLang).toBeUndefined()
  })

  it('README.md に phase-5-design.md への参照またはセクションが追加されている', () => {
    const content = readFile(README)
    // 設計書や操作ドキュメントへのリンクが存在する
    const hasRef =
      content.includes('phase-5') ||
      content.includes('ptp-client-cutover') ||
      content.includes('設計書')
    expect(hasRef).toBe(true)
  })
})
