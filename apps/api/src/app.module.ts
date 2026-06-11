import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { HealthController } from './health/health.controller'
import { PrismaModule } from './modules/rag/infrastructure/prisma/prisma.module'
import { GuardrailModule } from './guardrail/guardrail.module'
import { RetrievalModule } from './retrieval/retrieval.module'
import { IngestionModule } from './ingestion/ingestion.module'
import { RagModule } from './modules/rag/rag.module'
import { BearerTokenGuard } from './common/guards/bearer-token.guard'

@Module({
  imports: [
    PrismaModule,
    GuardrailModule,
    RetrievalModule,
    IngestionModule,
    RagModule,
  ],
  controllers: [HealthController],
  // Phase 3: 全ルートに Bearer Token 認証を強制（非公開化ダブルロックの内側）
  // 設計書: docs/operations/phase-3-design.md §3 判断 1 / §4-3
  // main.ts（ローカル）と api/index.ts（Vercel serverless）の双方に
  // create-app.ts SSoT 経由で同一 guard が効く。
  providers: [{ provide: APP_GUARD, useClass: BearerTokenGuard }],
})
export class AppModule {}
