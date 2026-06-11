# 設計観点再レビュー — Phase fix 4 deploy ブロッカー（B-1〜B-4）

```yaml
ticket: phase-fix-blockers
github-pr: ""                  # 未コミット working tree レビュー（ふみさんが後でまとめてコミット）
reviewer: architecture
review-mode: parallel-agents   # quality レビューと並列実行 / 相互参照なし
verdict: approved              # 条件付き（§統合 verdict 参照 / push 前に vercel-deploy.md §1.5 実行が必須条件）
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 1
codex-error-reason: ""
self-constraint-1-applied: true    # 盲点 8（実機検証なし固定）同型再発系列 → B-4 で是正済みを確認
self-constraint-2-triggered: n/a   # 並列実行のため本レビュー単独では判定不能（eng-pm が両レビュー突合時に判定）
self-constraint-3-triggered: n/a   # diff に claim-first 書込パス追加なし（409 写像テーブルのみ / read 系）
self-constraint-4-triggered: n/a   # SSRF / network egress / DNS / dispatcher 系 diff なし
---
```

## Codex 機械観点レビュー

実行コマンド: `codex-companion.mjs adversarial-review --wait --base main --scope branch`（cwd = `/Volumes/DevShare/projects/training-bot-rga-hub` / nodenv 22.14.0 PATH 前置で起動。初回は対象リポに `.node-version` が無く node 解決ミスマッチで「Codex CLI is not installed」誤エラー → PATH 前置で回避。memory `feedback_codex_nodenv_path.md` の既知事象）。

Codex stdout（最終レポート部分）:

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

no-ship。Vercel/CI の clean install が `postinstall` に到達する前に lockfile 不整合で停止するため、deploy ブロッカー修正として未完了です。

Findings:
- [high] `@pmtp/shared` 追加後の lockfile 未同期で clean install が失敗する (apps/api/package.json:28)
  `apps/api/package.json` は runtime dependency に `@pmtp/shared: file:../../packages/shared` を追加していますが、`apps/api/package-lock.json` の root dependencies と `node_modules/@pmtp/shared` entry には反映されていません。実際に `npm --prefix apps/api ci --dry-run --ignore-scripts` は `Missing: @pmtp/shared@0.1.0 from lock file` で失敗しました。Vercel/CI が lockfile ベースで install する経路では、今回追加した `postinstall` は実行前に止まるため、shared build/prisma generate の修正が deploy に効きません。
  Recommendation: `npm install --prefix apps/api` を実行して `apps/api/package-lock.json` に `@pmtp/shared` の file dependency を反映し、lockfile 差分をコミット対象に含めてください。その後 `npm --prefix apps/api ci --dry-run --ignore-scripts` が通ることを確認してください。

Next steps:
- `apps/api/package-lock.json` を `apps/api/package.json` と同期する
- 同期後に `npm --prefix apps/api ci --dry-run --ignore-scripts` を再実行する
```

### Codex 指摘の取り扱い判定（architecture reviewer 裁定）

Codex High-1（lockfile 未同期）は **新規欠陥ではなく、B-2 の合意済みスコープ判断そのもの**。本ワークフローの前提条件は「SMB マウント上で npm install を実行しない → 代わりに runbook（`vercel-deploy.md` §1.5）へ手順を明文化し、ふみさんが push 前にローカルで lockfile 同期を実行する」であり、§1.5 は実在し手順も正確（後述 B-2 評価）。Codex はこの設計判断の前提状態（lockfile 未同期のまま push すると deploy が落ちる）を実機 `npm ci --dry-run` で裏取りしてくれた形で、**「§1.5 の実行が push 前の必須ゲートである」ことの機械的証明**として価値が高い。よって changes-requested ではなく「approved + push 前必須条件の明示」で吸収する。

Codex の High 推奨アクション（`npm ci --dry-run --ignore-scripts` の事後確認）は §1.5 の検証ポイントに既に実質含まれるが、dry-run コマンドそのものは未記載 → 推奨改善 R-1 として下に記載。

## 組織固有観点レビュー（Claude）

### B-1: postinstall 拡張（`apps/api/package.json:16`）

- [x] **monorepo 構造適合**: `npm --prefix ../../packages/shared install → run build → prisma generate` の 3 段直列。Vercel `@vercel/node` builder は `apps/api/package.json` を nearest package として install を走らせるため、相対パス `../../packages/shared` は Root Directory `./`（`vercel.json` 確認済み）の checkout で成立する
- [x] **順序依存が壊れていない**: shared の devDeps（typescript）install → `tsc -p tsconfig.json`（`packages/shared/package.json` の build が `dist/` を吐くことを確認）→ prisma generate。`vercel.json` の `includeFiles: ["packages/shared/dist/**"]` と整合し、bundle 時点で dist が存在する設計
- [x] **`@pmtp/shared` が dependencies に `file:../../packages/shared` 形式で存在**（L28）
- [x] **YAGNI**: turborepo / workspaces 化等の過剰一般化に逃げず、postinstall 1 行で最小解決。組織のアーキテクチャ哲学に適合
- ⚠️ 指示書原案（shared build + prisma generate のみ）に対し shared install を前置した判断は妥当。fresh checkout では shared の node_modules が空で `tsc` が見つからず build が落ちるため、修正担当の「想定外の発見」は正しい設計判断

### B-2: lockfile 同期 runbook（`docs/operations/vercel-deploy.md` §1.5）

- [x] **ローカル再現性**: 手順 1→2→3 の順序が依存方向（shared deps → shared dist → apps/api lockfile 確定）と一致。SMB 直列実行の注意書きあり（memory 規約準拠）
- [x] **Vercel 再現性**: 「postinstall は build を担うが lockfile 同期は push 前ローカル責務」という責務分離が背景説明として明文化されており、読者（ふみさん）が「なぜローカルで必要か」を理解できる
- [x] **検証ポイントが具体**: lockfile 内の `resolved` パス / dist 2 ファイル / symlink の 3 点チェックリスト。トラブル時の §7 への導線もある
- ⚠️ 軽微: 手順 1（shared install）は手順 3 の postinstall 連鎖でも再実行されるため冗長だが、冪等であり初見読者の理解を助けるので許容

### B-3: RagExceptionFilter の HttpException 分岐（`rag-exception.filter.ts:103-117, 173-196`）

- [x] **分岐順の設計**: `RagApiException`（`extends Error` / HttpException 非継承を実コードで確認）→ `HttpException` → `ZodError` → `IdempotencyConflictError` → `ProviderError` → fallback 500。ドメイン例外の正規ルートを最優先に保ったまま、Guard / Pipe / NestJS 内部由来の HttpException を 500 に潰さない位置に挿入されており、「HttpException 最優先（ドメイン例外を除く）」の意図を満たす。コメントで分岐理由と smoke-test T2/T3 への影響を明記しており保守性が高い
- [x] **既存 RAG エラー処理を非破壊**: IdempotencyConflictError / ProviderError / ZodError（duck-type 判定含む）はいずれも HttpException 非継承のため新分岐と衝突しない。既存 spec 7 件無改変 + 新規 2 件（401 / 503 status 透過）
- [x] **status 透過 + code 写像の責務分離**: `mapHttpStatusToErrorCode` を純関数 helper として切り出し。`ERROR_CODE_HTTP_STATUS`（code→status の正本マップ）と方向が逆の写像である旨と 503 フォールバックの設計判断が doc コメントに残る。`ERROR_CODES` 11 値（`packages/shared/src/rag-enums.ts:245`）に対し写像の値域が全て実在することを確認
- [x] **グローバル登録非破壊**: `rag.module.ts:46` の `APP_FILTER` provider 登録は無改変。`@Catch()` 全例外捕捉も維持
- [x] **テスタビリティ**: filter は host モックで完結する純粋な写像ロジックのまま。DI 依存追加なし

推奨改善（必須ではない / 将来の盲点メモ）:
- **R-2**: HttpException 分岐は `getResponse()` の `message` のみ抽出し `details` を落とす。現状 ZodValidationPipe が素の ZodError を投げる設計なので実害ゼロだが、将来 NestJS 組み込み ValidationPipe / BadRequestException(details 付き) を導入すると details が消える。導入時に本分岐の details 透過を検討
- **R-3**: HttpException 経由の 429（将来 Throttler 導入時）は `retryAfterSeconds` が立たず Retry-After ヘッダ必須規約（10 §4.1）に違反し得る。Throttler 導入チケットで本分岐への retryAfter 透過を要件化すること（現状 429 は RagApiException ルートのみのため問題なし）
- **R-4**: 422 → `RAG_GUARDRAIL_BLOCKED` の写像は「guardrail 以外の 422」が将来現れた場合に意味ズレする。現状 guardrail は RagApiException ルートで先取りされるため到達しないが、写像表のコメントに残すとよい

### B-4: ptp-client-cutover.md §9 訂正

- [x] **scope 内判断が正確**: 「実機検証済」虚偽記載の除去 / 「未検証」ステータス見出し / 警告ブロック / 「手順書ではなく実機の挙動が真」原則 / cutover 当日チェックリスト 5 件（idempotency_replayed 2 回実行検証 + trace_id 突合 + decision ファイル記録）が全て実在することを確認（L320-332）。過去ドラフトの誤記訂正である旨も履歴として明示されており、訂正の透明性が高い
- [x] **scope 外判断が妥当**: `cutover-smoke-test.sh` の secret argv 露出を別チケット送りにした判断は、本ワークフローの定義（4 ブロッカー限定 / High/Medium は後追い）と一致。束ね修正で diff を膨らませなかったのは正しい
- [x] **盲点 8 整合**（`engineering-review-independence.md` 盲点 8 = 外部仕様の実機検証なし固定）: B-4 はまさに同型再発（DAI-064 → DAI-090 系列と同構造）の文書版であり、本訂正は「実機検証ログが無いものを検証済と書かない」原則への回帰。§9 のチェックリストが「検証結果を実機ログ付きで decision ファイルに記録」まで含むため、cutover 当日に盲点 8 を構造的に塞ぐ設計になっている

### 構造的盲点（自己制約 1）

本系列（8 レビュー中 7 needs-revision / 盲点 8 同型の虚偽記載）を踏まえ、「文書の検証ステータス記載」観点で他 docs を横断確認した。`ptp-client-cutover.md` §0 は元から「未検証（推測禁止）/ discovery 必須」と正しく書かれており、§9 だけが逸脱していた。§9 訂正後、本リポ docs/operations 配下に「実機検証済」と無根拠に主張する箇所は残っていない（grep で確認）。新たな構造的盲点の追加指摘なし。

### 組織固有チェックリスト

- [x] **pre-merge gate**: N/A — 本レビューは未コミット working tree 対象（PR 不在 / ふみさんが後でまとめてコミットする運用）。コミット → PR 化の際に通常の pre-merge gate（HEAD SHA 記録 / ローカル build / Step A-C）を適用すること
- [x] **独立性**: quality レビューファイルは未参照（並列実行 / parallel-agents）
- [x] **D### 決議整合**: 盲点 8（DAI-091 系）への是正が B-4 で実施済み。D344（Codex frontmatter 義務）は本レビューで遵守。違反なし
- [x] **保守性・YAGNI**: 4 修正とも最小 diff で過剰抽象化なし
- [x] **テスタビリティ**: B-3 はモック容易な純写像のまま。検証担当追加の `phase-fix-blockers.spec.ts`（43 件）のうち docs / package.json への静的文字列アサーション系は将来の文書編集で壊れやすい点に留意（推奨改善 R-5: cutover 完了後に当該静的テストの退役 or `cutover-gate` 系への隔離を検討）

## 統合 verdict

**approved（条件付き）**

- Codex: Critical 0 / High 1。High-1 は B-2 の合意済みスコープ判断（npm install を本ワークフローで実行しない）の前提状態を再確認したもので、新規欠陥ではない。対応は runbook §1.5 として実在し正確
- Claude 組織固有観点: 4 ブロッカーすべて設計妥当。Critical / High 級の新規指摘なし
- **push 前必須条件**: ふみさんが `vercel-deploy.md` §1.5 を実行し lockfile を同期してからコミット / push すること。未実施のまま push すると Vercel の `npm ci` が postinstall 到達前に停止し B-1 の修正が無効化される（Codex が `npm --prefix apps/api ci --dry-run --ignore-scripts` の実走で `Missing: @pmtp/shared@0.1.0 from lock file` を確認済み）
- 推奨改善（任意）: R-1 §1.5 検証ポイントに `npm --prefix apps/api ci --dry-run --ignore-scripts` の合格確認を 1 行追記 / R-2 details 透過 / R-3 Throttler 導入時の Retry-After / R-4 422 写像コメント / R-5 静的文書テストの退役計画

---
**独立性の補足**: 本レビューは architecture 観点のみで作成し、もう一方のレビュー（quality）は参照していない。
