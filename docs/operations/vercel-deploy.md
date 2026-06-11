# Vercel 初回 deploy runbook（Phase 3）

- 作成日: 2026-06-11
- 対象: training-bot-rag-hub（apps/api / NestJS serverless）
- 前提フェーズ: Phase 1（Neon 移行）/ Phase 2（serverless 化）/ Phase 3（Bearer Token 認証）
- 関連設計書: `docs/operations/phase-2-design.md` / `docs/operations/phase-3-design.md` / `docs/operations/neon-setup.md`
- スコープ: ふみさんが単独で初回 deploy → smoke-test まで完走できる手順

## 0. このランブックの使い方

- 各章の手順は **上から順** に実施。途中で躓いたら次に進まず、§7「トラブルシュート」と `smoke-test.md` の判別表を先に当てる
- 値を埋める箇所は `<…>` 表記。**実値・トークン・シークレットは本ランブックに書かない**（書いた瞬間に Git 履歴で露出）
- 認証情報の保管は **パスワードマネージャ**（1Password / Bitwarden 等）に「Vercel: training-bot-rag-hub」項目を作って一元化

---

## 1. 前提確認

実施前に以下が満たされていることをチェック:

- [x] GitHub の自リポジトリ（例: `vincentmango-wen/training-bot-rga-hub`）に最新コードが push 済
- [x] リポジトリのルートに `vercel.json` が存在し、`/health` / `/api/v1/`* / フォールバックが同一関数 `apps/api/api/index.ts` に向いている（Phase 2 通過済）
- [x] `apps/api/api/index.ts` が初期化 Promise キャッシュ（G-1 / G-2）実装済（Phase 2 通過済）
- [x] Neon の接続文字列 2 種を手元に保持
  - Pooled URL（`-pooler` ホスト / `?sslmode=require&pgbouncer=true&connection_limit=1&schema=public`）
  - Direct URL（`-pooler` 無し / `?sslmode=require&schema=public`）
  - 詳細は `docs/operations/neon-setup.md`
- [x] OpenAI API キーを手元に保持（未保有なら [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys) から発行）
- [ ] ローカルで `openssl` が叩ける（macOS は標準）

---

## 1.5. 初回 deploy 前のローカル準備（lockfile 同期 / B-2）

> 背景: `apps/api` は `@pmtp/shared`（モノレポ内 package）を `file:../../packages/shared`
> 形式で参照している。`apps/api/package-lock.json` にこの依存関係が反映されていないと、
> Vercel ビルド時の `npm ci` で lockfile 不整合エラーとなり deploy が失敗する。
> Vercel 側の `postinstall` は `packages/shared` の **ビルド**は実行するが、
> **lockfile の同期は git push 前にローカルで完了させておく必要がある**。

push 前に以下の順序で実行（**SMB マウント上で並列実行禁止 / 必ず 1 つずつ直列**）:

```bash
# 1. shared パッケージの依存をインストール
npm install --prefix packages/shared

# 2. shared を build して dist/ を生成（apps/api の TypeScript 解決に必要）
npm --prefix packages/shared run build

# 3. apps/api の依存をインストール（@pmtp/shared への file: 参照を lockfile に確定）
npm install --prefix apps/api

# 4. lockfile 差分を確認
git status apps/api/package-lock.json packages/shared/package-lock.json

# 5. 差分があれば commit に含める（実値・トークンは含まれない / 安全）
git add apps/api/package-lock.json packages/shared/package-lock.json
git commit -m "chore: sync lockfile for @pmtp/shared workspace dep"
```

検証ポイント:

- [ ] `apps/api/package-lock.json` の `packages` セクションに `node_modules/@pmtp/shared`
  ```
  が `"resolved": "../../packages/shared"` 形式で記載されている
  ```
- [ ] `packages/shared/dist/index.js` と `packages/shared/dist/index.d.ts` が生成済
  ```
  （gitignore 対象だが、Vercel の postinstall がビルドで再生成する）
  ```
- [ ] `node_modules/@pmtp/shared` が symlink として `packages/shared` を指している

トラブル時:

- `npm ci` が「lockfile out of sync」で落ちる → 上記手順 1-3 を再実行し lockfile を再生成
- `packages/shared/dist not found` が build ログに出る → §7「トラブルシュート」参照
（根本原因は `apps/api/package.json` の `postinstall` が shared build を呼ぶ実装になっていることを確認）

---

## 2. Vercel プロジェクト作成

1. [https://vercel.com](https://vercel.com) にログイン（GitHub OAuth）
2. 右上「Add New…」→ **Project** を選択
3. **Import Git Repository** で `training-bot-rga-hub` を選択
4. **Configure Project** 画面:
  - **Project Name**: 任意（例: `training-bot-rag-hub`）。後で変えにくいので確定値を入れる
  - **Framework Preset**: `Other`
  - **Root Directory**: `./`（ルート）。**変更しない**
  - **Build & Output Settings**: そのまま（`vercel.json` の `builds` 設定が優先されるため、ダッシュボード側の Build Command / Output Directory は無視される。Phase 2 設計書 §2 隠れコスト参照）
5. **Environment Variables** セクションは次章で投入するため、ここでは **何も入れず空のまま** 進む
6. 「**Deploy**」を**まだ押さない**。Stop / Skip Deployment があれば押す。なければ先に Deploy が走ってしまうが、後で環境変数を投入して再 deploy するので OK（最初の 1 回は確実に失敗する）

---

## 3. 環境変数の投入

Project Settings → **Environment Variables** から以下を 1 つずつ追加。すべて **Sensitive** にチェックを入れる（ダッシュボードで値の再表示を不可にする）。

### 3-1. 投入対象一覧


| Key                | 値の取得元                                                                                               | Environment                           |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `DATABASE_URL`     | Neon Pooled URL（`-pooler` ホスト + `?sslmode=require&pgbouncer=true&connection_limit=1&schema=public`） | Production / Preview / Development 全部 |
| `DIRECT_URL`       | Neon Direct URL（`-pooler` 無し + `?sslmode=require&schema=public`）                                    | Production / Preview / Development 全部 |
| `OPENAI_API_KEY`   | OpenAI ダッシュボード                                                                                      | Production / Preview / Development 全部 |
| `API_BEARER_TOKEN` | **次節 §3-2 で生成**                                                                                     | Production / Preview / Development 全部 |


### 3-2. `API_BEARER_TOKEN` の生成

ローカルターミナルで以下を実行（**シェル履歴に値が残る点**に注意。気になる場合は `read -s` で標準入力経由にする）:

```bash
openssl rand -hex 32
```

64 桁の 16 進文字列（256-bit エントロピー）が出る。これを Vercel 環境変数 `API_BEARER_TOKEN` の値として投入し、**同じ値**をパスワードマネージャに保管。ローカル `.env`（`apps/api/.env`）にも同じ値を書いて 3 箇所同期する（ローカル開発時の Bearer 認証用）。

> ⚠️ 値をブラウザのアドレスバーや URL 引数に入れない（履歴・referrer 経由で露出する）。

### 3-3. 投入後の確認

Project Settings → Environment Variables 画面で 4 件すべてが「Sensitive」表示になっていることを目視確認。

---

## 4. Deployment Protection（外側のロック）有効化

1. Project Settings → **Deployment Protection**（左サイドバー）
2. **Vercel Authentication** セクション:
  - **Standard Protection** を有効化
  - 公式ドキュメント: [https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
  - ⚠️ **要実機確認**: Standard Protection の保護範囲（特に Production custom domain / preview URL の扱い）は公式ドキュメントの**現時点の記載**で確認する。本ランブック作成時の理解と将来の Vercel 仕様が変わっている可能性あり（設計書 §3 判断 5 / 自己制約 4 観点）。最終的な保護有効性は §6 の smoke-test Test 1 で**実機検証**する
3. **Protection Bypass for Automation** セクション:
  - **Create Secret** を押して bypass secret を発行（curl / スクリプト疎通用）
  - 値をパスワードマネージャに保管（**ダッシュボードを閉じると再表示されないものがある**）
  - 公式ドキュメント: [https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)

> **bypass secret の取扱**: 漏洩したら Standard Protection が形骸化する。GitHub Issue / PR / Slack に貼らない。再発行すると旧 secret は即無効化される（§9 ローテーション参照）。

---

## 5. 初回 deploy

### 5-1. Deploy トリガー

- 環境変数投入後、Deployments タブ → 直近の deployment（あれば失敗しているはず）の右上「**Redeploy**」を押す
- もしくは GitHub に空コミットを push して新規 deployment を発火させる:
  ```bash
  git commit --allow-empty -m "chore: trigger initial vercel deploy"
  git push
  ```

### 5-2. ビルドログの確認ポイント

Deployments → 該当 deployment → **Build Logs** を開き、以下を確認:


| チェック項目                           | 失敗時の症状                              | 対処                                                                   |
| -------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `prisma generate` が成功            | `Error: schema.prisma not found`    | `vercel.json` の `builds` 設定で `installCommand` が `apps/api` を含むか確認    |
| `@pmtp/shared` が解決できる            | `Cannot find module '@pmtp/shared'` | `packages/shared` の `dist/` が build 前に生成されているか確認                     |
| 関数サイズが Hobby plan 上限内            | `Function exceeds size limit`       | `vercel.json` の `includeFiles` / `excludeFiles` で `node_modules` を絞る |
| `apps/api/api/index.ts` の export | `Handler not found`                 | `export default async function(req, res)` 形式になっているか                  |


### 5-3. deploy 完了後の URL

- Production URL: `https://<project-slug>.vercel.app`（または独自ドメイン設定がある場合はそちら）
- これを **以降の手順の `BASE_URL`** として使う

---

## 6. Migration 適用（ローカルから Neon に対して実行）

> **方針**: Vercel build 中に `prisma migrate deploy` を走らせない。理由 = build 並列実行時（preview deploy が複数本走る等）に二重 migrate が衝突するリスク。ローカルから 1 回だけ手動実行する。

### 6-1. ローカル `.env` を準備

`apps/api/.env` に `DIRECT_URL` を Neon の **Direct URL**（`-pooler` 無しホスト）で設定:

```
DIRECT_URL=postgresql://<role>:<password>@<endpoint>.<region>.aws.neon.tech/<db>?sslmode=require&schema=public
```

### 6-2. Migrate 実行

```bash
cd apps/api
npx prisma migrate deploy
```

期待出力: `All migrations have been successfully applied.`（適用済 migration はスキップ = 冪等）

### 6-3. pgvector 拡張の確認（初回のみ）

Neon の SQL Editor または `psql` で:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT * FROM pg_extension WHERE extname = 'vector';
```

1 行返れば OK。

---

## 7. smoke-test 実行

`docs/operations/smoke-test.md` に従い、以下 4 系列を順に検証:

1. **Test 1** — 外側ロック確認（ヘッダなし → Vercel 401 / HTML）
2. **Test 2** — 内側ロック確認（bypass のみ → アプリ 401 / JSON）
3. **Test 3** — 不正トークン（bypass + 不正 Bearer → アプリ 401 / JSON）
4. **Test 4** — 正常系（bypass + 正 Bearer → 200）

詳細・curl・期待レスポンスは `smoke-test.md` を参照。

---

## 8. トラブルシュート（よく出る症状）


| 症状                         | 真因の候補                                           | 確認手順                                                                                                         |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Test 1 で 200 が返る           | Standard Protection が効いていない / 該当 URL が保護対象外     | Project Settings → Deployment Protection の有効化状態 / URL 種別（production vs preview）                              |
| Test 2 / Test 3 で HTML が返る | bypass secret 不一致 → Vercel 側で止まっている             | secret の値・ヘッダ名（`x-vercel-protection-bypass`）の typo 確認                                                        |
| 全リクエストが JSON 503           | `API_BEARER_TOKEN` が Vercel 環境変数に投入されていない / 空文字 | Project Settings → Environment Variables / 関数ログで `[BearerTokenGuard] API_BEARER_TOKEN is not configured` を確認 |
| 404 が返る                    | `vercel.json` のルーティング / build 時の関数登録漏れ          | Build Logs に `Functions: api/index.ts` が出ているか                                                                |
| 500 が返る                    | bootstrap 失敗（Prisma / DB 接続 / OpenAI 初期化）       | 関数ログで `[vercel-handler]` プレフィックスのエラーを確認（G-2 ログ）                                                              |


---

## 9. `API_BEARER_TOKEN` ローテーション手順

定期ローテーション or 漏洩疑い時:

1. 新トークン生成: `openssl rand -hex 32`
2. Vercel 環境変数を **Edit**（Add ではなく Edit / 既存値を上書き）
3. Redeploy（環境変数変更は新 deployment にのみ反映 / 既存 deployment は旧値のまま）
4. ローカル `.env` の値を新トークンに更新
5. 呼び出しクライアント（外部スクリプト / OpenAPI クライアント等）の保管トークンを更新
6. パスワードマネージャを更新（旧値は履歴として残す or 完全破棄）
7. smoke-test を再実行して新トークンが効いていることを確認

⚠️ **新トークンと旧トークンの並走期間を作らない**（並走させたい場合は guard 側に許容トークンリスト機構を入れる別チケットが必要 / 個人運用では不要）。

## 10. Protection Bypass secret ローテーション

漏洩疑い時:

1. Project Settings → Deployment Protection → Protection Bypass for Automation → **Regenerate Secret**
2. 旧 secret は**即無効化**される
3. smoke-test スクリプトの環境変数を新 secret に置き換え
4. パスワードマネージャを更新

---

## 11. 関連ドキュメント

- 設計書: `docs/operations/phase-3-design.md`
- smoke-test: `docs/operations/smoke-test.md`
- Phase 2 serverless: `docs/operations/phase-2-design.md`
- Neon セットアップ: `docs/operations/neon-setup.md`
- Vercel 公式: [https://vercel.com/docs/projects/environment-variables](https://vercel.com/docs/projects/environment-variables)

