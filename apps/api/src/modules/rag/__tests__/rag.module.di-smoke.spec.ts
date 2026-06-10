/**
 * RagModule の DI 解決スモークテスト。
 *
 * NestFactory 相当の DI コンテナで RagModule（→ orchestrator + 4 controller + 横断層）が
 * 解決できることを確認する。DB / OpenAI には接続しないよう PrismaService と OPENAI_CLIENT を
 * mock で上書きする（boot 時に $connect / network を踏まない）。
 *
 * 配線ミス（export 漏れ / 循環依存 / token 不一致）は本テストの compile() で即落ちる。
 */
import { Test } from '@nestjs/testing'
import { RagModule } from '../rag.module'
import { RagOrchestrator } from '../application/rag-orchestrator.service'
import { SimilarCasesService } from '../application/similar-cases.service'
import { HistoryService } from '../application/history.service'
import { RagQueryController } from '../controllers/rag-query.controller'
import { RagBotContextController } from '../controllers/rag-bot-context.controller'
import { RagSimilarCasesController } from '../controllers/rag-similar-cases.controller'
import { RagHistoryController } from '../controllers/rag-history.controller'
import { PrismaService } from '../infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../infrastructure/providers/openai/openai-client.port'

describe('RagModule DI smoke', () => {
  it('orchestrator / services / 4 controller を解決できる', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RagModule],
    })
      // 実 DB / OpenAI へ接続しないよう上書き。
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(OPENAI_CLIENT)
      .useValue({ createChatCompletion: jest.fn(), createEmbeddings: jest.fn() })
      .compile()

    expect(moduleRef.get(RagOrchestrator)).toBeInstanceOf(RagOrchestrator)
    expect(moduleRef.get(SimilarCasesService)).toBeInstanceOf(SimilarCasesService)
    expect(moduleRef.get(HistoryService)).toBeInstanceOf(HistoryService)
    expect(moduleRef.get(RagQueryController)).toBeInstanceOf(RagQueryController)
    expect(moduleRef.get(RagBotContextController)).toBeInstanceOf(RagBotContextController)
    expect(moduleRef.get(RagSimilarCasesController)).toBeInstanceOf(
      RagSimilarCasesController,
    )
    expect(moduleRef.get(RagHistoryController)).toBeInstanceOf(RagHistoryController)

    await moduleRef.close()
  })
})
