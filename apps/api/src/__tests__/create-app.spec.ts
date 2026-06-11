/**
 * createApp() 単体テスト（設計書 §6 / docs/operations/phase-2-design.md）
 *
 * テスト対象: apps/api/src/create-app.ts
 *
 * カバーする設計書 §6 の観点:
 *   - /health が global prefix から除外されている（200 を返す）
 *   - /api/v1/* 配下に既存ルートが生えている（prefix が正しく適用されている）
 *   - main.ts と api/index.ts が setGlobalPrefix を直接呼ばず create-app.ts に委譲している（SSoT）
 *
 * 制約:
 *   - DB / OpenAI には接続しない（Test.createTestingModule + overrideProvider）
 *   - health.e2e-spec.ts と同型のスタイルを踏襲（test/ 配下の既存 e2e に合わせる）
 *   - OPENAI_API_KEY 未設定でも通ること
 *
 * 参考: apps/api/test/health.e2e-spec.ts / rag.module.di-smoke.spec.ts
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import * as fs from 'fs'
import * as path from 'path'
import { AppModule } from '../app.module'
import { PrismaService } from '../modules/rag/infrastructure/prisma/prisma.service'
import { OPENAI_CLIENT } from '../modules/rag/infrastructure/providers/openai/openai-client.port'

// ---------------------------------------------------------------------------
// テスト用アプリ（createApp() と同等の構成で Test.createTestingModule を使う）
// createApp() は NestFactory.create(AppModule) を呼ぶが、e2e では
// Test.createTestingModule + overrideProvider で DB/OpenAI を mock に差し替える。
// global prefix の設定は createApp() の責務であることを静的解析テストで担保する。
// ---------------------------------------------------------------------------

describe('createApp() — global prefix 設定（Phase 2 / 設計書 §6）', () => {
  let app: INestApplication
  // Phase 3: APP_GUARD 導入により全ルートが Bearer Token 必須となったため、
  // spec 側で env にテスト用トークンを注入し、リクエストにヘッダを付与する。
  // guard を無効化するテスト用バックドアは作らない方針（設計書 §7 quality 観点）。
  const TEST_BEARER_TOKEN = 'test-bearer-token-for-create-app-spec'
  const AUTH_HEADER = `Bearer ${TEST_BEARER_TOKEN}`
  let originalBearerToken: string | undefined

  beforeAll(async () => {
    originalBearerToken = process.env.API_BEARER_TOKEN
    process.env.API_BEARER_TOKEN = TEST_BEARER_TOKEN

    // health.e2e-spec.ts と同型：DB / OpenAI をモック上書き
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(OPENAI_CLIENT)
      .useValue({ createChatCompletion: jest.fn(), createEmbeddings: jest.fn() })
      .compile()

    app = moduleRef.createNestApplication()
    // create-app.ts の createApp() と同じ設定を適用（SSoT の確認は別 describe で行う）
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

  it('/health が 200 を返す（global prefix から除外されている / Bearer 認証必須）', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .set('Authorization', AUTH_HEADER)
      .expect(200)
      .expect({ status: 'ok', service: 'training-bot-rag-hub-api' })
  })

  it('/health は Bearer Token なしで弾かれる（Phase 3: /health も保護対象）', async () => {
    // RagExceptionFilter が HttpException を RAG_INTERNAL_ERROR(500) に写像するため、
    // 実機の status は 500 になる（401 ではない）。ここでの本旨は
    // 「guard で弾かれ 200 が返らないこと」。フィルタ側の HttpException 尊重は
    // 別チケットの責務（本 PR スコープ外）として扱う。
    const res = await request(app.getHttpServer()).get('/health')
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('/api/v1/rag/query が 404 にならない（prefix が正しく設定されている）', async () => {
    // DB は mock のため処理はできないが、NestJS が route を認識していれば 400/500 が返る。
    // 404 は prefix 未設定 or ルート登録漏れを意味する。
    const res = await request(app.getHttpServer())
      .post('/api/v1/rag/query')
      .set('Authorization', AUTH_HEADER)
      .send({})
    expect(res.status).not.toBe(404)
  })

  it('/rag/query が 4xx/5xx を返す（prefix なしパスは未登録 = route not found）', async () => {
    // prefix が正しく設定されていれば /rag/query は NestJS ルートテーブルに存在しない。
    // RagExceptionFilter が NotFoundException を 500 にマッピングする実装のため
    // 404 または 500 のどちらかが返ることで「ルート未登録」を確認する。
    // （prefix 誤設定 = 200 系が返る状況の排除が目的）
    const res = await request(app.getHttpServer())
      .post('/rag/query')
      .set('Authorization', AUTH_HEADER)
      .send({})
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// create-app.ts — SSoT 確認（設計書 §4-1）
// main.ts と api/index.ts が setGlobalPrefix を直接呼ばず、
// create-app.ts のみに集約されていることを静的解析で確認する。
// ---------------------------------------------------------------------------

describe('create-app.ts — SSoT 静的確認（設計書 §4-1）', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..')
  const CREATE_APP_PATH = path.join(REPO_ROOT, 'apps/api/src/create-app.ts')
  const MAIN_TS_PATH = path.join(REPO_ROOT, 'apps/api/src/main.ts')
  const HANDLER_PATH = path.join(REPO_ROOT, 'apps/api/api/index.ts')

  it('main.ts が createApp() を import して使っている', () => {
    const content = fs.readFileSync(MAIN_TS_PATH, 'utf-8')
    expect(content).toMatch(/from ['"]\.\/create-app['"]/)
    expect(content).toContain('createApp()')
  })

  it('main.ts 自体に setGlobalPrefix の呼び出しがない（SSoT = create-app.ts に集約）', () => {
    const content = fs.readFileSync(MAIN_TS_PATH, 'utf-8')
    expect(content).not.toContain('setGlobalPrefix')
  })

  it('api/index.ts が create-app.ts を import して使っている', () => {
    const content = fs.readFileSync(HANDLER_PATH, 'utf-8')
    expect(content).toMatch(/from ['"]\.\.\/src\/create-app['"]/)
    expect(content).toContain('createApp()')
  })

  it('api/index.ts 自体に setGlobalPrefix の呼び出しがない（SSoT = create-app.ts に集約）', () => {
    const content = fs.readFileSync(HANDLER_PATH, 'utf-8')
    expect(content).not.toContain('setGlobalPrefix')
  })

  it('create-app.ts が setGlobalPrefix を 1 箇所だけ呼んでいる（重複なし）', () => {
    const content = fs.readFileSync(CREATE_APP_PATH, 'utf-8')
    const matches = content.match(/setGlobalPrefix/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('create-app.ts が exclude: [\'health\'] で /health を prefix 対象外にしている', () => {
    const content = fs.readFileSync(CREATE_APP_PATH, 'utf-8')
    expect(content).toContain("exclude: ['health']")
  })

  it('create-app.ts が global prefix として \'api/v1\' を設定している', () => {
    const content = fs.readFileSync(CREATE_APP_PATH, 'utf-8')
    expect(content).toContain("'api/v1'")
  })
})
