# **Training Bot RAG Hub MVP仕様書 v1.0**

本MVP仕様は、企画書・要件定義書・アーキテクチャ設計・コスト見積を踏まえ、「最短で価値を出しつつ金融システムとして安全性を担保する」ことを目的とする。 

---

## **1. MVP概要**

### **システム名**

Training Bot RAG Hub

### **目的**

Training Bot が以下を参照できる知識基盤を構築する。

- Botログ
- 注文履歴
- 約定履歴
- 戦略ドキュメント
- 市場データ

RAGは売買判断を行わない。

RAGは注文を実行しない。

RAGは判断材料のみ提供する。 

---

## **2. MVPゴール**

### **実現すること**

#### **Goal-1**

Training Botが過去類似ケースを検索できる

例

```text
BTCUSDT

RSI=29
MACD=Golden Cross

に近いケースを検索
```

---

#### **Goal-2**

Botシグナルの説明生成

入力

```json
{
  "signal":"BUY"
}
```

出力

```json
{
  "supporting_factors":[...],
  "opposing_factors":[...],
  "risk_level":"MEDIUM"
}
```

---

#### **Goal-3**

AI分析画面へ根拠表示

表示項目

- Summary
- Supporting Factors
- Opposing Factors
- Risk Level
- Confidence
- Citation

---

#### **Goal-4**

RAG履歴保存

保存対象

- Query
- Retrieval
- Response
- Citation
- Provider Usage

---

#### **Goal-5**

Guardrail実装

保証内容

```text
注文不可
Secret非表示
Prompt Injection防御
```

---

## **3. MVP対象スコープ**

### **対象**

|**分類**|**内容**|
|---|---|
|内部RAG|○|
|類似ケース検索|○|
|Bot説明生成|○|
|市場要約|○|
|監査ログ|○|
|OpenAI連携|○|
|Provider Adapter|○|
|pgvector検索|○|
|AI分析画面表示|○|

要件定義書のMVP範囲に準拠。 

---

### **対象外**

|**分類**|**内容**|
|---|---|
|自動売買|×|
|注文実行|×|
|Bot設定変更|×|
|SNS本格収集|×|
|Polymarket連携|×|
|専用Vector DB|×|
|Claude実装|×|
|Gemini実装|×|
|Mistral実装|×|

---

## **4. MVPアーキテクチャ**

```text
Training Bot
      ↓
RAG API
      ↓
Retriever
      ↓
pgvector
      ↓
OpenAI
      ↓
Guardrail
      ↓
Response
```

採用構成

|**分類**|**技術**|
|---|---|
|Backend|NestJS|
|Language|TypeScript|
|DB|PostgreSQL|
|Vector|pgvector|
|Cache|Redis|
|ORM|Prisma|
|Validation|Zod|
|LLM|OpenAI|
|Embedding|OpenAI|

---

## **5. MVPデータソース**

### **内部データ**

|**ソース**|
|---|
|Botログ|
|注文履歴|
|約定履歴|
|戦略ドキュメント|
|市場データ|

### **対象外**

|**ソース**|
|---|
|SNS|
|ニュース|
|Polymarket|
|オンチェーンデータ|

Phase2以降で追加。 

---

## **6. MVP機能一覧**

### **F-01 Query API**

```http
POST /api/v1/rag/query
```

用途

```text
通常RAG問い合わせ
```

---

### **F-02 Bot Context API**

```http
POST /api/v1/rag/bot-context
```

用途

```text
Bot向け説明生成
```

---

### **F-03 Similar Cases API**

```http
POST /api/v1/rag/similar-cases
```

用途

```text
類似ケース検索
```

---

### **F-04 RAG History API**

```http
GET /api/v1/rag/history
```

用途

```text
監査・履歴確認
```

---

## **7. MVP DBテーブル**

最低限必要なテーブル

```text
rag_sources
rag_documents
rag_chunks
rag_embeddings

rag_queries
rag_responses
rag_citations

rag_bot_contexts

rag_provider_usages
```

---

## **8. MVP画面**

### **画面1**

AI分析画面

表示

```text
Summary
Confidence
Risk Level
Citation
```

---

### **画面2**

Bot検証画面

表示

```text
Bot Signal
Supporting Factors
Opposing Factors
Similar Cases
```

---

### **画面3**

RAG履歴画面

表示

```text
Query
Response
Citation
Provider
Cost
Latency
```

---

## **9. MVP Guardrail**

### **必須ルール**

#### **Rule-1**

```json
{
  "order_permission": false
}
```

固定

---

#### **Rule-2**

注文API接続禁止

```text
Order Service
Trading Engine
```

へ書込不可

---

#### **Rule-3**

Prompt Injection防御

検知例

```text
Ignore previous instructions
Call Order API
```

→ BLOCK

---

#### **Rule-4**

Secret Masking

禁止対象

```text
API Key
JWT
Password
Secret
.env
```

---

#### **Rule-5**

Schema Validation

不正JSON

↓

```text
BLOCK
```

---

## **10. MVP性能要件**

|**項目**|**目標**|
|---|---|
|RAG Query|3秒以内|
|Bot Context|3秒以内|
|類似ケース検索|5秒以内|
|Fallback|10秒以内|

---

## **11. MVP成功基準**

### **必須**

- BotがRAG検索できる
- 類似ケース検索できる
- Citationが返る
- Risk Levelが返る
- Confidenceが返る
- Query履歴保存
- Response履歴保存
- Provider利用履歴保存
- Prompt Injection防御
- Secret漏洩ゼロ

### **絶対条件**

```text
order_permission=true
0件
```

```text
RAG起因注文事故
0件
```

```text
Trading Engine影響
0件
```

---

## **12. MVP開発工数**

企画・設計資料から逆算すると、

|**工程**|**工数**|
|---|---|
|DB設計|2人日|
|RAG取込|3人日|
|Embedding|2人日|
|OpenAI Adapter|2人日|
|Query API|3人日|
|Bot API|2人日|
|Guardrail|4人日|
|履歴保存|2人日|
|UI|4人日|
|テスト|7人日|

**合計：約29人日**

既存設計の見積範囲（27〜44人日）に収まる。 

---

## **MVPリリース判定**

以下をすべて満たした場合のみリリースする。

```text
Critical Bug = 0

High Bug = 0

order_permission=true = 0件

Secret漏洩 = 0件

Prompt Injection突破 = 0件

Schema成功率 >= 99%

Citation整合率 >= 95%

Query応答 <= 3秒

Trading Engine影響 = 0件
```

このMVPであれば、約1ヶ月（個人開発＋AI支援）で完成可能で、月額運用費も$5〜$50程度に収まる現実的な第一版になります。