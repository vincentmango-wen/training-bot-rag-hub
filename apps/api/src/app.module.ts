import { Module } from '@nestjs/common'
import { HealthController } from './health/health.controller'
import { PrismaModule } from './modules/rag/infrastructure/prisma/prisma.module'
import { GuardrailModule } from './guardrail/guardrail.module'
import { RetrievalModule } from './retrieval/retrieval.module'
import { IngestionModule } from './ingestion/ingestion.module'
import { RagModule } from './modules/rag/rag.module'

@Module({
  imports: [
    PrismaModule,
    GuardrailModule,
    RetrievalModule,
    IngestionModule,
    RagModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
