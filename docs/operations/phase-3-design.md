# Phase 3 設計書 — Bearer Token 認証（アプリ側ロック）+ Vercel deploy runbook

- 作成日: 2026-06-11
- 作成者: eng-backend（設計フェーズ担当）
- ステータス: 設計レビュー待ち
- 対象リポジトリ: `/Volumes/DevShare/projects/training-bot-rga-hub`
- 前フェーズ設計書: `docs/operations/phase-2-design.md`（serverless 化）/ `docs/operations/neon-setup.md`（Neon）

---

## 1. 目的と前提

### 目的

個人非公開運用のための **非公開化ダブルロック** を完成させる。

1. **外側のロック（Vercel 側）**: Vercel Authentication（Deployment Protection / Standard Protection）を有効化し、Vercel アカウント認証なしのブラウザアクセスを遮断する → 手順を runbook 化（コード変更なし / ふみさん手作業）
2. **内側のロック（アプリ側）**: NestJS の global guard で `Authorization: Bearer <token>` を必須化する。Vercel 側設定が誤って外れた場合・Protection Bypass secret が漏れた場合でも、アプリ単体で全ルートが 401 になる（defense in depth）
3. **deploy runbook**: Vercel プロジェクト作成 → 環境変数投入 → Protection 有効化 → 初回 deploy → smoke-test までの一連手順を `docs/operations/vercel-deploy.md` / `docs/operations/smoke-test.md` に固定する

### 入力となる前フェーズの成果物（実機確認済 / 2026-06-11）

| 既存物 | 場所 | 本フェーズへの影響 |
|---|---|---|
| Vercel Functions エントリ | `apps/api/api/index.ts`（初期化 Promise キャッシュ G-1/G-2 実装済） | 変更不要。guard は DI コンテナ内で完結するため serverless エントリに手を入れない |
| bootstrap SSoT | `apps/api/src/create-app.ts`（`setGlobalPrefix('api/v1', { exclude: ['health'] })`） | 変更不要（§3 判断 1 で APP_GUARD 方式を採るため）。main.ts / api/index.ts 双方に自動適用される |
| ルート定義 | `vercel.json`（`/health` / `/api/v1/*` / フォールバック → 同一関数） | 変更不要。全ルートが同一 Nest アプリに入るため global guard が全経路をカバー |
| AppModule | `apps/api/src/app.module.ts`（`providers: []` 空 / global guard 未登録） | `APP_GUARD` provider を追記する（既存 import / module 構成は不変） |
| env テンプレ | `apps/api/.env.example`（Prisma / OpenAI 正本）+ ルート `.env.example` | 両方に `API_BEARER_TOKEN` を追記 |
| テスト基盤 | jest 29 + ts-jest（`apps/api/package.json` / `npm test` = `jest --passWithNoTests`） | guard spec も同基盤で書く（新規 devDependency なし） |

### スコープ外（本フェーズでやらないこと）

- Vercel ダッシュボード実操作・実 deploy・環境変数の実投入（**ふみさん手作業**。本フェーズは runbook 提供まで）
- ユーザー概念の導入（マルチユーザー認証 / JWT / セッション）。単一共有トークンのみ（個人非公開運用のため）
- rate limit / IP 制限（Vercel Authentication が外側を塞ぐため現段階では過剰）
- `npm install`（新規依存ゼロのため不要。万一必要になっても SMB 上での実行禁止 → ふみさん側で実施）

---

## 2. 想定コスト

### 実装工数（人間想定 × 2/3 のエージェント係数適用）

| 作業 | 人間想定 | 係数後 |
|---|---|---|
| `bearer-token.guard.ts` 実装 | 1.5h | 1.0h |
| `bearer-token.guard.spec.ts`（8 ケース想定） | 1.5h | 1.0h |
| `app.module.ts` APP_GUARD 登録 + `.env.example` ×2 追記 | 0.5h | 0.33h |
| `docs/operations/vercel-deploy.md` runbook | 1.5h | 1.0h |
| `docs/operations/smoke-test.md` | 1.0h | 0.67h |
| ローカル検証（typecheck / jest 全件 / 既存テスト非破壊確認） | 0.5h | 0.33h |
| **合計** | **6.5h** | **約 4.3h** |

※ Vercel 実機 deploy + smoke-test 実走はふみさんのアカウント操作のため別枠（runbook 通読 + 実行で人間 30〜60 分想定）。

### 月額運用実費

- **¥0**。Vercel Authentication（Standard Protection）は Hobby プランで利用可。Bearer Token はアプリ内実装のみ。新規依存・新規 SaaS なし

### 隠れコスト

- **トークン管理の運用負荷**: トークンは Vercel 環境変数 + ローカル `.env` + 呼び出しクライアント側の 3 箇所で同期が必要。ローテーション時は 3 箇所更新 → runbook にローテーション手順を含める
- **Vercel Authentication と curl の相性**: Standard Protection 有効時、ブラウザ以外（curl / スクリプト）は Vercel SSO 画面に飛ばされて疎通確認できない。**Protection Bypass for Automation**（`x-vercel-protection-bypass` ヘッダ）の secret 発行が smoke-test に必須 → 管理 secret が 1 個増える
- **401 デバッグの二重化**: 「Vercel 側の 401（SSO リダイレクト / HTML）」と「アプリ側の 401（JSON）」が混在するため、障害切り分けに知識が要る → smoke-test.md に判別表を載せて吸収

### ゼロコスト代替案

- 本フェーズ自体が追加実費ゼロ。さらに削る案は「Vercel Authentication のみ（アプリ側ロックなし）」だが、Protection 設定ミス・bypass secret 漏洩時に全 API が裸になる単一障害点となるため不採用（ダブルロックがブリーフの確定要件）

---

## 3. アーキテクチャ判断

### 判断 1: トークン検証の実装層 — NestJS global guard（APP_GUARD）を採用

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: `APP_GUARD` provider（推奨）** | `CanActivate` 実装を `app.module.ts` に `{ provide: APP_GUARD, useClass: BearerTokenGuard }` で登録 | NestJS 標準イディオム。DI / Reflector 拡張が将来効く。`createApp()` に手を入れず main.ts / serverless 双方へ自動適用。jest で素直に単体テスト可 | guard 実行は routing 解決後（存在しないパスは guard 前に 404）— 後述の通り実害なし |
| B: express middleware を `create-app.ts` で `app.use()` | bootstrap 時に生 middleware 挿入 | routing 前に走る（404 より 401 が先） | Nest DI 外で素の express 流儀になる。テストが http レベルになり重い。`create-app.ts`（SSoT）の責務が太る |
| C: Nest middleware（`NestModule.configure`） | AppModule に `configure()` 追加 | Nest 流儀の middleware | guard より適用範囲指定が冗長。`exclude` 指定が文字列ベースで壊れやすい。guard で足りる場面に middleware を使う必然性なし |

**推奨: 案 A**。理由: (1) 変更が `common/guards/` 新設 + `app.module.ts` の providers 1 エントリに閉じる（変更範囲最小）、(2) 既存の `create-app.ts` / `api/index.ts`（Phase 2 レビュー通過済コード）を無改変で済ませられる、(3) 単体テストが `ExecutionContext` モックだけで完結する。

案 A の唯一の差分「未定義ルートは 401 でなく 404 が返る」は、ルート存在の推測（enumeration）に使える情報が `/health` と `/api/v1/*` しかなく、かつ外側で Vercel Authentication が全リクエストを遮るため実害なしと判断。

### 判断 2: `/health` を guard 対象に含めるか — 含める（例外なし / fail-closed）を採用

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: 全ルート保護（`/health` 含む）（推奨）** | 例外機構を作らない | コード最小（decorator / Reflector 不要）。fail-closed。露出ゼロ | smoke-test の liveness 確認にもトークンが要る |
| B: `@Public()` decorator + Reflector で `/health` 免除 | 標準的な opt-out パターン | 無認証 liveness が打てる | ファイル +1（decorator）+ guard に Reflector 分岐。現状 `/health` を無認証で叩く主体が存在しない（Vercel Hobby に health probe なし / 外形監視未導入）ため YAGNI |

**推奨: 案 A**。`/health` のレスポンスは `{ status, service }` のみで漏れて困る情報はないが、免除機構そのものが「将来の guard 素通り穴」になる（グローバルルール 2「最小構成」）。外形監視を導入するフェーズが来たら案 B へ拡張する（guard の構造は案 B 拡張を妨げない）。

### 判断 3: トークン比較方式 — SHA-256 ダイジェスト化 + `timingSafeEqual` を採用

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A: `===` 文字列比較 | 素朴 | 単純 | 比較時間が一致 prefix 長に比例 → タイミング攻撃面が残る（ブリーフ要件違反） |
| B: `timingSafeEqual(Buffer.from(a), Buffer.from(b))` 直接 | 定数時間比較 | crypto 標準 | **両 buffer の長さ不一致で throw する**。長さ一致チェックを先に入れると長さ情報がタイミングで漏れる + 例外パスの考慮が増える |
| **C: 両辺を SHA-256 で 32 byte に正規化してから `timingSafeEqual`（推奨）** | `timingSafeEqual(sha256(provided), sha256(expected))` | 長さが常に 32 byte で揃い throw しない。長さ情報も漏れない。標準的な実務パターン | hash 2 回分のコスト（µs オーダー / 無視可） |

**推奨: 案 C**。`node:crypto` のみで実装（依存追加ゼロ）。

### 判断 4: `API_BEARER_TOKEN` 未設定時の挙動 — fail-closed（503）を採用

- **採用**: 環境変数が未設定 / 空文字のとき、**全リクエストを `503 Service Unavailable` で拒否** + `Logger.error` で設定不備を 1 リクエスト 1 回記録（トークン値は当然ログに出さない。「未設定」という事実のみ）
- 401 ではなく 503 にする理由: クライアント側の資格情報問題（401）とサーバ側の設定不備（503）を切り分け可能にする。smoke-test の判別表で活用
- 不採用案「未設定時は認証スキップ（fail-open）」: ローカル開発が楽になるが、Vercel 環境変数の投入漏れがそのまま全公開につながる事故面。ローカルも `.env` にトークンを書けば済むため fail-open の利得が小さすぎる

### 判断 5: Vercel 側ロック — Standard Protection + Protection Bypass for Automation

- Vercel Authentication を **Standard Protection** で有効化（ブリーフ確定事項）。本プロジェクトはカスタムドメインを付けない（`*.vercel.app` の生成 URL のみ）ため、Standard Protection で全アクセス経路が保護対象になる
- ⚠️ **要実機確認（runbook に検証ステップとして組込）**: Standard Protection の保護対象範囲（production custom domain の扱い等）は公式ドキュメント https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication を deploy 時点の記載で確認し、smoke-test の「無認証 → Vercel 401」で実挙動を必ず検証する（外部仕様の実機検証なし固定の禁止 / 盲点 8）
- curl での疎通には **Protection Bypass for Automation**（Project Settings → Deployment Protection で secret 発行 → `x-vercel-protection-bypass: <secret>` ヘッダ）を使う。公式: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation

---

## 4. ファイル別実装指示

### 4-1. `apps/api/src/common/guards/bearer-token.guard.ts`（新規）

- **目的**: 全 HTTP ルートに `Authorization: Bearer <API_BEARER_TOKEN>` を強制する `CanActivate` guard
- **主要ロジック**:
  1. `process.env.API_BEARER_TOKEN` を **リクエスト毎に読む**（コンストラクタでキャッシュしない — 単体テストで env を差し替えやすく、serverless では env は invocation 間で不変なので性能差なし）
  2. 未設定 / 空文字 → `Logger.error('[BearerTokenGuard] API_BEARER_TOKEN is not configured')` の後 `ServiceUnavailableException` を throw（判断 4）。**ログにトークン値・ヘッダ値を含めない**
  3. `context.switchToHttp().getRequest()` から `headers.authorization` を取得。`typeof !== 'string'` または `'Bearer '` 始まりでない → `UnauthorizedException`。scheme は `'Bearer '` 固定の厳格一致（クライアントは自前 curl / スクリプトのみのため RFC 7235 の scheme 大文字小文字非依存は実装しない。判断根拠としてコメントに残す）
  4. `header.slice('Bearer '.length)` で取り出した提示トークンと期待値を、**両辺 `createHash('sha256').update(v).digest()` で 32 byte 化してから `timingSafeEqual`**（判断 3）。不一致 → `UnauthorizedException`
  5. 一致 → `return true`
- **実装上の注意**: 401 の例外メッセージは固定文言（`'Invalid or missing bearer token'` 等）とし、「ヘッダ欠落」「scheme 不正」「トークン不一致」を**レスポンスで区別しない**（攻撃者への情報供与を避ける。区別はテストの期待 status のみで担保）
- **引用ドキュメント**:
  - NestJS Guards / APP_GUARD: https://docs.nestjs.com/guards
  - `crypto.timingSafeEqual`: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
  - RFC 6750 (Bearer Token Usage): https://datatracker.ietf.org/doc/html/rfc6750

### 4-2. `apps/api/src/common/guards/bearer-token.guard.spec.ts`（新規）

- **目的**: §6 のテスト観点を jest（既存基盤 / ts-jest）で網羅
- **主要ロジック**: `ExecutionContext` は `createMock` 系ライブラリを足さず、`{ switchToHttp: () => ({ getRequest: () => ({ headers: {...} }) }) } as unknown as ExecutionContext` の手書きモックで構成（依存追加ゼロ）。`process.env.API_BEARER_TOKEN` は `beforeEach` で保存 → 各ケースで設定 → `afterEach` で復元（**他テストへの env 汚染を残さない**）
- 最低 8 ケース（§6 参照）。`Logger.error` は spy して「トークン値が引数に含まれない」ことまで assert する

### 4-3. `apps/api/src/app.module.ts`（追記）

- **目的**: guard をアプリ全域に適用する
- **主要ロジック**: `@nestjs/core` から `APP_GUARD` を import し、既存の空 `providers: []` に以下を追加（それ以外の行は不変）:
  ```ts
  providers: [{ provide: APP_GUARD, useClass: BearerTokenGuard }],
  ```
- これにより main.ts（ローカル）/ api/index.ts（Vercel）双方に同一の guard が効く（`create-app.ts` SSoT 経由のため両エントリの改変は不要）
- **引用ドキュメント**: https://docs.nestjs.com/guards#binding-guards （"Global guards set up via APP_GUARD are DI-enabled"）

### 4-4. `.env.example` ×2（追記）

- **`apps/api/.env.example`**（正本側）: 末尾に以下の形で追記。**実値・サンプル値らしき文字列は書かない**（プレースホルダすら実トークンに見える形にしない）
  ```
  # --- Phase 3: アプリ側 Bearer Token（非公開化ダブルロックの内側） ---
  # 生成方法: openssl rand -hex 32（docs/operations/vercel-deploy.md §環境変数 参照）
  # 未設定時は guard が fail-closed（全リクエスト 503）で落とす。ローカル開発でも必ず設定する。
  API_BEARER_TOKEN=
  ```
- **ルート `.env.example`**: `API_BEARER_TOKEN=` の 1 行 + 「正本は apps/api/.env.example」のコメント 1 行を追記（既存の DATABASE_URL と同じ整理方針に合わせる）

### 4-5. `docs/operations/vercel-deploy.md`（新規 runbook）

- **目的**: ふみさんが単独で初回 deploy を完了できる手順書。以下の章立て:
  1. **前提確認**: GitHub repo push 済 / `vercel.json` がルートに存在 / Neon 接続文字列が手元にある（neon-setup.md 完了）
  2. **Vercel プロジェクト作成**: ダッシュボード → Add New → Project → GitHub repo `training-bot-rga-hub` を import。Framework Preset = Other（`vercel.json` の `builds` が優先されるためダッシュボード Build 設定は無視される旨を明記 / phase-2 設計 §2 隠れコスト参照）
  3. **環境変数投入**: `DATABASE_URL`（Pooled / pgbouncer=true&connection_limit=1）/ `DIRECT_URL`（Direct）/ `OPENAI_API_KEY` / `API_BEARER_TOKEN`。トークン生成コマンド `openssl rand -hex 32` を明記。**Sensitive 扱いで投入**。値は本 runbook にも PR にも書かない
  4. **Deployment Protection 有効化**: Project Settings → Deployment Protection → Vercel Authentication = **Standard Protection**。続けて **Protection Bypass for Automation** の secret を発行し、パスワードマネージャへ保管（smoke-test 用）
  5. **初回 deploy**: import 時に自動 deploy される。失敗時はビルドログの確認ポイント（Prisma generate / `@pmtp/shared` 解決 / 関数サイズ）を列挙
  6. **migration 適用**: `DIRECT_URL` を使った `npx prisma migrate deploy` をローカルから実行する手順（Vercel build 中に migrate を走らせない方針の理由 1 行: build 並列実行時の二重 migrate 回避）
  7. **smoke-test 実行**: `docs/operations/smoke-test.md` へ誘導
  8. **トークンローテーション手順**: 新トークン生成 → Vercel 環境変数更新 → redeploy → クライアント側更新 → 旧トークン破棄（3 箇所同期の注意）
- **引用ドキュメント**: 判断 5 の 2 URL + https://vercel.com/docs/projects/environment-variables

### 4-6. `docs/operations/smoke-test.md`（新規）

- **目的**: deploy 直後の疎通確認を copy & paste で完走できる curl 一式 + 結果判別表
- **主要内容**:
  1. 変数準備: `BASE_URL` / `BYPASS_SECRET` / `API_TOKEN` を export する雛形（実値はシェル履歴に残る点の注意書き → `read -s` 推奨）
  2. **Test 1 — 外側ロック確認**: ヘッダなし `curl -i $BASE_URL/health` → 期待: Vercel の 401（HTML / `_vercel_sso` リダイレクト系）。**200 が返ったら Standard Protection が効いていない**（即設定見直し）
  3. **Test 2 — 内側ロック確認**: `x-vercel-protection-bypass` のみ付与 → 期待: アプリの 401（JSON / NestJS 形式）
  4. **Test 3 — 不正トークン**: bypass + `Authorization: Bearer wrong-token` → 期待: 401（JSON）
  5. **Test 4 — 正常系**: bypass + 正トークン → `GET /health` 200 `{"status":"ok",...}`、続けて `GET /api/v1/...`（実在する代表 1 エンドポイント）200
  6. **判別表**: 「HTML 401 = Vercel 側 / JSON 401 = アプリ側トークン不一致 / JSON 503 = `API_BEARER_TOKEN` 未投入 / 404 = ルーティング（vercel.json）/ 500 + 関数ログ = bootstrap 失敗（api/index.ts G-2 のログを Vercel ダッシュボードで確認）」

---

## 5. 冪等性ガード（実装必須項目）

**コード変更分は N/A**。根拠:

- `BearerTokenGuard` は **読み取り専用・ステートレス**（DB write / 外部 API call / ファイル write / 状態遷移が一切ない）。同一リクエストに対し何度評価しても同じ結果を返す純関数的判定であり、claim-first / 二重実行リスクの構造を持たない
- `$transaction` / upsert / INSERT / ステータス機械はこの diff に登場しない（reviewer 自己制約 3 のトリガーキーワード非該当）

**runbook（手作業）側の再実行安全性**は以下を runbook 本文に明記する:

- [ ] 環境変数の再投入は「上書き更新」になる（Vercel は同名 add でエラー → Edit を使う旨を手順に記載）
- [ ] Protection Bypass secret の再発行は **旧 secret を即無効化** する（再発行したら smoke-test 側の変数も差し替え）
- [ ] `prisma migrate deploy` は適用済 migration をスキップする（Prisma 標準の冪等性）— 二重実行可と明記

---

## 6. テストすべき観点（後続テスト担当向け）

`bearer-token.guard.spec.ts`（単体 / ExecutionContext モック）:

1. 正トークン（`Bearer <一致値>`）→ `canActivate` が `true`
2. `authorization` ヘッダ欠落 → `UnauthorizedException`
3. scheme 不正（`Basic xxx` / `bearer <正値>`(小文字) / `Bearer` のみで値なし）→ `UnauthorizedException`
4. トークン不一致（同長の別値）→ `UnauthorizedException`
5. **トークン長違い**（期待値より短い / 長い提示値）→ throw が `UnauthorizedException` であること（`timingSafeEqual` の長さ不一致 `RangeError` が漏れ出ないこと = 判断 3 案 C の検証）
6. `API_BEARER_TOKEN` 未設定 → `ServiceUnavailableException` + `Logger.error` が呼ばれる
7. `API_BEARER_TOKEN` 空文字 → 同上（空文字を「設定済」と誤認しない）
8. ログ・例外メッセージに **期待トークン値 / 提示トークン値が含まれない**（spy の呼び出し引数を文字列検査）

統合（任意 / `create-app.spec.ts` の流儀に合わせ supertest があれば）:

9. APP_GUARD 登録後、`GET /health` がトークンなしで 401 / 正トークンで 200（判断 2 案 A の「/health も保護」の実機確認）
10. 既存テスト（retrieval / ingestion / guardrail / vercel-handler）が**全件グリーンのまま**であること — guard 追加で http レベルの既存 spec が 401 化していないか（401 化していたら spec 側にトークン注入が必要 = 影響範囲の検出）

環境復元:

11. spec 内の `process.env` 変更が `afterEach` で復元され、他 spec に漏れない

---

## 7. レビュー観点

### architecture reviewer

- [ ] APP_GUARD 方式（判断 1 案 A）で `create-app.ts` / `api/index.ts` が無改変のままか（Phase 2 通過済コードへの不要な手入れがないこと）
- [ ] guard の配置が `common/guards/`（横断関心事）であり、guardrail/（LLM 出力ドメインガード）と混同されていないか — 名前が似ているが責務が別物
- [ ] `/health` 例外機構（decorator 等）を**勝手に追加していない**か（判断 2 で不採用済 / 最小構成違反の検出）
- [ ] fail-closed（503）の分岐が guard 内に閉じているか（bootstrap 時 throw にすると G-2 の再試行ループと干渉するため、リクエスト時判定が正）

### quality reviewer

- [ ] `timingSafeEqual` の両辺が **SHA-256 で長さ正規化済**か（生 Buffer 比較だと長さ不一致 throw / 長さリーク。§6 ケース 5 のテスト存在確認）
- [ ] トークン値・Authorization ヘッダ値が **ログ / 例外メッセージ / spec の出力に一切現れない**か（grep: `API_BEARER_TOKEN` の値参照箇所すべて）
- [ ] 401 レスポンスが失敗理由（欠落 / scheme / 不一致）を区別していないか（情報供与の検出）
- [ ] `process.env` の読み取りがリクエスト毎で、spec の env 復元（§6 ケース 11）があるか
- [ ] `.env.example` に実値らしき文字列が入っていないか / runbook・PR 本文に secret が書かれていないか
- [ ] 自己制約 3: claim-first トリガー非該当（§5 N/A 根拠の妥当性確認 — 読み取り専用 guard であること）
- [ ] 自己制約 4 観点: 本 PR は SSRF / network egress 非該当だが、smoke-test.md の curl が**実機検証の手順として成立しているか**（期待 status の根拠が判別表で追えるか）

### 両 reviewer 共通

- [ ] runbook の Standard Protection 記述が「要実機確認」フラグ付き（判断 5）のまま断定していないか — 外部仕様の実機検証なし固定（盲点 8）の予防
- [ ] diff が Phase 3 スコープ（auth guard + runbook + env テンプレ）に閉じているか（無関係ファイル混入の検出）

---

## 付記: 実装フェーズへの引き継ぎメモ

- 新規 npm 依存は **ゼロ**（`node:crypto` + 既存 NestJS / jest のみ）。install 不要のため SMB 制約に抵触しない
- `common/` ディレクトリは現存しないため `apps/api/src/common/guards/` を新設する（初の横断関心事レイヤ）
- 既存の http レベル spec（`create-app.spec.ts` / `vercel-handler.spec.ts`）が guard 導入で落ちる場合、spec 側に `API_BEARER_TOKEN` 設定 + ヘッダ付与を足すこと（guard を無効化するテスト用バックドアは作らない）
