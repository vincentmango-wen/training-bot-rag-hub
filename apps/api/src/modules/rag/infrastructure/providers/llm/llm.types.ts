/**
 * LLM 層の補助型・MVP モデル仕様。
 */
import type { ProviderName } from '../provider.types'

/** LLM を提供しうる Provider 名（ProviderName のサブ集合）。 */
export type LlmProviderName = ProviderName

/**
 * MVP の LLM モデル（16 / 24 §6.1）。MVP は OpenAI のみ。
 * gpt-4o-mini を既定・低コスト Primary とする（24 §11 Level1 = Mini 固定にも整合）。
 */
export const OPENAI_LLM_MODEL_DEFAULT = 'gpt-4o-mini' as const
/** 上位品質モデル（task 別に Router が選択。MVP 既定は Mini）。 */
export const OPENAI_LLM_MODEL_QUALITY = 'gpt-4o' as const

/** 温度・seed の固定値（24 温度/seed 固定 / PP-003）。 */
export const LLM_FIXED_TEMPERATURE = 0 as const
export const LLM_FIXED_SEED = 42 as const
