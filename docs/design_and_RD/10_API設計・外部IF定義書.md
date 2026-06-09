以下で作成します。前提は企画書・要件定義書の方針に合わせています。RAGは注文APIを呼ばず、Training Bot / UI 向けの参照APIに限定します。 

---

# **Personal Multi Trading Platform**

# **Training Bot RAG Hub API設計・外部IF定義書 v1.0**

## **1. 文書情報**

|**項目**|**内容**|
|---|---|
|文書名|Training Bot RAG Hub API設計・外部IF定義書|
|対象システム|Personal Multi Trading Platform（PMTP）|
|対象機能|Training Bot参照用RAG基盤|
|文書種別|API設計・外部IF定義書|
|版数|v1.0|
|作成日|2026-06-09|
|対象フェーズ|MVP / Provider比較 / 外部情報RAG|

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
|Traceable|全APIで `trace_id` を扱う|

---

## **3. 共通API仕様**

### **3.1 Base URL**

```text
Local MVP:
http://localhost:3000/api/v1

Future Cloud:
https://api.pmtp.example.com/api/v1
```

---

### **3.2 認証方式**

|**項目**|**内容**|
|---|---|
|認証方式|JWT Bearer Token|
|Header|Authorization: Bearer {access_token}|
|MVP|ローカル開発では一部mock可|
|本番|必須|

---

### **3.3 共通Header**

```http
Authorization: Bearer {jwt}
Content-Type: application/json
X-Trace-Id: trace_uuid
X-Client-Type: ui | training_bot | system | worker
```

---

### **3.4 共通Response形式**

#### **Success**

```json
{
  "success": true,
  "data": {},
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

#### **Error**

```json
{
  "success": false,
  "error": {
    "code": "RAG_VALIDATION_ERROR",
    "message": "Invalid request payload",
    "details": []
  },
  "meta": {
    "trace_id": "trace_uuid",
    "request_id": "request_uuid",
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

---

## **4. エラーコード定義**

|**Code**|**HTTP**|**内容**|
|---|---|---|
|RAG_VALIDATION_ERROR|400|リクエスト形式不正|
|RAG_UNAUTHORIZED|401|認証エラー|
|RAG_FORBIDDEN|403|権限不足|
|RAG_NOT_FOUND|404|対象データなし|
|RAG_GUARDRAIL_BLOCKED|422|ガードレールでブロック|
|RAG_PROVIDER_ERROR|502|LLM Providerエラー|
|RAG_PROVIDER_TIMEOUT|504|LLM Providerタイムアウト|
|RAG_INTERNAL_ERROR|500|内部エラー|
|RAG_RATE_LIMITED|429|レート制限|
|RAG_COST_LIMIT_EXCEEDED|429|コスト上限超過|

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

---

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

### **Response**

```json
{
  "success": true,
  "data": {
    "query_id": "uuid",
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
        "used_reason": "出来高増加の根拠として使用"
      }
    ],
    "llm": {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "fallback_used": false,
      "input_tokens": 3200,
      "output_tokens": 760,
      "estimated_cost": 0.0061,
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
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

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
    "atr": 0.034,
    "funding_rate": 0.012
  },
  "provider_policy": "risk_aware"
}
```

### **Response**

```json
{
  "success": true,
  "data": {
    "context_id": "uuid",
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
        "max_drawdown_pct": -1.8,
        "max_favorable_excursion_pct": 3.2
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
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

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
    "price_change_pct_24h": 4.2
  },
  "lookback_days": 365,
  "limit": 10
}
```

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
        "after_move_4h_pct": 2.4,
        "after_move_24h_pct": -0.8,
        "max_drawdown_pct": -2.1,
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
    "timestamp": "2026-06-09T00:00:00Z"
  }
}
```

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
      "estimated_cost": 0.0061,
      "latency_ms": 1850
    }
  }
}
```

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
    "status": "PENDING"
  }
}
```

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
    "status": "PENDING"
  }
}
```

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
    "total_estimated_cost": 18.42,
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
        "estimated_cost": 17.55,
        "avg_latency_ms": 1820
      }
    ]
  }
}
```

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
|order_permission固定|常にfalse|

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
|Training Bot|120 requests / min|
|Worker|300 requests / min|
|Admin|60 requests / min|

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
```

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