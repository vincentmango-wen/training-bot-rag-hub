/**
 * LLM structured output の Zod schema（21 §6〜§8 出力 Schema / structured output 強制）。
 *
 * これは **LLM に生成させる JSON の形**であり、API レスポンス（common.ts citationSchema 等）
 * とは別物。LLM には chunk_id 主体の軽量 citation を出させ、orchestrator が retrieval 集合と
 * 突合して whitelist 検証 + メタ補完してから API citation を組み立てる（10 §6.1 / B2）。
 *
 * order_permission は LLM 出力に含めても **必ず literal false を要求**する（21 §12 / 横断規約5）。
 * Guardrail OrderPermissionGuard が二次防御で再固定するが、schema 段でも false 以外を弾く。
 */
import { z } from 'zod'
import { riskLevelSchema } from '@pmtp/shared'

/** LLM が返す citation 最小形（chunk_id + 使用理由）。集合外 ID は whitelist 段で除去。 */
export const llmCitationSchema = z.object({
  chunk_id: z.string(),
  used_reason: z.string(),
})
export type LlmCitation = z.infer<typeof llmCitationSchema>

/** PROMPT-001 市場文脈検索の出力（query API / 21 §6）。 */
export const llmQueryOutputSchema = z.object({
  summary: z.string(),
  supporting_factors: z.array(z.string()),
  opposing_factors: z.array(z.string()),
  risk_level: riskLevelSchema,
  confidence: z.number().min(0).max(1),
  citations: z.array(llmCitationSchema),
})
export type LlmQueryOutput = z.infer<typeof llmQueryOutputSchema>

/** PROMPT-002 Bot 判断理由生成の出力（bot-context API / 21 §7）。 */
export const llmBotContextOutputSchema = z.object({
  explanation: z.string(),
  supporting_factors: z.array(z.string()),
  opposing_factors: z.array(z.string()),
  risk_level: riskLevelSchema,
  confidence: z.number().min(0).max(1),
  citations: z.array(llmCitationSchema),
  /** 21 §7 出力 Schema は order_permission:false を含む。literal false を強制（横断規約5）。 */
  order_permission: z.literal(false),
})
export type LlmBotContextOutput = z.infer<typeof llmBotContextOutputSchema>
