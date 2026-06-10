/**
 * POST /api/v1/rag/similar-cases（RAG-API-003 / 10 §6.3）。
 *
 * retrieval ベースの類似ケース検索（LLM 生成なし）。
 * - Idempotency-Key 必須（read-only 検索だが POST のため契約上必須 / guard 担保）。
 * - body は similarCasesRequestSchema で検証。
 * - 金融数値（*_pct）は string 透過（横断規約 §2）。
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import {
  similarCasesRequestSchema,
  type SimilarCasesRequest,
  type SimilarCasesResponse,
} from '@pmtp/shared'
import { SimilarCasesService } from '../application/similar-cases.service'
import { buildMeta, successEnvelope } from '../application/response-envelope'
import { IdempotencyKey, IdempotencyKeyGuard } from '../http/idempotency.guard'
import { ZodValidationPipe } from '../http/zod-validation.pipe'
import { RequesterId, TraceCtx } from '../http/request-context'
import type { TraceContext } from '../http/trace-context'

@Controller('rag')
export class RagSimilarCasesController {
  constructor(private readonly similarCases: SimilarCasesService) {}

  @Post('similar-cases')
  @HttpCode(200)
  @UseGuards(IdempotencyKeyGuard)
  async similar(
    @Body(new ZodValidationPipe(similarCasesRequestSchema)) request: SimilarCasesRequest,
    @IdempotencyKey() idempotencyKey: string,
    @TraceCtx() trace: TraceContext,
    @RequesterId() requesterId: string,
  ): Promise<SimilarCasesResponse> {
    this.similarCases.assertValid(request)
    const { cases, replayed } = await this.similarCases.findSimilarCases({
      request,
      requesterId,
      idempotencyKey,
      trace,
    })
    const meta = buildMeta({ trace, idempotencyKey, idempotencyReplayed: replayed })
    return successEnvelope({ cases }, meta)
  }
}
