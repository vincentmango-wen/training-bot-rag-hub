import { Prisma } from '@prisma/client'

import {
  DEFAULT_MAX_STALENESS_DAYS,
  DEFAULT_RELIABILITY_FLOOR,
  type ChunkVisibilityParams,
} from './retrieval.types'

/**
 * チャンク検索可視性条件 SSoT（公開条件の唯一の組み立て口）。
 *
 * 設計正本: 05_DB_ER設計書 §5.4（隔離列一本化 / status='ACTIVE' 単述語）/ §8.1（検索 SQL の
 * WHERE 群）/ §9.4（「検索可視性条件の WHERE 直書きを禁止し helper を唯一の組み立て口とする」）。
 *
 * 本 helper を経由しない可視性 WHERE の直書きを **禁止** する。rag_embeddings / rag_chunks /
 * rag_documents / rag_sources を参照する全検索パスは本 helper の戻り値を WHERE に AND 結合する。
 *
 * 不変条件（テストで担保 / chunk-visibility.where.spec.ts）:
 *   1. chunk(`c`)        : status='ACTIVE'                  （QUARANTINED/DISABLED を一括遮断）
 *   2. chunk(`c`)        : deleted_at IS NULL               （論理削除除外）
 *   3. document(`d`)     : status='INDEXED' AND deleted_at IS NULL
 *   4. source(`s`)       : status='ACTIVE'  AND deleted_at IS NULL
 *   5. source(`s`)       : reliability_score >= reliabilityFloor   （信頼度足切り / パラメータ化）
 *   6. staleness hard cap: coalesce(c.event_time, c.ingested_at) >= now() - maxStalenessDays days
 *
 * これらは「金銭判断に影響する出力の品質担保」のため必須（§8.1 置換理由 / B5）。
 * いずれか 1 つでも欠落すると QUARANTINED / 論理削除 / 低信頼 / 古すぎる情報が混入する。
 *
 * @param aliases - SQL 内のテーブル別名（既定: chunk=c / document=d / source=s）
 * @returns AND 結合可能な `Prisma.Sql` 断片（先頭は `c.status = 'ACTIVE' AND ...`）
 */
export function buildChunkVisibilityWhere(
  params?: Partial<ChunkVisibilityParams>,
  aliases?: { chunk?: string; document?: string; source?: string },
): Prisma.Sql {
  const reliabilityFloor =
    params?.reliabilityFloor ?? DEFAULT_RELIABILITY_FLOOR
  const maxStalenessDays =
    params?.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS

  // 別名はリテラルとして埋め込むため、許可リスト相当の固定値のみ受け付ける
  // （Prisma.raw に外部入力を混ぜない / injection 面の遮断）。既定値は a-z のみ。
  const c = safeAlias(aliases?.chunk ?? 'c')
  const d = safeAlias(aliases?.document ?? 'd')
  const s = safeAlias(aliases?.source ?? 's')

  const conditions: Prisma.Sql[] = [
    // 1. chunk 隔離除外（QUARANTINED / DISABLED を 1 述語で遮断 / §5.4 設計裁定 1）
    Prisma.sql`${Prisma.raw(c)}.status = 'ACTIVE'`,
    // 2. chunk 論理削除除外
    Prisma.sql`${Prisma.raw(c)}.deleted_at is null`,
    // 3. document: INDEXED + 論理削除除外
    Prisma.sql`${Prisma.raw(d)}.status = 'INDEXED'`,
    Prisma.sql`${Prisma.raw(d)}.deleted_at is null`,
    // 4. source: ACTIVE + 論理削除除外
    Prisma.sql`${Prisma.raw(s)}.status = 'ACTIVE'`,
    Prisma.sql`${Prisma.raw(s)}.deleted_at is null`,
    // 5. 信頼度足切り（パラメータ化）
    Prisma.sql`${Prisma.raw(s)}.reliability_score >= ${reliabilityFloor}`,
    // 6. staleness hard cap（パラメータ化 / make_interval で日数注入）
    //    バインドは driver により bigint になるため ::int で make_interval(days integer) に合わせる
    Prisma.sql`coalesce(${Prisma.raw(c)}.event_time, ${Prisma.raw(c)}.ingested_at) >= now() - make_interval(days => ${maxStalenessDays}::int)`,
  ]

  return Prisma.join(conditions, ' and ')
}

/** 解決済みの可視性パラメータ（監査・スナップショット用に呼び出し側へ返す）。 */
export function resolveVisibilityParams(
  params?: Partial<ChunkVisibilityParams>,
): ChunkVisibilityParams {
  return {
    reliabilityFloor: params?.reliabilityFloor ?? DEFAULT_RELIABILITY_FLOOR,
    maxStalenessDays: params?.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS,
  }
}

/**
 * テーブル別名のサニタイズ。Prisma.raw に渡すため、英小文字のみ（1〜10 文字）に限定する。
 * 想定外文字が来たら例外（外部入力が別名に混入する経路を構造的に塞ぐ）。
 */
function safeAlias(alias: string): string {
  if (!/^[a-z][a-z0-9_]{0,9}$/.test(alias)) {
    throw new Error(`invalid SQL alias: ${alias}`)
  }
  return alias
}
