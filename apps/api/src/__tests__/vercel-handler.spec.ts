/**
 * api/index.ts — Vercel ハンドラ + 冪等性ガードテスト（設計書 §6 / §5）
 *
 * テスト対象: apps/api/api/index.ts
 *
 * カバーする設計書 §6 / §5 の観点:
 *   - G-1: 2 回連続でハンドラを呼んでも NestFactory.create が 1 回しか呼ばれない
 *          （並行初期化レース対策 = 初期化 Promise キャッシュ）
 *   - G-2: 初期化が reject した後の再呼び出しで bootstrap が再試行される
 *          （恒久 500 化防止 = appPromise = undefined リセット）
 *   - ハンドラが express インスタンスに req/res をそのまま委譲する
 *
 * 実装上の注意:
 *   api/index.ts は module-level で appPromise を保持するため、テスト間で状態が持続する。
 *   各テストは jest.resetModules() + 動的 require で新鮮なモジュールを取得する。
 *
 * 参考: docs/operations/phase-2-design.md §5 冪等性ガード / §4-2 api/index.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// helper: api/index.ts を新鮮にロードするユーティリティ
// ---------------------------------------------------------------------------

/**
 * jest.resetModules() → jest.isolateModules() でモジュールキャッシュをリセットし、
 * api/index.ts と create-app.ts を新鮮にロードする。
 * module-level の appPromise をテスト間でリセットするために必要。
 */
async function loadFreshHandler(createAppImpl: () => Promise<unknown>) {
  // create-app モジュールを mock
  jest.mock('../../api/../src/create-app', () => ({
    createApp: createAppImpl,
  }))

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../api/index') as {
    default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }
  return mod.default
}

// ---------------------------------------------------------------------------
// G-1: 並行初期化レース対策（Promise キャッシュ）
// ---------------------------------------------------------------------------

describe('G-1: 初期化 Promise キャッシュ（並行リクエストで bootstrap は 1 回）', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  it('2 回連続でハンドラを呼んでも createApp は 1 回しか呼ばれない', async () => {
    let createCallCount = 0

    // express インスタンスの mock（(req, res) を呼ぶだけ）
    const mockExpress = jest.fn()
    const mockGetHttpAdapter = jest.fn(() => ({
      getInstance: jest.fn(() => mockExpress),
    }))
    const mockApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: mockGetHttpAdapter,
    }

    const createAppMock = jest.fn().mockImplementation(async () => {
      createCallCount++
      return mockApp
    })

    jest.doMock('../create-app', () => ({ createApp: createAppMock }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = {} as IncomingMessage
    const res = {} as ServerResponse

    // 1 回目と 2 回目を並行して呼ぶ（同時着弾のシミュレーション）
    await Promise.all([handler(req, res), handler(req, res)])

    expect(createCallCount).toBe(1)
    expect(mockApp.init).toHaveBeenCalledTimes(1)
  })

  it('3 回連続でハンドラを呼んでも createApp は 1 回しか呼ばれない（直列）', async () => {
    let createCallCount = 0

    const mockExpress = jest.fn()
    const mockApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: jest.fn(() => ({ getInstance: jest.fn(() => mockExpress) })),
    }

    jest.doMock('../create-app', () => ({
      createApp: jest.fn().mockImplementation(async () => {
        createCallCount++
        return mockApp
      }),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = {} as IncomingMessage
    const res = {} as ServerResponse

    await handler(req, res)
    await handler(req, res)
    await handler(req, res)

    expect(createCallCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// G-2: 初期化失敗時の appPromise リセット（恒久 500 化防止）
// ---------------------------------------------------------------------------

describe('G-2: 初期化失敗後の appPromise リセット（再 bootstrap を許可）', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  it('初期化が reject した後の再呼び出しで createApp が再実行される', async () => {
    let createCallCount = 0
    const initError = new Error('DB connection refused')

    // 1 回目: reject、2 回目: resolve させる
    const mockExpress = jest.fn()
    const mockSuccessApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: jest.fn(() => ({ getInstance: jest.fn(() => mockExpress) })),
    }

    jest.doMock('../create-app', () => ({
      createApp: jest.fn().mockImplementation(async () => {
        createCallCount++
        if (createCallCount === 1) {
          throw initError
        }
        return mockSuccessApp
      }),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = {} as IncomingMessage
    const res = {} as ServerResponse

    // 1 回目: 初期化失敗 → handler が reject する
    await expect(handler(req, res)).rejects.toThrow('DB connection refused')

    // 2 回目: appPromise がリセットされているので再 bootstrap が走る → 成功
    await expect(handler(req, res)).resolves.not.toThrow()

    expect(createCallCount).toBe(2)
  })

  it('初期化失敗時に console.error が呼ばれる（エラーが握り潰されない）', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const initError = new Error('init failed for test')

    let callCount = 0
    const mockExpress = jest.fn()
    const mockSuccessApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: jest.fn(() => ({ getInstance: jest.fn(() => mockExpress) })),
    }

    jest.doMock('../create-app', () => ({
      createApp: jest.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw initError
        return mockSuccessApp
      }),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = {} as IncomingMessage
    const res = {} as ServerResponse

    await expect(handler(req, res)).rejects.toThrow()

    // console.error に '[vercel-handler]' プレフィックス付きで記録されること
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vercel-handler]'),
      expect.any(Error),
    )

    consoleErrorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// ハンドラが express インスタンスに req/res を委譲する
// ---------------------------------------------------------------------------

describe('handler — express インスタンスへの委譲（設計書 §4-2）', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  it('handler が express インスタンスを (req, res) で呼び出す', async () => {
    const mockExpress = jest.fn()
    const mockApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: jest.fn(() => ({ getInstance: jest.fn(() => mockExpress) })),
    }

    jest.doMock('../create-app', () => ({
      createApp: jest.fn().mockResolvedValue(mockApp),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = { url: '/health', method: 'GET' } as IncomingMessage
    const res = {} as ServerResponse

    await handler(req, res)

    // express インスタンスが (req, res) の組で呼ばれたことを確認
    expect(mockExpress).toHaveBeenCalledWith(req, res)
    expect(mockExpress).toHaveBeenCalledTimes(1)
  })

  it('handler 呼び出し後に app.getHttpAdapter().getInstance() が呼ばれている', async () => {
    const mockGetInstance = jest.fn(() => jest.fn())
    const mockGetHttpAdapter = jest.fn(() => ({ getInstance: mockGetInstance }))
    const mockApp = {
      init: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: mockGetHttpAdapter,
    }

    jest.doMock('../create-app', () => ({
      createApp: jest.fn().mockResolvedValue(mockApp),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: handler } = require('../../api/index') as {
      default: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }

    const req = {} as IncomingMessage
    const res = {} as ServerResponse

    await handler(req, res)

    expect(mockGetHttpAdapter).toHaveBeenCalled()
    expect(mockGetInstance).toHaveBeenCalled()
  })
})
