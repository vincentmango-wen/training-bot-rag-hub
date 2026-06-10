import {
  chunkItem,
  chunkRecords,
  chunkMarketData,
  splitIntoAtomicBlocks,
  splitTableByRows,
  splitCodeBlock,
  recordToText,
} from '../chunker'
import { validateChunkIndexContinuity } from '../chunk-index-validator'
import type { IngestionItemInput } from '../ingestion.types'

describe('chunker — strategy_doc', () => {
  it('AC-CHUNK-001/002: 見出し単位で chunk を生成し metadata を付与する', () => {
    const md = [
      '# 戦略概要',
      'BTC の短期反発を狙う。',
      '',
      '## リスク',
      '上位足の下落継続に注意。',
    ].join('\n')
    const item: IngestionItemInput = { rawContent: md, symbol: 'BTCUSDT', market: 'crypto' }
    const chunks = chunkItem(item, 'strategy_doc')

    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]!.metadata['source_type']).toBe('strategy_doc')
    expect(chunks[0]!.metadata['symbol']).toBe('BTCUSDT')
    expect(chunks[0]!.contentHash).toHaveLength(64)
    expect(chunks[0]!.status).toBe('ACTIVE')
  })

  it('AC-CHUNK-012: chunk_index が 0 起点・連続・重複なし', () => {
    const md = Array.from({ length: 6 }, (_, i) => `## 見出し${i}\n本文${i}`).join('\n')
    const chunks = chunkItem({ rawContent: md }, 'strategy_doc')
    const validation = validateChunkIndexContinuity(chunks)
    expect(validation.valid).toBe(true)
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
  })
})

describe('chunker — atomic 要素（AC-CHUNK-011 / 27 §5.3）', () => {
  it('表は 1 つの atomic ブロックとして検出される', () => {
    const section = ['段落テキスト', '| a | b |', '|---|---|', '| 1 | 2 |', '次の段落'].join('\n')
    const blocks = splitIntoAtomicBlocks(section)
    const table = blocks.find((b) => b.kind === 'table')
    expect(table).toBeDefined()
    expect(table!.text).toContain('| a | b |')
    expect(table!.text).toContain('| 1 | 2 |')
  })

  it('コードブロックは開閉フェンスを含む 1 ブロックとして検出される', () => {
    const section = ['説明', '```ts', 'const x = 1', 'const y = 2', '```', '後続'].join('\n')
    const blocks = splitIntoAtomicBlocks(section)
    const code = blocks.find((b) => b.kind === 'code')
    expect(code).toBeDefined()
    expect(code!.text.startsWith('```ts')).toBe(true)
    expect(code!.text.trimEnd().endsWith('```')).toBe(true)
  })

  it('大きい表は行分割され、各断片にヘッダ+区切り行が複製される', () => {
    const header = '| 銘柄 | 説明 |'
    const divider = '|------|------|'
    // 各行を CJK 多めにして 1 行 ≈ 40 token 程度に膨らませ、合計を MAX(1000) 超に。
    const rows = Array.from(
      { length: 80 },
      (_, i) => `| BTCUSDT-${i} | これは行${i}の説明テキストで意味のある長さを確保するための文章 |`,
    )
    const table = [header, divider, ...rows].join('\n')
    const parts = splitTableByRows(table)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part).toContain(header)
      expect(part).toContain(divider)
    }
  })

  it('大きいコードブロックは分割されても全断片のフェンスが閉じている', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `const v${i} = ${i}`)
    const code = ['```ts', ...lines, '```'].join('\n')
    const parts = splitCodeBlock(code)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      const fences = (part.match(/```/g) ?? []).length
      expect(fences % 2).toBe(0) // 開閉が偶数 = フェンス閉じ済み
    }
  })
})

describe('chunker — bot_log / order_history（27 §7.2）', () => {
  it('records があれば 1 レコード = 1 chunk', () => {
    const item: IngestionItemInput = {
      rawContent: '',
      records: [
        { symbol: 'BTCUSDT', signal: 'BUY', rsi: '29' },
        { symbol: 'ETHUSDT', signal: 'SELL', rsi: '71' },
      ],
    }
    const bodies = chunkRecords(item)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('symbol=BTCUSDT')
    expect(bodies[0]).toContain('signal=BUY')
  })

  it('金融数値（string）は number 化されず素通しする（横断規約 §2）', () => {
    const text = recordToText({ price: '65000.50', quantity: '0.001' })
    expect(text).toContain('price=65000.50')
    expect(text).toContain('quantity=0.001')
  })

  it('records 未指定なら空行区切りで 1 レコード分割', () => {
    const item: IngestionItemInput = { rawContent: 'log A\nline2\n\nlog B' }
    const bodies = chunkRecords(item)
    expect(bodies).toEqual(['log A\nline2', 'log B'])
  })
})

describe('chunker — market_data window（27 §7.3）', () => {
  it('timeframe 別の window + overlap でスライドする', () => {
    const records = Array.from({ length: 200 }, (_, i) => ({ close: String(i) }))
    const item: IngestionItemInput = { rawContent: '', timeframe: '1h', records }
    const bodies = chunkMarketData(item)
    // 1h: window=72 / overlap=12 / step=60。200 本 → 4 window。
    expect(bodies.length).toBeGreaterThanOrEqual(3)
    expect(bodies[0]).toContain('close=0')
  })
})
