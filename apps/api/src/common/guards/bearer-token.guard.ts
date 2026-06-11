/**
 * BearerTokenGuard — アプリ側 Bearer Token 認証（非公開化ダブルロックの内側）
 *
 * 設計書: docs/operations/phase-3-design.md
 *
 * 仕様サマリ:
 *   - `Authorization: Bearer <API_BEARER_TOKEN>` を全 HTTP ルートに強制
 *   - `process.env.API_BEARER_TOKEN` は **リクエスト毎** に読む
 *     （単体テストで env を差し替えやすく、serverless では invocation 間で env 不変のため
 *      性能差なし）
 *   - env 未設定 / 空文字 → `ServiceUnavailableException` (503) + `Logger.error` で
 *     設定不備を 1 回記録（fail-closed / 判断 4）
 *   - scheme は `'Bearer '` 固定の厳格一致（RFC 7235 の大文字小文字非依存は
 *     実装しない — クライアントは自前 curl / スクリプトのみのため）
 *   - 提示トークンと期待値を、両辺 SHA-256 で 32 byte 化してから `timingSafeEqual`
 *     （長さ不一致 throw と長さ情報リークを回避 / 判断 3 案 C）
 *   - 401 のメッセージは固定文言。「ヘッダ欠落」「scheme 不正」「不一致」を
 *     レスポンス上で区別しない（攻撃者への情報供与回避）
 *   - ログ・例外メッセージに **トークン値・ヘッダ値は一切含めない**
 *
 * 参考:
 *   - NestJS Guards / APP_GUARD: https://docs.nestjs.com/guards
 *   - crypto.timingSafeEqual: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
 *   - RFC 6750 (Bearer Token Usage): https://datatracker.ietf.org/doc/html/rfc6750
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { createHash, timingSafeEqual } from 'node:crypto'

const BEARER_SCHEME = 'Bearer '
const INVALID_TOKEN_MESSAGE = 'Invalid or missing bearer token'
const NOT_CONFIGURED_MESSAGE = 'API authentication is not configured'

@Injectable()
export class BearerTokenGuard implements CanActivate {
  private readonly logger = new Logger(BearerTokenGuard.name)

  canActivate(context: ExecutionContext): boolean {
    const expectedToken = process.env.API_BEARER_TOKEN

    // 判断 4: 未設定 / 空文字は fail-closed（503）
    // env の事実だけログに残し、値は出さない
    if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
      this.logger.error(
        '[BearerTokenGuard] API_BEARER_TOKEN is not configured',
      )
      throw new ServiceUnavailableException(NOT_CONFIGURED_MESSAGE)
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>
    }>()
    const authHeader = request?.headers?.authorization

    // ヘッダ欠落 / 型不正 / scheme 不正は同一メッセージで 401
    if (typeof authHeader !== 'string' || !authHeader.startsWith(BEARER_SCHEME)) {
      throw new UnauthorizedException(INVALID_TOKEN_MESSAGE)
    }

    const providedToken = authHeader.slice(BEARER_SCHEME.length)

    // 判断 3 案 C: SHA-256 で 32 byte に正規化してから timingSafeEqual
    // - 両辺常に 32 byte → 長さ不一致 RangeError を構造的に回避
    // - 長さ情報もタイミングから漏れない
    const providedDigest = createHash('sha256').update(providedToken).digest()
    const expectedDigest = createHash('sha256').update(expectedToken).digest()

    if (!timingSafeEqual(providedDigest, expectedDigest)) {
      throw new UnauthorizedException(INVALID_TOKEN_MESSAGE)
    }

    return true
  }
}
