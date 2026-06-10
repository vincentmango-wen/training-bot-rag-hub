import React, { useState } from "react";

/**
 * Training Bot RAG Hub — UI Mock
 * Concept: Institutional AI Terminal (per 18_UIデザイン設計書 / 19_ワイヤーフレーム)
 *
 * 設計原則（UI設計書より）
 *  - RAG回答より「根拠」を目立たせる / BUY・SELLを強調しすぎない
 *  - Risk / Confidence / Citation / Guardrail を常に可視化
 *  - order_permission = false をUI上でも明示
 *  - 注文ボタン・Bot設定変更ボタンは配置しない
 *  - 利益方向より損失方向（Max Drawdown）を目立たせる
 */

// ── Design Tokens（18_UIデザイン設計書 の theme をそのまま採用）──
const t = {
  background: "#0B1020",
  surface: "#131A2A",
  card: "#1A2235",
  cardHi: "#1F2A40",
  border: "#243145",
  divider: "#334155",
  textPrimary: "#F8FAFC",
  textSecondary: "#CBD5E1",
  textMuted: "#94A3B8",
  textDisabled: "#64748B",
  primary: "#3B82F6",
  ai: "#8B5CF6",
  info: "#06B6D4",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
};

const RISK = {
  LOW: { bg: "#052E16", fg: "#22C55E", label: "LOW" },
  MEDIUM: { bg: "#172554", fg: "#3B82F6", label: "MEDIUM" },
  HIGH: { bg: "#451A03", fg: "#F59E0B", label: "HIGH" },
  CRITICAL: { bg: "#450A0A", fg: "#EF4444", label: "CRITICAL" },
};

const GUARD = {
  PASS: { bg: "#052E16", fg: "#22C55E", bd: "#14532D" },
  WARNING: { bg: "#451A03", fg: "#F59E0B", bd: "#78350F" },
  BLOCKED: { bg: "#450A0A", fg: "#EF4444", bd: "#7F1D1D" },
};

const sans = "'Inter','Noto Sans JP',system-ui,-apple-system,sans-serif";
const mono = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace";

// ────────────────────────────────────────────────────────────
//  小コンポーネント
// ────────────────────────────────────────────────────────────
function RiskBadge({ level, size = "md" }) {
  const r = RISK[level] || RISK.MEDIUM;
  const pad = size === "sm" ? "2px 8px" : "4px 12px";
  const fs = size === "sm" ? 10 : 11;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        borderRadius: 999,
        padding: pad,
        fontSize: fs,
        fontWeight: 600,
        letterSpacing: 0.4,
        background: r.bg,
        color: r.fg,
        border: `1px solid ${r.fg}33`,
        fontFamily: mono,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: r.fg }} />
      {r.label}
    </span>
  );
}

function ConfidenceMeter({ value, showLabel = true }) {
  const pct = Math.round(value * 100);
  const label =
    value < 0.3 ? "Low" : value < 0.6 ? "Medium" : value < 0.8 ? "High" : "Very High";
  const low = value < 0.5;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {showLabel && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: t.textMuted,
            fontFamily: mono,
          }}
        >
          <span>Confidence</span>
          <span style={{ color: low ? t.warning : t.textSecondary }}>
            {label} / {pct}%
          </span>
        </div>
      )}
      <div style={{ height: 8, borderRadius: 999, background: "#0E1422", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 999,
            background: low
              ? `linear-gradient(90deg,${t.warning},#fbbf24)`
              : `linear-gradient(90deg,${t.primary},${t.ai})`,
          }}
        />
      </div>
    </div>
  );
}

function GuardrailStatus({ status = "PASS", reason }) {
  const g = GUARD[status] || GUARD.PASS;
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${g.bd}`,
        background: g.bg,
        padding: 14,
        fontFamily: mono,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ color: g.fg, fontWeight: 700, fontSize: 13, letterSpacing: 0.4 }}>
          GUARDRAIL: {status}
        </div>
        <Lock />
      </div>
      <div
        style={{
          marginTop: 8,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: t.textSecondary,
          background: "#0E1422",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: "4px 10px",
        }}
      >
        order_permission = <span style={{ color: t.danger, fontWeight: 700 }}>false</span>
      </div>
      {reason && (
        <div style={{ marginTop: 8, fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
          {reason}
        </div>
      )}
    </div>
  );
}

function ProviderBadge({ provider, model, fallbackUsed }) {
  const colors = {
    openai: t.success,
    claude: t.ai,
    gemini: t.info,
    mistral: t.warning,
    local: t.textMuted,
  };
  const c = colors[provider] || t.primary;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: mono,
        fontSize: 11,
        color: t.textSecondary,
        border: `1px solid ${t.border}`,
        background: t.card,
        borderRadius: 8,
        padding: "3px 9px",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: c }} />
      {provider} / {model}
      {fallbackUsed && (
        <span style={{ color: t.warning, fontWeight: 600 }}>· fallback</span>
      )}
    </span>
  );
}

function FactorCard({ type, text }) {
  const isSup = type === "supporting";
  const accent = isSup ? t.success : t.warning;
  const glyph = isSup ? "＋" : "−";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "9px 12px",
        background: "#0E1422",
        border: `1px solid ${t.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
      }}
    >
      <span style={{ color: accent, fontFamily: mono, fontWeight: 700, lineHeight: "20px" }}>
        {glyph}
      </span>
      <span style={{ fontSize: 13, color: t.textSecondary, lineHeight: 1.5 }}>{text}</span>
    </div>
  );
}

function CitationCard({ sourceType, sourceName, reliability, recency, usedReason }) {
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${t.border}`,
        background: t.card,
        padding: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: t.textMuted,
            fontFamily: mono,
          }}
        >
          {sourceType}
        </span>
        <button style={btnGhost}>Detail</button>
      </div>
      <div style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color: t.textPrimary }}>
        {sourceName}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <ScoreRow label="Reliability" value={reliability} color={t.success} />
        <ScoreRow label="Recency" value={recency} color={t.info} />
      </div>
      <p style={{ marginTop: 10, fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
        {usedReason}
      </p>
    </div>
  );
}

function ScoreRow({ label, value, color }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 78, fontSize: 10, color: t.textMuted, fontFamily: mono }}>{label}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: "#0E1422" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: 999, background: color }} />
      </div>
      <span style={{ width: 34, textAlign: "right", fontSize: 11, color: t.textSecondary, fontFamily: mono }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function WarningBanner({ tone = "risk", title, message }) {
  const map = {
    risk: { bg: "#451A03", bd: "#78350F", fg: t.warning },
    citation: { bg: "#172554", bd: "#1E3A8A", fg: t.primary },
    info: { bg: "#0E2A33", bd: "#155E75", fg: t.info },
  };
  const c = map[tone] || map.risk;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        background: c.bg,
        border: `1px solid ${c.bd}`,
        borderRadius: 10,
        padding: "10px 14px",
      }}
    >
      <span style={{ color: c.fg, fontSize: 14, lineHeight: "20px" }}>⚠</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: c.fg }}>{title}</div>
        <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2, lineHeight: 1.5 }}>
          {message}
        </div>
      </div>
    </div>
  );
}

function Card({ title, right, children, pad = 16, style }) {
  return (
    <section
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        ...style,
      }}
    >
      {title && (
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: t.textPrimary, letterSpacing: 0.2 }}>
            {title}
          </h3>
          {right}
        </header>
      )}
      <div style={{ padding: pad }}>{children}</div>
    </section>
  );
}

function MetricCard({ label, value, sub, accent }) {
  return (
    <div
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 11, color: t.textMuted, letterSpacing: 0.3 }}>{label}</div>
      <div
        style={{
          marginTop: 8,
          fontSize: 28,
          fontWeight: 700,
          fontFamily: mono,
          color: accent || t.textPrimary,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ marginTop: 8, fontSize: 11, color: t.textMuted }}>{sub}</div>}
    </div>
  );
}

const btnPrimary = {
  background: t.primary,
  color: "#fff",
  border: "none",
  borderRadius: 10,
  padding: "10px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: sans,
};
const btnSecondary = {
  background: t.card,
  color: t.textSecondary,
  border: `1px solid ${t.border}`,
  borderRadius: 10,
  padding: "8px 14px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: sans,
};
const btnGhost = {
  background: "transparent",
  color: t.primary,
  border: "none",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: sans,
};

// 小さなアイコン（依存無し）
function Lock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────
//  Mock Data
// ────────────────────────────────────────────────────────────
const CITATIONS = [
  { sourceType: "market_data", sourceName: "BTCUSDT 1h OHLCV", reliability: 0.92, recency: 0.95, usedReason: "出来高増加と価格変動の根拠として使用" },
  { sourceType: "bot_log", sourceName: "RSI-Reversal Bot / 判断ログ", reliability: 0.85, recency: 0.88, usedReason: "類似条件での過去シグナルの参照に使用" },
  { sourceType: "strategy_doc", sourceName: "Mean Reversion Strategy v1", reliability: 0.78, recency: 0.45, usedReason: "戦略ルールの前提確認に使用" },
];

const HISTORY = [
  { id: "q-1042", date: "06/10 09:41", query: "BTCUSDT 急騰の背景と過去類似ケース", symbol: "BTCUSDT", risk: "HIGH", conf: 0.62, provider: "openai", model: "gpt-5.4-mini", cost: 0.0059, latency: 1850, guard: "PASS" },
  { id: "q-1041", date: "06/10 09:18", query: "ETH 短期センチメント要約", symbol: "ETHUSDT", risk: "MEDIUM", conf: 0.71, provider: "openai", model: "gpt-5.4-mini", cost: 0.0051, latency: 1620, guard: "PASS" },
  { id: "q-1039", date: "06/10 08:55", query: "今すぐBTCを全力で買うべき？", symbol: "BTCUSDT", risk: "MEDIUM", conf: 0.0, provider: "—", model: "—", cost: 0.0, latency: 90, guard: "BLOCKED" },
  { id: "q-1037", date: "06/09 22:30", query: "USDJPY 直近の類似ケース", symbol: "USDJPY", risk: "LOW", conf: 0.74, provider: "openai", model: "gpt-5.4-mini", cost: 0.0048, latency: 1410, guard: "PASS" },
  { id: "q-1035", date: "06/09 20:02", query: "高リスク相場のリスクレビュー", symbol: "BTCUSDT", risk: "CRITICAL", conf: 0.58, provider: "openai", model: "gpt-5.4", cost: 0.0305, latency: 2980, guard: "WARNING" },
];

const SIMILAR_CASES = [
  { id: "case-1021", period: "2025-11-15 → 11-16", sim: 0.91, after: "+3.2%", dd: "-1.4%", risk: "MEDIUM", note: "急騰後に出来高低下で短期反落" },
  { id: "case-1198", period: "2025-10-01 → 10-02", sim: 0.86, after: "-0.9%", dd: "-2.8%", risk: "HIGH", note: "上位足の下落トレンドに飲まれた" },
  { id: "case-0902", period: "2025-08-18 → 08-19", sim: 0.82, after: "+2.4%", dd: "-1.2%", risk: "MEDIUM", note: "RSI反発が4hで継続" },
];

const PROVIDERS = [
  { provider: "openai", model: "gpt-5.4-mini", queries: 3120, input: "9.36M", output: "2.50M", cost: 18.27, latency: 1820, err: 0.4, fallback: 12, schema: 99.2 },
  { provider: "openai", model: "gpt-5.4", queries: 214, input: "1.07M", output: "0.26M", cost: 6.41, latency: 2960, err: 0.9, fallback: 3, schema: 99.5 },
  { provider: "claude", model: "sonnet-4.6", queries: 38, input: "0.19M", output: "0.05M", cost: 1.32, latency: 2410, err: 0.0, fallback: 0, schema: 98.7 },
];

const EVAL = [
  { provider: "OpenAI", model: "gpt-5.4-mini", schema: 99, citation: 96, hallu: 2, risk: 92, cost: "$", score: 94 },
  { provider: "Claude", model: "sonnet-4.6", schema: 97, citation: 95, hallu: 1, risk: 95, cost: "$$", score: 95 },
  { provider: "Gemini", model: "2.5-flash", schema: 94, citation: 91, hallu: 4, risk: 88, cost: "$", score: 88 },
  { provider: "Mistral", model: "large", schema: 90, citation: 88, hallu: 6, risk: 84, cost: "$", score: 82 },
];

// ────────────────────────────────────────────────────────────
//  画面
// ────────────────────────────────────────────────────────────
function Dashboard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="ダッシュボード" sub="RAG Hub の稼働状況・リスク・コストを俯瞰" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        <MetricCard label="本日のQuery数" value="128" sub="前日比 +14" />
        <MetricCard label="平均Latency" value="1.8s" sub="目標 3s 以内" accent={t.success} />
        <MetricCard label="今月の推定コスト" value="$12.30" sub="月額上限 $50 / 残 $37.70" accent={t.primary} />
        <MetricCard label="Guardrail Block" value="4" sub="本日 / うちInjection 1" accent={t.warning} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <Card title="直近のRAG Query" pad={0}>
          {HISTORY.slice(0, 4).map((h, i) => (
            <div
              key={h.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderTop: i === 0 ? "none" : `1px solid ${t.border}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: t.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }}>
                  {h.query}
                </div>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: mono, marginTop: 3 }}>
                  {h.date} · {h.symbol}
                </div>
              </div>
              <RiskBadge level={h.risk} size="sm" />
            </div>
          ))}
        </Card>

        <Card title="Risk Alerts" pad={12}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <AlertRow level="CRITICAL" text="BTCUSDT — 低信頼ソース混入の警告" />
            <AlertRow level="HIGH" text="BTCUSDT — ボラティリティ上昇" />
            <AlertRow level="HIGH" text="ETHUSDT — 出来高急変" />
          </div>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card title="Provider Usage">
          <BarRow label="OpenAI gpt-5.4-mini" pct={72} color={t.success} />
          <BarRow label="OpenAI gpt-5.4" pct={20} color={t.primary} />
          <BarRow label="Claude sonnet-4.6" pct={8} color={t.ai} />
        </Card>
        <Card title="Guardrail Summary">
          <BarRow label="PASS" pct={92} color={t.success} />
          <BarRow label="WARNING" pct={6} color={t.warning} />
          <BarRow label="BLOCKED" pct={2} color={t.danger} />
        </Card>
      </div>

      <WarningBanner
        tone="info"
        title="この画面は参考情報です"
        message="RAGは投資助言を行わず、注文実行権限を持ちません。表示内容はBot検証・市場理解のための参考情報です。"
      />
    </div>
  );
}

function AlertRow({ level, text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <RiskBadge level={level} size="sm" />
      <span style={{ fontSize: 12, color: t.textSecondary }}>{text}</span>
    </div>
  );
}

function BarRow({ label, pct, color }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: t.textSecondary, marginBottom: 5 }}>
        <span>{label}</span>
        <span style={{ fontFamily: mono, color: t.textMuted }}>{pct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "#0E1422" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: 999, background: color }} />
      </div>
    </div>
  );
}

function AIAnalysis() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="AI分析 / BTCUSDT · 1h" sub="市場文脈・根拠・リスク・引用を確認する最重要画面" />
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 320px", gap: 16, alignItems: "start" }}>
        {/* Query Panel */}
        <Card title="Query" pad={14}>
          <Field label="Symbol" value="BTCUSDT" />
          <Field label="Timeframe" value="1h" />
          <Field label="Source Types" value="market_data, bot_log, news" />
          <Field label="Provider Policy" value="default" />
          <button style={{ ...btnPrimary, width: "100%", marginTop: 10 }}>Run Query</button>
          <button style={{ ...btnSecondary, width: "100%", marginTop: 8 }}>履歴を見る</button>
        </Card>

        {/* Analysis Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <WarningBanner
            tone="risk"
            title="High Risk — 急変動リスクを含みます"
            message="根拠と反対材料の両方を確認してください。この出力は投資助言ではありません。"
          />
          <Card title="Market Summary" right={<RiskBadge level="HIGH" />}>
            <p style={{ margin: 0, fontSize: 14, color: t.textSecondary, lineHeight: 1.7 }}>
              BTCUSDTは出来高増加と外部イベント期待が重なり短期的に上昇しています。RSIは依然として
              中立〜やや過熱、上位足は下落トレンドが残存しており、急騰後の反落リスクが意識される局面です。
            </p>
            <div style={{ marginTop: 14, maxWidth: 280 }}>
              <ConfidenceMeter value={0.62} />
            </div>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Card title="Supporting Factors" pad={12}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FactorCard type="supporting" text="出来高が急増している" />
                <FactorCard type="supporting" text="MACDが上向き転換（golden cross）" />
                <FactorCard type="supporting" text="過去類似ケースで短期反発が確認された" />
              </div>
            </Card>
            <Card title="Opposing Factors" pad={12}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FactorCard type="opposing" text="上位足は下落トレンドが継続" />
                <FactorCard type="opposing" text="急騰後の利確売り圧力" />
                <FactorCard type="opposing" text="出来高低下時の失速リスク" />
              </div>
            </Card>
          </div>

          <Card title="Similar Cases" pad={12}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SIMILAR_CASES.slice(0, 2).map((c) => (
                <SimilarCaseRow key={c.id} c={c} />
              ))}
            </div>
          </Card>

          <GuardrailStatus status="PASS" reason="RAGは注文権限を持ちません。検証用の参考情報として返却しています。" />
        </div>

        {/* Citation Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: t.textMuted, letterSpacing: 0.3 }}>Citations</div>
          {CITATIONS.map((c) => (
            <CitationCard key={c.sourceName} {...c} />
          ))}
          <div style={{ marginTop: 2 }}>
            <ProviderBadge provider="openai" model="gpt-5.4-mini" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 5, letterSpacing: 0.4, textTransform: "uppercase", fontFamily: mono }}>
        {label}
      </div>
      <div
        style={{
          background: "#0E1422",
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: "8px 10px",
          fontSize: 12,
          color: t.textSecondary,
          fontFamily: mono,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SimilarCaseRow({ c }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "center",
        background: "#0E1422",
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: mono, fontSize: 12, color: t.textPrimary }}>{c.id}</span>
          <RiskBadge level={c.risk} size="sm" />
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3, fontFamily: mono }}>{c.period}</div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3 }}>{c.note}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 11, color: t.textMuted, fontFamily: mono }}>
          sim <span style={{ color: t.primary }}>{c.sim.toFixed(2)}</span>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, fontFamily: mono }}>after {c.after}</div>
        <div style={{ fontSize: 12, color: t.danger, fontFamily: mono, fontWeight: 600 }}>DD {c.dd}</div>
      </div>
    </div>
  );
}

function BotValidation() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="Bot検証 / Bot-001 · RSI-Reversal" sub="仮シグナルに対するRAGの根拠・反対材料・リスクを確認" />
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 280px", gap: 16, alignItems: "start" }}>
        <Card title="Bot Context" pad={14}>
          <div style={{ fontSize: 10, color: t.textMuted, letterSpacing: 0.4, fontFamily: mono }}>SIGNAL CANDIDATE</div>
          <div
            style={{
              marginTop: 6,
              fontSize: 26,
              fontWeight: 700,
              color: t.textPrimary,
              fontFamily: mono,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            BUY
            <span style={{ fontSize: 11, fontWeight: 500, color: t.textMuted }}>candidate</span>
          </div>
          <div style={{ height: 1, background: t.border, margin: "14px 0" }} />
          <Field label="Symbol" value="BTCUSDT · 1h" />
          <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 6, letterSpacing: 0.4, fontFamily: mono }}>FEATURES</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <KV k="RSI" v="29" />
            <KV k="MACD" v="golden_cross" />
            <KV k="Volume Spike" v="true" />
            <KV k="ATR" v="0.024" />
          </div>
          <button style={{ ...btnSecondary, width: "100%", marginTop: 14 }}>RAG説明を再取得</button>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="RAG Explanation" right={<RiskBadge level="HIGH" />}>
            <p style={{ margin: 0, fontSize: 14, color: t.textSecondary, lineHeight: 1.7 }}>
              RSIが売られすぎ圏にあり、MACDも上向き転換しているため、短期反発シナリオを支持する材料があります。
              ただしこれは投資指示ではなく、検証用の根拠候補です。
            </p>
            <div style={{ marginTop: 14, maxWidth: 280 }}>
              <ConfidenceMeter value={0.61} />
            </div>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Card title="Supporting Factors" pad={12}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FactorCard type="supporting" text="RSI oversold" />
                <FactorCard type="supporting" text="MACD golden cross" />
                <FactorCard type="supporting" text="Volume spike" />
              </div>
            </Card>
            <Card title="Opposing Factors" pad={12}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FactorCard type="opposing" text="上位足の下落トレンドが継続する可能性" />
                <FactorCard type="opposing" text="急変動時のスリッページ拡大" />
              </div>
            </Card>
          </div>

          <Card title="Similar Cases" pad={12}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SIMILAR_CASES.map((c) => (
                <SimilarCaseRow key={c.id} c={c} />
              ))}
            </div>
          </Card>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Review" pad={14}>
            <KV k="Human Review" v="Pending" />
            <div style={{ height: 10 }} />
            <KV k="Trace ID" v="trc-9f2…aa1" mono />
          </Card>
          <GuardrailStatus status="PASS" reason="Bot Contextは読み取り専用です。この画面から注文・Bot設定変更はできません。" />
          <WarningBanner tone="citation" title="禁止導線" message="RAG結果から注文・Bot設定の自動反映には進めません（設計上ボタンを配置していません）。" />
        </div>
      </div>
    </div>
  );
}

function KV({ k, v, mono: isMono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 12, color: t.textMuted }}>{k}</span>
      <span style={{ fontSize: 12, color: t.textSecondary, fontFamily: isMono ? mono : sans }}>{v}</span>
    </div>
  );
}

function SimilarCases() {
  const [sel, setSel] = useState(SIMILAR_CASES[0]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="類似ケース検索" sub="現在の市場特徴量に近い過去ケースを比較（過去ケースは将来を保証しません）" />
      <Card title="検索条件" pad={14}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <MiniField label="Symbol" value="BTCUSDT" w={120} />
          <MiniField label="Timeframe" value="1h" w={70} />
          <MiniField label="RSI" value="29" w={60} />
          <MiniField label="MACD" value="GC" w={60} />
          <MiniField label="Lookback" value="365d" w={80} />
          <button style={btnPrimary}>Search</button>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, alignItems: "start" }}>
        <Card title="Result List" pad={12}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {SIMILAR_CASES.map((c) => (
              <div
                key={c.id}
                onClick={() => setSel(c)}
                style={{
                  cursor: "pointer",
                  background: sel.id === c.id ? t.cardHi : "#0E1422",
                  border: `1px solid ${sel.id === c.id ? t.primary : t.border}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: mono, fontSize: 13, color: t.textPrimary }}>{c.id}</span>
                  <RiskBadge level={c.risk} size="sm" />
                </div>
                <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: "#0B1020" }}>
                  <div style={{ height: "100%", width: `${c.sim * 100}%`, borderRadius: 999, background: t.primary }} />
                </div>
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 11 }}>
                  <span style={{ color: t.textMuted }}>similarity {c.sim.toFixed(2)}</span>
                  <span style={{ color: t.danger, fontWeight: 600 }}>Max DD {c.dd}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Case Detail" pad={14}>
          <div style={{ fontFamily: mono, fontSize: 13, color: t.textPrimary }}>{sel.id}</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4, fontFamily: mono }}>{sel.period}</div>
          <div style={{ height: 1, background: t.border, margin: "12px 0" }} />
          <KV k="Similarity" v={sel.sim.toFixed(2)} mono />
          <div style={{ height: 8 }} />
          <KV k="After Move" v={sel.after} mono />
          <div style={{ height: 8 }} />
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: t.textMuted }}>Max Drawdown</span>
            <span style={{ fontSize: 13, color: t.danger, fontFamily: mono, fontWeight: 700 }}>{sel.dd}</span>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 6 }}>Risk Notes</div>
            <p style={{ margin: 0, fontSize: 13, color: t.textSecondary, lineHeight: 1.6 }}>{sel.note}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function MiniField({ label, value, w }) {
  return (
    <div style={{ width: w }}>
      <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 5, fontFamily: mono }}>{label}</div>
      <div style={{ background: "#0E1422", border: `1px solid ${t.border}`, borderRadius: 8, padding: "7px 9px", fontSize: 12, color: t.textSecondary, fontFamily: mono }}>
        {value}
      </div>
    </div>
  );
}

function HistoryView({ onOpen }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="RAG履歴" sub="過去の問い合わせ・回答・Provider・Guardrail結果を監査" />
      <Card title="Filters" pad={12}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <MiniChip text="Symbol: ALL" />
          <MiniChip text="Risk: ALL" />
          <MiniChip text="Provider: ALL" />
          <MiniChip text="Guardrail: ALL" />
          <MiniChip text="期間: 直近7日" />
        </div>
      </Card>
      <Card pad={0}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono }}>
            <thead>
              <tr>
                {["Date", "Query", "Symbol", "Risk", "Conf", "Provider", "Cost", "Latency", "Guardrail", ""].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HISTORY.map((h) => (
                <tr key={h.id} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={td}>{h.date}</td>
                  <td style={{ ...td, fontFamily: sans, color: t.textPrimary, maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.query}</td>
                  <td style={td}>{h.symbol}</td>
                  <td style={td}><RiskBadge level={h.risk} size="sm" /></td>
                  <td style={td}>{h.conf ? h.conf.toFixed(2) : "—"}</td>
                  <td style={td}>{h.provider}</td>
                  <td style={td}>${h.cost.toFixed(4)}</td>
                  <td style={td}>{h.latency}ms</td>
                  <td style={td}><GuardChip status={h.guard} /></td>
                  <td style={td}><button style={btnGhost} onClick={() => onOpen(h)}>詳細</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const th = { textAlign: "left", padding: "11px 14px", fontSize: 10, color: t.textMuted, letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600 };
const td = { padding: "11px 14px", fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" };

function MiniChip({ text }) {
  return (
    <span style={{ background: "#0E1422", border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 11, color: t.textSecondary, fontFamily: mono }}>
      {text}
    </span>
  );
}
function GuardChip({ status }) {
  const g = GUARD[status] || GUARD.PASS;
  return (
    <span style={{ background: g.bg, color: g.fg, border: `1px solid ${g.bd}`, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 600 }}>
      {status}
    </span>
  );
}

function QueryDetail({ row, onBack }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button style={btnSecondary} onClick={onBack}>← 履歴へ戻る</button>
        <PageTitle title="回答詳細" sub={`trace_id: trc-${row.id}`} compact />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Query">
            <p style={{ margin: 0, fontSize: 14, color: t.textPrimary, lineHeight: 1.6 }}>{row.query}</p>
          </Card>
          <Card title="Response" right={<RiskBadge level={row.risk} />}>
            {row.guard === "BLOCKED" ? (
              <WarningBanner tone="risk" title="Guardrail BLOCKED" message="この入力は注文誘導とみなされ、回答本文は生成・表示されません。" />
            ) : (
              <>
                <p style={{ margin: 0, fontSize: 14, color: t.textSecondary, lineHeight: 1.7 }}>
                  市場状況の要約と、支持材料・反対材料・リスク要因を根拠付きで提示しています。
                </p>
                <div style={{ marginTop: 14, maxWidth: 280 }}>
                  <ConfidenceMeter value={row.conf} />
                </div>
              </>
            )}
          </Card>
          {row.guard !== "BLOCKED" && (
            <Card title="Citations" pad={12}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {CITATIONS.slice(0, 2).map((c) => (
                  <CitationCard key={c.sourceName} {...c} />
                ))}
              </div>
            </Card>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card title="Metadata" pad={14}>
            <KV k="Provider" v={row.provider} mono />
            <div style={{ height: 8 }} />
            <KV k="Model" v={row.model} mono />
            <div style={{ height: 8 }} />
            <KV k="Cost" v={`$${row.cost.toFixed(4)}`} mono />
            <div style={{ height: 8 }} />
            <KV k="Latency" v={`${row.latency}ms`} mono />
            <div style={{ height: 8 }} />
            <KV k="Tokens" v="3000 / 800" mono />
          </Card>
          <GuardrailStatus status={row.guard} reason="RAGは注文権限を持ちません。" />
        </div>
      </div>
    </div>
  );
}

function ProviderUsage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="Provider利用状況" sub="Provider別の利用量・コスト・Latency・Schema成功率" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
        <MetricCard label="今月の総コスト" value="$26.00" sub="月額上限 $50" accent={t.primary} />
        <MetricCard label="平均Latency" value="1.9s" accent={t.success} />
        <MetricCard label="Cache Hit Rate" value="32%" />
      </div>
      <Card pad={0}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono }}>
            <thead>
              <tr>
                {["Provider", "Model", "Queries", "Input", "Output", "Cost", "Latency", "Err%", "Fallback", "Schema%"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={td}><ProviderBadge provider={p.provider} model={""} /></td>
                  <td style={td}>{p.model}</td>
                  <td style={td}>{p.queries.toLocaleString()}</td>
                  <td style={td}>{p.input}</td>
                  <td style={td}>{p.output}</td>
                  <td style={{ ...td, color: t.textPrimary }}>${p.cost.toFixed(2)}</td>
                  <td style={td}>{p.latency}ms</td>
                  <td style={td}>{p.err}%</td>
                  <td style={td}>{p.fallback}</td>
                  <td style={{ ...td, color: p.schema >= 99 ? t.success : t.warning }}>{p.schema}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <WarningBanner tone="risk" title="コストアラート" message="月額上限の80%に到達すると警告、100%でBLOCKまたはmini限定に切替わります。" />
    </div>
  );
}

function ProviderEvaluation() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageTitle title="Provider評価" sub="同一評価セットでの品質・コスト・安全性の比較（Phase 2）" />
      <Card title="評価条件" pad={14}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <MiniField label="Dataset" value="RAG-EVAL-001" w={150} />
          <MiniField label="Task" value="bot_signal_explanation" w={210} />
          <button style={btnPrimary}>Run Eval</button>
        </div>
      </Card>
      <Card pad={0}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono }}>
            <thead>
              <tr>
                {["Provider", "Model", "Schema", "Citation", "Hallucination", "Risk Cov.", "Cost", "Score"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVAL.map((e, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ ...td, color: t.textPrimary, fontFamily: sans }}>{e.provider}</td>
                  <td style={td}>{e.model}</td>
                  <td style={{ ...td, color: e.schema >= 99 ? t.success : t.textSecondary }}>{e.schema}%</td>
                  <td style={td}>{e.citation}%</td>
                  <td style={{ ...td, color: e.hallu > 3 ? t.warning : t.textSecondary }}>{e.hallu}%</td>
                  <td style={td}>{e.risk}%</td>
                  <td style={td}>{e.cost}</td>
                  <td style={{ ...td, color: t.textPrimary, fontWeight: 700 }}>{e.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <WarningBanner tone="info" title="用途別に読む" message="単純なランキングではなく、リスクレビュー・通常要約・外部情報要約など用途別に最適Providerを判断します。" />
    </div>
  );
}

function PageTitle({ title, sub, compact }) {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: compact ? 18 : 22, fontWeight: 700, color: t.textPrimary, letterSpacing: 0.2 }}>
        {title}
      </h2>
      {sub && <div style={{ marginTop: 4, fontSize: 12, color: t.textMuted }}>{sub}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  App Shell
// ────────────────────────────────────────────────────────────
const NAV = [
  { id: "dashboard", label: "ダッシュボード", group: "Overview" },
  { id: "ai-analysis", label: "AI分析", group: "Analysis" },
  { id: "bot-validation", label: "Bot検証", group: "Analysis" },
  { id: "similar-cases", label: "類似ケース", group: "Analysis" },
  { id: "history", label: "RAG履歴", group: "Audit" },
  { id: "provider-usage", label: "Provider利用状況", group: "Audit" },
  { id: "provider-evaluation", label: "Provider評価", group: "Audit" },
];

export default function App() {
  const [view, setView] = useState("ai-analysis");
  const [detailRow, setDetailRow] = useState(null);

  const groups = [...new Set(NAV.map((n) => n.group))];

  let content;
  if (view === "dashboard") content = <Dashboard />;
  else if (view === "ai-analysis") content = <AIAnalysis />;
  else if (view === "bot-validation") content = <BotValidation />;
  else if (view === "similar-cases") content = <SimilarCases />;
  else if (view === "history")
    content = detailRow ? (
      <QueryDetail row={detailRow} onBack={() => setDetailRow(null)} />
    ) : (
      <HistoryView onOpen={(r) => setDetailRow(r)} />
    );
  else if (view === "provider-usage") content = <ProviderUsage />;
  else if (view === "provider-evaluation") content = <ProviderEvaluation />;

  return (
    <div style={{ background: t.background, color: t.textPrimary, fontFamily: sans, minHeight: "100vh" }}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: ${t.border}; border-radius: 999px; }
        ::-webkit-scrollbar-track { background: transparent; }
        button:hover { filter: brightness(1.12); }
      `}</style>

      {/* Header */}
      <header
        style={{
          height: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          borderBottom: `1px solid ${t.border}`,
          background: t.surface,
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: `linear-gradient(135deg,${t.primary},${t.ai})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: mono,
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            R
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Training Bot RAG Hub</div>
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: mono }}>PMTP Intelligence Reference Layer</div>
          </div>
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              fontFamily: mono,
              color: t.warning,
              border: `1px solid ${t.warning}55`,
              background: "#451A0322",
              borderRadius: 6,
              padding: "2px 8px",
            }}
          >
            LOCAL
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: t.textSecondary, fontFamily: mono }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: t.success }} />
            Providers healthy
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary, fontFamily: mono }}>
            Monthly <span style={{ color: t.textPrimary }}>$12.30</span> / $50
          </span>
          <div style={{ width: 30, height: 30, borderRadius: 999, background: t.card, border: `1px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontFamily: mono }}>
            F
          </div>
        </div>
      </header>

      <div style={{ display: "flex", minHeight: "calc(100vh - 64px)" }}>
        {/* Sidebar */}
        <aside style={{ width: 240, borderRight: `1px solid ${t.border}`, background: t.surface, padding: "16px 12px", flexShrink: 0 }}>
          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10, color: t.textDisabled, letterSpacing: 0.8, textTransform: "uppercase", padding: "0 10px 8px", fontFamily: mono }}>
                {g}
              </div>
              {NAV.filter((n) => n.group === g).map((n) => {
                const active = view === n.id;
                return (
                  <button
                    key={n.id}
                    onClick={() => {
                      setView(n.id);
                      setDetailRow(null);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 10px",
                      marginBottom: 2,
                      borderRadius: 8,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      fontFamily: sans,
                      background: active ? t.cardHi : "transparent",
                      color: active ? t.textPrimary : t.textMuted,
                      borderLeft: active ? `2px solid ${t.primary}` : "2px solid transparent",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {n.label}
                  </button>
                );
              })}
            </div>
          ))}

          <div style={{ marginTop: 24, padding: 12, borderRadius: 10, background: t.card, border: `1px solid ${t.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: t.textSecondary }}>
              <Lock />
              <span style={{ fontWeight: 600 }}>Read-only RAG</span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 10.5, color: t.textMuted, lineHeight: 1.5 }}>
              注文実行・Bot設定変更・緊急停止解除は不可。判断材料のみを提供します。
            </p>
          </div>
        </aside>

        {/* Main */}
        <main style={{ flex: 1, padding: 24, maxWidth: 1280, margin: "0 auto", width: "100%" }}>{content}</main>
      </div>
    </div>
  );
}
