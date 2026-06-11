# Vercel + Neon 移行 総括レポート（Phase 1〜5）

作成: 2026-06-11 / eng-pm（秘書ロール）
対象リポ: `/Volumes/DevShare/projects/training-bot-rga-hub`
ゴール: docker-compose（SMB I/O 不安定）→ Vercel Hobby + Neon Free の個人非公開運用 / 月額 ¥0

> **重要**: 全変更は未コミット working tree（新規 40 ファイル 8,163 行 + 既存 11 ファイル修正 +87/-48）。コミット・push はふみさん手動。**8 レビュー中 7 件が needs-revision** のため、§4 の必須修正を消化してからコミット → deploy に進むこと。

---

## 1. Phase 別サマリ表

| Phase | 主要成果物 | arch | qual | 残課題（必須修正） |
|---|---|---|---|---|
| 1: Neon + migration | `neon-setup.md` / `.env.example` 2 系統 URL（Direct/Pooler）追記 / `phase1-migration-static.spec.ts` | needs-revision（Codex High 1: runbook §4 URL クエリ二重付与） | **approved**（Medium 3 / Low 2 のみ） | runbook §4 の `?`/`&` 分岐明示 / `\dt` SQL Editor 非互換修正 |
| 2: serverless 化 | `create-app.ts` / `api/index.ts` / `vercel.json` / docker-compose Redis 完全撤去 / 50 tests | needs-revision | needs-revision | **`packages/shared/dist` が gitignored で deploy コンテキスト不在**（postinstall で shared build 必要）/ lockfile に `@pmtp/shared` 未同期 |
| 3: Bearer 認証 + deploy runbook | `bearer-token.guard.ts`（APP_GUARD / fail-closed）/ `vercel-deploy.md` / `smoke-test.md` / 70 tests | needs-revision（High 1: 401/503 → 500 潰し） | needs-revision（Phase 2 由来の lockfile/dist 2 件 + 同 500 写像） | `RagExceptionFilter` に HttpException 分岐追加（または runbook 期待値を現行挙動に整合） |
| 4: ingestion CLI 分離 | `scripts/ingest/` 5 ファイル（既存 IngestionService 再利用 / createApplicationContext）/ `ingestion-runbook.md` / 106 tests | changes-requested（Codex High 2 + Claude High 1） | needs-revision（**Codex failed**: working tree 未コミットで diff 空 / Claude High 2） | live モード前提（openai SDK 未宣言）/ 再取込時の旧文書残置 / mtime→payloadHash 409 / 中断 replay の exit 0 |
| 5: PTP cutover 指示書 | `cutover-smoke-test.sh`（291 行）/ `ptp-client-cutover.md` / README 追記 / 53 tests | changes-requested（Codex High 1 + Claude High 2） | needs-revision（**Claude Critical 1: §9「実機検証済」虚偽記載**） | §9 の虚偽記載是正（実機検証 or「未検証」へ書換）/ T2・T3 期待値の filter 500 問題と整合 / secret の curl argv 露出 → `--config` 化 |

テスト資産: 静的検証 spec 9 ファイル / 約 280 テスト新規追加。既存失敗 1 件（`providers.module.di-smoke` = openai 未インストール / 着工前からの既存問題、各 Phase と無関係を stash 検証済）。

---

## 2. ふみさん手動作業チェックリスト

**前提 0（最優先）**: §4 の必須修正をエージェントに消化させてから以下に進む。特に Phase 2 の `packages/shared/dist` 問題と lockfile 同期は **初回 deploy が確実に失敗する** ブロッカー。

1. **必須修正の消化確認 → git commit + push**（ふみさん手動 / 全変更が未コミット。コミット後に Phase 4 qual の Codex 再レビューが可能になる）
2. **Neon プロジェクト作成**: `neon-setup.md` §2-3。リージョン選択 → Pooled / Direct の 2 接続文字列を取得
3. **Vercel プロジェクト作成**: `vercel-deploy.md` §2。リポ連携 + Root Directory 設定
4. **環境変数投入**: `vercel-deploy.md` §3。`DATABASE_URL`（Pooler）/ `DATABASE_URL_DIRECT` / `API_BEARER_TOKEN`（§3-2 で生成）/ `OPENAI_API_KEY`。あわせて §4 で Deployment Protection（Standard Protection）を有効化
5. **npm install（ローカル / 直列実行）**: `npm install --prefix apps/api` → **lockfile 差分を必ずコミット**（Phase 2 必須修正）。SMB 上で並列 install 禁止
6. **migrate deploy**: `neon-setup.md` §5 / `vercel-deploy.md` §6。ローカルから Direct URL 経由で `prisma migrate deploy` → §6-3 で pgvector 拡張確認（`CREATE EXTENSION` は init migration に含まれるため追加作業なし）
7. **初回 deploy**: `vercel-deploy.md` §5。ビルドログで shared build / prisma generate の通過を確認
8. **smoke-test**: `smoke-test.md` 全 Test。外側ロック（Vercel 401）→ 内側ロック（アプリ 401 JSON）→ 正常系の 3 段確認
9. **PTP 側 cutover**: `ptp-client-cutover.md` + `cutover-smoke-test.sh`。PTP リポで env 変数 discovery grep → URL 切替（env 1 本 / 切り戻しは env 復元のみ）

---

## 3. 想定コスト最終確認

| 項目 | 月額 | 備考 |
|---|---|---|
| Neon Free | ¥0 | 0.5 GB ストレージ / 月 190 compute hours / autosuspend あり |
| Vercel Hobby | ¥0 | 個人非公開・非商用の範囲内 |
| OpenAI embedding | 従量（≒¥0〜数十円） | ingestion 実行時のみ。content_hash 差分再利用で再取込コスト抑制済 |

**有償化トリガー（監視ポイント）**:
- Neon ストレージ 0.5 GB 超過（`neon-setup.md` §8 の監視手順で月次確認）→ Launch plan $19/月
- Neon compute 190 h/月超過（常時アクセスがなければ autosuspend で実質届かない）
- Vercel Hobby の商用利用該当（収益化したら Pro $20/月）
- **隠れコスト**: コールドスタート（autosuspend 復帰で数百 ms〜数秒）は ¥0 の対価として許容済

---

## 4. 既知のリスク・残課題・後続チケット候補

**deploy ブロッカー（コミット前に必須）**:
1. `packages/shared/dist` が gitignored → Vercel fresh checkout で MODULE_NOT_FOUND。`apps/api/package.json` postinstall を `npm --prefix ../../packages/shared run build && prisma generate` へ拡張（Phase 2 arch A-1 / Phase 3 qual High-B）
2. `apps/api/package-lock.json` に `@pmtp/shared` 未反映 → `npm ci` 再現不能（Phase 2/3 共通 High）
3. `RagExceptionFilter` に HttpException 分岐なし → 401/503 が 500 に潰れ、smoke-test T2/T3 が構造的に不成立（Phase 3 arch / Phase 5 共通）
4. Phase 5 手順書 §9「実機検証済」虚偽記載の是正（Claude Critical / 検証ログを残すか「未検証」へ書換）

**後続チケット候補**:
- ingestion live モード整備（openai SDK 依存宣言 + 再取込時の旧文書残置解消 + 中断 replay の exit code 修正）— Phase 4 High 群を 1 チケットに束ねる
- `cutover-smoke-test.sh` の secret argv 露出 → `curl --config` 化（Phase 5 qual H-2）
- コミット後の Phase 4 qual **Codex 再レビュー**（今回 `codex-status: failed` = branch diff 空が原因 / auth 正常）
- `providers.module.di-smoke` 既存失敗の解消（openai package / SMB 環境問題）

**プロセス上の特記**: Phase 5 で「実機検証なしの検証済み記載」が発生 — 盲点 8（外部仕様の実機検証なし固定）と同型。cutover 当日は手順書を鵜呑みにせず smoke スクリプトの実走結果を正とする。

---

## 5. PSP 集計（5 Phase × 5 ロール = 25 agent）

**code-volume（git 実測 / 客観値）**:

| 指標 | 値 |
|---|---|
| 新規ファイル | 40（計 8,163 行）— runbook/設計書/レビュー 20 + 実装/テスト 20 |
| 既存ファイル修正 | 11（+87 / -48）— docker-compose Redis 撤去 / main.ts / package.json 等 |
| 新規テスト | 9 spec ファイル / 約 280 テスト（323/324 pass / 残 1 は既存問題） |

**bug-count（レビュー指摘の合算 / Critical+High+Medium）**:

| Phase | Critical | High | Medium | 計 |
|---|---|---|---|---|
| 1 | 0 | 1 | 4 | 5 |
| 2 | 1（級） | 3 | 1 | 5 |
| 3 | 0 | 3 | 1 | 4 |
| 4 | 0 | 5 | 8 | 13 |
| 5 | 1 | 3 | 2 | 6 |
| **計** | **2** | **15** | **16** | **33** |

**actual-duration**: 各 agent の完了報告には PSP フィールドが含まれていたが、リポ内ファイルに永続化されたのは一部のみ（例: Phase 2 design = 0.4h / estimated 1.0h / deviation -60%）。壁時計実測ではセッション全体で約 14 時間（06-10 22:30 〜 06-11 12:37 のファイル mtime 帯）。**残作業**: 各完了報告の psp 値を `.company/engineering/metrics/psp-log.csv` に 25 行バックフィルする（係数検証データとして 10 件以上の閾値を一気に超えるサンプル群）。観測傾向は既知パターンと一致 — 文書系は 2/3 係数でも大幅過大評価、設計判断含む工程は短縮率が小さい。
