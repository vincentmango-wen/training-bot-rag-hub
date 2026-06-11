#!/usr/bin/env bash
# cutover-smoke-test.sh — Vercel エンドポイントへの疎通確認（read-only 既定）
#
# 用途:
#   PTP 側 RAG クライアントが参照する RAG Hub の Vercel エンドポイントが
#   ダブルロック（Vercel Standard Protection + アプリ側 Bearer）を含めて
#   正しく機能していることを、curl + status code 比較で機械判定する。
#
# 関連設計書:
#   - docs/operations/phase-5-design.md       （本スクリプトの設計）
#   - docs/operations/ptp-client-cutover.md   （PTP 側切替手順書 / 本スクリプトを呼ぶ）
#   - docs/operations/smoke-test.md           （手動 copy & paste 版 / 期待値の正本）
#
# 必要な環境変数（引数では渡さない / ps・シェル履歴への露出回避）:
#   BASE_URL              例: https://<project>.vercel.app
#   RAG_API_TOKEN         アプリ側 Bearer（Phase 3 の API_BEARER_TOKEN と同値）
#   VERCEL_BYPASS_SECRET  Vercel Protection Bypass for Automation secret
#
# 実行例（値はシェル履歴に残さない / read -s 推奨）:
#   export BASE_URL="https://<project>.vercel.app"
#   read -s -p "RAG_API_TOKEN: " RAG_API_TOKEN; echo; export RAG_API_TOKEN
#   read -s -p "VERCEL_BYPASS_SECRET: " VERCEL_BYPASS_SECRET; echo; export VERCEL_BYPASS_SECRET
#   bash docs/operations/cutover-smoke-test.sh                # read-only（既定 / LLM 課金ゼロ）
#   bash docs/operations/cutover-smoke-test.sh --with-query   # opt-in（LLM 経路 / 24h 内は replay）
#
# exit code 契約:
#   0 = 全 PASS
#   1 = 1 件以上 FAIL
#   2 = 環境変数不備
#
# 設計上の注意:
#   - LLM 課金経路 (T6) は --with-query opt-in 時のみ実行する（既定は read-only）
#   - T6 の Idempotency-Key は安定値（タイムスタンプ非含有）/ 24h 内の再実行は
#     サーバ側 idempotency 契約（IF 30 §4.4）で replay = 再課金なし
#   - secret 値は標準出力・標準エラーに一切出さない（set -x 禁止）
#   - ローカル docker（http://localhost:3000）に対する実走では T1 が「200 = FAIL」となるが
#     これは正しい（ローカルには外側ロックがない）。T1 は Vercel 実機でのみ PASS する。

set -u
# set -e は使わない（curl 非 2xx で死なないため）
# set -x は禁止（secret 漏洩防止）

# ============================================================
# 引数パース
# ============================================================
WITH_QUERY=0
for arg in "$@"; do
  case "$arg" in
    --with-query)
      WITH_QUERY=1
      ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "usage: $0 [--with-query]" >&2
      exit 2
      ;;
  esac
done

# ============================================================
# 環境変数チェック（値は出さず、未設定の変数名のみ表示）
# ============================================================
missing=()
[ -z "${BASE_URL:-}" ] && missing+=("BASE_URL")
[ -z "${RAG_API_TOKEN:-}" ] && missing+=("RAG_API_TOKEN")
[ -z "${VERCEL_BYPASS_SECRET:-}" ] && missing+=("VERCEL_BYPASS_SECRET")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: missing required environment variable(s):" >&2
  for v in "${missing[@]}"; do
    echo "  - $v" >&2
  done
  echo "Set them via 'export' (use 'read -s' to avoid shell history)." >&2
  exit 2
fi

# 末尾スラッシュを除去（URL 結合時の // 防止）
BASE_URL="${BASE_URL%/}"

# ============================================================
# 一時 body ファイル（trap で必ず削除）
# ============================================================
TMPDIR_LOCAL="$(mktemp -d 2>/dev/null || mktemp -d -t 'cutover-smoke')"
cleanup() {
  rm -rf "$TMPDIR_LOCAL" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ============================================================
# 集計
# ============================================================
PASSED=0
FAILED=0

# pass/fail 記録（secret 値は絶対に出さない / status と Content-Type 種別のみ）
record() {
  local name="$1"
  local result="$2"  # PASS | FAIL
  local detail="$3"
  if [ "$result" = "PASS" ]; then
    PASSED=$((PASSED + 1))
    printf "  [PASS] %-40s %s\n" "$name" "$detail"
  else
    FAILED=$((FAILED + 1))
    printf "  [FAIL] %-40s %s\n" "$name" "$detail"
  fi
}

# Content-Type の HTML/JSON 種別判定（body の先頭で判定 / 値は出さない）
# 0 = JSON, 1 = HTML, 2 = unknown
classify_body() {
  local body_file="$1"
  if [ ! -s "$body_file" ]; then
    echo "empty"
    return
  fi
  # JSON: 先頭が { or [
  if head -c 1 "$body_file" | grep -qE '^[\{\[]'; then
    echo "json"
    return
  fi
  # HTML: <html / <!DOCTYPE / <head 等
  if head -c 200 "$body_file" | grep -qiE '<(html|!doctype|head|body)'; then
    echo "html"
    return
  fi
  echo "other"
}

# curl 実行 + status code 取得
# 使い方: do_curl <出力 body 先> <method> <path> [-H "..."] [-H "..."] ...
# stdout に status code（curl 失敗時は 000）
do_curl() {
  local body_file="$1"
  local method="$2"
  local path="$3"
  shift 3
  local status
  status=$(curl -s -o "$body_file" -w "%{http_code}" \
    --max-time 30 \
    -X "$method" \
    "$@" \
    "${BASE_URL}${path}" 2>/dev/null || echo "000")
  echo "$status"
}

echo "============================================================"
echo " RAG Hub cutover smoke-test"
echo " mode: $([ "$WITH_QUERY" = "1" ] && echo 'read-only + --with-query (LLM 課金あり)' || echo 'read-only (LLM 課金なし)')"
echo "============================================================"

# ============================================================
# T1: 外側ロック確認（ヘッダなし GET /health → Vercel 401 / SSO リダイレクト 期待）
#   200 が返ったら FAIL（= Standard Protection が無効化されている）
#   --max-time 30 で cold start を吸収（PTP 本番 client の 10 秒とは別物）
# ============================================================
body_t1="$TMPDIR_LOCAL/body_t1"
status_t1=$(do_curl "$body_t1" GET "/health")
ct_t1=$(classify_body "$body_t1")
case "$status_t1" in
  200)
    record "T1 outer-lock (no auth)" FAIL "status=200 body=$ct_t1 (Protection 無効の疑い)"
    ;;
  401|403|30[1237])
    record "T1 outer-lock (no auth)" PASS "status=$status_t1 body=$ct_t1"
    ;;
  000)
    record "T1 outer-lock (no auth)" FAIL "curl 失敗 (network/TLS or cold-start timeout >30s)"
    ;;
  *)
    record "T1 outer-lock (no auth)" FAIL "unexpected status=$status_t1 body=$ct_t1"
    ;;
esac

# ============================================================
# T2: 内側ロック確認（bypass のみ GET /health → アプリ 401 / JSON 期待）
# ============================================================
body_t2="$TMPDIR_LOCAL/body_t2"
status_t2=$(do_curl "$body_t2" GET "/health" \
  -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}")
ct_t2=$(classify_body "$body_t2")
if [ "$status_t2" = "401" ] && [ "$ct_t2" = "json" ]; then
  record "T2 inner-lock (bypass only)" PASS "status=401 body=json"
else
  if [ "$status_t2" = "401" ] && [ "$ct_t2" = "html" ]; then
    record "T2 inner-lock (bypass only)" FAIL "status=401 body=html (bypass secret 不一致の疑い)"
  else
    record "T2 inner-lock (bypass only)" FAIL "status=$status_t2 body=$ct_t2"
  fi
fi

# ============================================================
# T3: 不正トークン（bypass + 不正 Bearer → アプリ 401 / JSON 期待）
# ============================================================
body_t3="$TMPDIR_LOCAL/body_t3"
status_t3=$(do_curl "$body_t3" GET "/health" \
  -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}" \
  -H "Authorization: Bearer wrong-token-deliberately")
ct_t3=$(classify_body "$body_t3")
if [ "$status_t3" = "401" ] && [ "$ct_t3" = "json" ]; then
  record "T3 wrong-token (bypass+bad Bearer)" PASS "status=401 body=json"
else
  record "T3 wrong-token (bypass+bad Bearer)" FAIL "status=$status_t3 body=$ct_t3"
fi

# ============================================================
# T4: 正常系 liveness（bypass + 正 Bearer GET /health → 200 + JSON 期待）
# ============================================================
body_t4="$TMPDIR_LOCAL/body_t4"
status_t4=$(do_curl "$body_t4" GET "/health" \
  -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}" \
  -H "Authorization: Bearer ${RAG_API_TOKEN}")
ct_t4=$(classify_body "$body_t4")
if [ "$status_t4" = "200" ] && [ "$ct_t4" = "json" ]; then
  # body に "status":"ok" が含まれること（値そのものは出さない / 含有のみ確認）
  if grep -q '"status":"ok"' "$body_t4" 2>/dev/null; then
    record "T4 liveness (full auth)" PASS "status=200 body=json status=ok"
  else
    record "T4 liveness (full auth)" FAIL "status=200 body=json but missing status=ok"
  fi
else
  record "T4 liveness (full auth)" FAIL "status=$status_t4 body=$ct_t4"
fi

# ============================================================
# T5: DB read 疎通（bypass + 正 Bearer GET /api/v1/rag/history → 200 期待 / LLM 課金なし）
#     Neon 接続 + api/v1 ルーティング + guard 通過の一気通貫検証
# ============================================================
body_t5="$TMPDIR_LOCAL/body_t5"
status_t5=$(do_curl "$body_t5" GET "/api/v1/rag/history?limit=1" \
  -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}" \
  -H "Authorization: Bearer ${RAG_API_TOKEN}")
ct_t5=$(classify_body "$body_t5")
if [ "$status_t5" = "200" ] && [ "$ct_t5" = "json" ]; then
  record "T5 db-read (history GET)" PASS "status=200 body=json"
else
  record "T5 db-read (history GET)" FAIL "status=$status_t5 body=$ct_t5"
fi

# ============================================================
# T6: LLM 経路（--with-query opt-in のみ / 固定 Idempotency-Key で replay）
#     注: Idempotency-Key に日時を含めない（毎回新規 = 毎回課金 = ガード無効化）
# ============================================================
if [ "$WITH_QUERY" = "1" ]; then
  # BASE_URL のホスト部分（プロトコル除去）を安定値として key に組み込む
  host_part="${BASE_URL#https://}"
  host_part="${host_part#http://}"
  host_part="${host_part%%/*}"
  idem_key="cutover-smoke-${host_part}-v1"

  body_t6="$TMPDIR_LOCAL/body_t6"
  status_t6=$(do_curl "$body_t6" POST "/api/v1/rag/query" \
    -H "x-vercel-protection-bypass: ${VERCEL_BYPASS_SECRET}" \
    -H "Authorization: Bearer ${RAG_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${idem_key}" \
    -d '{"query":"cutover-smoke fixed payload","symbol":"BTC/USDT"}')
  ct_t6=$(classify_body "$body_t6")
  # 401 / 503 は明確に FAIL（両ロック不通 or サーバ env 不備）
  # 200 / 4xx (バリデーション等) は PASS（ルーティング + guard + bootstrap 成功）
  case "$status_t6" in
    401|503)
      record "T6 llm-path (POST query opt-in)" FAIL "status=$status_t6 body=$ct_t6"
      ;;
    200|400|404|409|422|429)
      record "T6 llm-path (POST query opt-in)" PASS "status=$status_t6 body=$ct_t6 (idem-key=stable)"
      ;;
    000)
      record "T6 llm-path (POST query opt-in)" FAIL "curl 失敗 (timeout / network)"
      ;;
    *)
      record "T6 llm-path (POST query opt-in)" FAIL "unexpected status=$status_t6 body=$ct_t6"
      ;;
  esac
fi

# ============================================================
# 集計
# ============================================================
echo "------------------------------------------------------------"
echo " passed=$PASSED  failed=$FAILED"
echo "============================================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
