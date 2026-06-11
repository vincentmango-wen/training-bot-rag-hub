# Vercel deploy 後の smoke-test（Phase 3）

- 作成日: 2026-06-11
- 対象: training-bot-rag-hub（Vercel deploy 後の疎通確認）
- 関連: `docs/operations/vercel-deploy.md` / `docs/operations/phase-3-design.md`
- 目的: ダブルロック（Vercel Authentication + アプリ側 Bearer）が両方効いていることを **4 系列の curl** で実機確認

## 0. 前提

- `vercel-deploy.md` §1〜§6 を完了済（Production URL を取得済 / 環境変数投入済 / Migrate 適用済）
- ローカルに `curl` が叩ける（macOS 標準）
- パスワードマネージャに以下 2 値を保管済:
  - `API_BEARER_TOKEN`（アプリ側ロックの値）
  - Vercel Protection Bypass secret（外側ロックを curl で迂回するための値）

---

## 1. 変数準備

シェルセッションに以下を export する。**シェル履歴に残さないため `read -s` 推奨**:

```bash
# BASE_URL は履歴に残ってよい（公開 URL）
export BASE_URL="https://<your-project>.vercel.app"

# Bypass secret は履歴に残さない
read -s -p "Vercel Protection Bypass secret: " BYPASS_SECRET; echo
export BYPASS_SECRET

# Bearer Token も履歴に残さない
read -s -p "API_BEARER_TOKEN: " API_TOKEN; echo
export API_TOKEN
```

> ⚠️ 別ターミナル / 別ホストに switch するときは再度 export し直す。`.bashrc` / `.zshrc` には書かない（dotfiles が他環境にコピーされたとき露出する）。

---

## 2. Test 1 — 外側ロック確認（無認証 → Vercel 401）

**目的**: Vercel Standard Protection が有効で、無認証アクセスを遮断していることを確認。

```bash
curl -i -X GET "${BASE_URL}/health"
```

### 期待

- **Status**: `HTTP/2 401`（または `HTTP/2 302` で SSO リダイレクト）
- **Content-Type**: `text/html` 系
- **Body**: Vercel の SSO ログイン HTML / リダイレクト（`_vercel_sso_nonce` など Vercel 由来の文字列が混じる）

### NG パターンと対処

| 返ってきたもの | 真因 | 対処 |
|---|---|---|
| `HTTP/2 200` + JSON `{"status":"ok",...}` | Standard Protection が効いていない | `vercel-deploy.md` §4 を再確認。Project Settings → Deployment Protection の状態をチェック |
| `HTTP/2 401` + JSON | Vercel 側を素通りしてアプリの 401 が返っている = 外側ロック未適用 | 同上 |
| `HTTP/2 404` | ルーティング設定（`vercel.json`）の問題 | Build Logs / `vercel.json` の routes を確認 |

---

## 3. Test 2 — 内側ロック確認（bypass のみ → アプリ 401 / JSON）

**目的**: Vercel 側を bypass で抜けたあと、アプリの BearerTokenGuard が無認証を遮断していることを確認。

```bash
curl -i -X GET "${BASE_URL}/health" \
  -H "x-vercel-protection-bypass: ${BYPASS_SECRET}"
```

### 期待

- **Status**: `HTTP/2 401`
- **Content-Type**: `application/json`
- **Body**: NestJS の標準 401 JSON（`{"statusCode":401,"message":"Invalid or missing bearer token","error":"Unauthorized"}` 系 / メッセージは固定文言）

### NG パターンと対処

| 返ってきたもの | 真因 | 対処 |
|---|---|---|
| `HTTP/2 401` + HTML | bypass secret が間違っている → Vercel 側で止まっている | secret の値・ヘッダ名 `x-vercel-protection-bypass` の typo を確認 |
| `HTTP/2 200` | guard が登録されていない | `apps/api/src/app.module.ts` で APP_GUARD provider が `BearerTokenGuard` を指しているか確認 |
| `HTTP/2 503` | `API_BEARER_TOKEN` が Vercel 環境変数に投入されていない | `vercel-deploy.md` §3 を再確認 |

---

## 4. Test 3 — 不正トークン（bypass + 不正 Bearer → アプリ 401 / JSON）

**目的**: トークン照合が機能していること、scheme / 値の typo を弾けることを確認。

```bash
curl -i -X GET "${BASE_URL}/health" \
  -H "x-vercel-protection-bypass: ${BYPASS_SECRET}" \
  -H "Authorization: Bearer wrong-token-deliberately"
```

### 期待

- **Status**: `HTTP/2 401`
- **Content-Type**: `application/json`
- **Body**: 同じ固定 401 メッセージ（不一致理由を区別しない / 攻撃者への情報供与回避）

---

## 5. Test 4 — 正常系（bypass + 正 Bearer → 200）

**目的**: 両ロックを正しく通過したリクエストがアプリに到達し、200 が返ることを確認。

### 5-1. /health

```bash
curl -i -X GET "${BASE_URL}/health" \
  -H "x-vercel-protection-bypass: ${BYPASS_SECRET}" \
  -H "Authorization: Bearer ${API_TOKEN}"
```

### 期待

- **Status**: `HTTP/2 200`
- **Content-Type**: `application/json`
- **Body**: `{"status":"ok","service":"training-bot-rag-hub-api"}`

### 5-2. /api/v1/rag/query（代表 API 1 本）

```bash
curl -i -X POST "${BASE_URL}/api/v1/rag/query" \
  -H "x-vercel-protection-bypass: ${BYPASS_SECRET}" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-test-$(date +%s)" \
  -d '{"query":"smoke-test ping","symbol":"BTC/USDT"}'
```

### 期待

- **Status**: `HTTP/2 200`（成功） or `HTTP/2 4xx/5xx`（バリデーション or DB 接続エラー）
- 401 / 503 が返らないことが重要（=「両ロック通過 + ルーティング + bootstrap 成功」が確認できる）
- 5xx が出る場合は Vercel ダッシュボード → Functions → ログで `[vercel-handler]` プレフィックスの bootstrap エラー or DB / OpenAI 接続エラーを確認

---

## 6. 結果判別表

すべての smoke-test で「想定外のステータス」が返った時の判別:

| 返ってきた status + Content-Type | 意味 | 一次対処 |
|---|---|---|
| `401` + HTML（`_vercel_sso` 等） | **Vercel 側で 401**（外側ロックが効いている / 通すには bypass secret が必要） | bypass secret を確認・再投入 |
| `401` + JSON | **アプリ側で 401**（内側ロックが効いている / Bearer Token 不一致 or 欠落） | `API_TOKEN` の値・`Authorization: Bearer <値>` 形式を確認 |
| `503` + JSON | **アプリ側で 503**（`API_BEARER_TOKEN` が Vercel 環境変数に未投入 / 空文字） | Project Settings → Environment Variables を確認 |
| `404` | **ルーティング**（`vercel.json` の routes / function 登録漏れ） | Build Logs / `vercel.json` を確認 |
| `500` | **bootstrap 失敗**（DB / Prisma / OpenAI 初期化エラー） | Vercel 関数ログで `[vercel-handler]` プレフィックスのスタックを確認 |
| `502 / 504` | **タイムアウト or cold start 失敗**（Hobby plan の制限） | 再リクエスト / 関数ログで初期化遅延を確認 |

---

## 7. 完了基準

以下すべてが満たされたら deploy 完了:

- [ ] Test 1: 401 + HTML（または 302 / SSO リダイレクト）
- [ ] Test 2: 401 + JSON
- [ ] Test 3: 401 + JSON
- [ ] Test 4 (/health): 200 + JSON `{"status":"ok","service":"training-bot-rag-hub-api"}`
- [ ] Test 4 (/api/v1/rag/query): 200 or 4xx（401 / 503 でなければ OK）

ここまで通れば、ダブルロック + serverless bootstrap + Neon 接続が一気通貫で機能している。

---

## 8. シェル履歴のクリーンアップ（推奨）

smoke-test 完了後、シェル履歴から token を削除:

```bash
# zsh の場合
fc -p
# または history 全消し（影響範囲が広いので最後の手段）
# history -c && history -w

# 該当行を pinpoint で消す
history | grep BASE_URL  # 該当 lineno を確認
# .zsh_history を手動編集して該当行を削除
```

`read -s` 経由で入力した値は history に残らないが、`export BASE_URL=...` などは残るので注意。
