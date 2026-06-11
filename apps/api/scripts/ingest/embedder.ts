/**
 * CLI 用 Nest module（Phase 4 / 設計書 §4-3）。
 *
 * 設計書からの責務再定義: 本ファイルは **OpenAI API ロジックを書かない**。
 * 既存 `OpenAIEmbeddingAdapter` と `OpenAiSdkClient` を CLI 専用 module で
 * 束縛するだけ。`EMBEDDING_PROVIDER` は単一 provider 束縛（サーバ側 ProvidersModule
 * の配列束縛とは独立 / 設計書 §3 判断 2）。
 *
 * 2 種類の module を提供:
 *   - IngestCliModule        … 本番モード（実 OpenAI adapter）
 *   - IngestCliDryRunModule  … dry-run モード（Stub provider / API キー不要）
 *
 * 注意:
 *   - ProvidersModule を import しない（EMBEDDING_PROVIDER 配列束縛と token 衝突するため）
 *   - PrismaModule は @Global だが root module で明示 import する（standalone context 起動時の解決確実性のため）
 */
import { Module } from '@nestjs/common'
import { IngestionService } from '../../src/ingestion/ingestion.service'
import { StubEmbeddingProvider } from '../../src/ingestion/testing/stub-embedding-provider'
import { PrismaModule } from '../../src/modules/rag/infrastructure/prisma/prisma.module'
import {
  OPENAI_CLIENT,
  type OpenAIClientPort,
} from '../../src/modules/rag/infrastructure/providers/openai/openai-client.port'
import { OpenAiSdkClient } from '../../src/modules/rag/infrastructure/providers/openai/openai-client.openai-sdk'
import { OpenAIEmbeddingAdapter } from '../../src/modules/rag/infrastructure/providers/embedding/openai-embedding.adapter'
import { EMBEDDING_PROVIDER } from '../../src/modules/rag/infrastructure/providers/embedding/embedding-provider.interface'

/**
 * CLI 用 OpenAI client factory（fail-fast）。
 *
 * サーバ側 ProvidersModule の createOpenAiClient は「キー未設定でも DI 解決を
 * 成功させ、実呼び出し時に throw」する lazy-fail だが、CLI は実呼び出しが
 * 目的のため **起動時に即 throw** する（設計書 §3 判断 2）。
 */
function createOpenAiClientForCli(): OpenAIClientPort {
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'OPENAI_API_KEY is not set. Set it in .env or pass --dry-run to skip embedding.',
    )
  }
  return new OpenAiSdkClient(apiKey)
}

/** 本番モード: 実 OpenAI adapter を EMBEDDING_PROVIDER に単一束縛。 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: OPENAI_CLIENT, useFactory: createOpenAiClientForCli },
    OpenAIEmbeddingAdapter,
    { provide: EMBEDDING_PROVIDER, useExisting: OpenAIEmbeddingAdapter },
    IngestionService,
  ],
  exports: [IngestionService],
})
export class IngestCliModule {}

/** dry-run モード: Stub provider を束縛（OPENAI_API_KEY 不要）。 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: EMBEDDING_PROVIDER, useClass: StubEmbeddingProvider },
    IngestionService,
  ],
  exports: [IngestionService],
})
export class IngestCliDryRunModule {}
