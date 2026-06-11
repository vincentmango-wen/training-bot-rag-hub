# Phase 3 architecture レビュー — Bearer Token 認証 + Vercel deploy runbook

```yaml
---
ticket: phase-3-bearer-token-auth
github-pr: ""              # 未コミット working tree レビュー（commit/push はふみさん手動方針）
reviewer: architecture
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 1
codex-error-reason: ""
self-constraint-1-applied: false   # 直近 3 件以内の同型 hot-fix 連発なし（Phase 1/2 とも approved / hot-fix 系列不在）
self-constraint-2-triggered: n/a   # 独立性ルールにより quality レビュー未参照。共造判定は eng-pm が両レビュー突合時に実施
self-constraint-3-triggered: n/a   # claim-first トリガーキーワード非該当。設計書 §5 の N/A 根拠（read-only / ステートレス guard）を実コードで確認し妥当
self-constraint-4-triggered: n/a   # SSRF / DNS / undici / dispatcher 系の diff なし（auth guard のみ）。runbook の curl 実機検証手順性は quality の領分
---
```

## レビュー対象

- 設計書: `docs/operations/phase-3-design.md`
- 実装: `apps/api/src/common/guards/bearer-token.guard.ts`（+ spec 18 件）/ `apps/api/src/app.module.ts`（APP_GUARD 1 エントリ）/ `.env.example` ×2
- テスト: `apps/api/src/__tests__/phase3-bearer-auth-static.spec.ts`（35 件）/ `create-app.spec.ts` 追従 / `test/health.e2e-spec.ts` 追従
- runbook: `docs/operations/vercel-deploy.md` / `docs/operations/smoke-test.md`
- 形態: main 上の未コミット working tree（commit / push 禁止方針のため PR なし）。Codex は working tree diff を対象に実行

---

## Codex 機械観点レビュー

実行環境メモ: 当リポは `.node-version` 不在のため nodenv global (22.13.1 / codex 不在) にフォールバックし初回「Codex CLI is not installed」誤判定が発生。`PATH="$HOME/.nodenv/versions/22.22.3/bin:$PATH"` 前置で解決（memory `feedback_codex_nodenv_path.md` の既知事象）。本リポに `.node-version` を置くことを推奨（別チケット可）。

### Codex stdout（全文）

```
# Codex Adversarial Review

Target: working tree diff
Verdict: needs-attention

no-ship。Phase 3 の guard 自体は認証判定しているが、既存の global APP_FILTER との組み合わせで認証失敗が 401/503 ではなく 500 に潰れることが差分内のテストコメントでも確認できる。smoke-test と運用切り分けが成立しない。

Findings:
- [high] Bearer 認証失敗が global filter に潰されて 500 になる (apps/api/src/app.module.ts:24)
  `APP_GUARD` として `BearerTokenGuard` を全ルートに掛けているが、`RagModule` の `APP_FILTER` はアプリ全体に効き、`UnauthorizedException` / `ServiceUnavailableException` を `RAG_INTERNAL_ERROR(500)` に正規化する。これは `create-app.spec.ts` 側でも「実機の status は 500 になる」と認めている。結果として無認証、不正トークン、設定漏れがすべて 500 系に見え、Phase 3 の smoke-test が期待する 401/503 判別と、Vercel 側 401・アプリ側 401・設定不備 503 の運用切り分けが壊れる。
  Recommendation: `RagExceptionFilter` が `HttpException` の status/message を尊重するよう修正するか、RAG controller だけに filter をスコープする。あわせて Bearer なしは 401、API_BEARER_TOKEN 未設定は 503 を返す e2e を追加し、`create-app.spec.ts` の `>=400` 受け入れを具体ステータス検証へ戻す。

Next steps:
- 認証例外の HTTP status を保持する修正を入れる。
- smoke-test.md の期待値どおり 401/503 が返ることを自動テストで固定する。
```

集計: Critical 0 / High 1 / Medium 0 / Low 0

### reviewer による裏取り

Codex High-1 を実コードで独立検証し **事実と確認**:

- `apps/api/src/modules/rag/rag.module.ts:46` — `{ provide: APP_FILTER, useClass: RagExceptionFilter }`（同ファイル L14 のコメント自体が「APP_FILTER はモジュールスコープで provide しても **アプリ全体に効く**」と明記）
- `apps/api/src/modules/rag/http/rag-exception.filter.ts:38` — `@Catch()`（全例外捕捉）。`normalize()` の分岐は `RagApiException` / `ZodError` / `IdempotencyConflictError` / `ProviderError` のみで、**NestJS `HttpException` 分岐が存在しない** → guard の `UnauthorizedException(401)` / `ServiceUnavailableException(503)` は最終 fallback の `RAG_INTERNAL_ERROR(500)` に落ちる

---

## 組織固有観点レビュー（Claude）

### チェックリスト

- [x] **pre-merge gate 遵守**: 本フェーズは「commit / push / gh 操作禁止（ふみさん手動）」方針のため PR・HEAD SHA 突合は N/A。代替として実装報告の検証結果（typecheck clean / 323/324 pass / 残 1 fail は着工前からの既存問題で stash 検証済との申告）を確認。merge 相当の操作（ふみさんの手動 commit）前に、本レビューの必須修正の解消確認を gate 条件とすること
- [x] **独立性ルール遵守**: quality レビューファイルは未参照（本レビュー作成時点で読んでいない / 末尾フッター参照）
- [x] **D### 系決議との整合**:
  - D344（codex frontmatter 記載義務）→ 本 frontmatter に 4 フィールド記載済 / codex-status: succeeded
  - 盲点 8（外部仕様の実機検証なし固定の禁止）→ 設計書 §3 判断 5 / vercel-deploy.md §4 が Standard Protection の保護範囲を「要実機確認」フラグ付きで扱い、smoke-test Test 1 で実機検証する構成。**遵守**
  - PSP 報告規律（2026-06-07 制定）→ 設計・実装・テスト各報告に psp フィールドあり。**遵守**
- [x] **設計書との適合（architecture チェックリスト §7 全 4 項目）**:
  - APP_GUARD 方式（判断 1 案 A）で `create-app.ts` / `api/index.ts` が無改変 → **確認**（git diff は app.module.ts の import 2 行 + providers 1 エントリのみ / 静的 spec でも担保）
  - guard の配置が `common/guards/` で `guardrail/`（LLM ドメインガード）と分離 → **確認**
  - `/health` 例外機構（`@Public()` decorator 等）を勝手に追加していない → **確認**（`Public` / `SetMetadata` / `Reflector` の grep 0 件 / 判断 2・YAGNI 遵守）
  - fail-closed（503）の分岐が guard 内（リクエスト時判定）に閉じ、bootstrap 時 throw でない → **確認**（G-2 再試行ループと干渉しない）
- [x] **保守性・拡張性・抽象化（YAGNI / 責務分離）**: guard は 80 行・単一責務・ステートレス。許容トークンリスト / scheme 大小文字非依存 / decorator 免除をすべて不採用とし判断根拠をコメントに残す構成は組織のアーキテクチャ哲学（最小構成 / 早すぎる一般化禁止）に合致。将来の `@Public()` 拡張も guard 構造を壊さず追加可能
- [x] **テスタビリティ**: env をリクエスト毎に読む設計により DI なしで単体テスト可能（spec 18 件が ExecutionContext 手書きモックのみで完結 / 依存追加ゼロ）。env の beforeEach 保存 / afterEach 復元で spec 間汚染なし。妥当

### 構造的指摘（Claude 独自 / 重大）

**C-1: 設計契約（設計書 §4-6 / smoke-test 判別表）と実装挙動の矛盾 — Codex High-1 と同根だが、本質は「文書成果物が実機で成立しない」こと**

- 設計書 §4-6 / smoke-test.md Test 2・Test 3 は「アプリの **401 / JSON**」、判別表は「**503 = `API_BEARER_TOKEN` 未投入**」を期待値として固定している。vercel-deploy.md §8 も「全リクエストが JSON 503」を症状として記載
- しかし実機では `RagExceptionFilter` により **401 も 503 もすべて `500 + RAG_INTERNAL_ERROR`** になる。つまり **smoke-test Test 2 / Test 3 は正しい deploy でも文書上「NG パターン」に落ち、判別表の 503 行は到達不能**
- Phase 3 の受け入れ条件は「ふみさんが runbook 単独で完走できること」。このままでは Test 2 で 500 が返り、判別表に従って「bootstrap 失敗（DB / Prisma / OpenAI）」という**誤った調査経路**に誘導される。判断 4（401 と 503 の切り分け可能性）が fail-closed 採用の根拠だったが、その切り分け自体がフィルタで無効化されている
- 実装担当はこの逸脱を `create-app.spec.ts` のコメントと完了報告に明記し、フィルタ改修を別チケットに送った（変更範囲限定の判断自体は理解できる）。しかし **runbook 側を実挙動に追従させないまま** 文書を納品しており、コード逸脱の自己申告と文書成果物の整合が取れていない。ここが needs-revision の核

**修正案（いずれか必須 / A 推奨）**:

- **案 A（推奨 / 約 10〜15 行）**: `RagExceptionFilter.normalize()` の fallback 直前に `exception instanceof HttpException` 分岐を追加し、`getStatus()` / message を尊重（401 → `RAG_UNAUTHORIZED` 系 code の新設 or 既存 code 体系への写像はエラー code 規約に従う）。設計書 §4-6 / smoke-test の期待値がそのまま成立し、`create-app.spec.ts` の `>= 400` 緩和を具体ステータス（401）検証へ戻せる。「不正トークン連打が error レベル + stack でログされる運用ノイズ」（フィルタ L51-55 の 5xx 分岐）も自然解消。guard 専用 hack ではなく HttpException 全般の尊重なので将来の guard / pipe 追加にも効き、最小構成原則の範囲内
- **案 B（最小 / フィルタ無改変を貫く場合）**: smoke-test.md Test 2・3 の期待値と §6 判別表、vercel-deploy.md §8 を実挙動（500 + JSON / body の `error.code` と関数ログで判別）に書き換え、設計書 §4-6 に逸脱注記を追記。ただし「外側 401 HTML / 内側 500 JSON」の判別は成立するものの、設定不備（503 相当）と本物の bootstrap 失敗が区別不能のまま残るため、判断 4 の設計意図が恒久毀損する。案 A より劣る

**併せて必須（案 A 採用時）**: ケース 9 検証（`create-app.spec.ts` L81-89）を 401 の具体ステータス assert に戻す + env 未設定 503 の http レベル検証を 1 件追加（Codex Next steps と同旨）

### 軽微な指摘（non-blocking / 推奨改善）

1. **静的 spec の文字列マッチ脆弱性**: `phase3-bearer-auth-static.spec.ts` はソース文字列の `toContain` 依存が強く、無害なリファクタ（クォート変更・改行位置）で偽陽性 fail し得る。ただし phase1/phase2 静的 spec と同型のスタイル踏襲であり、本リポの確立済パターンとして許容。次の大型リファクタ時に AST ベース or コンパイル時検証への移行を検討
2. **`.node-version` の設置**: 今回の Codex 起動失敗（nodenv フォールバック）の構造的解消として、リポルートに `.node-version`（22.22.3 等 codex 導入済バージョン）を置く 1 行チケットを推奨

### スコープ外観測（eng-pm への申し送り / Phase 3 の verdict には不算入）

Codex の初回実行（フォーカステキスト不完全のまま working tree 全体を走査）が Phase 1/2 由来の deploy 阻害 2 件を検出した。Phase 3 の runbook `vercel-deploy.md` §5-2 が前提とする「初回 deploy 成功」自体に関わるため記録:

- [high 相当] `apps/api/package.json` の `@pmtp/shared` runtime 依存が `package-lock.json` に未同期 → lockfile ベース install（Vercel / CI）が失敗する可能性
- [high 相当] fresh checkout の Vercel build で `packages/shared/dist` が生成されない（`.gitignore` で dist 未追跡 + `postinstall` は `prisma generate` のみ）→ `MODULE_NOT_FOUND` で起動不能の可能性

いずれも Phase 2 成果物の範囲。Phase 3 の runbook §5-2 トラブルシュート表は両症状を確認項目として既に列挙しているが、「確認して直す」ではなく構造的に直すチケット（Phase 2 follow-up）を初回 deploy 前に消化することを推奨。

---

## 統合 verdict

**needs-revision**

| 入力 | 結果 |
|---|---|
| Codex | High 1 件（401/503 → 500 潰し）/ Critical 0 |
| Claude 組織固有観点 | 重大 1 件（C-1: runbook 文書成果物が実機で成立しない — Codex High-1 と同根）|
| 統合ルール | Codex High あり → changes-requested（= needs-revision）|

設計書適合（§7 architecture 4 項目）・YAGNI・責務分離・テスタビリティ・guard 単体の実装品質はいずれも良好で、必須修正は **フィルタ 1 箇所（案 A）+ spec 2 件** または **runbook 書き換え（案 B）** に閉じる。修正後の再レビューは差分確認のみの軽量パスで可。

---

**独立性の補足**: 本レビューは architecture 観点のみで作成し、もう一方のレビュー（`phase-3-review-quality.md`）は参照していない。
