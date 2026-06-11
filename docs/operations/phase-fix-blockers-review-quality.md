# phase-fix-blockers — 品質・リスク観点レビュー（eng-reviewer-quality）

```yaml
ticket: phase-fix-blockers (B-1〜B-4 deploy ブロッカー一括消化)
github-pr: ""              # コミット前 working tree レビュー / gh 操作禁止ワークフロー
reviewer: quality
review-mode: parallel-agents
verdict: approved          # 条件付き（§統合 verdict 参照 / コミット前に vercel-deploy.md §1.5 実行必須）
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 1
codex-error-reason: ""
self-constraint-1-applied: true
self-constraint-2-triggered: n/a   # 並列独立実行のため共造判定は eng-pm 突合時に実施
self-constraint-3-triggered: true
self-constraint-4-triggered: n/a   # diff に undici / DNS / fetch interceptor / SSRF 防御層なし
```

---

## Codex 機械観点レビュー

起動メモ: 初回起動は `Codex CLI is not installed` で失敗 → 既知の nodenv パス問題（memory: feedback_codex_nodenv_path / 本リポに `.node-version` 不在のため codex 不在版 node にフォールバック）。`PATH="$HOME/.nodenv/versions/22.22.3/bin:$PATH"` 前置で再実行し成功。**auth 切れではない**（CODEX_AUTH_EXPIRED シグナル非該当）。

以下、Codex stdout 全文:

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

ship不可。clean install が実証済みで失敗し、rate limit 応答契約も HttpException 経路で欠落する。

Findings:
- [high] package.json と lockfile が同期しておらず clean install が停止する (apps/api/package.json:28)
  `apps/api/package.json` は `@pmtp/shared` を runtime dependency に追加しているが、`apps/api/package-lock.json` には該当 entry が存在しない。実際に `npm --prefix apps/api ci --dry-run --ignore-scripts` は `Missing: @pmtp/shared@0.1.0 from lock file` で失敗した。Vercel/CI が lockfile ベースで install する経路では postinstall に到達せず、deploy 不能になる。
  Recommendation: `apps/api` で lockfile を更新し、`apps/api/package-lock.json` に root dependency と `node_modules/@pmtp/shared` の `file:../../packages/shared` entry を反映する。その後 `npm --prefix apps/api ci --dry-run --ignore-scripts` を通す。
- [medium] HttpException 429 経路で Retry-After が欠落する (apps/api/src/modules/rag/http/rag-exception.filter.ts:103-116)
  新規分岐は任意の `HttpException` の 429 を `RAG_RATE_LIMITED` に写像するが、`retryAfterSeconds` を設定しない。`catch()` は `normalized.retryAfterSeconds` がある場合だけ `Retry-After` を付けるため、この経路の 429 はヘッダなしで返る。ファイル冒頭コメントは「429 系は Retry-After ヘッダを必須付与」と明記しており、rate limit 時のクライアント retry 制御が壊れる。
  Recommendation: 429 を `HttpException` 経由で許可するなら `Retry-After` の取得元を定義して `retryAfterSeconds` に詰める。取得不能な 429 は `RagApiException('RAG_RATE_LIMITED', ..., { retryAfterSeconds })` を投げる方針に寄せ、テストで HttpException 429 のヘッダ有無を固定する。
- [medium] cutover 手順が idempotency 検証済みと読めるが、参照スクリプトは replay を検証していない (docs/operations/ptp-client-cutover.md:318-330)
  §9 は `--with-query` の再実行が replay されることを期待し、チェックリストでも 1 回目/2 回目の `idempotency_replayed` を確認対象にしている。一方、参照先 `cutover-smoke-test.sh` の T6 は `200|400|404|409|422|429` を PASS とするだけで、レスポンス本文の `idempotency_replayed` を検査していない。手順通り「script が exit 0」を信じると、LLM 経路や idempotency が壊れていても cutover 完了判断に進める。
  Recommendation: `cutover-smoke-test.sh --with-query` を 200 必須かつ 2 回目で `idempotency_replayed: true` 必須に変更するか、本文で script exit 0 は疎通のみであり replay は別コマンドで機械確認すると明記する。

Next steps:
- lockfile 同期後に `npm --prefix apps/api ci --dry-run --ignore-scripts` を再実行する
- HttpException 429 の Retry-After 契約をテストで固定する
- cutover smoke の idempotency 判定をスクリプト側で機械化する
```

### Codex 指摘の quality reviewer 裁定

- **[high] lockfile 未同期** — 事実だが **新規欠陥ではなく B-2 の合意済み残存状態**。本ワークフローは SMB 規約により `npm install` 実行禁止であり、B-2 の合意済み解決策は「runbook 化（vercel-deploy.md §1.5）+ ふみさんがローカルで実行」。Codex の `npm ci --dry-run` 実証は「§1.5 を実行せずに push すると deploy 必ず失敗する」ことの確認であり、§1.5 の必要性を裏付ける。→ **コミット/push 前の §1.5 実行を必須条件** として approved に織り込む（修正要求はしない / 修正手段がエージェントに許可されていない）。
- **[medium] HttpException 429 の Retry-After 欠落** — 事実。ただし現行コードベースで 429 を投げる経路は `RagApiException('RAG_RATE_LIMITED', {retryAfterSeconds})` のみ（Codex も grep 済）で、HttpException(429) を投げる箇所は存在しない。**潜在契約ギャップ**であり現時点で動作バグではない。→ 推奨改善（別チケット可）。
- **[medium] T6 と §9 チェックリストの検証強度乖離** — 実機 grep で裏取り済（T6 は `200|400|404|409|422|429` を PASS、`idempotency_replayed` 未検査）。§9 チェックリストはオペレータの手動フィールド確認を要求しており補完されているが、§10 完了基準 L343 が「script exit 0」だけを完了条件に挙げているのは乖離。→ 推奨改善（1 行追記で解消可能）。

---

## 組織固有観点レビュー（Claude）

### チェックリスト

- [x] **UX フロー（オペレータ体験 / 障害時診断性）**: B-1 postinstall は `&&` 連結のため失敗ステップが npm エラーログで一意に特定できる（shared install / shared build / prisma generate のどこで落ちたか判別可能）。vercel-deploy.md §5-2 のビルドログ確認表が `Cannot find module '@pmtp/shared'` の症状→対処を既にカバー。§1.5 の「トラブル時」節も B-1/B-2 双方の失敗症状への動線を持つ。問題なし。
- [x] **コンプライアンス / secret 露出**: §1.5 runbook に secret 値の混入なし（lockfile に実値が含まれない旨も明記済）。B-3 のフィルタ・guard とも「ログ・例外メッセージにトークン値・ヘッダ値を一切含めない」原則を維持。401 メッセージは固定文言（ヘッダ欠落 / scheme 不正 / 不一致を区別しない）で攻撃者への情報供与なし。レスポンス body に stack trace は一切載らず、5xx の stack はサーバ側ログのみ。問題なし。
- [x] **組織独自の品質ルール**: マーケ連携機能なし（marketing-content-slop.md 非該当）。盲点 8（外部仕様の実機検証なし固定）への B-4 の訂正は規約趣旨に合致。
- [x] **独立性ルール遵守**: architecture 側レビューファイルは参照していない（自己宣言）。
- [x] **PII / API キー混入の構造的チェック**: 変更 4 ファイルに PII が流れ込む構造なし。エラーレスポンスの `meta` は trace_id / request_id / timestamp のみで個人情報なし。

### B-1: postinstall（品質観点）

- **postinstall 非実行条件での fallback**: `npm ci --ignore-scripts` 系の CI では shared build も prisma generate も走らないが、これは prisma generate 単体だった従来からの既存リスクで今回の劣化ではない。Vercel は postinstall をデフォルト実行するため deploy 経路は成立。**ただし Codex High の通り、lockfile 未同期のままでは `npm ci` が postinstall 到達前に停止する** — §1.5 実行が前提条件。
- **診断可能性**: ✅（上記チェックリスト参照）。
- 軽微: ローカル `npm install --prefix apps/api` のたびに shared の install + build が走り数秒〜数十秒のオーバーヘッド。SMB マウント上ではやや重いが、正しさ優先で妥当。

### B-2: runbook（品質観点）

- **コピペで動くか**: ✅ §1.5 の 5 コマンドはすべてリポジトリルート前提で一貫しており、プレースホルダなしでそのまま実行可能。検証ポイント 3 件（lockfile 内 resolved パス / dist 生成 / symlink）も機械確認可能な記述。
- **secret 漏洩リスク**: ✅ なし（前述）。
- **SMB 直列実行の注意書き**: ✅ あり（L41）。
- 軽微: §1.5 の「Vercel ビルド時の `npm ci`」という表現は、実際の Vercel install command の確証（npm ci か npm install か）が runbook 内に示されていないが、どちらでも §1.5 実行後は整合するため実害なし。

### B-3: ExceptionFilter（品質観点）

- **レスポンス body 形の整合**: ✅ HttpException 分岐は `normalize()` 内で `NormalizedError` に写像 → 既存の `ErrorResponse` 共通形（success / error.code / error.message / meta.trace_id / meta.request_id / meta.timestamp）で出力され、他の全エラー経路と完全に同形。spec でも meta.trace_id 保持を verify 済。
- **情報漏洩 / stack trace 露出**: ✅ 破壊なし。body に stack なし、5xx stack はサーバログのみ、guard はトークン値非含有の固定文言。
- **🟡 Medium（新規挙動変化 / 推奨改善）**: 従来は全 HttpException が「Internal server error」固定文言の 500 に丸められていたが、本修正後は **5xx 系 HttpException の message が verbatim でクライアントに流れる**。503 の「API authentication is not configured」は意図的（smoke-test 診断用 / 機微情報なし）で妥当だが、将来コードが `InternalServerErrorException(内部詳細)` を投げると詳細が露出する構造。対策案: `httpStatus >= 500` かつ既知の 503 設定不備メッセージ以外は generic message に丸める 1 分岐の追加（別チケット可 / 現行コードに該当 throw なしのため blocking ではない）。
- 🟢 Low: `mapHttpStatusToErrorCode` の 422 → `RAG_GUARDRAIL_BLOCKED` は、guardrail 以外の出所の 422 が「guardrail でブロックされた」と誤申告される語義ズレの余地。現行 422 の出所は RagApiException.guardrailBlocked のみ（そちらは第一分岐で処理）のため実害なし。
- 🟢 Low: `getResponse()` が `{ message: string[] }`（NestJS ValidationPipe 形）の場合 `String(array)` でカンマ結合される。本プロダクトは ZodValidationPipe 採用のため到達経路なし。
- **テスト**: ✅ 追加 2 spec（401 / 503）は httpStatus 透過・code 写像・message 保持・meta 保持を検証。既存 7 spec 無改変。検証担当の追加 spec（unit 6 件）で 422 / 400 / 500 / meta 必須も担保済。

### B-4: 手順書訂正（品質観点）

- **cutover 当日の事故防止に十分か**: ✅ 概ね十分。(1) 虚偽記載の削除 + 「過去ドラフトの誤りを本改訂で訂正」と訂正履歴を明示、(2) 「手順書ではなく実機の挙動が真」原則の明文化、(3) チェックリスト 5 件が手動での `idempotency_replayed` 確認 + trace_id 突合 + decision 記録まで要求 — 盲点 8 同型再発への訂正として要件を満たす。
- **🟡 Medium（推奨改善 / Codex Medium-2 と同根）**: §10 完了基準 L343 が「`cutover-smoke-test.sh` が exit 0（read-only / `--with-query` 双方）」を完了条件として残置しており、T6 が 400/404/409/422/429 でも PASS する仕様と組み合わせると「exit 0 だが LLM 経路・replay は壊れている」状態で完了判断に進める読み筋が残る。§10 に「`--with-query` は §9 チェックリスト（200 + `idempotency_replayed` 確認）併用必須」の 1 行を足すと閉じる。§9 チェックリスト自体が手動確認を要求しているため blocking ではない。
- **自己制約 4（SSRF / 外部ライブラリ DI）該当箇所**: なし。diff に undici / DNS lookup / fetch interceptor / dispatcher / SSRF 防御層の追加・変更は含まれない（B-3 は例外フィルタ、B-4 はドキュメント）。→ `n/a`。

### 構造的盲点（自己制約 1）

発火根拠: B-4 自体が盲点 8（外部仕様の実機検証なし固定）の同型再発であり、本移行ワークフローは 8 レビュー中 7 件 needs-revision の連続是正サイクル中。

追加走査の結果: 同型構造「**ドキュメントが機械検証より強い主張をする**」パターンを diff 全体で再走査した。検出 1 件 = §10 完了基準の「script exit 0」が実際の検証強度（T6 は 4xx でも PASS / replay 未検査）より強い完了保証として読める乖離（上記 B-4 Medium / Codex Medium-2 と同一根）。§9 の訂正自体は同型を正しく潰しているが、同じファイル内の §10 に弱い残滓がある、という指摘。

### claim-first ガード検証（自己制約 3）

発火根拠: diff（ptp-client-cutover.md §9）に `Idempotency-Key` / `idempotency` / replay のキーワードあり。

対照確認の結果: 本 diff のスコープに claim / INSERT / upsert / $transaction の **実装コード変更は含まれない**（§9 はサーバ側既存実装 = rag_queries 部分 UNIQUE + payload hash 照合への参照のみ / B-3 は例外フィルタで DB 書込なし）。§9 の冪等性ガード表 5 項目を `cutover-smoke-test.sh` 実体と対照した:

- ✅ read-only 既定: スクリプト既定は GET のみ（T1〜T5）、T6 は `--with-query` opt-in — 実体一致
- ✅ 安定 Idempotency-Key: `cutover-smoke-${host}-v1` 固定、タイムスタンプ非含有 — 実体一致（L249-254）
- ⚠️ サーバ側 idempotency: 表の主張は既存実装参照として正しいが、**スクリプトは replay を機械検証しない**（手動チェックリストで補完 / 上記 Medium）
- ✅ env 操作の冪等性 / bypass ローテ同期: ドキュメント記述のみ、矛盾なし

---

## 統合 verdict

**approved（条件付き）**

### 判定根拠

| 出所 | 重大度 | 内容 | 裁定 |
|---|---|---|---|
| Codex | High | lockfile 未同期で `npm ci` 停止（実証済） | **新規欠陥ではなく B-2 の合意済み残存状態**。SMB 規約で本ワークフロー内の npm install は禁止 = エージェントに修正手段がない。合意済み解決策（§1.5 runbook + ふみさんローカル実行）が成果物として存在。→ changes-requested ではなく「**コミット/push 前に §1.5 実行必須**」の条件として approved に織り込む |
| Codex | Medium | HttpException(429) 経路の Retry-After 欠落 | 現行コードに該当 throw なし（潜在契約ギャップ）→ 推奨改善 / 別チケット |
| Codex + Claude | Medium | T6 検証強度と §9/§10 の乖離 | §9 手動チェックリストで補完済 → §10 への 1 行追記を推奨改善 |
| Claude | Medium | 5xx HttpException message の verbatim 露出（新規挙動） | 現行 throw は 503 固定文言のみで機微情報なし → 推奨改善 / 別チケット |
| Claude | Low | 422 → RAG_GUARDRAIL_BLOCKED 語義ズレ / message 配列の String 化 | 到達経路なし → 任意改善 |

統合 verdict 表上は「Codex High → changes-requested」だが、当該 High は本ワークフローのスコープ定義（B-2 = 文書化で対応、install はふみさん実行）で意図的に残置された既知状態であり、これを changes-requested とするとエージェントに禁止操作（npm install）を要求することになる。よって例外裁定として approved（条件付き）とし、条件を下記に明文化する。

### approve の必須条件（eng-pm / ふみさんへ）

1. **コミット〜push の前に `docs/operations/vercel-deploy.md` §1.5 を実行し、lockfile 差分を同一コミット群に含めること**（未実施のまま deploy すると Codex 実証の通り `npm ci` で確実に失敗する）
2. §1.5 実行後に `npm --prefix apps/api ci --dry-run --ignore-scripts` が通ることを確認（Codex 推奨の機械検証）

### 推奨改善（別チケット可 / blocking ではない）

1. HttpException(429) 経路の Retry-After 契約をテストで固定（Codex Medium-1）
2. ptp-client-cutover.md §10 完了基準に「`--with-query` は §9 チェックリスト併用必須」を 1 行追記（Codex Medium-2 / Claude 同根検出）
3. ExceptionFilter で `httpStatus >= 500` の HttpException message を generic に丸める分岐（503 設定不備メッセージは許容リスト化）

---

**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（architecture）は参照していない。
