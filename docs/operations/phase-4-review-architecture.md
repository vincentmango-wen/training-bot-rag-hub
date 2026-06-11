---
ticket: phase-4-rag-ingestion-cli
github-pr: ""
reviewer: architecture
review-mode: parallel-agents
verdict: changes-requested
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 2
codex-error-reason: ""
self-constraint-1-applied: false   # 本リポに直近 3 件以内の同型 hot-fix 履歴なし
self-constraint-2-triggered: n/a   # 並列独立レビューのため本レビュー単独では判定不能（eng-pm が両レビュー突合時に判定）
self-constraint-3-triggered: true  # claim / idempotencyKey / upsert / status 機械 キーワード検出
self-constraint-4-triggered: n/a   # SSRF / network egress / 外部 DI 防御層の diff なし
---

# Phase 4 architecture レビュー — RAG ingestion CLI 分離

- 対象: `apps/api/scripts/ingest/{index,chunker,embedder}.ts` / `apps/api/scripts/tsconfig.json` / `docs/operations/ingestion-runbook.md` / `package.json` ×2 / `apps/api/tsconfig.spec.json` / テスト 3 ファイル
- 設計書: `docs/operations/phase-4-design.md`
- レビュー方式: working tree（未コミット / commit・push はふみさん手動運用）

## 統合 verdict: changes-requested

- Codex: Critical 0 / **High 2** / Medium 1 → 表ルール上 changes-requested
- Claude 組織固有観点: **High 1**（live モード実行前提の欠落）+ Medium 3 + Low 2
- うち Codex High-2（再取込時の旧文書残置）は Claude 側で実コード裁定し **confirm**（推論ではなく事実）

---

## Codex 機械観点レビュー

起動メモ: 初回起動は「Codex CLI is not installed」誤判定（nodenv フォールバック / `.node-version` 不在のため codex 不在版 node に解決）。memory `feedback_codex_nodenv_path.md` 通り PATH 前置（`~/.nodenv/versions/22.22.3/bin`）で解消。auth 起因ではない（CODEX_AUTH_EXPIRED 非該当）。

### Codex stdout 全文（正規実行 / Phase 4 スコープ指定）

```
# Codex Adversarial Review

Target: branch diff against main
Verdict: needs-attention

no-ship。指定 CLI は現状 `--dry-run` ですら起動できず、起動後も再取込時に古い文書を残す設計リスクがある。

Findings:
- [high] CLI が実行時に @pmtp/shared を解決できず起動しない (apps/api/package.json:12)
  `apps/api/package.json` の `ingest` は `ts-node/register/transpile-only` だけで `scripts/ingest/index.ts` を実行するが、実際に `npm run ingest -- docs/operations/ingestion-runbook.md --dry-run` を実行すると `Cannot find module '@pmtp/shared'` で index.ts:36 の import 前に落ちた。`typecheck:scripts` は通るため、型検査では検出できない実行時 module resolution 破綻。これでは dry-run も live ingestion も出荷できない。
  Recommendation: CLI 起動経路で `@pmtp/shared` が確実に解決されるように package-lock / install 構成を更新するか、`tsconfig-paths/register` 等を含めて実行時解決を揃える。加えて `npm run ingest -- <既存md> --dry-run` の smoke test を追加する。
- [high] 編集済みファイルの再取込で旧文書が active のまま残る (apps/api/scripts/ingest/chunker.ts:101-110)
  `buildItems` はファイルの相対パスを `externalId` として渡すが、CLI 側には同じ `externalId` の既存 document を置換・削除する処理がない。下流の `IngestionService` は document を `sourceId + contentHash` で探すため、同じファイルを編集して再取込すると idempotency key は変わり、新 contentHash の新 document が作られる一方で旧 contentHash の document/chunk は active のまま残る、という推論になる。RAG 検索で古い内容と新しい内容が同時にヒットするデータ汚染リスクがある。
  Recommendation: CLI ingestion では `(sourceId, externalId)` を文書の置換キーとして扱い、同じ externalId の旧 document/chunk/embedding を transaction 内で deleted/置換してから新内容を保存する。少なくとも「同一ファイルを編集して再実行しても active document が 1 件だけ残る」テストを追加する。
- [medium] root の ingest script と相対パス解決の基準がずれている (apps/api/scripts/ingest/chunker.ts:41-43)
  root の `ingest` は `npm --prefix apps/api run ingest --` で apps/api 側 script を起動する。一方 `collectFiles` は受け取った path をそのまま `resolve(p)` しており、実行 cwd 基準で解決する。npm prefix 実行では `scripts/ingest/index.ts` が apps/api 配下として解決されているため、runbook の `npm run ingest -- ./docs/strategy...` のような root 相対パスは apps/api 相対として扱われ、モジュール解決を直しても `ENOENT` になる可能性が高い。
  Recommendation: CLI の path 解決基準を `process.env.INIT_CWD ?? process.cwd()` に固定する、または root script / runbook を apps/api 相対か絶対パス前提に揃える。root から `docs/...` を渡すケースをテストに入れる。

Next steps:
- まず CLI の runtime module resolution を直し、`npm run ingest -- docs/operations/ingestion-runbook.md --dry-run` が成功することを確認する。
- 次に root 相対パスの解決基準と externalId ベースの再取込置換セマンティクスを明文化し、回帰テストを追加する。
```

### Codex 初回実行（フォーカス誤指定）からの補足転記

初回起動時に focus text が `--help` として解釈され working tree 全体（Phase 2/3 含む）がレビューされた。Phase 4 スコープ外だが eng-pm へ転送すべき指摘 2 件:

1. **[high / Phase 3 スコープ]** `RagExceptionFilter`（`@Catch()` 全例外捕捉）が `HttpException` を尊重せず、Bearer 認証の 401/503 を 500 に潰す。smoke-test の 401/503 判別手順が機能しない。→ Phase 3 系チケットで `getStatus()` 保持分岐を追加すべき
2. **[high / Phase 2 スコープ]** fresh Vercel build で `packages/shared/dist` の生成経路がない（`.gitignore` 対象 + `postinstall` は `prisma generate` のみ）→ Vercel 上で `@pmtp/shared` MODULE_NOT_FOUND の可能性。→ Phase 2 系チケットで build 経路に shared build を組み込むべき

---

## 組織固有観点レビュー（Claude）

### チェックリスト

- [x] **pre-merge gate**: n/a — 本リポは PR レス運用（commit / push / gh 操作はふみさん手動）。HEAD SHA 突合・CI 確認は適用外。代替として「merge（= ふみさん commit）前に下記 必須修正 1〜3 の解消 + dry-run smoke 実走」をゲート条件として提示
- [x] **独立性ルール**: quality レビュー（`phase-4-review-quality.md`）は未参照。本レビューは architecture 観点のみで独立作成
- [ ] **設計書と実装事実の整合（D### 同型 / 盲点 8 類型）**: ❌ 重大不一致あり（下記 High-2）。設計書 §4-2 が「externalId = 再取込時の document 対応付けキー」と主張するが、`ingestion.service.ts:261-262` の document 照合は `{sourceId, contentHash, deletedAt: null}` のみで externalId を一切使わない。「既存実装の仕様を実機（実コード）検証なしに希望的に固定」した盲点 8 同型
- [x] **保守性・YAGNI・責務分離**: 候補 A（既存 IngestionService 再利用）採用は妥当。B/C 却下理由（二重実装ドリフト）は組織のSSoT哲学と整合 ✅
- [x] **enum SSoT**: `MVP_SOURCE_TYPES` を `@pmtp/shared` から import、リテラル再宣言なし、`as never` / `as unknown as` なし（`as MvpSourceType` は `includes` ガード後の narrowing で許容パターン）✅
- [x] **変更範囲の限定**: サーバ側既存ファイル（`ingestion.module.ts` / `providers.module.ts`）は無変更。factory は共用化せず CLI 側に fail-fast 版を新設 — 設計書 §4-3 が明示許容した選択肢で、lazy-fail / fail-fast のセマンティクス差があるため複製が正当 ✅
- [x] **テスタビリティ**: chunker.ts を fs のみ依存の純関数群に分離し実 fs I/O でテスト — 良い構造 ✅（ただし static spec の文字列マッチに偽パスあり / Medium-1）

### 設計通り正しく実装されている点（確認済）

1. **DIRECT_URL → DATABASE_URL 上書きの副作用順序**: 静的 import は `node:util` / `node:crypto` / `@pmtp/shared` のみ（Prisma 非含有）、Prisma 系は全て動的 import。さらに PrismaClient の env 解決はインスタンス化時（createApplicationContext 後）のため二重に安全。設計 §3 判断 3 準拠 ✅
2. **EMBEDDING_PROVIDER 単一束縛**: `IngestionService` の constructor 依存は `PrismaService` + `@Inject(EMBEDDING_PROVIDER)` の 2 つのみと実コードで確認。`IngestCliModule` の providers でグラフ完結。`ProvidersModule`（配列 export / `providers.module.ts:66,83`）非 import で token 衝突回避 ✅
3. **RagSource upsert**: `@@unique([sourceType, sourceName])` を schema.prisma:53 で確認。`sourceType_sourceName` 複合キーの upsert はレース安全（ガード 6）✅
4. **dry-run の書込ゼロ**: dry-run 分岐は `NestFactory` 起動前に return。設計指示（Stub provider 切替）より強い保証に進化 ✅（副作用として Medium-1 / Medium-2 が発生）

### claim-first ガード検証（自己制約 3）

設計書 §5 冪等性ガード表（7 項目）と実装の対照:

| # | ガード | 対照結果 |
|---|---|---|
| 1 | claim-first（既存） | ✅ `IngestionService.claimJob()` 経由 / CLI は `--force` 以外で idempotencyKey を必ず渡す（index.ts:244-251） |
| 2 | idempotencyKey 安定導出 | ⚠️ 単一パス指定では ✅（externalId 昇順ソート + mtime 除外 / chunker.ts:125-133）。**複数ディレクトリ指定時は引数順依存**（Medium-3 参照） |
| 3 | document 差分（既存） | ✅ 既存 service に乗る — ただし「同一 externalId の旧版置換」は存在しない（High-2 参照 / ガードの守備範囲外の構造穴） |
| 4 | embedding 差分（既存） | ✅ 既存 service に乗る |
| 5 | 1 文書 1 トランザクション（既存） | ✅ 既存 service に乗る |
| 6 | RagSource upsert レース | ✅ 複合 unique 上の upsert（index.ts:225-241） |
| 7 | dry-run 書込ゼロ | ✅ ジョブ行も作らない（Nest 自体を起動しない） |

---

## 必須修正（Critical / High）

### High-1（Claude 独自）: live モードの実行前提 `openai` SDK が未宣言・未インストール

- **事実**: `openai` パッケージは `apps/api/package.json` / root / `packages/shared` のいずれにも未宣言、node_modules にも不在。`OpenAiSdkClient` constructor は `require('openai')` を遅延実行し、不在なら throw（`openai-client.openai-sdk.ts:51-64`）。CLI live モードは `createApplicationContext(IngestCliModule)` の factory 実行時点で必ず落ちる
- **なぜ問題か**: Phase 4 の受け入れ条件「CLI 1 コマンドで chunk → embed → Neon 書込が完結」が、どの環境でも未充足。サーバ側は Stub 束縛だったため、実 adapter が load-bearing になるのは **本フェーズが初**であり、Phase 4 の責任範囲。設計書 §3 判断 4「本フェーズは新規依存ゼロで成立する」は dry-run のみ真。runbook §2 前提（「CLI 実行のみで npm install は不要」）にも記載なし — runbook の完全性主張と矛盾
- **どう直すか**: (1) `apps/api/package.json` dependencies に `openai` を宣言（install 自体はふみさん手動 / SMB 直列ルール遵守）、(2) runbook §2 前提に「live モードは `openai` SDK 必須 / dry-run は不要」を追記、(3) 設計書 §3 判断 4 に「新規依存ゼロ = dry-run 限定」の訂正注記

### High-2（Codex High-2 を Claude が実コード confirm）: 再取込時に旧 document が active 残置 — 設計書の前提が実装事実と不一致

- **事実**（裁定済 / 推論ではない）: `ingestion.service.ts:261-262` の document 照合は `findFirst({ sourceId, contentHash, deletedAt: null })`。externalId は照合キーに使われない。chunk/embedding の deleteMany（同 305-308 行）は同一 documentId 内の置換のみ。**ファイルを編集して再取込 → 新 contentHash の新 document が作られ、旧 document（旧内容）は active のまま** → RAG 検索で新旧両方がヒットするデータ汚染
- **なぜ問題か**: runbook §4 が推す主要運用ループ「戦略ドキュメント更新時に手動実行」がそのまま汚染トリガー。設計書 §4-2「externalId = 再取込時の document 対応付けキー」と §2「既存パイプラインは全置換セマンティクス」は実装事実の誤認（盲点 8 同型: 既存仕様の希望的固定）。CLI 自体のコードは設計書通りだが、設計の前提が偽
- **どう直すか**（いずれかを eng-pm 裁定）:
  - **案 a（推奨）**: `IngestionService.persistDocumentAndChunks` のトランザクション内で「同一 `(sourceId, externalId)` かつ別 contentHash の旧 document を soft-delete（`deletedAt` 付与）」する supersede 処理を追加。既存サーバ経路にも益する正攻法。+ 「同一ファイル編集再取込で active document が 1 件」の統合テスト
  - **案 b（暫定）**: CLI 側で ingest 前に同一 `(sourceId, externalId)` の旧 document を soft-delete。サーバ経路は別チケット
  - 最低限: runbook に既知制約として明記し、構造チケットを起票して merge 並行（黙殺は不可）

### High-3（Codex High-1）: `@pmtp/shared` の実行時解決が現状壊れている（dry-run も起動不能）

- **事実**: Codex の実走で `Cannot find module '@pmtp/shared'`。`@pmtp/shared` は working tree で package.json に追加済だが install 未実施（ふみさん手動運用のため想定内）+ lockfile 未同期。加えて `tsconfig paths` は `packages/shared/dist` 直指しのため、**shared の build 済 dist が前提**（`.gitignore` 対象）
- **なぜ問題か**: 実装報告の「検証未実施項目」と整合しており実装ミスではないが、**ふみさんの merge 前ゲート条件として明文化されていない**。install 後も shared 未 build なら同じ症状になる
- **どう直すか**: runbook §2 前提に「(1) `npm install`（apps/api / 直列）、(2) `packages/shared` の build（dist 生成）、(3) `npm run ingest -- <既存md> --dry-run` smoke が exit 0」を merge 前チェックリストとして追記。lockfile 同期もふみさん install 時に確定

---

## 推奨改善（Medium / Low）

1. **[Medium / Codex Medium-1] root script 経由の相対パス基準ズレ**: `npm --prefix apps/api run ingest` の cwd は apps/api。runbook の `./docs/strategy` 例（root 相対）は apps/api 相対に解決され ENOENT。`INIT_CWD` 基準への固定 or runbook 例の修正
2. **[Medium / Claude] `IngestCliDryRunModule` が dead code**: index.ts:160 で destructure されるが以降未使用（dry-run は Nest 非起動に進化したため）。static spec の「--dry-run フラグで IngestCliDryRunModule を使う分岐がある」は import 行の文字列マッチで**偽パス**しており、テストが実装と乖離。→ モジュール削除（YAGNI / 最小構成）+ 当該テスト修正。`noUnusedLocals` 未設定のため typecheck では検出されない
3. **[Medium / Claude] dry-run プレビューが `normalizeText` 非経由**: live は `chunkItem({...item, rawContent: normalized})`（service:201-205）、dry-run は raw のまま → chunk 数（= 課金見積もり）が live と乖離し得る。dry-run でも `normalizeText` を通す（純関数 / 1 行）
4. **[Medium / Claude] 複数ディレクトリ指定時の `pickBaseDir` が引数順依存**: 「最初に見つかったディレクトリ」が baseDir になるため、`dirA dirB` と `dirB dirA` で externalId（相対パス）と idempotencyKey が変わる = ガード 2 の「順序非依存」が条件付きで破れ、High-2 の重複 document も誘発。共通祖先方式にするか、runbook に「複数ディレクトリ指定時は順序を固定」と注記
5. **[Low / Claude] `SOURCE_STATUSES[0]` のマジックインデックス**（index.ts:238）: shared 側の配列並び替えで静かに `'ACTIVE'` 以外になる。`'ACTIVE' satisfies SourceStatus` 等の名前参照に
6. **[Low / Claude] 設計書 §3 判断 4 の「新規依存ゼロ」記述訂正**: dry-run 限定であることを明記（High-1 の派生）

---

## 統合 verdict の根拠

| 入力 | 結果 |
|---|---|
| Codex | Critical 0 / High 2（@pmtp/shared 起動不能 / 旧文書残置）/ Medium 1 |
| Claude 独自 | High 1（openai SDK 未宣言で live 起動不能）/ Medium 3 / Low 2 |
| 表適用 | Codex High あり → changes-requested。Claude 独自 High あり → changes-requested |

**→ changes-requested**。設計の骨格（候補 A 再利用 / DI 単一束縛 / DIRECT_URL 上書き / enum SSoT / 純関数分離）は良質で、blocked 相当の構造欠陥ではない。必須修正は (1) 実行前提の宣言と runbook 化、(2) externalId supersede セマンティクスの裁定と対処（または既知制約明記 + 構造チケット）、(3) install 後 smoke の merge 前ゲート化の 3 点に収束する。

---
**独立性の補足**: 本レビューは architecture 観点のみで作成し、もう一方のレビュー（`phase-4-review-quality.md`）は参照していない。
