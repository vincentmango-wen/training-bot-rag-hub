以下で作成します。前提は企画書・要件定義書の方針に合わせています。RAGは注文APIを呼ばず、Training Bot / UI 向けの参照APIに限定します。 

---

# **Personal Multi Trading Platform**

# **Training Bot RAG Hub API設計・外部IF定義書 v1.1**

## **1. 文書情報**

|**項目**|**内容**|
|---|---|
|文書名|Training Bot RAG Hub API設計・外部IF定義書|
|対象システム|Personal Multi Trading Platform（PMTP）|
|対象機能|Training Bot参照用RAG基盤|
|文書種別|API設計・外部IF定義書|
|版数|v1.1 <!-- ★v1.1 -->|
|作成日|2026-06-09|
|改訂日|2026-06-10 <!-- ★v1.1 -->|
|対象フェーズ|MVP / Provider比較 / 外部情報RAG|

### **1.1 改訂履歴** <!-- ★v1.1 新設 -->

|**版**|**日付**|**内容**|
|---|---|---|
|v1.0|2026-06-09|初版|
|v1.1|2026-06-10|着工前ブロッカー解消改訂: Idempotency-Key 必須化 + `RAG_IDEMPOTENCY_CONFLICT`（B1）/ citation スキーマ拡張 + whitelist 検証（B2）/ trace_id・request_id 発行責務確定（B4）/ 欠落エンドポイント RAG-API-012〜016 追加（B8）/ リトライ可否・Retry-After・error details 構造 / bot_id 単位 rate limit + IDOR 防御 / SourceType・BotSignal enum SSoT 統一 / 金融数値 string 化。変更箇所は `★v1.1` マーカーで明示。|

---

## **2. API設計方針**

### **2.1 基本方針**

|**方針**|**内容**|
|---|---|
|Read-only First|RAG APIは参照・検索・要約・履歴保存のみを行う|
|No Direct Trading|注文API、Bot起動、Bot設定変更APIは呼び出さない|
|JSON Schema固定|LLM出力は必ずSchema Validationする|
|Provider Adapter経由|OpenAI直結実装は禁止し、Adapter経由で呼び出す|
|Audit First|Query、Retrieval、Response、Citation、Provider利用量を保存する|
|Fail Safe|異常時はBLOCKまたは検索結果のみ返却する|
|Traceable|`trace_id`（**サーバ発行** / リトライ跨ぎで不変）+ `request_id`（**サーバ発行** / 1 HTTP 実行ごと）を全APIで扱う <!-- ★v1.1 改訂: 発行責務を確定 -->|
|Idempotent|全 POST API は `Idempotency-Key` ヘッダ必須（**ボット/呼出側採番**）。同一キー再送は保存済み結果を再返却し、二重課金・監査重複を構造的に防ぐ <!-- ★v1.1 追加: B1 -->|
|Decimal Safe|金融数値（price / qty / funding_rate / atr / drawdown / runup / 金額）は JSON **string** で表現し number にしない（IEEE 754 誤差防止 / PTP Prisma.Decimal 方針同型）<!-- ★v1.1 追加 -->|

---

## **3. 共通API仕様**

### **3.1 Base URL**

```text
Local MVP (Docker network 内 / PTP からの呼び出しは service name 解決):   ← ★v1.1 改訂
http://rag-api:3000/api/v1

Local MVP (ホストからの開発用直アクセス):
http://localhost:3000/api/v1

Future Cloud:
https://api.pmtp.example.com/api/v1
```

> ★v1.1 注記: RAG Hub は PTP backend と**別プロセス・別コンテナ**（rag-api / rag-worker）。PTP からの呼び出しはネットワーク経由の HTTP のみで、NestJS Module としての同居 import・直接 DB 参照は禁止（07 アーキテクチャ設計書 / 09 インフラ設計書のサービス境界に従う）。

---

### **3.2 認証方式**

|**項目**|**内容**|
|---|---|
|認証方式|JWT Bearer Token|
|Header|Authorization: Bearer {access_token}|
|MVP|ローカル開発では一部mock可|
|本番|必須|

---

### **3.3 共通Header** <!-- ★v1.1 全面改訂: X-Trace-Id 廃止 / Idempotency-Key・X-Correlation-Id 追加 -->

```http
Authorization: Bearer {jwt}
Content-Type: application/json
Idempotency-Key: {ボット/呼出側採番キー}    # 全 POST 必須（★v1.1 / B1）
X-Correlation-Id: {呼出側の相関ID}          # 任意（★v1.1 / 旧 X-Trace-Id を置換）
X-Client-Type: ui | training_bot | system | worker
```

|**Header**|**必須**|**採番者**|**内容**|
|---|---|---|---|
|Authorization|yes|—|JWT Bearer Token|
|Idempotency-Key|**POST のみ yes**|**ボット（呼出側）**|二重実行防止キー。リトライ時は**同じ値**を再送する。推奨合成例: `sha256(bot_id + symbol + signal_hash + time_window_start)`。UI 経由は UUIDv4 採番。キーは対象行の保持期間中ずっと有効（再送は `payload_hash` 一致なら常に replay / 不一致なら 409）。時間窓で区切りたい場合は合成キーに `time_window_start` を含める（上記推奨例が該当）|
|X-Correlation-Id|no|呼出側|呼出側システムの相関ID。RAG は監査ログに併記するのみで、`trace_id` の代わりにはならない|
|X-Client-Type|yes|呼出側|クライアント種別|

> ★v1.1 注記（**X-Trace-Id 廃止**）: `trace_id` は **RAG サーバ発行**であり、クライアントが指定できるヘッダにしない（偽装・衝突防止）。呼出側が自系統の ID を紐づけたい場合は `X-Correlation-Id` を使う。

---

### **3.4 共通Response形式** <!-- ★v1.1 改訂: meta 拡張 + 識別子の発行責務確定 + error details 構造化 -->

#### **Success**

```json
{
  "success": true,
  "data": {},
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "idempotency_key": "client-supplied-key",
    "idempotency_replayed": false,
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

> ★v1.1: `idempotency_key`（POST のみエコーバック）と `idempotency_replayed`（true = 過去結果の再返却 / 再課金なし）を追加。

#### **Error**

```json
{
  "success": false,
  "error": {
    "code": "RAG_VALIDATION_ERROR",
    "message": "Invalid request payload",
    "details": [
      {
        "field": "timeframe",
        "code": "INVALID_ENUM",
        "message": "timeframe must be one of 1m / 5m / 1h / 1d"
      }
    ]
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

> ★v1.1: `error.details` は **`[{field, code, message}]` の構造化配列**に固定する。`field` はリクエスト JSON のパス（ネストは dot 記法: `features.rsi`）、`code` は機械可読サブコード（`INVALID_ENUM` / `REQUIRED` / `OUT_OF_RANGE` / `TYPE_MISMATCH` / `IDEMPOTENCY_PAYLOAD_MISMATCH` 等）、`message` は人間可読説明。フィールド単位でない全体エラーは `field: ""` とする。エラー時も `meta.trace_id` / `meta.request_id` は必ず返す（障害調査の突合キー）。

#### **3.4.1 識別子の発行責務（★v1.1 新設 / B4）**

|**識別子**|**採番者**|**寿命**|**用途**|
|---|---|---|---|
|`trace_id`|**RAG サーバ発行**。受信リクエストごとに RAG 側で生成する。`X-Correlation-Id` 受領時は監査ログに correlation として併記（trace_id 自体は常にサーバ採番）|1 論理処理（API → Retrieval → LLM → Guardrail → 保存）。**リトライ跨ぎでは `idempotency_replayed` 返却時に初回実行の trace_id を返す**|PMTP ↔ RAG 横断追跡|
|`request_id`|RAG サーバ発行|**1 HTTP 実行ごと**。ボットがリトライすると毎回変わる|個別実行・ログ突合・リトライ判別|
|`idempotency_key`|**ボット（呼出側）採番**|1 業務意図ごと。リトライで変わらない|二重実行・二重課金防止（B1）|

#### **3.4.2 data への trace_id 併載契約（★v1.1 新設）**

`meta` に加えて、**呼出側が自レコードへ刻印して永続化する必要がある API** では `data` 直下にも `trace_id` / `request_id` を含める:

- `POST /rag/query` → `data.query_id` + `data.trace_id`
- `POST /rag/bot-context` → `data.context_id` + `data.trace_id`
- `POST /rag/backtest-report` → `data.report_id` + `data.trace_id`
- 非同期 Job 系（ingestions / indexing / provider-evaluations / backtest-report）→ `data.trace_id` を必須とし、Job レコード・Redis Streams メッセージ payload にも同じ trace_id を伝播する（ingest 系のトレーサビリティ欠落の解消）

#### **3.4.3 共通 Enum 定義（SSoT / ★v1.1 新設）**

以下 2 つの enum について、本節を **API 表現（シリアライズ）の正本**とする。値集合（DB enum）の正本は **05 ER 設計書 §6**（source_type=§6.1 / query_type=§6.2 / risk_level=§6.3）であり、本節はそれと**完全一致**させる。値リテラルを各所で再宣言・部分列挙してはならない（FE/BE enum SSoT 規約同型）。

**SourceType（12 値）** — 値集合の正本は 05 §6.1。本書 v1.0 の 7 値例示は不完全だったため 05 §6.1（全 12 値）へ揃える。`◎` = MVP 実投入（4 値）/ `△` = enum 定義済・投入は Phase2 以降:

```text
SourceType =
    "market_data"        # ◎ MVP
  | "bot_log"            # ◎ MVP
  | "order_history"      # ◎ MVP
  | "strategy_doc"       # ◎ MVP
  | "execution_history"  # △ Phase2+
  | "position_history"   # △ Phase2+
  | "audit_log"          # △ Phase2+
  | "news"               # △ Phase2+
  | "sns"                # △ Phase2+
  | "prediction_market"  # △ Phase2+
  | "macro_event"        # △ Phase2+
  | "manual_note"        # △ Phase2+
```

**BotSignal（4 値）** — 04 詳細設計書 L1660 の 4 値を正とする。05 ER 設計書 §rag_bot_contexts の「BUY / SELL / HOLD」（NONE 欠落）は本定義に従い `NONE` を追加して読み替える:

```text
BotSignal = "BUY" | "SELL" | "HOLD" | "NONE"
```

- `NONE` = シグナル未確定の状態問い合わせ（Bot が判断材料の事前収集として呼ぶケース）。
- Validation: 上記列挙外の値は `400 RAG_VALIDATION_ERROR`（`details[].code: INVALID_ENUM`）。
- BUY / SELL / HOLD / NONE はいずれも**投資指示ではなく Bot の仮シグナルラベル**（Guardrail 仕様 §9 と整合）。

---

## **4. エラーコード定義** <!-- ★v1.1 改訂: RAG_IDEMPOTENCY_CONFLICT 追加 + リトライ可否列 + Retry-After -->

|**Code**|**HTTP**|**内容**|**リトライ可否（★v1.1）**|
|---|---|---|---|
|RAG_VALIDATION_ERROR|400|リクエスト形式不正（Idempotency-Key 欠落含む）|**不可**（payload 修正が必要）|
|RAG_UNAUTHORIZED|401|認証エラー|不可（トークン再取得後は可）|
|RAG_FORBIDDEN|403|権限不足（JWT subject と bot_id 不一致含む）|**不可**|
|RAG_NOT_FOUND|404|対象データなし|不可|
|RAG_IDEMPOTENCY_CONFLICT|**409**|同一 Idempotency-Key で**異なる payload** を再送（★v1.1 / B1）|**不可**（キーまたは payload の誤りを修正）|
|RAG_GUARDRAIL_BLOCKED|422|ガードレールでブロック|**不可**（同一入力の再送は同一結果。BLOCK を「リスクなし」と解釈しない）|
|RAG_RATE_LIMITED|429|レート制限|**可**（`Retry-After` 秒待機後、同一 Idempotency-Key で再送）|
|RAG_COST_LIMIT_EXCEEDED|429|コスト上限超過|**可**（`Retry-After` 待機後。上限リセットまで長時間の場合あり）|
|RAG_INTERNAL_ERROR|500|内部エラー|条件付き可（1 回まで / 同一 Idempotency-Key）|
|RAG_PROVIDER_ERROR|502|LLM Providerエラー|**可**（同一 Idempotency-Key で再送。Fallback Provider はサーバ側で自動試行済み）|
|RAG_PROVIDER_TIMEOUT|504|LLM Providerタイムアウト|**可**（同一 Idempotency-Key で再送）|

### **4.1 リトライ・タイムアウト契約（★v1.1 新設）**

|**項目**|**内容**|
|---|---|
|リトライ可能エラー|**429 / 502 / 504**（+ 500 は 1 回まで）。リトライ時は**必ず同一 `Idempotency-Key`** を再送する（request_id はサーバ側で変わる）|
|リトライ不可エラー|**400 / 401 / 403 / 404 / 409 / 422**。payload・権限・入力を修正しない限り再送しても結果は変わらない|
|Retry-After ヘッダ|429 系（RAG_RATE_LIMITED / RAG_COST_LIMIT_EXCEEDED）のレスポンスに **`Retry-After: {秒}` を必須**で付与する。クライアントは指定秒待機してから再送する|
|inbound タイムアウト（サーバ側処理上限）|同期 API（`/rag/query` / `/rag/bot-context` / `/rag/similar-cases` / `/rag/backtest-report`）は **LLM Fallback 込みで 10 秒**を処理上限とし、超過時は `504 RAG_PROVIDER_TIMEOUT` を返す（07 アーキテクチャ設計書 §15.1 と整合）|
|クライアント側 timeout|ボット側 client timeout = **10 秒**を推奨既定値とする。タイムアウト時のボットの挙動は 2 択のみ: `TRAINING_HALT`（当該シグナル処理をスキップ）または `DEGRADED_EXPLICIT`（RAG 文脈なし続行 + 結果レコードに `rag_context: "UNAVAILABLE"` を必ず刻印）。**「黙って古い RAG 文脈で判断継続」は契約違反**|
|推奨バックオフ|exponential backoff + jitter（初回 1s / 最大 30s / 最大 3 回）。Retry-After がある場合はそちらを優先|

---

# **5. 内部API一覧**

## **5.1 API一覧**

|**API ID**|**Method**|**URI**|**用途**|**優先度**|
|---|---|---|---|---|
|RAG-API-001|POST|`/rag/query`|通常RAG問い合わせ|最優先|
|RAG-API-002|POST|`/rag/bot-context`|Training Bot向け文脈取得|最優先|
|RAG-API-003|POST|`/rag/similar-cases`|過去類似ケース検索|高|
|RAG-API-004|GET|`/rag/history`|RAG履歴一覧|高|
|RAG-API-005|GET|`/rag/history/{query_id}`|RAG履歴詳細|高|
|RAG-API-006|POST|`/rag/ingestions`|データ取込要求|高|
|RAG-API-007|POST|`/rag/indexing/jobs`|Indexing Job作成|高|
|RAG-API-008|GET|`/rag/sources`|RAGソース一覧|中|
|RAG-API-009|POST|`/rag/provider-evaluations`|Provider評価実行|中|
|RAG-API-010|GET|`/rag/provider-usage`|Provider利用量確認|高|
|RAG-API-011|GET|`/rag/health`|Health Check|最優先|
|RAG-API-012|GET|`/rag/dashboard`|RAGダッシュボード集計（★v1.1 / B8）|高|
|RAG-API-013|GET|`/rag/sources/{source_id}`|参照ソース詳細（★v1.1 / B8）|中|
|RAG-API-014|POST|`/rag/backtest-report`|Bot検証レポート生成（★v1.1 / B8）|中|
|RAG-API-015|GET|`/rag/admin/sources`|ソース管理一覧・隔離含む全件（★v1.1 / B8）|中|
|RAG-API-016|GET|`/rag/provider-evaluations/{job_id}`|Provider評価Job状態・結果取得（★v1.1 / B8: 従来 POST のみで結果取得手段がなかった欠落の補完）|中|

> ★v1.1 注記: RAG-API-012〜015 は 08_UI画面設計・遷移設計書が参照しているにもかかわらず本一覧に不在だったエンドポイント。RAG-API-016 は RAG-API-009（POST）に対する GET 取得口の欠落補完。詳細は §6.11〜§6.15。

---

## **5.2 API実装Issue分解表**

本節では、API設計をGitHub Issue単位へ分解する。

分解方針は以下とする。

```text
1 API = 原則 1 Issue
ただし、履歴一覧・履歴詳細のように同一Controllerで実装できるものは1 Issueにまとめる
Request Validation / Response Schema / 認証認可 / Audit Log / テスト観点を各Issueに含める
RAGから注文API・Trading Engine・Bot設定変更APIへ接続するIssueは作成しない
```
| API ID      | Method | URI                                | 実装Issue | Issue名                                      | Milestone | Label                                                 | 依存Issue                                                | 完了条件                                                                               |
| ----------- | ------ | ---------------------------------- | ------- | ------------------------------------------- | --------- | ----------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| RAG-API-001 | POST   | `/api/v1/rag/query`                | GH-028  | POST /api/v1/rag/query を実装する                | M3        | type: feature / area: api / priority: critical        | GH-021, GH-022, GH-024, GH-025, GH-027, GH-032, GH-033 | Request Validation、Response Schema、Audit Log、Provider Usage、order_permission=false |
| RAG-API-002 | POST   | `/api/v1/rag/bot-context`          | GH-029  | POST /api/v1/rag/bot-context を実装する          | M3        | type: feature / area: api / priority: critical        | GH-021, GH-022, GH-027, GH-030, GH-032, GH-033         | Bot仮シグナルを投資指示として扱わない、BotContext保存、order_permission=false                           |
| RAG-API-003 | POST   | `/api/v1/rag/similar-cases`        | GH-030  | POST /api/v1/rag/similar-cases を実装する        | M3        | type: feature / area: api / priority: high            | GH-021, GH-022, GH-023                                 | 類似ケース配列、similarity、risk_notes、citationを返す                                          |
| RAG-API-004 | GET    | `/api/v1/rag/history`              | GH-031  | GET /api/v1/rag/history を実装する               | M3        | type: feature / area: api / priority: high            | GH-026, GH-028, GH-029, GH-030                         | query、response、citation、guardrail_statusを一覧表示できる                                   |
| RAG-API-005 | GET    | `/api/v1/rag/history/{query_id}`   | GH-031  | GET /api/v1/rag/history/{query_id} を実装する    | M3        | type: feature / area: api / priority: high            | GH-026, GH-028, GH-029, GH-030                         | retrieved_chunks、response、citations、provider_usageを詳細表示できる                         |
| RAG-API-006 | POST   | `/api/v1/rag/ingestions`           | GH-064  | POST /api/v1/rag/ingestions を実装する           | M2        | type: feature / area: ingestion / priority: high      | GH-010, GH-011, GH-015                                 | 取込Jobを作成し、Secret Masking / Prompt Injection Scan対象にする                              |
| RAG-API-007 | POST   | `/api/v1/rag/indexing/jobs`        | GH-065  | POST /api/v1/rag/indexing/jobs を実装する        | M2        | type: feature / area: indexing / priority: high       | GH-012, GH-013, GH-016, GH-018, GH-019, GH-020         | Indexing Jobを作成し、force_reindexを制御する                                                |
| RAG-API-008 | GET    | `/api/v1/rag/sources`              | GH-066  | GET /api/v1/rag/sources を実装する               | M2        | type: feature / area: api / priority: medium          | GH-010                                                 | 有効なSource一覧を返す。無効Sourceは検索対象外として扱う                                                 |
| RAG-API-009 | POST   | `/api/v1/rag/provider-evaluations` | GH-067  | POST /api/v1/rag/provider-evaluations を実装する | M6        | type: feature / area: llm-provider / priority: medium | GH-024, GH-025, GH-026                                 | Provider評価Jobを作成し、評価対象Providerとdatasetを保存する                                        |
| RAG-API-010 | GET    | `/api/v1/rag/provider-usage`       | GH-068  | GET /api/v1/rag/provider-usage を実装する        | M3        | type: feature / area: audit / priority: high          | GH-026                                                 | provider、model、tokens、estimated_cost、latencyを取得できる                                 |
| RAG-API-011 | GET    | `/api/v1/rag/health`               | GH-069  | GET /api/v1/rag/health を実装する                | M0        | type: feature / area: infra / priority: high          | GH-002, GH-003                                         | db、redis、vector_store、llm_provider、embedding_providerの状態を返す                        |

> ★v1.1 注記: v1.1 で追加した RAG-API-012〜016 の Issue 分解（GH 採番・Milestone・依存）は、既存 GH-070 以降の採番衝突を避けるため**起票時に別途確定**する（本表は v1.0 起票済み分の正本のまま維持）。完了条件は §5.3 共通条件 + 各 API の §6.11〜§6.15 を適用する。

## 5.3 API Issue共通完了条件

すべてのAPI実装Issueは以下を満たす。
```text
Request DTOがある
Request Validationがある
Response DTOがある
Error Responseが共通形式で返る
JWT認証の有無が明記されている
Roleごとの認可条件が明記されている
Audit Log保存対象が明記されている
Providerを使う場合はProvider Adapter経由である
order_permission / orderPermission は常に false である
Secret / API Key / JWT をレスポンス・ログ・Provider送信内容に含めない
POST API は Idempotency-Key 必須検証 + 同一キー再送の再返却（idempotency_replayed=true）テストがある  ← ★v1.1
trace_id はサーバ発行であり、クライアント指定ヘッダから受け取っていない（X-Correlation-Id は監査併記のみ）  ← ★v1.1
エラーレスポンスの details が [{field, code, message}] 構造である  ← ★v1.1
正常系テストがある
異常系テストがある
Validationテストがある
Securityテストがある
Guardrailテストがある
```
## 5.4 API Issue別テスト観点

| API ID      | 正常系                          | 異常系                 | Security            | Guardrail                        | Audit                                                    |
| ----------- | ---------------------------- | ------------------- | ------------------- | -------------------------------- | -------------------------------------------------------- |
| RAG-API-001 | summary / risk / citations返却 | query空、timeframe不正  | JWTなし401            | 注文誘導BLOCK、order_permission=false | Query / Retrieval / Response / Citation / Provider Usage |
| RAG-API-002 | Bot説明生成                      | bot_id未指定、features空 | TRAINING_BOT権限確認    | BUY/SELLを投資指示にしない                | BotContext / Response                                    |
| RAG-API-003 | 類似ケース返却                      | features空           | JWTなし401            | 類似ケースを将来保証として扱わない                | Retrieval                                                |
| RAG-API-004 | 履歴一覧返却                       | page不正              | 他人の履歴403            | Secret表示なし                       | History Access                                           |
| RAG-API-005 | 履歴詳細返却                       | query_id不正          | 他人の詳細403            | Secret表示なし                       | History Access                                           |
| RAG-API-006 | 取込Job作成                      | source_type不正       | Worker権限確認          | 危険文書隔離                           | Ingestion Job                                            |
| RAG-API-007 | Indexing Job作成               | document_ids空       | Worker権限確認          | Quarantine文書をIndexしない            | Indexing Job                                             |
| RAG-API-008 | Source一覧取得                   | 無効source除外          | Admin/User権限確認      | 危険source除外                       | Source Access                                            |
| RAG-API-009 | Provider評価Job作成              | provider不正          | Admin/Evaluator権限確認 | 評価中もorder_permission=false       | Evaluation Job                                           |
| RAG-API-010 | Provider Usage取得             | from > to           | Admin権限確認           | Secret非表示                        | Provider Usage                                           |
| RAG-API-011 | Health取得                     | DB停止                | 公開範囲制御              | Secret非表示                        | 障害時ログ                                                    |



# **6. API詳細定義**

## **6.1 RAG Query API**

### **概要**

通常のRAG問い合わせを実行する。  
UI、Training Bot、AI Analysis Serviceから利用する。

```http
POST /api/v1/rag/query
```

### **Request**

```json
{
  "query": "BTCUSDTの現在相場について、過去類似ケースとリスクを教えて",
  "symbol": "BTCUSDT",
  "market": "crypto",
  "timeframe": "1h",
  "source_types": [
    "market_data",
    "bot_log",
    "news"
  ],
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-06-09T00:00:00Z",
  "language": "ja",
  "top_k": 8,
  "provider_policy": "default"
}
```

### **Request項目**

|**項目**|**型**|**必須**|**内容**|
|---|---|---|---|
|query|string|yes|問い合わせ本文|
|symbol|string|no|銘柄|
|market|string|no|crypto / stock / fx|
|timeframe|string|no|1m / 5m / 1h / 1d|
|source_types|string[]|no|検索対象ソース|
|from|datetime|no|検索開始日時|
|to|datetime|no|検索終了日時|
|language|string|no|ja / en / zh|
|top_k|number|no|取得チャンク数|
|provider_policy|string|no|default / risk_aware / low_cost|

> ★v1.1: `source_types` の許容値は **§3.4.3 SourceType（7 値 SSoT）** に従う。本 API は POST のため `Idempotency-Key` ヘッダ必須（§3.3）。

### **Response**

```json
{
  "success": true,
  "data": {
    "query_id": "uuid",
    "trace_id": "trace_uuid",
    "summary": "市場状況の要約",
    "supporting_factors": [
      "出来高が増加している",
      "過去類似ケースでは短期反発が確認された"
    ],
    "opposing_factors": [
      "上位足では下落トレンドが継続している",
      "急騰後の反落リスクがある"
    ],
    "risk_level": "MEDIUM",
    "confidence": 0.68,
    "citations": [
      {
        "source_id": "uuid",
        "document_id": "uuid",
        "chunk_id": "uuid",
        "source_type": "market_data",
        "title": "BTCUSDT 1h OHLCV",
        "used_reason": "出来高増加の根拠として使用",
        "excerpt": "（chunk 本文先頭 ~300 字。Secret Masking 済み / UI 向けのみ）",
        "event_time": "2026-06-09T00:00:00Z",
        "ingested_at": "2026-06-09T01:00:00Z",
        "retrieval_score": 0.82,
        "quality_status": "ACTIVE"
      }
    ],
    "llm": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "fallback_used": false,
      "input_tokens": 3200,
      "output_tokens": 760,
      "estimated_cost": "0.0061",
      "latency_ms": 1850
    },
    "guardrail": {
      "status": "PASS",
      "order_permission": false,
      "reason": "RAG has no trading permission"
    }
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "idempotency_key": "client-supplied-key",
    "idempotency_replayed": false,
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

> ★v1.1: `data.trace_id` を併載（§3.4.2）。`llm.estimated_cost` は **string**（金額 / §2.1 Decimal Safe）。

### **citation オブジェクト定義（★v1.1 全面改訂 / B2）**

|**項目**|**型**|**必須**|**内容**|
|---|---|---|---|
|source_id / document_id / chunk_id|uuid|yes|引用元の 3 階層 ID|
|source_type|string|yes|§3.4.3 SourceType SSoT|
|title|string|no|引用元タイトル|
|used_reason|string|yes|当該根拠を使った理由|
|excerpt|string|**UI 向けのみ**|引用箇所の本文スナップショット（先頭 ~300 字 / **Secret Masking 通過後**の文字列のみ）。後日の chunk 変更・削除に耐える監査固定値|
|event_time|datetime|yes (nullable)|情報が指す時点（chunk.event_time のスナップショット）|
|ingested_at|datetime|yes|取込時点のスナップショット。鮮度検証用|
|retrieval_score|number|yes|rerank 後の検索スコア（金融数値ではないため number 可）|
|quality_status|string|yes|citation 品質の合成ステータス（値集合の正本は 05 §5.11）: `ACTIVE` / `QUARANTINED` / `DISABLED` / `STALE` / `LOW_RELIABILITY`。**ACTIVE 以外の引用は Guardrail BLOCK 対象**|

#### **chunk_id whitelist 検証（★v1.1 / B2 核心）**

LLM が返した citations の `chunk_id` は、**当該クエリの retrieval 結果集合（rag_retrieval_results に保存済みの chunk_id 集合）に実在するものだけを許可**する。集合外の ID（LLM の捏造 ID）は citation ごと削除し、削除の結果 `citations` が空になった場合は「根拠なし回答は返却しない」原則（04 NFR-LLM-006）に従い `422 RAG_GUARDRAIL_BLOCKED` とする。DB 層でも複合 FK（rag_citations → rag_retrieval_results）で物理強制される（05 ER 設計書参照）。

#### **audience 別出し分け（★v1.1 / B2）**

|**呼出元（X-Client-Type）**|**citation 形**|
|---|---|
|`training_bot`|`excerpt` を**省略**（ID + retrieval_score + quality_status + 時刻のみ）。トークン・帯域節約と Secret 二次流出面の最小化|
|`ui` / admin 系|`excerpt` 含むフル形（Secret Masking 済み）|

実装は response serializer の audience パラメータ 1 つで分岐し、**エンドポイントは分けない**。

---

## **6.2 Bot Context API**

### **概要**

Training Botが仮シグナルに対する説明・反対材料・リスクを取得する。

```http
POST /api/v1/rag/bot-context
```

### **Request**

```json
{
  "bot_id": "uuid",
  "strategy_id": "uuid",
  "symbol": "BTCUSDT",
  "market": "crypto",
  "timeframe": "1h",
  "bot_signal": "BUY",
  "features": {
    "rsi": 29,
    "macd": "golden_cross",
    "volume_spike": true,
    "atr": "0.034",
    "funding_rate": "0.012"
  },
  "provider_policy": "risk_aware"
}
```

> ★v1.1: `bot_signal` の許容値は **§3.4.3 BotSignal（BUY / SELL / HOLD / NONE）SSoT** に従う。`atr` / `funding_rate` 等の金融数値は **string**（§2.1 Decimal Safe）。`rsi` はテクニカル指標のスコア値であり number のまま可。本 API は POST のため `Idempotency-Key` ヘッダ必須（リトライ時に同一キー再送 / 二重課金防止）。

### **Response**

```json
{
  "success": true,
  "data": {
    "context_id": "uuid",
    "trace_id": "trace_uuid",
    "bot_id": "uuid",
    "strategy_id": "uuid",
    "symbol": "BTCUSDT",
    "bot_signal": "BUY",
    "explanation": "RSIが売られすぎ圏にあり、MACDも上向き転換しているため、短期反発シナリオを支持する材料がある。",
    "supporting_factors": [
      "RSI oversold",
      "MACD golden cross",
      "Volume spike"
    ],
    "opposing_factors": [
      "上位足の下落トレンドが継続している可能性",
      "急変動時のスリッページ拡大リスク"
    ],
    "similar_cases": [
      {
        "case_id": "uuid",
        "period_from": "2025-09-01T00:00:00Z",
        "period_to": "2025-09-02T00:00:00Z",
        "similarity": 0.84,
        "outcome": "UP_AFTER_4H",
        "max_drawdown_pct": "-1.8",
        "max_favorable_excursion_pct": "3.2"
      }
    ],
    "risk_level": "HIGH",
    "confidence": 0.61,
    "order_permission": false,
    "action_policy": "ORDER_NOT_ALLOWED_BY_RAG",
    "llm": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "fallback_used": false
    }
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "idempotency_key": "client-supplied-key",
    "idempotency_replayed": false,
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

> ★v1.1: `data.trace_id` 併載（Bot は自分の検証結果レコードにこの trace_id を刻印して保存する / §3.4.2）。`max_drawdown_pct` / `max_favorable_excursion_pct` は **string**（金融数値 / §2.1 Decimal Safe）。`similarity` / `confidence` はスコア値のため number のまま。`order_permission` は常に literal `false`（一次防御は DB ロール物理遮断 / 本フィールドは二次防御。Bot 側は値を読まずに破棄してよい）。

---

## **6.3 Similar Cases API**

```http
POST /api/v1/rag/similar-cases
```

### **Request**

```json
{
  "symbol": "BTCUSDT",
  "market": "crypto",
  "timeframe": "1h",
  "features": {
    "rsi": 29,
    "macd": "golden_cross",
    "volume_spike": true,
    "price_change_pct_24h": "4.2"
  },
  "lookback_days": 365,
  "limit": 10
}
```

> ★v1.1: `price_change_pct_24h` は **string**（金融数値 / §2.1 Decimal Safe）。本 API は POST のため `Idempotency-Key` ヘッダ必須。

### **Response**

```json
{
  "success": true,
  "data": {
    "cases": [
      {
        "case_id": "uuid",
        "symbol": "BTCUSDT",
        "period_from": "2025-10-01T00:00:00Z",
        "period_to": "2025-10-02T00:00:00Z",
        "similarity": 0.87,
        "matched_features": [
          "rsi",
          "macd",
          "volume_spike"
        ],
        "after_move_4h_pct": "2.4",
        "after_move_24h_pct": "-0.8",
        "max_drawdown_pct": "-2.1",
        "risk_notes": [
          "短期上昇後に失速",
          "出来高低下で反落"
        ]
      }
    ]
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "idempotency_key": "client-supplied-key",
    "idempotency_replayed": false,
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

> ★v1.1: `after_move_*_pct` / `max_drawdown_pct` は **string**（金融数値 / §2.1 Decimal Safe）。

---

## **6.4 RAG History API**

```http
GET /api/v1/rag/history
```

### **Query Parameters**

|**Parameter**|**必須**|**内容**|
|---|---|---|
|symbol|no|銘柄|
|bot_id|no|Bot ID|
|risk_level|no|LOW / MEDIUM / HIGH / CRITICAL|
|from|no|開始日時|
|to|no|終了日時|
|page|no|ページ番号|
|limit|no|件数|

### **Response**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "query_id": "uuid",
        "created_at": "2026-06-09T00:00:00Z",
        "symbol": "BTCUSDT",
        "query": "BTCUSDTのリスクを教えて",
        "risk_level": "MEDIUM",
        "confidence": 0.68,
        "provider": "openai",
        "model": "gpt-5.4-mini",
        "guardrail_status": "PASS"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 120
    }
  }
}
```

---

## **6.5 RAG History Detail API**

```http
GET /api/v1/rag/history/{query_id}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "query_id": "uuid",
    "query": "BTCUSDTのリスクを教えて",
    "request_payload": {},
    "retrieved_chunks": [
      {
        "chunk_id": "uuid",
        "document_id": "uuid",
        "score": 0.82,
        "used_in_answer": true
      }
    ],
    "response": {
      "summary": "市場状況の要約",
      "supporting_factors": [],
      "opposing_factors": [],
      "risk_level": "MEDIUM",
      "confidence": 0.68
    },
    "citations": [],
    "guardrail": {
      "status": "PASS",
      "blocked_reasons": []
    },
    "provider_usage": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "input_tokens": 3200,
      "output_tokens": 760,
      "estimated_cost": "0.0061",
      "latency_ms": 1850
    }
  }
}
```

> ★v1.1: `estimated_cost` は **string**（金額 / §2.1 Decimal Safe）。

---

## **6.6 Ingestion API**

```http
POST /api/v1/rag/ingestions
```

### **用途**

内部データ、戦略ドキュメント、外部ニュース等の取込Jobを作成する。

### **Request**

```json
{
  "source_id": "uuid",
  "source_type": "strategy_doc",
  "input_type": "text",
  "title": "BTC Scalping Strategy v1",
  "content": "strategy document body",
  "metadata": {
    "symbol": "BTCUSDT",
    "market": "crypto",
    "language": "ja",
    "risk_tags": [
      "scalping",
      "volatility"
    ]
  }
}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "ingestion_job_id": "uuid",
    "trace_id": "trace_uuid",
    "status": "PENDING"
  }
}
```

> ★v1.1: `Idempotency-Key` 必須（同一キー再送は既存 Job を再返却 / 取込 Job の二重作成防止）。`data.trace_id` を必須とし、Ingestion Job レコード・Redis Streams メッセージ payload・後続の Indexing 処理まで同一 trace_id を伝播する（§3.4.2 / ingest 系トレーサビリティ）。`source_type` は §3.4.3 SourceType SSoT。

---

## **6.7 Indexing Job API**

```http
POST /api/v1/rag/indexing/jobs
```

### **Request**

```json
{
  "document_ids": [
    "uuid"
  ],
  "embedding_provider": "openai",
  "embedding_model": "text-embedding-3-small",
  "force_reindex": false
}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "indexing_job_id": "uuid",
    "trace_id": "trace_uuid",
    "status": "PENDING"
  }
}
```

> ★v1.1: `Idempotency-Key` 必須（Indexing Job の二重作成 = Embedding 二重課金の防止）。`data.trace_id` 必須 + Job レコード / Redis Streams payload へ伝播（§3.4.2）。

---

## **6.8 Provider Evaluation API**

```http
POST /api/v1/rag/provider-evaluations
```

### **Request**

```json
{
  "eval_dataset_id": "RAG-EVAL-001",
  "providers": [
    "openai",
    "claude",
    "gemini",
    "mistral"
  ],
  "task_type": "bot_signal_explanation",
  "sample_limit": 100
}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "evaluation_job_id": "uuid",
    "trace_id": "trace_uuid",
    "status": "PENDING",
    "providers": [
      "openai",
      "claude",
      "gemini",
      "mistral"
    ]
  }
}
```

> ★v1.1: `Idempotency-Key` 必須（評価 Job 二重実行 = Provider 比較費二重計上の防止）。`data.trace_id` 必須 + Job レコード / Redis Streams payload へ伝播（§3.4.2）。結果取得は `GET /rag/provider-evaluations/{job_id}`（§6.15 / RAG-API-016）。

---

## **6.9 Provider Usage API**

```http
GET /api/v1/rag/provider-usage
```

### **Query Parameters**

|**Parameter**|**内容**|
|---|---|
|from|開始日時|
|to|終了日時|
|provider|openai / claude / gemini / mistral|
|model|モデル名|
|task_type|query / bot_context / evaluation|

### **Response**

```json
{
  "success": true,
  "data": {
    "total_estimated_cost": "18.42",
    "total_input_tokens": 9200000,
    "total_output_tokens": 2100000,
    "items": [
      {
        "provider": "openai",
        "model": "gpt-5.4-mini",
        "task_type": "rag_query",
        "request_count": 3000,
        "input_tokens": 9000000,
        "output_tokens": 2000000,
        "estimated_cost": "17.55",
        "avg_latency_ms": 1820
      }
    ]
  }
}
```

> ★v1.1: `total_estimated_cost` / `estimated_cost` は **string**（金額 / §2.1 Decimal Safe）。

Provider利用量とコストは、コスト見積もり書で必須ログとして定義されている `provider`、`model`、`input_tokens`、`output_tokens`、`estimated_cost`、`latency_ms` を保存対象にします。 

---

## **6.10 Health Check API**

```http
GET /api/v1/rag/health
```

### **Response**

```json
{
  "success": true,
  "data": {
    "status": "UP",
    "db": "UP",
    "redis": "UP",
    "vector_store": "UP",
    "llm_provider": "UP",
    "embedding_provider": "UP"
  }
}
```

---

## **6.11 RAG Dashboard API（★v1.1 新設 / B8 / RAG-API-012）**

```http
GET /api/v1/rag/dashboard
```

### **用途**

UI ダッシュボード画面（08_UI画面設計 参照）向けの集計値を返す。read-only。

### **Query Parameters**

|**Parameter**|**必須**|**内容**|
|---|---|---|
|from|no|集計開始日時（既定: 過去 7 日）|
|to|no|集計終了日時（既定: now）|

### **Response**

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-06-03T00:00:00Z", "to": "2026-06-10T00:00:00Z" },
    "query_count": 1240,
    "bot_context_count": 860,
    "guardrail_blocked_count": 12,
    "dlq_count": 3,
    "total_estimated_cost": "12.80",
    "provider_breakdown": [
      { "provider": "openai", "request_count": 1100, "estimated_cost": "11.20" }
    ],
    "source_health": [
      { "source_type": "news", "active_count": 4, "quarantined_count": 1 }
    ]
  }
}
```

### **権限・備考**

- Role: USER / ADMIN
- `total_estimated_cost` / `estimated_cost` は string（§2.1 Decimal Safe）
- 集計対象メトリクスは 04 非機能要件 §22.1 のサブセット

---

## **6.12 RAG Source Detail API（★v1.1 新設 / B8 / RAG-API-013）**

```http
GET /api/v1/rag/sources/{source_id}
```

### **用途**

RAG-API-008（ソース一覧）の詳細版。ソース個別の信頼度・取込履歴・品質状態を返す。

### **Response**

```json
{
  "success": true,
  "data": {
    "source_id": "uuid",
    "source_type": "news",
    "source_name": "coindesk_rss",
    "display_name": "CoinDesk RSS",
    "reliability_score": 0.7,
    "status": "ACTIVE",
    "document_count": 320,
    "chunk_count": 2150,
    "quarantined_chunk_count": 4,
    "last_ingested_at": "2026-06-09T23:00:00Z",
    "recent_ingestion_jobs": [
      { "ingestion_job_id": "uuid", "status": "INDEXED", "created_at": "2026-06-09T23:00:00Z" }
    ]
  }
}
```

### **権限・備考**

- Role: USER / ADMIN
- USER には status `ACTIVE` のソースのみ。無効・隔離ソースの詳細は 404（存在秘匿）。ADMIN は全状態を閲覧可
- `source_type` は §3.4.3 SourceType SSoT

---

## **6.13 Backtest Report API（★v1.1 新設 / B8 / RAG-API-014）**

```http
POST /api/v1/rag/backtest-report
```

### **用途**

Bot 検証（バックテスト）結果に対する説明レポートを LLM で生成する。LLM 生成を伴うため **Guardrail 全適用**（§9）+ `Idempotency-Key` 必須。

### **Request**

```json
{
  "bot_id": "uuid",
  "strategy_id": "uuid",
  "symbol": "BTCUSDT",
  "period_from": "2026-05-01T00:00:00Z",
  "period_to": "2026-06-01T00:00:00Z",
  "metrics": {
    "total_return_pct": "4.8",
    "max_drawdown_pct": "-3.2",
    "win_rate_pct": "56.0",
    "trade_count": 142
  },
  "provider_policy": "default"
}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "report_id": "uuid（永続先は rag_responses.id / query_type='backtest_report' 行。専用テーブルは作らない ★v1.1 / B7）",
    "trace_id": "trace_uuid",
    "summary": "検証期間の傾向要約",
    "strengths": [],
    "weaknesses": [],
    "risk_notes": [],
    "citations": [],
    "order_permission": false,
    "guardrail": { "status": "PASS", "blocked_reasons": [] }
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "idempotency_key": "client-supplied-key",
    "idempotency_replayed": false,
    "timestamp": "2026-06-10T00:00:00Z"
  }
}
```

### **権限・備考**

- Role: USER / ADMIN
- `metrics` 内の金融数値（return / drawdown / win_rate）はすべて **string**（§2.1 Decimal Safe）。`trade_count` は件数のため number
- citations は §6.1 の citation オブジェクト定義（whitelist 検証含む）に従う
- 同期処理上限 10 秒（§4.1）。レポートが重い場合は将来 Job 化を検討（Phase 2）

---

## **6.14 Admin Source Management API（★v1.1 新設 / B8 / RAG-API-015）**

```http
GET /api/v1/rag/admin/sources
```

### **用途**

ソース管理画面向けの全件一覧。RAG-API-008 と異なり **DISABLED / BLOCKED / QUARANTINED 状態のソースも含めて返す**。

### **Query Parameters**

|**Parameter**|**必須**|**内容**|
|---|---|---|
|status|no|ACTIVE / DISABLED / BLOCKED（未指定 = 全件）|
|source_type|no|§3.4.3 SourceType SSoT|
|page / limit|no|ページネーション|

### **Response**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "source_id": "uuid",
        "source_type": "sns",
        "display_name": "X Sentiment Summary",
        "reliability_score": 0.4,
        "status": "DISABLED",
        "quarantined_chunk_count": 12,
        "updated_at": "2026-06-08T00:00:00Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 9 }
  }
}
```

### **権限・備考**

- Role: **ADMIN のみ**（USER は 403 RAG_FORBIDDEN）
- read-only（ソースの有効化・無効化等の変更系 API は別途設計。本書 v1.1 スコープ外）

---

## **6.15 Provider Evaluation Result API（★v1.1 新設 / B8 / RAG-API-016）**

```http
GET /api/v1/rag/provider-evaluations/{job_id}
```

### **用途**

RAG-API-009（POST = 評価 Job 作成）に対する**状態・結果の取得口**。v1.0 では POST のみで結果取得手段が欠落していた。

### **Response**

```json
{
  "success": true,
  "data": {
    "evaluation_job_id": "uuid",
    "trace_id": "trace_uuid",
    "status": "COMPLETED",
    "eval_dataset_id": "RAG-EVAL-001",
    "providers": ["openai", "claude"],
    "results": [
      {
        "provider": "openai",
        "model": "gpt-5.4-mini",
        "sample_count": 100,
        "schema_valid_rate": 0.99,
        "avg_latency_ms": 1820,
        "estimated_cost": "1.20"
      }
    ],
    "started_at": "2026-06-09T00:00:00Z",
    "completed_at": "2026-06-09T00:12:00Z"
  }
}
```

### **権限・備考**

- Role: ADMIN / RAG_EVALUATOR
- `status` は §8.4 Provider Evaluation Job 状態（PENDING / RUNNING / COMPLETED / FAILED / CANCELLED）
- `estimated_cost` は string（§2.1 Decimal Safe）
- Precision@10 / Citation 整合率 / Hallucination 率等の **RAG 品質指標は Phase 2**（28_Retrieval評価設計書）。本 API の MVP スコープは Job 状態 + Schema 妥当率 + レイテンシ + コストまで

---

# **7. 外部IF定義**

## **7.1 外部IF一覧**

|**IF ID**|**接続先**|**方向**|**用途**|**MVP**|
|---|---|---|---|---|
|EXT-IF-001|OpenAI API|Outbound|LLM生成・Embedding|対象|
|EXT-IF-002|Anthropic Claude API|Outbound|リスクレビュー|Phase 2|
|EXT-IF-003|Google Gemini API|Outbound|要約・Provider比較|Phase 2|
|EXT-IF-004|Mistral API|Outbound|Provider比較|Phase 2|
|EXT-IF-005|News Source / RSS|Inbound Pull|ニュース取得|Phase 3|
|EXT-IF-006|Polymarket等|Inbound Pull|予測市場データ取得|Phase 3|
|EXT-IF-007|SNS API / Manual Summary|Inbound Pull / Manual|SNS要約取得|Phase 3|
|EXT-IF-008|PMTP Market Service|Internal|市場データ取得|対象|
|EXT-IF-009|PMTP Bot Service|Internal|Bot情報取得|対象|
|EXT-IF-010|PMTP Audit Service|Internal|監査ログ保存|対象|

---

## **7.2 OpenAI API IF**

### **用途**

- 通常RAG回答生成
- Bot判断理由生成
- Embedding生成
- Structured Output生成

### **接続方式**

|**項目**|**内容**|
|---|---|
|Protocol|HTTPS|
|Auth|API Key|
|Secret管理|`.env` または Secret Manager|
|呼出方式|Provider Adapter経由|
|Timeout|10秒|
|Retry|最大2回|
|Fallback|Gemini / Mistral / Claude|

### **送信禁止データ**

|**データ**|**方針**|
|---|---|
|API Key|送信禁止|
|Secret|送信禁止|
|JWT|送信禁止|
|個人情報|匿名化または送信禁止|
|出金情報|送信禁止|
|注文実行権限情報|送信禁止|

---

## **7.3 LLM Provider Adapter IF**

### **Interface**

```typescript
export interface LlmProvider {
  generateStructuredAnswer(
    input: RagPromptInput
  ): Promise<RagStructuredResponse>;

  generateSummary(
    input: RagSummaryInput
  ): Promise<RagSummaryResponse>;

  evaluateRisk(
    input: RagRiskInput
  ): Promise<RagRiskResponse>;

  getUsage(): Promise<LlmUsage>;
}
```

### **Adapter実装**

```text
OpenAiLlmProvider
ClaudeLlmProvider
GeminiLlmProvider
MistralLlmProvider
LocalLlmProvider
```

---

## **7.4 Embedding Provider Adapter IF**

```typescript
export interface EmbeddingProvider {
  embedText(input: string): Promise<number[]>;

  embedBatch(inputs: string[]): Promise<number[][]>;

  getDimension(): number;

  getModelName(): string;

  getProviderName(): string;
}
```

---

## **7.5 PMTP Market Service IF**

### **用途**

市場データ、テクニカル指標、特徴量をRAGへ取り込む。

### **Internal API想定**

```http
GET /api/v1/market/candles
GET /api/v1/market/indicators
GET /api/v1/market/features
```

### **取得データ**

|**データ**|**内容**|
|---|---|
|OHLCV|始値、高値、安値、終値、出来高|
|Indicators|RSI、MACD、ATR、VWAP|
|Funding Rate|仮想通貨向け|
|Open Interest|仮想通貨向け|
|Volume Spike|出来高急増判定|

---

## **7.6 PMTP Bot Service IF**

### **用途**

Training Botの設定、仮シグナル、BotログをRAG文脈に利用する。

### **Internal API想定**

```http
GET /api/v1/bots/{bot_id}
GET /api/v1/bots/{bot_id}/logs
GET /api/v1/bots/{bot_id}/signals
```

### **制約**

```text
RAGからBot設定変更APIは呼ばない。
RAGからBot起動・停止APIは呼ばない。
RAGから自動売買有効化APIは呼ばない。
```

---

## **7.7 PMTP Audit Service IF**

### **用途**

RAG問い合わせ、検索結果、回答、Provider利用量を監査ログとして保存する。

### **Internal API想定**

```http
POST /api/v1/audit/rag-events
```

### **Event例**

```json
{
  "trace_id": "trace_uuid",
  "event_type": "RAG_QUERY_COMPLETED",
  "actor_type": "training_bot",
  "actor_id": "uuid",
  "query_id": "uuid",
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "risk_level": "MEDIUM",
  "guardrail_status": "PASS",
  "created_at": "2026-06-09T00:00:00Z"
}
```

---

# **8. Webhook / 非同期IF**

## **8.1 Queue設計**

MVPではRedis Streamsを想定する。

|**Stream**|**用途**|
|---|---|
|rag.ingestion.requested|データ取込要求|
|rag.indexing.requested|Embedding生成要求|
|rag.provider_evaluation.requested|Provider評価要求|
|rag.audit.requested|監査ログ保存要求|

> ★v1.1: 全 Stream メッセージ payload に **`trace_id`（起点 API でサーバ発行した値）と `idempotency_key`（あれば）を必須フィールド**として含める。Worker 側のログ・DLQ 投入時も同 trace_id を維持し、API → Queue → Worker → DB の横断追跡を成立させる（B4）。

---

## **8.2 Ingestion Job状態**

```text
PENDING
FETCHING
NORMALIZED
INDEXING
INDEXED
FAILED
BLOCKED
```

---

## **8.3 Indexing Job状態**

```text
PENDING
CHUNKING
EMBEDDING
SAVING
COMPLETED
FAILED
BLOCKED
```

> ★v1.1（B7 整合）: 上記は **Indexing Job の API 表示サブステート**。DB 永続の正本は 05 §5.6 `rag_ingestion_jobs.status`（`PENDING` / `FETCHING` / `NORMALIZED` / `INDEXING` / `INDEXED` / `FAILED` / `BLOCKED`）。マッピング: `CHUNKING` + `EMBEDDING` + `SAVING` → DB `INDEXING`、`COMPLETED` → DB `INDEXED`、`FETCHING` / `NORMALIZED` は API では `PENDING` に内包。API はサブステートを返してよいが、永続値は 05 の 7 状態に集約する。

---

## **8.4 Provider Evaluation Job状態**

```text
PENDING
RUNNING
COMPLETED
FAILED
CANCELLED
```

---

# **9. ガードレール仕様**

## **9.1 必須検証**

|**検証**|**内容**|
|---|---|
|Prompt Injection検知|外部文書内の命令文を無効化|
|Secret Masking|API Key、JWT、個人情報をマスク|
|Output Schema Validation|LLM回答をJSON Schema検証|
|禁止表現検知|断定的投資助言、利益保証、注文命令を検知|
|Citation必須チェック|原則として回答に根拠ソースを含める|
|Citation whitelist検証|LLM 返却の chunk_id が**当該クエリの retrieval 集合（rag_retrieval_results）に実在すること**を検証。捏造 ID は citation ごと削除し、削除で citations が空になったら BLOCK（§6.1 / ★v1.1 / B2）|
|Citation品質検証|`quality_status` が ACTIVE 以外（QUARANTINED / DISABLED / STALE / LOW_RELIABILITY）の chunk を引用した回答は BLOCK 対象（★v1.1）|
|order_permission固定|常にfalse（コード上の literal false は**二次防御**。一次防御は RAG 用 DB ユーザーに Order/取引系テーブルの GRANT を付与しない**DB ロール物理遮断** / ★v1.1 注記）|

---

## **9.2 Guardrail Response**

```json
{
  "status": "PASS",
  "order_permission": false,
  "blocked_reasons": [],
  "warnings": [
    "External prediction market data is treated as sentiment, not fact."
  ]
}
```

---

# **10. Rate Limit / Cost Limit**

## **10.1 Rate Limit**

|**Client**|**Limit**|
|---|---|
|UI|60 requests / min|
|Training Bot|**120 requests / min / bot_id 単位**（★v1.1 改訂: クライアント種別合算ではなく bot_id ごとに独立カウント。暴走 Bot 1 体が他 Bot の枠を食い潰さない）|
|Worker|300 requests / min|
|Admin|60 requests / min|

### **10.1.1 Rate Limit の適用キーと IDOR 防御（★v1.1 新設）**

|**項目**|**内容**|
|---|---|
|適用キー|`X-Client-Type: training_bot` のリクエストは **JWT の subject claim に紐づく bot_id** をキーに集計する（リクエスト body の bot_id ではない）|
|JWT subject ↔ bot_id 一致検証|リクエスト body / path に `bot_id` を含む API（`/rag/bot-context` / `/rag/backtest-report` / `/rag/history?bot_id=` 等）では、**JWT subject に紐づく bot_id と一致することを必須検証**する。不一致は `403 RAG_FORBIDDEN`。他 Bot の ID を指定して文脈・履歴を取得する **IDOR（Insecure Direct Object Reference）を遮断**|
|超過時|`429 RAG_RATE_LIMITED` + `Retry-After: {秒}` 必須（§4.1）|
|履歴系の所有権検証|`GET /rag/history` / `GET /rag/history/{query_id}` は requester（JWT subject）が所有する query のみ返す（既存 §5.4「他人の履歴403」の機械的検証方法を JWT subject 照合として確定）|

---

## **10.2 Cost Limit**

|**項目**|**MVP上限**|
|---|---|
|月間LLM費|$50|
|月間Embedding費|$5|
|Provider比較費|$10|
|外部データ費|$30|
|月間総額|$100以内|

---

# **11. セキュリティ設計**

## **11.1 権限**

|**Role**|**許可**|
|---|---|
|USER|RAG問い合わせ、履歴閲覧|
|ADMIN|ソース管理、Provider設定、評価実行|
|SYSTEM|内部処理|
|TRAINING_BOT|RAG参照のみ|
|RAG_WORKER|取込、Indexing|
|RAG_EVALUATOR|Provider評価|

---

## **11.2 明確な禁止IF**

RAGから以下のIFは呼び出し禁止。

```text
POST /api/v1/orders
POST /api/v1/orders/cancel
POST /api/v1/bots/{bot_id}/start
POST /api/v1/bots/{bot_id}/stop
PATCH /api/v1/bots/{bot_id}/settings
POST /api/v1/risk-limits/relax
POST /api/v1/emergency/disable
```

---

# **12. OpenAPI化対象**

MVPでOpenAPI Schema化する対象は以下。

```text
POST /api/v1/rag/query
POST /api/v1/rag/bot-context
POST /api/v1/rag/similar-cases
GET  /api/v1/rag/history
GET  /api/v1/rag/history/{query_id}
POST /api/v1/rag/ingestions
POST /api/v1/rag/indexing/jobs
GET  /api/v1/rag/provider-usage
GET  /api/v1/rag/health
GET  /api/v1/rag/dashboard                          ← ★v1.1 追加（B8）
GET  /api/v1/rag/sources/{source_id}                ← ★v1.1 追加（B8）
POST /api/v1/rag/backtest-report                    ← ★v1.1 追加（B8）
GET  /api/v1/rag/admin/sources                      ← ★v1.1 追加（B8）
GET  /api/v1/rag/provider-evaluations/{job_id}      ← ★v1.1 追加（B8）
```

> ★v1.1: OpenAPI Schema では §3.4.3 の SourceType / BotSignal enum を components/schemas に**1 箇所だけ定義**し、各エンドポイントは `$ref` 参照する（enum SSoT / 値リテラルの再宣言禁止）。`Idempotency-Key` ヘッダは全 POST の required parameter として定義する。

---

# **13. MVP実装優先順位**

```text
1. 共通Response / Error定義
2. JWT認証・Role認可
3. RAG Query API
4. Bot Context API
5. Similar Cases API
6. RAG History API
7. Provider Adapter Interface
8. OpenAI Adapter
9. Embedding Adapter
10. Provider Usage Log
11. Guardrail / Output Validation
12. Ingestion API
13. Indexing Job API
14. Health Check API
15. Provider Evaluation API
```

---

# **14. 最終方針**

Training Bot RAG HubのAPIは、PMTP内のTraining Bot、AI Analysis UI、Backtest機能に対して、根拠付きの参照情報を返すためのRead-only APIとして設計する。

最重要ルールは以下。

```text
RAGは注文しない。
RAGはBot設定を変更しない。
RAGは緊急停止を解除しない。
RAGは判断材料だけを返す。
注文可否はTrading Engine / Risk Filter / Human Confirm側で判断する。
```

MVPでは、`RAG Query API`、`Bot Context API`、`Similar Cases API`、`History API`、`Provider Usage API` を優先実装する。