import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectFiles, buildItems, deriveIdempotencyKey, pickBaseDir } from '../../scripts/ingest/chunker'

/**
 * Phase 4 — scripts/ingest/chunker.ts の純関数単体テスト（設計書 §6）。
 *
 * DB 接続なし・OpenAI 呼び出しなし。
 * os.tmpdir() に実ファイルを作成し、fs 依存の純関数を検証する。
 *
 * カバーする設計書 §6 の観点:
 *   - collectFiles: ディレクトリ再帰 / 拡張子フィルタ / 隠しファイル除外 /
 *     node_modules 除外 / 結果ソート済 / 存在しないパスでエラー / 空ディレクトリで空配列
 *   - buildItems: title / externalId(相対パス) / metadata フィールド契約 /
 *     UTF-8 読込 / 10MB 超スキップ + 警告
 *   - deriveIdempotencyKey: 同一ファイル集合(順序違い) → 同一キー /
 *     内容 1 byte 変更 → 別キー / ファイル追加 → 別キー
 *   - pickBaseDir: ディレクトリ引数を優先 / 全ファイルなら最初のファイルの親
 */

// ---------------------------------------------------------------------------
// テスト用 tmpdir ユーティリティ
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-chunker-test-'))
}

function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return full
}

// ---------------------------------------------------------------------------
// collectFiles
// ---------------------------------------------------------------------------

describe('collectFiles — ディレクトリ再帰 / 拡張子フィルタ', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmp()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('AC-COLLECT-001: .md ファイルを再帰収集する', () => {
    writeFile(tmp, 'a.md', '# A')
    writeFile(tmp, 'sub/b.md', '# B')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toHaveLength(2)
    expect(files.every((f) => f.endsWith('.md'))).toBe(true)
  })

  it('AC-COLLECT-002: 拡張子フィルタ — .txt のみ指定時は .md が除外される', () => {
    writeFile(tmp, 'a.md', '# A')
    writeFile(tmp, 'b.txt', 'B')
    const files = collectFiles([tmp], ['.txt'])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('b.txt')
  })

  it('AC-COLLECT-003: 拡張子の . なしでも正規化されて動作する', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['md']) // dot 省略
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('a.md')
  })

  it('AC-COLLECT-004: 隠しファイル（. 始まり）は除外される', () => {
    writeFile(tmp, '.hidden.md', '# hidden')
    writeFile(tmp, 'visible.md', '# visible')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('visible.md')
  })

  it('AC-COLLECT-005: 隠しディレクトリ（. 始まり）配下は除外される', () => {
    writeFile(tmp, '.hiddendir/a.md', '# in hidden dir')
    writeFile(tmp, 'visible.md', '# visible')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('visible.md')
  })

  it('AC-COLLECT-006: node_modules 配下は除外される', () => {
    writeFile(tmp, 'node_modules/pkg/README.md', '# pkg')
    writeFile(tmp, 'visible.md', '# visible')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('visible.md')
  })

  it('AC-COLLECT-007: dist 配下は除外される', () => {
    writeFile(tmp, 'dist/output.md', '# dist')
    writeFile(tmp, 'visible.md', '# visible')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toHaveLength(1)
  })

  it('AC-COLLECT-008: 結果は絶対パスのソート済配列（冪等キー安定性 / §5 ガード 2）', () => {
    writeFile(tmp, 'b.md', '# B')
    writeFile(tmp, 'a.md', '# A')
    writeFile(tmp, 'c.md', '# C')
    const files = collectFiles([tmp], ['.md'])
    expect(files).toEqual([...files].sort())
    for (const f of files) {
      expect(path.isAbsolute(f)).toBe(true)
    }
  })

  it('AC-COLLECT-009: 空ディレクトリは空配列を返す（エラーにならない）', () => {
    const files = collectFiles([tmp], ['.md'])
    expect(files).toEqual([])
  })

  it('AC-COLLECT-010: 存在しないパスで ENOENT 例外が発生する', () => {
    expect(() => collectFiles(['/nonexistent/path/that/does/not/exist'], ['.md'])).toThrow()
  })

  it('AC-COLLECT-011: ファイルを直接指定した場合は拡張子一致のみ収集', () => {
    const f = writeFile(tmp, 'a.md', '# A')
    const fTxt = writeFile(tmp, 'b.txt', 'B')
    const files = collectFiles([f, fTxt], ['.md'])
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('a.md')
  })

  it('AC-COLLECT-012: ファイルとディレクトリを混在指定できる', () => {
    const subdir = path.join(tmp, 'sub')
    fs.mkdirSync(subdir, { recursive: true })
    writeFile(tmp, 'sub/c.md', '# C')
    const topFile = writeFile(tmp, 'top.md', '# top')
    const files = collectFiles([topFile, subdir], ['.md'])
    expect(files).toHaveLength(2)
  })

  it('AC-COLLECT-013: paths 空配列で例外が発生する', () => {
    expect(() => collectFiles([], ['.md'])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildItems
// ---------------------------------------------------------------------------

describe('buildItems — IngestionItemInput 組み立て', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmp()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('AC-BUILD-001: title はファイル名（拡張子除く）', () => {
    writeFile(tmp, 'my-doc.md', '# content')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(items[0]!.title).toBe('my-doc')
  })

  it('AC-BUILD-002: externalId は baseDir からの相対パス（POSIX 区切り / 再取込の対応付けキー）', () => {
    writeFile(tmp, 'sub/doc.md', '# content')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(items[0]!.externalId).toBe('sub/doc.md')
  })

  it('AC-BUILD-003: rawContent は UTF-8 文字列として読み込まれる', () => {
    const content = '# 日本語テスト\nこれはテスト文書です。'
    writeFile(tmp, 'ja.md', content)
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(items[0]!.rawContent).toBe(content)
  })

  it('AC-BUILD-004: language は "ja" 固定（MVP）', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(items[0]!.language).toBe('ja')
  })

  it('AC-BUILD-005: metadata に relativePath / fileSizeBytes / mtime が含まれる', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    const meta = items[0]!.metadata as Record<string, unknown>
    expect(meta['relativePath']).toBe('a.md')
    expect(typeof meta['fileSizeBytes']).toBe('number')
    expect(typeof meta['mtime']).toBe('string')
  })

  it('AC-BUILD-006: mtime は ISO 8601 文字列', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    const meta = items[0]!.metadata as Record<string, unknown>
    expect(() => new Date(meta['mtime'] as string).toISOString()).not.toThrow()
  })

  it('AC-BUILD-007: 10MB 超ファイルはスキップされる（黙殺禁止 / 警告は console.warn）', () => {
    // 11MB のファイルをモックする — 実際に作ると遅いので statSync を spy
    const mockStat = jest.spyOn(fs, 'statSync')
    const realStat = jest.requireActual<typeof fs>('node:fs').statSync as typeof fs.statSync

    writeFile(tmp, 'big.md', '# big')
    const bigPath = path.join(tmp, 'big.md')

    mockStat.mockImplementation((p, ...args) => {
      const result = realStat(p as string, ...(args as []))
      if (p === bigPath) {
        return { ...result, size: 11 * 1024 * 1024 }
      }
      return result
    })

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const items = buildItems([bigPath], tmp)

    expect(items).toHaveLength(0) // スキップ
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('big.md'))

    mockStat.mockRestore()
    warnSpy.mockRestore()
  })

  it('AC-BUILD-008: 10MB 未満ファイルはスキップされない', () => {
    writeFile(tmp, 'small.md', '# small')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(items).toHaveLength(1)
  })

  it('AC-BUILD-009: fileSizeBytes が実ファイルサイズと一致する', () => {
    const content = 'hello world'
    writeFile(tmp, 'size.txt', content)
    const files = collectFiles([tmp], ['.txt'])
    const items = buildItems(files, tmp)
    const meta = items[0]!.metadata as Record<string, unknown>
    const actualSize = Buffer.byteLength(content, 'utf8')
    expect(meta['fileSizeBytes']).toBe(actualSize)
  })

  it('AC-BUILD-010: metadata.relativePath が POSIX 区切り（/ のみ）', () => {
    writeFile(tmp, 'sub/deep/doc.md', '# deep')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    const meta = items[0]!.metadata as Record<string, unknown>
    expect(meta['relativePath']).not.toContain('\\')
    expect(meta['relativePath']).toBe('sub/deep/doc.md')
  })
})

// ---------------------------------------------------------------------------
// deriveIdempotencyKey — §5 ガード 2 / §3 判断 5
// ---------------------------------------------------------------------------

describe('deriveIdempotencyKey — 冪等キー安定導出（§5 ガード 2）', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmp()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('AC-IDEM-001: 同一ファイル集合（順序違い）→ 同一キー（順序非依存）', () => {
    writeFile(tmp, 'a.md', '# A')
    writeFile(tmp, 'b.md', '# B')
    const files = collectFiles([tmp], ['.md'])
    const items1 = buildItems(files, tmp)
    // 順序を逆にした items2
    const items2 = [...items1].reverse()
    expect(deriveIdempotencyKey(items1)).toBe(deriveIdempotencyKey(items2))
  })

  it('AC-IDEM-002: 内容 1 byte 変更 → 別キー', () => {
    writeFile(tmp, 'a.md', '# A original')
    const files = collectFiles([tmp], ['.md'])
    const items1 = buildItems(files, tmp)
    const key1 = deriveIdempotencyKey(items1)

    // ファイル内容を変更
    fs.writeFileSync(path.join(tmp, 'a.md'), '# A modified', 'utf8')
    const items2 = buildItems(files, tmp)
    const key2 = deriveIdempotencyKey(items2)

    expect(key1).not.toBe(key2)
  })

  it('AC-IDEM-003: ファイル追加 → 別キー', () => {
    writeFile(tmp, 'a.md', '# A')
    const files1 = collectFiles([tmp], ['.md'])
    const items1 = buildItems(files1, tmp)
    const key1 = deriveIdempotencyKey(items1)

    writeFile(tmp, 'b.md', '# B new')
    const files2 = collectFiles([tmp], ['.md'])
    const items2 = buildItems(files2, tmp)
    const key2 = deriveIdempotencyKey(items2)

    expect(key1).not.toBe(key2)
  })

  it('AC-IDEM-004: キーは "cli-" プレフィックスで始まる（サーバ系列と区別 / 設計書 §4-2）', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    const key = deriveIdempotencyKey(items)
    expect(key.startsWith('cli-')).toBe(true)
  })

  it('AC-IDEM-005: mtime が変わっても内容が同一ならキーが変わらない（mtime はキー対象外）', () => {
    writeFile(tmp, 'a.md', '# A constant content')
    const files = collectFiles([tmp], ['.md'])
    const items1 = buildItems(files, tmp)
    const key1 = deriveIdempotencyKey(items1)

    // mtime を変更（ファイル内容は同一 / touch 相当）
    const now = new Date()
    fs.utimesSync(path.join(tmp, 'a.md'), now, now)
    // buildItems を再実行 → mtime が変わっているが rawContent は同じ
    const items2 = buildItems(files, tmp)

    const key2 = deriveIdempotencyKey(items2)
    expect(key1).toBe(key2)
  })

  it('AC-IDEM-006: 同一内容で 2 回呼んでも結果が同一（決定的 / 副作用なし）', () => {
    writeFile(tmp, 'a.md', '# A')
    const files = collectFiles([tmp], ['.md'])
    const items = buildItems(files, tmp)
    expect(deriveIdempotencyKey(items)).toBe(deriveIdempotencyKey(items))
  })
})

// ---------------------------------------------------------------------------
// pickBaseDir
// ---------------------------------------------------------------------------

describe('pickBaseDir — baseDir 選定', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeTmp()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('AC-BASEDIR-001: ディレクトリ引数があればそのディレクトリを返す', () => {
    const result = pickBaseDir([tmp])
    expect(path.resolve(result)).toBe(path.resolve(tmp))
  })

  it('AC-BASEDIR-002: 全引数がファイルなら最初のファイルの親ディレクトリを返す', () => {
    const f1 = writeFile(tmp, 'sub/doc.md', '# doc')
    const f2 = writeFile(tmp, 'sub/other.md', '# other')
    const result = pickBaseDir([f1, f2])
    expect(path.resolve(result)).toBe(path.resolve(path.dirname(f1)))
  })

  it('AC-BASEDIR-003: ファイルとディレクトリが混在する場合はディレクトリを優先', () => {
    const f1 = writeFile(tmp, 'doc.md', '# doc')
    const result = pickBaseDir([f1, tmp])
    // ディレクトリが優先される
    expect(path.resolve(result)).toBe(path.resolve(tmp))
  })
})
