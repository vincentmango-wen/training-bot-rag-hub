/**
 * GET /api/v1/rag/history（RAG-API-004 / 10 §6.4）。
 *
 * read-only。requester（JWT subject）所有の query のみ返す（10 §10.1.1 所有権検証）。
 * - GET のため Idempotency-Key は不要（meta に idempotency_* を含めない）。
 * - query string は historyQuerySchema で検証（数値は coerce / page・limit）。
 */
import { Controller, Get, Query } from '@nestjs/common'
import {
  historyQuerySchema,
  type HistoryQuery,
  type HistoryResponse,
} from '@pmtp/shared'
import { HistoryService } from '../application/history.service'
import { buildMeta, successEnvelope } from '../application/response-envelope'
import { ZodValidationPipe } from '../http/zod-validation.pipe'
import { RequesterId, TraceCtx } from '../http/request-context'
import type { TraceContext } from '../http/trace-context'

@Controller('rag')
export class RagHistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('history')
  async list(
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery,
    @TraceCtx() trace: TraceContext,
    @RequesterId() requesterId: string,
  ): Promise<HistoryResponse> {
    const data = await this.history.list({ query, requesterId })
    const meta = buildMeta({ trace })
    return successEnvelope(data, meta)
  }
}
