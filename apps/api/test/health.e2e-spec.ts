import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { PrismaService } from '../src/modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../src/modules/rag/infrastructure/providers/openai/openai-client.port'

describe('HealthController', () => {
  let app: INestApplication
  // Phase 3: APP_GUARD 導入 → /health も Bearer Token 必須。
  // e2e 環境にトークンを注入し、リクエストにヘッダを付与する。
  const TEST_BEARER_TOKEN = 'test-bearer-token-for-health-e2e'
  let originalBearerToken: string | undefined

  beforeAll(async () => {
    originalBearerToken = process.env.API_BEARER_TOKEN
    process.env.API_BEARER_TOKEN = TEST_BEARER_TOKEN

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // DB / OpenAI に接続しないよう差し替え（e2e 環境に DB がない場合の timeout 防止）。
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(OPENAI_CLIENT)
      .useValue({ createChatCompletion: jest.fn(), createEmbeddings: jest.fn() })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api/v1', { exclude: ['health'] })
    await app.init()
  }, 30000)

  afterAll(async () => {
    await app.close()
    if (originalBearerToken === undefined) {
      delete process.env.API_BEARER_TOKEN
    } else {
      process.env.API_BEARER_TOKEN = originalBearerToken
    }
  })

  it('GET /health returns ok', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .set('Authorization', `Bearer ${TEST_BEARER_TOKEN}`)
      .expect(200)
      .expect({
        status: 'ok',
        service: 'training-bot-rag-hub-api',
      })
  })
})