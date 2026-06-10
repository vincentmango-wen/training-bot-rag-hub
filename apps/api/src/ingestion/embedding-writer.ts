import type { PrismaClient } from '@prisma/client'

/**
 * rag_embeddings への vector 書き込み（05 §5.5 / 横断規約 §3）。
 *
 * `embedding` 列は型なし `vector`（Prisma では Unsupported("vector")）のため、
 * Prisma 標準 create では書けない。pgvector のテキスト表現 `'[1,2,3]'::vector` を
 * `$executeRaw` で INSERT する。
 *
 * - UNIQUE(chunk_id, provider, model) があるため、再 Embedding 時は upsert 相当
 *   （ON CONFLICT DO UPDATE）で status / content_hash / embedding を差し替える。
 * - CHECK(vector_dims(embedding) = dimension) があるため、長さ不一致は DB が物理拒否
 *   （次元事故の構造防御 / B6）。
 */

export interface EmbeddingRow {
  readonly chunkId: string
  readonly provider: string
  readonly model: string
  readonly dimension: number
  /** 埋め込みベクトル（長さ = dimension）。 */
  readonly vector: readonly number[]
  readonly contentHash: string
  /** 'ACTIVE' | 'STALE' | 'FAILED'（shared EMBEDDING_STATUSES）。 */
  readonly status: string
  readonly errorMessage?: string | null
}

/** pgvector のテキスト表現 `[1,2,3]` を number[] に復元（embedding 再利用時）。 */
export function parseVectorText(text: string): number[] {
  const trimmed = text.trim()
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed
  if (inner.length === 0) return []
  return inner.split(',').map((s) => Number(s))
}

/** number[] を pgvector リテラル `[1,2,3]` に変換（NaN/Infinity を拒否）。 */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const v of vector) {
    if (!Number.isFinite(v)) {
      throw new Error('embedding vector contains non-finite value')
    }
  }
  return `[${vector.join(',')}]`
}

/**
 * 1 embedding を upsert する（UNIQUE(chunk_id, provider, model) で衝突解決）。
 * tx（$transaction クライアント）または PrismaClient を受ける。
 */
export async function upsertEmbedding(
  db: Pick<PrismaClient, '$executeRaw'>,
  row: EmbeddingRow,
): Promise<void> {
  const literal = toVectorLiteral(row.vector)
  // embedding は ::vector キャスト、それ以外はバインドパラメータ。
  await db.$executeRaw`
    INSERT INTO "rag_embeddings"
      ("id", "chunk_id", "provider", "model", "dimension", "embedding",
       "content_hash", "status", "error_message", "embedded_at", "created_at")
    VALUES
      (gen_random_uuid(), ${row.chunkId}::uuid, ${row.provider}, ${row.model},
       ${row.dimension}, ${literal}::vector, ${row.contentHash}, ${row.status},
       ${row.errorMessage ?? null}, now(), now())
    ON CONFLICT ("chunk_id", "provider", "model") DO UPDATE SET
      "dimension" = EXCLUDED."dimension",
      "embedding" = EXCLUDED."embedding",
      "content_hash" = EXCLUDED."content_hash",
      "status" = EXCLUDED."status",
      "error_message" = EXCLUDED."error_message",
      "embedded_at" = now()
  `
}
