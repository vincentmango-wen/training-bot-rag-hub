**Training Bot RAG Hub Provider Policy設計書 v1.0**

**1. 文書情報**

|   |   |
|---|---|
|**項目**|**内容**|
|文書名|Provider Policy設計書|
|対象システム|PMTP - Training Bot RAG Hub|
|文書種別|アプリケーション設計書|
|版数|v1.0|
|作成日|2026-06-09|
|対象フェーズ|MVP〜Phase4|
|関連文書|企画書、要件定義書、アーキテクチャ設計書|

  

⸻

  

**2. 目的**

Provider Policyは、

- OpenAI固定実装を回避する
- Provider切替を統一管理する
- コスト最適化する
- 障害耐性を確保する
- 金融システムとして安全な出力を保証する

ための意思決定レイヤーである。

要件定義で定義された

OpenAI First

Vendor Lock-in Never

Provider Adapter Mandatory

Evaluate Before Expansion

を実現するための中核コンポーネントである。  

  

⸻

  

**3. Provider Policyの責務**

**3.1 管理対象**

|   |   |
|---|---|
|**対象**|**内容**|
|Provider選択|OpenAI / Claude / Gemini / Mistral / Local|
|Model選択|Provider毎の利用モデル|
|Fallback制御|障害時切替|
|コスト制御|予算超過防止|
|品質制御|評価スコア反映|
|安全制御|危険タスク制御|
|利用制限|月額上限管理|
|Provider停止|強制利用停止|

  

⸻

  

**4. 設計原則**

**PP-001 OpenAI First**

MVPではOpenAIを標準利用する。

理由：

- Structured Output
- Embedding統合
- TypeScript親和性
- 実装速度

要件定義準拠。  

  

⸻

  

**PP-002 Lock-in禁止**

禁止事項

if provider == "openai"

のようなアプリケーションコード内の分岐。

  

必ず

LlmProvider

EmbeddingProvider

インターフェース経由で利用する。  

  

⸻

  

**PP-003 安全性優先**

金融システムのため

速度 > 品質

ではなく

安全性 > 品質 > コスト > 速度

を優先する。

  

⸻

  

**5. Task分類**

Provider PolicyはまずTaskを分類する。

export enum RagTaskType {

  MARKET_SUMMARY,

  BOT_EXPLANATION,

  RISK_REVIEW,

  SIMILAR_CASE_ANALYSIS,

  EXTERNAL_NEWS_SUMMARY,

  BACKTEST_REPORT,

  PROVIDER_EVALUATION,

  EMBEDDING,

  HIGH_CONFIDENTIAL_ANALYSIS

}

  

⸻

  

**6. Provider選択ポリシー**

**6.1 MVP**

|   |   |   |
|---|---|---|
|**Task**|**Primary**|**Fallback**|
|MARKET_SUMMARY|OpenAI Mini|Gemini Flash|
|BOT_EXPLANATION|OpenAI|Claude|
|RISK_REVIEW|Claude|OpenAI|
|SIMILAR_CASE_ANALYSIS|OpenAI|Gemini|
|EXTERNAL_NEWS_SUMMARY|Gemini|OpenAI|
|BACKTEST_REPORT|OpenAI|Claude|
|PROVIDER_EVALUATION|OpenAI|Gemini|
|EMBEDDING|OpenAI Small|Voyage|
|HIGH_CONFIDENTIAL_ANALYSIS|Local LLM|なし|

要件定義のProvider選択方針を実装レベルへ具体化する。  

  

⸻

  

**7. Provider選択アルゴリズム**

**Step1**

Task判定

MARKET_SUMMARY

BOT_EXPLANATION

RISK_REVIEW

...

  

⸻

  

**Step2**

Policy読込

provider_policy

取得

  

⸻

  

**Step3**

Provider稼働確認

ProviderHealth

確認

  

⸻

  

**Step4**

予算確認

monthly_cost

確認

  

⸻

  

**Step5**

Primary選択

  

⸻

  

**Step6**

実行

  

⸻

  

**Step7**

Schema検証

  

⸻

  

**Step8**

失敗時Fallback

  

⸻

  

**Step9**

監査ログ保存

  

⸻

  

**8. Policy設定テーブル**

**rag_provider_policies**

|   |   |
|---|---|
|**列名**|**型**|
|id|UUID|
|task_type|VARCHAR|
|primary_provider|VARCHAR|
|primary_model|VARCHAR|
|fallback_provider|VARCHAR|
|fallback_model|VARCHAR|
|max_cost_per_query|DECIMAL|
|max_latency_ms|INT|
|enabled|BOOLEAN|
|created_at|TIMESTAMP|
|updated_at|TIMESTAMP|

  

⸻

  

**サンプル**

{

  "task_type": "BOT_EXPLANATION",

  "primary_provider": "openai",

  "primary_model": "gpt-5-mini",

  "fallback_provider": "claude",

  "fallback_model": "sonnet",

  "max_cost_per_query": 0.03,

  "max_latency_ms": 5000

}

  

⸻

  

**9. Health Check Policy**

**Provider状態**

enum ProviderHealth {

  HEALTHY,

  DEGRADED,

  UNAVAILABLE

}

  

⸻

  

**HEALTHY**

利用可能

  

⸻

  

**DEGRADED**

条件

エラー率 > 5%

または

平均Latency > 10秒

  

⸻

  

**UNAVAILABLE**

条件

API障害

認証失敗

レート制限超過

  

⸻

  

**10. Fallback Policy**

**10.1 一次Fallback**

OpenAI

 ↓

Claude

  

⸻

  

**10.2 二次Fallback**

Claude

 ↓

Gemini

  

⸻

  

**10.3 三次Fallback**

Gemini

 ↓

Mistral

  

⸻

  

**10.4 全失敗**

要件定義準拠。

{

  "mode": "retrieval_only",

  "llm_used": false

}

  

⸻

  

**11. コスト制御Policy**

コスト見積書で定義された上限を利用する。  

**月額制限**

|   |   |
|---|---|
|**項目**|**上限**|
|LLM|$50|
|Embedding|$5|
|Provider比較|$10|
|外部データ|$30|

  

⸻

  

**超過時**

**Level1**

OpenAI → Miniモデル固定

  

⸻

  

**Level2**

高コストモデル停止

  

⸻

  

**Level3**

Provider評価停止

  

⸻

  

**Level4**

管理者通知

  

⸻

  

**12. Quality Policy**

Provider評価結果を利用する。

**評価指標**

|   |   |
|---|---|
|**指標**|**閾値**|
|Schema成功率|99%以上|
|Citation整合率|95%以上|
|Hallucination率|5%未満|
|Risk Coverage|90%以上|
|Safety違反率|0%|

評価要件準拠。  

  

⸻

  

**13. Security Policy**

**利用禁止条件**

以下を検出した場合

Prompt Injection

Tool Injection

Secret要求

注文要求

Provider呼び出し前にBLOCKする。

要件・セキュリティ試験仕様準拠。

  

⸻

  

**強制付与**

全Provider共通

{

  "order_permission": false

}

  

⸻

  

**Secret送信禁止**

送信前マスキング

API Key

JWT

Secret

個人情報

  

⸻

  

**14. Provider Evaluation Policy**

**実施タイミング**

|   |   |
|---|---|
|**条件**|**実施**|
|月次|必須|
|新Provider追加|必須|
|料金変更|必須|
|品質劣化|必須|
|障害多発|必須|

コスト見積書準拠。  

  

⸻

  

**Dataset**

RAG-EVAL-001

RAG-EVAL-002

RAG-EVAL-003

RAG-EVAL-004

RAG-EVAL-005

RAG-EVAL-006

RAG-EVAL-007

RAG-EVAL-008

要件定義準拠。  

  

⸻

  

**15. 監査ログ要件**

保存項目

{

  "provider": "openai",

  "model": "gpt-5-mini",

  "task_type": "BOT_EXPLANATION",

  "input_tokens": 3000,

  "output_tokens": 800,

  "estimated_cost": 0.005,

  "latency_ms": 2100,

  "fallback_used": false,

  "trace_id": "uuid"

}

監査要件・コスト管理要件準拠。

  

⸻

  

**16. Provider Policy API**

**GET**

GET /api/v1/provider-policies

一覧取得

  

⸻

  

**POST**

POST /api/v1/provider-policies

作成

  

⸻

  

**PUT**

PUT /api/v1/provider-policies/{id}

更新

  

⸻

  

**POST**

POST /api/v1/provider-policies/test

動作確認

  

⸻

  

**17. MVP実装範囲**

**実装**

- Provider Policy Engine
- OpenAI Provider
- Fallback Framework
- Cost Control
- Health Check
- Provider Usage Log
- Provider Evaluation基盤

  

⸻

  

**未実装**

- AIによる自動Provider最適化
- 動的コスト予測
- Provider自動学習
- 自律的ルーティング最適化

  

⸻

  

**18. 成功基準**

|   |   |
|---|---|
|**ID**|**基準**|
|PP-AC-001|OpenAI障害時にFallbackできる|
|PP-AC-002|Provider切替時にRAG本体改修不要|
|PP-AC-003|Schema成功率99%以上|
|PP-AC-004|Provider利用履歴100%保存|
|PP-AC-005|Secret送信0件|
|PP-AC-006|order_permission=true 0件|
|PP-AC-007|全Provider停止時にRetrieval Onlyへ移行|
|PP-AC-008|月額予算上限を超えない|
|PP-AC-009|Provider評価を月次実施できる|
|PP-AC-010|Trading Engineへの影響0件|

この設計書は、要件定義書の「9. LLM Provider要件」を実装レベルまで落とし込む補完設計書として位置付けるのが適切です。