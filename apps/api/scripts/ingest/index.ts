/**
 * Phase 4 / RAG Ingestion CLI エントリポイント（設計書 §4-1）。
 *
 * 機能:
 *   - 引数で指定された file / dir を走査し、chunk → embed → Neon に書き込む
 *   - 既存 IngestionService を Nest standalone context 経由で再利用（再実装禁止 / §3 判断 1）
 *   - DATABASE_URL を DIRECT_URL で上書き（pooler 経由を回避 / §3 判断 3）
 *   - 冪等 replay 対応（同一内容の再実行は課金ゼロ・DB 書込ゼロ / §5 ガード 1-2）
 *   - --dry-run は Stub provider 経由かつ DB 書込ゼロ（ジョブ行も作らない / §5 ガード 7）
 *
 * 設計書: docs/operations/phase-4-design.md
 * runbook: docs/operations/ingestion-runbook.md
 */

// --- 副作用順序の注意 -------------------------------------------------------
// PrismaClient は **インスタンス化時** に env('DATABASE_URL') を解決する。
// よって以下の `applyDirectUrlOverride()` は **PrismaService を間接 import する
// 全ての文より前** に評価される必要がある。本ファイルは TypeScript の top-level
// import 評価順に従い、まず env 上書きしてから他 import を行う形にする。
// （実装上は applyDirectUrlOverride を 1 関数として top で呼び、PrismaService を
//  含む import は **動的 import**（後段）で行うことで順序保証する。）

/** DIRECT_URL があれば DATABASE_URL を上書きする（PrismaClient インスタンス化前に呼ぶこと）。 */
function applyDirectUrlOverride(): void {
  const direct = process.env.DIRECT_URL
  if (direct !== undefined && direct.length > 0) {
    process.env.DATABASE_URL = direct
  }
}

applyDirectUrlOverride()

// 上記より下の import は PrismaService を巻き込んでよい（env 上書き済）。
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { MVP_SOURCE_TYPES, SOURCE_STATUSES, type MvpSourceType } from '@pmtp/shared'

/** usage 表示。 */
function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  npm run ingest -- <path> [<path>...] [options]

Arguments:
  <path>                  File or directory to ingest (one or more required).

Options:
  --source-type <type>    One of: ${MVP_SOURCE_TYPES.join(' | ')}  (default: strategy_doc)
  --source-name <name>    RagSource find-or-create key. (default: local-cli)
  --ext <csv>             Extensions to scan (default: .md,.txt)
  --dry-run               Use Stub embedding provider and skip DB writes.
  --force                 Omit idempotencyKey (force new job; bypass replay).
  --idempotency-key <k>   Override auto-derived idempotency key.
  -h, --help              Show this help.

Examples:
  npm run ingest -- ./docs/strategy --source-type strategy_doc
  npm run ingest -- ./docs/strategy ./notes.md
  npm run ingest -- ./docs/strategy --dry-run
`)
}

interface ParsedCliArgs {
  paths: string[]
  sourceType: MvpSourceType
  sourceName: string
  exts: string[]
  dryRun: boolean
  force: boolean
  idempotencyKeyOverride: string | undefined
}

/** 引数を parseArgs で解析し、検証する。失敗時は exit 2。 */
function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'source-type': { type: 'string', default: 'strategy_doc' },
      'source-name': { type: 'string', default: 'local-cli' },
      ext: { type: 'string', default: '.md,.txt' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'idempotency-key': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (parsed.values.help) {
    printUsage()
    process.exit(0)
  }

  const paths = parsed.positionals
  if (paths.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[ingest] ERROR: at least one path is required.')
    printUsage()
    process.exit(2)
  }

  const sourceTypeRaw = String(parsed.values['source-type'])
  if (!(MVP_SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)) {
    // eslint-disable-next-line no-console
    console.error(
      `[ingest] ERROR: --source-type must be one of: ${MVP_SOURCE_TYPES.join(', ')}. Got: ${sourceTypeRaw}`,
    )
    process.exit(2)
  }

  const exts = String(parsed.values.ext)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (exts.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[ingest] ERROR: --ext must contain at least one extension.')
    process.exit(2)
  }

  return {
    paths,
    sourceType: sourceTypeRaw as MvpSourceType,
    sourceName: String(parsed.values['source-name']),
    exts,
    dryRun: Boolean(parsed.values['dry-run']),
    force: Boolean(parsed.values.force),
    idempotencyKeyOverride: parsed.values['idempotency-key'] as string | undefined,
  }
}

/** メイン処理。 */
async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2))

  // env fail-fast（dry-run 時を除く / 設計書 §3 判断 2 / §4-1 ロジック 3）
  if (!args.dryRun) {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length === 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[ingest] ERROR: OPENAI_API_KEY is not set. Set it in .env or pass --dry-run.',
      )
      return 2
    }
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.length === 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[ingest] ERROR: neither DATABASE_URL nor DIRECT_URL is set. Configure .env (see docs/operations/neon-setup.md).',
      )
      return 2
    }
  }

  // 動的 import: ここでようやく PrismaService 等を含むモジュールを評価する
  // （applyDirectUrlOverride 後であることを保証するため）
  const { NestFactory } = await import('@nestjs/core')
  const { collectFiles, buildItems, deriveIdempotencyKey, pickBaseDir } = await import(
    './chunker'
  )
  const { IngestCliModule, IngestCliDryRunModule } = await import('./embedder')
  const { chunkItem } = await import('../../src/ingestion/chunker')

  // 1. ファイル走査 + item 組み立て
  let files: string[]
  try {
    files = collectFiles(args.paths, args.exts)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ingest] ERROR: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[ingest] ERROR: no files matched. paths=${JSON.stringify(args.paths)} exts=${args.exts.join(',')}`,
    )
    return 2
  }

  const baseDir = pickBaseDir(args.paths)
  const items = buildItems(files, baseDir)
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[ingest] ERROR: all files skipped (e.g. all over 10MB). nothing to ingest.')
    return 2
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ingest] discovered ${items.length} file(s) under ${baseDir} (mode=${args.dryRun ? 'dry-run' : 'live'})`,
  )

  // --- dry-run: ジョブ行を作らず chunk プレビューだけ表示（§5 ガード 7） -----
  if (args.dryRun) {
    let totalChunks = 0
    for (const item of items) {
      const chunks = chunkItem(item, args.sourceType)
      totalChunks += chunks.length
      // eslint-disable-next-line no-console
      console.log(
        `  [dry-run] ${item.externalId ?? '(no-externalId)'} -> ${chunks.length} chunk(s)`,
      )
    }
    // eslint-disable-next-line no-console
    console.log(
      `[ingest] dry-run complete: items=${items.length} chunks=${totalChunks} (no DB writes, no embedding calls)`,
    )
    return 0
  }

  // --- live: Nest standalone context 起動 → IngestionService.ingest() -----
  const app = await NestFactory.createApplicationContext(IngestCliModule, {
    logger: ['error', 'warn'],
  })
  try {
    // PrismaService を取得して RagSource を find-or-create
    const { PrismaService } = await import(
      '../../src/modules/rag/infrastructure/prisma/prisma.service'
    )
    const { IngestionService } = await import('../../src/ingestion/ingestion.service')

    const prisma = app.get(PrismaService)
    const ingestion = app.get(IngestionService)

    const source = await prisma.ragSource.upsert({
      where: {
        sourceType_sourceName: {
          sourceType: args.sourceType,
          sourceName: args.sourceName,
        },
      },
      update: {},
      create: {
        sourceType: args.sourceType,
        sourceName: args.sourceName,
        displayName: `${args.sourceType}:${args.sourceName}`,
        reliabilityScore: '1.0',
        status: SOURCE_STATUSES[0], // 'ACTIVE'
      },
      select: { id: true },
    })

    // 冪等キー導出（--force 時は undefined / --idempotency-key で上書き可）
    let idempotencyKey: string | undefined
    if (args.idempotencyKeyOverride !== undefined && args.idempotencyKeyOverride.length > 0) {
      idempotencyKey = args.idempotencyKeyOverride
    } else if (args.force) {
      idempotencyKey = undefined
    } else {
      idempotencyKey = deriveIdempotencyKey(items)
    }

    const traceId = randomUUID()
    const requestId = randomUUID()

    // eslint-disable-next-line no-console
    console.log(
      `[ingest] start ingest sourceId=${source.id} idempotencyKey=${idempotencyKey ?? '(none)'}`,
    )

    const result = await ingestion.ingest({
      sourceId: source.id,
      sourceType: args.sourceType,
      jobType: 'manual_upload',
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      items,
      traceId,
      requestId,
    })

    // 結果サマリ表示（OPENAI_API_KEY / DB URL / 本文は出さない）
    // eslint-disable-next-line no-console
    console.log(
      `[ingest] job ${result.jobId} status=${result.status} replayed=${result.replayed} total=${result.totalCount} success=${result.successCount} failed=${result.failedCount}`,
    )
    for (const item of result.items) {
      const id = item.externalId ?? item.documentId ?? '(no-id)'
      // eslint-disable-next-line no-console
      console.log(
        `  - ${id}: status=${item.status} chunks=${item.chunkCount} reused=${item.reusedEmbeddingCount} new=${item.newEmbeddingCount}${
          item.errorMessage ? ` error=${truncate(item.errorMessage, 200)}` : ''
        }`,
      )
    }

    // exit code: 全 SUCCESS/SKIPPED = 0 / 1 件でも FAILED = 1
    if (result.status === 'FAILED' || result.failedCount > 0) return 1
    return 0
  } finally {
    // finally で必ず接続を切る（Neon Free 接続枠の圧迫回避 / §4-1 ロジック 9）
    await app.close()
  }
}

/** メッセージ長を抑制（log 表示用）。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`
}

// エントリ
main()
  .then((code) => {
    process.exit(code)
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[ingest] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    process.exit(1)
  })
