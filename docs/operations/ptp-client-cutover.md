# PTP 側 RAG クライアント — Vercel エンドポイントへの切替手順（cutover）

- 作成日: 2026-06-11
- 対象読者: PTP（Personal Multi Trading Platform / **別リポジトリ**）側の実装担当 / ふみさん本人
- 目的: PTP 側 RAG クライアントが参照する RAG Hub のエンドポイントを、ローカル docker（`http://rag-api:3000` / `localhost:3000`）から **Vercel Production URL**（`https://<project>.vercel.app`）へ切り替える
- 関連設計書:
  - `docs/operations/phase-5-design.md`（本フェーズ設計書）
  - `docs/operations/vercel-deploy.md` / `docs/operations/smoke-test.md`（RAG Hub 側 deploy / 疎通確認）
  - `docs/operations/cutover-smoke-test.sh`（Vercel エンドポイント機械疎通確認スクリプト / 本手順書 §5 で実行）
  - PTP リポ `docs/design_and_RD/30_RAGサービスIF契約・疎結合境界定義書.md`（IF 契約 / 本手順で変更しない部分）

---

## 0. 重要な前提（読み飛ばし注意）

### 本手順書は PTP リポへ書き込まない

本手順書は **本リポ（training-bot-rag-hub）** に置かれた「PTP 側で実行すべき差分の手順書」です。PTP リポの env 変数名・クライアント実装の実体は本手順書作成時点で **未検証**（推測禁止）です。**§2 の discovery ステップを必ず最初に実行**し、実機 grep で base URL 定義箇所と既存 env 変数名を特定してから着手してください。

### 認証方式の契約差異（誤解防止）

PTP リポ `docs/design_and_RD/30_RAGサービスIF契約・疎結合境界定義書.md` §4.2 は `Authorization: Bearer {jwt}` と記載していますが、**Phase 3 の MVP 実装は JWT ではなく単一共有の静的トークン**（`API_BEARER_TOKEN`）です。ヘッダ形式は同一のため PTP 側の送信実装は変わりませんが、**JWT を採番・検証する仕組みは RAG Hub 側に存在しません**。JWT ライブラリを新規導入しないでください。

### 変更しないもの（IF 契約 30 維持）

- パス（`/api/v1/rag/query` / `/bot-context` / `/similar-cases` / `/history`）
- `Idempotency-Key` の付与方式と保持期間（24h）
- client timeout 10 秒（30 §5）
- フォールバック 2 択契約（`TRAINING_HALT` / `DEGRADED_EXPLICIT`）
- リクエスト/レスポンス JSON 契約

→ **変わるのは URL のホスト部とヘッダ 2 本（Authorization + x-vercel-protection-bypass）のみ**です。

### 切替前提

- RAG Hub 側で `vercel-deploy.md` §1〜§6 完了済（Production URL 取得済 / Migration 適用済）
- RAG Hub 側で `smoke-test.md` Test 1〜4 全通過済
- パスワードマネージャに以下 2 値が保管されている:
  - `API_BEARER_TOKEN`（RAG Hub アプリ側の Bearer / Phase 3 で発行）
  - Vercel Protection Bypass for Automation secret（`vercel-deploy.md` §4 で発行）

---

## 1. 全体像（30 秒サマリ）

```
[切替前]  PTP client ─→ http://rag-api:3000/api/v1/rag/*  （ローカル docker）
                       ヘッダ: Authorization のみ（or 無し）

[切替後]  PTP client ─→ https://<project>.vercel.app/api/v1/rag/*  （Vercel）
                       ヘッダ: Authorization: Bearer <API_BEARER_TOKEN>
                              x-vercel-protection-bypass: <Vercel bypass secret>
```

**切り戻し**: env 3 値を旧値に戻すだけ（コード revert 不要）。

---

## 2. 現状把握（discovery / PTP リポ側で最初に実行）

PTP リポの **base URL 定義箇所と env 変数名を、推測せず実機 grep で特定**します。これを省略するとハードコード除去漏れ・変数名重複・既存規約との衝突が起きます。

### 2-1. base URL / パスの定義箇所を全列挙

PTP リポのルートで実行:

```bash
# base URL ハードコード or env 参照箇所
grep -rn "rag-api\|localhost:3000\|/api/v1/rag" \
  --include="*.ts" --include="*.tsx" --include="*.js" \
  --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="*.env*" --include="Dockerfile*" --include="docker-compose*" \
  --include="*.md" \
  .

# 既存 env 変数の命名規約確認
grep -rn "^RAG_\|^TRAINING_BOT_\|^HUB_" --include="*.env*" --include="*.ts" .
```

### 2-2. 分類する（着工前 / 変更範囲を限定するため）

discovery 結果を以下 4 分類に振り分けます:

| 分類 | 例 | 本手順での扱い |
|---|---|---|
| **env 定義** | `.env.example` / `.env.local` / `config.ts` の `process.env.XXX` 読込 | §3 で値を差し替え |
| **クライアント実装** | `apps/api/src/.../rag-client.ts` 等の `fetch` / `axios` / `got` 使用箇所 | §4 で base URL の env 化 + ヘッダ注入 |
| **docker-compose / Dockerfile** | `services.rag-api` / `depends_on` / `RAG_HUB_*=http://...` | 切替後はローカル docker RAG を **起動しない**運用に。ただし参照は残置可（旧値に戻せるよう） |
| **テスト / mock** | `__mocks__/rag-client.ts` / 単体テスト fixture | 触らない（テストは別 base URL で完結） |

### 2-3. 既存 env 変数名がある場合は流用

discovery で既存変数（例: `RAG_API_URL` / `RAG_BASE_URL` / `TRAINING_BOT_RAG_ENDPOINT` 等）が見つかった場合は、**既存名をそのまま流用**して値だけ差し替えてください。本手順書では「新設するならこの名前」という推奨名のみ提示します（後段 §3）。

---

## 3. env 変更（PTP 側）

### 3-1. 値の整理

| 役割 | 推奨新設変数名（既存なければ） | 値（cutover 後） | 値（切り戻し時 / 旧値） |
|---|---|---|---|
| base URL | `RAG_HUB_BASE_URL` | `https://<project>.vercel.app` | `http://rag-api:3000`（docker-compose 内）or `http://localhost:3000`（host から） |
| Bearer | `RAG_HUB_BEARER_TOKEN` | RAG Hub 側 `API_BEARER_TOKEN` と**同値** | （空 / 未設定 / 旧来の値） |
| Vercel bypass | `RAG_HUB_VERCEL_BYPASS` | `vercel-deploy.md` §4 で発行した secret | （空 / 未設定） |

### 3-2. base URL に `/api/v1/rag` パスを含めるかは既存実装の結合方式に合わせる

PTP 既存クライアントが `${RAG_BASE_URL}/api/v1/rag/query` のようにパスを結合しているなら、env には **ホスト部のみ**（`https://<project>.vercel.app`）を設定。
逆に `${RAG_BASE_URL}/query` のように **prefix 込み**で結合しているなら env に `https://<project>.vercel.app/api/v1/rag` を設定。

→ §2 discovery のクライアント実装側コードを 1 箇所読んで判断してください。**両方を試すような実験はせず、discovery で確定**してから書き換えます。

### 3-3. env の保管箇所

- PTP 側 `.env`（git 管理外 / `.gitignore` 確認必須）に追記
- 値はパスワードマネージャに**先**に保管 → コピペで `.env` に書く
- `.bashrc` / `.zshrc` / dotfiles に書かない（他環境へコピー時に露出する）
- ログ出力経路から完全に除外（`console.log(process.env)` 系がないこと）

---

## 4. クライアントコード調整（PTP 側）

§2 で特定したクライアント実装に対し、以下 4 点を反映します。**共通リクエスト層 1 箇所に集約**してください（各エンドポイント毎にヘッダを散在させると付け忘れが事故面になる）。

### 4-1. base URL のハードコード除去 + env 読込化

```ts
// before (例)
const RAG_URL = "http://rag-api:3000/api/v1/rag";

// after (例 / 既存パス結合に合わせる)
const RAG_BASE_URL = process.env.RAG_HUB_BASE_URL;
if (!RAG_BASE_URL) {
  throw new Error("RAG_HUB_BASE_URL is not set");
}
```

### 4-2. 共通リクエスト層でヘッダ 2 本を注入

```ts
// 例: 既存の fetch wrapper / axios instance 等の共通層 1 箇所で
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  // Idempotency-Key は IF 契約 30 §4.4 通り呼出側で生成して付与（既存実装維持）
};

// 切替後のヘッダ 2 本を「値が空でなければ」付与する
// → 切り戻し時に env を空にすれば自動的に外れる構造（コード revert 不要）
const bearer = process.env.RAG_HUB_BEARER_TOKEN;
if (bearer) {
  headers["Authorization"] = `Bearer ${bearer}`;
}
const bypass = process.env.RAG_HUB_VERCEL_BYPASS;
if (bypass) {
  headers["x-vercel-protection-bypass"] = bypass;
}
```

> **注**: 「値が空なら付与しない」実装にすることで、**切り戻し時に env を空に戻すだけ**でローカル docker 構成（ヘッダ不要）に戻せます。コード自体の revert は不要です。

### 4-3. https 化に伴う注意

- 証明書検証を**無効化しない**（`rejectUnauthorized: false` 等を入れない）
- Vercel は有効な証明書を提供。証明書エラーが出るなら CA bundle や OS 時刻を疑う

### 4-4. 変更しないもの（IF 契約 30 維持）

- `Idempotency-Key` 付与（24h 内 replay 動作も維持）
- client timeout 10 秒（IF 30 §5）
- フォールバック 2 択契約（タイムアウト / 異常時の `TRAINING_HALT` / `DEGRADED_EXPLICIT` 縮退）
- リクエスト/レスポンス JSON 契約
- 認証は **JWT ではなく静的共有トークン**（§0 契約差異）→ JWT 採番/検証コードを新規追加しない

---

## 5. 疎通確認

### 5-1. cutover-smoke-test.sh をコピーして実行

本リポ `docs/operations/cutover-smoke-test.sh` を **PTP ホスト**にコピーし（または本リポ clone から直接実行）、以下を流します:

```bash
export BASE_URL="https://<project>.vercel.app"
read -s -p "RAG_API_TOKEN: " RAG_API_TOKEN; echo
export RAG_API_TOKEN
read -s -p "VERCEL_BYPASS_SECRET: " VERCEL_BYPASS_SECRET; echo
export VERCEL_BYPASS_SECRET

# read-only 既定（LLM 課金ゼロ / 何度でも気軽に再実行可）
bash cutover-smoke-test.sh
# 期待: 全 PASS (T1〜T5) / exit 0

# LLM 経路まで end-to-end（24h 内の再実行は replay = 再課金なし）
bash cutover-smoke-test.sh --with-query
# 期待: 全 PASS (T1〜T6) / exit 0
```

### 5-2. PTP 側アプリ経由の実呼び出し 1 件

スクリプト全 PASS 後に、PTP 側アプリから RAG client を実呼び出しして:

- レスポンスに `meta.trace_id` が返ること
- `Idempotency-Key` が正しく付与されていること（アプリログで確認）
- フォールバック契約に意図せず落ちていないこと（`TRAINING_HALT` / `DEGRADED_EXPLICIT` ではなく実応答）

### 5-3. secret 取扱（再掲）

- スクリプト出力に secret 値が**一切現れないこと**を確認（grep で念押し可能）
- 全テスト完了後、`fc -p` 等でシェル履歴をクリーンアップ

---

## 6. ウォームアップと初回タイムアウトの扱い（重要 / 誤判断防止）

### Neon auto-suspend + Vercel cold start の干渉

- Neon Free は compute がアイドルで suspend → 初回リクエストで resume に数秒
- Vercel Hobby も cold start で数秒
- 両者が重なると **初回リクエストが IF 契約 30 §5 のクライアント timeout 10 秒を超え得る**

### 正常動作と異常の見分け方

| 症状 | 判定 |
|---|---|
| 切替直後の初回 1〜2 リクエストが timeout → 以降は安定 | **正常**（cold start / Neon resume）。Bot 側は `TRAINING_HALT` / `DEGRADED_EXPLICIT` で安全に縮退 → 復帰 |
| timeout が連続発生し続ける（10 件以上） | **異常**。§8 トラブルシュート参照 |

### 運用上のウォームアップ

Bot 連続実行を開始する前に、`/health` を 1 発叩いて warm 状態にしてから運用開始するのが安全です:

```bash
curl -s -o /dev/null -w "warmup: %{http_code} (%{time_total}s)\n" \
  -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}" \
  -H "Authorization: Bearer ${RAG_API_TOKEN}" \
  --max-time 30 \
  "https://<project>.vercel.app/health"
```

「切替直後はタイムアウトが増えて見える」のは正常動作です。**これだけを理由に切り戻し判断をしないでください**。

---

## 7. 切り戻し手順（rollback）

切り戻し条件（例）: Vercel 側に恒久的な不具合 / RAG Hub deploy の重大欠陥 / secret 露出インシデント。

### 7-1. env を旧値に戻す

PTP 側 `.env` を以下のいずれかに戻す:

| 変数 | 旧値（戻し先） |
|---|---|
| `RAG_HUB_BASE_URL`（既存名がある場合はそれ） | `http://rag-api:3000`（docker-compose 内）or `http://localhost:3000`（host から） |
| `RAG_HUB_BEARER_TOKEN` | 空 / 未設定 / 旧来の値 |
| `RAG_HUB_VERCEL_BYPASS` | 空 / 未設定 |

§4-2 の「値が空ならヘッダ付与しない」実装になっていれば、env を空にするだけでローカル構成に整合します。

### 7-2. ローカル RAG Hub を起動

本リポ側で:

```bash
npm run docker:up
npm run dev
```

### 7-3. PTP 側再起動 + 疎通確認

```bash
# PTP 側アプリ再起動（env 反映）
# その後 RAG 実呼び出し 1 件で meta.trace_id が返ることを確認
```

### 7-4. コード revert は不要

§4-2 の構造（env 空 → ヘッダ自動省略）により、**コード変更の revert は不要**です。env 操作のみで完結します。

### 7-5. bypass secret ローテーション時の同期

`vercel-deploy.md` §10 で Vercel Protection Bypass secret を再発行した場合、**再発行と同時に旧 secret は即無効化**されます。PTP 側 `RAG_HUB_VERCEL_BYPASS` も**同じタイミング**で新 secret に差し替えてください。

→ 同期忘れの症状: 全リクエストが `401` + HTML（Vercel 側で止まっている）

---

## 8. トラブルシュート（判別表）

`smoke-test.md` §6 判別表を PTP 視点で再掲:

| 症状（status + Content-Type） | 真因 | 一次対処 |
|---|---|---|
| `401` + HTML（`_vercel_sso` 等が含まれる） | Vercel 側で 401（bypass secret 不一致 / ヘッダ名 typo / secret ローテ後の同期忘れ） | `RAG_HUB_VERCEL_BYPASS` の値と、送信ヘッダ名 `x-vercel-protection-bypass` を確認 |
| `401` + JSON | アプリ側で 401（Bearer 不一致 / 欠落 / scheme typo） | `RAG_HUB_BEARER_TOKEN` の値、`Authorization: Bearer <値>` 形式を確認 |
| `503` + JSON | RAG Hub サーバ側 env 不備（`API_BEARER_TOKEN` 未投入 / 空） | RAG Hub 側 Vercel Project Settings → Environment Variables を確認 |
| `404` | base URL のパス結合ミス（§3-2 / `/api/v1/rag` 二重結合 or 欠落） | discovery 結果と base URL 値の整合を再確認 |
| `timeout` 連発（初回 1〜2 件は §6 通り正常） | cold start / Neon resume / 経路障害 | `/health` の warmup を 1 件入れてから再試行。連続継続なら Vercel ダッシュボード → Functions ログ確認 |
| `500` | bootstrap 失敗（DB / Prisma / OpenAI 初期化エラー） | Vercel 関数ログで `[vercel-handler]` プレフィックスのスタックを確認 |
| `502 / 504` | タイムアウト or cold start 失敗（Hobby plan 制限） | 再リクエスト / 関数ログで初期化遅延確認 |

---

## 9. 再実行安全性（冪等性ガード）

本手順書および `cutover-smoke-test.sh` は以下の冪等性ガードを満たします:

| ガード | 内容 | 該当箇所 |
|---|---|---|
| read-only 既定 | スクリプト既定実行は GET のみ。書込・LLM 課金経路に到達しない | `cutover-smoke-test.sh`（`--with-query` なし） |
| 安定 Idempotency-Key | `--with-query` 時の key は `cutover-smoke-<host>-v1` 固定。タイムスタンプを混入させない | `cutover-smoke-test.sh` T6 |
| サーバ側 idempotency | 部分 UNIQUE + payload hash 照合（RAG Hub 既存実装） | RAG Hub 側 `rag_queries` テーブル B1 制約 |
| env 操作の冪等性 | env 変更は値の上書き / 切り戻しは旧値再設定のみで副作用なし | §3 / §7-1 |
| bypass ローテ同期 | 再発行と同時に旧 secret は即無効。PTP 側 env も即差し替え | §7-5 |

`--with-query` を **24h 以内に 2 回連続実行**しても、サーバ側 idempotency 契約（IF 30 §4.4）により 2 回目以降は replay されることを期待しています（`idempotency_replayed: true` / 再課金なし / 設計書 §5 ガード 3）。

### ⚠ 実機検証ステータス: **未検証（PTP cutover 当日に smoke-test スクリプトで検証）**

本手順書および本セクションの冪等性ガードは、**training-bot-rag-hub 側の設計上の期待値**であって、PTP クライアントとの結合状態での実機検証は本ドキュメント時点で **未完了**です（PTP リポは別リポ + 別環境で、本ワークフロー時点でアクセスしていません / 過去ドラフトに「実機検証済」と記載していたのは誤りであり、本改訂で訂正しました）。

> **重要**: 本手順書は training-bot-rag-hub 側の改修と整合性が取れているという前提で書かれていますが、PTP リポ側の実装状態 / env 命名 / クライアント実装の差異は未検証です。cutover 当日は `cutover-smoke-test.sh` の実走結果を正とし、本手順書を鵜呑みにしないこと。判別表（§8）と実 status code が食い違ったら、**手順書ではなく実機の挙動が真**として扱う。

cutover 当日の検証チェックリスト:

- [ ] `cutover-smoke-test.sh`（read-only）が exit 0
- [ ] `cutover-smoke-test.sh --with-query` 1 回目: status 200 / `idempotency_replayed: false`（または初回のためフィールド無）
- [ ] `cutover-smoke-test.sh --with-query` 2 回目（同日内）: status 200 / `idempotency_replayed: true`
- [ ] PTP アプリ経由の実呼び出し 1 件で `meta.trace_id` が返り、RAG Hub 側ログにも同 trace_id が記録されている
- [ ] 検証結果を `.company/engineering/` の cutover 完了 decision ファイルに記録（実機検証ログ付き）

---

## 10. 完了基準

以下すべてが満たされたら cutover 完了:

- [ ] §2 discovery 完了（base URL 定義箇所と既存変数名を特定）
- [ ] §3 env 3 値を PTP 側 `.env` に設定（既存変数名がある場合は流用）
- [ ] §4 クライアントコード調整完了（base URL env 化 + 共通層ヘッダ注入）
- [ ] §5 `cutover-smoke-test.sh` が exit 0（read-only / `--with-query` 双方）
- [ ] §5 PTP アプリ経由の実呼び出し 1 件で `meta.trace_id` が返る
- [ ] §6 ウォームアップ運用と「初回 timeout は正常」を運用者が理解
- [ ] §7 切り戻し手順（env 旧値復元）を運用者が把握
- [ ] ローカル docker（RAG Hub）は停止 or 起動可能状態として保持（即切り戻せる構成）

---

## 11. 参考リンク

- [Vercel — Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
- [Neon — Scale to zero](https://neon.tech/docs/introduction/scale-to-zero)
- [RFC 6750 — The OAuth 2.0 Authorization Framework: Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
- 本リポ `docs/operations/vercel-deploy.md` / `smoke-test.md` / `phase-5-design.md`

---

## 付記: 残課題（cutover 完了後に着手推奨）

- **IF 契約書 30 §4.1 の Base URL 記載改訂**: 現在の `http://rag-api:3000/api/v1/rag` 記載が cutover 後に実態と乖離。PTP 側 PR で別チケット化を推奨
- **外形監視導入時の `/health` 無認証化**: 現在は `/health` も Bearer 必須（Phase 3 判断）。外形監視 SaaS を入れる際に `/health/public` の追加を検討
