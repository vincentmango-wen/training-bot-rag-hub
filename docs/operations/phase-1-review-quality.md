# Phase 1 品質レビュー（eng-reviewer-quality）— Neon プロビジョニング + Prisma migration

```yaml
ticket: training-bot-rga-hub-phase-1-neon
github-pr: ""                  # PR 未作成（コミット・push はふみさん手動方針）
reviewer: quality
review-mode: parallel-agents   # architecture レビューと並列・独立実行（参照していない）
verdict: approved
created: 2026-06-11
codex-status: succeeded
codex-critical-count: 0
codex-high-count: 0
codex-error-reason: ""
self-constraint-1-applied: false   # 本リポ初フェーズ / 直近 3 件以内の同型 hot-fix 履歴なし
self-constraint-2-triggered: n/a   # architecture レビュー参照禁止のため共造判定は eng-pm 裁定側で実施
self-constraint-3-triggered: true  # diff に unique 制約 / idempotency_key 言及あり → 設計書 §5 と対照確認実施（下記）
self-constraint-4-triggered: n/a   # SSRF / 外部ネットワーク DI / fetch 系コードの追加なし
```

## レビュー対象（working tree / main 上の未コミット変更）

- `docs/operations/phase-1-design.md`（新規 211 行）
- `docs/operations/neon-setup.md`（新規 155 行 / runbook）
- `apps/api/.env.example`（追記 7 行）
- `.env.example`（追記 2 行）
- `apps/api/src/__tests__/phase1-migration-static.spec.ts`（新規 256 行 / 27 ケース）

## Codex 機械観点レビュー

> **起動経路の注記**: 規定の `codex-companion.mjs adversarial-review` は 2 段階で失敗（①対象リポに `.node-version` 不在 → nodenv が codex 未インストールの node 22.13.1 に解決 / PATH 前置で回避 ②companion script 内部 app-server review が `failed to load configuration: No such file or directory (os error 2)`）。codex 本体（0.133.0）は同 cwd で正常動作確認済みのため、**`codex exec` 直叩き + 全 diff 添付のフォールバック**で同等のレビューを取得した（exit 0 / stdout 正常）。auth 切れパターン（400 / session ended / Please log in again）は **非該当**。

### Codex stdout（verdict 部全文）

```
対象: Phase 1 Neon 移行準備 working tree
verdict: changes-requested

🟡 Medium: docs/operations/neon-setup.md:89 / :97
Neon SQL Editor と psql を同じ手順にしているが、`\dt rag_*` は psql meta-command なので SQL Editor では実行できません。runbook の「そのまま貼れる検証手順」として偽です。SQL Editor 用は information_schema.tables か pg_tables の SELECT に分けて、`\dt` は psql 専用と明記してください。

🟡 Medium: docs/operations/neon-setup.md:50 / :53
`<pooled URL>?sslmode=...` の形は、Neon コンソールの URL が既に `?sslmode=require` 等を含んでいた場合に `...?sslmode=require?sslmode=require...` のような壊れた URL を作らせます。:65 で重複注意は書いていますが、コピペ用コードブロック自体が事故りやすいです。`<base URL without query>` と書くか、既存 query を削除してから付ける手順にしてください。

🟡 Medium: apps/api/src/__tests__/phase1-migration-static.spec.ts:135
B2 の複合 FK テストが rag_retrieval_results と retrieval_result_id の存在しか見ていません。実際の UNIQUE ("id", "chunk_id") や FOREIGN KEY (...) REFERENCES ... が消えても通るため、citation whitelist の退行を検出できません。制約名と列組み合わせを regex で検証してください。

🔵 Low: apps/api/src/__tests__/phase1-migration-static.spec.ts:106
テスト名は ALTER TABLE rag_embeddings で CHECK が適用されていることを検証する内容ですが、実装は sql.includes('B6') || sql.includes('vector_dims') だけです。コメントだけ残っていても通ります。

🔵 Low: apps/api/src/__tests__/phase1-migration-static.spec.ts:210
「実パスワードが含まれていない」テストが、実質 DATABASE_URL に localhost が含まれることしか見ていません。postgresql://user:real_secret@localhost... でも通ります。既知 secret pattern / Neon 実 endpoint / 非 placeholder password を検出する negative assertion にした方がよいです。

secret grep は必須パターンでヒットなしでした。Critical / High は見つかっていません。

重大度集計: Critical=0 High=0 Medium=3 Low=2
```

※ Codex の verdict 表記は「changes-requested」だが、Critical/High = 0 のため統合 verdict ルール（Medium/Low のみ → approved + 軽微指摘記録）に従い本レビューの統合判定は approved（§統合 verdict 参照）。

## 組織固有観点レビュー（Claude）

- [x] **Secret 管理（実測検証済）**: 新規 4 ファイルを grep 走査 → 実値・実 endpoint・実パスワードの混入なし。placeholder（`<role>` / `<password>`）と既知ダミー（`rag_password_local_only`）のみ。`apps/api/.env` は `.gitignore:8` でカバー済を `git check-ignore -v` で実機確認
- [x] **.env.example 追記のみ・既存値無削除（実測検証済）**: `git diff` で両ファイルとも純追記（ルート側は EOF 改行補正のみ既存行に触れる / 値の変更なし）。冪等性ガード表 §5 の grep ガードと整合
- [x] **テスト報告の裏取り（実測検証済）**: `npx jest phase1-migration-static.spec.ts` を再実行 → **27 passed / 27 total** をレビュー側で独立再現。migration 実体も確認（L19 `CREATE EXTENSION IF NOT EXISTS vector` / `CREATE TABLE "` = 17 件 / schema.prisma L23 `directUrl` 既設 / root npm scripts `db:migrate:deploy` `db:migrate:status` 実在）
- [x] **runbook の操作者 UX（ふみさん手作業前提）**: 章立ては「画面操作 ↔ コピペコマンド」交互で迷いにくい。autosuspend / 0.5GB 上限 / compute hours の隠れコストが §7-8 に落ちている。エッジケース（pooler/direct 混同 → advisory lock hang）もトラブルシュート表にあり
- [ ] **runbook §6 の軽微な不正確 2 点**（Codex Medium-1 と同根 + 追加 1 点）:
  - `\dt rag_*` は psql meta-command で Neon SQL Editor では動かない（Codex 未検出ではなく同検出 / 重複指摘として統合）
  - **Codex 未検出**: §6 (b) の期待コメント「rag_sources / ... / 他 17 件」（neon-setup.md:98-99）— 9 テーブル列挙後に「他 17 件」は合計 26 件と誤読される。正しくは「計 17 件」
- [ ] **個人非公開運用の認証境界（推奨追記）**: Neon Free は IP 許可リスト機能がない（有料機能）ため、DB endpoint はインターネット到達可能で**接続文字列が唯一の認証境界**になる。runbook §1 または §3 に「接続文字列 = 単独で DB 全権の secret として扱う / 漏洩時は Neon コンソールの Reset password で即ローテーション」の 1-2 行を追記推奨。Phase 2 の Vercel env 投入時に再度効いてくる注意
- [x] **コンプライアンス**: 個人情報・課金フロー・景表法該当なし（個人非公開運用 / docs + env テンプレート + 静的テストのみ）
- [x] **組織独自品質ルール**: 想定コストセクション（工数 + 月額 + 隠れコスト + ゼロコスト代替 3 案）が設計書 §2 に完備。マーケ素材該当なし
- [x] **PII / API キー混入の構造的チェック**: 将来 PII が流れ込む構造なし。むしろテスト側に「.env.example への実値混入を検出する構造ガード」（spec L199-208）が追加されており方向性は良い（強度不足は Codex Low-2 の通り）
- [x] **独立性ルール遵守（自己宣言）**: architecture レビューファイルは開いていない・読んでいない

### claim-first ガード検証（自己制約 3）

トリガー: diff（テスト spec）に `idempotency_key` / 部分 unique 制約への言及あり → 発火。設計書 §5「冪等性ガード」と実装の対照結果:

| 設計書 §5 のガード | 実装 / 検証 | 判定 |
|---|---|---|
| `migrate deploy` 再実行（`_prisma_migrations` で skip） | runbook §5 に「再実行は安全」明記 | ✅ |
| `CREATE EXTENSION ... IF NOT EXISTS`（冪等） | init L19 実在 + spec L61-72 が IF NOT EXISTS 必須をテスト | ✅ |
| .env.example 追記重複（grep 事前確認） | 実装報告に grep 0→2 / 0→1 の実施記録あり + 実ファイル目視で重複なし | ✅ |
| Neon 同名プロジェクト二重作成 | runbook §2-3 に「既存一覧確認してから Create」ステップあり | ✅ |
| claim-first（INSERT/upsert コード）= N/A 宣言 | 根拠明記（DB 書き込みコードを一切追加しない）。diff 実査でも書き込みコードなし → N/A 妥当 | ✅ |

## 統合 verdict

**approved**（Codex: Critical=0 / High=0 / Medium=3 / Low=2 → 軽微指摘のみ。Claude 独自: 重大指摘なし）

### 推奨改善（マージブロックしない / Phase 2 着工前または同フェーズ微修正で消化推奨）

1. **[Codex Medium + Claude 同検出]** runbook §6: `\dt rag_*` を SQL Editor 用 `SELECT tablename FROM pg_tables WHERE tablename LIKE 'rag_%';` に置換 or psql 専用と明記（neon-setup.md:97）
2. **[Codex Medium]** runbook §4: コピペブロックを「query なし base URL + パラメータ一括付与」の形に修正し二重 `?` 事故を防ぐ（neon-setup.md:50,53）
3. **[Codex Medium]** spec L135-139: B2 複合 FK テストを制約の実体（UNIQUE / FOREIGN KEY 列組）regex 検証に強化
4. **[Codex Low]** spec L106-110: `includes('B6') || includes('vector_dims')` のトートロジー気味 assertion を ALTER TABLE 実体検証に置換
5. **[Codex Low]** spec L210-219: 実パスワード検出 assertion の強化（neon.tech 実 endpoint / 非 placeholder password の negative assertion）
6. **[Claude]** runbook §6 (b) 期待コメント「他 17 件」→「計 17 件」に修正（neon-setup.md:99）
7. **[Claude]** runbook に「接続文字列 = 唯一の認証境界 / 漏洩時 Reset password」の注意 1-2 行を追記（Neon Free に IP 許可リストなし）

---
**独立性の補足**: 本レビューは quality 観点のみで作成し、もう一方のレビュー（`phase-1-review-architecture.md` 等）は参照していない。
