/**
 * 冪等性キー衝突（横断規約 §3 / 05 §5.6 / 10 §4 RAG_IDEMPOTENCY_CONFLICT）。
 *
 * 同一 (source_id, idempotency_key) の再送で payload_hash が **不一致** の場合に投げる。
 * 上位（controller / interceptor）が 409 RAG_IDEMPOTENCY_CONFLICT に写像する。
 * payload_hash **一致** は衝突ではなく replay（200 で既存ジョブ返却）なので投げない。
 */
export class IdempotencyConflictError extends Error {
  readonly code = 'RAG_IDEMPOTENCY_CONFLICT' as const
  readonly sourceId: string
  readonly idempotencyKey: string

  constructor(params: { sourceId: string; idempotencyKey: string }) {
    super(
      `idempotency key conflict: same (source_id, idempotency_key) reused with a different payload`,
    )
    this.name = 'IdempotencyConflictError'
    this.sourceId = params.sourceId
    this.idempotencyKey = params.idempotencyKey
  }
}
