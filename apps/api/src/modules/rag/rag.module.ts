/**
 * RagModule — 4 controller + orchestrator + 横断層を 1 モジュールに束ねて配線する。
 *
 * 依存モジュール（既存実装 / DI 経由で消費）:
 *   - PrismaModule        … PrismaService（永続）
 *   - ProvidersModule     … ProviderRouter（embedding + LLM structured output）
 *   - RetrievalModule     … RetrievalService（HNSW 検索 + rag_retrieval_results 永続）
 *   - GuardrailModule     … GuardrailService（secret masking / injection 隔離 / citation whitelist / order_permission 固定）
 *
 * 横断層（全 RAG リクエストに貫通）:
 *   - TraceInterceptor    … trace_id / request_id 発行（APP_INTERCEPTOR）
 *   - RagExceptionFilter  … 10 §3.4 Error 共通形 + meta 付与（APP_FILTER）
 *
 * 注意: APP_INTERCEPTOR / APP_FILTER はモジュールスコープで provide しても **アプリ全体に効く**
 * （Nest 仕様）。本 MVP は RAG が単一ドメインのため許容。health 等にも trace が付くが無害。
 */
import { Module } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import { PrismaModule } from './infrastructure/prisma/prisma.module'
import { ProvidersModule } from './infrastructure/providers/providers.module'
import { RetrievalModule } from '../../retrieval/retrieval.module'
import { GuardrailModule } from '../../guardrail/guardrail.module'
import { RagOrchestrator } from './application/rag-orchestrator.service'
import { SimilarCasesService } from './application/similar-cases.service'
import { HistoryService } from './application/history.service'
import { RagQueryController } from './controllers/rag-query.controller'
import { RagBotContextController } from './controllers/rag-bot-context.controller'
import { RagSimilarCasesController } from './controllers/rag-similar-cases.controller'
import { RagHistoryController } from './controllers/rag-history.controller'
import { TraceInterceptor } from './http/trace.interceptor'
import { RagExceptionFilter } from './http/rag-exception.filter'

@Module({
  imports: [PrismaModule, ProvidersModule, RetrievalModule, GuardrailModule],
  controllers: [
    RagQueryController,
    RagBotContextController,
    RagSimilarCasesController,
    RagHistoryController,
  ],
  providers: [
    RagOrchestrator,
    SimilarCasesService,
    HistoryService,
    { provide: APP_INTERCEPTOR, useClass: TraceInterceptor },
    { provide: APP_FILTER, useClass: RagExceptionFilter },
  ],
})
export class RagModule {}
