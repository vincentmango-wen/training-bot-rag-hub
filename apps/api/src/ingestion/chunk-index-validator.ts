import type { ChunkDraft } from './ingestion.types'

/**
 * chunk_index 連続性検証（27 §10.3 / AC-CHUNK-012）。
 *
 * 不変条件: 同一 document 配下の chunk_index は 0 起点・連続・重複なし（0..N-1）。
 * ingest 完了条件に含め、違反時は当該 job item を FAILED として文書全体を再処理する
 * （部分成功で欠番のまま INDEXED にしない）。
 *
 * DB 側は 05 正本の UNIQUE(document_id, chunk_index) が重複を物理拒否するが、
 * 本検証は「欠番・0 起点ずれ」をアプリ側で早期検出する二重防御。
 */

export interface ChunkIndexValidation {
  readonly valid: boolean
  readonly reason: string | null
}

export function validateChunkIndexContinuity(
  chunks: ReadonlyArray<Pick<ChunkDraft, 'chunkIndex'>>,
): ChunkIndexValidation {
  if (chunks.length === 0) {
    return { valid: false, reason: 'no chunks generated' }
  }
  const indices = chunks.map((c) => c.chunkIndex)
  const sorted = [...indices].sort((a, b) => a - b)

  if (sorted[0] !== 0) {
    return { valid: false, reason: `chunk_index must start at 0, got ${sorted[0]}` }
  }
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i) {
      return {
        valid: false,
        reason: `chunk_index gap/duplicate at position ${i}: expected ${i}, got ${sorted[i]}`,
      }
    }
  }
  return { valid: true, reason: null }
}
