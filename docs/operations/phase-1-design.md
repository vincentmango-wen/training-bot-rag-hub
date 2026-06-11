# Phase 1 設計書 — Neon プロビジョニング + Prisma migration 対応

- 作成日: 2026-06-11
- 作成者: eng-backend（設計フェーズ担当）
- ステータス: 設計レビュー待ち
- 対象リポジトリ: `/Volumes/DevShare/projects/training-bot-rga-hub`

---

## 1. 目的と前提

### 目的

ローカル docker-compose（SMB 上の I/O 不安定により dev サーバが落ちる問題あり）から、**Neon Free（pgvector 対応 serverless Postgres）** へ DB を移行できる状態を整える。本フェーズのゴールは「Neon プロジェクトを作成し、既存 Prisma migration を `migrate deploy` で適用し、pgvector を含む全スキーマが Neon 上に再現される」こと。アプリ（NestJS）の serverless 化は後続フェーズ（Vercel Functions エントリ追加）のスコープであり、本フェーズでは触らない。

### 入力となる既存成果物（実機確認済 / 2026-06-11）

| 既存物 | 場所 | 本フェーズへの影響 |
|---|---|---|
| 初期 migration | `apps/api/prisma/migrations/00000000000000_init/migration.sql` | **L19 に `CREATE EXTENSION IF NOT EXISTS vector;` が既に存在**。pgvector 有効化は init が担う（§3 判断 1） |
| Prisma schema | `apps/api/prisma/schema.prisma` | **datasource に `directUrl = env("DIRECT_URL")` が既設（L23）**。ブリーフの「directUrl 追加」は実質完了済（§3 判断 2） |
| env テンプレート | `apps/api/.env.example`（Prisma CLI が読む正本）/ ルート `.env.example`（docker-compose 用） | 2 ファイル構成。`DATABASE_URL` / `DIRECT_URL` は apps/api 側に既存（ローカル値） |
| npm scripts | ルート `db:migrate:deploy` → `apps/api` の `prisma migrate deploy` | runbook からそのまま利用可能 |
| schema パラメータ規約 | `apps/api/.env.example` コメント: `?schema=public` を使う（pgvector が public 常駐で vector 型が search_path 解決されるため） | Neon URL でも `schema=public` を踏襲 |

### ブリーフとの差分（eng-pm 裁定事項）

ブリーフの成果物リストのうち 2 件は既存実装と重複・矛盾するため、§3 で代替案を提示する:

1. 「`enable_pgvector` migration の新規追加」→ init に既存。**後置 migration は構造的に無意味**（init 自体が vector 型を必要とするため、init より後に走る migration では手遅れ。新規 DB では init の L19 が必ず先に有効化する）
2. 「schema.prisma に directUrl 追加」→ 既設。env 変数名がブリーフ（`DATABASE_URL_DIRECT`）と既存（`DIRECT_URL`）で不一致 → 命名統一の判断が必要

---

## 2. 想定コスト

### 実装工数（人間想定 × 2/3 のエージェント係数適用）

| 作業 | 人間想定 | 係数後 |
|---|---|---|
| runbook（neon-setup.md）作成 | 1.5h | 1.0h |
| .env.example 2 ファイル追記 | 0.5h | 0.33h |
| Neon 実機プロビジョニング + migrate deploy 検証（runbook 通し） | 1.0h | 0.67h |
| **合計** | **3.0h** | **2.0h** |

※ Neon プロジェクト作成・コンソール操作はふみさんの手作業（アカウント認証が必要）のため人間工数のまま見るべき部分を含む。エージェントが代行できるのは runbook / env / 検証クエリの整備。

### 月額運用実費

- **¥0**。Neon Free plan（0.5 GB ストレージ / 月 190 compute hours / autosuspend あり）+ Vercel Hobby（後続フェーズ）で完結
- プラン仕様の正本: https://neon.com/docs/introduction/plans （runbook 作成時に最新値を再確認すること）

### 隠れコスト

- **コールドスタート**: Neon Free は無アクセス約 5 分で autosuspend → 再開時に数百 ms〜数秒の接続遅延。個人非公開運用では許容範囲だが、初回リクエストの体感劣化として認識しておく
- **0.5 GB ストレージ上限**: pgvector の HNSW index は実データの数倍に膨らみ得る。embedding 蓄積が進んだら `pg_total_relation_size` の定期確認が必要（runbook に確認クエリを含める）
- **compute hours 上限（190h/月）**: 常時接続ポーリング等を実装すると枯渇する。serverless 前提（リクエスト駆動）なら実質問題なし
- **ブランチ運用の誘惑**: Neon の DB ブランチ機能は便利だが Free だと本体ストレージを食い合う。Phase 1 では main ブランチのみ使用

### ゼロコスト代替案

| 代替 | 評価 |
|---|---|
| docker-compose 継続（現状維持） | ¥0 だが SMB I/O 不安定という移行動機が解消されない。**不採用** |
| Supabase Free（500 MB / pgvector 対応） | 実費は同等。ただし Free プロジェクトは 1 週間無アクセスで pause（手動 resume 必要）+ 既存 schema の `?schema=public` 運用は Supabase の予約 schema 群と同居になる。Neon の方が「素の Postgres」に近く Prisma directUrl/pooler の公式ガイドも充実。**次点** |
| ローカル Postgres を SMB 外（Mac 内蔵ディスク）に移す | ¥0 で I/O 問題も解消するが、Vercel serverless 化（最終ゴール）から外部到達可能な DB が必要になるため二度手間。**不採用** |

---

## 3. アーキテクチャ判断

### 判断 1: pgvector 有効化の方式

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: init migration に委ねる（推奨）** | 既存 `00000000000000_init` L19 の `CREATE EXTENSION IF NOT EXISTS vector;` をそのまま使う。新規 migration は追加しない | 新規 DB（Neon）で `migrate deploy` 一発で完結。冪等。変更ゼロ（最小構成原則） | ブリーフの成果物リストと差分が出る（本設計書で明示してカバー） |
| B: 後置 `enable_pgvector` migration 追加（ブリーフ案） | `<ts>_enable_pgvector/migration.sql` を新規追加 | ブリーフ通り | **構造的に dead migration**。migration は名前順実行のため init より後に走るが、init 自体が vector 型（`Unsupported("vector")` 列 + `vector_dims` CHECK + HNSW index）を必要とする。init が成功した時点で vector は必ず有効 → 後置分は常に no-op。誤解を生む負債 |
| C: Neon SQL Editor で手動 `CREATE EXTENSION` | コンソールから手動実行 | 手数最少 | 「DB 変更は migration ファイル経由（手動 SQL 直叩き禁止）」の部門規約に抵触。再現性なし |

**推奨: A**。Neon は DB オーナーロール（`neon_superuser` 権限付与済）で `CREATE EXTENSION vector` を実行可能（https://neon.com/docs/extensions/pgvector ）なので、init migration がそのまま通る。runbook には「pgvector は init migration が有効化する。手動有効化は不要」と明記し、検証クエリ（`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';`）で確認させる。

### 判断 2: direct URL の env 変数名

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: `DIRECT_URL` 維持（推奨）** | schema.prisma 既設の `env("DIRECT_URL")` をそのまま使う | schema.prisma / apps/api/.env.example とも変更不要。Prisma 公式ドキュメントの例示名と一致（https://www.prisma.io/docs/orm/reference/prisma-schema-reference#directurl ） | ブリーフ表記（`DATABASE_URL_DIRECT`）と不一致 |
| B: `DATABASE_URL_DIRECT` へ改名 | schema.prisma の env 名を書き換え + 既存 .env / .env.example を全箇所改名 | ブリーフ表記と一致 | 既存 3 箇所（schema / 2 つの .env.example）+ ふみさんローカル .env の手修正が必要。得られる利益が命名の好みのみ |

**推奨: A**。ブリーフの意図は「migration 用と実行時用の URL を分離する」ことであり、変数名そのものではない。既存資産が既に分離済のため最小変更で達成。eng-pm がブリーフ表記への厳密一致を求める場合のみ B に切り替え（その場合は実装担当が schema.prisma L23 と 2 つの .env.example を同一 PR で改名）。

### 判断 3: Neon 接続文字列の構成（実行時 = Pooler / migration = Direct）

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: Pooler + `pgbouncer=true`（実行時）/ Direct（migration）の二系統（推奨）** | `DATABASE_URL` = `-pooler` ホスト + `?sslmode=require&pgbouncer=true&connection_limit=1&schema=public` / `DIRECT_URL` = 非 pooler ホスト + `?sslmode=require&schema=public` | serverless（Vercel Functions）の同時実行で direct 接続上限を食い潰さない。Prisma 公式の PgBouncer 対応構成（https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer ） | URL 2 本の管理が必要（既に schema.prisma が前提としている構成なので追加負担なし） |
| B: Direct 一本 | `DATABASE_URL` = `DIRECT_URL` = 非 pooler | 単純 | Vercel serverless の同時 invocation ごとに direct 接続が張られ、Neon の direct 接続上限に容易に到達。最終ゴールと非整合 |
| C: Neon serverless driver（`@neondatabase/serverless`）+ Prisma driver adapter | HTTP/WebSocket 経由 | エッジ環境対応 | Prisma 5.22 では driver adapter が preview。NestJS + Node runtime なら Pooler で十分。過剰 |

**推奨: A**。パラメータの根拠:
- `pgbouncer=true`: Neon pooler は PgBouncer transaction mode。Prisma に prepared statement 回避を指示するため必須
- `connection_limit=1`: serverless の 1 invocation = 1 接続に制限（Vercel 公式推奨パターン）。ローカル開発で Neon に繋ぐ場合は外してよい（runbook に両パターン記載）
- `sslmode=require`: Neon 必須
- `schema=public`: 既存規約踏襲（apps/api/.env.example コメント参照。pgvector の型解決のため）
- 接続文字列の正本ドキュメント: https://neon.com/docs/guides/prisma / https://neon.com/docs/connect/connection-pooling

---

## 4. ファイル別実装指示

### 4-1. `docs/operations/neon-setup.md`（新規作成）

- **目的**: ふみさんが手を動かして Neon プロジェクト作成 → migrate deploy 完了まで到達できる runbook。エージェントが代行できない部分（ブラウザでのアカウント操作）を含むため、コマンドのコピペと画面操作の指示を交互に書く
- **章立て（必須）**:
  1. 前提（Neon アカウント / Node 22 / リポジトリ clone 済 / `apps/api` で `npm run prisma:validate` が通ること）
  2. Neon プロジェクト作成（region は `ap-southeast-1` (Singapore) 推奨 = 東京から最寄りの Neon region。プロジェクト名 / DB 名 / ロールはコンソール表示値をそのまま控える）
  3. 接続文字列の取得（コンソールの Connect パネルで **Pooled connection** と **Direct connection** の両方をコピー。`-pooler` の有無で見分ける旨を明記）
  4. `.env` への投入（`apps/api/.env` に `DATABASE_URL`（pooler + `pgbouncer=true&connection_limit=1&sslmode=require&schema=public`）と `DIRECT_URL`（direct + `sslmode=require&schema=public`）を記入。**実値は .env のみ / .env.example・runbook・チャットに貼らない**）
  5. migration 適用（リポジトリルートで `npm run db:migrate:deploy` → `npm run db:migrate:status` で「Database schema is up to date!」確認）
  6. pgvector / スキーマ検証（Neon SQL Editor または `psql "$DIRECT_URL"` で: `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';` → 1 行 / `\dt` で rag_* 17 テーブル / `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%hnsw%';` で HNSW index）
  7. トラブルシュート表（`P1001` = 接続不可 → sslmode 確認 / `prepared statement "s0" already exists` → pooler URL に `pgbouncer=true` 欠落 / `type "vector" does not exist` → schema パラメータが public 以外 / autosuspend 直後のタイムアウト → リトライ 1 回）
  8. ストレージ監視クエリ（`SELECT pg_size_pretty(pg_database_size(current_database()));` / 0.5 GB 上限への注意）
- **引用すべき外部ドキュメント**: https://neon.com/docs/guides/prisma / https://neon.com/docs/connect/connection-pooling / https://neon.com/docs/extensions/pgvector / https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer
- **書かないこと**: Vercel 連携手順（後続フェーズの runbook へ）/ 実接続文字列の値

### 4-2. `apps/api/.env.example`（追記 / 既存値は削除しない）

- **目的**: Prisma CLI が読む正本テンプレートに Neon 用の 2 系統 URL の「形」を追記する
- **実装指示**: 既存の `DATABASE_URL` / `DIRECT_URL`（docker-compose ローカル値）は**そのまま残し**、直下に Neon 用のコメントブロックを追記する:
  ```bash
  # --- Neon 移行後はこちらの形式に差し替える（docs/operations/neon-setup.md 参照） ---
  # 実行時用（Pooled / -pooler ホスト）。pgbouncer=true は Prisma + PgBouncer transaction mode に必須。
  # DATABASE_URL=postgresql://<role>:<password>@<endpoint>-pooler.<region>.aws.neon.tech/<db>?sslmode=require&pgbouncer=true&connection_limit=1&schema=public
  # migration 用（Direct / pooler なしホスト）。prisma migrate deploy はこちらを使う（schema.prisma の directUrl）。
  # DIRECT_URL=postgresql://<role>:<password>@<endpoint>.<region>.aws.neon.tech/<db>?sslmode=require&schema=public
  ```
- placeholder（`<role>` 等）のみ使用し、実値・実エンドポイント名は書かない
- 判断 2 で B（改名）が裁定された場合のみ、キー名を `DATABASE_URL_DIRECT` に置換 + schema.prisma L23 を同一 PR で修正

### 4-3. ルート `.env.example`（追記 / 既存値は削除しない）

- **目的**: docker-compose 用テンプレートに「DB の正本が Neon に移ること」への導線を残す
- **実装指示**: 既存の `POSTGRES_*` / `DATABASE_URL` / `REDIS_*` 行は削除しない（docker-compose 削除は後続フェーズで Redis 撤去と同時に扱う）。末尾に 2 行のコメントを追記:
  ```bash
  # Neon 移行後の DATABASE_URL / DIRECT_URL は apps/api/.env.example を参照（Prisma の正本はそちら）
  ```

### 4-4. `apps/api/prisma/migrations/<ts>_enable_pgvector/migration.sql`

- **判断 1-A 採用時（推奨）: 作成しない**。pgvector 有効化は init migration L19 が担っており、後置 migration は dead migration になる（§3 判断 1 の短所欄参照）。runbook §6 の検証クエリで「有効化されたこと」を確認する設計に置き換える
- **判断 1-B が裁定された場合のみ**: `CREATE EXTENSION IF NOT EXISTS vector;` の 1 文 + 「init L19 と重複する冪等 no-op であり、ドキュメント目的で存在する」旨のコメントヘッダを付けて作成する

### 4-5. `apps/api/prisma/schema.prisma`

- **変更不要（確認のみ）**。datasource ブロック（L20-24）に `directUrl = env("DIRECT_URL")` が既設。実装担当は `npm --prefix apps/api run prisma:validate` が通ることだけ確認する
- 判断 2-B 裁定時のみ L23 を `env("DATABASE_URL_DIRECT")` へ変更

---

## 5. 冪等性ガード

本フェーズは DB スキーマの新規追加なし・アプリコード変更なしのため、二重実行リスクは「runbook 手順の再実行」と「env 追記の重複」に限られる。

| 処理 | 二重実行リスク | ガード |
|---|---|---|
| `prisma migrate deploy` の再実行 | なし | Prisma が `_prisma_migrations` テーブルで適用済 migration を skip（公式仕様）。runbook に「再実行は安全」と明記 |
| `CREATE EXTENSION ... vector` | なし | `IF NOT EXISTS` 付き（init L19 既存）で冪等 |
| .env.example へのコメントブロック追記 | **あり**（実装を 2 回走らせると重複追記） | 実装担当は追記前に `grep -c "pgbouncer=true" apps/api/.env.example` で 0 を確認してから追記する |
| Neon プロジェクト作成 | あり（同名プロジェクトの二重作成） | runbook 冒頭に「既存プロジェクト一覧を確認してから作成」のステップを置く。Neon は同名作成を許すため名前規約（`training-bot-rag-hub`）を固定する |

DB 書き込みを伴う新規アプリ処理は本フェーズに存在しないため、idempotency-key / claim-first 系のガードは **N/A**（根拠: 成果物は runbook + env テンプレート + 既存 migration の適用のみで、INSERT/upsert を行うコードを一切追加しない）。

---

## 6. テストすべき観点（後続テスト担当向け）

- `npm --prefix apps/api run prisma:validate` が pass する（schema と env 参照の整合）
- Neon（または pgvector/pgvector:pg16 のクリーン DB）に対し `prisma migrate deploy` が exit 0 / `migrate status` が "up to date"
- 適用後 DB 検証（SQL）:
  - `SELECT extname FROM pg_extension WHERE extname = 'vector'` が 1 行
  - rag_* 全 17 テーブルが存在
  - `rag_embeddings` への `vector_dims` CHECK 違反 INSERT が reject される（dimension=3 で 2 次元 vector を入れる等）
  - HNSW 部分式 index / 部分 unique（idempotency_key）/ 複合 FK（rag_citations）が `pg_indexes` / `pg_constraint` に存在
- **Pooler URL 経由の実行時クエリ**: `DATABASE_URL`（pgbouncer=true 付き）で Prisma Client の `findMany` 等が連続 2 回成功する（prepared statement 重複エラーが出ないこと = pgbouncer=true の効果確認）
- **Direct URL 経由の migration**: pooler URL を `DIRECT_URL` に誤設定した場合に migrate が失敗する（advisory lock が pooler 経由で取れない）ことの確認は任意（negative control）
- .env.example 2 ファイルに既存キーの削除・改変がないこと（`git diff` が追記のみ）
- runbook のコマンドが全てコピペ実行可能（変数 placeholder 以外に手修正不要）であること

## 7. レビュー観点

**architecture reviewer**:
- 判断 1（dead migration 回避）の妥当性 — ブリーフ成果物リストとの差分が設計書で明示・裁定可能になっているか
- 判断 3 の接続パラメータ（`pgbouncer=true` / `connection_limit=1` / `sslmode=require` / `schema=public`）が Neon + Prisma 5.22 + 将来の Vercel Functions 前提と整合するか
- `schema=public` 踏襲が既存 init migration ヘッダの `?schema=rag` 記述と矛盾して見える点 — 正本は apps/api/.env.example のコメント（public 採用 + 理由）であることの確認
- 後続フェーズ（serverless 化）への引き継ぎ事項が runbook に混入していないか（スコープ境界）

**quality reviewer**:
- 接続文字列・パスワード等の実値が runbook / .env.example / 設計書に書かれていないか（placeholder のみか）
- .env.example の変更が「追記のみ・既存値無削除」になっているか
- runbook のトラブルシュート表が実エラーメッセージ（`P1001` / prepared statement / type "vector" does not exist）と対応しているか
- 冪等性ガード表（§5）の grep ガードが実装 commit に反映されているか
- 外部ドキュメント URL が実在する（WebFetch で疎通確認済か、実装担当が確認した旨の記録があるか）

---

## 付録: 判断サマリ（eng-pm 裁定用）

| # | 論点 | 推奨 | ブリーフとの差分 |
|---|---|---|---|
| 1 | pgvector 有効化 | init migration 既存行に委ねる（新規 migration 作らない） | あり（成果物 3 点目を省略） |
| 2 | direct URL 変数名 | `DIRECT_URL` 維持 | あり（`DATABASE_URL_DIRECT` 不採用） |
| 3 | 接続 URL 構成 | Pooler+pgbouncer=true（実行時）/ Direct（migration） | なし（ブリーフ通り） |
