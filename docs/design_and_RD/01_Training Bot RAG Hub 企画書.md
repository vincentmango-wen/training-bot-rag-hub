# Personal Multi Trading Platform

# Training Bot RAG Hub 企画書

---

## 1. 企画概要

### 1.1 企画名

Training Bot RAG Hub  
別名：PMTP Intelligence Reference Layer

### 1.2 対象システム

Personal Multi Trading Platform（PMTP）

### 1.3 企画目的

本企画は、PMTP内で作成予定のトレーニングボットが、外部情報・市場データ・過去検証結果・取引ルール・リスク情報を参照できるRAG基盤を構築することを目的とする。

このRAGは、直接注文を実行するものではない。  
役割は、トレーニングボットに対して以下を提供することである。

- 市場状況の文脈整理
    
- 売買シナリオの根拠提示
    
- 過去類似ケースの検索
    
- リスク要因の抽出
    
- Bot学習・検証用の説明データ生成
    
- 判断理由の可視化
    
- 将来のAI分析機能・Bot機能との接続基盤
    

---

## 2. 背景

PMTPは、株・FX・仮想通貨を統合管理する個人投資プラットフォームであり、将来的にはAI分析・Bot制御・自動売買支援を含む構想を持つ。

一方で、金融システムでは誤発注・Bot暴走・AI誤判定・ハルシネーションが重大リスクとなる。  
そのため、AIやRAGの出力をそのまま注文に使うのではなく、まずはトレーニングボットが参照する知識基盤として導入する。

本RAGは、PMTPの取引エンジンとは分離し、学習・検証・説明生成・市場文脈整理を担う。

---

## 3. 企画コンセプト

### 3.1 基本思想

本RAGは、以下の思想で設計する。

|方針|内容|
|---|---|
|Reference First|売買実行ではなく参照基盤として使う|
|Human-in-the-loop|最終判断は人間または既存ルール側で行う|
|Explainability|なぜその見方になったかを説明する|
|Risk-aware|常にリスク要因を併記する|
|Source-grounded|根拠ソースを明示する|
|Read-only First|初期は注文APIへ接続しない|
|Simulation First|まずは検証・学習・バックテスト支援に限定する|

### 3.2 RAGの位置づけ

PMTP全体の中で、本RAGは以下の位置に置く。

```text
Market Data / External Data / Internal Logs / Strategy Docs
        ↓
Training Bot RAG Hub
        ↓
Training Bot / Backtest Bot / AI Analysis UI
        ↓
Human Review / Rule Engine / Risk Filter
        ↓
Trading Engine
```

重要なのは、RAGからTrading Engineへ直接注文を流さないこと。  
RAGは判断材料を作るだけで、注文可否は別レイヤーで判定する。

---

## 4. 解決したい課題

### 4.1 現状課題

|課題ID|課題|内容|
|---|---|---|
|P-001|市場情報が分散している|価格、ニュース、SNS、予測市場、Botログが別々に存在する|
|P-002|Bot判断の根拠が残りにくい|なぜその判断に至ったかを後から追跡しにくい|
|P-003|AI出力の信頼性が不明|AIが何を根拠に回答したか見えない|
|P-004|過去ケースを活用しづらい|似た相場・似たBot挙動を検索できない|
|P-005|トレーニングデータ整備が弱い|Bot学習・検証用の説明付きデータが不足している|
|P-006|外部センチメントを扱いにくい|Polymarket、SNS、ニュースなどを投資判断に安全に組み込みにくい|

### 4.2 解決方針

RAGを導入し、以下を実現する。

- 分散情報の一元検索
    
- Bot判断理由の生成
    
- 類似相場ケース検索
    
- 外部センチメントの要約
    
- リスク要因の抽出
    
- 出力根拠の保存
    
- バックテスト・検証レポート生成
    

---

## 5. 対象ユーザー

|ユーザー|利用目的|
|---|---|
|個人投資家本人|市場理解、Bot検証、投資判断補助|
|トレーニングボット|過去データ・外部情報・リスク情報の参照|
|AI分析画面|シグナル理由・根拠・注意点の表示|
|将来のBot Engine|ルール評価時の補助情報取得|
|システム管理者|RAG回答履歴・ソース品質・異常出力の確認|

---

## 6. 対象スコープ

### 6.1 MVP対象

MVPでは以下を対象とする。

|分類|対象|
|---|---|
|内部データ|Bot設定、戦略ルール、注文履歴、約定履歴、ポジション履歴、監査ログ|
|市場データ|OHLCV、RSI、MACD、ATR、出来高、Funding Rate、Open Interest|
|外部データ|ニュース要約、予測市場データ、SNS要約|
|RAG機能|検索、要約、類似ケース抽出、リスク抽出、根拠提示|
|Bot連携|トレーニングボットへのRead-only API提供|
|UI連携|AI分析画面・Bot検証画面への表示|
|安全制御|注文API非接続、出力バリデーション、監査ログ保存|

### 6.2 MVP対象外

以下はMVPでは対象外とする。

|対象外|理由|
|---|---|
|RAGによる自動発注|危険性が高い|
|Polymarketでの取引実行|法規制・利用制約リスクがある|
|SNS投稿の真偽断定|信頼性保証ができない|
|利益保証・勝率保証|不可能|
|投資助言としての断定表現|法務・倫理リスクが高い|
|完全自律Bot|初期段階では危険|
|マルチ市場本番接続|MVPでは複雑すぎる|
|高頻度取引向け低遅延RAG|RAGは低遅延売買に向かない|

---

## 7. RAGの主なユースケース

### UC-RAG-001 市場文脈検索

トレーニングボットが、現在の相場に関連するニュース・予測市場・過去相場・内部ログを検索する。

入力例：

```text
BTCUSDTが急騰している。直近で関連しそうな外部要因と過去類似ケースを取得して。
```

出力例：

```json
{
  "summary": "直近の急騰は出来高増加と外部イベント期待が重なっている可能性がある。",
  "related_factors": [
    "出来高急増",
    "Funding Rate上昇",
    "予測市場でリスクオン材料が増加"
  ],
  "similar_cases": [
    {
      "date": "2025-xx-xx",
      "condition": "RSI上昇 + Volume Spike",
      "after_move": "+3.2% / 4h"
    }
  ],
  "risk_notes": [
    "急騰後の反落リスク",
    "出来高低下時の失速リスク"
  ],
  "confidence": 0.68
}
```

---

### UC-RAG-002 Bot判断理由生成

Botが出した仮シグナルに対して、RAGが理由と反対材料を生成する。

入力例：

```json
{
  "symbol": "BTCUSDT",
  "bot_signal": "BUY",
  "features": {
    "rsi": 29,
    "macd": "golden_cross",
    "volume_spike": true
  }
}
```

出力例：

```json
{
  "explanation": "RSIが売られすぎ圏にあり、MACDも上向き転換しているため、短期反発シナリオを支持する材料がある。",
  "supporting_factors": [
    "RSI oversold",
    "MACD golden cross",
    "Volume spike"
  ],
  "opposing_factors": [
    "上位足トレンドが下落の場合は反発が短命になる可能性",
    "急変動時はスリッページが拡大する可能性"
  ],
  "risk_level": "MEDIUM",
  "action_policy": "ORDER_NOT_ALLOWED_BY_RAG"
}
```

---

### UC-RAG-003 過去類似ケース検索

現在の市場状態に似た過去データを検索し、Bot学習用に利用する。

検索条件：

- RSI
    
- MACD
    
- ATR
    
- Volume Spike
    
- Funding Rate
    
- Open Interest
    
- ニュースイベント
    
- 予測市場の確率変化
    

出力：

- 類似期間
    
- 類似度
    
- その後の価格変動
    
- 最大逆行幅
    
- 最大順行幅
    
- リスクコメント
    
- Bot学習用ラベル
    

---

### UC-RAG-004 外部センチメント要約

Polymarketなどの予測市場データ、ニュース、SNSを集約し、相場に関係しそうなセンチメントを要約する。

ただし、予測市場データは「事実」ではなく「市場参加者の見方」として扱う。

出力項目：

- 強気材料
    
- 弱気材料
    
- 中立材料
    
- 市場心理の変化
    
- 信頼度
    
- 情報ソース
    
- 注意点
    

---

### UC-RAG-005 Bot検証レポート生成

バックテスト結果とRAG参照情報を組み合わせ、Bot改善用レポートを生成する。

出力項目：

- 勝ちパターン
    
- 負けパターン
    
- 発生頻度
    
- 最大ドローダウン要因
    
- 外部イベントとの関連
    
- 改善候補
    
- 次回検証条件
    

---

## 8. 機能要件

### 8.1 データ収集機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F001|市場データ取込|OHLCV、指標、出来高、板情報を取り込む|
|RAG-F002|内部ログ取込|Botログ、注文履歴、約定履歴、監査ログを取り込む|
|RAG-F003|戦略ドキュメント取込|Botルール、リスク設定、設計書を取り込む|
|RAG-F004|外部情報取込|ニュース、SNS、予測市場情報を取り込む|
|RAG-F005|データ正規化|ソースごとに共通フォーマットへ変換する|

### 8.2 インデックス機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F006|チャンク分割|文書・ログ・ニュースを検索しやすい単位に分割する|
|RAG-F007|Embedding生成|テキストをベクトル化する|
|RAG-F008|メタデータ付与|symbol、timeframe、source、risk_type、created_atを付与する|
|RAG-F009|Vector保存|検索用ベクトルを保存する|
|RAG-F010|再インデックス|データ更新時に再処理する|

### 8.3 検索機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F011|Semantic Search|意味検索を行う|
|RAG-F012|Metadata Filter|銘柄、期間、情報種別で絞り込む|
|RAG-F013|Hybrid Search|キーワード検索とベクトル検索を併用する|
|RAG-F014|類似ケース検索|現在相場に近い過去ケースを検索する|
|RAG-F015|ソース信頼度評価|情報ソースごとに信頼度を算出する|

### 8.4 生成機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F016|市場要約生成|検索結果を要約する|
|RAG-F017|Bot判断理由生成|Botシグナルに対する説明を生成する|
|RAG-F018|反対材料抽出|シグナルと逆方向の材料を抽出する|
|RAG-F019|リスクコメント生成|損失・急変動・流動性リスクを説明する|
|RAG-F020|検証レポート生成|Bot学習・バックテスト結果を整理する|

### 8.5 Bot連携機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F021|Bot向けQuery API|トレーニングボットからRAGを参照できる|
|RAG-F022|Read-only制御|RAGから注文APIへアクセスできないようにする|
|RAG-F023|RAG Response保存|Botが参照したRAG結果を保存する|
|RAG-F024|Bot学習データ生成|検証用データセットを作成する|
|RAG-F025|Bot改善候補提示|改善案を提案するが、自動反映はしない|

### 8.6 安全制御機能

|機能ID|機能名|内容|
|---|---|---|
|RAG-F026|Prompt Injection検知|外部テキスト内の悪意ある指示を無効化する|
|RAG-F027|Output Validation|出力JSON Schemaを検証する|
|RAG-F028|禁止表現チェック|断定的な投資助言・注文命令を除外する|
|RAG-F029|監査ログ保存|Query、参照ソース、回答、Bot利用履歴を保存する|
|RAG-F030|権限制御|RAG参照権限と管理権限を分離する|

---

## 9. 非機能要件

|分類|要件|
|---|---|
|安全性|RAGは注文APIへ直接アクセスしない|
|説明可能性|回答には根拠・ソース・信頼度を含める|
|監査性|RAGの入力、検索結果、回答、Bot参照履歴を保存する|
|再現性|同一入力に対して、参照ソースと生成条件を追跡可能にする|
|拡張性|ニュース、SNS、予測市場、オンチェーンデータを後から追加可能にする|
|性能|Bot参照用途では3秒以内、UI表示用途では5秒以内を目標とする|
|可用性|RAG障害時もTrading Engineには影響させない|
|セキュリティ|Prompt Injection、SSRF、Secret漏洩、外部データ汚染を防ぐ|
|データ品質|低信頼ソースは回答に混ぜるが、信頼度を明示する|
|運用性|インデックス更新、失敗リトライ、DLQ、再処理を可能にする|

---

## 10. システム構成案

### 10.1 論理構成

```text
[External Sources]
- News
- Prediction Market
- SNS
- Market Data
- On-chain Data

        ↓

[Ingestion Worker]
- Fetch
- Normalize
- Validate
- Store Raw Data

        ↓

[Knowledge Store]
- Raw Documents
- Processed Documents
- Embeddings
- Metadata
- Source Scores

        ↓

[RAG Engine]
- Query Understanding
- Retrieval
- Reranking
- Risk Filter
- Answer Generation
- Output Validation

        ↓

[Bot RAG Adapter]
- Read-only API
- Training Bot Query
- Backtest Context Query
- Explanation Query

        ↓

[PMTP UI]
- AI Analysis Screen
- Bot Detail Screen
- Backtest Report Screen
```

### 10.2 推奨コンポーネント

|コンポーネント|役割|
|---|---|
|rag-ingestion-worker|外部・内部データ取込|
|rag-normalizer|正規化・メタデータ付与|
|rag-indexer|Embedding生成・Vector保存|
|rag-retriever|検索・再ランキング|
|rag-orchestrator|LLM呼び出し・回答生成|
|rag-guardrail|出力検証・禁止表現検知|
|rag-api|Bot/UI向けAPI|
|rag-audit-logger|参照履歴・回答履歴保存|

---

## 11. 技術方針

### 11.1 MVP技術構成

|分類|推奨|
|---|---|
|Backend|既存PMTP BackendにRAG moduleを追加|
|Language|TypeScript / Node.js中心|
|Framework|NestJS|
|DB|PostgreSQL|
|Vector Store|pgvector|
|Cache|Redis|
|Queue|Redis Streams|
|Validation|Zod|
|ORM|Prisma|
|LLM|OpenAI APIなど|
|Embedding|OpenAI Embedding APIなど|
|Observability|JSON Log + trace_id|

### 11.2 pgvectorを推奨する理由

MVPでは新しい専用Vector DBを増やすより、既存PostgreSQLへpgvectorを追加する方がよい。

理由：

- 既存アーキテクチャとの整合性が高い
    
- 運用対象が増えにくい
    
- MVPとして十分
    
- Prisma / PostgreSQL構成に寄せられる
    
- 監査ログやメタデータと同じDBで管理しやすい
    

将来的にデータ量が増えた場合は、Qdrant、Weaviate、OpenSearch Vector Searchなどへの移行を検討する。

---

## 12. データ設計方針

### 12.1 主要テーブル案

|Table|用途|
|---|---|
|rag_sources|データソース管理|
|rag_documents|原文・加工済みドキュメント|
|rag_chunks|チャンク単位の本文|
|rag_embeddings|Embedding保存|
|rag_queries|RAG問い合わせ履歴|
|rag_responses|RAG回答履歴|
|rag_citations|回答に使った参照ソース|
|rag_source_scores|ソース信頼度スコア|
|rag_bot_contexts|Botが参照したRAG文脈|
|rag_eval_results|RAG評価結果|

### 12.2 メタデータ

各チャンクには以下を付与する。

```json
{
  "source_type": "news | sns | prediction_market | market_data | bot_log | strategy_doc",
  "source_name": "polymarket | internal | binance | news_api",
  "symbol": "BTCUSDT",
  "market": "crypto",
  "timeframe": "1m | 5m | 1h | 1d",
  "event_time": "datetime",
  "ingested_at": "datetime",
  "reliability_score": 0.72,
  "recency_score": 0.91,
  "risk_tags": ["volatility", "liquidity", "sentiment"],
  "language": "ja | en | zh"
}
```

---

## 13. RAG回答仕様

### 13.1 Bot向け回答形式

```json
{
  "query_id": "uuid",
  "symbol": "BTCUSDT",
  "summary": "市場状況の要約",
  "supporting_factors": [
    "強気材料1",
    "強気材料2"
  ],
  "opposing_factors": [
    "弱気材料1",
    "弱気材料2"
  ],
  "similar_cases": [
    {
      "case_id": "uuid",
      "period": "2025-xx-xx",
      "similarity": 0.84,
      "outcome": "UP_AFTER_4H",
      "max_drawdown": "-1.8%"
    }
  ],
  "risk_level": "LOW | MEDIUM | HIGH | CRITICAL",
  "confidence": 0.0,
  "citations": [
    {
      "source_id": "uuid",
      "title": "source title",
      "source_type": "news",
      "used_reason": "根拠として使用した理由"
    }
  ],
  "guardrail": {
    "order_permission": false,
    "reason": "RAGは注文権限を持たない"
  }
}
```

### 13.2 UI向け回答形式

```json
{
  "signal_context": "BUY寄りだが、根拠は限定的",
  "confidence": 0.62,
  "risk_score": 0.71,
  "reason": [
    "RSIが売られすぎ圏",
    "過去類似ケースでは短期反発が多い",
    "ただし出来高低下時は失速リスクあり"
  ],
  "source_summary": [
    "内部市場データ",
    "過去Botログ",
    "外部ニュース要約"
  ],
  "warning": "この出力は投資助言ではなく、Bot学習・検証用の参考情報です。"
}
```

---

## 14. セキュリティ・ガードレール

### 14.1 禁止事項

RAGは以下をしてはいけない。

- 注文APIを直接呼び出す
    
- API Keyを参照する
    
- Secret情報を回答に含める
    
- 「必ず買うべき」「絶対上がる」など断定する
    
- 外部ソースの命令文をSystem Promptとして扱う
    
- Bot設定を自動変更する
    
- Risk Limitを自動緩和する
    
- 緊急停止を解除する
    

### 14.2 必須制御

|制御|内容|
|---|---|
|Tool制限|RAGから呼べるToolを検索・DB参照・要約に限定する|
|Output Validation|回答JSON Schemaを必ず検証する|
|Prompt Injection対策|外部文書内の命令を無効化する|
|Source Filtering|危険ソース・低信頼ソースを識別する|
|Audit Logging|Query、参照ソース、回答、Bot利用履歴を保存する|
|Read-only Role|RAG専用DBユーザーは原則Read-onlyにする|
|PII/Secret Mask|秘密情報・個人情報は回答前にマスクする|

---

## 15. 外部データ方針

### 15.1 Polymarket / Prediction Market

Polymarket等の予測市場データは、以下のように扱う。

|項目|方針|
|---|---|
|用途|市場心理・イベント確率の参考情報|
|扱い|事実ではなく市場参加者の見方として扱う|
|取引|RAGでは実行しない|
|Bot利用|シグナル補助情報としてのみ利用|
|注意点|流動性、操作、偏り、法規制リスクを明記する|

### 15.2 ニュース

|項目|方針|
|---|---|
|用途|イベント背景、マクロ要因、規制情報の把握|
|処理|要約、重複除外、時系列整理|
|注意点|速報の誤報、古い情報、偏向に注意する|

### 15.3 SNS

|項目|方針|
|---|---|
|用途|短期センチメント、話題化検知|
|処理|集約・ノイズ除去・影響度スコア化|
|注意点|煽り投稿、Bot投稿、インフルエンサー投稿の偏りに注意する|

### 15.4 内部データ

|項目|方針|
|---|---|
|Botログ|学習・検証用の重要データとして保存|
|注文履歴|RAGは参照のみ。注文判断には使わない|
|約定履歴|類似ケース・損益分析に利用|
|監査ログ|RAG利用追跡に利用。ただし秘密情報は除外|

---

## 16. MVP開発範囲

### 16.1 Phase 1: 内部RAG

対象：

- 戦略ルール
    
- Bot設定
    
- 注文履歴
    
- 約定履歴
    
- ポジション履歴
    
- 過去市場データ
    
- AI分析結果
    

目的：

- Botが過去類似ケースを検索できる
    
- Botの仮シグナルに説明を付けられる
    
- AI分析画面にReasonを表示できる
    

### 16.2 Phase 2: 外部情報RAG

対象：

- ニュース
    
- Polymarket等の予測市場データ
    
- SNS要約
    
- マクロイベント
    

目的：

- 外部センチメントをBot検証に使う
    
- 予測市場の確率変化を市場心理として参照する
    
- ニュースと価格変動の関連を整理する
    

### 16.3 Phase 3: Training Bot連携強化

対象：

- バックテストレポート
    
- 戦略改善候補
    
- 負けパターン分析
    
- リスクパターン抽出
    

目的：

- Bot改善サイクルを作る
    
- RAGを学習データ生成基盤として使う
    
- 将来のAI Bot設計へ接続する
    

---

## 17. 成功指標

|KPI|目標|
|---|---|
|RAG回答の根拠付き率|95%以上|
|回答JSON Schema検証成功率|99%以上|
|Bot参照履歴保存率|100%|
|禁止表現検出率|95%以上|
|検索レスポンス|3秒以内|
|類似ケース検索成功率|80%以上|
|RAG起因の注文事故|0件|
|RAGから注文APIアクセス|0件|
|外部ソース信頼度スコア付与率|90%以上|

---

## 18. 主要リスクと対策

|リスク|内容|対策|
|---|---|---|
|RAGハルシネーション|存在しない根拠を作る|引用必須、根拠なし回答禁止|
|Prompt Injection|外部文書がAIへ命令する|外部文書はデータとして扱い、命令として扱わない|
|低品質ソース混入|SNSや予測市場にノイズが多い|ソース信頼度スコアを付ける|
|Bot暴走誘発|RAG出力をBotが過信する|RAG出力は注文権限なし、Risk Filter必須|
|過去データ過信|類似ケースが未来を保証しない|参考情報として明示する|
|法規制リスク|予測市場や投資助言に関わる|取引連携禁止、断定表現禁止|
|情報鮮度低下|古いニュースを参照する|recency_scoreを付与する|
|秘密情報漏洩|ログやAPI Keyが混入する|マスキング、Read-only、Secret除外|

---

## 19. 推奨実装順序

```text
1. RAG対象データ定義
   ↓
2. rag_sources / rag_documents / rag_chunks 設計
   ↓
3. 内部ドキュメント・Botログ取込
   ↓
4. Embedding生成・pgvector保存
   ↓
5. RAG Query API実装
   ↓
6. Output Validation / Guardrail実装
   ↓
7. Training Bot Adapter実装
   ↓
8. AI分析画面への表示
   ↓
9. 類似ケース検索
   ↓
10. 外部情報データ追加
```

---

## 20. 最終方針

本企画の結論として、PMTPにおけるRAGは、初期段階では「投資判断AI」ではなく「トレーニングボットの参照知識基盤」として実装する。

最も重要なのは、RAGをTrading Engineから分離すること。  
RAGは、情報を整理し、根拠を示し、リスクを説明し、Botの学習・検証を支援する。  
しかし、注文実行・Bot設定変更・緊急停止解除は行わない。

この設計により、AI分析・Bot開発・外部情報活用を進めながら、金融システムとして最重要である誤発注防止、資金保護、監査可能性を維持できる。