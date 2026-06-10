/**
 * Provider 選択ポリシー（24 §6.1 MVP テーブル / §5 Task 分類）。
 *
 * - task_type → (primary, fallback) のマップ。設計書 24 §6.1 をコード化。
 * - MVP では OpenAI のみ adapter 実装済み（MVP_PROVIDER_NAMES）。fallback に
 *   claude/gemini 等が並ぶ task もあるが、**未実装 provider は Router が runtime で
 *   skip** する（16 MVP スコープ / OpenAI のみ）。enum 値としては将来拡張のため残す。
 * - 本ファイルは静的既定。将来は rag_provider_policies テーブル（24 §8）から
 *   読み込んで上書きするが、その配線は別チケット。
 */
import type { ProviderName, RagTaskType } from '../provider.types'
import {
  OPENAI_LLM_MODEL_DEFAULT,
  OPENAI_LLM_MODEL_QUALITY,
} from '../llm/llm.types'
import { OPENAI_EMBEDDING_MODEL } from '../embedding/embedding.types'

export interface ProviderChoice {
  provider: ProviderName
  model: string
}

export interface TaskProviderPolicy {
  primary: ProviderChoice
  /** 24 §10 Fallback。未実装 provider は Router が skip。 */
  fallbacks: ProviderChoice[]
  /** per-call timeout（ms）。24 §6.1 max_latency_ms 相当。 */
  maxLatencyMs: number
}

/**
 * 24 §6.1 MVP テーブルのコード化。
 * MVP は OpenAI のみ実装のため、primary は基本 openai。設計書で Primary が
 * Claude/Gemini の task（RISK_REVIEW / EXTERNAL_NEWS_SUMMARY）は、MVP では
 * openai に倒した primary を採用し、設計書値を fallbacks にコメントで保持する。
 */
export const MVP_PROVIDER_POLICY: Record<RagTaskType, TaskProviderPolicy> = {
  MARKET_SUMMARY: {
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'gemini', model: 'gemini-flash' }],
    maxLatencyMs: 10_000,
  },
  BOT_EXPLANATION: {
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'claude', model: 'sonnet' }],
    maxLatencyMs: 10_000,
  },
  RISK_REVIEW: {
    // 24 §6.1 Primary=Claude。MVP は OpenAI のみ実装のため openai(quality) を primary に。
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_QUALITY },
    fallbacks: [{ provider: 'claude', model: 'sonnet' }],
    maxLatencyMs: 10_000,
  },
  SIMILAR_CASE_ANALYSIS: {
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'gemini', model: 'gemini-flash' }],
    maxLatencyMs: 10_000,
  },
  EXTERNAL_NEWS_SUMMARY: {
    // 24 §6.1 Primary=Gemini（Phase2 外部情報）。MVP は openai。
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'gemini', model: 'gemini-flash' }],
    maxLatencyMs: 10_000,
  },
  BACKTEST_REPORT: {
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'claude', model: 'sonnet' }],
    maxLatencyMs: 10_000,
  },
  PROVIDER_EVALUATION: {
    primary: { provider: 'openai', model: OPENAI_LLM_MODEL_DEFAULT },
    fallbacks: [{ provider: 'gemini', model: 'gemini-flash' }],
    maxLatencyMs: 10_000,
  },
  EMBEDDING: {
    primary: { provider: 'openai', model: OPENAI_EMBEDDING_MODEL },
    // 24 §6.1 Fallback=Voyage（Phase2）。MVP は fallback なし。
    fallbacks: [],
    maxLatencyMs: 10_000,
  },
  HIGH_CONFIDENTIAL_ANALYSIS: {
    // 24 §6.1 Primary=Local LLM / Fallback なし（機密分析専用）。MVP では未実装。
    primary: { provider: 'local', model: 'local-llm' },
    fallbacks: [],
    maxLatencyMs: 10_000,
  },
}

export function getTaskPolicy(taskType: RagTaskType): TaskProviderPolicy {
  return MVP_PROVIDER_POLICY[taskType]
}
