---
ticket: phase-3-bearer-token-vercel-deploy
reviewer: quality
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 2
codex-error-reason: ""
self-constraint-1-applied: false   # 直近 3 件以内の同型 hot-fix 連発なし（Phase 1→2→3 は通常進行）
self-constraint-2-triggered: n/a   # parallel-agents 独立レビューのため共造判定は eng-pm 裁定時
self-constraint-3-triggered: n/a   # claim-first トリガーキーワード非該当（diff に $transaction/upsert/claim なし）— 設計書 §5 N/A 根拠は妥当と独立検証済
self-constraint-4-triggered: n/a   # undici/DNS/fetch interceptor 等の外部ライブラリ DI なし。smoke-test の実機検証手順成立性は High-1 で指摘
---

# Phase 3 品質レビュー（quality 観点）— Bearer Token 認証 + Vercel deploy runbook

- レビュー対象: 未コミット working tree（guard 実装 + spec + runbook 2 本 + .env.example ×2 + app.module.ts）
- レビュー実施日: 2026-06-11
- 注: 本リポジトリは「コミット・push・gh 操作禁止（ふみさん手動）」運用のため GitHub PR は存在しない。レビューは working tree 直接走査 + Codex working tree diff で実施

---

## Codex 機械観点レビュー

起動: `codex-companion.mjs adversarial-review --wait --base main --scope branch`（cwd = リポジトリルート）。
※ 起動時に既知の nodenv ミスマッチ（本リポに `.node-version` なし → codex 不在の node 22.13.1 にフォールバック）で「未インストール」誤判定が出たため、`PATH="$HOME/.nodenv/versions/22.22.3/bin:$PATH"` 前置で解消（memory `feedback_codex_nodenv_path.md` の既知パターン）。

### Codex stdout（全文）

```
# Codex Adversarial Review

Target: working tree diff
Verdict: needs-attention

no-ship。clean install と fresh Vercel build が再現不能で、Bearer 認証の失敗応答も 500 に潰れるため、出荷後の初回デプロイと運用確認が壊れる可能性が高いです。

Findings:
- [high] `@pmtp/shared` 追加後に lockfile が同期されていない (apps/api/package.json:26)
  `apps/api/package.json` は runtime dependency に `@pmtp/shared` を追加していますが、`apps/api/package-lock.json` の root dependencies には同依存が存在しません。lockfile ベースの clean install では package.json/package-lock の不整合で止まるため、CI/Vercel の fresh install 経路が再現不能になります。
  Recommendation: `apps/api` で依存解決を更新し、`apps/api/package-lock.json` に `@pmtp/shared` と `node_modules/@pmtp/shared` の file dependency エントリを反映したうえで、`npm ci` 相当の同期確認を通してください。
- [high] fresh Vercel build で `@pmtp/shared` の `dist` が存在しない (vercel.json:9)
  Vercel 設定は `packages/shared/dist/**` を含めるだけですが、`@pmtp/shared` の package entry は `dist/index.js` を指し、`packages/shared/dist` は `.gitignore` の `dist` で未追跡です。さらに `apps/api` の `postinstall` は `prisma generate` だけなので、fresh checkout の Vercel build では shared の dist が生成されず、`@pmtp/shared` の runtime import が MODULE_NOT_FOUND で起動前に落ちると推論できます。
  Recommendation: Vercel の repo 内 build 手順で `packages/shared` を必ず先に build してください。例: `apps/api` の `postinstall` または Vercel build command に `npm --prefix ../../packages/shared install && npm --prefix ../../packages/shared run build` 相当を入れ、fresh checkout で dist 不在から検証してください。
- [medium] Bearer 認証の 401/503 が既存 global filter で 500 に潰れる (apps/api/src/app.module.ts:24)
  この変更で `BearerTokenGuard` が APP_GUARD として全ルートに登録され、guard は未設定時に `ServiceUnavailableException`、認証失敗時に `UnauthorizedException` を投げます。一方、既存の `RagExceptionFilter` は `HttpException` を尊重せず未知例外を `RAG_INTERNAL_ERROR` 500 に正規化します。結果として smoke-test が期待する 401/503 が返らず、認証失敗とサーバ障害を区別できず、監視や復旧判断を誤らせます。
  Recommendation: `RagExceptionFilter` に `HttpException` 分岐を追加して status/message を保持するか、認証例外を filter の 500 正規化対象から除外してください。あわせて `/health` の無認証は 401、`API_BEARER_TOKEN` 未設定は 503 を返す e2e を追加してください。
```

### Codex High 指摘の reviewer 裏取り（実体確認済 / 偽陽性なし）

- High-A（lockfile 不整合）: `grep -c "@pmtp/shared" apps/api/package-lock.json` → **0 件**。`apps/api/package.json:26` には `"@pmtp/shared": "file:../../packages/shared"` あり。npm ci 系 clean install は確実に失敗する。**真**
- High-B（shared dist 不在）: `.gitignore:4` に `dist`（packages/shared/dist は未追跡）。`packages/shared/package.json` の `main` は `dist/index.js`。`apps/api` の `postinstall` は `prisma generate` のみ。fresh checkout では dist が生成されない。**真**
- 注: High-A / High-B はいずれも **Phase 2 由来の working tree 変更**（Phase 3 の実装ファイル 9 件には含まれない）。ただし Phase 3 の納品物である `vercel-deploy.md` が誘導する初回 deploy（§5）を**起動前に確実に阻害**し、§5-2 / §8 のトラブルシュート表にも該当行がないため、本フェーズの受け入れ判断に直結する。

---

## 組織固有観点レビュー（Claude）

### 🟠 High-1: runbook の期待ステータス（401 / 503）が実機挙動（500）と食い違う — smoke-test が「実機検証手順として成立」していない

設計書 §7 quality 観点の必須チェック項目「smoke-test.md の curl が実機検証の手順として成立しているか（期待 status の根拠が判別表で追えるか）」に **不適合**。

- 事実関係（独立確認済）:
  - `RagExceptionFilter` は `@Catch()`（全例外）+ `APP_FILTER`（`rag.module.ts:46` / アプリ全域適用）で、`HttpException` 分岐を持たず、guard の `UnauthorizedException(401)` / `ServiceUnavailableException(503)` を **`RAG_INTERNAL_ERROR(500)` に正規化**する（`rag-exception.filter.ts:134-138`）
  - 実装担当も `create-app.spec.ts:81-89` のコメントで「実機 status は 500 になる」と認識済み。**しかし runbook 2 本にはこの実挙動が反映されていない**
- 食い違い箇所（修正必須）:
  - `smoke-test.md` §3 Test 2: 期待「401 + JSON」→ 実機は **500 + `RAG_INTERNAL_ERROR` JSON**
  - `smoke-test.md` §4 Test 3: 期待「401 + JSON」→ 同上 500
  - `smoke-test.md` §3 NG 表「503 = env 未投入」→ 実機は 500（503 は返らない）
  - `smoke-test.md` §6 判別表: 「`500` = bootstrap 失敗」→ **認証失敗も 500 になるため、この行が deploy 実施者（ふみさん）を bootstrap デバッグへ誤誘導する**。Test 2/3 で必ず 500 が返る以上、判別表は機能しない
  - `smoke-test.md` §7 完了基準: 「Test 2: 401 + JSON / Test 3: 401 + JSON」→ 実機では絶対に満たせない完了基準（**runbook 通読 → 実行で完走不能**）
  - `vercel-deploy.md` §8: 「全リクエストが JSON 503 = `API_BEARER_TOKEN` 未投入」→ 実機は 500
- リスク: ふみさんが単独で smoke-test を実施した際、正しく動作している認証を「bootstrap 失敗（500）」と誤認し、DB / Prisma / OpenAI 接続の無駄な調査に入る。runbook の唯一の目的（単独完走）が崩れる
- 是正案（いずれか必須 / 推奨は a）:
  - (a) `RagExceptionFilter.normalize()` に `HttpException` 分岐を追加し status / message を保持（数行の変更。401/503 の設計判断 4 の切り分け価値がそのまま復活し、runbook は現状のまま正となる）。guard の固定メッセージ方針は維持されるため情報供与リスク増なし
  - (b) 本 PR を runbook 側の修正に倒す: Test 2/3 期待値を「500 + `RAG_INTERNAL_ERROR`（フィルタ写像による既知挙動 / 別チケットで 401 化予定）」へ書き換え、判別表に「500 = 認証失敗 or bootstrap 失敗 → 関数ログで `[BearerTokenGuard]` の有無により切り分け」の行を追加
  - 補足: (b) を選ぶ場合、設計判断 4 の「401 と 503 を切り分け可能にする」根拠が HTTP レイヤでは死ぬため、設計書 §3 判断 4 への注記も併せて必要
- 関連で軽微な観測: フィルタの 5xx 分岐により、**認証失敗のたびに error レベル + stack でログが出る**（運用ノイズ / 値の漏洩はなし）。(a) を採れば 4xx は warn 1 行に収まり解消する

### ✅ 通過項目（設計書 §7 quality チェックリスト対照）

- [x] `timingSafeEqual` の両辺 SHA-256 で 32 byte 正規化済（`bearer-token.guard.ts:71-74`）。長さ不一致 RangeError / 長さリークなし。§6 ケース 5 のテスト存在確認済（短い / 長い両方 + `not.toThrow(RangeError)`）
- [x] トークン値・Authorization ヘッダ値がログ / 例外メッセージに現れない: guard のログは固定文言のみ（`bearer-token.guard.ts:50-52`）、例外も固定文言。spec ケース 8 が Logger spy 引数 + 例外 serialize の双方を文字列検査。grep でも値参照のログ出力ゼロを確認
- [x] 401 レスポンスが失敗理由（欠落 / scheme / 不一致）を区別しない: `INVALID_TOKEN_MESSAGE` 固定文言 1 種のみ
- [x] `process.env` の読み取りがリクエスト毎（`canActivate` 内 / コンストラクタキャッシュなし）。spec の env 復元は `beforeEach` 保存 → `afterEach` 復元 + ケース 11 で独立性検証
- [x] `.env.example` ×2 に実値なし（`API_BEARER_TOKEN=` 空 / 静的 spec が `^API_BEARER_TOKEN=\s*$` で機械検証）。runbook にも実値・サンプルトークンなし。`.env` 実体は git 管理外
- [x] fail-closed: 未設定 / 空文字 → 503（guard 内判定 / 空文字を「設定済」と誤認しないテストあり）。fail-open バックドアなし。テスト用 guard 無効化バックドアも作っていない（spec はトークン注入方式）
- [x] Secret 運用設計: Vercel 環境変数 Sensitive 指定 / `read -s` でシェル履歴回避 / パスワードマネージャ保管 / URL 引数禁止注記 / ローテーション手順（トークン §9 / bypass secret §10）あり
- [x] 盲点 8（外部仕様の実機検証なし固定）予防: Standard Protection の保護範囲は設計書 §3 判断 5 / `vercel-deploy.md` §4 ともに「⚠️ 要実機確認」フラグ付きで断定していない。最終検証を smoke-test Test 1 に委譲する構造
- [x] 冪等性（runbook 手作業側）: 設計書 §5 の 3 項目が runbook に反映済 — env 再投入は Edit（§9-2）/ bypass secret 再発行で旧即無効（§10-2）/ `prisma migrate deploy` 冪等（§6-2）
- [x] 個人運用での非公開化要件: ダブルロック構造は成立（外側 Standard Protection + 内側 Bearer）。guard 自体は全ルート保護（/health 含む）で露出ゼロ

### claim-first ガード検証（自己制約 3）

- トリガーキーワード走査: 本 diff（guard / spec / runbook / env テンプレ / app.module）に `$transaction` + INSERT / `upsert` / `ON CONFLICT` / `claim` 識別子 / `findFirst`+early return / ステータス機械は**不在** → n/a
- 設計書 §5「冪等性ガード（実装必須項目）」の N/A 根拠を独立検証: `BearerTokenGuard` は DB write / 外部 API call / ファイル write / 状態遷移を一切持たない読み取り専用判定（実装コードで確認済）。**N/A 根拠は妥当**
- runbook 側の再実行安全性 3 項目は上記 ✅ の通り全て反映済

### 自己制約 4 検証（SSRF / network egress）

- 外部ライブラリ DI / undici / DNS lookup / fetch interceptor は diff に不在 → n/a
- ただし quality 観点として課された「smoke-test が実機検証手順として成立しているか」は **High-1 の通り不成立**（Test 2/3 の期待 status が実機と乖離）

### 🟡 Medium（修正推奨）

- M-1: **rag 系 e2e 4 本の Authorization 未追従で `test:e2e` ジョブが red のまま**。実装担当が残課題として明示しており隠蔽はないが、「red なテストスイートを既知として放置」は次フェーズで麻痺（real regression の見落とし）を生む。マージ前にチケット起票（eng-test 担当 / 共通 helper 化）まで確定させること
- M-2: High-1 是正案 (a) を採る場合、`smoke-test.md` の期待値はそのまま正になるが、**採否がどちらでも「runbook と実装の整合検証」を完了基準に含める**こと（今回の食い違いは「実装担当が認識していたのに納品物へ未反映」という伝搬漏れであり、再発しやすい構造）

### 🟢 Low（任意改善）

- L-1: `smoke-test.md` §8 の `fc -p` は zsh で履歴スタック切替であり「該当行の削除」にはならない。`read -s` 徹底で実害は薄いが、手順としては `.zsh_history` 手動編集の行だけ残す方が正確
- L-2: プロジェクト名表記ゆれ（リポ = `training-bot-rga-hub` / runbook 内プロジェクト名例・service 文字列 = `training-bot-rag-hub`）。既存由来だが、Vercel プロジェクト名を確定値で入れる §2-4 の指示と併せて初見の混乱要因
- L-3: guard spec ケース 8「未設定時に Logger 引数へ期待トークン値が含まれない」は、未設定時は期待値が存在しないため検証情報量が小さい（形骸ではないが弱い）。不一致時（設定済）の Logger 検査は不要（そもそもログを出さないパス）なので現状で実害なし

---

## 統合 verdict

**needs-revision（changes-requested 相当）**

| 出所 | 件数 | 内訳 |
|---|---|---|
| Codex Critical | 0 | — |
| Codex High | 2 | High-A: lockfile に `@pmtp/shared` 未同期（clean install 不能）/ High-B: `packages/shared/dist` が fresh checkout に存在せず MODULE_NOT_FOUND（いずれも Phase 2 由来だが、Phase 3 納品物 vercel-deploy.md の初回 deploy を確実に阻害 + トラブルシュート表に該当行なし） |
| Codex Medium | 1 | 401/503 → 500 写像（Claude High-1 と同根 / Claude 側で High に格上げ） |
| Claude High | 1 | High-1: smoke-test.md / vercel-deploy.md の期待ステータス（401/503）が実機挙動（500）と乖離 — runbook の完了基準（§7）が実機で満たせず、判別表が bootstrap デバッグへ誤誘導。設計書 §7 quality 必須チェック項目に不適合 |
| Claude Medium | 2 | M-1: rag e2e 4 本 red 放置のチケット確定 / M-2: runbook-実装整合の完了基準化 |
| Claude Low | 3 | L-1〜L-3 |

### 判定根拠

- §4 統合 verdict 表: Codex High あり → `changes-requested`。Claude 独自でも High-1（runbook = ふみさんの単独 deploy 完走という本フェーズの受け入れ条件そのものを毀損）
- **セキュリティ実装そのものは堅牢**（timingSafeEqual + SHA-256 正規化 / fail-closed / 固定文言 / 値の非ログ / バックドアなし / Secret 運用設計良好）であり、blocked（課金・PII・重大セキュリティ欠陥）には該当しない。リクエストは全パターンで確実に拒否される — 壊れているのは「拒否のされ方の可観測性」と「deploy 前提の成立性」
- 必須修正（マージ / ふみさんコミット前）:
  1. High-1: フィルタ `HttpException` 尊重（推奨 / 数行）or runbook 期待値の実挙動への書き換え + 判別表修正
  2. Codex High-A: `apps/api/package-lock.json` の `@pmtp/shared` 同期（SMB 制約のため `npm install` はふみさんローカル実施）
  3. Codex High-B: `packages/shared` の build を deploy 経路に組込（postinstall 拡張 or vercel.json 調整）+ vercel-deploy.md §5-2 への確認行追加
  4. M-1: rag e2e 追従チケットの起票確定

---
**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（`phase-3-review-architecture.md`）は参照していない。
