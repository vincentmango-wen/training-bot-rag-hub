/**
 * OpenAI モデル別の概算コスト計算（24 §15 監査ログ `estimated_cost`）。
 *
 * - 金額は string で返す（横断規約 §2 / 10 §6.1 estimated_cost は string）。
 * - USD / 1M tokens の単価表。料金改定時は本表のみ更新（料金は SSoT 化）。
 * - 未知モデルは undefined（コスト不明として meta から estimated_cost を省略）。
 *
 * 注: 厳密会計用ではなく監査・予算監視用の概算（24 コスト制御 Policy）。
 */

import { Prisma } from '@prisma/client'

/** USD / 1,000,000 tokens の単価（string で保持 / Decimal Safe / float 乗算を避ける）。 */
interface ModelRate {
  input: string
  output: string
}

const USD_PER_MILLION: Record<string, ModelRate> = {
  // chat
  'gpt-4o-mini': { input: '0.15', output: '0.6' },
  'gpt-4o': { input: '2.5', output: '10' },
  // embedding（output は無し）
  'text-embedding-3-small': { input: '0.02', output: '0' },
}

const ONE_MILLION = new Prisma.Decimal(1_000_000)

/**
 * トークン使用量からコスト（USD）を string で算出。未知モデルは undefined。
 *
 * cost_usd = inputTokens * (input_rate / 1e6) + outputTokens * (output_rate / 1e6)
 * Minor: float 乗算（IEEE 754 誤差の入口）をやめ Prisma.Decimal で計算する（横断規約 §2）。
 * 小数 8 桁固定（極小コストの欠落防止）。string 化（Decimal Safe）。
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): string | undefined {
  const rate = USD_PER_MILLION[model]
  if (rate === undefined) return undefined

  const inputCost = new Prisma.Decimal(inputTokens)
    .mul(new Prisma.Decimal(rate.input))
    .div(ONE_MILLION)
  const outputCost = new Prisma.Decimal(outputTokens)
    .mul(new Prisma.Decimal(rate.output))
    .div(ONE_MILLION)

  return inputCost.plus(outputCost).toFixed(8)
}
