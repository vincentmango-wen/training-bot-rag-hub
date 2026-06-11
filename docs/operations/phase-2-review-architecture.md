# Phase 2 レビュー — architecture 観点

---
ticket: phase-2-serverless-vercel
github-pr: ""
reviewer: architecture
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 1
codex-error-reason: ""
self-constraint-1-applied: false   # 本リポに直近 3 件以内の同型 hot-fix 履歴なし（Phase 1 → 2 が初の連続フェーズ）
self-constraint-2-triggered: n/a   # 独立レビューのため quality 側の検出は本レビュー時点で不可知
self-constraint-3-triggered: n/a   # claim-first キーワード（$transaction/upsert/claim 等）不使用。ただし設計書 §5 G-1/G-2 の対照確認は実施済（後述）
self-constraint-4-triggered: n/a   # SSRF / network egress / DNS / undici DI の diff なし
---

## 統合 verdict: needs-revision

- Codex 機械観点: **High 1 件**（lockfile 未同期 / `npm ci` 再現不能）
- Claude 組織固有・設計観点: **Critical 級 1 件**（`packages/shared/dist` が gitignore 済みのため Vercel デプロイコンテキストに存在せず、判断 3 のブロッカー解消が実機では未完成）
- 統合ルール（Codex High → changes-requested / Claude 重大指摘 → changes-requested）により **needs-revision**

設計の骨格（案 A の express 直接呼び出し / bootstrap SSoT 化 / Promise キャッシュ G-1/G-2 / builds+routes 構成）は正しく、修正は局所的。下記 2 点の解消で approved に転換できる。

---

## Codex 機械観点レビュー

（stdout 全文転記）

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

no-ship。`apps/api/package.json` に依存を追加しているのに lockfile が更新されておらず、clean install が再現不能です。

Findings:
- [high] package-lock 未更新で `npm ci` が失敗する (apps/api/package.json:26)
  `@pmtp/shared` が依存に追加されていますが、`apps/api/package-lock.json` の root package dependencies には同依存が存在しません。実際に `npm --prefix apps/api ci --dry-run --ignore-scripts` は `package.json and package-lock.json ... are in sync` ではないとして失敗し、`Missing: @pmtp/shared@0.1.0 from lock file` を返しました。CI/Vercel が clean install を使う経路ではビルド前に停止します。
  Recommendation: `apps/api` 配下で `npm install` 等を実行して `apps/api/package-lock.json` に `@pmtp/shared` の file dependency を反映し、更新された lockfile を差分に含めてください。

Next steps:
- `apps/api/package-lock.json` を package.json と同期する
- 同期後に `npm --prefix apps/api ci --dry-run --ignore-scripts` と `npm --prefix apps/api run typecheck:vercel` を再実行する
```

**eng-pm 向け文脈注記**: この High は「SMB 上での npm install 禁止」規約により実装担当が意図的に install を保留した結果であり、実装報告の「ふみさん側オペレーション 1」に `npm install --prefix apps/api` として既に委譲済み。ただし **「lockfile 差分のコミットまでが完了条件」が明文化されていない** ため、ふみさんのオペレーション項目に「install 後の `apps/api/package-lock.json` 差分を必ずコミットに含める + `npm --prefix apps/api ci --dry-run --ignore-scripts` で同期確認」を追記することを必須とする。

なお Codex は `typecheck` / `typecheck:vercel` の実機実行（両方 pass）と Secret 漏洩 grep（ヒットなし）も完了している。

---

## 組織固有観点レビュー（Claude）

### 必須修正

#### A-1（Critical 級）: `packages/shared/dist` が Vercel デプロイコンテキストに存在しない — 判断 3 のブロッカー解消が実機で未完成

**事実関係（実機確認済）**:
- `git check-ignore -v packages/shared/dist/index.js` → `.gitignore:4:dist` でマッチ。`git ls-files packages/shared/` に dist は含まれない（src のみ追跡）
- `.vercelignore` は不在 → CLI デプロイでも `.gitignore` がアップロード除外に使われる
- `packages/shared/package.json` は `main: dist/index.js` / build script は `tsc -p tsconfig.json`（手動実行のみ）。npm の `file:` 依存はシンボリックリンク化されるだけで、リンク先パッケージの devDependencies インストールや build/prepare 実行は行われない

**帰結**: Vercel ビルドマシン上では `packages/shared/` に `src/` しか存在せず、`require('@pmtp/shared')` → `main: dist/index.js` の解決が **MODULE_NOT_FOUND で即死**する。これは設計書 §3 判断 3 が塞ごうとしたブロッカーそのものであり、`file:` 依存追加は「ローカルの `npm start` 修復」には効くが「Vercel ランタイム解決」には半分しか効いていない。`vercel.json` の `includeFiles: ["packages/shared/dist/**"]` も、デプロイコンテキストに存在しないファイルは include できないため空振りする。

**なぜローカル検証で見えないか**: ローカルには手動 build 済みの dist が実在するため、typecheck / 全テスト 50 件 / 静的検証のすべてが green のまま通過する。デプロイして初めて顕在化する構造的盲点（テスト担当の静的検証スタイルでは原理的に検出不能）。

**修正案（いずれか / 推奨順）**:
1. **`apps/api` の postinstall を拡張**: `"postinstall": "npm --prefix ../../packages/shared install && npm --prefix ../../packages/shared run build && prisma generate"`。@vercel/node は entry 直近の package.json（apps/api）で install を実行するため、その postinstall で shared の install + build を連鎖させる。ローカルの `npm install --prefix apps/api` でも同じ経路が走り dist が常に最新化される副次効果あり。SMB 並列 install にならないよう直列連鎖（`&&`）であることが重要
2. `.gitignore` を `dist` → 限定パターンに変えて `packages/shared/dist` をコミット対象化（ゼロ設定だがビルド成果物のコミットは保守性が劣る / 非推奨）

いずれを採るにせよ、**phase2-serverless-static.spec.ts に「postinstall が shared build を含む」or「dist が git 追跡されている」の静的 assert を 1 件追加**して固定化すること。

#### A-2（High / Codex 由来）: lockfile 同期の完了条件明文化

上記 Codex セクションの注記参照。修正案 A-1 案 1 を採る場合、postinstall 変更後に install するため lockfile 同期と同一オペレーションで完了する。

### 承認できている設計判断（パス項目）

- [x] **判断 1（serverless-express 不採用 / 案 A）**: 妥当。@vendia/serverless-express は API Gateway/Lambda イベント→HTTP 変換層であり、素の `(req, res)` を渡す Vercel Node ランタイムには挟む場所がないという理解は正しい。依存追加ゼロで NestJS 公式 FAQ の標準形に一致。ブリーフからの逸脱は設計書 §1 で裁定依頼として明示済みで、逸脱プロセスも適正
- [x] **bootstrap SSoT 化（create-app.ts）**: `setGlobalPrefix('api/v1', { exclude: ['health'] })` の二重持ちが排除され、main.ts / api/index.ts とも createApp() 経由のみ。create-app.spec.ts が「直接 setGlobalPrefix を呼ばない」ことまで静的 assert しており乖離防止が構造化されている。将来 Phase の Bearer Token guard 追加も createApp() 1 箇所で済む拡張性がある
- [x] **冪等性ガード G-1/G-2 の設計書対照確認**: 設計書 §5 の 2 ガードとも実装に存在。G-1 = app ではなく初期化 Promise を module-level キャッシュ（api/index.ts L25-29 / 並行着弾でも bootstrap 高々 1 回）。G-2 = `.catch` で `appPromise = undefined` リセット + `console.error` + rethrow（L36-42 / 恒久 500 化の防止 / 握り潰しなし）。catch チェーンの構造もレース安全（リセットは reject 時に 1 回だけ走り、進行中の待機者には rejection が正しく伝播）。vercel-handler.spec.ts が両ガードを検証済
- [x] **判断 2（ルート vercel.json + builds + routes）**: モノレポで packages/shared を文脈に含める唯一の構成という判断は正しい。routes の順序（/health → /api/v1 → catch-all）も妥当。ダッシュボード Build 設定無効化のトレードオフは設計書 §2 で認識済
- [x] **判断 3 のローカル側半分（`file:` 依存 + tsconfig paths 共存）**: 型解決は paths（`packages/shared/dist/index`）、ランタイムは node_modules リンクという二層は衝突しない。`npm start`（`node dist/main.js`）の潜在破損も同時修復される
- [x] **api/tsconfig.json の TS6059 回避**: `rootDir: ".."` + `noEmit` + spec 除外で、既存 `typecheck` / `nest build` の対象範囲（`include: src/**`）に影響を与えない分離設計。Codex 実機で両 typecheck pass 確認済
- [x] **判断 4（Redis 残置物のセット撤去）**: `.env.example` キー / 逆方向 assert へのテスト書き換え / `docker/redis/` 削除 / `rag_local` network 残置、すべて参照整合が取れている。docker-compose は postgres + healthcheck 無傷
- [x] **YAGNI / 最小構成**: 未使用依存の先置き（serverless-express の布石論）を明示的に退けており組織のアーキテクチャ哲学に整合。`includeFiles` の保険 2 点も「ビルドログ確認後に不要なら削る」と撤去条件付きで許容範囲

### D### 系決議・規約との整合

- [x] 工数係数 ×2/3 適用 + PSP 3 フィールド: 設計 / 実装 / テストの 3 報告すべてに記載あり（`engineering-agent-psp-reporting.md` 準拠）
- [x] SMB 並列 install 禁止: install 未実行で遵守（その帰結が A-2）
- [x] 想定コストセクション（実装工数 + 月額実費 + 隠れコスト + ゼロコスト代替）: 設計書 §2 に 4 項目とも存在
- [x] コミット・push・gh 操作禁止: working tree のみで遵守（git status で全変更が未コミットであることを確認済）
- [⚠] **盲点 8（外部仕様の実機検証なし固定）**: 判断 1 の「Vercel が素の (req, res) を渡す」/ `includeFiles` のパス解決基準 / `NODEJS_HELPERS` body 競合 / postinstall 実行保証は、いずれも公式ドキュメント根拠のみで実機検証ログがない。Vercel 実機がふみさんのアカウント操作を要する以上、本フェーズ内での実機検証は構造的に不可能であり、設計書 §7 が自ら盲点 8 該当と申告 + §6 で実機確認項目を runbook へ引き継いでいるため **ブロッカーとはしない**。ただし後続デプロイフェーズの runbook（vercel-deploy.md）に「初回デプロイ後の確認 4 点（GET /health 200 / POST body 非空 / 関数サイズ / shared 解決）」を必須項目として明記することを承認条件に含める

### pre-merge gate / 独立性

- pre-merge gate: 本タスクは GitHub PR を経由しないローカルフェーズ（コミット・push はふみさん手動）のため HEAD SHA 突合は N/A。代替として、本レビューは working tree の実ファイル + `git diff` / `git status` 実機読みに基づく（報告文の転記ではない）ことを記録する
- 独立性: 本レビューは architecture 観点のみで作成し、quality レビュー（`phase-2-review-quality.md`）は参照していない（review-mode: parallel-agents）

### 推奨改善（任意 / 修正必須ではない）

1. **vercel.json の routes 明示 2 本**: catch-all 1 本で機能的には足りる。意図可読性のための残置は設計書で理由が述べられており許容だが、ルーティング変更時に 3 箇所更新になる点だけ留意
2. **`postinstall: prisma generate` と `npm ci --ignore-scripts` 系 CI の相互作用**: 将来 CI を整備する際、`--ignore-scripts` を使うと generate が走らない。CI 設計時に `prisma generate` の明示ステップを忘れないこと（今は CI 不在のため指摘のみ）
3. **Hobby maxDuration 10s vs LLM 呼び出し**: 設計書 §2 で認識済。RAG クエリエンドポイントの実レイテンシ計測をデプロイフェーズの確認項目に含めると判断材料が早く揃う

---

## 再レビュー条件

以下 2 点の対応後、差分レビュー（A-1 / A-2 のみ）で approved 判定可能:

1. A-1: shared build の Vercel ビルド時実行経路の確立（推奨: postinstall 連鎖）+ 静的 assert 1 件追加
2. A-2: ふみさんオペレーション項目への「lockfile 差分コミット + `npm ci --dry-run` 同期確認」明記
