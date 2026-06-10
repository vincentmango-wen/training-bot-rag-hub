/**
 * RagOrchestrator の入力/出力型（controller ↔ orchestrator 境界）。
 *
 * Zod 検証済みの request（packages/shared）+ trace + 冪等性スコープを束ねる。
 */
import type {
  BotContextRequest,
  BotContextResponseData,
  QueryRequest,
  QueryResponseData,
  ClientType,
} from '@pmtp/shared'
import type { TraceContext } from '../http/trace-context'

/** POST 共通の冪等性 + 主体メタ。 */
export interface RequestEnvelope {
  trace: TraceContext
  /** Idempotency-Key（POST では必須 / guard が保証）。 */
  idempotencyKey: string
  /** 冪等性スコープ + 履歴所有権の主体（rag_queries.requester_id）。 */
  requesterId: string
  /** citation audience 出し分け（X-Client-Type）。 */
  audience: ClientType
}

export interface RunQueryInput extends RequestEnvelope {
  request: QueryRequest
}

export interface RunBotContextInput extends RequestEnvelope {
  request: BotContextRequest
}

/** orchestrator 出力（data + replay フラグ）。controller が meta を付けて返す。 */
export interface OrchestratorResult<TData> {
  data: TData
  replayed: boolean
}

export type RunQueryResult = OrchestratorResult<QueryResponseData>
export type RunBotContextResult = OrchestratorResult<BotContextResponseData>
