-- ============================================================================
-- Training Bot RAG Hub — 初期 migration
-- 正本: docs/design_and_RD/05_DB_ER設計書.md（v1.1 / 正本化 2026-06-10）
--
-- 本ファイルは 2 部構成:
--   [A] Prisma 管理 DDL（prisma migrate diff 由来 / schema.prisma と同期）
--   [B] raw SQL 制約（schema.prisma で表現できない / 05 §9.4）:
--       - pgvector 拡張 + embedding 列の dimension 整合 CHECK（B6）
--       - HNSW 部分式 index（provider/model/dimension 別 / 05 §7.3）
--       - 部分 unique（idempotency / B1）
--       - 複合 FK による citation whitelist 物理強制（B2）
--       - order_permission 二次防御 CHECK（B3）
--       - reliability_score / confidence の 0..1 CHECK
--
-- 適用は DATABASE_URL の ?schema=rag で rag スキーマ運用（DB ロール物理遮断 / 05 §12.1）。
-- ============================================================================

-- pgvector 拡張（embedding 列・vector_dims() に必須 / 05 §7.3）
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- [A] Prisma 管理 DDL
-- ----------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "rag_sources" (
    "id" UUID NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "source_name" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "base_url" TEXT,
    "reliability_score" DECIMAL(5,4) NOT NULL,
    "default_language" VARCHAR(10),
    "fetch_policy" JSONB,
    "status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rag_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_source_scores" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "reliability_score" DECIMAL(5,4) NOT NULL,
    "recency_score" DECIMAL(5,4) NOT NULL,
    "noise_score" DECIMAL(5,4),
    "bias_score" DECIMAL(5,4),
    "evaluation_reason" TEXT,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_source_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_documents" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "document_type" VARCHAR(50) NOT NULL,
    "title" TEXT,
    "raw_content" TEXT NOT NULL,
    "normalized_content" TEXT NOT NULL,
    "summary" TEXT,
    "language" VARCHAR(10) NOT NULL,
    "source_url" TEXT,
    "content_hash" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL,
    "event_time" TIMESTAMPTZ(6),
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rag_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "token_count" INTEGER,
    "metadata" JSONB NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "symbol" VARCHAR(30),
    "market" VARCHAR(30),
    "timeframe" VARCHAR(20),
    "event_time" TIMESTAMPTZ(6),
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "language" VARCHAR(10) NOT NULL,
    "risk_tags" TEXT[],
    "status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_embeddings" (
    "id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "dimension" INTEGER NOT NULL,
    "embedding" vector NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "error_message" TEXT,
    "embedded_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_ingestion_jobs" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "job_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "idempotency_key" TEXT,
    "payload_hash" VARCHAR(64),
    "trace_id" VARCHAR(100) NOT NULL,
    "request_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rag_ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_ingestion_job_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "document_id" UUID,
    "external_id" VARCHAR(255),
    "status" VARCHAR(30) NOT NULL,
    "error_message" TEXT,
    "raw_payload" JSONB,
    "trace_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rag_ingestion_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_queries" (
    "id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "user_id" UUID,
    "bot_id" UUID,
    "strategy_id" UUID,
    "idempotency_key" TEXT,
    "payload_hash" VARCHAR(64),
    "query_type" VARCHAR(50) NOT NULL,
    "query_text" TEXT NOT NULL,
    "symbol" VARCHAR(30),
    "market" VARCHAR(30),
    "timeframe" VARCHAR(20),
    "source_types" TEXT[],
    "filters" JSONB NOT NULL,
    "features" JSONB,
    "provider_policy" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "trace_id" VARCHAR(100) NOT NULL,
    "request_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rag_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_retrieval_results" (
    "id" UUID NOT NULL,
    "query_id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "rank_order" INTEGER NOT NULL,
    "similarity_score" DECIMAL(8,6),
    "keyword_score" DECIMAL(8,6),
    "rerank_score" DECIMAL(8,6),
    "recency_score" DECIMAL(8,6),
    "final_score" DECIMAL(8,6),
    "used_in_answer" BOOLEAN NOT NULL,
    "retrieval_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_retrieval_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_responses" (
    "id" UUID NOT NULL,
    "query_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "response_json" JSONB NOT NULL,
    "supporting_factors" JSONB,
    "opposing_factors" JSONB,
    "similar_cases" JSONB,
    "risk_level" VARCHAR(20) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "order_permission" BOOLEAN NOT NULL DEFAULT false,
    "warning_message" TEXT,
    "status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rag_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_citations" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "retrieval_result_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "citation_order" INTEGER NOT NULL,
    "title" TEXT,
    "source_url" TEXT,
    "used_reason" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "similarity_score" DECIMAL(8,6),
    "rerank_score" DECIMAL(8,6),
    "event_time" TIMESTAMPTZ(6),
    "ingested_at" TIMESTAMPTZ(6),
    "quality_status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_guardrail_results" (
    "id" UUID NOT NULL,
    "query_id" UUID NOT NULL,
    "response_id" UUID,
    "guardrail_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "detected_items" JSONB,
    "reason" TEXT,
    "blocked" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_guardrail_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_bot_contexts" (
    "id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "bot_id" UUID NOT NULL,
    "strategy_id" UUID,
    "idempotency_key" TEXT,
    "payload_hash" VARCHAR(64),
    "query_id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "symbol" VARCHAR(30),
    "timeframe" VARCHAR(20),
    "bot_signal" VARCHAR(20),
    "features" JSONB,
    "context_json" JSONB NOT NULL,
    "order_permission" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_bot_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_provider_policies" (
    "id" UUID NOT NULL,
    "policy_name" VARCHAR(100) NOT NULL,
    "task_type" VARCHAR(50) NOT NULL,
    "primary_provider" VARCHAR(50) NOT NULL,
    "primary_model" VARCHAR(100) NOT NULL,
    "fallback_provider" VARCHAR(50),
    "fallback_model" VARCHAR(100),
    "max_input_tokens" INTEGER,
    "max_output_tokens" INTEGER,
    "max_estimated_cost" DECIMAL(12,6),
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rag_provider_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_provider_calls" (
    "id" UUID NOT NULL,
    "query_id" UUID,
    "response_id" UUID,
    "provider_policy_id" UUID,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "call_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "fallback_used" BOOLEAN NOT NULL,
    "fallback_from_call_id" UUID,
    "request_hash" VARCHAR(64),
    "response_hash" VARCHAR(64),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "trace_id" VARCHAR(100) NOT NULL,
    "request_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_provider_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_provider_usage_logs" (
    "id" UUID NOT NULL,
    "provider_call_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "estimated_cost_usd" DECIMAL(12,6) NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "query_type" VARCHAR(50),
    "bot_id" UUID,
    "trace_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_provider_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_provider_errors" (
    "id" UUID NOT NULL,
    "provider_call_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100),
    "error_type" VARCHAR(50) NOT NULL,
    "error_code" VARCHAR(100),
    "error_message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL,
    "fallback_triggered" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_provider_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rag_sources_source_type_status_idx" ON "rag_sources"("source_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rag_sources_source_type_source_name_key" ON "rag_sources"("source_type", "source_name");

-- CreateIndex
CREATE INDEX "rag_source_scores_source_id_idx" ON "rag_source_scores"("source_id");

-- CreateIndex
CREATE INDEX "rag_documents_source_id_status_idx" ON "rag_documents"("source_id", "status");

-- CreateIndex
CREATE INDEX "rag_documents_event_time_idx" ON "rag_documents"("event_time");

-- CreateIndex
CREATE INDEX "rag_documents_content_hash_idx" ON "rag_documents"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rag_documents_source_id_content_hash_key" ON "rag_documents"("source_id", "content_hash");

-- CreateIndex
CREATE INDEX "rag_chunks_document_id_chunk_index_idx" ON "rag_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "rag_chunks_symbol_timeframe_idx" ON "rag_chunks"("symbol", "timeframe");

-- CreateIndex
CREATE INDEX "rag_chunks_event_time_idx" ON "rag_chunks"("event_time");

-- CreateIndex
CREATE INDEX "rag_chunks_source_type_idx" ON "rag_chunks"("source_type");

-- CreateIndex
CREATE UNIQUE INDEX "rag_chunks_document_id_chunk_index_key" ON "rag_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "rag_chunks_document_id_content_hash_key" ON "rag_chunks"("document_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rag_embeddings_chunk_id_provider_model_key" ON "rag_embeddings"("chunk_id", "provider", "model");

-- CreateIndex
CREATE INDEX "rag_ingestion_jobs_source_id_status_idx" ON "rag_ingestion_jobs"("source_id", "status");

-- CreateIndex
CREATE INDEX "rag_ingestion_job_items_job_id_idx" ON "rag_ingestion_job_items"("job_id");

-- CreateIndex
CREATE INDEX "rag_queries_trace_id_idx" ON "rag_queries"("trace_id");

-- CreateIndex
CREATE INDEX "rag_queries_bot_id_created_at_idx" ON "rag_queries"("bot_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rag_retrieval_results_query_id_chunk_id_key" ON "rag_retrieval_results"("query_id", "chunk_id");

-- CreateIndex
CREATE INDEX "rag_responses_query_id_idx" ON "rag_responses"("query_id");

-- CreateIndex
CREATE INDEX "rag_citations_retrieval_result_id_idx" ON "rag_citations"("retrieval_result_id");

-- CreateIndex
CREATE UNIQUE INDEX "rag_citations_response_id_citation_order_key" ON "rag_citations"("response_id", "citation_order");

-- CreateIndex
CREATE INDEX "rag_guardrail_results_query_id_idx" ON "rag_guardrail_results"("query_id");

-- CreateIndex
CREATE INDEX "rag_bot_contexts_bot_id_created_at_idx" ON "rag_bot_contexts"("bot_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rag_provider_calls_trace_id_idx" ON "rag_provider_calls"("trace_id");

-- CreateIndex
CREATE INDEX "rag_provider_usage_logs_created_at_idx" ON "rag_provider_usage_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "rag_provider_usage_logs_provider_model_created_at_idx" ON "rag_provider_usage_logs"("provider", "model", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rag_provider_errors_provider_call_id_idx" ON "rag_provider_errors"("provider_call_id");

-- AddForeignKey
ALTER TABLE "rag_source_scores" ADD CONSTRAINT "rag_source_scores_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_embeddings" ADD CONSTRAINT "rag_embeddings_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "rag_chunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_ingestion_jobs" ADD CONSTRAINT "rag_ingestion_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_ingestion_job_items" ADD CONSTRAINT "rag_ingestion_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "rag_ingestion_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_ingestion_job_items" ADD CONSTRAINT "rag_ingestion_job_items_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_retrieval_results" ADD CONSTRAINT "rag_retrieval_results_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "rag_queries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_retrieval_results" ADD CONSTRAINT "rag_retrieval_results_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "rag_chunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_retrieval_results" ADD CONSTRAINT "rag_retrieval_results_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_retrieval_results" ADD CONSTRAINT "rag_retrieval_results_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_responses" ADD CONSTRAINT "rag_responses_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "rag_queries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "rag_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rag_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "rag_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "rag_chunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_guardrail_results" ADD CONSTRAINT "rag_guardrail_results_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "rag_queries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_guardrail_results" ADD CONSTRAINT "rag_guardrail_results_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "rag_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_bot_contexts" ADD CONSTRAINT "rag_bot_contexts_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "rag_queries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_bot_contexts" ADD CONSTRAINT "rag_bot_contexts_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "rag_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_provider_calls" ADD CONSTRAINT "rag_provider_calls_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "rag_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_provider_calls" ADD CONSTRAINT "rag_provider_calls_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "rag_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_provider_calls" ADD CONSTRAINT "rag_provider_calls_provider_policy_id_fkey" FOREIGN KEY ("provider_policy_id") REFERENCES "rag_provider_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_provider_usage_logs" ADD CONSTRAINT "rag_provider_usage_logs_provider_call_id_fkey" FOREIGN KEY ("provider_call_id") REFERENCES "rag_provider_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_provider_errors" ADD CONSTRAINT "rag_provider_errors_provider_call_id_fkey" FOREIGN KEY ("provider_call_id") REFERENCES "rag_provider_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ----------------------------------------------------------------------------
-- [B] raw SQL 制約（schema.prisma で表現できない / 05 §9.4）
-- ----------------------------------------------------------------------------

-- === B6: embedding 列の dimension 整合 CHECK（05 §5.5）=======================
-- 宣言次元(dimension)と実体ベクトルの次元(vector_dims)の不一致を物理拒否。
-- マルチ Provider 次元混在（1024/1536/3072）を単一テーブルで安全に保持する。
ALTER TABLE "rag_embeddings"
  ADD CONSTRAINT "rag_embeddings_dimension_match_chk"
  CHECK (vector_dims("embedding") = "dimension");

-- === B6 / 05 §7.3: HNSW 部分式 index（provider/model/dimension 別）===========
-- 型なし vector 列には直接 index を張れないため、式 index (embedding::vector(N)) +
-- 部分述語 WHERE で provider 別 ANN を成立させる（pgvector 公式 mixed-dimension）。
-- 検索 SQL は §8.1 と「同一キャスト式 + 同一 WHERE 述語」を書くこと（planner 一致条件）。
-- 新 embedding model 採用時は本セクションに 1 行追加（命名規約: idx_emb_hnsw_{provider}_{dim}）。
--
-- MVP: OpenAI text-embedding-3-small（1536 次元）のみ。
CREATE INDEX "idx_emb_hnsw_openai_small_1536"
  ON "rag_embeddings"
  USING hnsw (("embedding"::vector(1536)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE "provider" = 'openai'
    AND "model" = 'text-embedding-3-small'
    AND "dimension" = 1536
    AND "status" = 'ACTIVE';

-- Phase2 で voyage-3（1024）等を採用する場合の雛形（コメントアウト）:
-- CREATE INDEX "idx_emb_hnsw_voyage_1024"
--   ON "rag_embeddings"
--   USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
--   WITH (m = 16, ef_construction = 64)
--   WHERE "provider" = 'voyage' AND "model" = 'voyage-3'
--     AND "dimension" = 1024 AND "status" = 'ACTIVE';

-- === B1: 部分 unique（idempotency / WHERE idempotency_key IS NOT NULL）========
-- 同一 (requester_id|source_id, idempotency_key) の二重 INSERT を物理遮断。
-- NULL（冪等性なし呼び出し / UI 等）は対象外。
CREATE UNIQUE INDEX "uq_rag_queries_idempotency"
  ON "rag_queries" ("requester_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "uq_rag_ingestion_jobs_idempotency"
  ON "rag_ingestion_jobs" ("source_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "uq_rag_bot_contexts_idempotency"
  ON "rag_bot_contexts" ("requester_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- === B2: citation whitelist 物理強制（複合 FK）===============================
-- (1) 参照先となる複合 unique を rag_retrieval_results(id, chunk_id) に張る。
--     id は PK で既に unique だが、複合 FK の参照先には対象列を含む unique 制約が必要。
ALTER TABLE "rag_retrieval_results"
  ADD CONSTRAINT "uq_rag_retrieval_results_id_chunk_id"
  UNIQUE ("id", "chunk_id");

-- (2) rag_citations(retrieval_result_id, chunk_id) -> rag_retrieval_results(id, chunk_id)。
--     LLM が返した chunk_id が当該クエリの retrieval 集合に実在することを DB 制約で物理強制。
--     アプリ検証が漏れても捏造 citation は INSERT 不能になる。
ALTER TABLE "rag_citations"
  ADD CONSTRAINT "fk_rag_citations_retrieval_whitelist"
  FOREIGN KEY ("retrieval_result_id", "chunk_id")
  REFERENCES "rag_retrieval_results" ("id", "chunk_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- === B3: order_permission 二次防御 CHECK（05 §5.10 / §5.13）==================
-- 一次防御は DB ロール物理遮断（インフラ / §12.1）。本 CHECK はその上の二次防御。
ALTER TABLE "rag_responses"
  ADD CONSTRAINT "rag_responses_order_permission_false_chk"
  CHECK ("order_permission" = false);

ALTER TABLE "rag_bot_contexts"
  ADD CONSTRAINT "rag_bot_contexts_order_permission_false_chk"
  CHECK ("order_permission" = false);

-- === スコア値域 CHECK（0..1）================================================
ALTER TABLE "rag_sources"
  ADD CONSTRAINT "rag_sources_reliability_score_range_chk"
  CHECK ("reliability_score" >= 0 AND "reliability_score" <= 1);

ALTER TABLE "rag_responses"
  ADD CONSTRAINT "rag_responses_confidence_range_chk"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- ----------------------------------------------------------------------------
-- 末尾メモ: §7.1 通常 index / §7.2 JSONB GIN index のうち schema.prisma の
-- @@index で表現済みのものは [A] に含まれる。GIN index は @@index で型指定できないため
-- 以下に raw SQL で追加する（05 §7.2）。
-- ----------------------------------------------------------------------------
CREATE INDEX "idx_rag_documents_metadata_gin"
  ON "rag_documents" USING gin ("metadata");

CREATE INDEX "idx_rag_chunks_metadata_gin"
  ON "rag_chunks" USING gin ("metadata");

CREATE INDEX "idx_rag_queries_filters_gin"
  ON "rag_queries" USING gin ("filters");

CREATE INDEX "idx_rag_responses_response_json_gin"
  ON "rag_responses" USING gin ("response_json");
