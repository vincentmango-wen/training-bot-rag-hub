# Neon プロビジョニング Runbook — Phase 1

- 対象: training-bot-rag-hub `apps/api`（NestJS + Prisma 5.22 + pgvector）
- ゴール: Neon Free 上に DB を作成し、`prisma migrate deploy` で既存 17 テーブル + pgvector を適用、検証クエリまで通す
- スコープ外: Vercel Functions エントリ追加（Phase 2 以降）/ docker-compose 撤去（Redis 削除と同タイミングで別フェーズ）
- 設計書: `docs/operations/phase-1-design.md`

---

## 1. 前提

- Neon アカウント取得済（https://neon.com/）。本プロジェクト用に Free プラン 1 プロジェクトを使う前提
- ローカル Node 22 + npm（リポジトリ全体は pnpm/npm 混在せず npm で運用）
- 本リポジトリ clone 済 / `apps/api` で `npm run prisma:validate` が exit 0 で通ること（schema と env 参照の整合）
- 実値（接続文字列・パスワード）はすべて `apps/api/.env` のみに記入し、`.env.example` / runbook / チャット / コミットには貼らない

---

## 2. Neon プロジェクト作成

1. Neon コンソール（https://console.neon.tech/）→ 「New Project」
2. 設定値:
   - **Project name**: `training-bot-rag-hub`（同名プロジェクトの二重作成防止のため固定）
   - **Postgres version**: 16 以上（pgvector を含む）
   - **Region**: `Asia Pacific (Singapore) — ap-southeast-1`（東京から最寄り）
   - **Database name**: `rag_hub`（apps/api/.env.example のローカル値と一致させると差し替えが楽）
   - **Role name**: コンソール表示のデフォルトでよい（後段で接続文字列をそのままコピーするため）
3. 既存プロジェクト一覧に `training-bot-rag-hub` がないことを確認してから「Create」
4. 作成後ダッシュボードに遷移したら、Project ID / Endpoint を控える（実値はコンソールに残る）

---

## 3. 接続文字列の取得

Neon コンソール → 該当プロジェクト → 左メニュー「Connect」（または右上「Connection Details」）

1. **Pooled connection** を選択 → 表示された URL をコピー（ホスト名に `-pooler` が含まれる / 例: `ep-xxx-pooler.ap-southeast-1.aws.neon.tech`）
2. **Direct connection** を選択 → 表示された URL をコピー（`-pooler` が含まれない）

両 URL を見分ける唯一の手がかりは **`-pooler` サフィックスの有無**。これを混同すると migrate deploy が advisory lock 取得失敗で詰まる。

---

## 4. `.env` への投入

`apps/api/.env`（存在しなければ `apps/api/.env.example` をコピーして作成）に以下の形で投入:

```bash
# 実行時用（Pooled）
DATABASE_URL=<pooled URL>?sslmode=require&pgbouncer=true&connection_limit=1&schema=public

# migration 用（Direct）
DIRECT_URL=<direct URL>?sslmode=require&schema=public
```

URL 末尾のクエリパラメータ:

| パラメータ | 必要性 | 理由 |
|---|---|---|
| `sslmode=require` | 必須（両方） | Neon は SSL 必須 |
| `pgbouncer=true` | **DATABASE_URL のみ** | Prisma が PgBouncer transaction mode 向けに prepared statement を無効化する。これが無いと連続クエリで `prepared statement "s0" already exists` |
| `connection_limit=1` | DATABASE_URL のみ（serverless 想定） | Vercel Functions の 1 invocation = 1 接続。ローカルから Neon を叩く分には外してよい |
| `schema=public` | 必須（両方） | pgvector が public schema に常駐し、vector 型・演算子の解決に必要（`apps/api/.env.example` コメント参照） |

**注意**: Neon コンソールが返す URL に既に一部パラメータが含まれている場合があるため、上記を**重複なく**追記すること（例: `?sslmode=require` 既存に `&pgbouncer=true&connection_limit=1&schema=public` を append）。

---

## 5. migration 適用

リポジトリルートで:

```bash
# Prisma が DIRECT_URL（apps/api/.env）を読んで advisory lock を取得 → migrate deploy
npm run db:migrate:deploy

# 適用確認
npm run db:migrate:status
```

期待出力: `Database schema is up to date!`

**冪等性**: `_prisma_migrations` テーブルが既存の migration を追跡するため、再実行は安全（適用済は skip される）。

---

## 6. pgvector / スキーマ検証

Neon コンソール → 「SQL Editor」、または `psql "$DIRECT_URL"` で接続して以下を実行:

```sql
-- (a) pgvector が有効化されている（init migration L19 が CREATE EXTENSION 済）
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- 期待: 1 行（extname=vector, extversion=0.5.x 以降）

-- (b) rag_* テーブル 17 個が存在
\dt rag_*
-- 期待: rag_sources / rag_documents / rag_chunks / rag_embeddings / rag_queries /
--       rag_retrieval_results / rag_citations / rag_ingestion_jobs / rag_bot_contexts / 他 17 件

-- (c) HNSW 部分式 index（pgvector 用）
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%hnsw%';
-- 期待: provider/model/dimension 別の HNSW index が複数行

-- (d) DB サイズ（0.5 GB 上限への余裕確認）
SELECT pg_size_pretty(pg_database_size(current_database()));
```

(a) が 0 行なら init migration が走っていない（§5 を再実行）。pgvector の手動有効化（`CREATE EXTENSION` を直接実行）は**禁止**（init が担う / 設計判断 1-A）。

---

## 7. トラブルシュート

| 症状 | 真因 | 対応 |
|---|---|---|
| `P1001: Can't reach database server` | `sslmode=require` 欠落 / Neon autosuspend 直後 | URL に `sslmode=require` を付与。autosuspend の場合は 1 回リトライ（数秒で起動完了） |
| `prepared statement "s0" already exists` | `DATABASE_URL` に `pgbouncer=true` を付け忘れ | DATABASE_URL のクエリに `pgbouncer=true` を追加 |
| `type "vector" does not exist` | `schema=public` 以外で接続 / 別 schema を search_path にしている | URL に `?schema=public` を明示。複数 schema を使う場合でも pgvector が住む public を解決可能にする |
| `migrate deploy` が advisory lock で hang | `DIRECT_URL` に Pooled URL（`-pooler` 付き）を誤設定 | DIRECT_URL は **`-pooler` なし** の URL に修正 |
| 初回リクエストが数秒遅い | Neon Free の autosuspend（無アクセス 5 分で停止）からの cold start | 仕様 / 個人非公開運用では許容 |

---

## 8. ストレージ監視（運用継続のため）

Neon Free は **0.5 GB ストレージ上限**。pgvector の HNSW index は実データの数倍に膨らみ得るため、embedding 蓄積が進んだら定期確認:

```sql
-- DB 全体サイズ
SELECT pg_size_pretty(pg_database_size(current_database()));

-- テーブル別サイズ（index 含む）
SELECT
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  pg_size_pretty(pg_indexes_size(relid)) AS index_size
FROM pg_catalog.pg_statio_user_tables
WHERE relname LIKE 'rag_%'
ORDER BY pg_total_relation_size(relid) DESC;
```

上限の 70% (~350 MB) を超えたら古い embedding の TTL / アーカイブを検討。Neon コンソールの「Monitoring」タブで compute hours（190h/月）の消費状況も確認可能。

---

## 参考ドキュメント（実装担当が WebFetch で実在確認推奨）

- Neon + Prisma 公式ガイド: https://neon.com/docs/guides/prisma
- Neon Connection Pooling: https://neon.com/docs/connect/connection-pooling
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- Prisma + PgBouncer: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer
- Prisma directUrl: https://www.prisma.io/docs/orm/reference/prisma-schema-reference#directurl
- Neon Plans: https://neon.com/docs/introduction/plans
