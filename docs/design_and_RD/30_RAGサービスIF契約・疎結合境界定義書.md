---
title: RAGサービスIF契約・疎結合境界定義書
version: "1.0"
created: 2026-06-10
source: ai:claude-code
status: 正本（サービス境界・IF契約に関する Single Source of Truth）
related-docs:
  - 04_非要件機能定義書.md
  - 05_DB_ER設計書.md
  - 06_アーキテクチャ図.md
  - 07_アーキテクチャ設計書.md
  - 09_インフラ設計書.md
  - 10_API設計・外部IF定義書.md
---

# 30. RAGサービスIF契約・疎結合境界定義書

---

# 1. 位置づけ・目的

本書は Training Bot RAG Hub（以下 RAG サービス）を Personal Multi Trading Platform（以下 PTP）から切り離した **「別サービス（疎結合の汎用モジュール）」として定義する正本** である。

- **サービス境界（デプロイ境界 / DB 権限境界 / 通信境界）に関して、本書は 06 / 07 / 09 / 10 より優先する**。既存文書と本書が矛盾する場合、本書の記述を正とし、既存文書側を本書へ追従修正する（修正対象は §10 に列挙）。
- RAG サービスの出力は Training Bot の学習・検証を通じて **金銭判断に影響しうる**。そのため本書の契約は「便利な API 仕様」ではなく **安全境界の定義** として扱い、変更には本書の version 更新を必須とする。
- 本書のスコープ: デプロイ境界 / DB 物理遮断 / PTP→RAG 呼び出し契約（冪等性・トレーサビリティ・金融数値型）/ Bot 側フォールバック契約 / `order_permission` 消費側契約 / マルチテナント方針 / Phase 2 送り整合。
- スコープ外: コスト単価（03 / 仮置きのまま触らない）、RAG 品質評価基盤の設計（Phase 2 / §9）、05↔27 の DDL 一本化の実編集（別作業 / 統合スキーマ正本仕様に従う）。

---

# 2. デプロイ境界 — RAG は別プロセス・別サービス

## 2.1 確定構成

RAG サービスは **独立した NestJS アプリケーション**（`rag-api` + `rag-worker` の 2 コンテナ / 09 §4.1-4.2 の通り）として動作する。PTP backend への NestJS Module としての組み込み（`import RagModule`）を **禁止** する。

```text
[PTP リポジトリ / Trading Engine プロセス]        [training-bot-rga-hub リポジトリ / RAG サービス]
  trading-engine (NestJS)                          rag-api (NestJS, port 3000)
  order-service                                    rag-worker (NestJS)
  bot-runtime ──HTTP/JSON─────────────────────▶     └ DB 接続ユーザー: rag_app_user / rag_worker_user
      │                                            postgres（rag スキーマ）
      └ DB 接続ユーザー: pmtp_app（取引系）          redis（RAG 専用 instance または DB 番号分離）
```

確定ルール:

1. **別リポジトリ・別プロセス・別コンテナ**。PTP→RAG の通信はネットワーク経由の HTTP のみ（§4）。共有メモリ・同一プロセス DI・PTP からの RAG DB 直接参照（およびその逆）のいずれも禁止。
2. 04 NFR-MNT-002（「RAG Module から Order Module への依存禁止 / import boundary test で検出」）は、別リポジトリ・別プロセス化により「**import 自体が物理的に不可能**」へ格上げされる。boundary test は防御の冗長層として維持。
3. DB 分離は **同一 PostgreSQL インスタンス内のスキーマ分離（`rag` スキーマ）+ 接続ユーザー分離** を MVP 採用（09 の Low Cost MVP 方針と両立。コンテナを増やさない）。RAG が触れるのは 07 §9.1 の `rag_*` 14 テーブルのみ。
4. 09 §5.1 の「Order Service 接続: 原則禁止」は「**禁止**（"原則" の語を削除）」へ強化する。

## 2.2 同一プロセス同居を禁止する理由

| リスク | 同居時に起きること |
|---|---|
| **OOM の波及** | Embedding 生成・大量チャンクのロード・LLM レスポンス保持で RAG 側がメモリを食い潰すと、同一プロセスの注文系（Order Service / Trading Engine）が OOM Kill に巻き込まれ、**ポジション保有中に注文制御不能** になる |
| **DB コネクション枯渇の波及** | RAG の ingestion / indexing バーストがコネクションプールを占有すると、注文系のコミットが待たされる。プール分離（別ユーザー・別プール上限）はプロセス分離が前提 |
| **デプロイ・障害の連動** | RAG 側の更新・クラッシュループが取引系の再起動を誘発する。07 §17.2 の Fail Safe 方針「RAG が失敗しても注文系は止めない」は別プロセスでないと構造的に守れない |
| **権限境界の崩壊** | 同一プロセスは同一 DB 接続情報を共有しがちで、§3 の DB ロール物理遮断が形骸化する |

## 2.3 既存文書の矛盾点（修正指示）

| 箇所 | 現状 | 裁定 |
|---|---|---|
| 07 §5.1（物理アーキテクチャ図 / `pmtp-backend └── NestJS RAG Module`） | RAG が PTP backend と同一プロセス同居 | **本書違反。09 §4.2 の rag-api / rag-worker 独立コンテナ構成を正とし、07 §5.1 を修正する** |
| 09 §4.2（postgres コンテナ `POSTGRES_USER: pmtp_app`） | RAG サービスが pmtp_app で接続 | §3.2 の `rag_app_user` / `rag_worker_user` へ置換 |
| 09 §5.1 L195（Order Service 接続: 原則禁止） | 「原則」付き | 「禁止」へ強化 |

---

# 3. DB 物理遮断（一次防御）— order_permission 安全境界の土台

## 3.1 方針

`order_permission` の遮断は **DB ロール物理遮断を一次防御** とする。RAG サービス用 DB ユーザーには PTP 側 Order / Execution / Position / Credential 系テーブルへの GRANT を **一切付与しない**（SELECT すら不可）。

- コード側の `order_permission: false` literal 強制（04 NFR-SAFE-002 / `z.literal(false)`、05 の `check (order_permission = false)`）は **二次防御としてそのまま維持** する（既存の良い設計を壊さない）。
- 09 §6.3 の現行ユーザー設計（`pmtp_app` / `pmtp_worker` / `pmtp_readonly` / `pmtp_admin`、「Order 系 DB への**書き込み**権限を付与しない」）は **「書込のみ禁止」になっており不十分**。本節の GRANT 設計で置換する。

## 3.2 GRANT 設計（正本 DDL）

```sql
-- 対象スキーマ: rag
--   rag スキーマの全テーブル（一覧の正本は 05 §5 / 全 21 テーブル）。
--   ここでは抜粋列挙せず schema 単位で GRANT する（テーブル追加時の付与漏れ防止）。

-- ★正本化 2026-06-10（B7 / ロール SSoT）: ロール名・構成の正本は 05 §12.1。
--   本節はそれと一致させる（4 ロール / `*_user` 接尾辞）。
CREATE ROLE rag_app_user      LOGIN PASSWORD '...';   -- rag-api 用
CREATE ROLE rag_worker_user   LOGIN PASSWORD '...';   -- rag-worker 用
CREATE ROLE rag_readonly_user LOGIN PASSWORD '...';   -- 分析・運用調査（Bot の DB 直接接続は禁止 / §2.1。Bot は HTTP API のみ）
CREATE ROLE rag_admin_user    LOGIN PASSWORD '...';   -- migration 専用（CI / 手動のみ。常駐プロセスは使用禁止）

-- rag スキーマのみ許可
GRANT USAGE ON SCHEMA rag TO rag_app_user, rag_worker_user, rag_readonly_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA rag TO rag_app_user, rag_worker_user;
GRANT SELECT ON ALL TABLES IN SCHEMA rag TO rag_readonly_user;  -- 分析用 read-only
ALTER DEFAULT PRIVILEGES IN SCHEMA rag
  GRANT SELECT, INSERT, UPDATE ON TABLES TO rag_app_user, rag_worker_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA rag
  GRANT SELECT ON TABLES TO rag_readonly_user;
-- DELETE は誰にも付与しない（論理削除のみ / rag_admin_user の maintenance を除く）

-- 取引系スキーマ（orders / executions / positions / bots / risk_limits / credentials 等 PTP 側）
-- への GRANT は一切発行しない。= REVOKE 運用ではなく「付与しない」が正。
-- さらに防御として（PTP 側テーブルが public スキーマにある場合の保険）:
REVOKE ALL ON SCHEMA public FROM rag_app_user, rag_worker_user, rag_readonly_user;

-- DELETE / TRUNCATE / DDL も rag_app_user / rag_worker_user には付与しない
-- （論理削除 deleted_at 運用のため UPDATE で足りる）
```

旧ユーザー名との対応: `pmtp_app`→`rag_app_user`、`pmtp_worker`→`rag_worker_user`、`pmtp_admin`→`rag_admin_user`、`pmtp_readonly`→`rag_readonly_user`（SELECT only / 分析・運用調査用。Bot の DB 直接接続は §2.1 で禁止）。

## 3.3 受け入れ基準（CI 自動検証）

| # | 検証 | 期待結果 |
|---|---|---|
| 1 | `psql -U rag_app_user -c "SELECT 1 FROM orders LIMIT 1"` | **permission denied**（CI で恒常実行） |
| 2 | `SELECT * FROM information_schema.role_table_grants WHERE grantee LIKE 'rag_%' AND table_schema <> 'rag';` | **0 rows**（rag_* ロールが rag スキーマ外の権限を 1 件も持たない） |
| 3 | `rag_app_user` / `rag_worker_user` での `DELETE` / `TRUNCATE` / DDL | すべて permission denied |
| 4 | 05 の `check (order_permission = false)`（rag_responses / rag_bot_contexts） | 無傷で存在（二次防御の維持確認） |

04 NFR-SAFE-001 / NFR-SEC-006 の受け入れ基準に「**DB GRANT レベルで SELECT 不可**」を追記する（§10）。

---

# 4. PTP→RAG 呼び出し契約

## 4.1 プロトコル

- **基本: HTTP/1.1 + JSON（REST）**。10 §3 の共通仕様をベースに維持する。
- Base URL: `http://rag-api:3000/api/v1/rag`（Docker network 内 service name 解決）。`localhost:3000` 直書きは compose service 名へ修正。
- **gRPC は Phase 2 オプション**。`/rag/bot-context`（04 NFR-PERF-002: 5 秒目標 / 10 秒上限）が実測で目標を割り込めない場合にのみ検討する。参考スケッチ（本タスクでは proto ファイルを作らない）:

```protobuf
// Phase 2 検討用スケッチ（非正本）
service RagDecisionContext {
  rpc GetDecisionContext (DecisionContextRequest) returns (DecisionContextResponse);
}
message DecisionContextRequest {
  string client_id = 1;          // generic 呼び出し主体 ID
  string idempotency_key = 2;    // ボット採番（必須）
  string symbol = 3;
  string timeframe = 4;
  string signal = 5;             // BUY / SELL / NEUTRAL
  map<string, string> features = 6;  // 金融数値は string（"0.012" 等）
}
message DecisionContextResponse {
  string trace_id = 1;           // サーバ発行
  string request_id = 2;         // サーバ発行（実行ごと）
  string explanation = 3;
  string risk_level = 4;
  double confidence = 5;         // スコア（非金融数値）
  bool order_permission = 6;     // 常に false
}
```

## 4.2 共通リクエストヘッダ（10 §3.3 の置換）

```http
Authorization: Bearer {jwt}
Content-Type: application/json
Idempotency-Key: {ボット採番キー}        # 全 POST 必須（§4.4）
X-Correlation-Id: {呼出側の相関ID}       # 任意。旧 X-Trace-Id を置換
X-Client-Type: ui | training_bot | system | worker
```

**`X-Trace-Id` ヘッダは廃止**する。trace_id はサーバ発行であり（§4.5）、クライアントが指定できるヘッダ名を残すと偽装・衝突の入口になる。呼出側が相関 ID を持つ場合は `X-Correlation-Id` で渡し、RAG は監査ログに correlation として併記する（trace_id 自体は常に RAG が新規発行）。

## 4.3 共通レスポンス meta（10 §3.4 の拡張）

```json
"meta": {
  "trace_id": "trace_uuid",        // サーバ発行。リトライ間で不変（idempotency 再返却時は初回の trace_id）
  "request_id": "request_uuid",    // この HTTP 実行 1 回ごとに発行。リトライで変わる
  "idempotency_key": "...",        // POST のみエコーバック
  "idempotency_replayed": false,   // true = 保存済み結果の再返却（再課金なし）
  "timestamp": "2026-06-10T00:00:00Z"
}
```

成功・エラー両方のレスポンスに `trace_id` + `request_id` を必ず含める。

## 4.4 冪等性契約（Idempotency-Key）

1. **全 POST エンドポイントで `Idempotency-Key` ヘッダ必須**（`/rag/query`, `/rag/bot-context`, `/rag/similar-cases`, `/rag/ingestions`, `/rag/indexing/jobs`, `/rag/provider-evaluations`, `/rag/backtest-report`）。
2. **キーはボット（呼出側）採番**。推奨合成例: `sha256(bot_id + symbol + signal_hash + time_window_start)`。UI 経由は UI が UUIDv4 採番。
3. サーバ側 DB 制約: `rag_queries` / `rag_bot_contexts` / ingestion・indexing・evaluation 各 job テーブルに `idempotency_key` 列 + **部分 UNIQUE（`UNIQUE (requester_id, idempotency_key) WHERE idempotency_key IS NOT NULL`）** を置く（カラム定義の正本は 05 + 統合スキーマ正本仕様。本書はセマンティクスのみ確定）。
4. **セマンティクス**:

| ケース | サーバ挙動 |
|---|---|
| 同一キー + 同一 payload hash | `200` で**保存済み結果を再返却**。`meta.idempotency_replayed: true`。**再課金・再 LLM 呼び出しなし** |
| 同一キー + 異なる payload hash | `409 Conflict` / エラーコード **`RAG_IDEMPOTENCY_CONFLICT`**（10 §4 エラーコード表に追加） |
| キー欠落 | `400 RAG_VALIDATION_ERROR`（メッセージで Idempotency-Key 必須を明示） |
| キー保持期間 | 24h（コスト二重計上の監査窓として十分。期限切れ後の再送は新規実行） |

5. 04 NFR-SAFE-008（「注文 ID 生成・Idempotency Key 生成を RAG が行わない」）との整合: 本契約のキーは **RAG API 呼び出しの冪等化** であり、注文 ID・注文冪等性キーとは無関係。NFR-SAFE-008 は無傷で維持し、誤読防止の注記を 04 に 1 行追加する（§10）。

## 4.5 トレーサビリティ契約（3 識別子）

| ID | 発行者 | ライフサイクル | 用途 |
|---|---|---|---|
| `trace_id` | **RAG サーバ発行**（`X-Correlation-Id` 受領時は監査ログに併記。trace_id 自体は常にサーバ採番） | 1 論理処理（API→Retrieval→LLM→Guardrail→保存 / 07 §13.2 のチェーン）。リトライ跨ぎで不変 | PTP↔RAG 横断追跡 |
| `request_id` | RAG サーバ発行 | **1 HTTP 実行ごと**。ボットがリトライすると変わる | リトライ判別・ログ突合 |
| `idempotency_key` | **ボット採番** | 1 業務意図ごと。リトライで変わらない | 二重実行・二重課金防止 |

- ingest 系・indexing 系のジョブレコード（Ingestion Job / Indexing Job / Provider Evaluation Job）と Redis Streams メッセージ payload にも `trace_id` を必須化する（現状 07 §13 は Query 系のみ）。
- 09 §11.2 の「UI/Bot ↓ trace_id → RAG API」図は「UI/Bot ↓ X-Correlation-Id（任意）→ RAG API が trace_id 発行」へ修正。

## 4.6 金融数値の型（string 統一）

金融数値（drawdown / runup / funding_rate / price / qty / 金額）は **JSON では string、DB では TEXT または Decimal** で保持する（PTP `engineering-prisma-decimal-policy` 同型。IEEE 754 浮動小数誤差の入口を塞ぐ）。

10 の I/O 例で number になっている以下を string へ統一する:

| 箇所 | 現状（number） | 改訂（string） |
|---|---|---|
| bot-context Request `features.funding_rate` / `atr` | `0.012` / `0.034` | `"0.012"` / `"0.034"` |
| bot-context Response `similar_cases[].max_drawdown_pct` / `max_favorable_excursion_pct` | `-1.8` / `3.2` | `"-1.8"` / `"3.2"` |
| similar-cases Response `after_move_4h_pct` / `after_move_24h_pct` / `max_drawdown_pct` / Request `features.price_change_pct_24h` | number | string |
| `llm.estimated_cost`（USD 金額） | `0.0061` | `"0.0061"` |

**非金融のスコア類**（`similarity` / `confidence` / `retrieval_score` / `rsi` 等のテクニカル指標値のうち比率でないスコア表示）は number のまま可。判断基準: 「取引所から受け取った / 注文・損益計算に使われうる値」は string、「RAG 内部の順位付け・確信度」は number。

## 4.7 主要エンドポイント I/O 契約

既存の RAG-API-001〜009（10 §5.1）+ 新規 RAG-API-012〜016 を契約対象とする。以下は境界契約として重要な代表 5 本の I/O 要約（フル定義の正本は 10。10 側は本書 §4.2〜4.6 の横断契約を反映して改訂する）。

### (a) POST /rag/query（RAG-API-001）

- **In**: `query`（必須）, `symbol`, `market`, `timeframe`, `source_types[]`, `from`, `to`, `language`, `top_k`, `provider_policy` + ヘッダ `Idempotency-Key`（必須）
- **Out**: `query_id`, `summary`, `supporting_factors[]`, `opposing_factors[]`, `risk_level`, `confidence`, `citations[]`（§4.8 拡張形）, `llm`（`estimated_cost` は string）, `guardrail`, + 共通 meta
- 契約: citations 空での回答返却禁止（04 NFR-LLM-006）。

### (b) POST /rag/bot-context（RAG-API-002 / generic 名: /rag/decision-context）

- **In**: `client_id`（必須 / generic）, `client_ref`（任意 JSON / PTP は `{bot_id, strategy_id}` を格納）, `symbol`, `market`, `timeframe`, `bot_signal`, `features`（金融数値は string）, `provider_policy` + `Idempotency-Key`（必須）
- **Out**: `context_id`, `explanation`, `supporting_factors[]`, `opposing_factors[]`, `similar_cases[]`（金融数値 string）, `risk_level`, `confidence`, **`order_permission: false`（literal）**, `action_policy: "ORDER_NOT_ALLOWED_BY_RAG"`, `llm`, + 共通 meta
- 契約: Bot 仮シグナルを投資指示として扱わない（10 既存記載を維持）。generic 名 `/rag/decision-context` を正とし `/rag/bot-context` は MVP 互換エイリアス。

### (c) POST /rag/similar-cases（RAG-API-003）

- **In**: `symbol`, `market`, `timeframe`, `features`（金融数値 string）, `lookback_days`, `limit` + `Idempotency-Key`（必須）
- **Out**: `cases[]`（`similarity` は number、`after_move_*_pct` / `max_drawdown_pct` は string、`risk_notes[]`）+ 共通 meta

### (d) GET /rag/history / GET /rag/history/{query_id}（RAG-API-004 / 005）

- **Out**: query / response / citations / guardrail_status / provider_usage。詳細側は `retrieved_chunks`（retrieval 集合 = citation whitelist の監査ビュー）を含む。
- GET のため Idempotency-Key 不要。共通 meta は必須。

### (e) GET /rag/sources / GET /rag/sources/{source_id}（RAG-API-008 / 013）

- **Out**: 一覧は有効ソースのみ（無効・隔離ソースは検索対象外）。詳細は `reliability_score` / 取込履歴 / `quality_status`。
- 管理用全件（QUARANTINED 含む）は `GET /rag/admin/sources`（RAG-API-015 / ADMIN のみ）に分離。

### 欠落エンドポイントの追加（10 §5.1 / §6 / §12 へ追記）

08 §12「API連携マッピング」が参照しているのに 10 の API 一覧に不在のものを正式採番する:

| API ID | Method | URI | 用途 | Role | 備考 |
|---|---|---|---|---|---|
| RAG-API-012 | GET | `/rag/dashboard` | RAG ダッシュボード集計（query 数 / cost / guardrail block 数 / DLQ 数） | USER/ADMIN | read-only |
| RAG-API-013 | GET | `/rag/sources/{source_id}` | 参照ソース詳細 | USER/ADMIN | RAG-API-008 の詳細版 |
| RAG-API-014 | POST | `/rag/backtest-report` | Bot 検証レポート生成 | USER/ADMIN | Idempotency-Key 必須 / 金融数値 string / LLM 生成のため Guardrail 全適用 |
| RAG-API-015 | GET | `/rag/admin/sources` | ソース管理一覧（無効・隔離含む全件） | ADMIN のみ | QUARANTINED も返す |
| RAG-API-016 | GET | `/rag/provider-evaluations/{job_id}` | Provider 評価 Job の状態・結果取得 | ADMIN/RAG_EVALUATOR | 現状 POST のみ（RAG-API-009）で結果取得手段がない欠落の補完 |

## 4.8 citation 契約（検証可能性メタ + whitelist）

### citation オブジェクト拡張（10 §6.1 の citations を置換）

```json
{
  "source_id": "uuid",
  "document_id": "uuid",
  "chunk_id": "uuid",
  "source_type": "market_data",
  "title": "BTCUSDT 1h OHLCV",
  "used_reason": "出来高増加の根拠として使用",
  "excerpt": "（chunk 本文先頭 ~300 字。Secret Masking 済み）",
  "event_time": "2026-06-09T00:00:00Z",
  "ingested_at": "2026-06-09T01:00:00Z",
  "retrieval_score": 0.82,
  "quality_status": "ACTIVE"
}
```

### chunk_id whitelist 検証（Guardrail 必須項目）

- LLM が返した citations の `chunk_id` は、**当該クエリの retrieval 結果集合（rag_retrieval_results に保存した chunk_id 集合）に実在するものだけを許可**。集合外 ID は citation ごと削除する。
- 削除の結果 `citations` が空になったら、04 NFR-LLM-006（根拠なし回答は返却しない）に従い **BLOCK**（`RAG_GUARDRAIL_BLOCKED` / 422）。
- DB 層では `rag_citations` の複合 FK `(retrieval_result_id, chunk_id) → rag_retrieval_results(id, chunk_id)` により捏造 citation の INSERT を物理拒否する（定義の正本は 05 + 統合スキーマ正本仕様）。

### audience 別出し分け

- **ボット向け**（`X-Client-Type: training_bot`）: `excerpt` を省略（ID + score + quality_status のみ）。トークン・帯域節約と Secret 二次流出面の最小化。
- **人間/UI 向け**（`ui` / `admin`）: `excerpt` 含むフル形。excerpt は二重 Secret Masking（04 NFR-SEC-011）通過後の文字列のみ。
- 実装は response serializer の audience パラメータ 1 つで分岐（エンドポイントは分けない）。

---

# 5. Bot 側フォールバック契約（消費側の義務）

07 §17.2 の Fail Safe 方針（「RAG が失敗しても注文系は止めない。ただし RAG 結果を必要とする Bot 検証処理は低信頼または停止扱いにする」）を、**消費側（PTP Training Bot）から見た契約** として定義する。

1. **古い RAG 文脈の再利用禁止**: ボットは RAG レスポンスをローカルキャッシュして次シグナルの判断に再利用してはならない。RAG 文脈の有効期間は **当該シグナル 1 件限り**。
2. **RAG 障害・タイムアウト時の挙動は 2 択のみ**:
   - **`TRAINING_HALT`**: 当該シグナルの学習・検証処理を停止（スキップ）する。
   - **`DEGRADED_EXPLICIT`**: RAG 文脈なしで処理を続ける場合、結果レコードに `rag_context: "UNAVAILABLE"` を必ず刻印し、「RAG 文脈ありの判断」と監査上区別可能にする。
   - **「黙って古い文脈で判断継続」は契約違反**。
3. タイムアウト値: ボット側 client timeout = **10 秒**（04 NFR-PERF-002 の bot-context 上限 10 秒と一致。Fallback Provider 切替を含む上限）。
4. RAG が `RAG_GUARDRAIL_BLOCKED`（422）/ `RAG_COST_LIMIT_EXCEEDED`（429）/ `RAG_RATE_LIMITED`（429）を返した場合もボットは上記 2 択。**BLOCK を「リスクなし」と解釈してはならない**。
5. リトライ規約: リトライ時は **同一 `Idempotency-Key`** を再送する（新キー採番は二重課金になる）。`request_id` は実行ごとに変わるため、ボット側ログにはレスポンス meta の `trace_id` + `request_id` を両方記録する。

---

# 6. order_permission 消費側契約

DB 物理遮断（§3 = RAG 側の防御）と対になる、**消費側（PTP）の防御** を定義する。

## 6.1 契約

1. **RAG の出力を単独で発注根拠にしてはならない**。RAG レスポンスは「学習・検証・説明のための文脈」であり、発注判断は PTP 側の Risk Filter / 戦略ロジック / 人間承認の責務。
2. `order_permission` は常に `false` で返る（05 の CHECK 制約 + 04 NFR-SAFE-002 の `z.literal(false)`）。**Bot 側は値を読まずに破棄してよい**（true が来ることを想定した分岐を書いてはならない — 分岐の存在自体が将来の事故面になる）。
3. generic 語彙では **`action_permission: false`**（「このサービスの出力は実行権限を持たない」）として定義し、PTP 向けレスポンスでは `order_permission`（literal false）と併記する。既存の `action_policy: "ORDER_NOT_ALLOWED_BY_RAG"` は維持。
4. **PTP Risk Filter は RAG の `confidence` / `risk_level` を直接発注ゲートに使わない**。`if (rag.confidence > 0.7) placeOrder()` のようなコードは契約違反。RAG 出力が発注経路に影響してよいのは「学習済みモデル・戦略パラメータを経由した間接影響」までであり、リアルタイム発注判定の入力にしない。

## 6.2 受け入れ基準（PTP 側 / クロスリポ検証）

| # | 検証 | 合格条件 |
|---|---|---|
| 1 | PTP リポジトリで `grep -rn "order_permission" --include="*.ts"`（注文系モジュール） | RAG レスポンスの `order_permission` を発注分岐に使う箇所が **0 件** |
| 2 | PTP リポジトリで RAG レスポンス型（confidence / risk_level）を Order Service / Risk Filter の発注ゲート関数へ渡す import 経路 | **0 件**（boundary test で担保） |
| 3 | Bot の結果レコードスキーマ | `rag_context: "UNAVAILABLE"` 刻印フィールドが存在（§5-2 の DEGRADED_EXPLICIT 実装確認） |
| 4 | RAG 側スキーマ | `order_permission` の `z.literal(false)` + DB CHECK が無傷（§3.3-4 と同一） |

---

# 7. マルチテナント方針 — 全ボット共有プール

- MVP は **全ボット共有プール（単一ユーザー前提）** を採用する。ボット間の知識交差（あるボットの取込データが別ボットの検索にヒットする「交差汚染」）は **仕様として許容** する。
- API 契約上はテナント識別子を要求しない（`client_id` は冪等性・監査のための呼び出し主体識別であり、データ分離キーではない）。
- **将来 owner 分離パス**: マルチオーナー化が必要になったら `rag_sources` / `rag_documents` / `rag_chunks` / `rag_queries` に `owner_id uuid` を追加し、検索 WHERE（chunk 可視性 helper）へ伝播させる。現時点では実装しない。

---

# 8. 汎用モジュール性（generic IF 語彙ルール）

RAG Hub を PTP 以外のボット・プロダクトからも再利用可能にするための語彙ルール:

1. **PTP 固有概念を必須フィールドにしない**: `bot_id` / `strategy_id` は generic な `client_id`（必須）+ `client_ref`（任意・呼出側自由形式 JSON）に再編。`/rag/bot-context` は generic 名 `/rag/decision-context` を正とし、`/rag/bot-context` を MVP 互換エイリアスとして残す。
2. **ドメイン語彙はメタデータに寄せる**: `symbol` / `market` / `timeframe` は検索フィルタであり API のコア契約ではない。コア契約は「query/features → context + citations + risk + confidence + action_permission(false)」の形。
3. Provider 抽象化（07 §8 / 04 NFR-EXT 系）と Guardrail 思想は generic 設計として既に良いため **無変更で維持**。

---

# 9. Phase 2 送り事項（MVP リリース判定との整合）

ふみさん確定方針により、**RAG 品質評価基盤（Precision@10 / Citation 整合率 / Hallucination 率の測定基盤）は Phase 2** とする。

- **MVP リリース判定（受け入れ基準）から品質指標を外す**。MVP のリリースゲートは本書の境界契約（§3.3 / §6.2 の CI 検証）+ 機能受け入れ + Guardrail 動作確認で構成し、品質指標値（例: Precision@10 ≥ X）を条件にしない。
- 28_Retrieval評価設計書の基準値は「Phase 2 測定開始時の初期目標値」と読み替える（28 側にリラベル注記）。
- 評価系テーブル（`rag_eval_datasets` / `rag_eval_results` / `rag_retrieval_evaluations`）は名前空間予約のみで、測定基盤の設計・実装は Phase 2 着工時に行う。
- 本書の API 契約のうち Provider 評価系（RAG-API-009 / 016）は **Provider 選定のためのコスト・レイテンシ評価** であり、品質評価基盤とは別物（MVP に残る）。

---

# 10. 既存文書との関係（本書が正本）

| 文書 | 関係 | 本書起因の修正事項 |
|---|---|---|
| 06_アーキテクチャ図 | 概観図。境界の正は本書 | RAG を独立サービスとして描画（PTP backend 内包表現があれば修正） |
| 07_アーキテクチャ設計書 | 論理・物理構成の詳細 | §5.1 物理図を rag-api / rag-worker 独立コンテナへ修正（§2.3）。§13 trace 定義に request_id 分離・ingest 系 trace 必須化を反映（§4.5） |
| 09_インフラ設計書 | コンテナ・DB・運用 | §6.3 を本書 §3.2 の GRANT 設計で置換。§4.2 の `POSTGRES_USER` を rag_* へ。§5.1「原則禁止」→「禁止」。§11.2 trace 図修正 |
| 10_API設計・外部IF定義書 | エンドポイント詳細の正本（I/O フル定義は 10 が持つ） | §3.3 ヘッダ置換（X-Trace-Id 廃止 / Idempotency-Key・X-Correlation-Id 追加）。§3.4 meta 拡張。§4 に `RAG_IDEMPOTENCY_CONFLICT`（409）追加。§5.1/§6/§12 に RAG-API-012〜016 追加。§6.1 citation 拡張。金融数値 string 化。§9 Guardrail 必須検証に citation whitelist 行追加 |
| 04_非要件機能定義書 | NFR の正本 | NFR-SAFE-001 / NFR-SEC-006 の受け入れ基準に「DB GRANT レベルで SELECT 不可」追記。NFR-SAFE-008 に「RAG API 冪等性キー（本書 §4.4）は注文冪等性と無関係」の誤読防止注記。NFR-MNT-002 を「別リポジトリ・別プロセスで import 物理不可」へ格上げ |
| 05_DB_ER設計書 | DB スキーマの正本（統合スキーマ正本仕様の適用先） | 本書は列のセマンティクス（idempotency_key / trace_id / request_id / citation 検証メタ）のみ定義。DDL の正は 05 |
| 27_Chunking設計書 / 28_Retrieval評価設計書 | Chunking 戦略 / Phase 2 評価 | 本書は §9 の Phase 2 整合のみ関与。DDL 一本化は統合スキーマ正本仕様に従う |

**優先順位**: サービス境界・IF 横断契約（ヘッダ / meta / 冪等性 / trace / 金融数値型 / フォールバック / order_permission 消費契約）= **本書**。個別エンドポイントの I/O フル定義 = 10。DB カラム定義 = 05。矛盾を発見した場合は本書を正として他文書を修正し、本書に誤りがある場合は version を上げて改訂する。

---

# 11. ブロッカー解消対照表（着工前レビュー指摘との対応）

| ブロッカー | 本書での解消箇所 |
|---|---|
| B1 冪等性（unique 無し / idempotency-key 無し） | §4.4（全 POST 必須ヘッダ + 部分 UNIQUE + 409 セマンティクス） |
| B2 citation 検証不能 | §4.8（excerpt / event_time / ingested_at / retrieval_score / quality_status 追加 + chunk_id whitelist 検証 + 複合 FK） |
| B3 order_permission 安全境界 | §3（DB ロール物理遮断 = 一次防御）+ §6（消費側契約 + 受け入れ基準）+ 既存 CHECK / z.literal(false) = 二次防御の維持 |
| B4 トレーサビリティ | §4.5（trace_id サーバ発行 / request_id 分離 / ingest 系 trace 必須化 / X-Trace-Id ヘッダ廃止） |
| B8 API 契約欠落 | §4.7（RAG-API-012〜016 の正式採番） |
| B5 / B6 / B7（検索 SQL / ベクタ次元 / DB 正本二重） | 本書スコープ外。05 への統合スキーマ正本仕様（別成果物）で解消 |

---

*本書は ai:claude-code により 2026-06-10 に作成。サービス境界・IF 契約の変更は本書の version 更新を必須とする。*
