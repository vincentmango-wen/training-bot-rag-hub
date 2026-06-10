/**
 * ProviderUsageRecorder — Provider 利用量の記録ポート（at-least-once）。
 *
 * Router は **成功・失敗・fallback を問わず必ず** record を呼ぶ（24 PP-AC-004
 * Provider 利用履歴 100% 保存）。永続化実装（Prisma）は別チケット。本 interface
 * は Router をストレージ実装から疎結合にするための注入境界。
 *
 * at-least-once 契約: record の失敗で本処理（query 応答）を落とさない。記録失敗は
 * 内部ログに留め、再送/補償は Recorder 実装側の責務（重複は audit 集計側で吸収）。
 */
import type { ProviderUsageRecord } from './provider-usage.types'

export interface ProviderUsageRecorder {
  /** 1 回の Provider 呼び出し結果を記録する。例外を呼び出し元へ伝播しないこと。 */
  record(usage: ProviderUsageRecord): Promise<void>
}

/** Nest DI トークン。 */
export const PROVIDER_USAGE_RECORDER = Symbol('PROVIDER_USAGE_RECORDER')

/**
 * 既定 no-op Recorder（永続化未配線時のフォールバック）。
 * MVP の Provider モジュール単体起動・テストで使う。本番は Prisma 実装に差し替え。
 */
export class NoopProviderUsageRecorder implements ProviderUsageRecorder {
  async record(_usage: ProviderUsageRecord): Promise<void> {
    // no-op（永続化は別チケットの repository 実装で差し替え）
  }
}
