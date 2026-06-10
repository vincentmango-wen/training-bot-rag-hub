/**
 * POST /api/v1/rag/query（RAG-API-001 / 10 §6.1）。
 *
 * - Idempotency-Key 必須（IdempotencyKeyGuard）。
 * - body は packages/shared の Zod（queryRequestSchema）で検証（ZodValidationPipe）。
 * - trace_id / request_id はサーバ発行（TraceInterceptor）→ meta + data.trace_id に併載。
 * - citation は audience（X-Client-Type）で excerpt 出し分け。
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import {
  queryRequestSchema,
  type QueryRequest,
  type QueryResponse,
} from '@pmtp/shared'
import { RagOrchestrator } from '../application/rag-orchestrator.service'
import { buildMeta, successEnvelope } from '../application/response-envelope'
import { IdempotencyKey, IdempotencyKeyGuard } from '../http/idempotency.guard'
import { ZodValidationPipe } from '../http/zod-validation.pipe'
import {
  ClientType,
  RequesterId,
  TraceCtx,
} from '../http/request-context'
import type { TraceContext } from '../http/trace-context'
import type { ClientType as ClientTypeValue } from '@pmtp/shared'

@Controller('rag')
export class RagQueryController {
  constructor(private readonly orchestrator: RagOrchestrator) {}

  @Post('query')
  @HttpCode(200)
  @UseGuards(IdempotencyKeyGuard)
  async query(
    @Body(new ZodValidationPipe(queryRequestSchema)) request: QueryRequest,
    @IdempotencyKey() idempotencyKey: string,
    @TraceCtx() trace: TraceContext,
    @RequesterId() requesterId: string,
    @ClientType() audience: ClientTypeValue,
  ): Promise<QueryResponse> {
    const result = await this.orchestrator.runQuery({
      request,
      idempotencyKey,
      trace,
      requesterId,
      audience,
    })
    const meta = buildMeta({
      trace,
      idempotencyKey,
      idempotencyReplayed: result.replayed,
    })
    return successEnvelope(result.data, meta)
  }
}
