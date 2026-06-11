---
ticket: phase-4-rag-ingestion-cli
github-pr: ""              # ローカル運用（コミット/push/gh はふみさん手動のため PR なし）
reviewer: quality
review-mode: parallel-agents
verdict: needs-revision
created: 2026-06-11
codex-status: failed
codex-critical-count: 0
codex-high-count: 0
codex-error-reason: "Phase 4 の変更が main 上の未コミット working tree のため branch diff が空。Codex は変更内容を参照できず実質レビュー不能（codex 自体は起動成功 / auth 正常）"
self-constraint-1-applied: false   # 同型 hot-fix 直近 3 件の系列なし（Phase 1-4 は単発の移行プロジェクト / hot-fix 連発履歴なし）
self-constraint-2-triggered: n/a   # 並列独立レビューのため本レビュー単独では判定不能（eng-pm が両レビュー突合時に判定）
self-constraint-3-triggered: true  # claim / idempotencyKey / upsert / findFirst+early-return / status 機械 → 発火
self-constraint-4-triggered: n/a   # SSRF 防御層 / undici / DNS lookup / fetch interceptor の新規配線なし。OpenAI egress は既存 OpenAiSdkClient + AbortController timeout を再利用するのみで、ネットワーク防御層の変更に該当しない
---

# Phase 4: RAG ingestion CLI 分離 — 品質・リスク観点レビュー（eng-reviewer-quality）

対象:
- `apps/api/scripts/ingest/index.ts` / `chunker.ts` / `embedder.ts`
- `apps/api/scripts/tsconfig.json` / `apps/api/package.json` / ルート `package.json` / `apps/api/tsconfig.spec.json` / `README.md`
- `docs/operations/ingestion-runbook.md`
- テスト 3 ファイル（`phase4-ingest-cli-{chunker,args,static}.spec.ts` / 18 describe / 106 it）

---

## Codex 機械観点レビュー

**起動失敗（実質）のため、本来のチェックリスト評価のみで判定。**

Codex CLI は nodenv PATH 回避（22.14.0 bin 前置）で起動に成功したが、`adversarial-review --base main --scope branch` は **コミット済み branch diff** を入力とするため、Phase 4 の変更（main 上の未コミット working tree / 本プロジェクトはコミット禁止規約）を参照できなかった。Codex stdout（全文要旨）:

> Verdict: needs-attention
> 対象 diff が提供コンテキスト上は空で、レビュー対象の変更内容を確認できません。
> Findings: [critical] レビュー対象の branch diff が空で変更内容を検証できない (repository_context:1)
> Next steps: main との差分生成 + secret grep 結果の提示

この [critical] は「diff が空」というメタ指摘であり、コード上の Critical ではないため `codex-critical-count: 0` と記録する。auth 切れシグナル（400 / session ended / Please log in again）は **なし**。

**補完措置**: Codex 担当だった機械化可能観点（secret 混入 grep / エラーハンドリング / データ整合性 / 外部 API timeout・retry）は本レビューで Claude が代替評価した（下記）。secret grep（`sk-` / `ghp_` / `password=` / `api_key=` パターン）は Phase 4 全ファイルで **ヒット 0**。

**構造メモ（eng-pm 向け）**: 本リポは「コミットはふみさん手動」運用のため、コミット前レビューでは Codex adversarial-review が構造的に空振りする。Phase 5 以降は「ふみさんコミット後に Codex を再走させる」か、working-tree 対応モードの検討が必要。

---

## 組織固有観点レビュー（Claude）

### チェックリスト

- [ ] **UX フロー（CLI 運用体験）**: 致命的エッジケース 2 件（H-1 / H-2）。正常系は良好だが「中断後の再実行」「touch 後の再実行」で設計の約束（迷ったら再実行してよい）が破れる
- [x] **コンプライアンス**: 個人非公開運用 / 課金フローなし / PII なし。OpenAI への送信は自分のローカルドキュメントのみで問題なし。`.env` の gitignore 確認手順が runbook §9 に明記済
- [x] **組織独自の品質ルール**: enum SSoT（`MVP_SOURCE_TYPES` / `SOURCE_STATUSES` を `@pmtp/shared` から import / リテラル再宣言なし / `as never` なし）✅。新規 npm 依存ゼロ ✅。SMB 制約遵守 ✅。金融数値規約は非該当（取込素材は string 素通し）
- [x] **独立性ルール遵守**: `phase-4-review-architecture.md` は開いていない・読んでいない（自己宣言）
- [x] **PII / API キー混入の構造的チェック**: ログ出力は jobId / status / 件数 / 相対パスのみ。API キー・接続文字列・ファイル本文の出力経路なし。errorMessage は 200 字 truncate。将来 PII が流れ込む構造もなし（入力はローカル .md/.txt のみ）

### 🟠 High-1: `metadata.mtime` が payloadHash に混入し、同一内容でも IdempotencyConflictError（409）で FATAL になる

- **場所**: `apps/api/scripts/ingest/chunker.ts:109`（`mtime: stat.mtime.toISOString()`）× `apps/api/src/ingestion/ingestion.service.ts:451`（`computePayloadHash` が `it.metadata` を含む）
- **構造**: `deriveIdempotencyKey` は設計通り mtime を除外している（コメントにも「mtime を入れるとガード無効化」と明記）。しかし `buildItems` が `metadata` に mtime を入れ、その metadata は `IngestionService.computePayloadHash` のハッシュ対象に含まれる。結果:
  - **idempotencyKey = 同一**（内容ベース）/ **payloadHash = 別**（mtime 差）
  - `resolveExisting` が「同一キー別 payload = キー使い回しバグ」と判定 → `IdempotencyConflictError` throw → CLI は FATAL exit 1
- **再現条件**: 内容を変えずに mtime だけ変わる操作（`touch` / `git checkout` / ファイルコピー / rsync / SMB 経由の複製）の後に再実行。**日常運用で普通に踏む**
- **影響**: runbook の核心の約束「同一内容での再実行 → replay（課金ゼロ）」「迷ったら再実行してよい」が崩壊。ユーザーは原因不明の conflict エラーに遭遇する
- **修正案**: `buildItems` の `metadata` から `mtime` を除去する（`{ relativePath, fileSizeBytes }` のみ。fileSizeBytes は内容由来なので安定）。mtime を残したいなら metadata ではなくログ表示専用に
- **テスト追補**: 「同一内容 + mtime 変更 → payloadHash 不変」を chunker spec ではなく **buildItems→computePayloadHash 経路の等価テスト** で固定すること（既存 static テスト「mtime を idempotencyKey に含めない」だけでは本件を検出できなかった）

### 🟠 High-2: 中断・部分失敗ジョブの replay が「何もせず exit 0」になり得る + runbook の復旧手順 3 行が実装と不一致

- **場所**: `apps/api/scripts/ingest/index.ts:287`（exit code 判定）× `ingestion.service.ts:104-145`（claim/replay は既存ジョブの **完了状態を見ずに** replay する）× `docs/operations/ingestion-runbook.md:148-150`
- **構造**:
  1. **SIGINT 中断**: ジョブ行は idempotencyKey + payloadHash 付きで残る（status=INDEXING / failedCount=0）。同一入力で再実行 → 同一キー同一 payload → **replay**（再処理なし）→ `result.status='INDEXING'` / `failedCount=0` → **exit 0**。未取込のまま CLI が成功を返す
  2. **部分失敗（429 等）**: job は INDEXED + failedCount>0 で確定。再実行 → replay で同じ失敗結果を返すだけ。**失敗 item は `--force` なしには永遠に再取込されない**（exit 1 は返るので発見は可能）
  3. **runbook の誤記述**（実装と不一致）:
     - L148「Neon idle 切断 → 再実行（replay により未完了分から再開）」→ **再開しない**。replay は既存結果の返却のみ
     - L149「429 → 再実行で差分継続」→ **継続しない**。`--force` が必要
     - L150「SIGINT → 同じ入力で再実行すれば**別キーで**新ジョブが立つ」→ **同一キーになり replay される**（deriveIdempotencyKey は内容ベースで mtime 非依存。新ジョブは立たない）
- **修正案（2 点セット）**:
  - **コード**: `result.replayed === true` かつ `result.status !== 'INDEXED' || result.failedCount > 0` の場合、「前回ジョブが未完了/失敗。`--force` で再取込してください」と警告して **exit 1** にするガードを index.ts に追加（replay 成功時のみ exit 0）
  - **runbook**: §8 の 3 行を「`--force` で再取込」に書き換え、§3.4 の「通常は不要」も「中断・失敗後の復旧では必須」と補正
- **補足**: これは既存 `IngestionService` の仕様（replay は完了状態を見ない）と CLI の組み合わせで顕在化した盲点であり、サーバ側コードの変更は不要。CLI 側ガード + runbook 修正で閉じる

### 🟡 Medium-1: dry-run プレビューが正規化前の rawContent で chunk 分割しており、live 実行と chunk 数がズレ得る

- **場所**: `index.ts:197`（`chunkItem(item, args.sourceType)`）vs `ingestion.service.ts:201-205`（live は `normalizeText` 後に `chunkItem`）
- dry-run の目的は「取込内容の事前検証」だが、live は正規化（secret/PII マスク含む）後の本文を分割するため、件数・QUARANTINE 判定が dry-run と一致しない場合がある
- **修正案**: dry-run でも `normalizeText`（純関数 / DB 不要）を通してから `chunkItem` する。1 行の動的 import 追加で済む

### 🟡 Medium-2: runbook / README の実行例の相対パスが実際の cwd（apps/api）と不一致

- `npm --prefix apps/api run ingest` は **cwd = apps/api** でスクリプトを実行するため、runbook §3 / README の例 `npm run ingest -- ./docs/strategy` の `./docs/strategy` は `apps/api/docs/strategy` に解決され ENOENT になる（リポルートの docs を意図しているなら）
- **修正案**: (a) runbook の例を絶対パスまたは「apps/api からの相対パス」と明記、または (b) index.ts で `process.env.INIT_CWD`（npm が元の cwd を渡す）を基準に resolve する

### 🟡 Medium-3: `--env-file=.env` は `.env` が無いと Node 起動自体が失敗する

- runbook §2.1 は「`.env`（**または起動時の env**）」と書くが、`node --env-file=.env` は apps/api/.env 不在時にエラー終了するため「起動時の env だけで動かす」経路が存在しない
- **修正案**: Node 22.9+ の `--env-file-if-exists=.env` に変更（engines は `>=22` のため要バージョン明記）、または runbook から「または起動時の env」を削除して .env 必須と明記

### 🟡 Medium-4: `SOURCE_STATUSES[0]` の位置インデックス参照は配列順変更で無言破壊する

- `index.ts:238`（`status: SOURCE_STATUSES[0], // 'ACTIVE'`）。SSoT 配列の参照自体は規約準拠だが、**位置**への依存は将来の配列順変更（先頭への値追加）で status が静かに変わる
- **修正案**: `const status: SourceStatus = 'ACTIVE'` のように型注釈付きリテラル（union 型検査が効くため SSoT 規約違反にならない）か、shared に named 定数を切る

### 🟢 Low（任意改善）

1. **IdempotencyConflictError の FATAL 表示**: H-1 修正後も `--idempotency-key` 手動指定での 409 はあり得る。catch して「同一キーで内容が変わっています。`--force` か別キーを使ってください」の 1 行ガイドを出すと CLI 体験が上がる
2. **pickBaseDir の複数ディレクトリ引数**: `ingest ./a ./b` で baseDir=./a となり、./b 配下の externalId が `../b/...` になる（引数順依存）。runbook に「1 回の実行は 1 ディレクトリ推奨」と一筆
3. **static テスト L138 の「textual に import より前」検証は弱い proxy**: ES import hoisting により実行順はテキスト順と一致しない。実際の順序保証は「Prisma 系を動的 import に限定した」構造の方（これは正しく実装・検証されている）なので、テストの説明コメントだけ実態に合わせると誤学習を防げる

### 良かった点（quality 観点）

- secrets 非出力の徹底（ログは jobId / 件数 / 相対パスのみ。errorMessage 200 字 truncate。grep でも混入ゼロ）
- `finally` での `app.close()` 保証（Neon Free 接続枠保護）と dry-run 時の Nest 非起動（接続ゼロ）
- env fail-fast（OPENAI_API_KEY / DATABASE_URL を DB 接続前に検査して exit 2）と exit code 契約の明確さ
- 10MB 超ファイルの警告付きスキップ（黙殺なし）+ 全スキップ時の exit 2
- RagSource upsert によるレース安全な find-or-create（手書き P2002 catch を書いていない）
- テストが「実 fs I/O での純関数検証」+「ロジック等価テスト（モックなし）」+「static 構造検証」の 3 層で、偽陽性を作りにくい構成

---

## claim-first ガード検証（自己制約 3）

設計書 §5「冪等性ガード（実装必須項目）」7 項目との対照:

| # | ガード | 検証結果 |
|---|---|---|
| 1 | claim-first（idempotency_key + payload_hash） | ✅ 既存実装健在。CLI は `--force` 時以外 idempotencyKey を必ず渡す（index.ts:244-251） |
| 2 | idempotencyKey の安定導出（順序非依存・内容ベース） | ⚠️ **キー自体は安定**（externalId ソート + contentHash のみ / chunker.ts:125-133、テスト AC-IDEM で順序非依存・mtime 非依存を verify 済）。**ただし payloadHash 側に mtime が混入しガード 1 と矛盾**（→ High-1）。「同一キー同一 payload = replay」の约束が touch 1 回で 409 に化ける |
| 3 | document 差分（UNIQUE(source_id, content_hash)） | ✅ 既存（ingestion.service.ts:261-291）。CLI 変更なし |
| 4 | embedding 差分（content_hash 一致で再利用） | ✅ 既存（snapshotReusableEmbeddings）。CLI 変更なし |
| 5 | 1 文書 1 トランザクション | ✅ 既存（$transaction）。SIGINT 時の DB 整合性は保たれる。**ただし中断ジョブの replay 挙動は runbook 記載と不一致**（→ High-2） |
| 6 | RagSource find-or-create のレース | ✅ `prisma.ragSource.upsert`（compound unique 上 / index.ts:225-241）。手書きレース処理なし |
| 7 | dry-run の書込ゼロ保証 | ✅ `IngestionService` 不呼出・`NestFactory` 不起動・ジョブ行も作らない（index.ts:194-209、static テストで二重 verify） |

**結論**: 🆕 3 項目（2 / 6 / 7）は実装に落ちているが、ガード 2 は payloadHash との境界整合（mtime）に欠陥があり、ガード 1 の replay 約束を運用上無効化する。設計書 §5 の表自体に「metadata は payloadHash に入る」という前提の明記がなかったことが盲点の根（設計書側にも 1 行追記推奨）。

## 自己制約 4 検証（SSRF / network egress）

- diff に undici Agent / dispatcher / DNS lookup / fetch interceptor / SSRF 防御層の識別子なし。外部 egress は既存 `OpenAiSdkClient` + `OpenAIEmbeddingAdapter`（AbortController による per-call timeout 10s / 型付き retryable エラー実装済を実コード確認）の再利用のみ → **n/a**（新規ネットワーク防御層なし）

---

## 統合 verdict

**needs-revision**（changes-requested 相当）

- Codex 由来: 実質レビュー不能（branch diff 空）のため判定材料なし（Critical 0 / High 0 として扱う）
- Claude 独自: **High 2 件**（H-1 mtime→payloadHash 409 / H-2 中断 replay の exit 0 + runbook 復旧手順 3 行の実装不一致）→ 統合 verdict 表「Claude 重大指摘あり → changes-requested」に該当
- Medium 4 件 / Low 3 件は推奨改善（マージブロックしない）
- セキュリティ（secret 混入 / ログ漏洩 / 認証境界）と課金安全性（embedding 差分再利用）は問題なし。High 2 件はいずれも **データ未取込・運用混乱系** であり、修正は CLI + runbook に閉じる（既存サーバコード変更不要）

### 必須修正（merge 前）

1. H-1: `buildItems` の metadata から `mtime` を除去（+ payloadHash 不変の等価テスト追加）
2. H-2: replay 時の未完了/失敗ジョブ警告 + exit 1 ガードを index.ts に追加、runbook §8 の 3 行（idle / 429 / SIGINT）と §3.4 を実装挙動に合わせて修正

---
**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（`phase-4-review-architecture.md`）は参照していない。
