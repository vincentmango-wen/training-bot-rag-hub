/**
 * BearerTokenGuard 単体テスト
 *
 * 設計書: docs/operations/phase-3-design.md §6 テストすべき観点
 *
 * カバーするケース:
 *   1. 正トークン → canActivate が true
 *   2. authorization ヘッダ欠落 → UnauthorizedException
 *   3. scheme 不正（Basic / 小文字 bearer / Bearer のみ）→ UnauthorizedException
 *   4. 同長の不一致トークン → UnauthorizedException
 *   5. トークン長違い（短い / 長い）→ UnauthorizedException
 *      （RangeError が漏れず UnauthorizedException で吸収されることを担保）
 *   6. API_BEARER_TOKEN 未設定 → ServiceUnavailableException + Logger.error
 *   7. API_BEARER_TOKEN 空文字 → 同上
 *   8. ログ・例外メッセージに期待値 / 提示値が含まれない（情報漏れ検出）
 *  11. process.env の変更が afterEach で復元され他 spec に漏れない
 */
import { ExecutionContext, Logger } from '@nestjs/common'
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { BearerTokenGuard } from './bearer-token.guard'

const VALID_TOKEN = 'a'.repeat(64) // openssl rand -hex 32 相当の長さ

function makeContext(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext
}

describe('BearerTokenGuard', () => {
  let guard: BearerTokenGuard
  let originalToken: string | undefined
  let loggerErrorSpy: jest.SpyInstance

  beforeEach(() => {
    // env の状態を保存（ケース 11: 他 spec への漏れ防止）
    originalToken = process.env.API_BEARER_TOKEN
    guard = new BearerTokenGuard()
    // Logger.error の引数まで検査するため spy 化
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    // env の復元
    if (originalToken === undefined) {
      delete process.env.API_BEARER_TOKEN
    } else {
      process.env.API_BEARER_TOKEN = originalToken
    }
    loggerErrorSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // ケース 1: 正常系
  // -------------------------------------------------------------------------
  describe('ケース 1: 正トークン', () => {
    it('Bearer <一致値> で canActivate が true を返す', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({ authorization: `Bearer ${VALID_TOKEN}` })

      expect(guard.canActivate(ctx)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // ケース 2: authorization ヘッダ欠落
  // -------------------------------------------------------------------------
  describe('ケース 2: authorization ヘッダ欠落', () => {
    it('ヘッダ無し → UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({})

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('authorization が undefined → UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({ authorization: undefined })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('authorization が配列（型不正）→ UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({ authorization: [`Bearer ${VALID_TOKEN}`] })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })
  })

  // -------------------------------------------------------------------------
  // ケース 3: scheme 不正
  // -------------------------------------------------------------------------
  describe('ケース 3: scheme 不正', () => {
    it('Basic xxx → UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({ authorization: 'Basic somebase64==' })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('小文字 bearer は不一致（厳格 scheme 一致）→ UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const ctx = makeContext({ authorization: `bearer ${VALID_TOKEN}` })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('Bearer のみで値なし（空文字 token）→ UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      // 'Bearer ' で startsWith は通るが、その後の token が空 → ダイジェスト不一致
      const ctx = makeContext({ authorization: 'Bearer ' })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('Bearer（末尾スペース無し）→ UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      // 'Bearer ' (スペース込み) で startsWith しない
      const ctx = makeContext({ authorization: 'Bearer' })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })
  })

  // -------------------------------------------------------------------------
  // ケース 4: 同長の不一致トークン
  // -------------------------------------------------------------------------
  describe('ケース 4: 同長の不一致トークン', () => {
    it('同じ長さで内容が違う → UnauthorizedException', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const wrong = 'b'.repeat(VALID_TOKEN.length)
      const ctx = makeContext({ authorization: `Bearer ${wrong}` })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })
  })

  // -------------------------------------------------------------------------
  // ケース 5: トークン長違い（timingSafeEqual の RangeError が漏れ出ないこと）
  // -------------------------------------------------------------------------
  describe('ケース 5: トークン長違い', () => {
    it('期待値より短い提示値 → UnauthorizedException（RangeError 漏れなし）', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const short = 'a'.repeat(8)
      const ctx = makeContext({ authorization: `Bearer ${short}` })

      // SHA-256 で 32 byte に正規化されているため、長さ違いでも
      // UnauthorizedException として吸収される（RangeError ではない）
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
      expect(() => guard.canActivate(ctx)).not.toThrow(RangeError)
    })

    it('期待値より長い提示値 → UnauthorizedException（RangeError 漏れなし）', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const long = 'a'.repeat(128)
      const ctx = makeContext({ authorization: `Bearer ${long}` })

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
      expect(() => guard.canActivate(ctx)).not.toThrow(RangeError)
    })
  })

  // -------------------------------------------------------------------------
  // ケース 6 & 7: API_BEARER_TOKEN 未設定 / 空文字 → fail-closed (503)
  // -------------------------------------------------------------------------
  describe('ケース 6 & 7: API_BEARER_TOKEN 未設定 / 空文字', () => {
    it('未設定（undefined）→ ServiceUnavailableException + Logger.error', () => {
      delete process.env.API_BEARER_TOKEN
      const ctx = makeContext({ authorization: `Bearer ${VALID_TOKEN}` })

      expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException)
      expect(loggerErrorSpy).toHaveBeenCalled()
    })

    it('空文字 → ServiceUnavailableException + Logger.error（空文字を「設定済」と誤認しない）', () => {
      process.env.API_BEARER_TOKEN = ''
      const ctx = makeContext({ authorization: `Bearer ${VALID_TOKEN}` })

      expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException)
      expect(loggerErrorSpy).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // ケース 8: ログ・例外メッセージにトークン値が含まれない
  // -------------------------------------------------------------------------
  describe('ケース 8: 情報漏れ防止', () => {
    it('Logger.error 引数に期待トークン値が含まれない（未設定時）', () => {
      delete process.env.API_BEARER_TOKEN
      const ctx = makeContext({ authorization: `Bearer ${VALID_TOKEN}` })

      try {
        guard.canActivate(ctx)
      } catch {
        /* 期待される throw */
      }

      // すべての Logger.error 呼び出し引数を 1 つの文字列にして検査
      const allLoggedStrings = loggerErrorSpy.mock.calls
        .flat()
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join('|')

      // 期待値（プレースホルダ '' / 未設定）も提示値もログに含めないこと
      expect(allLoggedStrings).not.toContain(VALID_TOKEN)
    })

    it('401 例外メッセージに期待トークン値 / 提示トークン値が含まれない', () => {
      process.env.API_BEARER_TOKEN = VALID_TOKEN
      const wrong = 'b'.repeat(VALID_TOKEN.length)
      const ctx = makeContext({ authorization: `Bearer ${wrong}` })

      try {
        guard.canActivate(ctx)
        // ここに到達したら fail
        throw new Error('Expected UnauthorizedException')
      } catch (err) {
        const e = err as Error
        expect(e).toBeInstanceOf(UnauthorizedException)
        // メッセージに正値 / 不正値が一切含まれない
        const serialized = JSON.stringify({
          message: e.message,
          stack: e.stack ?? '',
        })
        expect(serialized).not.toContain(VALID_TOKEN)
        expect(serialized).not.toContain(wrong)
      }
    })

    it('503 例外メッセージに期待トークン値が含まれない', () => {
      delete process.env.API_BEARER_TOKEN
      const ctx = makeContext({ authorization: `Bearer ${VALID_TOKEN}` })

      try {
        guard.canActivate(ctx)
        throw new Error('Expected ServiceUnavailableException')
      } catch (err) {
        const e = err as Error
        expect(e).toBeInstanceOf(ServiceUnavailableException)
        const serialized = JSON.stringify({
          message: e.message,
          stack: e.stack ?? '',
        })
        expect(serialized).not.toContain(VALID_TOKEN)
      }
    })
  })

  // -------------------------------------------------------------------------
  // ケース 11: env 復元（他 spec への漏れ検証）
  // -------------------------------------------------------------------------
  describe('ケース 11: env 復元', () => {
    it('beforeEach / afterEach で process.env.API_BEARER_TOKEN が現在の spec 内に閉じる', () => {
      // この spec 内で env を変更
      process.env.API_BEARER_TOKEN = 'spec-local-token'
      expect(process.env.API_BEARER_TOKEN).toBe('spec-local-token')
      // afterEach で復元される（次の spec / 他テストファイルに漏れない）
    })

    it('前の spec の値が漏れていない（独立性確認）', () => {
      // 'spec-local-token' は前の it のローカル値であり、ここには漏れていないこと
      expect(process.env.API_BEARER_TOKEN).not.toBe('spec-local-token')
    })
  })
})
