# Runbook — Training Bot RAG Hub MVP

立ち上げ・利用・運用の実務マニュアル。README が基礎（構成・セットアップ・DB マイグレーション）を、設計書（`docs/design_and_RD/`）が契約と設計判断を扱うのに対し、本書は **「動かす・叩く・整える」** の手順を一本化する。

- **対象読者**: 開発者（ふみ）、PTP 等の消費側ボット実装者、運用担当
- **対象環境**: ローカル開発（macOS + Docker）。Phase 2 以降の本番運用（k8s / managed Postgres 等）は対象外
- **MVP スコープ**: 4 endpoint（query / bot-context / similar-cases / history）+ 内部 4 source_type の取込 + OpenAI Provider のみ

---

## 0. 前提と最重要原則

- Node.js 22 / npm / Docker（Colima 可）
- ports: postgres `5433` / redis `6380` / API `3000`
- リポジトリルート: `/Volumes/DevShare/projects/training-bot-rga-hub`
- **RAG は判断材料を返すだけ**: 注文しない / Bot 設定を変えない / 緊急停止を解除しない（コード + DB ロール + CHECK 制約の三層防御）
- **コミットは feature ブランチで作業 → PR → squash merge**（main 直接 commit 禁止）

---

## 1. クイックスタート（0 → 動く API まで）

初回または完全リセット後の最短手順。コピペで動く。

```bash
cd /Volumes/DevShare/projects/training-bot-rga-hub

# 1. 依存インストール
npm ci
npm ci --prefix packages/shared
npm ci --prefix apps/api

# 2. Docker（pgvector + redis）起動
npm run docker:up
npm run docker:ps          # postgres healthy / redis healthy を確認

# 3. 環境変数を用意
cp apps/api/.env.example apps/api/.env
# OPENAI_API_KEY は空のままで OK（テストは mock、実呼び出し時のみ必須）

# 4. Prisma client 生成 + マイグレーション適用
npm run db:generate
npm run db:migrate:deploy
npm run db:migrate:status  # "Database schema is up to date!" を確認

# 5. shared を build（apps/api は dist 参照）
npm --prefix packages/shared run build

# 6. 開発サーバ起動
npm run dev

# 別ターミナルでヘルスチェック
curl -s http://localhost:3000/health
# → { "status": "ok" }
```

ここまで通れば API は稼働。停止は dev サーバを Ctrl+C、Docker は `npm run docker:down`。

---

## 2. API を叩く（4 endpoint）

ベース URL: `http://localhost:3000/api/v1/rag`

### 共通仕様（10_API設計書 §3.4 / 横断規約 §3, §6）

- **POST は全て `Idempotency-Key` ヘッダ必須**（無いと 400）
  - 同一 key + 同一 payload → **200 replay**（LLM/embedding は再呼び出しされない）
  - 同一 key + 異なる payload → **409 RAG_IDEMPOTENCY_CONFLICT**
  - 同一 key + in-flight → **409**
- **`trace_id` はサーバ発行**（`X-Correlation-Id` を渡しても、内部 trace は別に発行され meta に併記される）
- **レスポンスは `{ data, meta: { trace_id, request_id, idempotency_replayed?, server_time } }` 構造**
- **金融数値は string**（client 側で number 化する場合は境界変換層で）
- **citation の excerpt は audience 別**: `client_type: ui` で含む / `client_type: training_bot` で省略

### 2.1 POST /rag/query — 一般質問

```bash
curl -X POST http://localhost:3000/api/v1/rag/query \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "query": "ETH の最近のボラティリティ傾向は？",
    "query_type": "GENERAL",
    "filters": {
      "symbol": "ETH-USDT",
      "timeframe": "1h",
      "top_k": 10
    },
    "client_type": "ui"
  }'
```

レスポンス（抜粋）:
```json
{
  "data": {
    "summary": "...",
    "citations": [
      { "chunk_id": "...", "retrieval_score": 0.82, "quality_status": "ACTIVE",
        "excerpt": "...", "event_time": "...", "ingested_at": "...", "used_reason": "..." }
    ],
    "risk_level": "MEDIUM",
    "confidence": 0.75,
    "trace_id": "..."
  },
  "meta": { "trace_id": "...", "request_id": "...", "idempotency_replayed": false }
}
```

`top_k` の上限は **50**（shared SSoT `MAX_TOP_K`）。超過すると 400。

### 2.2 POST /rag/bot-context — ボット文脈

PTP 等のボットが「今これを買おうとしている、判断材料をくれ」と聞く用。

```bash
curl -X POST http://localhost:3000/api/v1/rag/bot-context \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "bot_id": "btc-grid-v1",
    "strategy_id": "grid-001",
    "bot_signal": "BUY",
    "symbol": "BTC-USDT",
    "timeframe": "5m",
    "features": { "current_price": "65432.10", "rsi_14": "62.5" }
  }'
```

**`order_permission` は常に `false` 固定**（schema が `z.literal(false)` を強制 / DB CHECK 制約 / GuardRail で literal 上書き）。`action_policy` は `ORDER_NOT_ALLOWED_BY_RAG` で常に返る。これは **設計上の契約**であり、ボット側は受け取った値を信用してよい。

### 2.3 POST /rag/similar-cases — 過去の類似ケース

検索ベース（LLM 非経由）。`*_pct` は string で返る。

```bash
curl -X POST http://localhost:3000/api/v1/rag/similar-cases \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "context": { "symbol": "BTC-USDT", "timeframe": "1h" },
    "limit": 5
  }'
```

`limit` 上限 **100**。

### 2.4 GET /rag/history — 履歴

`Idempotency-Key` は不要（GET）。

```bash
curl -s "http://localhost:3000/api/v1/rag/history?page=1&limit=20&risk_level=HIGH"
```

ページネーション: `page` 1-indexed / `limit` 1-100 / `total` はフィルタ後の件数（Stage3 で修正済）。

### エラーモデル（10 §4）

すべて統一構造:
```json
{
  "error": {
    "code": "RAG_VALIDATION_ERROR",
    "message": "...",
    "details": [{ "field": "filters.top_k", "code": "OUT_OF_RANGE", "message": "..." }]
  },
  "meta": { "trace_id": "...", "request_id": "..." }
}
```

主要コード:
- `RAG_VALIDATION_ERROR` (400) — Zod / schema 違反
- `RAG_IDEMPOTENCY_CONFLICT` (409) — key 衝突 / in-flight
- `RAG_GUARDRAIL_BLOCKED` (422) — citation 全除去 / BLOCKED 状態
- `RAG_RATE_LIMITED` (429) — Retry-After 付き
- `RAG_INTERNAL_ERROR` (500)

---

## 3. テストを走らせる

```bash
# unit（OpenAI mock / DB 不要）
npm run test
# → shared 55 + apps/api 228 = 283 passed

# e2e（mock orchestrator / 配線確認）
npm run test:e2e
# → 30 passed

# DB 統合（実 pgvector / docker:up 必須）
cd apps/api && DATABASE_URL="postgresql://rag_user:rag_password_local_only@localhost:5433/rag_hub?schema=public" \
  npx jest --config ./test/jest-db-integration.json
# → 12 passed（複合FK / CHECK / 部分unique / vector_dims / HNSW Index Scan hard assert）
```

DB 統合は `DATABASE_URL` 未設定なら全件 skip、設定済みで接続不能なら **fail**（空虚 pass を構造的に禁止 / Stage4 修正）。

### typecheck / lint / build

```bash
npm run typecheck
npm run lint
npm run build
```

`typecheck` / `build` 前に `npm run db:generate` と `npm --prefix packages/shared run build` が前提（CI でも同順序）。

---

## 4. ボット側（PTP 等）からの利用パターン

設計書 `30_RAGサービスIF契約・疎結合境界定義書.md` を併読のこと。

### 4.1 疎結合の鉄則

- RAG は **別サービス / 別 DB ロール**（rag_app_user）として叩く前提
- PTP の DB ユーザーは `Order` / `Position` テーブルに GRANT が**無い RAG ロール**を使用してはいけない（一次防御）
- HTTP 越し（または将来 gRPC）。直接 DB アクセスは禁止
- 障害時の fallback: bot-context が落ちたら **`bot_signal: NONE` 相当**（取引見送り）に倒す。これも契約（30 §Bot fallback）

### 4.2 Idempotency-Key の発行

- ボット側で **`{bot_id}:{strategy_id}:{symbol}:{decision_minute}`** 等の決定的な ID を使うのが推奨（再送が自然に replay になる）
- UUID 都度発行は一過性のリトライ吸収にしか効かない
- in-flight 中の同キー再送は 409 が返る → ボット側は **wait + 元の応答を待つ** のが正しい挙動

### 4.3 trace_id の扱い

- ボット側ログには **レスポンスの `meta.trace_id`** を必ず記録
- ふみさん側で履歴を引く際にこれを起点にする
- `X-Correlation-Id` を渡すと監査ログに併記される（任意）

### 4.4 citation の使い方

- ボット側は `excerpt` を見ない（`client_type: training_bot` で省略される設計）
- 使うのは `chunk_id` / `retrieval_score` / `quality_status` / `event_time` のメタ情報
- `quality_status !== 'ACTIVE'` の citation は server 側で除去済（whitelist + 複合FK で物理強制）

---

## 5. 環境変数リファレンス

`apps/api/.env`（`.env.example` をコピー）:

| 変数 | 必須 | 用途 | 例 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Prisma 接続 / `?schema=public` 必須 | `postgresql://rag_user:rag_password_local_only@localhost:5433/rag_hub?schema=public` |
| `DIRECT_URL` | ✅ | Prisma migration 用（同値で可） | 同上 |
| `OPENAI_API_KEY` | △ | LLM/embedding の実呼び出し時のみ | 空でも DI 解決・テスト・mock は通る |
| `NODE_ENV` | — | 既定 `development` | `production` で本番モード（MVP 未使用） |
| `PORT` | — | 既定 `3000` | `parseInt` 経由のため文字列で OK |

`OPENAI_API_KEY` を実際に設定する場合は **`apps/api/.env` のみ**に書き、絶対に commit / Slack / ログに出さない（Secret masking guard が一次防御だが、入口で漏らさないのが本筋）。

実 SDK を使うときは `npm i openai --prefix apps/api` も必要（adapter が遅延 require / 未 install 時は明示エラー）。

---

## 6. 停止・再起動・データリセット

```bash
# 停止
# - dev サーバ: Ctrl+C
npm run docker:down                  # postgres + redis 停止（data volume は保持）

# 再起動
npm run docker:up && npm run dev

# データだけリセット（schema 含めて作り直す）
npm run docker:reset                 # ⚠️ rag_hub の全データ削除
npm run db:migrate:deploy            # マイグレーションを再適用

# Prisma client を作り直す（schema.prisma を変更したとき）
npm run db:generate

# shared dist を作り直す（packages/shared を変更したとき）
npm --prefix packages/shared run build
```

`docker:reset` は **ローカルの全テストデータが消える** ので、検証データがあれば事前に `pg_dump` 等で退避すること。

---

## 7. トラブルシュート（既知の罠）

| 症状 | 真因 | 対応 |
|---|---|---|
| `typecheck` で `Cannot find module '@pmtp/shared'` 大量発生 | `packages/shared/dist/` が未生成 | `npm --prefix packages/shared run build` を先に走らせる |
| `typecheck` で `@prisma/client` 関連エラー | `prisma generate` 未実行 | `npm run db:generate` を実行 |
| Postgres 接続失敗（ローカル） | docker 未起動 / port 5433 衝突 | `npm run docker:ps` / `lsof -i :5433` で衝突確認 |
| HNSW Index Scan が選ばれない | 少量データで planner が Seq Scan を優位と判断 | 設計仕様（1 万行未満では Seq Scan でも動作 / 05 §7.3）。実運用ボリュームでは自動で HNSW に切り替わる |
| `RAG_GUARDRAIL_BLOCKED` (422) が連発 | citation 全除去（whitelist 違反 or quality_status 不適格） | retrieval ログを `rag_retrieval_results` で確認、source の `reliability_score` / `status` を点検 |
| `RAG_IDEMPOTENCY_CONFLICT` (409) | 同一 key + 異なる payload、または in-flight | ボット側でキー命名規則を見直す（4.2 参照） |
| Migration 適用失敗（複合 FK / CHECK / 部分 unique） | 既存データが新制約に違反 | `docker:reset` で初期化、または手動で違反行を整理 |
| `prisma migrate dev` が raw SQL を再生成しない | Prisma が表現できない制約（pgvector / 複合 FK / 部分式 index）は手動管理 | `migration.sql` の `[B] raw SQL 制約` セクションに手動追記（README §189 参照） |
| OpenAI 実呼び出しで `openai package not found` | adapter が遅延 require している | `npm i openai --prefix apps/api` を実行 |
| CI で typecheck が落ちる | `prisma generate` / `shared build` が typecheck より前に走っていない | `.github/workflows/ci.yml` の該当 step を確認（MVP merge 時に追加済） |

ログ確認:
```bash
npm run docker:logs                  # postgres + redis
# dev サーバのログは npm run dev のターミナル
```

---

## 8. 運用上の注意

### 8.1 コスト

- **OpenAI 課金が発生するのは 4 endpoint の query / bot-context のみ**（similar-cases も embedding は走る）
- **冪等 replay は LLM/embedding を再呼び出ししない**（コスト抑制の主要設計）
- `top_k` の上限 50 は OpenAI コンテキスト窓と embedding コストの観点で設定
- 概算単価は `apps/api/src/modules/rag/infrastructure/providers/openai/openai-pricing.ts` 参照。`Prisma.Decimal` で計算（float 誤差なし）

### 8.2 セキュリティ・コンプライアンス

- `order_permission` 三層防御: コード literal false + LLM 出力 schema `z.literal(false)` + DB CHECK 制約 + DB ロール GRANT 不在（インフラ側で別途設定）
- secret masking: 送信前 + 保存前の 1 箇所で実施（`apps/api/src/guardrail/secret-masking.guard.ts`）。OpenAI/Anthropic key / JWT / Bearer / AWS / Google / GitHub / Slack / email / カード番号を検知
- prompt injection 一次検知: 取得文書のデリミタ隔離 + 命令文字列 regex 検知

### 8.3 現状の制約（MVP）

- **OpenAI のみ**（Claude / Gemini / Mistral は interface 拡張余地のみ / 実装は Phase 2）
- **内部 4 source_type のみ**: `bot_log` / `order_history` / `execution_history` / `strategy_doc` / `market_data`。`news` / `sns` / `polymarket` は Phase 2
- **provider_calls の永続は Noop**（Major7 / 裁定待ち）。history.service は `response_json.llm` へフォールバック
- **CI に DB 統合スイートが結線されていない**: ローカル手動実行のみ。`npm run test:db` + pg service job 追加は別チケット
- **`actions/checkout@v4` / `actions/setup-node@v4` は Node 20 deprecation あり**: 2026-09-16 までに `@v5` への更新が必要

### 8.4 観測（将来）

- 現状は dev サーバ標準出力 + Docker logs のみ
- 本番運用時は構造化ログ（trace_id / request_id をフィールド化）+ メトリクス（4 endpoint レイテンシ / OpenAI コスト累計 / guardrail BLOCK 率）を別チケットで導入

---

## 9. リファレンス

| 文書 | 場所 | 役割 |
|---|---|---|
| README | `README.md` | 構成・初期セットアップ・DB マイグレーション基礎 |
| 本書 (Runbook) | `docs/operations/runbook.md` | 立ち上げ・利用・運用フロー |
| DB ER 設計書 | `docs/design_and_RD/05_DB_ER設計書.md` | DB 正本（DDL / 制約 / index / 検索 SQL） |
| API 設計書 | `docs/design_and_RD/10_API設計・外部IF定義書.md` | API 契約正本（4 endpoint / Idempotency-Key / error model） |
| MVP 仕様書 | `docs/design_and_RD/16_MVP仕様書.md` | スコープ境界 |
| プロンプト設計書 | `docs/design_and_RD/21_プロンプト設計書.md` | LLM プロンプト構造 |
| Provider Policy | `docs/design_and_RD/24_Provider Policy設計書.md` | Provider 抽象 / fallback / 温度seed |
| Chunking 設計書 | `docs/design_and_RD/27_Chunking設計書.md` | source_type 別 chunking 戦略 |
| RAG IF 契約 | `docs/design_and_RD/30_RAGサービスIF契約・疎結合境界定義書.md` | 別サービス境界 / DB 物理遮断 / 消費側契約 |

---

## 改訂履歴

| 日付 | 改訂 | 出典 |
|---|---|---|
| 2026-06-10 | 初版 | MVP merge (#25) 直後 / Fable5 4 ラウンド ship 後 |
