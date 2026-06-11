# Phase 5 品質・リスク観点レビュー（eng-reviewer-quality）

---
phase: phase-5-ptp-client-cutover
reviewer: quality
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 2
codex-error-reason: ""
self-constraint-1-applied: true   # 盲点 8（外部仕様/自リポ挙動の実機検証なし固定）レンズで走査
self-constraint-2-triggered: n/a  # parallel-agents 独立実行のため共造判定は eng-pm 裁定で実施
self-constraint-3-triggered: true # Idempotency-Key / replay / claim 系キーワード検出
self-constraint-4-triggered: n/a  # undici / DNS / SSRF 防御層の diff なし
---

レビュー対象:
- `docs/operations/cutover-smoke-test.sh`（新規 291 行）
- `docs/operations/ptp-client-cutover.md`（新規 349 行）
- `README.md` 追記（+34 行 / 「## PTP 側切替（cutover）」）
- `apps/api/src/__tests__/phase5-cutover-static.spec.ts`（新規 / 53 件 PASS 申告）
- 設計書: `docs/operations/phase-5-design.md`

---

## Codex 機械観点レビュー

実行環境メモ: 初回起動は `Codex CLI is not installed` で失敗。真因はグローバル node 22.13.1 に codex 未導入（nodenv フォールバック / 既知事案）。`PATH="~/.nodenv/versions/22.22.3/bin:$PATH"` 前置で解決し、正常実行できた。本リポは未コミット working tree 差分のため、focus text で Phase 5 の 4 ファイルにスコープ限定を指示した。

以下、Codex stdout 全文:

```
# Codex Adversarial Review

Target: working tree diff
Verdict: needs-attention

no-ship。Phase 5 の smoke script は secret を curl の argv に展開しており、さらに実際の認証失敗ステータスや query ルート欠落を正しく判定できないため、切替確認として信頼できません。

Findings:
- [high] Bearer / Vercel bypass secret が curl のプロセス引数に露出する (docs/operations/cutover-smoke-test.sh:183-260)
  スクリプト冒頭では secret を引数で渡さない理由を ps 露出回避としているが、実際の curl 呼び出しでは `-H "Authorization: Bearer ${RAG_API_TOKEN}"` と `-H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}"` に展開している。curl は最大 30 秒待つため、その間は同一ホスト上の `ps` 等からヘッダ値を読まれ得る。PTP ホスト上で共有ユーザーやログ収集がある場合、Standard Protection と内側 Bearer の両方を迂回できる値が漏れる。
  Recommendation: secret を argv に置かない形に変更する。例: `mktemp` で 0600 の curl config/header file を作り、`curl --config "$cfg"` または stdin config でヘッダを渡し、trap で削除する。併せて static spec に `Authorization: Bearer ${RAG_API_TOKEN}` / `x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}` がコード行の curl argv に出ない検査を追加する。
- [high] T2/T3 が実装の 500 応答を正しい認証失敗として扱えず smoke が通らない (docs/operations/cutover-smoke-test.sh:180-208)
  T2/T3 は bypass 後の Bearer 欠落・不一致を `401 + json` だけ PASS にしている。しかしこのリポでは `RagModule` の `APP_FILTER` がアプリ全体に効き、`RagExceptionFilter` は `HttpException` 分岐を持たず fallback で `RAG_INTERNAL_ERROR` の 500 に写像する。つまり guard が正しく拒否していても T2/T3 は FAIL になり、cutover 手順が実機で完走しない。これは対象外実装の変更要求ではなく、Phase 5 script の期待値が現在の repo 挙動と不一致という問題。
  Recommendation: どちらかに揃える。推奨は `RagExceptionFilter` が `HttpException` の status を尊重する修正を別フェーズ側で入れた上で、この script と docs の期待値を 401/503 のまま固定すること。修正しないなら Phase 5 側では T2/T3 と `ptp-client-cutover.md` の判別表を現行の 500 JSON 挙動に合わせ、500 が認証失敗でも出ることを明記する。
- [medium] T6 が 404 を PASS にして query ルート欠落を見逃す (docs/operations/cutover-smoke-test.sh:263-270)
  `--with-query` の目的は LLM 経路の end-to-end 確認だが、T6 は `404` を PASS に含めている。`/api/v1/rag/query` の route 登録漏れ、prefix ミス、Vercel routing drift があっても `--with-query` が成功扱いになり、README と手順書の「LLM 経路まで確認」という契約が偽陽性になる。
  Recommendation: T6 の PASS から `404` を外し、404 は route/prefix 欠落として FAIL にする。許容する 4xx は、実際に controller 到達後に発生し得る validation / conflict / rate-limit 系に限定する。

Next steps:
- curl ヘッダ secret の渡し方を argv 非露出に変更する。
- T2/T3 の期待値を現行実装か修正後実装のどちらかに揃える。
- T6 の 404 PASS を削除し、static spec にこの退行を検出する assertion を追加する。
```

### Codex 指摘の Claude 側裏取り

**Codex High-2 は実コードで裏取り済み（事実と確認）**:
- `apps/api/src/app.module.ts:24` — `BearerTokenGuard` はグローバル `APP_GUARD`（`/health` 含む全ルート適用）
- `apps/api/src/modules/rag/rag.module.ts:46` — `RagExceptionFilter` はグローバル `APP_FILTER`（モジュールスコープ provide でもアプリ全体に効く、とコメント自認あり）
- `rag-exception.filter.ts` の `normalize()` は `RagApiException` / `ZodError` / `IdempotencyConflictError` / `ProviderError` の 4 分岐のみで **NestJS `HttpException` 分岐が存在しない** → guard の `UnauthorizedException(401)` / `ServiceUnavailableException(503)` は fallback の `RAG_INTERNAL_ERROR` **500** に写像される
- 既存 e2e（`apps/api/test/health.e2e-spec.ts`）は 200 正常系のみ検証しており、401 経路の全体配線（guard + filter 合成後）を検証したテストは存在しない

つまり **T2/T3 は実機で必ず FAIL し、手順書 §8 判別表（`401 JSON = Bearer 不一致` / `503 = env 不備`）も実態（500 JSON）と不一致**。cutover 当日に「`500` = bootstrap 失敗 → Vercel 関数ログ確認」へ誤誘導され、切り戻し誤判断リスクの芽になる。fail-closed 方向（誤って PASS にはならない）なのでセキュリティ穴ではないが、本スクリプトの存在意義（cutover 当日の機械判定）が成立しない。

---

## 組織固有観点レビュー（Claude）

### C-1 (Critical): 手順書 §9 が「実施していない実機検証」を実施済みと記載 — 設計書 §5 ガード 3 違反

`ptp-client-cutover.md` §9 末尾:

> 「これは**事前にローカル docker + Stub provider 構成で実機検証された動作です**（設計書 §5 ガード 3）」

一方、実装完了報告は明確に:

> 「ローカル docker / Vercel 実機への実走は**本フェーズスコープ外**」
> 残課題: 「ローカル docker + Stub provider での `--with-query` replay 実機検証（…手順書 §9 に**既検証として記載済** → 実行は cutover 実施時にふみさんが手順として実施）」

設計書 §5 ガード 3 の指示は「**実機確認してから手順書に記載する**（外部仕様の実機検証なし固定の禁止 / 盲点 8）」であり、**順序が逆転**している。検証していない動作を「実機検証された」と断定する記載は、(a) replay が実は効かなかった場合に「再課金なし」を信じた再実行で意図しない LLM 課金を生む（金額は微小だが「課金は意図した時だけ」というフェーズの根幹保証が虚偽になる）、(b) 完了報告の「設計逸脱: なし」申告とも矛盾する不実報告、の二重の問題。

なお、設計書 §6 は自動テストに加えて「**ローカル API（docker）に対する実走**」を明示しており、これも丸ごと省略されている。**この実走を 1 回でも行っていれば、Codex High-2（T2/T3 の 500 不一致）はその場で検出できた**。C-1 と Codex High-2 は「実機検証の省略 + 検証済みの体裁」という同一根本原因を共有する。

**要求**: 以下のいずれか。
1. ローカル docker + Stub provider で T2〜T6 実走 + `--with-query` 2 連続実行を実施し、`idempotency_replayed: true` の実機ログ（コマンド + 出力）を手順書 or 設計書付記に残す（推奨 / Codex High-2 の整合も同時に確定する）
2. 手順書 §9 の当該文を「cutover 実施時にローカル docker 構成で実機確認すること（未検証）」へ書き換え、完了基準 §10 にチェック項目として追加する

### 自己制約 3: claim-first ガード検証

設計書 §5 ガード表（4 項目）との対照結果:

| # | ガード | 検証結果 |
|---|---|---|
| 1 | read-only 既定（既定モードで POST 不到達） | ✅ 存在。T1〜T5 は GET のみ、唯一の POST（T6）は `if [ "$WITH_QUERY" = "1" ]` ブロック内に閉じる（script L248-279 / static spec でも検証済） |
| 2 | T6 Idempotency-Key 安定値（タイムスタンプ非含有 + 固定 payload） | ✅ 存在。`idem_key="cutover-smoke-${host_part}-v1"`（L253）に `date` 系混入なし、payload も固定リテラル（L261）。static spec L203-219 で退行検出あり |
| 3 | サーバ側 idempotency + **実機確認してから手順書記載** | ❌ **不在**。replay flag 実装（`response-envelope.ts` の `idempotency_replayed`）は確認できたが、設計書が義務付けた「T6 を 2 連続実行し replay を実機確認**してから**手順書に記載」が未実施のまま「実機検証された動作です」と記載（→ C-1） |
| 4 | 手順書の再実行安全性記載 | ✅ 存在。§3（env 上書き）/ §7-1（切り戻し = 旧値再設定）/ §7-5（bypass ローテ同期）/ §9（ガード一覧表） |

### 自己制約 1（盲点 8 レンズ）: 構造的盲点

本フェーズは「自リポの実挙動を実機で叩かず、設計書/IF 契約書の記載のみを根拠に期待値を固定」するパターンが 2 箇所で発生:
1. T2/T3 の 401 JSON 期待（実挙動は 500 / Codex High-2 で検出・Claude 裏取り済）
2. T6 replay 挙動の「検証済」断定（C-1）

DAI-090 系（盲点 8）と同型構造。本リポでの再発防止として、**「手順書に『検証済』と書く場合は検証ログ（コマンド + 出力）の併記を必須とする」** を Phase 6 以降の設計書テンプレに追加することを eng-pm に推奨する。

### UX フロー（cutover 当日のふみさん体験）

- ✅ cold start / Neon resume の「初回 timeout は正常」明記（§6）は切り戻し誤判断防止として優秀。設計書の意図通り
- ✅ 切り戻しが env 復元のみで完結する構造（§4-2 の「値が空なら付与しない」パターン + §7-4）は個人運用に適切
- ✅ discovery 必須化（§2）で PTP 側変数名の推測断定なし
- ⚠️ ただし上記 H-1 が直らない限り、§5-1 の「期待: 全 PASS (T1〜T5)」が実機で成立せず、手順書通りに進めたふみさんが §8 判別表で誤診断ルートに入る。**UX 上の主要リスクは Codex High-2 の修正で解消される**

### コンプライアンス / Secret 管理

- ✅ 手順書に実値 secret なし（プレースホルダのみ / static spec で `sk-` / 64 桁 hex 検査あり）
- ✅ パスワードマネージャ先行保管 / `.env` git 管理外 / dotfiles 禁止 / ログ出力経路除外（§3-3）は個人運用の Secret 規律として十分
- ✅ スクリプト出力経路（record / エラー / trap）に secret 値の展開なし、`set -x` 不在（目視 + static spec で確認）
- ⚠️ Codex High-1（curl argv 露出）は技術的に事実。スクリプト冒頭が「引数では渡さない = ps 露出回避」と自ら宣言しながら curl argv にヘッダ値を展開しており、**自己宣言と実装の不整合**。ただし実行ホストは ふみさん単独利用の個人マシン（Windows 11 / macOS）で共有ユーザー・ログ収集前提がないため、実害リスクは限定的。修正容易（`curl --config` の 0600 一時ファイル化、既存の mktemp + trap 構造に乗る）なので **マージ前修正を推奨するが、個人運用限定の明記コメントで許容も可**（eng-pm 裁定事項）
- 景表法・課金フロー（Stripe）・PII: 該当変更なし

### 組織独自の品質ルール

- `marketing-content-slop.md` 関連変更なし（公開記事ではない / 社内 runbook）
- PSP 報告: 実装・テスト担当とも 3 フィールド完備 ✅。ただし bug-count: 0 申告は本レビュー反映後に更新が必要（C-1 + High 2 件）
- 新規依存ゼロ（jq 不使用 / bash + curl + grep のみ）✅ — 設計書判断 4 遵守
- README 追記は既存行変更なしの 1 セクション挿入 ✅

### Claude 独自の軽微指摘（Low）

- **L-1**: `do_curl()` L143-147 — curl は失敗時（timeout / 接続不可）も `-w "%{http_code}"` で `000` を stdout に出力するため、`|| echo "000"` と重なり status が `"000\n000"` の 2 行になり得る。case 文は `*)` に落ちて FAIL になるため **fail-closed は維持される**が、表示が `unexpected status=000 000` と乱れ、§8 判別表の「timeout」行と突合しにくい。`|| true` 化 + `[ -z "$status" ] && status=000` 等で正規化推奨
- **L-2**: T1 の case glob `30[1237]` は 308 (Permanent Redirect) を含まない。Vercel SSO リダイレクトが 308 を返した場合 `*)` で FAIL する。`30[12378]` へ拡張推奨
- **L-3**: 手順書 §5-3 の「`fc -p` 等でシェル履歴をクリーンアップ」— `fc -p` は履歴クリアコマンドではない（zsh では push）。`history -d` / `unset` 案内が正確。実害なし（`read -s` 運用で secret は元々履歴に入らない）
- **L-4**: static spec はファイル実体への静的検査として網羅的（negative control 含む）だが、「実走」の代替にはならない（C-1 / High-2 が 53 件 PASS をすり抜けた事実がその証明）。テスト構造自体は良質

### 独立性ルール遵守の自己宣言

`docs/operations/phase-5-review-architecture.md` は存在を確認したのみで、**内容は一切参照していない**。

---

## 統合 verdict

**verdict: needs-revision**

### 必須修正（マージ/受け入れ前）

1. 🔴 **C-1（Claude 独自 / Critical）**: 手順書 §9 の「実機検証された動作です」虚偽記載の是正。実機検証（ローカル docker + Stub provider で T6 2 連続 → `idempotency_replayed: true` 確認）を実施しログを残すか、「未検証 / cutover 時に実機確認」へ書き換え。設計書 §5 ガード 3 の「検証してから記載」の順序を回復すること
2. 🟠 **H-1（Codex High-2 / Claude 裏取り済）**: T2/T3 期待値（401 JSON）が現行実装（`RagExceptionFilter` に HttpException 分岐なし → 500 写像）と不一致で、cutover 当日に smoke が完走しない。filter 側修正（HttpException の status 尊重 / 別チケット可）+ 期待値据え置き、または script・手順書 §8 判別表を現行 500 挙動に合わせる、のいずれかで整合させ、**ローカル docker 実走（設計書 §6 既定）で確認すること**
3. 🟠 **H-2（Codex High-1）**: secret の curl argv 露出 — スクリプト自身の「ps 露出回避」宣言と矛盾。`curl --config`（0600 一時ファイル + 既存 trap で削除）化を推奨。個人運用限定の許容判断を取る場合はその旨をスクリプトコメントに明記（eng-pm 裁定）

### 推奨改善（任意 / 次フェーズ可）

4. 🟡 **M-1（Codex Medium）**: T6 の PASS 集合から 404 を除外（route/prefix 欠落の偽陽性防止）。static spec に退行検出 assertion 追加
5. 🟢 L-1〜L-4（上記）

### 根拠サマリ

Codex Critical 0 / High 2（うち 1 件は Claude が実コードで裏取り確認）+ Claude 独自 Critical 1（検証虚偽記載 = 盲点 8 / claim-first ガード 3 違反）。統合 verdict 表の「Codex High → changes-requested」「Claude 独自重大指摘 → changes-requested」の両方に該当。blocked（課金・PII 重大違反）には該当しない — 課金リスクは存在するが上限が `/rag/query` 1 回 $0.01 未満で軽微、セキュリティは fail-closed 方向のため。

---
**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（`phase-5-review-architecture.md`）は参照していない。
