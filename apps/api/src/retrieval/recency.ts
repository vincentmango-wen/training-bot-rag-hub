import type { SourceType } from '@pmtp/shared'

/**
 * 鮮度スコア τ（半減期）の source_type 別マップ。
 *
 * 設計正本: 05_DB_ER設計書 §8.1 のパラメータ注記 + §8.1 設計注記。
 *   news / sns / prediction_market : 7 日
 *   market_data                    : 30 日
 *   bot_log / order_history        : 90 日（= else 既定）
 *   strategy_doc                   : 365 日
 *   その他                          : 90 日（else）
 *
 * recency は **検索 SQL 内で動的計算** する（カラム保持しない / 経年再計算ジョブ不要 /
 * §5.4 設計裁定 2）。本マップは SQL の `CASE c.source_type ... END` を TS 定数として
 * SSoT 化し、SQL リテラルと TS テストの両方から参照できるようにするためのもの。
 */

/** source_type 別 τ（日数）。明示されない source_type は {@link DEFAULT_TAU_DAYS}。 */
export const RECENCY_TAU_DAYS: Readonly<Record<string, number>> = {
  news: 7,
  sns: 7,
  prediction_market: 7,
  market_data: 30,
  strategy_doc: 365,
  bot_log: 90,
  order_history: 90,
}

/** マップ外 source_type の既定 τ（05 §8.1 の else 分岐 = 90 日）。 */
export const DEFAULT_TAU_DAYS = 90 as const

/**
 * source_type の τ（日数）を返す。マップ外は既定 90 日。
 * 検証・テスト用（SQL 側は §8.1 の CASE 式が正本）。
 */
export function tauDaysFor(sourceType: SourceType | string): number {
  return RECENCY_TAU_DAYS[sourceType] ?? DEFAULT_TAU_DAYS
}

/**
 * 検索 SQL に埋め込む recency_score 式（05 §8.1）。
 *
 *   exp( -Δt / τ )
 *   Δt = now() - coalesce(c.event_time, c.ingested_at)   （秒）
 *   τ  = source_type 別（上記マップ / 秒換算）
 *
 * カラム別名は呼び出し側 SQL の chunk テーブル別名（既定 `c`）に合わせる。
 * CASE 式の値・分岐は {@link RECENCY_TAU_DAYS} と完全一致させること（drift 防止）。
 */
export function recencyScoreSqlExpression(chunkAlias = 'c'): string {
  const c = chunkAlias
  return `exp( - extract(epoch from (now() - coalesce(${c}.event_time, ${c}.ingested_at)))
         / extract(epoch from (
             case ${c}.source_type
               when 'news' then interval '7 days'
               when 'sns' then interval '7 days'
               when 'prediction_market' then interval '7 days'
               when 'market_data' then interval '30 days'
               when 'strategy_doc' then interval '365 days'
               else interval '90 days'
             end)) )`
}
