/**
 * CLI 用 ファイル走査 + IngestionItemInput 組み立て モジュール（Phase 4 / 設計書 §4-2）。
 *
 * 設計書からの責務再定義: 本ファイルは **token chunk 分割を実装しない**。
 * token 分割は既存 `src/ingestion/chunker.ts`（既定 700 / max 1000 token）が
 * IngestionService 内で実施する。本ファイルは fs のみ依存の純関数群で、
 * ディレクトリ走査 + ファイル → IngestionItemInput 変換のみ担う。
 *
 * 参照:
 *   - 設計書 docs/operations/phase-4-design.md §4-2
 *   - IngestionItemInput の契約: src/ingestion/ingestion.types.ts
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { resolve, relative, join, basename, extname, sep } from 'node:path'
import { sha256Hex, stableHashOfJson } from '../../src/ingestion/content-hash'
import type { IngestionItemInput } from '../../src/ingestion/ingestion.types'

/** 1 ファイルあたりの上限（OpenAI batch / メモリ保護）。 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

/** 走査時に除外するディレクトリ名。 */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git'])

/**
 * 引数で指定されたパス（ファイル / ディレクトリ混在可）を走査し、
 * 拡張子フィルタにかけて **絶対パスのソート済**配列を返す。
 *
 * - ディレクトリは再帰走査
 * - 隠しファイル（'.' 始まり）と node_modules / dist / .git は除外
 * - 存在しないパスは例外
 *
 * ソート安定性は idempotencyKey の安定導出に必須（設計書 §3 判断 5 / §5 ガード 2）。
 */
export function collectFiles(paths: string[], exts: string[]): string[] {
  if (paths.length === 0) {
    throw new Error('collectFiles: paths must not be empty')
  }
  const normalizedExts = exts.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
  const collected = new Set<string>()

  for (const p of paths) {
    const abs = resolve(p)
    const stat = statSync(abs) // 存在しなければ ENOENT
    if (stat.isDirectory()) {
      walkDir(abs, normalizedExts, collected)
    } else if (stat.isFile()) {
      if (matchesExt(abs, normalizedExts)) {
        collected.add(abs)
      }
    }
  }

  return Array.from(collected).sort()
}

function walkDir(dir: string, exts: string[], out: Set<string>): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 隠しファイル / 隠しディレクトリ
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      walkDir(join(dir, entry.name), exts, out)
    } else if (entry.isFile()) {
      const full = join(dir, entry.name)
      if (matchesExt(full, exts)) {
        out.add(full)
      }
    }
  }
}

function matchesExt(file: string, exts: string[]): boolean {
  const ext = extname(file).toLowerCase()
  return exts.includes(ext)
}

/**
 * ファイル群 → IngestionItemInput[] を組み立てる。
 * - 10MB 超ファイルは警告して **スキップ**（黙殺禁止 / 設計書 §4-2 ガード）
 * - 1 ファイル = 1 item
 * - title = ファイル名（拡張子除く）
 * - externalId = baseDir からの相対パス（再取込時の document 対応付けキー）
 * - language = 'ja' 固定（MVP）
 */
export function buildItems(files: string[], baseDir: string): IngestionItemInput[] {
  const items: IngestionItemInput[] = []
  const absBaseDir = resolve(baseDir)

  for (const file of files) {
    const stat = statSync(file)
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ingest] WARN: skip ${file} (size ${stat.size} bytes > ${MAX_FILE_SIZE_BYTES} bytes / 10MB)`,
      )
      continue
    }
    const rawContent = readFileSync(file, 'utf8')
    const relativePath = toPosixPath(relative(absBaseDir, file))

    items.push({
      externalId: relativePath,
      title: basename(file, extname(file)),
      rawContent,
      language: 'ja',
      metadata: {
        relativePath,
        fileSizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
      },
    })
  }

  return items
}

/**
 * idempotencyKey を items 内容から決定的に導出する（設計書 §3 判断 5 / §5 ガード 2）。
 *
 * - externalId（= 相対パス）でソート → 順序非依存
 * - 各 item の {externalId, contentHash} のみをハッシュ対象にする
 *   （fileSizeBytes / mtime を入れると同一内容でもキーが変わる = ガード無効化）
 * - 'cli-' プレフィックスでサーバ系列の idempotencyKey と区別
 */
export function deriveIdempotencyKey(items: ReadonlyArray<IngestionItemInput>): string {
  const fingerprint = items
    .map((item) => ({
      externalId: item.externalId ?? '',
      contentHash: sha256Hex(item.rawContent),
    }))
    .sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0))
  return `cli-${stableHashOfJson(fingerprint)}`
}

/** baseDir の選定: 引数 paths のうちディレクトリがあればそれ、無ければ最初のファイルの dirname。 */
export function pickBaseDir(paths: string[]): string {
  for (const p of paths) {
    const abs = resolve(p)
    const stat = statSync(abs)
    if (stat.isDirectory()) return abs
  }
  // 全てファイルの場合: 最初のファイルの親ディレクトリ
  const firstAbs = resolve(paths[0]!)
  return firstAbs.split(sep).slice(0, -1).join(sep) || sep
}

/** Windows path 対策（CI / Vercel 等で macOS/Linux 経路を想定するが防御的に正規化）。 */
function toPosixPath(p: string): string {
  return p.split(sep).join('/')
}
