// apps/web/src/components/MarketIntelPanel.tsx
// PANEL MARKET INTELLIGENCE (master task Fase 7) — visualisasi snapshot
// deterministik dari /api/market-intel (schema artatrade-market-intelligence-v1).
// Panel read-only: tidak ada tombol, tidak ada jalur ke order — hanya konteks.
import { useEffect, useState } from "react";
import { colors } from "../theme.js";

interface Intel {
  schema_version: string; analysis_id: string; generated_at: string; computed_at_ms: number;
  universe: { target: number; valid: number; coverage_ratio: number };
  breadth: { positive: number; negative: number; valid: number };
  breadth_1h: { positive: number; negative: number; valid: number };
  btc_relative_strength: { value_1h: number | null; classification: string };
  regime: { label: string; consistency: number | null; atr_pct_1h: number | null };
  liquidity: { status: string; symbols: { symbol: string; imbalance: number | null; bidNotionalNear: number; askNotionalNear: number; stale: boolean }[] };
  liquidations: { status: string; windowMin: number; longLiqUsd: number; shortLiqUsd: number; count: number; stream: string; top: { symbol: string; notionalUsd: number }[] };
  data_quality: { status: string; coverage_ratio: number; missing_features: string[] };
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 2, padding: "10px 12px" }}>
      <div style={{ fontSize: 9.5, letterSpacing: 1, color: colors.textMuted }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: tone ?? colors.text, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function DqBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    FRESH: { bg: colors.upBg, fg: colors.up },
    PARTIAL: { bg: colors.warnBg, fg: colors.warn },
    STALE: { bg: colors.downBg, fg: colors.down },
    INVALID: { bg: colors.downBg, fg: colors.down },
  };
  const s = map[status] ?? { bg: colors.bgInput, fg: colors.textMuted };
  return <span style={{ background: s.bg, color: s.fg, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999 }}>{status}</span>;
}

export function MarketIntelPanel() {
  const [intel, setIntel] = useState<Intel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [age, setAge] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/market-intel");
        if (!alive) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setIntel(await r.json());
        setErr(null);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setAge(Math.floor((Date.now() - (intel?.computed_at_ms ?? 0)) / 1000)), 1000);
    return () => clearInterval(id);
  }, [intel?.computed_at_ms]);

  if (err && !intel) {
    return <div style={{ fontSize: 12, color: colors.down, padding: "8px 0" }}>Market Intel error: {err}</div>;
  }
  if (!intel) return <div style={{ fontSize: 12, color: colors.textMuted, padding: "8px 0" }}>Memuat market intelligence…</div>;

  const b1 = intel.breadth_1h;
  const b24 = intel.breadth;
  const b1Tot = Math.max(1, b1.valid);
  const b24Tot = Math.max(1, b24.valid);
  const liqNet = intel.liquidations.longLiqUsd - intel.liquidations.shortLiqUsd;
  const dqTone = intel.data_quality.status === "FRESH" ? colors.up : intel.data_quality.status === "STALE" ? colors.down : colors.warn;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <DqBadge status={intel.data_quality.status} />
        <span style={{ fontSize: 10.5, color: colors.textMuted }}>
          snapshot {age < 90 ? `${age}s lalu` : `${Math.floor(age / 60)}m lalu`} · id {intel.analysis_id} · coverage {(intel.data_quality.coverage_ratio * 100).toFixed(0)}%
          {intel.data_quality.missing_features.length > 0 && ` · missing: ${intel.data_quality.missing_features.join(", ")}`}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        <Stat label="REGIME BTC (1H)" value={intel.regime.label} tone={intel.regime.label === "TREND_UP" ? colors.up : intel.regime.label === "TREND_DOWN" ? colors.down : colors.text} />
        <Stat label="BTC RS vs MAJOR (1H)" value={`${intel.btc_relative_strength.classification}${intel.btc_relative_strength.value_1h != null ? ` (${intel.btc_relative_strength.value_1h > 0 ? "+" : ""}${intel.btc_relative_strength.value_1h}%)` : ""}`} />
        <Stat label="BREADTH 1H" value={`${b1.positive}/${b1.negative} (${b1.valid} valid)`} tone={b1.positive > b1.negative ? colors.up : b1.negative > b1.positive ? colors.down : colors.text} />
        <Stat label="BREADTH 24H" value={`${b24.positive}/${b24.negative} (${b24.valid} valid)`} tone={b24.positive > b24.negative ? colors.up : b24.negative > b24.positive ? colors.down : colors.text} />
        <Stat label={`LIQUIDATIONS ${intel.liquidations.windowMin}M`} value={usd(intel.liquidations.longLiqUsd + intel.liquidations.shortLiqUsd)} tone={liqNet > 0 ? colors.down : liqNet < 0 ? colors.up : colors.text} />
        <Stat label="LIQ STREAM" value={intel.liquidations.stream} tone={intel.liquidations.stream.startsWith("CONNECTED") ? colors.up : colors.warn} />
      </div>
      {/* Detail likuiditas per simbol + top likuidasi */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
        <div style={{ fontSize: 11, color: colors.textMuted, lineHeight: 1.8 }}>
          <span style={{ color: colors.text, fontWeight: 600 }}>Order book ±0.25%:</span>{" "}
          {intel.liquidity.symbols.length === 0 && "tidak tersedia"}
          {intel.liquidity.symbols.map((s) => (
            <div key={s.symbol}>
              {s.symbol}: imbalance {(s.imbalance ?? 0) >= 0 ? "+" : ""}{s.imbalance ?? "n/a"} (bid {usd(s.bidNotionalNear)} / ask {usd(s.askNotionalNear)}){s.stale && " ⚠ stale"}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: colors.textMuted, lineHeight: 1.8 }}>
          <span style={{ color: colors.text, fontWeight: 600 }}>Top likuidasi:</span>
          {intel.liquidations.top.length === 0 && " · (tidak ada event 2 jam; stream hidup tanpa event ≠ basi)"}
          {intel.liquidations.top.map((t) => (
            <div key={t.symbol}>{t.symbol}: {usd(t.notionalUsd)}</div>
          ))}
          <div style={{ marginTop: 4, fontSize: 10, color: colors.textMuted }}>
            Net long liq − short liq: {usd(liqNet)} · {liqNet > 0 ? "tekanan long dominan" : liqNet < 0 ? "tekanan short dominan" : "seimbang/tanpa event"}
          </div>
        </div>
      </div>
    </div>
  );
}
