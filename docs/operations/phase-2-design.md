# Phase 2 設計書 — NestJS serverless 化 + vercel.json + docker-compose クリーンアップ

- 作成日: 2026-06-11
- 作成者: eng-backend（設計フェーズ担当）
- ステータス: 設計レビュー待ち
- 対象リポジトリ: `/Volumes/DevShare/projects/training-bot-rga-hub`
- 前フェーズ設計書: `docs/operations/phase-1-design.md` / runbook: `docs/operations/neon-setup.md`

---

## 1. 目的と前提

### 目的

NestJS API（`apps/api`）を **Vercel Functions（@vercel/node ランタイム）** で動かせるようにする。具体的には:

1. `apps/api/api/index.ts` に Vercel Functions エントリを追加（INestApplication を module-level でキャッシュし、express handler として呼び出す）
2. リポジトリルートに `vercel.json` を置き、builds / routes を設定
3. 未使用の Redis を docker-compose / ルート npm scripts から撤去（postgres はローカル開発用に残す）

### 入力となる前フェーズの成果物（実機確認済 / 2026-06-11）

| 既存物 | 場所 | 本フェーズへの影響 |
|---|---|---|
| Neon 用 接続文字列テンプレ | `apps/api/.env.example`（Pooled = `DATABASE_URL` / Direct = `DIRECT_URL` コメント済） | Vercel の環境変数にそのまま転記する前提。`pgbouncer=true&connection_limit=1` が serverless 用に既設計 |
| Prisma schema | `apps/api/prisma/schema.prisma`（`directUrl` 既設 / pgvector は init migration L19） | serverless エントリからは既存 `PrismaModule` をそのまま使う。schema 変更なし |
| Neon runbook | `docs/operations/neon-setup.md` | 「docker-compose 撤去（Redis 削除）は別フェーズ」と明記 → **本フェーズがその別フェーズ** |
| 既存 bootstrap | `apps/api/src/main.ts`（`setGlobalPrefix('api/v1', { exclude: ['health'] })` / PORT listen） | prefix 設定ロジックを serverless エントリと共有する必要あり（§4-1） |

### スコープ外（後続フェーズ）

- Vercel Authentication（Standard Protection）の有効化 + アプリ側 Bearer Token guard の実装（非公開化ダブルロック）
- Vercel 実機デプロイ・環境変数投入（ふみさん手作業 / runbook は本フェーズ成果物に含めない。デプロイ runbook は後続フェーズで `docs/operations/vercel-deploy.md` として作成想定）
- `npm install` の実行（**SMB 上での install は禁止 / package.json 編集のみ。install はふみさん側で実施**）

### ブリーフとの差分（eng-pm 裁定事項）— 必読

実機確認の結果、ブリーフの「構成上のキー判断」のうち 1 点に技術的な不整合を検出した。§3 判断 1 で詳述するが、結論サマリ:

1. **`@vendia/serverless-express` は AWS Lambda イベント変換ライブラリであり、Vercel では不要かつ不適合**。Vercel の Node ランタイムは素の `http.IncomingMessage` / `http.ServerResponse` 互換オブジェクトをハンドラに渡すため、Lambda イベント → HTTP 変換を行う serverless-express を挟む場所がない。**推奨は `app.getHttpAdapter().getInstance()` で express インスタンスを直接呼ぶ方式（依存追加ゼロ）**。
2. 追加で発見した **潜在ブロッカー**: `@pmtp/shared` は tsconfig `paths` のみで解決されており、`apps/api/node_modules/@pmtp/` は存在しない（実機 `ls` で確認）。`nest start` は CLI が tsconfig-paths を登録するため動くが、**Vercel 上の関数ランタイムでは `require('@pmtp/shared')` が解決できず即死する**。`file:` プロトコル依存の追加が必須（§3 判断 3）。

---

## 2. 想定コスト

### 実装工数（人間想定 × 2/3 のエージェント係数適用）

| 作業 | 人間想定 | 係数後 |
|---|---|---|
| bootstrap 共通化（`create-app.ts` 抽出 + main.ts 改修） | 1.5h | 1.0h |
| `apps/api/api/index.ts` 新規作成 | 1.5h | 1.0h |
| `vercel.json` 新規作成 | 1.0h | 0.67h |
| package.json 2 ファイル編集 + docker-compose 編集 | 0.5h | 0.33h |
| ローカル検証（typecheck / test / docker compose config） | 1.0h | 0.67h |
| **合計** | **5.5h** | **約 3.7h** |

※ Vercel 実機デプロイ検証はふみさんのアカウント操作（環境変数投入・デプロイ実行）が必要なため本フェーズ工数に含めない。

### 月額運用実費

- **¥0**。Vercel Hobby（無料 / 個人非商用）+ Neon Free。新規依存の追加は `file:` ローカル参照のみで外部 SaaS 契約なし

### 隠れコスト

- **コールドスタート二重発生**: Vercel 関数のコールドスタート（NestJS DI コンテナ初期化 ≒ 数百 ms〜1s）+ Neon autosuspend 再開（数百 ms〜数秒）が重なると初回リクエストが数秒かかる。個人非公開運用では許容
- **Hobby プランの関数制限**: 実行時間上限 10s（デフォルト）/ メモリ 1024MB。RAG の LLM 呼び出し（OpenAI）が長引くと 10s を超えるリスク → `vercel.json` の `maxDuration` 調整余地はあるが Hobby は上限 60s（要実機確認）。超過時はレスポンス分割等の設計変更が必要になる（後続フェーズの検討事項）
- **`builds` 配列使用時の Vercel ダッシュボード Build 設定無効化**: `vercel.json` に `builds` を書くとダッシュボードの Build & Development Settings が無視される（Vercel 公式仕様）。設定が「コードに固定される」こと自体は望ましいが、ダッシュボードから挙動を変えられない点は認識しておく
- **Prisma engine サイズ**: `@prisma/client` + query engine で関数バンドルが数十 MB になる。Hobby の関数サイズ上限 250MB（解凍後）には収まる見込みだが、ビルドログでサイズ確認を推奨

### ゼロコスト代替案

- 本フェーズ自体がゼロコスト構成（Vercel Hobby + Neon Free）への移行作業であり、追加実費ゼロ。さらにコストを削る選択肢としては「ローカル docker-compose 運用の継続」だが、SMB I/O 不安定で dev サーバが落ちる現問題が解消されないため不採用

---

## 3. アーキテクチャ判断

### 判断 1: NestJS → Vercel handler の変換方式

| 観点 | 案 A: express インスタンス直接呼び出し | 案 B: @vendia/serverless-express（ブリーフ記載） | 案 C: esbuild で単一ファイルにバンドル + custom handler |
|---|---|---|---|
| 仕組み | `app.init()` 後に `app.getHttpAdapter().getInstance()` で express を取り出し `(req, res)` を直接渡す | Lambda イベント（API Gateway 形式）を HTTP に変換して express へ proxy | ビルド時に依存ごと 1 ファイル化し Node ランタイムで実行 |
| Vercel との適合 | ◎ Vercel の Node ランタイムは `(req, res)` を渡す素の HTTP モデル。変換層が不要 | ✗ **serverless-express の入力は Lambda イベントオブジェクト。Vercel は Lambda イベントを渡さないため変換層が成立しない**（無理に使うには偽イベントの自作が必要 = 本末転倒） | ○ 動くが @vercel/node が同等のトレース/バンドルを内蔵しており二重投資 |
| 追加依存 | なし | `@vendia/serverless-express`（+ `@types/aws-lambda`） | esbuild + ビルドスクリプト |
| AWS Lambda への将来移植 | エントリ書き換えで対応可 | ◎ そのまま使える | △ |
| 実装量 | 最小（~40 行） | 中 + 偽イベント変換の独自実装リスク | 大 |

**推奨: 案 A**。ブリーフのキー判断（案 B）は「NestJS serverless 化 = serverless-express」という AWS Lambda 圏の定石を Vercel に転写したものと推察するが、Vercel の Node ランタイムは express ハンドラシグネチャ `(req, res)` をネイティブに受けるため変換層自体が不要。NestJS 公式 FAQ の serverless 章でも Vercel 系は express インスタンス直接呼び出しが標準形。

> **eng-pm 裁定依頼**: 案 A 採用なら「`@vendia/serverless-express` の依存追加」という成果物項目は **削除** が正。将来 AWS Lambda 移植の布石として依存だけ先置きする選択肢もあるが、未使用依存の追加は最小構成原則に反するため非推奨。本設計書は案 A 前提で §4 を記述し、裁定で案 B 強行となった場合のみ §4-2 の代替記述に差し替える。

### 判断 2: vercel.json の構成方式

| 観点 | 案 A: ルート vercel.json + `builds` + `routes`（ブリーフ記載） | 案 B: Vercel Root Directory = `apps/api` + `/api` 自動検出 | 案 C: `buildCommand` + `outputDirectory` のモダン設定 |
|---|---|---|---|
| モノレポ対応 | ◎ リポジトリ全体がビルドコンテキスト。`packages/shared` を含められる | ✗ Root Directory 外の `packages/shared` がアップロード対象外になり import 不能 | △ serverless 関数のカスタムエントリ指定が `/api` ディレクトリ規約に縛られる |
| 設定の所在 | コード（vercel.json）に固定 | ダッシュボード設定に依存 | 混在 |
| 制約 | `builds` 使用時はダッシュボード Build 設定が無視される（許容） | — | — |

**推奨: 案 A（ブリーフ通り）**。`packages/shared` への依存がある以上、ビルドコンテキストはリポジトリルート必須であり、`builds` + `routes` が唯一モノレポ構成と両立する。

### 判断 3: `@pmtp/shared` のランタイム解決（本設計書で新規検出したブロッカー）

現状 `apps/api` の依存に `@pmtp/shared` が無く、tsconfig `paths` のみで解決している（`apps/api/node_modules/@pmtp/` 不在を実機確認）。tsconfig paths は **型解決のみ** で emit された JS の `require('@pmtp/shared')` は書き換えられないため、Vercel 関数ランタイムでは `MODULE_NOT_FOUND` で即死する。

| 観点 | 案 A: `file:../../packages/shared` 依存追加 | 案 B: tsconfig paths のまま @vercel/node のエイリアス解決に期待 | 案 C: `tsconfig-paths/register` を関数エントリで require |
|---|---|---|---|
| 確実性 | ◎ npm が `node_modules/@pmtp/shared` に link/copy → 標準の Node 解決で動く。nft（Vercel のファイルトレース）も追跡可能 | ✗ @vercel/node は emit 後 JS の paths 書き換えを保証しない | △ 動くが tsconfig.json + dist の同梱が必要で関数サイズ増・脆い |
| ローカルへの影響 | `npm install` 再実行が必要（ふみさん側で実施）。既存 tsconfig paths と共存可（型は paths、ランタイムは node_modules） | なし | なし |
| 副作用 | `node dist/main.js`（`npm start`）が **現状壊れている潜在問題も同時に直る** | 潜在問題温存 | 温存 |

**推奨: 案 A**。`packages/shared/package.json` は `main: dist/index.js` / `types: dist/index.d.ts` が整備済みで `file:` 参照にそのまま耐える。

### 判断 4: Redis 撤去の範囲

ブリーフ明示分は (a) docker-compose の redis サービス + `rag_redis_data` volume、(b) ルート package.json の `redis:cli`。実機 grep の結果、以下の Redis 残置物を追加検出した:

| 残置物 | 扱い | 理由 |
|---|---|---|
| ルート `.env.example` の `REDIS_HOST_PORT=` / `REDIS_URL=`（L11-12） | **同一フェーズで削除を推奨** | docker-compose から redis が消えた後は参照先のない死に設定。残すと「どこかで使っている」誤認を生む |
| `apps/api/src/__tests__/phase1-migration-static.spec.ts` L249-251（`REDIS_URL=` 保持を assert するテスト） | **上記とセットで削除（テスト 1 件）** | このテスト自体が「Redis 撤去は後続フェーズ」と注記しており、本フェーズがその後続フェーズ。env キーだけ消すとテストが落ちるため必ずセットで変更 |
| `docker/redis/` ディレクトリ（redis.conf） | **同一フェーズで削除を推奨** | docker-compose の volume mount 参照元。サービス削除後は孤児ファイル |
| `networks: rag_local` | **残す** | postgres が引き続き使用 |

> **eng-pm 裁定依頼**: 上記 3 点はブリーフ未記載だが、redis サービス削除と論理的に一体（参照整合）。「変更範囲の限定」原則とのトレードオフを認識した上で、**死に設定の同時撤去を推奨**する。裁定で「ブリーフ厳守」となった場合は docker-compose + `redis:cli` のみ変更し、残置 3 点を tech-debt として起票する。

---

## 4. ファイル別実装指示

### 4-1. `apps/api/src/create-app.ts`（新規 / bootstrap 共通化）

- **目的**: `setGlobalPrefix('api/v1', { exclude: ['health'] })` 等のアプリ構成ロジックを main.ts（ローカル listen）と api/index.ts（serverless）で二重持ちしないための共通ファクトリ
- **主要ロジック**:
  ```ts
  import { NestFactory } from '@nestjs/core'
  import type { INestApplication } from '@nestjs/common'
  import { AppModule } from './app.module'

  export async function createApp(): Promise<INestApplication> {
    const app = await NestFactory.create(AppModule, { bufferLogs: true })
    app.setGlobalPrefix('api/v1', { exclude: ['health'] })
    return app
  }
  ```
- `main.ts` は `createApp()` → `app.listen(port)` に簡素化（既存コメントの趣旨は維持）
- 参考: NestJS 公式 FAQ serverless 章 https://docs.nestjs.com/faq/serverless

### 4-2. `apps/api/api/index.ts`（新規 / Vercel Functions エントリ）

- **目的**: Vercel の Node ランタイムから NestJS（express）へリクエストを引き渡すハンドラ。コールドスタートコストを invocation 間で償却するため INestApplication を module-level キャッシュする
- **主要ロジック**（判断 1 案 A 前提）:
  ```ts
  import 'reflect-metadata'
  import type { IncomingMessage, ServerResponse } from 'node:http'
  import type { INestApplication } from '@nestjs/common'
  import { createApp } from '../src/create-app'

  // app ではなく「初期化 Promise」をキャッシュする（§5 冪等性ガード G-1）
  let appPromise: Promise<INestApplication> | undefined

  async function getApp(): Promise<INestApplication> {
    if (!appPromise) {
      appPromise = createApp().then(async (app) => {
        await app.init() // listen はしない（Vercel がソケットを管理）
        return app
      })
    }
    return appPromise
  }

  export default async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const app = await getApp()
    const expressInstance = app.getHttpAdapter().getInstance()
    expressInstance(req, res)
  }
  ```
- **注意点**:
  - `await app.listen()` は呼ばない（ポート bind は Vercel 側の責務 / `app.init()` のみ）
  - 初期化失敗時は `appPromise = undefined` に戻して次 invocation で再試行できるよう `.catch` でリセットする（握り潰さず `console.error` でログにも残す）
  - tsconfig: `apps/api/tsconfig.json` の `include` は `src/**` のみで `rootDir: ./src` のため、`api/` を加えると TS6059 になる。**nest build には含めず**、typecheck 用に `apps/api/api/tsconfig.json`（`extends: ../tsconfig.json` / `rootDir` を `..` に / `noEmit: true` / `include: ["./**/*.ts", "../src/**/*.ts"]`）を新設し、`typecheck:vercel` script で検証する。Vercel 上のコンパイルは @vercel/node が行うためビルド成果物は不要
- 参考: Vercel Node.js ランタイム https://vercel.com/docs/functions/runtimes/node-js / NestJS serverless FAQ https://docs.nestjs.com/faq/serverless

### 4-3. `apps/api/package.json`（編集）

- **目的**: ランタイム解決の確立（判断 3）と Vercel build 時の Prisma client 生成
- **変更内容**:
  1. `dependencies` に `"@pmtp/shared": "file:../../packages/shared"` を追加（判断 3 案 A）
  2. `scripts` に `"postinstall": "prisma generate"` を追加 — @vercel/node は `builds` モードで entry 直近の package.json の install を実行するが、`vercel-build` script は実行しない（それは @vercel/static-build の規約）。Prisma client 生成は postinstall フックが唯一確実な注入点（Prisma 公式の Vercel デプロイ手順と同じ）
  3. `scripts` に `"typecheck:vercel": "tsc --noEmit -p api/tsconfig.json"` を追加
  4. （判断 1 が案 B 裁定の場合のみ）`"@vendia/serverless-express": "^4"` を追加。**案 A 裁定なら追加しない**
- **npm install は実行しない**（SMB 並列 install 禁止 / ふみさん側で `npm install --prefix apps/api` を実施）
- 参考: Prisma + Vercel https://www.prisma.io/docs/orm/prisma-client/deployment/serverless/deploy-to-vercel
- 補足（実装ではなくコメントで残す）: Vercel build マシンは rhel 系のため build 上で `prisma generate` する限り `binaryTargets` 追記は不要。CI 等別環境で generate したバンドルを持ち込む構成に変えるときは `binaryTargets = ["native", "rhel-openssl-3.0.x"]` が必要になる

### 4-4. `vercel.json`（新規 / リポジトリルート）

- **目的**: モノレポルートをビルドコンテキストに `apps/api/api/index.ts` を単一関数としてビルドし、全パスをルーティングする
- **内容**:
  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "version": 2,
    "builds": [
      {
        "src": "apps/api/api/index.ts",
        "use": "@vercel/node",
        "config": {
          "includeFiles": ["apps/api/prisma/**", "packages/shared/dist/**"]
        }
      }
    ],
    "routes": [
      { "src": "/health", "dest": "/apps/api/api/index.ts" },
      { "src": "/api/v1/(.*)", "dest": "/apps/api/api/index.ts" },
      { "src": "/(.*)", "dest": "/apps/api/api/index.ts" }
    ]
  }
  ```
- **注意点**:
  - `includeFiles` の `apps/api/prisma/**` は Prisma が実行時に schema を参照するケース（migrate 系は使わないが engine 解決の保険）、`packages/shared/dist/**` は nft トレース漏れの保険。ビルドログで関数サイズと同梱物を確認し、不要が確定したら後続フェーズで削る
  - routes は実質 catch-all 1 本で足りるが、`/health`（prefix 除外パス）と `/api/v1/*` を明示しておくと意図が読める。順序は上から評価
  - `builds` を使うとダッシュボードの Build & Development Settings が無視される（§2 隠れコスト）
  - **既知リスク**: @vercel/node のヘルパー（`req.body` 先読みパース）と express 側 body-parser が競合し、POST body が空になる事象が報告されている。発生した場合は Vercel 環境変数 `NODEJS_HELPERS=0` でヘルパーを無効化する（実機デプロイ検証時の確認項目 / §6）
- 参考: vercel.json 仕様 https://vercel.com/docs/project-configuration / builds https://vercel.com/docs/project-configuration#builds

### 4-5. `docker-compose.yml`（編集）

- **目的**: 未使用 Redis の撤去。postgres はローカル開発・migration 検証用に残す
- **変更内容**:
  1. `services.redis` ブロック全体（L26-42）を削除
  2. `volumes.rag_redis_data`（L46）を削除
  3. `networks.rag_local` は **残す**（postgres が参照中）
  4. `services.postgres` は無変更
- **検証**: `docker compose config` が exit 0 で通り、出力に redis が含まれないこと

### 4-6. ルート `package.json`（編集）

- **目的**: 撤去した redis サービスへの導線を消す
- **変更内容**: `scripts` から `"redis:cli": "docker compose exec redis redis-cli"`（L28）を削除。他 scripts は無変更（`docker:*` / `db:psql` は postgres 用に残す）

### 4-7. （判断 4 裁定後）Redis 残置物の同時撤去

- ルート `.env.example` から `REDIS_HOST_PORT=` / `REDIS_URL=`（L11-12）と直後の空行整理
- `apps/api/src/__tests__/phase1-migration-static.spec.ts` L249-251 の `REDIS_URL=` 保持テストを削除（describe 内の他テストは無変更）
- `docker/redis/` ディレクトリを削除
- ※ 裁定で「ブリーフ厳守」となった場合は本項スキップ + tech-debt 起票

---

## 5. 冪等性ガード

本フェーズに DB 書き込み・外部 API 呼び出し・claim 系処理は含まれないため、トランザクション系ガードは N/A。ただし serverless エントリ固有の **並行初期化レース** が二重実行リスクに該当する:

| # | リスク | ガード | 実装箇所 |
|---|---|---|---|
| G-1 | 同一関数インスタンスへ同時に複数リクエストが着弾し、`NestFactory.create` が二重実行される（DI コンテナ二重生成 / Prisma 接続二重化 → Neon Free の接続枯渇を早める） | **app ではなく初期化 Promise を module-level でキャッシュ**する。2 リクエスト目以降は同一 Promise を await するため bootstrap は高々 1 回 | `apps/api/api/index.ts`（§4-2 のコード形） |
| G-2 | 初期化失敗（Neon 疎通不可等）した Promise がキャッシュに残り続け、以後の全リクエストが恒久 500 になる | 失敗時に `appPromise = undefined` へリセットして次 invocation で再 bootstrap させる。エラーは `console.error` でログに残す（握り潰さない） | 同上 |

その他のファイル（vercel.json / docker-compose / package.json）は宣言的設定のみで実行時の二重実行概念がなく N/A。

---

## 6. テストすべき観点（後続テスト担当向け）

ローカルで完結する検証（Vercel 実機なし）:

- **静的検証（phase1-migration-static.spec.ts と同型のスタイル推奨）**:
  - `vercel.json` が JSON として parse でき、`builds[0].src === 'apps/api/api/index.ts'` / `use === '@vercel/node'` / routes に catch-all が存在する
  - `docker-compose.yml`（parse 後）に `services.redis` / `volumes.rag_redis_data` が存在しない / `services.postgres` と `networks.rag_local` は存在する
  - ルート `package.json` に `redis:cli` が存在しない / `docker:up` 等の既存 scripts は保持
  - `apps/api/package.json` に `@pmtp/shared`（`file:` プロトコル）と `postinstall: prisma generate` が存在する
- **create-app.ts の単体テスト**: `createApp()` が返す app で `/health` が prefix なし、`/api/v1/*` 配下に既存ルートが生えること（supertest + `app.init()` / 既存 e2e と同型）
- **api/index.ts のハンドラテスト**:
  - 2 回連続でハンドラを呼んでも `NestFactory.create` が 1 回しか呼ばれない（G-1 / NestFactory を jest.spyOn）
  - 初期化が reject した後の再呼び出しで bootstrap が再試行される（G-2）
  - ハンドラが express インスタンスに req/res をそのまま委譲する
- **回帰**: 既存 `npm test` / `npm run typecheck` / `npm run lint` が全 pass（main.ts 改修のデグレ検出）
- **Vercel 実機（ふみさんデプロイ後の手動確認項目として runbook 化を後続フェーズへ引き継ぎ）**: GET `/health` 200 / POST 系エンドポイントで body が空にならないこと（NODEJS_HELPERS 競合の検出 / §4-4）/ コールドスタート後の初回レスポンス時間

## 7. レビュー観点

**architecture reviewer**:

- 判断 1（serverless-express 不採用）の妥当性 — Vercel ランタイムのハンドラシグネチャ理解が正しいか。**外部仕様の実機検証なし固定（盲点 8）に該当する領域**のため、実装フェーズで Vercel 公式ドキュメント該当節の引用 or 最小実機検証を要求するか判断
- 判断 3（`file:` 依存）がローカル開発フロー（`npm run dev` / nest start の tsconfig-paths 解決）と衝突しないか
- bootstrap 共通化（create-app.ts）で main.ts と api/index.ts の構成が乖離しない構造になっているか（global prefix 等の二重持ち排除）
- `includeFiles` の保険が過剰包含（関数サイズ肥大）になっていないか

**quality reviewer**:

- G-1/G-2（Promise キャッシュ + 失敗時リセット）が §4-2 のコード通りに実装されているか — **自己制約 3 の対照確認対象**（本設計書 §5 が冪等性ガード節）
- エラーハンドリング: 初期化失敗が `console.error` に残り、ユーザー向けには 500 + 汎用メッセージになるか（スタックトレース漏洩なし / 接続文字列等の Secret がログに出ないか）
- `api/tsconfig.json` 新設で既存 `typecheck` / `nest build` の対象範囲が変わっていないか（rootDir 競合の TS6059 回避が正しいか）
- 判断 4 の撤去がテスト（phase1-migration-static.spec.ts）とセットで行われ、テストが green のまま整合しているか
- ブリーフ外ファイルへの変更が §3 判断 4 で裁定された範囲に収まっているか（スコープ混入検出）

---

## PSP 計測値（設計フェーズ）

```yaml
psp:
  actual-duration: 0.4h        # 既存コード実機調査（main.ts / tsconfig / docker-compose / env / shared 解決確認）+ 設計書執筆
  bug-count: 0                 # 設計フェーズのため対象外（ブリーフ不整合 2 件の検出は bug-count に含めない）
  code-volume:
    files-changed: 1           # 本設計書のみ（実装ファイルは次フェーズ）
    lines-added: 約 250
    lines-deleted: 0
estimate-vs-actual:
  estimated: 1.0h              # 人間想定 1.5h × 2/3（設計書カテゴリ）
  actual: 0.4h
  deviation-pct: -60
```
