# Runbook — Training Bot RAG Hub MVP

立ち上げ・利用・運用の実務マニュアル。README が基礎（構成・セットアップ・DB マイグレーション）を、設計書（`docs/design_and_RD/`）が契約と設計判断を扱うのに対し、本書は **「動かす・叩く・整える」** の手順を一本化する。

- **対象読者**: 開発者（ふみ）、PTP 等の消費側ボット実装者、運用担当
- **対象環境**: 本番 = Vercel Hobby + Neon Free（Postgres + pgvector） / 開発 = ローカル Docker
- **MVP スコープ**: 4 endpoint（query / bot-context / similar-cases / history）+ 内部 4 source_type の取込 + OpenAI Provider のみ

---

## 0. 前提と最重要原則

- Node.js 22 / npm
- **本番**: Vercel Functions（NestJS serverless）+ Neon（pgvector）/ Bearer Token 認証
- **開発**: macOS + Docker（Colima 可）/ ports postgres `5433` / API `3000`
- リポジトリルート: `/Volumes/DevShare/projects/training-bot-rga-hub`
- **RAG は判断材料を返すだけ**: 注文しない / Bot 設定を変えない / 緊急停止を解除しない（コード + DB ロール + CHECK 制約の三層防御）
- **コミットは feature ブランチで作業 → PR → squash merge**（main 直接 commit 禁止）
- **本番への deploy は main への push で Vercel が自動実行**

---

## 0.5 環境トポロジ

```
[本番 / production]
  https://<vercel-project>.vercel.app
    ├─ Vercel Functions (NestJS serverless / iad1 region)
    └─ Neon Postgres + pgvector (AWS US East 1 / Pooler URL 経由)
    認証: Authorization: Bearer ${API_BEARER_TOKEN}（必須）

[プレビュー / preview]
  https://<branch-name>-<vercel-project>.vercel.app
    ├─ feature ブランチを push する度に自動生成
    ├─ Vercel Authentication (Standard Protection) が外側にかかる
    └─ DB は本番と同じ Neon（または PR 専用 branch / 任意）

[開発 / local]
  http://localhost:3000
    ├─ npm run dev（NestJS dev server）
    └─ Docker postgres + pgvector (port 5433)
    認証: API_BEARER_TOKEN 未設定なら全エンドポイント 503（fail-closed）
```

3 環境で **同じコードベース**が動く。違いは「どこの DB を見るか」と「外側ロックの有無」だけ。

---

## 1. クイックスタート（API を叩く / consumer 向け）

PTP 等から training-bot-rag-hub を叩く場合の最短手順。

```bash
# 1. 環境変数を準備
export BASE_URL=https://<your-vercel-project>.vercel.app
export API_BEARER_TOKEN=<取得済みのトークン>

# 2. ヘルスチェック
curl -s "$BASE_URL/health" \
  -H "Authorization: Bearer $API_BEARER_TOKEN"
# → { "status": "ok" }

# 3. RAG クエリ（一般質問）
curl -s "$BASE_URL/api/v1/rag/query" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "query": "ETH の最近のボラティリティ傾向は？",
    "query_type": "GENERAL",
    "filters": { "symbol": "ETH-USDT", "timeframe": "1h", "top_k": 10 },
    "client_type": "ui"
  }'
```

`API_BEARER_TOKEN` の取得 / ローテーション手順は [vercel-deploy.md](./vercel-deploy.md) §3 を参照。

---

## 2. API を叩く（4 endpoint）

ベース URL: `${BASE_URL}/api/v1/rag`（本番 = Vercel URL / 開発 = `http://localhost:3000`）

### 共通仕様（10_API設計書 §3.4 / 横断規約 §3, §6）

- **`Authorization: Bearer ${API_BEARER_TOKEN}` ヘッダ必須**（本番）
  - 未付与 / 不正トークン → **401 RAG_UNAUTHORIZED**（JSON）
  - `API_BEARER_TOKEN` env 未設定（運用ミス）→ **503**（fail-closed / smoke-test T6 でも検出可）
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
curl -X POST "$BASE_URL/api/v1/rag/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "query": "ETH の最近のボラティリティ傾向は？",
    "query_type": "GENERAL",
    "filters": { "symbol": "ETH-USDT", "timeframe": "1h", "top_k": 10 },
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
curl -X POST "$BASE_URL/api/v1/rag/bot-context" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
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
curl -X POST "$BASE_URL/api/v1/rag/similar-cases" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
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
curl -s "$BASE_URL/api/v1/rag/history?page=1&limit=20&risk_level=HIGH" \
  -H "Authorization: Bearer $API_BEARER_TOKEN"
```

ページネーション: `page` 1-indexed / `limit` 1-100 / `total` はフィルタ後の件数（Stage3 で修正済）。

### エラーモデル（10 §4）

すべて統一構造:
```json
{
  "success": false,
  "error": {
    "code": "RAG_VALIDATION_ERROR",
    "message": "...",
    "details": [{ "field": "filters.top_k", "code": "OUT_OF_RANGE", "message": "..." }]
  },
  "meta": { "trace_id": "...", "request_id": "...", "timestamp": "..." }
}
```

主要コード:
- `RAG_UNAUTHORIZED` (401) — Bearer Token 未付与 / 不正
- `RAG_VALIDATION_ERROR` (400) — Zod / schema 違反
- `RAG_IDEMPOTENCY_CONFLICT` (409) — key 衝突 / in-flight
- `RAG_GUARDRAIL_BLOCKED` (422) — citation 全除去 / BLOCKED 状態
- `RAG_RATE_LIMITED` (429) — Retry-After 付き
- `RAG_INTERNAL_ERROR` (500 / 503) — env 不備の場合 503（fail-closed）

---

## 3. ローカル開発環境

本番は Vercel に乗っているが、コード変更時のローカル動作確認のために Docker 環境は残してある。

### 3.1 初回セットアップ

```bash
cd /Volumes/DevShare/projects/training-bot-rga-hub

# 1. 依存インストール（ローカルディスクで実行 / SMB 並列 install 禁止）
npm install --prefix packages/shared
npm --prefix packages/shared run build
npm install --prefix apps/api

# 2. Docker（pgvector）起動 — Redis は使わないため compose から削除済
npm run docker:up
npm run docker:ps          # postgres healthy を確認

# 3. 環境変数を用意
cp apps/api/.env.example apps/api/.env
# DATABASE_URL / DIRECT_URL は docker-compose 用のローカル値を使う
# API_BEARER_TOKEN は任意の値（例: openssl rand -hex 32）を設定
# OPENAI_API_KEY は空のままで OK（mock テスト時 / 実呼び出し時のみ必須）

# 4. Prisma client 生成 + マイグレーション適用
npm run db:generate
npm run db:migrate:deploy
npm run db:migrate:status  # "Database schema is up to date!" を確認

# 5. 開発サーバ起動
npm run dev

# 別ターミナルでヘルスチェック
curl -s http://localhost:3000/health -H "Authorization: Bearer $API_BEARER_TOKEN"
# → { "status": "ok" }
```

停止は dev サーバ Ctrl+C、Docker は `npm run docker:down`。

### 3.2 ローカルから Neon を参照する（任意）

Docker postgres ではなく本番 Neon に直接繋いでローカル dev サーバを動かすこともできる（Neon の compute hours が消費される）。

```bash
# .env を Neon 用に書き換え
# DATABASE_URL = Pooler URL（?pgbouncer=true&connection_limit=1&...）
# DIRECT_URL = Direct URL

npm run dev
```

注意: Neon Free は 500MB ストレージ + 100 CU-hours/月。開発と本番を同じ DB に向けると本番データを上書きするリスクがあるため、**通常はローカル Docker 推奨**。

---

## 4. テストを走らせる

```bash
# unit（OpenAI mock / DB 不要）
npm run test
# → shared 55 + apps/api 228+ = 283+ passed

# e2e（mock orchestrator / 配線確認）
npm run test:e2e

# DB 統合（実 pgvector / docker:up 必須）
cd apps/api && DATABASE_URL="postgresql://rag_user:rag_password_local_only@localhost:5433/rag_hub?schema=public" \
  npx jest --config ./test/jest-db-integration.json
```

DB 統合は `DATABASE_URL` 未設定なら全件 skip、設定済みで接続不能なら **fail**（空虚 pass を構造的に禁止）。

### typecheck / lint / build

```bash
npm run typecheck
npm run lint
npm run build
```

`typecheck` / `build` 前に `npm run db:generate` と `npm --prefix packages/shared run build` が前提（Vercel 側でも postinstall で同順序を強制）。

---

## 5. デプロイサイクル

### 5.1 通常フロー

```bash
# 1. feature ブランチを切る
git checkout -b feat/SOMETHING

# 2. 実装 → commit
git add . && git commit -m "feat: ..."

# 3. push（→ Vercel が preview を自動 deploy）
git push -u origin feat/SOMETHING
# Vercel ダッシュボードで <branch>-<project>.vercel.app の URL が確認できる
# preview は Vercel Authentication で保護される（ログイン必須）

# 4. PR 作成 + レビュー
gh pr create

# 5. main へ squash merge（→ Vercel が production を自動 deploy）
gh pr merge --squash --delete-branch
```

production deploy が完了したら必ず smoke-test を回す（[smoke-test.md](./smoke-test.md)）。

### 5.2 ロールバック

```bash
# Vercel ダッシュボード → Deployments → 戻したい deployment → "Promote to Production"
# または vercel CLI:
vercel rollback <deployment-url>
```

DB migration が含まれる変更を rollback する場合、**Prisma migration の down は対応していない** ため手動で revert する。詳細は [neon-setup.md](./neon-setup.md) §7。

### 5.3 環境変数の追加・変更

Vercel ダッシュボード → Settings → Environment Variables から追加 → 反映には **再 deploy が必要**（既存の deployment は古い env のまま動く）。

---

## 6. ボット側（PTP 等）からの利用パターン

設計書 `30_RAGサービスIF契約・疎結合境界定義書.md` を併読のこと。

### 6.1 疎結合の鉄則

- RAG は **別サービス / 別 DB ロール**（rag_app_user）として叩く前提
- PTP の DB ユーザーは `Order` / `Position` テーブルに GRANT が**無い RAG ロール**を使用してはいけない（一次防御）
- **HTTP 越しのみ**（`BASE_URL` + Bearer Token）。直接 DB アクセスは禁止
- 障害時の fallback: bot-context が落ちたら **`bot_signal: NONE` 相当**（取引見送り）に倒す。これも契約（30 §Bot fallback）
- Vercel cold start / Neon autosuspend からの復帰で初回リクエストが 1〜3 秒遅延する可能性。タイムアウトは **最低 10 秒** を推奨

### 6.2 Idempotency-Key の発行

- ボット側で **`{bot_id}:{strategy_id}:{symbol}:{decision_minute}`** 等の決定的な ID を使うのが推奨（再送が自然に replay になる）
- UUID 都度発行は一過性のリトライ吸収にしか効かない
- in-flight 中の同キー再送は 409 が返る → ボット側は **wait + 元の応答を待つ** のが正しい挙動

### 6.3 trace_id の扱い

- ボット側ログには **レスポンスの `meta.trace_id`** を必ず記録
- ふみさん側で履歴を引く際にこれを起点にする
- `X-Correlation-Id` を渡すと監査ログに併記される（任意）

### 6.4 citation の使い方

- ボット側は `excerpt` を見ない（`client_type: training_bot` で省略される設計）
- 使うのは `chunk_id` / `retrieval_score` / `quality_status` / `event_time` のメタ情報
- `quality_status !== 'ACTIVE'` の citation は server 側で除去済（whitelist + 複合FK で物理強制）

### 6.5 切替手順

PTP 側のクライアント実装で training-bot-rag-hub の URL を切り替える際は [ptp-client-cutover.md](./ptp-client-cutover.md) を参照。

---

## 7. 環境変数リファレンス

### 7.1 本番（Vercel ダッシュボード → Environment Variables）

| 変数 | 必須 | 用途 | 値の例 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Prisma 実行時接続（Neon Pooler URL）| `postgresql://...neon.tech/...?pgbouncer=true&connection_limit=1&sslmode=require&schema=public` |
| `DIRECT_URL` | ✅ | Prisma migration 用（Neon Direct URL）| `postgresql://...neon.tech/...?sslmode=require&schema=public` |
| `API_BEARER_TOKEN` | ✅ | 全 endpoint の認証ヘッダ照合 | `openssl rand -hex 32` で生成した 64 文字 hex |
| `OPENAI_API_KEY` | ✅ | LLM/embedding | `sk-...` |
| `NODE_ENV` | — | Vercel が自動で `production` に設定 | — |

ローテーション手順は [vercel-deploy.md](./vercel-deploy.md) §3-4。

### 7.2 開発（`apps/api/.env`）

| 変数 | 必須 | 用途 | 例 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | docker postgres 接続 | `postgresql://rag_user:rag_password_local_only@localhost:5433/rag_hub?schema=public` |
| `DIRECT_URL` | ✅ | 同上（同値で可） | 同上 |
| `API_BEARER_TOKEN` | ✅ | fail-closed 防止のため何か設定する | 開発用の任意値 |
| `OPENAI_API_KEY` | △ | LLM/embedding の実呼び出し時のみ | 空でも DI 解決・テスト・mock は通る |
| `PORT` | — | 既定 `3000` | — |

`OPENAI_API_KEY` を実際に設定する場合は **`apps/api/.env` のみ**に書き、絶対に commit / Slack / ログに出さない（Secret masking guard が一次防御だが、入口で漏らさないのが本筋）。

実 SDK を使うときは `npm i openai --prefix apps/api` も必要（adapter が遅延 require / 未 install 時は明示エラー）。Vercel 側では package.json の依存に入れるか、ingestion CLI ローカル実行に閉じ込める。

---

## 8. 停止・再起動・データリセット

### 8.1 本番

```bash
# Vercel deployment を一時停止
# → ダッシュボード → Settings → Pause Deployment

# Neon Postgres を pause（手動）
# → Neon ダッシュボード → Project Settings → Pause Project
#    Free プランは 5 分 idle で自動 autosuspend されるため通常は不要

# 環境変数だけ無効化して全リクエスト 503 に倒す（緊急停止）
# → Vercel → Environment Variables から API_BEARER_TOKEN を削除 → 再 deploy
#    → fail-closed で全 endpoint 503 RAG_INTERNAL_ERROR
```

### 8.2 開発

```bash
# 停止
npm run docker:down                  # postgres 停止（data volume は保持）

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

### 8.3 Neon 側の手動リセット（本番 / 慎重に）

```bash
# Direct URL 経由で接続して TRUNCATE / DROP
psql "$DIRECT_URL" -c "TRUNCATE TABLE rag_xxx CASCADE;"

# schema 丸ごと作り直す場合（最終手段）
# 1. Neon ダッシュボードで新しい branch を作る（本番 branch を残したまま試せる）
# 2. 新 branch の Direct URL に対して migrate deploy
# 3. 動作確認後に primary branch を入れ替え
```

---

## 9. トラブルシュート（既知の罠）

### 9.1 本番（Vercel + Neon）

| 症状 | 真因 | 対応 |
|---|---|---|
| 全リクエスト 503 | `API_BEARER_TOKEN` 未設定（運用ミス） | Vercel env で設定 → 再 deploy（fail-closed 設計通り）|
| 401 RAG_UNAUTHORIZED | Authorization ヘッダ未付与 or トークン不一致 | クライアント側でヘッダ確認 / ローテーション後の env 差分確認 |
| 初回リクエストが 1〜3 秒遅い | Vercel cold start + Neon autosuspend 復帰 | 設計通り。タイムアウトを 10 秒以上に / 重要 endpoint は定期 ping で warm 化 |
| Vercel Function timeout (10s) | Hobby プランの制限 | クエリ最適化 / pgvector index 確認 / ingestion はローカル CLI に分離（既に分離済）|
| Neon 100 CU-hours/月 超過で停止 | compute 上限到達 | 必要なら Launch plan ($19) / 通常は autosuspend で十分届かない |
| Neon 0.5GB ストレージ満杯 | embedding 件数増加 | 古い chunk を archive / quality_status で絞り込み |
| MODULE_NOT_FOUND `@pmtp/shared` | postinstall が shared build を走らせていない | `apps/api/package.json` の postinstall を確認（shared install → build → prisma generate の順序） |
| Vercel deploy 失敗 `npm ci` lockfile mismatch | `apps/api/package-lock.json` に `@pmtp/shared` 未同期 | ローカルで `npm install --prefix apps/api` 実行 → lockfile diff を commit |

### 9.2 開発（ローカル Docker）

| 症状 | 真因 | 対応 |
|---|---|---|
| `typecheck` で `Cannot find module '@pmtp/shared'` 大量発生 | `packages/shared/dist/` が未生成 | `npm --prefix packages/shared run build` を先に走らせる |
| `typecheck` で `@prisma/client` 関連エラー | `prisma generate` 未実行 | `npm run db:generate` を実行 |
| Postgres 接続失敗 | docker 未起動 / port 5433 衝突 | `npm run docker:ps` / `lsof -i :5433` で衝突確認 |
| `npm run dev` が SMB I/O で落ちる | SMB マウント上の高頻度ファイル監視 | Vercel preview で動作確認するか、`~/projects/` 配下にコピーして動かす |
| HNSW Index Scan が選ばれない | 少量データで planner が Seq Scan を優位と判断 | 設計仕様（1 万行未満では Seq Scan でも動作 / 05 §7.3）。実運用ボリュームでは自動で HNSW に切り替わる |
| `RAG_GUARDRAIL_BLOCKED` (422) が連発 | citation 全除去（whitelist 違反 or quality_status 不適格） | retrieval ログを `rag_retrieval_results` で確認、source の `reliability_score` / `status` を点検 |
| `RAG_IDEMPOTENCY_CONFLICT` (409) | 同一 key + 異なる payload、または in-flight | ボット側でキー命名規則を見直す（6.2 参照） |
| Migration 適用失敗（複合 FK / CHECK / 部分 unique） | 既存データが新制約に違反 | `docker:reset` で初期化、または手動で違反行を整理 |
| OpenAI 実呼び出しで `openai package not found` | adapter が遅延 require している | `npm i openai --prefix apps/api` を実行 |

ログ確認:
```bash
# 本番（Vercel）
# → ダッシュボード → Deployments → 該当 deployment → Runtime Logs
# または vercel CLI:
vercel logs <deployment-url>

# 開発
npm run docker:logs                  # postgres
# dev サーバのログは npm run dev のターミナル
```

---

## 10. 運用上の注意

### 10.1 コスト

| 項目 | 月額 | 備考 |
|---|---|---|
| Vercel Hobby | ¥0 | 非商用個人運用 / Bandwidth 100GB/月 / Function 100GB-hour/月 |
| Neon Free | ¥0 | 0.5GB ストレージ / 100 CU-hours/月 / autosuspend |
| OpenAI API | 従量 | query / bot-context / similar-cases の embedding と LLM 呼び出し |
| **小計** | **¥0/月** | OpenAI 課金のみ |

- **OpenAI 課金が発生するのは 4 endpoint の query / bot-context のみ**（similar-cases も embedding は走る）
- **冪等 replay は LLM/embedding を再呼び出ししない**（コスト抑制の主要設計）
- `top_k` の上限 50 は OpenAI コンテキスト窓と embedding コストの観点で設定
- 概算単価は `apps/api/src/modules/rag/infrastructure/providers/openai/openai-pricing.ts` 参照。`Prisma.Decimal` で計算（float 誤差なし）

**有償化トリガー**:
- Vercel Bandwidth 100GB/月 超過 → Pro $20/月
- Neon ストレージ 0.5GB 超過 → Launch $19/月
- Neon compute 100 CU-hours/月 超過 → Launch $19/月
- 商用化（収益化）→ Vercel Hobby 規約上 Pro 必須

### 10.2 セキュリティ・コンプライアンス

- **Bearer Token 認証**: アプリ側の全 endpoint で必須。timingSafeEqual で照合（タイミング攻撃耐性）
- **Vercel Authentication (Standard Protection)**: Hobby プランでは preview deployments のみ保護。production は Bearer Token のみが防御層（個人運用の RAG では実用上十分）
- `order_permission` 三層防御: コード literal false + LLM 出力 schema `z.literal(false)` + DB CHECK 制約 + DB ロール GRANT 不在（インフラ側で別途設定）
- secret masking: 送信前 + 保存前の 1 箇所で実施（`apps/api/src/guardrail/secret-masking.guard.ts`）。OpenAI/Anthropic key / JWT / Bearer / AWS / Google / GitHub / Slack / email / カード番号を検知
- prompt injection 一次検知: 取得文書のデリミタ隔離 + 命令文字列 regex 検知
- HTTPS 強制（Vercel が自動 / strict-transport-security ヘッダ付与）

### 10.3 現状の制約（MVP）

- **OpenAI のみ**（Claude / Gemini / Mistral は interface 拡張余地のみ / 実装は Phase 2）
- **内部 4 source_type のみ**: `bot_log` / `order_history` / `execution_history` / `strategy_doc` / `market_data`。`news` / `sns` / `polymarket` は Phase 2
- **provider_calls の永続は Noop**（Major7 / 裁定待ち）。history.service は `response_json.llm` へフォールバック
- **CI に DB 統合スイートが結線されていない**: ローカル手動実行のみ。`npm run test:db` + pg service job 追加は別チケット
- **Vercel Function timeout 10s**: 長時間処理は ingestion CLI に分離済（[ingestion-runbook.md](./ingestion-runbook.md)）
- **`actions/checkout@v4` / `actions/setup-node@v4` は Node 20 deprecation あり**: 2026-09-16 までに `@v5` への更新が必要

### 10.4 観測

- **Vercel Runtime Logs**: ダッシュボード or `vercel logs` で 1 時間遡れる（Hobby 上限）
- **Neon Monitoring**: ダッシュボード → Monitoring で compute usage / storage を確認
- 構造化ログ（trace_id / request_id をフィールド化）+ メトリクス（4 endpoint レイテンシ / OpenAI コスト累計 / guardrail BLOCK 率）は別チケットで導入

### 10.5 RAG ingestion

ドキュメント取り込み・embedding 生成は **ローカル CLI から Neon Direct URL 経由で実行**（Vercel Function timeout 10s 制約を避けるため）。

詳細は [ingestion-runbook.md](./ingestion-runbook.md)。

```bash
npm run ingest -- --source <path-or-dir>
```

---

## 11. リファレンス

| 文書 | 場所 | 役割 |
|---|---|---|
| README | `README.md` | 構成・初期セットアップ・DB マイグレーション基礎 |
| 本書 (Runbook) | `docs/operations/runbook.md` | 立ち上げ・利用・運用フロー（Vercel + Neon）|
| Neon Setup | `docs/operations/neon-setup.md` | Neon プロジェクト作成 → pgvector → migrate deploy 手順 |
| Vercel Deploy | `docs/operations/vercel-deploy.md` | Vercel プロジェクト作成 → 環境変数 → 初回 deploy → smoke-test |
| Smoke Test | `docs/operations/smoke-test.md` | deploy 後の疎通確認スクリプト + curl コマンド一式 |
| Ingestion Runbook | `docs/operations/ingestion-runbook.md` | ローカル CLI からの embedding ingestion 運用 |
| PTP Cutover | `docs/operations/ptp-client-cutover.md` | PTP 側で URL を切り替える指示書 |
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
| 2026-06-10 | 初版（ローカル Docker 運用前提）| MVP merge (#25) 直後 / Fable5 4 ラウンド ship 後 |
| 2026-06-11 | Vercel + Neon 運用へ全面改訂 | SMB I/O 不安定問題を受けた Vercel + Neon 移行ワークフロー完了 / Bearer Token 認証 / 環境トポロジ 3 層化 / ingestion CLI 分離 |
