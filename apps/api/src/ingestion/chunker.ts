import type { Language, SourceType } from '@pmtp/shared'
import { sha256Hex } from './content-hash'
import { scanForInjection } from './injection-scanner'
import { estimateTokens } from './token-estimator'
import type { ChunkDraft, IngestionItemInput } from './ingestion.types'

/**
 * source_type 別 Chunker（27_Chunking設計書 §5〜§8 / §10.3）。
 *
 * 出力契約（不変条件 / 27 §10.3 + AC-CHUNK-011/012）:
 *   - 同一 document 配下の chunkIndex は 0 起点・連続・重複なし
 *   - 表（| ... |）/ コードブロック（``` フェンス）を境界で分断しない（atomic）
 *   - injection 疑い chunk は status='QUARANTINED'、通常は 'ACTIVE'
 *   - 各 chunk に contentHash（sha256）必須付与
 *
 * 注: 入力テキストは normalizer 通過後（正規化 + Secret/PII マスク済み）を渡すこと。
 */

/** MVP 標準値（27 §5.2）。 */
const DEFAULT_CHUNK_SIZE_TOKENS = 700
const DEFAULT_OVERLAP_TOKENS = 100
const MAX_CHUNK_SIZE_TOKENS = 1000
const MIN_CHUNK_SIZE_TOKENS = 80

/** market_data の timeframe 別 window（27 §7.3 / 本数・overlap）。 */
const MARKET_WINDOW: Record<string, { window: number; overlap: number }> = {
  '1m': { window: 120, overlap: 20 },
  '5m': { window: 96, overlap: 12 },
  '15m': { window: 96, overlap: 12 },
  '1h': { window: 72, overlap: 12 },
  '4h': { window: 60, overlap: 8 },
  '1d': { window: 90, overlap: 10 },
}
const MARKET_WINDOW_FALLBACK = { window: 72, overlap: 12 }

export interface ChunkContext {
  readonly sourceType: SourceType
  readonly language: Language
  readonly symbol: string | null
  readonly market: string | null
  readonly timeframe: string | null
  readonly eventTime: Date | null
  readonly baseMetadata: Record<string, unknown>
  readonly riskTags: string[]
}

/**
 * item を source_type に応じて chunk 分割する。
 */
export function chunkItem(
  item: IngestionItemInput,
  sourceType: SourceType,
): ChunkDraft[] {
  const ctx: ChunkContext = {
    sourceType,
    language: item.language ?? 'ja',
    symbol: item.symbol ?? null,
    market: item.market ?? null,
    timeframe: item.timeframe ?? null,
    eventTime: item.eventTime ?? null,
    baseMetadata: { ...(item.metadata ?? {}) },
    riskTags: extractRiskTags(item.metadata),
  }

  let bodies: string[]
  switch (sourceType) {
    case 'strategy_doc':
      bodies = chunkStrategyDoc(item.rawContent)
      break
    case 'bot_log':
    case 'order_history':
      bodies = chunkRecords(item)
      break
    case 'market_data':
      bodies = chunkMarketData(item)
      break
    default:
      // MVP 対象外の source_type は token 分割にフォールバック（防御的）。
      bodies = splitByTokens(item.rawContent, DEFAULT_CHUNK_SIZE_TOKENS, DEFAULT_OVERLAP_TOKENS)
  }

  return finalize(bodies, ctx)
}

/* -------------------------------------------------------------------------- */
/* strategy_doc: 見出し分割 + token 再分割 + 表/コード atomic（27 §7.1 / §5.3）  */
/* -------------------------------------------------------------------------- */

export function chunkStrategyDoc(markdown: string): string[] {
  const sections = splitByHeadings(markdown)
  const out: string[] = []
  for (const section of sections) {
    if (estimateTokens(section) <= MAX_CHUNK_SIZE_TOKENS) {
      out.push(section)
    } else {
      // 大きい section は atomic（表/コード）を保ったまま token 再分割。
      for (const piece of splitLongSection(section)) {
        out.push(piece)
      }
    }
  }
  return out.filter((s) => s.trim().length > 0)
}

/** Markdown 見出し（# 〜 ######）で分割。見出し行は直下の本文と同一 chunk に含める。 */
function splitByHeadings(markdown: string): string[] {
  const lines = markdown.split('\n')
  const sections: string[] = []
  let current: string[] = []
  let insideCodeFence = false

  for (const line of lines) {
    if (/^```/.test(line.trim())) insideCodeFence = !insideCodeFence
    const isHeading = !insideCodeFence && /^#{1,6}\s+/.test(line)
    if (isHeading && current.length > 0) {
      sections.push(current.join('\n').trim())
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n').trim())
  return sections.filter((s) => s.length > 0)
}

/**
 * 大きい section を行ベースで再分割する。表・コードブロックは atomic（途中分断禁止）。
 * 表が単独で MAX を超える場合は行分割し、各断片にヘッダ + 区切り行を複製する（27 §5.3）。
 */
function splitLongSection(section: string): string[] {
  const blocks = splitIntoAtomicBlocks(section)
  const out: string[] = []
  let buf: string[] = []
  let bufTokens = 0

  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf.join('\n').trim())
      buf = []
      bufTokens = 0
    }
  }

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text)

    if (block.kind === 'table' && blockTokens > MAX_CHUNK_SIZE_TOKENS) {
      flush()
      for (const part of splitTableByRows(block.text)) out.push(part)
      continue
    }
    if (block.kind === 'code' && blockTokens > MAX_CHUNK_SIZE_TOKENS) {
      flush()
      for (const part of splitCodeBlock(block.text)) out.push(part)
      continue
    }

    // atomic ブロックを跨がない範囲で buffer に積む。
    if (bufTokens + blockTokens > DEFAULT_CHUNK_SIZE_TOKENS && buf.length > 0) {
      flush()
    }
    buf.push(block.text)
    bufTokens += blockTokens
  }
  flush()
  return out
}

type AtomicBlock = { kind: 'text' | 'table' | 'code'; text: string }

/**
 * section を「通常テキスト / 表 / コードブロック」の atomic 単位に分解する。
 * 表・コードは 1 つの構造要素として 1 ブロックにまとめる（境界で割らない）。
 */
export function splitIntoAtomicBlocks(section: string): AtomicBlock[] {
  const lines = section.split('\n')
  const blocks: AtomicBlock[] = []
  let i = 0

  const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // コードフェンス
    if (/^\s*```/.test(line)) {
      const codeLines = [line]
      i += 1
      while (i < lines.length) {
        codeLines.push(lines[i] ?? '')
        if (/^\s*```/.test(lines[i] ?? '')) {
          i += 1
          break
        }
        i += 1
      }
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }

    // 表（連続する | 行）
    if (isTableRow(line)) {
      const tableLines: string[] = []
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        tableLines.push(lines[i] ?? '')
        i += 1
      }
      blocks.push({ kind: 'table', text: tableLines.join('\n') })
      continue
    }

    // 通常テキスト（次の表/コード/末尾まで）
    const textLines: string[] = []
    while (
      i < lines.length &&
      !/^\s*```/.test(lines[i] ?? '') &&
      !isTableRow(lines[i] ?? '')
    ) {
      textLines.push(lines[i] ?? '')
      i += 1
    }
    if (textLines.join('').trim().length > 0) {
      blocks.push({ kind: 'text', text: textLines.join('\n') })
    }
  }
  return blocks
}

/** 表を行単位で分割し、各断片にヘッダ行 + 区切り行を複製先頭付与する（27 §5.3）。 */
export function splitTableByRows(table: string): string[] {
  const rows = table.split('\n').filter((r) => r.trim().length > 0)
  if (rows.length <= 2) return [table] // ヘッダ + 区切りのみ
  const header = rows[0] ?? ''
  const divider = rows[1] ?? ''
  const dataRows = rows.slice(2)

  const out: string[] = []
  let buf: string[] = []
  let bufTokens = estimateTokens([header, divider].join('\n'))

  const flush = (): void => {
    if (buf.length > 0) {
      out.push([header, divider, ...buf].join('\n'))
      buf = []
      bufTokens = estimateTokens([header, divider].join('\n'))
    }
  }
  for (const row of dataRows) {
    const t = estimateTokens(row)
    if (bufTokens + t > MAX_CHUNK_SIZE_TOKENS && buf.length > 0) flush()
    buf.push(row)
    bufTokens += t
  }
  flush()
  return out
}

/** コードブロックを論理行で分割し、各断片のフェンスを閉じ直す（27 §5.3 / フェンス開きっぱなし禁止）。 */
export function splitCodeBlock(code: string): string[] {
  const lines = code.split('\n')
  const fence = lines[0]?.trim() ?? '```'
  const lang = fence.replace(/^`+/, '')
  // 先頭/末尾フェンスを除いた中身。
  const inner = lines.slice(1, lines[lines.length - 1]?.trim().startsWith('```') ? -1 : undefined)

  const out: string[] = []
  let buf: string[] = []
  let bufTokens = 0
  const open = '```' + lang
  const baseTokens = estimateTokens(open + '\n```')

  const flush = (): void => {
    if (buf.length > 0) {
      out.push([open, ...buf, '```'].join('\n'))
      buf = []
      bufTokens = 0
    }
  }
  for (const line of inner) {
    const t = estimateTokens(line)
    if (bufTokens + t + baseTokens > MAX_CHUNK_SIZE_TOKENS && buf.length > 0) flush()
    buf.push(line)
    bufTokens += t
  }
  flush()
  return out.length > 0 ? out : [code]
}

/* -------------------------------------------------------------------------- */
/* bot_log / order_history: 1 レコード = 1 chunk（27 §7.2 / §5.1）             */
/* -------------------------------------------------------------------------- */

export function chunkRecords(item: IngestionItemInput): string[] {
  if (item.records && item.records.length > 0) {
    return item.records.map((r) => recordToText(r))
  }
  // records 未指定: rawContent を「空行区切りの 1 レコード」とみなす。
  const blocks = item.rawContent
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  return blocks.length > 0 ? blocks : [item.rawContent.trim()]
}

/** 構造化レコードを安定した key=value テキストに変換（27 §7.2 のチャンク本文例）。 */
export function recordToText(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join('\n')
}

function formatValue(v: unknown): string {
  if (typeof v === 'object') return JSON.stringify(v)
  // 金融数値（string）は素通し（横断規約 §2 / number 化しない）。
  return String(v)
}

/* -------------------------------------------------------------------------- */
/* market_data: timeframe 別 fixed window（27 §7.3）                          */
/* -------------------------------------------------------------------------- */

export function chunkMarketData(item: IngestionItemInput): string[] {
  const tf = item.timeframe ?? '1h'
  const { window, overlap } = MARKET_WINDOW[tf] ?? MARKET_WINDOW_FALLBACK

  const records = item.records ?? []
  if (records.length === 0) {
    // records 未指定: rawContent を 1 chunk として扱う。
    return [item.rawContent.trim()].filter((s) => s.length > 0)
  }

  const step = Math.max(1, window - overlap)
  const out: string[] = []
  for (let start = 0; start < records.length; start += step) {
    const slice = records.slice(start, start + window)
    if (slice.length === 0) break
    out.push(slice.map((r) => recordToText(r)).join('\n---\n'))
    if (start + window >= records.length) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* token 分割（フォールバック / overlap は atomic 要素にスナップ）              */
/* -------------------------------------------------------------------------- */

export function splitByTokens(
  text: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const blocks = splitIntoAtomicBlocks(text)
  const out: string[] = []
  let buf: AtomicBlock[] = []
  let bufTokens = 0

  const flush = (): void => {
    if (buf.length === 0) return
    out.push(buf.map((b) => b.text).join('\n').trim())
    // overlap: 末尾の atomic ブロックを次 chunk 先頭に持ち越す（要素境界でスナップ）。
    const carried: AtomicBlock[] = []
    let carriedTokens = 0
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      const t = estimateTokens(buf[i]!.text)
      if (carriedTokens + t > overlap) break
      carried.unshift(buf[i]!)
      carriedTokens += t
    }
    buf = carried
    bufTokens = carriedTokens
  }

  for (const block of blocks) {
    const t = estimateTokens(block.text)
    if (bufTokens + t > chunkSize && buf.length > 0) flush()
    buf.push(block)
    bufTokens += t
  }
  if (buf.length > 0) out.push(buf.map((b) => b.text).join('\n').trim())
  return out.filter((s) => s.length > 0)
}

/* -------------------------------------------------------------------------- */
/* 共通: ChunkDraft 化（metadata 付与 / hash / injection / chunk_index 採番）    */
/* -------------------------------------------------------------------------- */

function finalize(bodies: string[], ctx: ChunkContext): ChunkDraft[] {
  const cleaned = bodies.map((b) => b.trim()).filter((b) => b.length > 0)
  return cleaned.map((content, index) => {
    const scan = scanForInjection(content)
    const metadata: Record<string, unknown> = {
      ...ctx.baseMetadata,
      source_type: ctx.sourceType,
      chunk_index: index,
      language: ctx.language,
      ...(ctx.symbol ? { symbol: ctx.symbol } : {}),
      ...(ctx.market ? { market: ctx.market } : {}),
      ...(ctx.timeframe ? { timeframe: ctx.timeframe } : {}),
      ...(ctx.eventTime ? { event_time: ctx.eventTime.toISOString() } : {}),
      ...(scan.suspected ? { injection_suspected: scan.matchedPatterns } : {}),
    }
    return {
      chunkIndex: index,
      content,
      contentHash: sha256Hex(content),
      tokenCount: estimateTokens(content),
      metadata,
      sourceType: ctx.sourceType,
      symbol: ctx.symbol,
      market: ctx.market,
      timeframe: ctx.timeframe,
      eventTime: ctx.eventTime,
      language: ctx.language,
      riskTags: ctx.riskTags,
      status: scan.suspected ? 'QUARANTINED' : 'ACTIVE',
    }
  })
}

function extractRiskTags(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return []
  const tags = metadata['risk_tags']
  if (Array.isArray(tags)) {
    return tags.filter((t): t is string => typeof t === 'string')
  }
  return []
}

/** MIN_CHUNK_SIZE_TOKENS 未満を弾きたい場面のための公開定数（テスト・呼び出し側用）。 */
export const CHUNK_LIMITS = {
  defaultSize: DEFAULT_CHUNK_SIZE_TOKENS,
  defaultOverlap: DEFAULT_OVERLAP_TOKENS,
  maxSize: MAX_CHUNK_SIZE_TOKENS,
  minSize: MIN_CHUNK_SIZE_TOKENS,
} as const
