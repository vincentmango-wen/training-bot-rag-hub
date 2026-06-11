# Training Bot RAG Hub

Training Bot RAG Hub は、Personal Multi Trading Platform 内で Training Bot / AI分析画面 / Bot検証画面が参照するRAG基盤です。

## 最重要原則

- RAGは注文しない
- RAGはBot設定を変更しない
- RAGは緊急停止を解除しない
- RAGは判断材料だけを返す
- RAG出力は必ず検証する
- RAG利用履歴は必ず保存する
- ProviderはAdapter経由で呼び出す
- Secretをログ・回答・Provider送信に含めない

## 構成

```text
apps/
  api/       NestJS API
  web/       Future UI placeholder

packages/
  shared/    Shared types and constants
```

## 初期セットアップ
```
## 初期セットアップ

```bash
npm ci
npm ci --prefix packages/shared
npm ci --prefix apps/api

npm run typecheck
npm run lint
npm run test
npm run build
```

## 環境変数

GH-005では、ローカル開発用の環境変数テンプレートとして `.env.example` を用意します。

`.env.example` には変数名だけを定義し、Secret / API Key / JWT / DBパスワードの実値は入れません。

ローカル環境では以下を実行して `.env` を作成します。

```bash
cp .env.example .env
```

`.env` はGit管理対象外です。実値は `.env` にのみ記入します。

以下はコミット禁止です。

```text
OPENAI_API_KEY の実値
JWT の実値
DBパスワードの実値
Secret Manager相当の値
本番接続情報
```

Secret混入確認:

```bash
grep -nE '=.+' .env.example || true
grep -nE '(sk-|eyJ|secret|password|token|api_key)' .env.example || true
git check-ignore .env
git check-ignore .env.example || echo ".env.example is not ignored"
```

期待結果:

```text
.env.example に実値が出ない
.env は ignore される
.env.example は ignore されない
```

## Local Infrastructure

GH-003では PostgreSQL / Redis / pgvector を Docker Compose で起動します。

### 前提

Docker daemon が起動していることを確認します。

Colimaを使う場合:

```bash
colima start
docker info
```

## 起動
```
npm run docker:up
npm run docker:ps
```

## 期待結果:
```
pmtp-rag-postgres   healthy
pmtp-rag-redis      healthy
```

## PostgreSQL接続確認
```
npm run db:psql
```
psql内で以下を実行します。
```
SELECT current_database();
SELECT current_user;
SELECT extname FROM pg_extension WHERE extname = 'vector';
\q
```
期待結果:
```
current_database = rag_hub
current_user = rag_user
extname = vector
```
Redis接続確認
```
npm run redis:cli
```
redis-cli内で以下を実行します。
```
PING
```
期待結果:
```
PONG
```
ログ確認
```
npm run docker:logs
```
停止
```
npm run docker:down
```
## 初期化SQLを再実行したい場合
PostgreSQLのDocker volumeを削除して再作成します。
```
npm run docker:reset
```
注意: docker:reset はローカルDBデータを削除します。必要な検証データがある場合は実行前に退避してください。


## DB マイグレーション（Prisma + pgvector）

RAG 基盤の DB スキーマは Prisma で管理します。正本設計書は `docs/design_and_RD/05_DB_ER設計書.md` です。

### 環境変数

`apps/api/.env` に DB 接続情報を記入します（`apps/api/.env.example` をコピー）。

```bash
cp apps/api/.env.example apps/api/.env
```

`DATABASE_URL` / `DIRECT_URL` は `?schema=public` を使います。pgvector 拡張は `public`
に常駐し、`vector` 型・演算子が search_path に解決されるためです（`$queryRaw` の ANN 検索に必須）。
`order_permission` の一次防御は DB ロールの GRANT 物理遮断であり、schema 分離には依存しません
（05 §2.4.3 / §12.1）。

### 初回マイグレーション適用

DB（docker postgres）が起動している状態で実行します。

```bash
npm run docker:up        # postgres（pgvector 同梱）+ redis を起動
npm run db:migrate:deploy # prisma migrate deploy（既存マイグレーションを適用）
npm run db:generate      # Prisma Client を生成（build/typecheck で自動実行されない場合）
```

新しいマイグレーションを作成する場合（スキーマ変更時）:

```bash
npm run db:migrate       # prisma migrate dev（差分マイグレーション生成 + 適用）
npm run db:migrate:status # 適用状況を確認
```

### Prisma で表現できない制約（raw SQL 管理）

以下は `prisma/migrations/00000000000000_init/migration.sql` 内の「[B] raw SQL 制約」
セクションで管理しています（schema.prisma にはコメントで存在を明記 / 05 §9.4）。

- pgvector 拡張 + `embedding` 列の dimension 整合 `CHECK(vector_dims(embedding)=dimension)`（B6）
- HNSW 部分式 index（provider/model/dimension 別 / 新 embedding model 採用時は 1 行追加 / 05 §7.3）
- 部分 unique（`WHERE idempotency_key IS NOT NULL` / 二重課金・二重実行の物理遮断 / B1）
- 複合 FK `rag_citations(retrieval_result_id, chunk_id) -> rag_retrieval_results(id, chunk_id)`
  による citation whitelist 物理強制（捏造 citation を INSERT 不能にする / B2）
- `order_permission = false` の二次防御 `CHECK`（B3）/ スコア値域 `CHECK(0..1)`

スキーマ変更で新しい部分 unique・複合 FK・vector index を追加する場合は、`prisma migrate dev`
が生成した `migration.sql` に手動で raw SQL を追記してください（Prisma は再生成しません）。

### enum SSoT

`source_type` / `query_type` / `BotSignal` / `risk_level` / 各 status は
`packages/shared/src/rag-enums.ts` に `as const` + Zod schema で 1 箇所定義します。
DB 側は `varchar` 保持です。値リテラルを各所で再宣言しないでください。


## 開発起動
```
npm run dev
```
Health check:
```
curl http://localhost:3000/health
```

## CI
このリポジトリでは、Pull Request作成時とmainブランチへのpush時にGitHub ActionsでCIを実行します。

CIで実行するコマンド:
```bash
npm run typecheck
npm run lint
npm run test
npm run build
```
CIではSecret / API Key / JWTを使用しません。
.env、.env.*はコミット対象外です。


`.gitignore`では`.env`と`.env.*`が除外され、`.env.example`だけ許可されています。:contentReference[oaicite:8]{index=8}


## GitHub Issue運用
- Issue単位でbranchを切る
- PRはIssueに紐づける
- typecheck / lint / test / build を通してからレビューに出す

Branch例:
```
feature/gh-001-repository-setup
```

## Ingestion（ローカル CLI 経由）

ドキュメント取込・embedding 生成は Vercel に載せず、ローカル CLI で実行する（Phase 4）。

```bash
# 通常実行（.md / .txt をディレクトリ再帰取込）
npm run ingest -- ./docs/strategy --source-type strategy_doc

# 課金ゼロ・DB 書込ゼロでの事前検証
npm run ingest -- ./docs/strategy --dry-run
```

- 既存 `IngestionService`（claim-first / content_hash 差分 / 1 文書 1 トランザクション）を Nest standalone context で再利用
- DIRECT_URL があれば DATABASE_URL を自動上書きし、Neon の Direct 接続経由で書き込む
- 同一入力の再実行は冪等 replay（embedding 課金ゼロ / DB 書込ゼロ）
- 詳細手順・容量監視・トラブルシュート: [`docs/operations/ingestion-runbook.md`](docs/operations/ingestion-runbook.md)

## PTP 側切替（cutover）

PTP（Personal Multi Trading Platform）側 RAG クライアントの参照先を、ローカル docker から
Vercel Production URL へ切り替える手順は [`docs/operations/ptp-client-cutover.md`](docs/operations/ptp-client-cutover.md) を参照してください。

- env 変更 / クライアントコード調整 / 疎通確認 / 切り戻しまでを単独完走できる手順書
- 疎通確認は [`docs/operations/cutover-smoke-test.sh`](docs/operations/cutover-smoke-test.sh) を使用（既定は read-only / LLM 課金ゼロ）
- LLM 経路まで end-to-end で確認したい場合は `--with-query` フラグ（24h 内の再実行は replay = 再課金なし）

```bash
# read-only（LLM 課金ゼロ / 何度でも気軽に再実行可）
bash docs/operations/cutover-smoke-test.sh

# LLM 経路まで（固定 Idempotency-Key で replay）
bash docs/operations/cutover-smoke-test.sh --with-query
```

## 設計書

| 文書 | パス | 対応Issue |
|---|---|---|
| WBS・GitHub Issue管理設計書 | `docs/design_and_RD/20_WBS・GitHub Issue管理設計書.md` | GH-006 |
| DB・ER設計書 | `docs/design_and_RD/05_DB_ER設計書.md` | GH-008 |
| DB設計Issue分解 | `docs/design_and_RD/20_WBS・GitHub Issue管理設計書.md` | GH-008 |