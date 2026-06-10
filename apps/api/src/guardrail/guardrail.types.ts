/**
 * Guardrail モジュールの I/O 型定義。
 *
 * Guardrail は LLM 出力・取得文書・citation 集合を入力に、決定的（regex/コード）ロジックで
 * 検証し、PASS / WARNING / BLOCKED を返す。LLM 検証には依存しない（21 §12 の出力検証は
 * LLM 任意項目であり、本モジュールの BLOCK 判定はコード側で確定する）。
 */

import type {
  GuardrailStatus,
  GuardrailType,
  GuardrailSeverity,
  OrderPermission,
} from './guardrail.enums'

/* -------------------------------------------------------------------------- */
/* 個別検証結果 / 集約結果                                                      */
/* -------------------------------------------------------------------------- */

/** 1 検証（guard）の発火結果。 */
export type GuardrailViolation = {
  type: GuardrailType
  severity: GuardrailSeverity
  /** BLOCK か WARNING か（false=BLOCK / true=warning にとどめる）。 */
  blocking: boolean
  message: string
  /** 該当箇所のパス（任意 / 例: "citations[2].chunk_id"）。 */
  field?: string
}

/** Guardrail 全体の集約結果。 */
export type GuardrailResult = {
  status: GuardrailStatus
  /** 常に literal false（横断規約5）。 */
  order_permission: OrderPermission
  blocked_reasons: string[]
  warnings: string[]
  violations: GuardrailViolation[]
}

/* -------------------------------------------------------------------------- */
/* Citation whitelist / quality 検証                                           */
/* -------------------------------------------------------------------------- */

/** LLM が返した citation のうち、検証に必要な最小フィールド。 */
export type CitationCandidate = {
  chunk_id: string
  /** quality_status が無い citation は ACTIVE 以外として扱う（fail-safe）。 */
  quality_status?: string
  [key: string]: unknown
}

/**
 * 当該クエリの retrieval 結果集合（rag_retrieval_results）の 1 要素。
 * whitelist の正本であり、ここに存在しない chunk_id は LLM の捏造として除去する。
 */
export type RetrievalResultRef = {
  chunk_id: string
  /** chunk の最新 quality_status（DB 側が真値 / LLM 申告は信用しない）。 */
  quality_status: string
}

export type CitationFilterInput<C extends CitationCandidate = CitationCandidate> = {
  /** LLM が返した citation 配列。 */
  citations: C[]
  /** 当該クエリの retrieval 集合（whitelist の正本）。 */
  retrievalResults: RetrievalResultRef[]
}

export type CitationFilterOutput<C extends CitationCandidate = CitationCandidate> = {
  /** whitelist 通過 + ACTIVE のみを残した citation。 */
  allowed: C[]
  /** whitelist 集合外（捏造）で除去された chunk_id。 */
  removedNotInWhitelist: string[]
  /** whitelist には在るが quality_status が ACTIVE 以外で除去された chunk_id。 */
  removedNonActive: string[]
  /** 検証で発火した violation 群。 */
  violations: GuardrailViolation[]
  /**
   * 残存 citation が 0 件 = 根拠なし回答（10 §6.1 / 04 NFR-LLM-006）。
   * 呼び出し側はこの true を受けて 422 RAG_GUARDRAIL_BLOCKED を返す。
   */
  block: boolean
}

/* -------------------------------------------------------------------------- */
/* Prompt injection 検知                                                       */
/* -------------------------------------------------------------------------- */

/** 取得文書 1 件（injection 検知 + デリミタ隔離の対象）。 */
export type RetrievedDocument = {
  /** 監査・field 用の識別子（chunk_id 等）。 */
  id: string
  /** 取得した本文（外部由来 = データであり命令ではない）。 */
  content: string
}

export type InjectionScanResult = {
  /** 命令文字列を検知したか。 */
  detected: boolean
  /** 検知した文書 id とマッチしたパターンラベル。 */
  hits: Array<{ id: string; patterns: string[] }>
  violations: GuardrailViolation[]
}

/* -------------------------------------------------------------------------- */
/* Secret masking                                                              */
/* -------------------------------------------------------------------------- */

export type SecretMaskResult = {
  /** マスク後の文字列。 */
  masked: string
  /** マスクが 1 件以上発生したか。 */
  maskedAny: boolean
  /** 検知した secret 種別ラベル（"openai_api_key" 等 / 値そのものは含めない）。 */
  kinds: string[]
}
