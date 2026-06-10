/**
 * POST /api/v1/rag/bot-context（RAG-API-002 / 10 §6.2）。
 *
 * Training Bot が仮シグナルに対する説明・反対材料・リスクを取得する。
 * - Idempotency-Key 必須 / body は botContextRequestSchema で検証。
 * - order_permission は常に literal false（横断規約5 / Guardrail 二次防御）。
 * - data.trace_id を併載（Bot が自検証レコードに刻印 / 10 §3.4.2）。
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import {
  botContextRequestSchema,
  type BotContextRequest,
  type BotContextResponse,
  type ClientType as ClientTypeValue,
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

@Controller('rag')
export class RagBotContextController {
  constructor(private readonly orchestrator: RagOrchestrator) {}

  @Post('bot-context')
  @HttpCode(200)
  @UseGuards(IdempotencyKeyGuard)
  async botContext(
    @Body(new ZodValidationPipe(botContextRequestSchema)) request: BotContextRequest,
    @IdempotencyKey() idempotencyKey: string,
    @TraceCtx() trace: TraceContext,
    @RequesterId() requesterId: string,
    @ClientType() audience: ClientTypeValue,
  ): Promise<BotContextResponse> {
    const result = await this.orchestrator.runBotContext({
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
