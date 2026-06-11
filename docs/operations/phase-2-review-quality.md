# Phase 2 品質レビュー（eng-reviewer-quality）

---
ticket: phase-2-nestjs-serverless-vercel
github-pr: ""
reviewer: quality
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 2
codex-error-reason: ""
self-constraint-1-applied: false   # 本リポ系列に直近 3 件以内の同型 hot-fix 履歴なし（Phase 1 → Phase 2 の通常進行）
self-constraint-2-triggered: n/a   # 並列レビューのため共造判定は eng-pm 裁定時に実施
self-constraint-3-triggered: true  # 設計書 §5 冪等性ガード（G-1/G-2）の対照確認を実施（下記参照）
self-constraint-4-triggered: n/a   # undici / dispatcher / DNS lookup / SSRF 防御層の diff なし
---

- 対象: Phase 2 — NestJS serverless 化（`apps/api/api/index.ts` + `create-app.ts`）+ `vercel.json` + docker-compose Redis 撤去 + テスト 3 ファイル
- 設計書: `docs/operations/phase-2-design.md`
- レビュー方式: working tree 差分（コミット禁止規約のため未コミット状態をレビュー）。Codex は `--scope working-tree` で起動
- 注記: ブリーフ規約により gh 操作禁止のため GitHub PR レビュー投稿はなし。本ファイルが正本

---

## Codex 機械観点レビュー

Codex adversarial-review（stdout 全文転記）:

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

no-ship: Vercel/serverless 化の差分は、依存解決の再現性と fresh deploy の成立条件がまだ壊れている可能性が高いです。

Findings:
- [high] package.json に追加した @pmtp/shared が lockfile に反映されていない (apps/api/package.json:26)
  `apps/api/package.json` は `@pmtp/shared` を runtime dependency に追加しているが、`apps/api/package-lock.json` の root package dependencies には `@pmtp/shared` が存在しない。lockfile を使う CI/Vercel の再現インストールでは package-lock と package.json が不整合になり、deploy 前に依存解決で止まるか、ローカルと異なる依存状態で serverless bundle が作られる。
  Recommendation: `apps/api` 側で lockfile を更新し、`apps/api/package-lock.json` の root dependencies と `node_modules/@pmtp/shared` entry に `file:../../packages/shared` が入る状態で `npm ci` 相当を通す。
- [high] fresh Vercel build で @pmtp/shared の dist が生成される保証がない (vercel.json:4-10)
  `@pmtp/shared` の package entry は `dist/index.js` / `dist/index.d.ts` を指しており、`vercel.json` も `packages/shared/dist/**` だけを includeFiles に入れている。一方で `vercel.json` には `packages/shared` を build する設定がなく、`@vercel/node` の entry は `apps/api/api/index.ts` だけ。fresh clone の Vercel build で root の `npm run build` が必ず先に走る設定が別途ない限り、runtime import が missing dist で落ちる。これは Vercel 設定外部への依存という推論を含むが、repo 内設定だけでは生成順序を担保できていない。
  Recommendation: Vercel build 手順を repo 内で固定し、`packages/shared` を必ず先に build する。例: Vercel の build command / root script / prebuild で `npm --prefix packages/shared run build` を実行し、その後 `apps/api` を bundle する。あわせて fresh checkout で dist 不在から deploy 検証する。

Next steps:
- lockfile を更新する
- fresh checkout 相当で `npm ci` と Vercel build 手順を検証する
```

集計: Critical 0 / High 2 / Medium 0 / Low 0。

### Codex High-2 の Claude 側裏取り（実機確認済）

Codex は「推論を含む」と注記しているが、Claude 側で以下を実機確認し **確定** とする:

- root `.gitignore` L4 に `dist` → `packages/shared/dist/` は **gitignore 対象**。`git ls-files packages/shared/dist` = 0 件（git 未追跡）
- Vercel の fresh checkout には `packages/shared/dist/` が **存在しない**。`packages/shared/package.json` に `prepare` script なし（`build` のみ）。npm の `file:` 依存は symlink 設置のみで被リンク側の build を実行しない
- `apps/api/src/guardrail/guardrail.enums.ts:25` は `@pmtp/shared` から **ランタイム値 import**（`ERROR_CODES` 等 / type-only でない）→ dist 不在は起動時 `MODULE_NOT_FOUND` で即死を意味する
- `vercel.json` の `includeFiles: ["packages/shared/dist/**"]` はビルド時に存在するファイルしか含められないため、空振りする

つまり設計書 §3 判断 3 が解消したと宣言した「`@pmtp/shared` MODULE_NOT_FOUND 即死」は、**ローカル（dist ビルド済み環境）でのみ解消、Vercel fresh build では未解消**。Phase 2 の目的「Vercel Functions で動かせるようにする」が実態として未達となる High 指摘。

---

## 組織固有観点レビュー（Claude）

### 実機検証ログ（claim 裏取り）

| 項目 | 結果 |
|---|---|
| 新規 3 + 既存 phase1 計 4 スイート jest 実行 | **77/77 pass** 実機確認（テスト担当報告の 50 新規 + phase1 27） |
| `tsc --noEmit -p tsconfig.json` | exit 0 |
| `tsc --noEmit -p api/tsconfig.json`（typecheck:vercel） | exit 0（Codex 側でも独立に exit 0 確認） |
| docker-compose redis 不在 / postgres + rag_local 残置 | ファイル実読で確認 |
| Redis 残置物 grep（`.env.example` / `docker/redis/` / spec） | 全撤去確認。残ヒットは「不在を assert する」テストコードのみ |
| `.env.example` 2 ファイルの Secret 混入 | なし（プレースホルダ / `<password>` テンプレのみ） |

### チェックリスト

- [x] **UX フロー**: エンドユーザー UI なし（API のみ）。/health 除外 prefix の挙動はテストで担保。エッジケース（初期化失敗時の恒久 500 化）は G-2 で手当て済み
- [ ] **コンプライアンス / コスト保護**: 下記 Q-1（認証ゼロ公開ウィンドウ）参照。課金フロー（Stripe）・PII・景表法は本フェーズに存在せず N/A
- [x] **組織独自の品質ルール**: marketing-content-slop 対象外。PSP 報告は設計/実装/テスト 3 報告とも完備
- [x] **独立性ルール遵守**: 本レビューは architecture レビュー（`phase-2-review-architecture.md`）を一切参照せず作成
- [x] **PII / API キー混入の構造的チェック**: OPENAI_API_KEY は env 経由のまま（コード焼き込みなし）。handler は req を express へ素通しするだけで新たなログ sink を作らない。`console.error` は err オブジェクトのみで接続文字列の意図的出力なし（Prisma エラーは host 名を含み得るが Vercel 私有ログに閉じる / 個人運用で許容）

### Claude 独自指摘

#### Q-1 🟠 High: 認証ゼロの公開ウィンドウ（OpenAI 課金保護）

- 本フェーズの `vercel.json` は **全パスを無認証で公開する構成**（catch-all → handler）。Bearer guard + Vercel Authentication は後続フェーズ。`/api/v1/rag/query` は OpenAI を実呼び出しする課金エンドポイントであり、**後続フェーズ完了前に production デプロイすると、URL を知る誰でも OpenAI クレジットを消費可能**
- デプロイはふみさん手作業 + runbook は後続フェーズという構造で「うっかり早期デプロイ」を止める仕掛けが文書上どこにもない
- **要求**: 設計書 §残課題 または `docs/operations/` のいずれかに「**Phase 3（非公開化ダブルロック）完了まで production デプロイ禁止**」を 1 行明記（修正コスト 1 行 / 課金事故の保険）

#### Q-2 🟡 Medium: create-app.spec.ts が `createApp()` 実体を実行していない

- 統合テスト（L49-51）は `Test.createTestingModule` + **手動で同じ `setGlobalPrefix` 設定を複製**しており、`createApp()` 関数そのものは一度も実行されない。`createApp()` 内部にデグレが入っても統合テストは通り、検出は文字列マッチの静的テスト（`'api/v1'` 含有チェック等）頼みになる
- DB 接続を避けるための意図的トレードオフとしてテストヘッダに明記されており許容範囲だが、静的テストは「文言が存在する」ことしか守れない（例: prefix 文字列を変数化したら偽陰性で落ちる / 逆にコメント内の文字列でも通る）
- **推奨**: 後続フェーズの実機 runbook 検証（/health 200 + /api/v1 応答）を fidelity の最終担保として明記。本フェーズでの修正は不要

#### Q-3 🟢 Low: vercel-handler.spec.ts の dead code

- L31-42 `loadFreshHandler` は定義のみで全テスト未使用。しかも内部の `jest.mock('../../api/../src/create-app', ...)` は実テストで使われる `jest.doMock('../create-app', ...)` とパス表記が異なり、将来の読み手を混乱させる。削除推奨

#### Q-4 🟢 Low（情報）: 初期化失敗時のクライアント応答は Vercel 既定挙動依存

- handler reject 時は Vercel が汎用 500（FUNCTION_INVOCATION_FAILED）を返す想定で、スタックトレースはクライアントに漏れない。設計書 §7 の要求（500 + 汎用メッセージ / Secret 非漏洩）は Vercel 既定挙動で満たされる見込みだが、これも実機未検証領域（盲点 8 系）。後続 runbook の確認項目「初期化失敗時のレスポンスボディにスタック非含有」を 1 行追加推奨

### claim-first ガード検証（自己制約 3）

設計書 §5 冪等性ガード節と実装の対照確認:

| ガード | 設計書の要求 | 実装 | 判定 |
|---|---|---|---|
| G-1: 並行初期化レース | app でなく初期化 Promise を module-level キャッシュ / bootstrap 高々 1 回 | `api/index.ts` L25-44: `appPromise` キャッシュ + `if (!appPromise)` ガード。listen せず `app.init()` のみ | ✅ 存在 / 設計通り |
| G-2: 失敗 Promise の恒久 500 化防止 | reject 時 `appPromise = undefined` リセット + `console.error`（握り潰さない） | L36-42: `.catch` でリセット + `[vercel-handler]` プレフィックス付き console.error + rethrow | ✅ 存在 / 設計通り |

- 境界レース分析: `.catch` の無条件リセットが「新しい Promise を誤って消す」可能性を検討 → `appPromise` の再代入は undefined 化の後にしか起きない（`if (!appPromise)` ガード）ため、古い catch が新 Promise を消す系の競合は構造的に発生しない。健全
- テスト対照: G-1 並行 2 件（`Promise.all` 同時着弾 + 直列 3 連打）/ G-2 2 件（再試行 + console.error 検証）が存在し、77/77 pass を実機確認

### 自己制約 4 検証

- 発火条件（undici Agent / dispatcher / DNS lookup / fetch interceptor / SSRF 防御層識別子）に該当する diff なし → **n/a**

---

## 統合 verdict

**needs-revision（changes-requested）** — Codex High 2 件（統合 verdict 表: High → changes-requested）+ Claude 独自 High 1 件。

### 必須修正（マージ前）

1. **[Codex High-2 / Claude 裏取り済] `packages/shared` の build が Vercel fresh checkout で実行されない**
   - dist は gitignored + npm `file:` 依存は被リンク側を build しない。修正案: `apps/api/package.json` の postinstall を `npm --prefix ../../packages/shared run build && prisma generate` に拡張（shared の devDeps 解決方法含め実装側で設計）。`prepare` script 方式は npm が file: 依存で実行しない点に注意
2. **[Codex High-1] `apps/api/package-lock.json` に `@pmtp/shared` が未反映**
   - 実装側の「ふみさん側オペレーション」リストに `npm install --prefix apps/api` は記載済みだが、**install 後の lockfile 差分コミットを Phase 2 完了条件（受け入れ条件）に明記**すること。lockfile 未コミットのまま Vercel に渡ると `npm ci` 相当で不整合
3. **[Claude Q-1 High] 「Phase 3 完了まで production デプロイ禁止」の 1 行を設計書残課題 or docs/operations に明記**（OpenAI 課金保護）

### 推奨改善（任意）

4. [Q-3 Low] `vercel-handler.spec.ts` L31-42 の dead code（`loadFreshHandler`）削除
5. [Q-2 Medium] createApp() 実体未実行の fidelity gap → 後続 runbook の実機確認項目で最終担保
6. [Q-4 Low] runbook 確認項目に「初期化失敗時レスポンスのスタック非含有」追加

### 良かった点

- 冪等性ガード G-1/G-2 が設計書のコード形通りに実装され、テストも並行・直列・失敗再試行・ログの 4 軸でカバー（自己制約 3 全項目 ✅）
- Redis 撤去が参照整合込み（env / spec / docker/redis/ / scripts）で漏れなく完遂。grep で残置ゼロを確認
- 全 claim（77 テスト pass / typecheck 2 種 exit 0）が実機再現した。報告の信頼性が高い
- `@vendia/serverless-express` 不採用判断とその静的テスト化（「不在を assert」）は良い再発防止構造

---
**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（`phase-2-review-architecture.md`）は参照していない。
