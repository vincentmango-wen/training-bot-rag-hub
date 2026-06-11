---
ticket: phase-5-ptp-client-cutover
github-pr: ""
reviewer: architecture
review-mode: parallel-agents
verdict: changes-requested
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 1
codex-error-reason: ""
self-constraint-1-applied: true    # 盲点 8 類型（実機検証なし固定）が Phase 4 arch レビュー High-2 に続き 2 連続で検出されたため発火
self-constraint-2-triggered: n/a   # 並列独立レビューのため本レビュー単独では判定不能（eng-pm が両レビュー突合時に判定）
self-constraint-3-triggered: true  # Idempotency-Key / replay / claim 系キーワード検出 → §5 ガード表対照実施
self-constraint-4-triggered: n/a   # SSRF / network egress / 外部ライブラリ DI 防御層の diff なし（curl ベース疎通スクリプトは該当外）
---

# Phase 5 architecture レビュー — PTP 側 RAG クライアント URL 切替指示書（cutover）

- 対象: `docs/operations/cutover-smoke-test.sh`（新規 291 行）/ `docs/operations/ptp-client-cutover.md`（新規 349 行）/ `README.md`（追記）/ `apps/api/src/__tests__/phase5-cutover-static.spec.ts`（新規 314 行）
- 設計書: `docs/operations/phase-5-design.md`
- レビュー方式: working tree（未コミット / commit・push はふみさん手動運用）

## 統合 verdict: changes-requested（= needs-revision）

- Codex: Critical 0 / **High 1**（T6 の 4xx 一括 PASS）→ 表ルール上 changes-requested
- Claude 組織固有観点: **High 2**（手順書 §9 の「実機検証済」虚偽記載 / RagExceptionFilter 起因で T2・T3 期待値が実機で構造的に不成立）+ Medium 1 + Low 3
- 設計の骨格（判断 1〜4 / discovery-first / read-only 既定）は健全。必須修正はいずれも局所的で、再設計は不要

---

## Codex 機械観点レビュー

起動メモ: nodenv PATH 前置（`~/.nodenv/versions/22.22.3/bin` / memory `feedback_codex_nodenv_path.md`）で正常起動。auth エラーなし（CODEX_AUTH_EXPIRED 非該当）。`main...HEAD` の branch diff は空（全変更が未コミット working tree）だったが、Codex 側が working tree diff へ自律フォールバックし Phase 5 対象ファイルをレビュー完了。

### Codex stdout（最終レビュー全文）

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

No-ship: cutover の opt-in E2E が broken route / validation drift / rate limit を PASS 扱いするため、切替確認として信用できません。

Findings:
- [high] T6 が 4xx を一括 PASS にして cutover 失敗を正常扱いする (docs/operations/cutover-smoke-test.sh:263-270)
  `--with-query` は固定 payload で `/api/v1/rag/query` の LLM 経路を確認する目的ですが、`400|404|409|422|429` をすべて PASS にしています。現行 `queryRequestSchema` は `{query, symbol}` を受理するため、400/422 は payload/schema drift、404 は route/prefix 破損、409 は安定 Idempotency-Key と payload の不整合、429 は本番 client が成功しない状態を示し得ます。これを PASS にすると cutover smoke が exit 0 になり、PTP 側の本番切替後に初めて障害化します。
  Recommendation: T6 は `200` かつ JSON success envelope（少なくとも `success:true` と `meta.trace_id`、再実行時は `idempotency_replayed:true`）のみ PASS にしてください。`400/404/409/422/429` は FAIL とし、payload を変更する場合は `idem_key` の version suffix も更新してください。

Next steps:
- T6 の status 判定を fail-closed に変更する
- phase5 static spec に T6 の PASS 許可ステータスが 200 のみに閉じていること、404/400/409/429 が FAIL になることを追加する
```

### Codex High-1 への Claude 裁定: **confirm（根本原因は設計書 §4-2 の T6 期待値）**

実装は設計書 §4-2 T6 期待値「`200` or `4xx`（401/503 でなければ PASS）」に忠実。欠陥の発生源は設計書側にある。実コード裁定の補強事実:

- T6 固定 payload `{"query":"...","symbol":"BTC/USDT"}` は `packages/shared/src/api.ts:41-55` の `queryRequestSchema`（`query` のみ必須 / `symbol` optional）に**適合する**。よって正常稼働時に 400/422 が返ることはなく、返ったら schema drift = 障害シグナル
- 409 は `IdempotencyConflictError`（filter で `RAG_IDEMPOTENCY_CONFLICT` に写像）= 「安定 key のまま payload を変更した」ガード 2 自身の破れを示す状態であり、PASS で隠蔽すると冪等性ガードの検証能力が消える
- 修正は **設計書 §4-2 T6 期待値の訂正 + スクリプト T6 分岐 + static spec の追補**の 3 点セットで行うこと（スクリプトだけ直すと設計書と実装の乖離が再発する）

---

## 組織固有観点レビュー（Claude）

### チェックリスト

- [x] **pre-merge gate**: n/a — 本リポは PR レス運用（commit / push / gh 操作はふみさん手動）。代替ゲートとして「ふみさん commit 前に下記 必須修正 1〜3 の解消」を条件として提示
- [x] **独立性ルール**: quality レビュー（`phase-5-review-quality.md`）は未参照。本レビューは architecture 観点のみで独立作成
- [ ] **設計書と成果物の事実整合（盲点 8 類型）**: ❌ 手順書 §9 が未実施の実機検証を「実機検証された動作です」と断定記載（High-A）
- [ ] **クロスフェーズ契約整合**: ❌ スクリプト T2/T3 の期待値 401 + JSON は、現行 `RagExceptionFilter` 実装では構造的に成立しない（High-B）
- [x] **PTP リポ非アクセス制約**: ✅ 手順書 §0 で明示 / §2 discovery grep 必須化 / env 変数名は「既存名流用優先 + 推奨名提示」に留め推測断定なし — 設計意図通り。グローバル CLAUDE.md §1「推測で決めない」とも整合
- [x] **保守性・YAGNI**: ✅ 判断 1（env 1 本切替 / コード分岐・proxy 不採用）、判断 4（bash + curl のみ / jq 不採用）は新規運用物・新規依存ゼロで切り戻し最速。候補比較と却下理由が明確。「値が空ならヘッダ付与しない」構造（手順書 §4-2）により切り戻しが env 操作のみで完結する設計は秀逸
- [x] **ダブルロック要件維持**: ✅ 判断 2 通り bypass ヘッダ常時付与で Standard Protection を維持。手順書に「Protection 無効化」へ誘導する記述なし（B 案は設計書内で明示的に不採用）。T1 の「200 = FAIL」が外側ロック消失を検出する設計も正しい
- [x] **スクリプトの責務閉じ**: ✅ 疎通判定のみ。deploy 操作・env 書換・DB 書込（既定モード）の副作用なし。T1〜T5 は GET のみ、POST は `WITH_QUERY` ブロック内に閉じることを実コードで確認（cutover-smoke-test.sh:248-279）
- [x] **IF 契約 30 整合**: ✅ パス・Idempotency-Key・timeout 10 秒・フォールバック 2 択を「変更しない」と手順書 §0 / §4-4 で明記。JWT→静的トークン差異（§0）/ Base URL 乖離（付記残課題）も注記済
- [x] **テスタビリティ**: ✅ static spec は phase 1〜4 と同スタイルで一貫。negative control（T1 で 200→FAIL の存在検証）を含む

### 設計通り正しく実装されている点（確認済）

1. **T4 の `"status":"ok"` grep**: `health.controller.ts` は `{status:'ok', service:'...'}` を返し、NestJS の JSON 直列化（スペースなし）と grep パターンが一致 ✅
2. **T5 `GET /api/v1/rag/history?limit=1`**: `rag-history.controller.ts` に GET 実装あり / `historyQuerySchema` が `limit` を coerce / `@RequesterId()` は静的トークン構成でも固定 dev requester にフォールバック（`request-context.ts`）→ 200 期待は成立 ✅
3. **T6 固定 payload の schema 適合**: `queryRequestSchema`（query 必須 / symbol optional）に適合 ✅（→ だからこそ 4xx は障害シグナル / Codex High-1）
4. **secret 非出力構造**: env チェックは変数名のみ出力 / record() は status と body 種別のみ / `set -x` 不在 / mktemp + trap EXIT INT TERM ✅
5. **BASE_URL 末尾スラッシュ正規化**（`${BASE_URL%/}`）: パス二重スラッシュ事故の予防 ✅

### claim-first ガード検証（自己制約 3）

設計書 §5 冪等性ガード表（4 項目）と成果物の対照:

| # | ガード | 対照結果 |
|---|---|---|
| 1 | read-only 既定 | ✅ T1〜T5 は GET のみ / POST は `if [ "$WITH_QUERY" = "1" ]` 内に閉じる（実コード確認） |
| 2 | 安定 Idempotency-Key | ✅ `cutover-smoke-${host_part}-v1` / `date` 系コマンド非含有（実コード確認）。⚠️ ただし payload と key version の結合規律（payload 変更時の `-v1` 更新義務）がスクリプトコメント・手順書のどちらにも書かれておらず、破った場合の 409 を T6 が PASS で隠蔽する（Codex High-1 と同根） |
| 3 | サーバ側 idempotency + **実機確認してから手順書に記載** | ❌ **違反**（High-A）。実機確認は未実施のまま手順書 §9 が「実機検証された動作です」と記載 |
| 4 | 手順書の再実行安全性記載 | ✅ §3 / §7-1 / §7-5 / §9 に記載あり |

### 構造的盲点（自己制約 1）

盲点 8（外部仕様・既存実装の実機検証なし固定）が **Phase 4 arch レビュー High-2（externalId セマンティクスの希望的固定）に続き 2 フェーズ連続**で検出された（本レビュー High-A）。3 件目が出たら本リポにも「実機検証ログ（コマンド + 出力）を完了報告に必須添付」の規律をフェーズ共通ゲートとして固定することを eng-pm に推奨する。

---

## 必須修正（High）

### High-A（Claude 独自）: 手順書 §9 の「実機検証された動作です」は虚偽記載 — 設計書 §5 ガード 3 の記載順序義務に違反

- **事実**: `ptp-client-cutover.md:318` は「これは事前にローカル docker + Stub provider 構成で実機検証された動作です（設計書 §5 ガード 3）」と断定。一方、実装完了報告自身が「ローカル docker / Vercel 実機への実走は本フェーズスコープ外」「実行は cutover 実施時にふみさんが手順として実施」と明記しており、検証は行われていない
- **なぜ問題か**: 設計書 §5 ガード 3 は「**実装フェーズで T6 を 2 連続実行し `idempotency_replayed: true` を実機確認してから手順書に記載する**（盲点 8 対策）」と記載順序まで義務化している。その義務に直接違反した上、読者（ふみさん）は「検証済」を信じて `--with-query` の再実行 = 再課金なしを前提に行動する。replay が実際に機能しなければ静かな再課金が発生する
- **どう直すか**（いずれか）:
  - **案 a（推奨）**: 実装担当がローカル docker + Stub provider で T6 相当を 2 連続実行し、`idempotency_replayed: true` の実機ログ（コマンド + 出力）を完了報告に添付してから現記載を維持
  - **案 b**: §9 の当該文を「cutover 実施時に `--with-query` を 2 連続実行し、2 回目のレスポンスで replay されること（`idempotency_replayed: true`）を確認すること」という**指示形**に書き換え、検証済との主張を撤回

### High-B（Claude 独自 / クロスフェーズ整合）: 現行 `RagExceptionFilter` では T2・T3 の期待値 401 + JSON が実機で構造的に不成立 — 手順書 §8 判別表が誤診断へ誘導

- **事実**（実コード裁定）: `rag.module.ts:46` で `RagExceptionFilter` が `APP_FILTER` 登録（= グローバル / `/health` 含む全ルートに適用）。filter は `@Catch()` 全捕捉だが `normalize()`（rag-exception.filter.ts:84-139）は `RagApiException` / `ZodError` / `IdempotencyConflictError` / `ProviderError` のみ処理し、NestJS `HttpException` 分岐が**ない**。`BearerTokenGuard` の `UnauthorizedException`（401）と `ServiceUnavailableException`（503）はフォールスルーで `RAG_INTERNAL_ERROR`（**500**）に潰される。401/503 の HTTP 経路テスト（guard→filter→response の統合）は存在しない（guard spec は canActivate 単体のみ）
- **なぜ問題か**:
  1. 実機（Vercel / ローカル docker いずれも）で T2・T3 は 401 でなく 500 を受け取り **FAIL** → 手順書 §10 完了基準「cutover-smoke-test.sh が exit 0」が現実装では達成不能
  2. 手順書 §8 判別表は `500` を「bootstrap 失敗（DB / Prisma / OpenAI 初期化エラー）」に対応付けており、実際は Bearer 不一致 / env 不備でも 500 が返るため、cutover 実施者を**初期化エラーの調査へ誤誘導**する
  3. 本欠陥は Phase 3 スコープの既存問題（Phase 4 arch レビューで eng-pm 転送済）だが、Phase 5 はその欠陥挙動の上に期待値を構築しているため、**Phase 5 成果物の受け入れ条件として顕在化**した
- **どう直すか**（いずれかを eng-pm 裁定）:
  - **案 a（推奨）**: Phase 3 系 hot-fix（`normalize()` に `HttpException` 分岐を追加し `getStatus()` を保持）を **cutover の前提条件**として先行修正 + guard→filter 統合テスト追加。スクリプト・手順書は無変更で正となる
  - **案 b（暫定）**: 手順書 §0 前提に「既知問題: filter 修正（Phase 3 系チケット）完了まで T2/T3 は 500 で FAIL する」を明記し、§8 判別表の 500 行に「Bearer 不一致 / env 不備でも 500 になる既知バグあり」を注記。ただし誤診断リスクが残るため案 a を強く推奨

### High-C（= Codex High-1 / confirm 済）: T6 の 4xx 一括 PASS を fail-closed 化

- 上記「Codex High-1 への Claude 裁定」参照。**設計書 §4-2 T6 期待値の訂正 + スクリプト分岐修正 + static spec 追補**の 3 点セットで修正すること
- 修正時は High-B との整合に注意: filter 修正前は 401/503 も 500 として現れるため、T6 の FAIL 分岐は「200 + success envelope 以外はすべて FAIL」に単純化するのが安全

---

## 推奨改善（任意 / Medium・Low）

### Medium-1: README diff に Phase 4 スコープの「## Ingestion」セクションが混入 — 帰属の裁定が必要

`git diff README.md` の +34 行は「## Ingestion（ローカル CLI 経由）」（Phase 4 スコープ / Phase 4 レビューの対象ファイル一覧に README は不在）と「## PTP 側切替（cutover）」の **2 セクション**を含む。Phase 5 実装報告は「README +34 行 / cutover セクションのみ挿入」と主張しており、報告と diff 実体が不一致（cutover セクション単独は約 18 行）。pre-merge gate Step B（スコープ外混入検出）の同型。eng-pm が「Phase 4 成果物の commit 漏れが同居しているだけ」か「Phase 5 が束ねて追加した」かを裁定し、束ね修正なら理由を記録、PSP の code-volume も実体に合わせて補正すること。

### Low-1: `do_curl` の `|| echo "000"` は二重出力になり `000)` 分岐が事実上 dead code

curl は接続失敗時も `-w "%{http_code}"` により自ら `000` を stdout に出力してから非 0 exit するため、`|| echo "000"` が追記されて status は `000000` になる。結果、各テストの `000)` 分岐（「curl 失敗」と診断表示する分岐）には到達せず `*)` の「unexpected status」に落ちる。**fail-closed は維持される**（FAIL になる）ため動作上の危険はないが、診断メッセージが不正確 + 到達不能分岐の温存（盲点 7 の親戚 = 期待した分岐に到達しない構造）。`|| true` に変えて curl 自身の `000` を採用するか、`case` に `000*)` を足すのが小修正。

### Low-2: `-h|--help` の `sed -n '2,40p' "$0"` がヘッダコメント行数にハードコード結合

冒頭コメントを増減すると help 出力が黙って切れる / コードが混入する。`awk '/^[^#]/{exit} NR>1{print}'` 等の「最初の非コメント行まで」方式にすると保守結合が消える。

### Low-3: T1 の正常系ステータスに `308` が含まれない

`30[1237]` は 301/302/303/307 のみ。Vercel はリダイレクトに 308 を使うことがあり、その場合 T1 が偽 FAIL する。`30[12378]` への 1 文字修正を推奨。

---

## 統合 verdict の根拠

| 入力 | 結果 |
|---|---|
| Codex | Critical 0 / High 1（T6 4xx 一括 PASS → confirm 済） |
| Claude 独自 | High 2（§9 虚偽記載 / filter 起因の T2・T3 不成立）+ Medium 1 + Low 3 |
| 統合表 | High あり → **changes-requested** |

必須修正 3 件（High-A / High-B / High-C）の解消後、再レビューは差分確認のみで足りる見込み（設計骨格の変更は不要）。

---
**独立性の補足**: 本レビューは architecture 観点のみで作成し、もう一方のレビュー（`phase-5-review-quality.md`）は参照していない。
