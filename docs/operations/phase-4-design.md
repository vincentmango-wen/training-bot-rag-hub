# Phase 4 設計書 — RAG ingestion CLI 分離（ローカル実行 / Neon Direct 書込）

- 作成日: 2026-06-11
- 作成者: eng-backend（設計フェーズ担当）
- ステータス: 設計レビュー待ち
- 対象リポジトリ: `/Volumes/DevShare/projects/training-bot-rga-hub`
- 前フェーズ設計書: `docs/operations/phase-3-design.md`（Bearer Token 認証）/ `docs/operations/phase-2-design.md`（serverless 化）/ `docs/operations/neon-setup.md`（Neon）

---

## 1. 目的と前提

### 目的

ドキュメント取り込み / embedding 生成のような **長時間・高メモリ処理を Vercel Functions（Hobby: 実行時間上限あり）に載せない**。代わりにローカル PC で動く CLI として分離し、Neon の **Direct URL（pooler 非経由）** に対して直接書き込む。

1. CLI 1 コマンドで「対象ファイル/ディレクトリ指定 → chunk → embed → Neon 書込」が完結する
2. 同じ入力で再実行しても二重課金・二重登録が起きない（冪等）
3. Neon Free 0.5GB 枠の監視ポイントと到達時対応を runbook 化する

### 入力となる前フェーズ・既存実装の成果物（実機確認済 / 2026-06-11）

| 既存物 | 場所 | 本フェーズへの影響 |
|---|---|---|
| **Ingestion パイプライン一式** | `apps/api/src/ingestion/`（`ingestion.service.ts` / `chunker.ts` / `normalizer.ts` / `content-hash.ts` / `embedding-writer.ts` / `injection-scanner.ts` / `chunk-index-validator.ts`） | **CLI はこれを呼ぶだけ**。冪等 claim（claim-first + payload_hash replay）・content_hash 差分（再 embedding 回避）・QUARANTINE・1 文書 1 トランザクションが実装済。**再実装禁止** |
| token chunk 分割 | `apps/api/src/ingestion/chunker.ts`（既定 700 token / max 1000 / min 80 / overlap 100） | ブリーフの「500-1000 token 想定」を既に満たす。CLI 側で新規 chunk 実装は不要 |
| EmbeddingProvider 抽象 | `apps/api/src/modules/rag/infrastructure/providers/embedding/embedding-provider.interface.ts`（`EMBEDDING_PROVIDER` トークン） | CLI もこの DI トークン経由で embed する（Provider Adapter 踏襲 / OpenAI 直叩き禁止） |
| OpenAI 実 adapter | 同 `openai-embedding.adapter.ts`（text-embedding-3-small / 1536 dims / timeout / 型付きエラー）+ `openai/openai-client.openai-sdk.ts` | CLI の `EMBEDDING_PROVIDER` 束縛先。`ProvidersModule` 内部 provider で **未 export** のため CLI 用 module で再配線する（§4-3） |
| サーバ側 DI 既定 | `apps/api/src/ingestion/ingestion.module.ts`（`EMBEDDING_PROVIDER` → **Stub** 束縛） | サーバ側は触らない。CLI 専用 module で実 adapter を束縛（§3 判断 2） |
| Prisma 接続 | `schema.prisma`: `url = env("DATABASE_URL")` / `directUrl = env("DIRECT_URL")`。`PrismaModule`（`src/modules/rag/infrastructure/prisma/` / @Global） | CLI 実行時は `DATABASE_URL` に **Direct URL を流し込む**（§3 判断 3）。**注: ブリーフの env 名 `DATABASE_URL_DIRECT` は本リポでは `DIRECT_URL` が正**（`.env.example` / schema.prisma 準拠）。設計はリポ実体に合わせる |
| RagSource テーブル | `schema.prisma` `RagSource`（`@@unique([sourceType, sourceName])` / `reliabilityScore` 必須） | ingestion は `sourceId` 必須。CLI が find-or-create する（§4-1） |
| enum SSoT | `packages/shared/src/rag-enums.ts`（`MVP_SOURCE_TYPES` = market_data / bot_log / order_history / strategy_doc） | CLI の `--source-type` バリデーションは shared の Zod schema を使う（リテラル再宣言禁止 / enum SSoT 規約） |
| ts-node | `apps/api` devDependencies に `ts-node@^10.9.2` 既存 | **新規 npm install 不要**（SMB 並列 install 禁止制約にも抵触しない） |

### ブリーフからの責務再定義（eng-pm 確認事項）

ブリーフの成果物 `scripts/ingest/chunker.ts`（テキストチャンク分割）/ `embedder.ts`（OpenAI ラッパ）は、**同等実装が `src/ingestion/` に既に存在する**ため、ファイル名は維持しつつ責務を以下に再定義する（重複実装は規約違反かつ将来のドリフト源）:

| 成果物 | ブリーフ上の責務 | 本設計での責務 |
|---|---|---|
| `scripts/ingest/chunker.ts` | テキストチャンク分割 | **ファイル走査 + `IngestionItemInput` 組み立て**（token 分割は `IngestionService` 内の既存 chunker が実施） |
| `scripts/ingest/embedder.ts` | OpenAI API ラッパ | **CLI 用 Nest module**（`EMBEDDING_PROVIDER` → 実 `OpenAIEmbeddingAdapter` の DI 配線 + API キー fail-fast） |

### スコープ外（本フェーズでやらないこと）

- 実装ファイルの作成（実装フェーズの担当）
- news / sns 等 Phase2+ source_type の取込
- ファイル形式パーサ（PDF / docx）。MVP は `.md` / `.txt` のみ
- cron / 自動定期実行（手動 CLI のみ。推奨頻度は runbook に記載）
- ローカル embedding モデル（ollama 等）導入 — Provider Adapter の将来拡張点としてのみ言及

---

## 2. 想定コスト

### 実装工数（人間想定 × 2/3 のエージェント係数適用）

| 作業 | 人間想定 | 係数後 |
|---|---|---|
| `scripts/ingest/index.ts`（args / env / bootstrap / 結果報告 / exit code） | 2.5h | 1.7h |
| `scripts/ingest/chunker.ts`（ファイル走査 + item 組み立て） | 1.0h | 0.7h |
| `scripts/ingest/embedder.ts`（CLI 用 DI module + fail-fast） | 1.0h | 0.7h |
| `package.json` scripts + `scripts/tsconfig.json` | 0.3h | 0.2h |
| `docs/operations/ingestion-runbook.md` | 1.5h | 1.0h |
| `README.md` 追記 | 0.3h | 0.2h |
| ローカル検証（typecheck / 既存 jest 非破壊 / docker postgres への実走 1 回） | 0.9h | 0.6h |
| **合計** | **7.5h** | **約 5.0h** |

### 月額運用実費

- **Neon / Vercel: ¥0**（既存 Free / Hobby 枠のまま。CLI はローカル実行のため Vercel に変更なし）
- **OpenAI embedding**: text-embedding-3-small は **$0.02 / 1M tokens**（[pricing](https://platform.openai.com/docs/pricing)）。個人ドキュメント想定（例: 月 100 ファイル × 3,000 tokens = 0.3M tokens）で **月 $0.006 ≒ ¥1 未満**。事実上ゼロだが「ゼロでない」ことは明記

### 隠れコスト

- **Neon 0.5GB 枠の消費**: 1 chunk あたり vector 1536 dims × 4 bytes ≒ 6KB + 本文 + index。概算 **6〜10KB/chunk** → 0.5GB ≒ **5〜8 万 chunk** が上限目安。runbook に容量監視 SQL と到達時対応（古い document の削除 / reindex）を必須記載
- **OPENAI_API_KEY の露出面が 1 つ増える**: これまでサーバ（Vercel 環境変数）のみ → ローカル `.env` にも保持。`.gitignore` 済を実装時に再確認
- **再取込の DB churn**: 既存パイプラインは全置換セマンティクス（旧 chunk 物理削除 → 再 INSERT）。embedding は content_hash 一致で再利用されるが、**行の削除/再作成は発生**する。Neon の storage は論理サイズ課金のため実害は小さいが、runbook の「推奨頻度」で無駄な再実行を抑制
- **ts-node 起動オーバーヘッド**: SMB 上の node_modules 読込で起動に数十秒かかる可能性。`transpile-only` で緩和（§4-4）

### ゼロコスト代替案

- **embedding 課金もゼロにする案**: `--dry-run` フラグ（§4-1）で Stub provider に切替え、chunk 分割結果と件数だけ確認 → 課金ゼロで取込内容を事前検証できる。実 embed は本実行のみ
- **完全ゼロ運用**: ローカル embedding（ollama + bge-m3 等）を `EmbeddingProvider` 実装として追加すれば可能だが、次元数変更（1536 → 1024）が HNSW index・既存データと非互換のため MVP では不採用。月 ¥1 未満の実費に対し改修コストが見合わない

---

## 3. アーキテクチャ判断

### 判断 1: CLI の実行基盤 — 既存 `IngestionService` を Nest standalone context で再利用（候補 A 採用）

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: Nest standalone context + 既存 `IngestionService`（推奨）** | `NestFactory.createApplicationContext(IngestCliModule)` で DI コンテナだけ起動し、`IngestionService.ingest()` を呼ぶ（[NestJS Standalone applications](https://docs.nestjs.com/standalone-applications)） | 冪等 claim / content_hash 差分 / QUARANTINE / トランザクション境界 / chunk_index 検証を **1 行も再実装しない**。サーバ経路と CLI 経路で取込セマンティクスが恒久一致 | Nest 起動オーバーヘッド（数秒）。CLI 専用 module の DI 配線が 1 ファイル必要 |
| B: 素の TypeScript で chunk → embed → INSERT を新規実装 | `PrismaClient` + openai SDK を直接使う standalone スクリプト | Nest 非依存で起動が速い | **冪等性・差分更新・全置換・隔離の再実装 = 二重実装ドリフト**。サーバ側 ingestion と挙動が乖離する事故が構造的に不可避。Provider Adapter 踏襲も破る |
| C: 純関数（`chunkItem` / `normalizeText`）だけ import し、永続化を CLI 独自実装 | DI を避けつつ部分再利用 | Nest 起動不要 | `persistDocumentAndChunks` のトランザクション / embedding 再利用ロジック（約 150 行の正本）を複製することになり B と同じドリフト問題。中途半端 |

**採用: A**。`IngestionService` は HTTP に依存しない純アプリケーション層であり、standalone context から呼ぶのが設計意図通り。B/C は「最小構成」ではなく「二重実装」。

### 判断 2: `EMBEDDING_PROVIDER` の束縛 — CLI 専用 module で実 OpenAI adapter を束縛

- サーバ側 `IngestionModule` は `EMBEDDING_PROVIDER` → **Stub** を束縛（API キーなし boot 用）。これは触らない（変更範囲の限定）
- `ProvidersModule` は `EMBEDDING_PROVIDER` を **配列**（`EmbeddingProvider[]`、Router 用）として export しており、`IngestionService` が期待する単一 provider と **型が合わない**。そのまま import すると実行時に `embeddingProvider.embed is not a function` 系の事故になる
- → CLI 専用の `IngestCliModule`（`scripts/ingest/embedder.ts`）で `OPENAI_CLIENT` factory + `OpenAIEmbeddingAdapter` + `{ provide: EMBEDDING_PROVIDER, useExisting: OpenAIEmbeddingAdapter }`（単一束縛）+ `IngestionService` を自前配線する（§4-3）
- CLI は実呼び出しが目的なので、サーバの lazy-fail 方針と異なり **起動時に `OPENAI_API_KEY` 未設定を fail-fast**（`--dry-run` 時を除く）

### 判断 3: Neon Direct URL の流し込み — プロセス起動時に `DATABASE_URL` を `DIRECT_URL` で上書き

| 案 | 内容 | 評価 |
|---|---|---|
| **A: `index.ts` 冒頭で `process.env.DATABASE_URL = process.env.DIRECT_URL`（DIRECT_URL があれば）（推奨）** | PrismaClient は **インスタンス化時** に `env("DATABASE_URL")` を読むため、`createApplicationContext` より前の代入で確実に効く | コード 3 行。runbook の手順が「普通に `npm run ingest`」のままで済む |
| B: runbook で `DATABASE_URL=$DIRECT_URL npm run ingest` を指示 | コード変更ゼロ | 人間がフラグを忘れると pooler 経由（`connection_limit=1` + PgBouncer transaction mode）で長時間トランザクションが不安定化。運用ミス前提の設計は不採用 |

**採用: A**。pooler 経由を避ける理由: ingestion は 1 文書 1 トランザクションで `$queryRaw`（vector 書込）を多用し、PgBouncer transaction mode との相性問題（prepared statements）と pooler のアイドル切断リスクがある。migration と同じく Direct が正（[Neon: Connection pooling](https://neon.tech/docs/connect/connection-pooling) / [Neon: Prisma guide](https://neon.tech/docs/guides/prisma)）。

### 判断 4: .env 読込 — Node 22 ネイティブ `--env-file` を使用（dotenv 不採用）

- ルート `package.json` の engines は `node >=22`。`node --env-file=.env` がネイティブ対応（[Node.js CLI docs](https://nodejs.org/docs/latest-v22.x/api/cli.html#--env-fileconfig)）
- dotenv 追加は **新規 npm install が必要**になり SMB 制約（並列 install 禁止 / そもそも install はふみさん手動）に抵触するため不採用。**本フェーズは新規依存ゼロ**で成立する

### 判断 5: 冪等キー — ファイル内容から自動導出（`--idempotency-key` で上書き可）

- `idempotencyKey = 'cli-' + stableHashOfJson(対象ファイルの { 相対パス, contentHash } ソート済リスト)`（既存 `content-hash.ts` の `stableHashOfJson` を再利用）
- 同一内容での再実行 → 既存ジョブ replay（**embedding 課金ゼロ・DB 書込ゼロ**）。ファイルが 1 つでも変われば別キー → 新ジョブ（content_hash 差分で変更分のみ embed）
- ユーザーが明示再取込したい場合は `--force`（idempotencyKey を付けず新規ジョブ化）を用意

---

## 4. ファイル別実装指示

### 4-1. `apps/api/scripts/ingest/index.ts`（新規 / CLI エントリポイント）

- **目的**: 引数解釈 → env 検証 → Nest standalone context 起動 → `IngestionService.ingest()` 呼び出し → 結果サマリ表示 → exit code 返却
- **引数仕様**（Node 22 ネイティブ `node:util` の `parseArgs` を使用。commander 等の新規依存は禁止）:
  - 位置引数: 対象ファイルまたはディレクトリのパス（1 個以上必須）
  - `--source-type <type>`: 既定 `strategy_doc`。`@pmtp/shared` の `MVP_SOURCE_TYPES` / Zod schema でバリデート（リテラル再宣言禁止）
  - `--source-name <name>`: 既定 `local-cli`。RagSource の find-or-create キー
  - `--ext <csv>`: 走査対象拡張子。既定 `.md,.txt`
  - `--dry-run`: Stub provider（`src/ingestion/testing/stub-embedding-provider`）に切替え、**DB 書込もスキップ**（chunk 分割プレビューと件数のみ表示）。OPENAI_API_KEY 不要
  - `--force`: idempotencyKey を付けない（強制新規ジョブ）
  - `--idempotency-key <key>`: 自動導出の上書き
- **主要ロジック**:
  1. 冒頭（あらゆる import 副作用より前に評価される位置）で `DIRECT_URL` があれば `process.env.DATABASE_URL` を上書き（§3 判断 3）
  2. `parseArgs` → バリデーション失敗は usage 表示 + exit 2
  3. `--dry-run` でなければ `OPENAI_API_KEY` 未設定で即エラー + exit 2（fail-fast / §3 判断 2）
  4. `chunker.ts` の `collectFiles()` / `buildItems()` で `IngestionItemInput[]` を構築
  5. RagSource find-or-create: `prisma.ragSource.upsert({ where: { sourceType_sourceName: ... } })` 相当（`reliabilityScore: 1.0` / `status: 'ACTIVE'`。enum は shared `SOURCE_STATUSES` 参照）。upsert により並行実行レースも DB unique で安全
  6. `IngestionService.ingest({ sourceId, sourceType, jobType: 'manual_upload', idempotencyKey, items, traceId: randomUUID(), requestId: randomUUID() })`
  7. 結果表示: jobId / replayed / 成功・失敗件数 / item ごとの status・chunkCount・reused/new embedding 数・errorMessage。**OPENAI_API_KEY・DB URL・ファイル本文はログに出さない**
  8. exit code: 全 item SUCCESS/SKIPPED = 0 / 一部 FAILED = 1 / ジョブ自体失敗・例外 = 1 / 引数・env 不備 = 2
  9. `finally` で `app.close()`（Prisma 接続を確実に切る。Neon Free の接続維持回避）
- **参照ドキュメント**: [NestJS Standalone applications](https://docs.nestjs.com/standalone-applications) / [Node.js util.parseArgs](https://nodejs.org/docs/latest-v22.x/api/util.html#utilparseargsconfig)

### 4-2. `apps/api/scripts/ingest/chunker.ts`（新規 / ファイル走査 + item 組み立て）

> 責務再定義に注意（§1）。token 分割は実装しない（既存 `src/ingestion/chunker.ts` が `IngestionService` 内で実施する。既定 700 / max 1000 token でブリーフの 500-1000 想定を満たす）。

- **目的**: パス引数（ファイル / ディレクトリ混在可）を走査し、`IngestionItemInput[]` に変換する純関数群。Nest 非依存・fs のみ依存（単体テスト容易性のため）
- **export**:
  - `collectFiles(paths: string[], exts: string[]): string[]` — ディレクトリは再帰走査。拡張子フィルタ。隠しファイル（`.` 始まり）と `node_modules` / `dist` は除外。結果は **絶対パスのソート済**配列（idempotencyKey の安定性に必須）
  - `buildItems(files: string[], baseDir: string): IngestionItemInput[]` — 1 ファイル = 1 item。`title` = ファイル名（拡張子除く）/ `externalId` = baseDir からの相対パス（再取込時の document 対応付けキー）/ `rawContent` = UTF-8 読込 / `language` = 'ja' 固定（MVP）/ `metadata` = `{ relativePath, fileSizeBytes, mtime }`
  - `deriveIdempotencyKey(items): string` — `stableHashOfJson`（`src/ingestion/content-hash.ts` から import）で `{ externalId, contentHash: sha256Hex(rawContent) }` のリスト（externalId ソート済）をハッシュし `'cli-' + hash` を返す
- **ガード**: 空ディレクトリ / 該当ファイル 0 件はエラーメッセージ + 空配列（呼び出し側で exit 2）。1 ファイル 10MB 超は警告してスキップ（OpenAI バッチ・メモリ保護）
- **参照ドキュメント**: 既存 `src/ingestion/ingestion.types.ts` の `IngestionItemInput` JSDoc（フィールド契約の正本）

### 4-3. `apps/api/scripts/ingest/embedder.ts`（新規 / CLI 用 DI module）

> 責務再定義に注意（§1）。OpenAI API ロジックは書かない（既存 `OpenAIEmbeddingAdapter` を束縛するだけ）。

- **目的**: CLI 専用の Nest module `IngestCliModule` を定義し、`EMBEDDING_PROVIDER` を**単一の**実 OpenAI adapter に束縛する（サーバ側 Stub 束縛・Router 用配列束縛とは独立）
- **構成**:
  ```ts
  @Module({
    imports: [PrismaModule],   // @Global だが root module で明示 import が必要
    providers: [
      { provide: OPENAI_CLIENT, useFactory: createOpenAiClientForCli },
      OpenAIEmbeddingAdapter,
      { provide: EMBEDDING_PROVIDER, useExisting: OpenAIEmbeddingAdapter },
      IngestionService,
    ],
  })
  export class IngestCliModule {}
  ```
- `createOpenAiClientForCli`: `providers.module.ts` の private factory `createOpenAiClient` と同等だが、**lazy-fail ではなく即 throw**（CLI は実呼び出し前提）。providers.module.ts 側の factory を export 化して共用してもよい（その場合は 1 行の additive 変更に留める）
- `--dry-run` 用に `IngestCliDryRunModule`（`EMBEDDING_PROVIDER` → `StubEmbeddingProvider`）も export。`index.ts` がフラグで使い分ける
- **注意**: `ProvidersModule` を import しない（`EMBEDDING_PROVIDER` 配列束縛との token 衝突を避ける / §3 判断 2）
- **参照ドキュメント**: [NestJS Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)（`useExisting` / `useFactory`）

### 4-4. `apps/api/package.json` + `apps/api/scripts/tsconfig.json`（追記 / 新規）

- scripts 追記:
  ```json
  "ingest": "node --env-file=.env -r ts-node/register/transpile-only scripts/ingest/index.ts",
  "typecheck:scripts": "tsc --noEmit -p scripts/tsconfig.json"
  ```
  - ブリーフ原案 `"ingest": "ts-node scripts/ingest/index.ts"` からの変更理由: (1) `.env` 自動読込（dotenv 新規依存なし / §3 判断 4）、(2) `transpile-only` で SMB 上の起動を高速化（型検査は `typecheck:scripts` に分離）
- `apps/api/tsconfig.json` は `rootDir: "./src"` / `include: ["src/**/*.ts"]` のため scripts/ が型検査対象外 → `scripts/tsconfig.json` を新設:
  ```json
  {
    "extends": "../tsconfig.json",
    "compilerOptions": { "rootDir": "..", "noEmit": true },
    "include": ["./**/*.ts", "../src/**/*.ts"]
  }
  ```
- ルート `package.json` に `"ingest": "npm --prefix apps/api run ingest --"` を追記（`--` 以降に CLI 引数透過）
- CI（既存 typecheck job）に `typecheck:scripts` を足すかは実装フェーズで判断（additive のため低リスク）

### 4-5. `docs/operations/ingestion-runbook.md`（新規 runbook）

- **目的**: ふみさんがローカルで ingestion を回すための完全手順 + 容量監視
- **必須セクション**:
  1. **前提**: `.env` に `DATABASE_URL`（pooler）/ `DIRECT_URL`（direct）/ `OPENAI_API_KEY` が揃っていること（`neon-setup.md` 参照）。SMB 注意（install 不要 / 実行のみ）
  2. **基本手順**: `npm run ingest -- ./docs/strategy --source-type strategy_doc` 形式の実行例 3 つ以上（単一ファイル / ディレクトリ / dry-run）
  3. **推奨頻度**: 戦略ドキュメント更新時に手動実行（cron 不要）。replay 冪等のため「迷ったら再実行してよい」ことを明記
  4. **容量監視**（月 1 回目安）:
     - `SELECT pg_size_pretty(pg_database_size(current_database()));`
     - テーブル別: `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC;`
     - Neon Console の Storage 表示（論理サイズ）も併記。[Neon plans](https://neon.tech/docs/introduction/plans) の Free 枠 0.5GB を正として参照
  5. **0.5GB 枠到達時の対応**（優先順）: (a) 不要 document の削除（`rag_documents` → cascade で chunk / embedding も削除されるか **FK 設計を実装時に確認**して正確に書く）、(b) 古い `rag_ingestion_jobs` / `job_items` の履歴削除、(c) 有償プラン移行は最終手段（収益マイルストーン連動）
  6. **トラブルシュート表**: OPENAI_API_KEY 未設定 / DIRECT_URL 未設定（pooler 警告）/ Neon idle timeout / 429 rate limit（adapter が retryable エラー化済 → 再実行で replay + 差分継続）

### 4-6. `README.md`（追記）

- 「## 設計書」セクションの直前あたりに「## Ingestion（ローカル CLI 経由）」を追記（既存ファイルへの追記 / 上書きなし）
- 内容: 3〜6 行。「ingestion は Vercel に載せずローカル CLI で実行 / `npm run ingest -- <path>` / 詳細は `docs/operations/ingestion-runbook.md`」+ dry-run の存在

---

## 5. 冪等性ガード（実装必須項目）

二重実行リスク: **あり**（CLI の再実行・並行実行・Ctrl-C 中断後の再実行）。ガードは大半が既存実装に存在し、CLI 側は「正しく乗る」ことが義務。

| # | ガード | 実装箇所 | 状態 |
|---|---|---|---|
| 1 | claim-first（idempotency_key + payload_hash + 部分 unique）。同一キー同一 payload = replay（課金ゼロ）/ 同一キー別 payload = 409 conflict | `ingestion.service.ts` `claimJob()` | ✅ 既存。CLI は idempotencyKey を**必ず**渡す（`--force` 時を除く） |
| 2 | idempotencyKey の安定導出（ファイル順序非依存・内容ベース） | `scripts/ingest/chunker.ts` `deriveIdempotencyKey()` | 🆕 CLI 実装。**ソート済リスト**のハッシュであること（順序依存だと同一入力で別キー = ガード 1 が無効化される） |
| 3 | document 差分（UNIQUE(source_id, content_hash) / 一致なら再利用） | `ingestion.service.ts` `persistDocumentAndChunks()` | ✅ 既存 |
| 4 | embedding 差分（content_hash 一致 chunk はベクトル退避 → 再付与 / 再課金なし） | 同上 `snapshotReusableEmbeddings()` | ✅ 既存 |
| 5 | 1 文書 1 トランザクション（中断時に半端な chunk 集合が残らない） | 同上 `$transaction` | ✅ 既存。CLI は途中 SIGINT でも DB 不整合なし（ジョブ status が INDEXING 残置になるのみ → runbook トラブルシュートに記載） |
| 6 | RagSource find-or-create のレース | `scripts/ingest/index.ts` | 🆕 CLI 実装。`upsert`（unique (sourceType, sourceName) 上）で実装し、create + P2002 catch の手書きレース処理を書かない |
| 7 | dry-run の書込ゼロ保証 | `scripts/ingest/index.ts` | 🆕 CLI 実装。dry-run は `IngestionService` を呼ばず `chunkItem` プレビューのみ（ジョブ行すら作らない）。「dry-run なのに rag_ingestion_jobs が増える」を禁止 |

---

## 6. テストすべき観点（後続テスト担当向け）

`scripts/ingest/` の純関数（chunker.ts）は jest 単体で、index.ts の配線は統合（docker postgres + Stub provider）で。

- **collectFiles**: ディレクトリ再帰 / 拡張子フィルタ（`.md,.txt` 以外除外）/ 隠しファイル・node_modules 除外 / 結果がソート済 / 存在しないパスでエラー / 空ディレクトリで空配列
- **buildItems**: title・externalId（相対パス）・metadata の各フィールド契約 / UTF-8 読込 / 10MB 超スキップ + 警告
- **deriveIdempotencyKey**: 同一ファイル集合（順序違い）→ 同一キー / 内容 1 byte 変更 → 別キー / ファイル追加 → 別キー
- **引数バリデーション**: `--source-type` に MVP 外の値（`news` 等）→ exit 2 / パス引数なし → exit 2 + usage
- **env ガード**: OPENAI_API_KEY なし + 非 dry-run → exit 2（DB 接続前に落ちること）/ dry-run なら通ること
- **DIRECT_URL 上書き**: `DIRECT_URL` 設定時に PrismaClient が direct 側へ接続すること（process.env 検証 or 接続文字列 spy）
- **DI 配線スモーク**: `IngestCliModule` が `EMBEDDING_PROVIDER` を**単一** adapter（配列でない）で解決すること（`ProvidersModule` の配列束縛との取り違え検出 / negative control: ProvidersModule を import した場合に型不整合が起きることの確認）
- **冪等 replay（統合）**: 同一ディレクトリ 2 回実行 → 2 回目は `replayed: true` + embed 呼び出し 0 回（Stub provider の呼出カウントで検証）
- **差分更新（統合）**: 1 ファイル変更後の再実行 → 変更 item のみ newEmbeddingCount > 0、未変更 chunk は reused
- **exit code**: 全成功 0 / 一部 FAILED 1（不正ファイルを混ぜる）/ 引数不備 2
- **dry-run**: rag_ingestion_jobs / rag_documents の行数が実行前後で不変

## 7. レビュー観点

### architecture reviewer

- 候補 A（既存 `IngestionService` 再利用）の妥当性。特に B/C（再実装）を退けた判断が「変更範囲の限定」「SSoT」に整合しているか
- `IngestCliModule` の DI 配線: `EMBEDDING_PROVIDER` 単一束縛 vs `ProvidersModule` の配列束縛の衝突回避が正しいか / `PrismaModule` 明示 import の要否
- `DATABASE_URL` ← `DIRECT_URL` 上書きのタイミング（PrismaClient インスタンス化前）が import 順序込みで保証されているか
- サーバ側既存ファイル（`ingestion.module.ts` / `providers.module.ts` / `create-app.ts`）への変更が additive 最小限（factory export 化 1 行まで）に収まっているか
- enum SSoT: `--source-type` 検証が shared の `MVP_SOURCE_TYPES` / Zod 経由か（リテラル再宣言・`as never` がないか）

### quality reviewer

- 冪等性ガード表（§5）の 🆕 3 項目が実装に 1 件ずつ落ちているか（claim-first トリガーキーワードに該当 → 自己制約 3 発火対象）
- `deriveIdempotencyKey` のソート安定性（順序依存バグは replay ガード全体を無効化する）
- secrets 非出力: エラーメッセージ・サマリ出力に OPENAI_API_KEY / 接続文字列が混入しないか
- exit code 契約と `app.close()` の finally 保証（接続リーク → Neon Free の接続枠圧迫）
- dry-run の書込ゼロ保証（ジョブ行も作らない）
- 10MB 超ファイルのスキップ警告（黙殺しない）

### 両 reviewer 共通

- 新規 npm 依存がゼロであること（SMB 制約 / dotenv・commander の混入禁止）
- ブリーフからの責務再定義（§1: chunker.ts / embedder.ts）と env 名差異（`DATABASE_URL_DIRECT` → `DIRECT_URL`）が PR 本文に明記されているか
- runbook の容量監視 SQL が実機で動く構文か / 0.5GB 到達時対応の削除カスケード方向が schema.prisma の FK 実体と一致しているか

---

## 付記: 実装フェーズへの引き継ぎメモ

- 実装順の推奨: chunker.ts（純関数 / テスト容易）→ embedder.ts（DI）→ index.ts（結線）→ runbook → README
- `providers.module.ts` の `createOpenAiClient` を export 化して共用する場合、サーバ側挙動（lazy-fail）を変えないこと。CLI 側 fail-fast は CLI 側でキー存在チェックを先に行う形で実現してもよい（その場合 factory 共用で十分）
- docker-compose の postgres（localhost:5433）に対する実走 1 回をローカル検証に含める（Neon 実機への初回実行はふみさん判断 / runbook 手順で実施）
- ジョブ中断（SIGINT）で `rag_ingestion_jobs.status = 'INDEXING'` が残置するケースの扱い（再実行時は別キーになる場合がある）は runbook トラブルシュートに必ず記載
