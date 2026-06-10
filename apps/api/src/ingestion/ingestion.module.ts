import { Module } from '@nestjs/common'
import { EMBEDDING_PROVIDER } from '../modules/rag/infrastructure/providers/embedding/embedding-provider.interface'
import { IngestionService } from './ingestion.service'
import { StubEmbeddingProvider } from './testing/stub-embedding-provider'

/**
 * Ingestion / Chunking / Embedding モジュール。
 *
 * - PrismaModule は @Global（A1 基盤）のため import 不要。
 * - EMBEDDING_PROVIDER は本モジュールが既定束縛を持つ（StubEmbeddingProvider /
 *   API キーなしで boot 可能 / 16 / テスト方針）。
 *
 * 本番では providers の OpenAIEmbeddingAdapter を EMBEDDING_PROVIDER に束縛したい。
 * その場合は本モジュールの `providers` 配列の该当エントリを差し替える（並行 Providers
 * タスク完成後に 1 行変更）。Stub は dev / テスト時のフォールバックとして残す。
 */
@Module({
  providers: [
    IngestionService,
    // 本番差し替えポイント: { provide: EMBEDDING_PROVIDER, useExisting: OpenAIEmbeddingAdapter }
    { provide: EMBEDDING_PROVIDER, useClass: StubEmbeddingProvider },
  ],
  exports: [IngestionService],
})
export class IngestionModule {}
