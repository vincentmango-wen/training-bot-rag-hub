# Phase 5 設計書 — PTP 側 RAG クライアント URL 切替指示書（cutover）

- 作成日: 2026-06-11
- 作成者: eng-backend（設計フェーズ担当）
- ステータス: 設計レビュー待ち
- 対象リポジトリ: `/Volumes/DevShare/projects/training-bot-rga-hub`
- 前フェーズ設計書: `docs/operations/phase-3-design.md`（ダブルロック）/ `docs/operations/phase-4-design.md`（ingestion CLI）/ `docs/operations/vercel-deploy.md` / `docs/operations/smoke-test.md`

---

## 1. 目的と前提

### 目的

Personal Multi Trading Platform（PTP / **別リポジトリ**）の RAG クライアントが参照する RAG Hub のエンドポイントを、ローカル docker（`http://rag-api:3000` / `localhost:3000`）から **Vercel Production URL（`https://<project>.vercel.app`）へ切り替えるための指示書** を本リポに整備する。

1. PTP 側で必要な env 変更 / クライアントコード調整 / 疎通確認 / 切り戻しを **手順書 1 本**（`ptp-client-cutover.md`）に固定する
2. Vercel エンドポイントへの疎通確認を **copy & paste で完走できるスクリプト雛形**（`cutover-smoke-test.sh`）として提供する（PTP 側ホストからも本リポからも実行可能）
3. 本リポ README から切替手順への導線を張る

### 重要な制約 — 本フェーズは PTP リポへ一切書き込まない

本ワークフローの作業ディレクトリに PTP リポは含まれない。成果物はすべて **本リポ側のドキュメント + スクリプト雛形** であり、PTP 側の実コード変更は「PTP 側で実行すべき差分の手順書」として記述するに留める。PTP 側の env 変数名・クライアント実装の実体は本設計時点で **未検証（推測禁止）** のため、手順書には **discovery ステップ**（PTP リポ内 grep コマンド）を必ず含める（§4-1）。

### 入力となる前フェーズ・既存資料の成果物（実機確認済 / 2026-06-11）

| 既存物 | 場所 | 本フェーズへの影響 |
|---|---|---|
| ダブルロック実装 | `apps/api/src/common/guards/bearer-token.guard.ts`（全ルート / `/health` 含む / fail-closed 503） | PTP クライアントは **`Authorization: Bearer <API_BEARER_TOKEN>`** を全リクエストに付与する必要がある |
| Vercel Standard Protection | `vercel-deploy.md` §4（Protection Bypass for Automation secret 発行済前提） | PTP クライアント（server-to-server / 非ブラウザ）は **`x-vercel-protection-bypass: <secret>`** ヘッダが必須（§3 判断 2） |
| 公開エンドポイント実体 | `health.controller.ts` → `GET /health` / `rag-query.controller.ts` → `POST /api/v1/rag/query` / `rag-bot-context.controller.ts` → `POST /api/v1/rag/bot-context` / `rag-similar-cases.controller.ts` → `POST /api/v1/rag/similar-cases` / `rag-history.controller.ts` → `GET /api/v1/rag/history` | 切替対象のパス一覧。**パス・I/O 契約は不変**（URL のホスト部とヘッダのみ変わる） |
| PTP→RAG IF 契約 | `docs/design_and_RD/30_RAGサービスIF契約・疎結合境界定義書.md` §4（Base URL `http://rag-api:3000/api/v1/rag` / Idempotency-Key 必須 / client timeout 10 秒 / フォールバック 2 択契約） | 切替後もこの契約は維持。Base URL 記載は cutover 後に乖離するため手順書に注記（§4-1 / 残課題） |
| smoke-test 雛形 | `docs/operations/smoke-test.md`（Test 1〜4 / 判別表） | `cutover-smoke-test.sh` は同じ 4 系列をスクリプト化 + read-only DB 確認を追加（§4-2） |
| Neon Free の auto-suspend | `neon-setup.md` / Neon Free はアイドル後 compute が suspend → 初回リクエストで resume 数秒 | **PTP client timeout 10 秒（IF 契約 §5）と干渉** → cold start 込みの初回失敗が起き得る。手順書のトラブルシュート + ウォームアップ手順に必須記載（§2 隠れコスト / §4-1） |

### 認証方式の契約差異（手順書に明記する）

IF 契約書 30 §4.2 は `Authorization: Bearer {jwt}` と記載しているが、Phase 3 の MVP 実装は **JWT ではなく単一共有静的トークン**（`API_BEARER_TOKEN`）である。ヘッダ形式は同一のため PTP 側の送信実装は変わらないが、「jwt を採番・検証する仕組みは存在しない」ことを手順書に明記し、誤って JWT ライブラリを導入させない。

### スコープ外（本フェーズでやらないこと）

- PTP リポへのコード変更・コミット（手順書の読者 = 次の PTP 側実装担当が実施）
- IF 契約書 30 本体の改訂（Base URL 乖離は注記 + 残課題として報告に含めるのみ）
- Vercel / Neon の実機操作（deploy 済前提。未 deploy なら `vercel-deploy.md` を先に完了）
- 監視・アラート（外形監視導入は別フェーズ）
- gRPC / Phase 2 オプションの検討

---

## 2. 想定コスト

### 実装工数（人間想定 × 2/3 のエージェント係数適用）

| 作業 | 人間想定 | 係数後 |
|---|---|---|
| `docs/operations/ptp-client-cutover.md`（env / コード調整 / 疎通 / 切り戻し / トラブルシュート） | 2.0h | 1.3h |
| `docs/operations/cutover-smoke-test.sh`（curl + status code 判定 / read-only 既定 / opt-in POST） | 1.5h | 1.0h |
| `README.md` 追記（導線 1 セクション） | 0.3h | 0.2h |
| ローカル検証（`bash -n` / shellcheck / docker ローカル API に対する実走 1 回） | 0.5h | 0.3h |
| **合計** | **4.3h** | **約 2.8h** |

### 月額運用実費

- **¥0**（Vercel Hobby / Neon Free / 既存構成のまま。新規 SaaS・新規依存なし）
- `cutover-smoke-test.sh --with-query` 実行時のみ OpenAI 実呼び出しが発生（`/rag/query` 1 回 ≒ $0.01 未満）。**既定は read-only モード**（LLM 課金ゼロ）で、課金を伴うテストは opt-in（§3 判断 3）

### 隠れコスト

- **secret の保管箇所が PTP 側に 2 個増える**: `API_BEARER_TOKEN` + Vercel Protection Bypass secret を PTP ホスト（Windows 11 運用）の env にも保持することになる。露出面の増加 → 手順書に保管ルール（パスワードマネージャ / `.env` git 管理外 / ログ出力禁止）を明記
- **cold start × Neon resume × PTP timeout 10 秒の干渉**: Vercel 関数 cold start（数秒）+ Neon Free compute resume（数秒）が重なると初回リクエストが IF 契約のクライアントタイムアウト 10 秒を超え得る。Bot 側はフォールバック契約（`TRAINING_HALT` / `DEGRADED_EXPLICIT`）で安全に縮退するが、**「切替直後はタイムアウトが増えて見える」** ことを手順書に明記しないと切り戻し誤判断を誘発する
- **bypass secret ローテーション時の同期箇所増**: 再発行で旧 secret 即無効 → PTP 側 env の更新を忘れると全リクエストが Vercel 401（HTML）になる。`vercel-deploy.md` §10 のローテーション手順に「PTP 側 env も更新」が事実上追加される（手順書で相互参照）
- **IF 契約書 30 §4.1 の Base URL 記載が古くなる**: 正本文書と実態の乖離。本フェーズでは注記で吸収し、30 の改訂は残課題

### ゼロコスト代替案

- **切替自体をしない（ローカル docker 継続）**: 追加コストゼロだが、SMB I/O 不安定で dev サーバが落ちる問題（本移行プロジェクトの起点）が未解決のまま。不採用
- **課金ゼロでの疎通確認**: スクリプト既定の read-only モード（`/health` + `GET /api/v1/rag/history`）が該当。DB 接続・認証・ルーティングまで LLM 課金なしで検証できるため、日常の疎通確認はこれで足りる

---

## 3. アーキテクチャ判断

### 判断 1: PTP 側の参照先切替方式 — env 変数 1 本切替を指示（コード分岐・プロキシ不採用）

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: Base URL を env 変数 1 本で切替（推奨）** | PTP 側の RAG client が読む base URL を env（例: `RAG_HUB_BASE_URL`）に外出しし、値を Vercel URL に差し替える | 切り戻しが「env を旧値に戻す」だけで完結。コード変更は base URL の env 化 + ヘッダ注入のみ | PTP 側に URL ハードコードがある場合、env 化リファクタが 1 回必要 |
| B: コード内で環境判定分岐（`if (prod) vercelUrl else localUrl`） | 分岐をコードに焼く | env 投入忘れに強い | 切替・切り戻しにコード変更 + 再ビルドが必要。分岐の存在自体が将来の事故面 |
| C: ローカルに reverse proxy を立てて転送 | PTP 側無変更で proxy が Vercel へ転送 | PTP 完全無改修 | 常駐 proxy という新規運用物が増える（月額ゼロ運用の管理コスト増）。ヘッダ注入を proxy に持たせると secret の置き場が増える |

**採用: A**。IF 契約 30 §4.1 も「`localhost:3000` 直書きは修正」方針であり、env 外出しは契約と整合。手順書には「PTP リポ内で base URL がどこに定義されているか」の discovery grep を含める（変数名を推測で断定しない / §4-1）。

### 判断 2: Vercel Standard Protection の通過方法 — Protection Bypass for Automation ヘッダを常時付与

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: `x-vercel-protection-bypass` ヘッダを PTP クライアントに常時付与（推奨）** | bypass secret を PTP 側 env に保持し、RAG Hub 向け全リクエストへ注入 | Vercel 公式の automation 向け正規ルート（[公式](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)）。Standard Protection を維持したままダブルロックが完全に効く | PTP 側の管理 secret が 1 個増える |
| B: Standard Protection を無効化し Bearer のみ運用 | 外側ロックを外す | secret 1 個で済む | **ダブルロック要件（ブリーフ確定事項）違反**。bypass secret 漏洩時と同じ状態を恒常化する。不採用 |
| C: OPTIONS Allowlist / Trusted IPs 等の例外設定 | Vercel 側で PTP からのアクセスだけ例外化 | ヘッダ注入不要 | Trusted IPs は Enterprise 限定。PTP ホスト（家庭回線想定）は固定 IP でなく成立しない。不採用 |

**採用: A**。Phase 3 の smoke-test と同じ通過方式であり、ヘッダ 2 本（bypass + Bearer）の注入を **PTP 側 RAG client の共通リクエスト層 1 箇所** に集約するよう手順書で指示する（散在させると付け忘れエンドポイントが事故面になる）。

### 判断 3: smoke-test スクリプトの課金設計 — read-only 既定 + `--with-query` opt-in

| 候補 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A: 既定は read-only（`/health` + `GET /api/v1/rag/history`）、POST `/rag/query` は `--with-query` フラグで opt-in（推奨）** | 認証 4 系列 + DB read 疎通を課金ゼロで判定。LLM 経路の end-to-end は明示フラグ時のみ | 何度でも気軽に再実行できる（切替直後・ローテーション後・障害切り分け）。課金が「意図した時だけ」発生 | LLM 経路の確認には 1 アクション余計に要る |
| B: 常に POST `/rag/query` まで実行 | 1 コマンドでフル検証 | 完全性 | 再実行のたびに LLM 課金 + DB 書込。「疎通確認」用途に対し過剰。Idempotency-Key 保持期間が 24h のため日を跨ぐ再実行は必ず再課金 |
| C: `/health` のみ | 最小 | 課金ゼロ | DB 接続（Neon）・`api/v1` ルーティング・guard の API 経路適用が未検証のまま。判定能力不足 |

**採用: A**。`GET /api/v1/rag/history` は read-only（Idempotency-Key 不要 / IF 契約 §4.7(d)）で、「Vercel ルーティング → guard 通過 → Nest bootstrap → Prisma → Neon」まで一気通貫で検証でき、判定能力と課金ゼロを両立する。`--with-query` 時は **固定 Idempotency-Key + 固定 payload** を使い、24h 内の再実行を replay（`idempotency_replayed: true` / 再課金なし）に倒す（§5 ガード 2）。

### 判断 4: スクリプトの依存 — bash + curl のみ（jq 不採用）

- 判定は `curl -s -o <body> -w "%{http_code}"` の **HTTP status code 比較を一次判定** とし、Content-Type の HTML/JSON 判別は `grep` で行う（smoke-test.md 判別表の「401 HTML = Vercel / 401 JSON = アプリ」を機械判定に落とす）
- jq は PTP ホスト（Windows 11 / Git Bash 等）に存在保証がないため使わない。**新規依存ゼロ**（macOS / Linux / Git Bash の標準ツールのみ）
- secret は環境変数経由で受け取り、**スクリプトが値を echo / set -x で出力しない**ことを構造的に保証する（`set -x` 禁止 / エラー表示は「未設定」の事実のみ）

---

## 4. ファイル別実装指示

### 4-1. `docs/operations/ptp-client-cutover.md`（新規 / PTP 側切替手順書）

- **目的**: PTP 側実装担当（または ふみさん本人）が、PTP リポの RAG クライアントを Vercel エンドポイントへ切り替え、疎通確認し、必要なら切り戻すまでを単独完走できる手順書
- **章立てと主要内容**:
  1. **前提確認**: `vercel-deploy.md` §1〜6 完了（Production URL 取得済 / migration 適用済）/ `smoke-test.md` の Test 1〜4 全通過済 / パスワードマネージャに `API_BEARER_TOKEN` + bypass secret 保管済
  2. **現状把握（discovery / PTP リポ側で実行）**: PTP 側の base URL 定義箇所と env 変数名を**推測せず実機 grep で特定**する手順。例:
     ```bash
     grep -rn "rag-api\|/api/v1/rag\|localhost:3000" --include="*.ts" --include="*.env*" <PTPリポルート>
     ```
     ヒット箇所を「env 定義 / クライアント実装 / docker-compose / テスト」に分類してから着手する（変更範囲の限定）
  3. **env 変更**: 以下 3 値を PTP 側 `.env`（git 管理外）に追加・変更。**変数名は discovery で判明した既存名を優先**し、新設する場合の推奨名を併記:
     - base URL（推奨名 `RAG_HUB_BASE_URL`）= `https://<project>.vercel.app`（**パス `/api/v1/rag` を含めるか否かは PTP 既存実装の結合方式に合わせる** — discovery 結果で決定）
     - Bearer（推奨名 `RAG_HUB_BEARER_TOKEN`）= Phase 3 の `API_BEARER_TOKEN` と同値
     - bypass（推奨名 `RAG_HUB_VERCEL_BYPASS`）= Protection Bypass for Automation secret
  4. **クライアントコード調整**: (a) base URL の env 読込化（ハードコード除去）、(b) **共通リクエスト層 1 箇所**への `Authorization: Bearer` + `x-vercel-protection-bypass` ヘッダ注入（判断 2）、(c) https 化に伴う注意（証明書検証を無効化しない）、(d) timeout 10 秒・Idempotency-Key・フォールバック 2 択契約（IF 契約 30 §4〜5）は**変更しない**ことの明記、(e) 認証は JWT でなく静的共有トークンである旨（§1 契約差異）
  5. **疎通確認**: 本リポの `docs/operations/cutover-smoke-test.sh` を PTP ホストへコピーして実行（read-only 既定 → 通過後に `--with-query` 1 回）。その後 PTP 側アプリ経由の実呼び出し 1 件で `meta.trace_id` が返ることを確認
  6. **ウォームアップと初回タイムアウト**: Neon auto-suspend + cold start の干渉（§2 隠れコスト）。Bot 連続実行前に `/health` を 1 発叩いて warm にする運用と、初回 `TRAINING_HALT` / `DEGRADED_EXPLICIT` 縮退が**正常動作**であることを明記
  7. **切り戻し手順**: env 3 値を旧値（ローカル docker URL / ヘッダ 2 値は空）に戻す → PTP 再起動 → ローカル docker（`npm run docker:up` + `npm run dev`）疎通確認。**コード変更の revert は不要**な構成（ヘッダ注入は値が空なら無害に付与スキップする実装を 4 章で指示）
  8. **トラブルシュート**: `smoke-test.md` §6 判別表を PTP 視点に再掲（401 HTML = bypass 不一致 / 401 JSON = Bearer 不一致 / 503 = サーバ側 env 不備 / timeout = cold start・Neon resume / 404 = base URL のパス結合ミス）
- **secret の取扱**: 手順書に実値・サンプル実値を一切書かない（プレースホルダ `<…>` のみ）
- **引用すべき外部ドキュメント**: [Vercel Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) / [Neon: Scale to zero](https://neon.tech/docs/introduction/scale-to-zero) / RFC 6750（Bearer 形式）

### 4-2. `docs/operations/cutover-smoke-test.sh`（新規 / 疎通確認スクリプト雛形）

- **目的**: Vercel エンドポイントへの疎通を curl + 期待 status code 判定で機械化する。`smoke-test.md`（手動 copy & paste）のスクリプト版で、PTP ホストからも本リポからも実行可能
- **入力（環境変数 / 引数で値を渡さない = ps・シェル履歴への露出回避）**:
  - `BASE_URL`（必須）/ `RAG_API_TOKEN`（必須）/ `VERCEL_BYPASS_SECRET`(必須)
  - 未設定時は「どの変数が未設定か」**のみ**表示して exit 2（値のヒントを出さない）
- **テスト系列**（既定 = read-only / 判断 3）:
  | # | リクエスト | 期待 |
  |---|---|---|
  | T1 外側ロック | ヘッダなし `GET /health` | `401` or `30x`（**200 なら FAIL** = Protection 無効） |
  | T2 内側ロック | bypass のみ `GET /health` | `401` + body が JSON（`grep -q '"statusCode"'` 等で HTML でないこと） |
  | T3 不正トークン | bypass + `Bearer wrong-token` | `401` + JSON |
  | T4 正常系 liveness | bypass + 正 Bearer `GET /health` | `200` + `"status":"ok"` |
  | T5 DB read 疎通 | bypass + 正 Bearer `GET /api/v1/rag/history` | `200`（Neon 接続 + api/v1 ルーティング確認 / LLM 課金なし） |
  | T6 (opt-in) LLM 経路 | `--with-query` 時のみ bypass + 正 Bearer `POST /api/v1/rag/query`（**固定 Idempotency-Key + 固定 payload**） | `200` or `4xx`（401/503 でなければ PASS / 2 回目以降は replay） |
- **主要ロジック**:
  1. `#!/usr/bin/env bash` + `set -u`（`set -e` は curl 非 2xx で死なないよう使わず、`set -x` は禁止）
  2. 各テストは `status=$(curl -s -o "$tmpbody" -w "%{http_code}" --max-time 30 ...)` → 期待値比較 → `PASS/FAIL` を行単位出力。**レスポンス body・ヘッダ値・トークン値は標準出力に出さない**（FAIL 時も status と Content-Type 種別のみ）
  3. T1 の初回は cold start を兼ねるため `--max-time 30`（PTP 本番 client の 10 秒とは別物である旨コメント）
  4. 一時 body ファイルは `mktemp` で作成し `trap ... EXIT` で削除（body に excerpt 等が残置されない）
  5. 集計: `passed/failed` 件数表示 → 全 PASS = exit 0 / 1 件でも FAIL = exit 1 / 変数・引数不備 = exit 2
  6. `--with-query` の Idempotency-Key は `cutover-smoke-${BASE_URL のホスト名}-v1` のような **実行日時を含まない安定値**（§5 ガード 2。`date +%s` を入れると毎回新規実行 = 毎回課金）
- **実行権限**: `chmod +x`。冒頭コメントに用途・必要 env・exit code 契約・実行例（`read -s` での env 投入例）を記載
- **引用すべき外部ドキュメント**: [curl -w write-out](https://curl.se/docs/manpage.html#-w)（status code 取得の根拠）/ `smoke-test.md` §6 判別表（期待値の正本）

### 4-3. `README.md`（追記）

- 既存「## 設計書」セクションの直前に「## PTP 側切替（cutover）」を追記（**既存行の変更なし / 追記のみ**）
- 内容 3〜5 行: 「PTP 側 RAG クライアントの参照先を Vercel へ切り替える手順は `docs/operations/ptp-client-cutover.md` を参照 / 疎通確認は `docs/operations/cutover-smoke-test.sh`（read-only 既定 / `--with-query` で LLM 経路まで）」

---

## 5. 冪等性ガード（実装必須項目）

成果物はドキュメント 2 + シェルスクリプト 1。DB スキーマ変更・サーバコード変更なし。ただし **スクリプトの T6（opt-in POST）はサーバ側に書込・課金を発生させ得る**ため、以下をガードとして実装必須とする:

| # | ガード | 実装箇所 | 状態 |
|---|---|---|---|
| 1 | 既定実行は read-only（GET のみ / 書込・課金経路に到達しない） | `cutover-smoke-test.sh` 既定モード | 🆕 本フェーズ実装。`--with-query` なしで POST が 1 本も飛ばないこと |
| 2 | T6 の Idempotency-Key を**安定値**（タイムスタンプ非含有）+ **固定 payload** にする → 24h 内の再実行はサーバ側 idempotency 契約（IF 30 §4.4）で replay / 再課金なし | 同上 `--with-query` パス | 🆕 本フェーズ実装。key に `$(date +%s)` 等を**入れない**（入れると再実行ごとに新規 LLM 課金 = ガード無効化） |
| 3 | サーバ側 idempotency（部分 UNIQUE + payload hash 照合） | 既存実装（rag_queries / B1 制約） | ✅ 既存。スクリプトは「正しく乗る」だけ。**実装フェーズで T6 を 2 連続実行し `idempotency_replayed: true` を実機確認**してから手順書に記載する（外部仕様の実機検証なし固定の禁止 / 盲点 8） |
| 4 | 手順書（手作業）の再実行安全性: env 変更は上書き / 切り戻しは旧値再設定のみで副作用なし / bypass secret 再発行は旧値即無効（再発行したら PTP 側 env も差し替え）を明記 | `ptp-client-cutover.md` | 🆕 本フェーズ実装（記載義務） |

---

## 6. テストすべき観点（後続テスト担当向け）

スクリプトは外部 URL 依存のため、自動テストは構文・静的検査 + ローカル API（docker）に対する実走で行う:

- **構文・静的**: `bash -n cutover-smoke-test.sh` が通る / shellcheck（導入済なら）で error 0 件 / `set -x` がファイル内に存在しない（grep）
- **env ガード**: `BASE_URL` 等を 1 つずつ未設定にして実行 → exit 2 + 「未設定の変数名のみ」表示（**値・ヒントが出ない**こと）
- **secret 非出力**: 全テスト PASS / FAIL 両ケースで標準出力・標準エラーに `RAG_API_TOKEN` / `VERCEL_BYPASS_SECRET` の値が**一切現れない**こと（出力を grep で検査）
- **exit code 契約**: 全 PASS = 0 / 1 件 FAIL = 1（ローカル API に対し故意に wrong token を正トークンとして渡して検証）/ env 不備 = 2
- **read-only 保証**: 既定実行の前後で `rag_queries` / `rag_ingestion_jobs` の行数が不変（docker postgres で確認）— ガード 1 の検証
- **T6 replay**: `--with-query` を同一 env で 2 連続実行 → 2 回目のレスポンスで replay されること（ガード 2 / 3 の検証。ローカル API + Stub provider でも検証可能なら課金ゼロで確認）
- **negative control**: T1 の期待を意図的に `200` に書き換えた改変版が FAIL を返すこと（判定ロジックが「常に PASS」になっていないことの確認 / 自己制約 4 の精神）
- **一時ファイル**: 実行後に `mktemp` の body ファイルが残置されないこと（`trap` 検証）
- **手順書**: `ptp-client-cutover.md` 内の grep コマンド・curl 例が構文として実行可能 / 実値 secret・実値らしきプレースホルダが含まれない（`sk-` / 64 桁 hex 等を grep）

---

## 7. レビュー観点

### architecture reviewer

- [ ] 判断 1（env 1 本切替）が PTP 側の改修最小・切り戻し最速になっているか。コード分岐 / proxy を退けた根拠の妥当性
- [ ] 判断 2（bypass ヘッダ常時付与）がダブルロック要件を維持しているか。「Protection 無効化」へ誘導する記述が手順書に混入していないか
- [ ] PTP リポ非アクセス制約が守られているか（手順書が「PTP 側で実行する手順」の記述に徹し、本リポ成果物が PTP 実体を推測断定していないか / discovery ステップの有無）
- [ ] IF 契約 30 との整合: パス・Idempotency-Key・timeout 10 秒・フォールバック 2 択を**変えない**指示になっているか / Base URL 乖離と JWT→静的トークン差異が注記されているか
- [ ] スクリプトの責務が「疎通判定」に閉じているか（deploy 操作・env 書換等の副作用を持たないこと）

### quality reviewer

- [ ] 冪等性ガード表（§5）の 🆕 3 項目が実装に 1 件ずつ落ちているか（T6 の Idempotency-Key に timestamp が混入していないかは**最重要**）
- [ ] secret 非出力: スクリプトの全出力経路（PASS/FAIL 表示・エラー・trap）にトークン値・bypass 値が現れないか / `set -x` 不在
- [ ] exit code 契約（0/1/2）と判定ロジックの fail-closed（curl 自体の失敗 = `000` を PASS 扱いしていないか）
- [ ] T1 の「200 なら FAIL」が実装されているか（外側ロック消失の検出が本スクリプトの最重要判定）
- [ ] 手順書のトラブルシュートが cold start / Neon resume 起因のタイムアウトを「切り戻し事由」と誤読させない書き方か
- [ ] 自己制約 3: claim-first トリガー（Idempotency-Key / replay 言及）に該当 → §5 ガード表との対照確認を実施
- [ ] 自己制約 4 観点: T6 replay の「実機確認してから手順書記載」（§5 ガード 3）が守られているか — 仕様書のみを根拠に replay 挙動を断定していないか

### 両 reviewer 共通

- [ ] 新規 npm 依存・新規ツール依存（jq 等）がゼロであること
- [ ] diff が Phase 5 スコープ（docs 2 + sh 1 + README 追記）に閉じているか（サーバコード・PTP リポ・他フェーズ文書への無関係変更がないか）
- [ ] README 追記が既存行を変更していないか（追記のみ規約）

---

## 付記: 実装フェーズへの引き継ぎメモ

- 実装順の推奨: `cutover-smoke-test.sh`（ローカル docker API で実走検証可能）→ `ptp-client-cutover.md`（スクリプトの実出力を手順書に反映）→ README 追記
- ローカル検証時は `BASE_URL=http://localhost:3000` + bypass ヘッダは無視される（Vercel 外）ため、T1 が「200 = FAIL」になるのは**正しい**（ローカルには外側ロックがない）。ローカルでは T2〜T5 のみ検証し、T1 は Vercel 実機でのみ PASS する旨をスクリプトコメントに明記
- `--with-query` の replay 実機確認（§5 ガード 3）は、ローカル docker + Stub provider 構成で先に通し、Vercel 実機での確認はふみさんの cutover 実施時に手順書ステップとして実行してもらう
- 残課題（完了報告に含める）: IF 契約書 30 §4.1 の Base URL 記載改訂（別チケット推奨）/ 外形監視導入時の `/health` 無認証化（Phase 3 判断 2 案 B への拡張）
