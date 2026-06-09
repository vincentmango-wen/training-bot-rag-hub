# **Retrieval評価設計書 v1.0**

**対象システム:** Training Bot RAG Hub**対象フェーズ:** MVP / Phase2**文書種別:** Retrieval Evaluation Design Specification

---

# **1. 目的**

本設計書は、Training Bot RAG HubにおけるRetrieval（検索）の品質を定量評価するための基準を定義する。

RAG品質は以下で構成される。

```text
RAG品質
=
Retrieval品質
+
Reranking品質
+
Generation品質
+
Guardrail品質
```

このうち本書は Retrieval 部分のみを対象とする。

RAG Hubでは検索品質が低い場合、

- 根拠不足
- Hallucination増加
- Citation不整合
- 類似ケース誤判定
- Bot説明品質低下

を引き起こすため、継続的評価が必須である。  

---

# **2. 評価対象**

## **2.1 評価範囲**

対象：

```text
Query
 ↓
Embedding
 ↓
Vector Search
 ↓
Metadata Filter
 ↓
Hybrid Search
 ↓
Reranking前結果
```

対象外：

```text
LLM生成品質
Guardrail品質
JSON Schema品質
Provider品質
```

---

## **2.2 評価コンポーネント**

|**コンポーネント**|**評価対象**|
|---|---|
|Embedding Provider|ベクトル品質|
|pgvector Search|検索品質|
|Metadata Filter|絞込精度|
|Hybrid Search|検索精度|
|Similarity Search|類似ケース品質|
|Chunking Strategy|チャンク品質|
|Reranker|再ランキング品質|

---

# **3. 評価方針**

## **3.1 評価原則**

金融RAGのため、

```text
Recall重視
↓
Precision重視
↓
Latency重視
```

の順で評価する。

  

理由：

  

検索漏れは重大リスクになる。

  

不要情報混入より、

```text
重要情報を取得できない
```

方が危険である。

---

## **3.2 評価レベル**

|**レベル**|**内容**|
|---|---|
|L1|Chunk検索精度|
|L2|Document検索精度|
|L3|類似ケース検索精度|
|L4|市場文脈検索精度|
|L5|実運用クエリ精度|

---

# **4. 評価データセット**

## **4.1 Retrieval Dataset**

Dataset ID:

```text
RET-EVAL-001
```

目的：

```text
通常検索品質評価
```

件数：

```text
300 Query
```

---

## **4.2 Similar Case Dataset**

Dataset ID:

```text
RET-EVAL-002
```

目的：

```text
類似ケース検索評価
```

件数：

```text
200 Query
```

---

## **4.3 Market Context Dataset**

Dataset ID:

```text
RET-EVAL-003
```

目的：

```text
市場文脈検索評価
```

件数：

```text
100 Query
```

---

## **4.4 Multilingual Dataset**

Dataset ID:

```text
RET-EVAL-004
```

目的：

```text
日本語
英語
中国語
```

件数：

```text
各50 Query
```

多言語対応要件に対応する。  

---

# **5. Ground Truth設計**

## **5.1 基本構造**

```json
{
  "query_id": "RET-001",
  "query": "BTCUSDT急騰の過去類似ケース",
  "expected_chunks": [
    "chunk-1001",
    "chunk-1022",
    "chunk-1048"
  ],
  "expected_documents": [
    "doc-88",
    "doc-102"
  ]
}
```

---

## **5.2 類似ケース**

```json
{
  "query_id": "SIM-001",
  "features": {
    "rsi": 29,
    "macd": "golden_cross",
    "volume_spike": true
  },
  "expected_cases": [
    "case-2025-08-18",
    "case-2025-11-02"
  ]
}
```

類似ケース検索要件に対応する。  

---

# **6. 評価指標**

## **6.1 Recall@K**

定義

```text
Ground Truth中
何件取得できたか
```

式

```text
Recall@K
=
Relevant Retrieved
/
All Relevant
```

例

```text
Relevant = 10

取得 = 8

Recall@10 = 0.80
```

---

## **6.2 Precision@K**

定義

```text
取得結果が
どれだけ正しかったか
```

式

```text
Precision@K
=
Relevant Retrieved
/
K
```

例

```text
Top10中
8件正解

Precision@10 = 0.80
```

---

## **6.3 MRR**

Mean Reciprocal Rank

定義

```text
最初の正解が
何位だったか
```

式

```text
MRR
=
1/rank
```

例

```text
1位なら 1.0
2位なら 0.5
5位なら 0.2
```

---

## **6.4 NDCG**

定義

```text
順位品質
```

重要情報が上位にあるかを測定する。

---

## **6.5 Hit Rate**

定義

```text
TopK内に
正解が存在する割合
```

例

```text
100 Query中

90 Queryで正解取得

Hit Rate = 90%
```

---

# **7. 評価基準**

## **7.1 MVP基準**

|**指標**|**目標**|
|---|---|
|Recall@10|85%以上|
|Precision@10|80%以上|
|MRR|0.75以上|
|HitRate@10|90%以上|
|NDCG@10|0.80以上|

---

## **7.2 類似ケース基準**

|**指標**|**目標**|
|---|---|
|Recall@5|80%以上|
|Precision@5|80%以上|
|HitRate@5|90%以上|

類似ケース検索成功率目標と整合する。  

---

## **7.3 多言語基準**

|**言語**|**Recall@10**|
|---|---|
|日本語|85%以上|
|英語|85%以上|
|中国語|80%以上|

---

# **8. Chunking評価**

## **8.1 比較対象**

|**方式**|**内容**|
|---|---|
|Chunk-A|500 tokens|
|Chunk-B|800 tokens|
|Chunk-C|1000 tokens|
|Chunk-D|Semantic Chunking|

---

## **8.2 評価項目**

|**項目**|**内容**|
|---|---|
|Recall||
|Precision||
|Latency||
|Embedding Cost||
|Storage Size||

---

## **8.3 採用基準**

```text
Recallを最優先

Recall差が小さい場合

Precision

↓

Latency

↓

Cost
```

---

# **9. Embedding評価**

## **9.1 対象**

MVP対象Embedding Provider。  

|**Provider**|
|---|
|OpenAI small|
|OpenAI large|
|Gemini Embedding|
|Voyage|
|Mistral Embed|

---

## **9.2 評価項目**

|**項目**|**内容**|
|---|---|
|Recall@10||
|Precision@10||
|Latency||
|Cost||
|多言語性能||

---

## **9.3 MVP採用基準**

```text
Recall@10 >= 85%

かつ

最も低コスト
```

---

# **10. Metadata Filter評価**

要件で必須。  

## **評価ケース**

### **Case1**

```json
{
  "symbol": "BTCUSDT"
}
```

期待：

```text
ETH除外
```

---

### **Case2**

```json
{
  "source_type": "news"
}
```

期待：

```text
Bot Log除外
```

---

### **Case3**

```json
{
  "timeframe": "1h"
}
```

期待：

```text
他timeframe除外
```

---

## **合格基準**

```text
Filter Accuracy
=
99%以上
```

---

# **11. Hybrid Search評価**

## **対象**

```text
Vector検索
+
Keyword検索
```

---

## **比較**

|**方式**|
|---|
|Vector Only|
|Keyword Only|
|Hybrid|

---

## **評価基準**

```text
Hybridが

Recall

Precision

ともに改善
```

---

# **12. 類似ケース評価**

対象ユースケース。  

## **入力例**

```json
{
  "rsi": 29,
  "macd": "golden_cross",
  "volume_spike": true
}
```

---

## **評価項目**

|**項目**|
|---|
|Case Recall|
|Case Precision|
|Similarity Score妥当性|
|最大逆行幅整合性|
|最大順行幅整合性|

---

## **合格基準**

```text
Case Recall ≥ 80%

Case Precision ≥ 80%
```

---

# **13. Latency評価**

性能要件準拠。  

## **計測対象**

|**項目**|**目標**|
|---|---|
|Vector Search|500ms以内|
|Metadata Filter|100ms以内|
|Hybrid Search|1秒以内|
|Similar Case Search|3秒以内|

---

## **負荷条件**

```text
100,000 chunks
100 concurrent users
```

---

# **14. 継続評価運用**

## **実行頻度**

|**頻度**|**内容**|
|---|---|
|PR作成時|サンプル評価|
|Release前|全件評価|
|月次|Retrieval回帰評価|
|Embedding変更時|必須|
|Chunking変更時|必須|

---

## **保存テーブル**

```text
rag_retrieval_evaluations
```

---

## **保存項目**

```json
{
  "dataset_id": "RET-EVAL-001",
  "retriever": "pgvector",
  "embedding_model": "text-embedding-3-small",
  "recall_at_10": 0.87,
  "precision_at_10": 0.82,
  "mrr": 0.79,
  "ndcg": 0.83,
  "executed_at": "datetime"
}
```

---

# **15. 品質ゲート**

## **Gate-R1**

```text
Recall@10 >= 85%
```

---

## **Gate-R2**

```text
Precision@10 >= 80%
```

---

## **Gate-R3**

```text
HitRate@10 >= 90%
```

---

## **Gate-R4**

```text
Metadata Filter Accuracy >= 99%
```

---

## **Gate-R5**

```text
Latency要件達成
```

---

# **16. 最終受入基準**

以下をすべて満たした場合のみRetrieval品質を合格とする。

|**項目**|**基準**|
|---|---|
|Recall@10|85%以上|
|Precision@10|80%以上|
|MRR|0.75以上|
|NDCG|0.80以上|
|HitRate@10|90%以上|
|Metadata Accuracy|99%以上|
|Case Recall|80%以上|
|Case Precision|80%以上|
|Vector Search|500ms以内|
|Hybrid Search|1秒以内|
|重大欠陥|0件|

```text
RetrievalはRAG品質の土台である。

Recall不足の状態で
LLMを改善しても意味がない。

まずRetrieval品質を基準値まで上げることを
最優先とする。
```