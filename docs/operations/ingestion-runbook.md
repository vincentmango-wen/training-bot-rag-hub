# Ingestion runbook — ローカル CLI 経由

- 作成日: 2026-06-11
- 対象: Phase 4 / RAG ingestion CLI（`apps/api/scripts/ingest/`）
- 関連設計書: `docs/operations/phase-4-design.md` / `docs/operations/neon-setup.md` / `docs/operations/phase-2-design.md`

---

## 1. なぜローカル CLI なのか

- Vercel Hobby は実行時間 / メモリに上限あり。Embedding 生成は I/O 待ちが長く、長尺ファイルでは時間切れリスクが残る
- ingestion は **書込頻度が低く・人手のトリガで十分** → cron 自動化を見送り、必要なときに手動で回す方針
- Neon の Direct URL（pooler 非経由）に対してローカルから直接書き込む。Vercel 側のコード経路は読込専用で十分

---

## 2. 前提

### 2.1 環境変数

ローカルの `apps/api/.env`（または起動時の env）に以下が揃っていること。`.env.example` を参考にする。

| 変数 | 用途 | 補足 |
|---|---|---|
| `DATABASE_URL` | 実行時の接続文字列（pooler 経由） | サーバ用。CLI でも初期化に必要 |
| `DIRECT_URL`   | 直接接続文字列（Neon の Direct） | **CLI 実行時に DATABASE_URL を自動上書きする**ため、設定必須 |
| `OPENAI_API_KEY` | Embedding 用 | `--dry-run` 時のみ未設定で可 |

> ブリーフでは `DATABASE_URL_DIRECT` と記載があったが、本リポでは `.env.example` / `schema.prisma` に従い **`DIRECT_URL`** が正本（設計書 §1 参照）。

### 2.2 ローカル開発（docker）の場合

`docker compose up -d postgres` で pgvector 入り postgres を起動し、`DATABASE_URL=postgresql://rag_user:rag_pass@localhost:5433/rag_hub?schema=public` を指定する（`DIRECT_URL` は同値で問題ない / pooler を経由しないため）。

### 2.3 SMB 上の注意

リポは `/Volumes/DevShare/...` に置かれる。**CLI 実行のみで npm install は不要**（ts-node・@nestjs/core 等は既存 devDependencies）。並列実行は I/O 競合を起こすため 1 プロセスだけ起動する。

---

## 3. 基本手順

### 3.1 単一ファイルを取込（strategy_doc）

```bash
npm run ingest -- ./docs/strategy/my-strategy.md
```

既定の `--source-type strategy_doc` / `--source-name local-cli` で取込。RagSource は自動で find-or-create される。

### 3.2 ディレクトリ再帰取込

```bash
npm run ingest -- ./docs/strategy --source-type strategy_doc --source-name local-cli
```

- `.md` と `.txt` を再帰走査（`--ext` で変更可）
- `node_modules` / `dist` / `.git` / 隠しファイルは除外
- 結果のファイル順は **絶対パスソート済**（同じ入力で同じ idempotencyKey）

### 3.3 dry-run（API 課金ゼロ・DB 書込ゼロでの事前検証）

```bash
npm run ingest -- ./docs/strategy --dry-run
```

- `OPENAI_API_KEY` 不要
- ジョブ行 (`rag_ingestion_jobs`) も作らない
- chunk 分割結果（1 ファイルあたり何 chunk になるか）だけを表示

### 3.4 強制再取込（idempotency replay を回避）

```bash
npm run ingest -- ./docs/strategy --force
```

または明示的に key を変える:

```bash
npm run ingest -- ./docs/strategy --idempotency-key cli-manual-2026-06-11
```

> 通常は不要。同一内容での再実行は自動的に replay（embedding 課金ゼロ / DB 書込ゼロ）。

---

## 4. 推奨頻度

- **戦略ドキュメント更新時に手動実行**（cron は使わない）
- 「迷ったら再実行してよい」: 同一内容ファイルは claim-first 冪等で replay されるため、過剰実行のリスクは小さい
- 大量に再取込が必要なときは `--source-name` を分けてスコープを切る

---

## 5. exit code

| code | 意味 |
|---|---|
| 0 | 全 item SUCCESS / SKIPPED |
| 1 | 1 件以上 FAILED / ジョブ自体が FAILED / 想定外例外 |
| 2 | 引数不備 / 環境変数不足 / 入力ファイルなし |

---

## 6. 容量監視（月 1 回目安）

Neon Free 枠 = **0.5GB**（[Neon plans](https://neon.tech/docs/introduction/plans)）。1 chunk あたり vector 1536 dims × 4 bytes ≒ 6KB + 本文 + index ≒ **6〜10KB / chunk** → 0.5GB ≒ 約 **5〜8 万 chunk** が上限目安。

### 6.1 DB 全体サイズ

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));
```

### 6.2 テーブル別サイズ（上位）

```sql
SELECT
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;
```

### 6.3 Neon Console（推奨）

Neon Console の Storage 表示（論理サイズ）を月初に確認。SQL の値とは集計タイミング差があるため、両方見て大きい方を採用する。

---

## 7. 0.5GB 枠到達時の対応（優先順）

1. **不要な document の削除**: 古い `rag_documents` を選別して削除。chunk / embedding の FK カスケード方向を schema.prisma で再確認の上で実行（手動 cascade が必要なら個別 DELETE）
2. **古いジョブ履歴の削除**: `rag_ingestion_jobs` / `rag_ingestion_job_items` で運用に不要な行を削除
3. **HNSW index の reindex**: 削除後の断片化を解消（`REINDEX TABLE rag_embeddings;`）
4. **有償プラン移行**: 最終手段。収益マイルストーン連動で判断

---

## 8. トラブルシュート

| 症状 | 真因候補 | 対処 |
|---|---|---|
| `OPENAI_API_KEY is not set` で起動失敗 | `.env` に未設定 / `node --env-file` が `.env` を読めていない | `.env` を `apps/api/.env` 配下に置く / `--dry-run` で先に検証 |
| `DATABASE_URL` 未設定 | `.env` 不備 | `DIRECT_URL` を設定するだけでも CLI が DATABASE_URL を上書きする |
| pooler 経由で長時間 tx が不安定 | `DIRECT_URL` が未設定 = pooler URL のまま | `.env` に `DIRECT_URL` を必ず設定する（CLI が自動で DATABASE_URL に流し込む） |
| Neon `connection terminated` (idle) | アイドル切断 | 再実行（replay により未完了分から再開 / 既処理は差分判定で skip） |
| `429 rate limit` from OpenAI | API レート上限 | 数分待って再実行（OpenAIEmbeddingAdapter が retryable error 化済 → 再実行で差分継続） |
| ジョブ status が `INDEXING` のまま残る | 実行途中で SIGINT / プロセス kill | 同じ入力で再実行すれば別キーで新ジョブが立つ。残置 INDEXING 行は運用判定で手動削除可（DB 整合性は損なわない / 1 文書 1 トランザクション保証） |
| dry-run なのに DB 書込が増えた | バグ報告対象 | `rag_ingestion_jobs` の COUNT を実行前後で比較し、再現すれば issue 起票 |
| 10MB 超ファイルが取込まれない | 設計通りスキップ | warning を確認。分割するか、`MAX_FILE_SIZE_BYTES` 上書きを検討（本 CLI では未対応 / 別チケット） |

---

## 9. 秘密情報の取り扱い

- ログ・サマリ出力に `OPENAI_API_KEY` / `DATABASE_URL` / `DIRECT_URL` / **ファイル本文** を出さない（CLI で構造的に防止）
- `.env` は `.gitignore` 済みであることを実行前に確認
- バックアップに `.env` を含めない

---

## 10. 参照

- 設計書: `docs/operations/phase-4-design.md`
- Neon セットアップ: `docs/operations/neon-setup.md`
- Phase 2 設計: `docs/operations/phase-2-design.md`
- Phase 3 設計: `docs/operations/phase-3-design.md`
- IngestionService（再利用元）: `apps/api/src/ingestion/ingestion.service.ts`
- enum SSoT: `packages/shared/src/rag-enums.ts`
