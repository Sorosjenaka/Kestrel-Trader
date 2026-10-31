// apps/web/src/pages/LabPage.tsx — Halaman Lab Eksperimen (CP-8, T-25/T-26/T-27).
// DISPLAY-ONLY: semua angka dihitung server (labEngine.ts) — halaman ini hanya
// merender hasil API, TIDAK menghitung statistik apa pun di client (Golden Rules #1).
// Lab = riset: tidak pernah menyentuh jalur trading / order / sizing live.
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import type { EChartsOption } from "echarts";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, card } from "../theme.js";
import { Panel, Btn, EmptyState } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { EChart } from "../components/EChart.js";

type LabInterval = "1m" | "3m" | "5m" | "15m" | "1h" | "4h" | "1d";
type LabIndicator = "RSI" | "EMA" | "SMA" | "ATR" | "MACD" | "BB" | "PRICE" | "VOLUME";
type LabOperator = "CROSS_ABOVE" | "CROSS_BELOW" | "GT" | "LT";

interface LabOperand {
  kind: "INDICATOR" | "VALUE";
  indicator?: LabIndicator;
  period?: number;
  source?: "close" | "high" | "low" | "open" | "hl2";
  line?: "macd" | "signal" | "hist" | "upper" | "lower" | "basis";
  value?: number;
}

interface LabCondition { left: LabOperand; op: LabOperator; right: LabOperand }

type LabExitSpec =
  | { kind: "ATR_MULT"; atrPeriod?: number; mult?: number }
  | { kind: "PCT"; value?: number }
  | { kind: "PRICE"; value?: number }
  | { kind: "R_MULT"; value?: number };

interface LabStats {
  sampleCount: number; winCount: number; winrate: number; profitFactor: number;
  sumR: number; avgR: number; maxDdR: number; avgHoldBars: number;
  perSide: { LONG: { n: number; winrate: number; sumR: number }; SHORT: { n: number; winrate: number; sumR: number } };
  intrabarBand: { slFirst: { sumR: number; winrate: number }; tpFirst: { sumR: number; winrate: number } };
  validation: { name: string; ok: boolean; detail: string }[];
}

interface LabResult {
  spec: { name: string; symbol: string; interval: string; direction: string };
  stats: LabStats;
  trades: { direction: string; entryTime: number; exitTime: number; entryPrice: number; exitPrice: number; exitReason: string; rMultiple: number; pnlPct: number; holdBars: number }[];
  equity: { t: number; r: number }[];
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  markers: { t: number; price: number; kind: string; direction: string }[];
  barsUsed: number; barsRequested: number; caveats: string[]; runtimeMs: number;
}

interface ParsedPine { ok: boolean; spec?: Record<string, unknown>; mapped: string[]; unmapped: string[]; notes: string[] }

const INTERVALS: LabInterval[] = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"];
const INDICATORS: LabIndicator[] = ["RSI", "EMA", "SMA", "ATR", "MACD", "BB", "PRICE", "VOLUME"];
const OPERATORS: LabOperator[] = ["CROSS_ABOVE", "CROSS_BELOW", "GT", "LT"];

// 14 Okt 2026: input angka boleh kosong — "" disimpan undefined, bukan dipaksa 0
// (dulu Number("") = 0 bikin angka 0 "menempel" dan tak bisa dihapus).
function numInput(v: string): number | undefined {
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
function isoDate(d: Date): string { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "·";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(2) : a >= 1 ? v.toFixed(4) : v.toFixed(8);
}
function fmtR(v: number): string { return Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(3)}R` : "·"; }
function fmtPct(v: number): string { return Number.isFinite(v) ? `${v.toFixed(2)}%` : "·"; }

const th: React.CSSProperties = {
  textAlign: "right", padding: "6px 10px", fontSize: 10.5, letterSpacing: "0.4px",
  fontWeight: 600, color: colors.textMuted, borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  textAlign: "right", padding: "6px 10px", fontSize: 12,
  borderBottom: "1px solid rgba(35,42,56,0.55)", color: colors.text,
  fontFamily: fonts.mono, whiteSpace: "nowrap",
};
const label: React.CSSProperties = { fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px", display: "block", marginBottom: 3 };
const input: React.CSSProperties = {
  background: colors.bgInput, color: colors.textStrong, border: `1px solid ${colors.borderLight}`, borderRadius: 6,
  padding: "6px 9px", fontSize: 12.5, fontFamily: fonts.main, width: "100%", outline: "none",
};

function defaultCondition(): LabCondition {
  return {
    left: { kind: "INDICATOR", indicator: "RSI", period: 14, source: "close" },
    op: "LT",
    right: { kind: "VALUE", value: 35 },
  };
}

// ── Chart: candle + penanda entry/exit (T-26) ──
function CandleChart({ result }: { result: LabResult }) {
  const cs = result.candles;
  const W = 940, H = 340;
  if (cs.length === 0) return <div style={{ padding: 20, color: colors.textMuted }}>Tidak ada candle untuk digambar.</div>;
  const lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
  const padY = (hi - lo) * 0.06 || 1;
  const yMin = lo - padY, yMax = hi + padY;
  const x = (i: number) => 10 + (i * (W - 70)) / Math.max(1, cs.length - 1);
  const y = (p: number) => 12 + ((yMax - p) / (yMax - yMin)) * (H - 40);
  const cw = Math.max(1.5, (W - 70) / cs.length - 1.6);
  const markColor: Record<string, string> = { ENTRY: colors.warn, EXIT_TP: colors.up, EXIT_SL: colors.down, EXIT_EOD: colors.purple };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 340, display: "block" }} aria-label="chart hasil Lab">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W - 60} y1={12 + f * (H - 40)} y2={12 + f * (H - 40)} stroke={colors.border} strokeWidth={1} />
      ))}
      {cs.map((c, i) => {
        const up = c.c >= c.o;
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={up ? colors.up : colors.down} strokeWidth={1} />
            <rect x={x(i) - cw / 2} y={Math.min(y(c.o), y(c.c))} width={cw}
              height={Math.max(1, Math.abs(y(c.o) - y(c.c)))}
              fill={up ? colors.upBg : colors.downBg} stroke={up ? colors.up : colors.down} strokeWidth={1} />
          </g>
        );
      })}
      {result.markers.map((m, i) => {
        const mi = cs.reduce((best, c, j) => (Math.abs(c.t - m.t) < Math.abs(cs[best].t - m.t) ? j : best), 0);
        const mx = x(mi), my = y(m.price);
        const col = markColor[m.kind] ?? colors.accent;
        const buy = m.direction === "LONG";
        return (
          <g key={`m${i}`}>
            <polygon points={buy ? `${mx},${my - 7} ${mx - 5},${my + 2} ${mx + 5},${my + 2}` : `${mx},${my + 7} ${mx - 5},${my - 2} ${mx + 5},${my - 2}`}
              fill={col} stroke={colors.bgPanel} strokeWidth={0.8} />
          </g>
        );
      })}
      <line x1={W - 60} x2={W - 60} y1={12} y2={H - 28} stroke={colors.border} strokeWidth={1} />
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={W - 56} y={16 + f * (H - 40)} fill={colors.textMuted} fontSize={9} fontFamily={fonts.mono}>
          {fmtPrice(yMax - f * (yMax - yMin))}
        </text>
      ))}
    </svg>
  );
}

// ── Kurva ekuitas R (T-26) — EChart Tahap 3 ──
function EquityChart({ equity }: { equity: { t: number; r: number }[] }) {
  const option: EChartsOption = useMemo(() => {
    if (equity.length === 0) return {};
    return {
      grid: { top: 16, right: 12, bottom: 24, left: 44 },
      xAxis: {
        type: "category" as const,
        data: equity.map((_, i) => String(i + 1)),
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { color: colors.textDim, fontSize: 9, fontFamily: fonts.mono, formatter: (v: number) => `${v.toFixed(1)}R` },
        splitLine: { lineStyle: { color: colors.border } },
      },
      tooltip: { trigger: "axis" as const, backgroundColor: colors.card, borderColor: colors.borderLight, textStyle: { color: colors.text, fontSize: 10, fontFamily: fonts.mono }, formatter: (p: any) => `Trade #${p[0]?.dataIndex + 1}: ${fmtR(p[0]?.value ?? 0)}` },
      series: [{
        type: "line" as const,
        data: equity.map((e) => e.r),
        smooth: false,
        symbol: "none",
        lineStyle: { color: colors.accent, width: 1.6 },
        areaStyle: { color: { type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(224,34,44,0.12)" }, { offset: 1, color: "rgba(224,34,44,0)" }] } },
        markLine: { silent: true, symbol: "none", lineStyle: { color: colors.border, type: "dashed" as const, width: 1 }, label: { show: false }, data: [{ yAxis: 0 }] },
      }],
    };
  }, [equity]);
  if (equity.length === 0) return <div style={{ padding: 12, color: colors.textMuted, fontSize: 11 }}>Belum ada titik ekuitas.</div>;
  return <EChart option={option} style={{ height: 130 }} />;
}

// ── Tabel statistik + band intrabar (T-27) ──
function StatsTable({ result }: { result: LabResult }) {
  const s = result.stats;
  const band = s.intrabarBand;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {[
            ["sample (n)", String(s.sampleCount)],
            ["win / loss", `${s.winCount} / ${s.sampleCount - s.winCount}`],
            ["winrate", fmtPct(s.winrate)],
            ["profit factor", Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : "·"],
            ["sum R", fmtR(s.sumR)],
            ["avg R / trade", fmtR(s.avgR)],
            ["max drawdown", fmtR(-Math.abs(s.maxDdR))],
            ["avg hold", `${s.avgHoldBars} bar`],
            ["bar dipakai", `${result.barsUsed} / ${result.barsRequested}`],
            ["runtime", `${result.runtimeMs} ms`],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...td, textAlign: "left", color: colors.textMuted, fontSize: 11, fontFamily: fonts.main }}>{k}</td>
              <td style={td}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={{ ...th, textAlign: "left" }}>BAND INTRABAR</th><th style={th}>sum R</th><th style={th}>winrate</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...td, textAlign: "left", color: colors.down, fontSize: 11 }}>SL-FIRST (pesimis)</td>
              <td style={td}>{fmtR(band.slFirst.sumR)}</td><td style={td}>{fmtPct(band.slFirst.winrate)}</td>
            </tr>
            <tr>
              <td style={{ ...td, textAlign: "left", color: colors.up, fontSize: 11 }}>TP-FIRST (optimis)</td>
              <td style={td}>{fmtR(band.tpFirst.sumR)}</td><td style={td}>{fmtPct(band.tpFirst.winrate)}</td>
            </tr>
          </tbody>
        </table>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
          <thead>
            <tr><th style={{ ...th, textAlign: "left" }}>PER SISI</th><th style={th}>n</th><th style={th}>winrate</th><th style={th}>sum R</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...td, textAlign: "left", color: colors.up, fontSize: 11 }}>LONG</td>
              <td style={td}>{s.perSide.LONG.n}</td><td style={td}>{fmtPct(s.perSide.LONG.winrate)}</td><td style={td}>{fmtR(s.perSide.LONG.sumR)}</td>
            </tr>
            <tr>
              <td style={{ ...td, textAlign: "left", color: colors.down, fontSize: 11 }}>SHORT</td>
              <td style={td}>{s.perSide.SHORT.n}</td><td style={td}>{fmtPct(s.perSide.SHORT.winrate)}</td><td style={td}>{fmtR(s.perSide.SHORT.sumR)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LabPage() {
  const [name, setName] = useState("Eksperimen Lab");
  // 14 Okt 2026: MULTI PAIR — pilih 1..5 pair (klik chip atau ketik + tambah).
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [symbolDraft, setSymbolDraft] = useState("");
  // 14 Okt 2026 (permintaan operator): Lab tidak lagi hanya BTCUSDT — daftar
  // pair futures aktif dari /api/binance/pairs (sumber sama dengan terminal).
  const [pairList, setPairList] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/binance/pairs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.pairs)) {
          setPairList(d.pairs.map((p: { symbol: string }) => String(p.symbol).toUpperCase()).filter(Boolean));
        }
      })
      .catch(() => {}); // gagal load daftar → input tetap bebas (fail-open)
  }, []);
  // 14 Okt 2026: MULTI TIME FRAME — pilih 1..7 TF, backtest dijalankan per TF.
  const [intervals, setIntervals] = useState<LabInterval[]>(["5m"]);
  const [results, setResults] = useState<LabResult[]>([]);
  const [activeTf, setActiveTf] = useState<string>("5m");
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 14 * 86400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [direction, setDirection] = useState<"LONG" | "SHORT" | "BOTH">("BOTH");
  const [conds, setConds] = useState<LabCondition[]>([defaultCondition()]);
  const [sl, setSl] = useState<LabExitSpec>({ kind: "PCT", value: 1 });
  const [tp, setTp] = useState<LabExitSpec>({ kind: "R_MULT", value: 1.5 });
  const [tvUrl, setTvUrl] = useState("");
  const [pineSrc, setPineSrc] = useState("");
  const [importInfo, setImportInfo] = useState<{ title?: string; license?: string; message?: string; mapped: string[]; unmapped: string[]; notes: string[] } | null>(null);
  const result = results.find((r) => `${r.spec.symbol}-${r.spec.interval}` === activeTf) ?? results[0] ?? null;
  const [history, setHistory] = useState<{ id: string; createdAt: number; spec: Record<string, unknown> & { name: string; symbol: string; interval: string }; stats: { sampleCount: number; winrate: number; sumR: number; profitFactor: number } }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(() => {
    fetch("/api/lab/experiments").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.ok && Array.isArray(d.experiments)) setHistory(d.experiments);
    }).catch(() => {});
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const setCond = (i: number, patch: Partial<LabCondition>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function applyParsedSpec(spec: Record<string, unknown>) {
    if (typeof spec.name === "string") setName(spec.name);
    if (typeof spec.symbol === "string") {
      const sy = String(spec.symbol).toUpperCase();
      setSymbols((cur) => (cur.length === 1 && cur[0] === "BTCUSDT" ? [sy] : cur.includes(sy) ? cur : [...cur, sy].slice(0, 5)));
    }
    if (typeof spec.interval === "string" && INTERVALS.includes(spec.interval as LabInterval)) setIntervals([spec.interval as LabInterval]);
    if (typeof spec.direction === "string") setDirection(spec.direction as "LONG" | "SHORT" | "BOTH");
    if (Array.isArray(spec.entryConditions) && spec.entryConditions.length > 0) setConds(spec.entryConditions as LabCondition[]);
    if (spec.sl) setSl(spec.sl as LabExitSpec);
    if (spec.tp) setTp(spec.tp as LabExitSpec);
    setImportInfo((prev) => prev ? { ...prev } : prev);
  }

  async function parseLink() {
    setError(""); setBusy(true);
    try {
      const res = await fetch("/api/lab/parse-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: tvUrl }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        // 14 Okt 2026: pesan error yang JELAS — status HTTP + alasan server +
        // panduan (bukan tulisan aneh "tidak dikenali").
        const alasan = d.error ?? `HTTP ${res.status}`;
        setError(
          alasan.includes("HTTP 404") || alasan.includes("tidak bisa diambil")
            ? `Link tidak bisa dibuka (${alasan}). Cek: (1) URL lengkap mulai https://www.tradingview.com/script/... (2) halaman bisa dibuka di browser tanpa login. Script invite-only/premium memang tidak bisa diambil otomatis · tempel kode Pine-nya di kolom bawah.`
            : alasan
        );
        return;
      }
      // Auto-detect nama eksperimen dari judul script TradingView.
      if (d.meta?.title && (name === "Eksperimen Lab" || !name.trim())) setName(d.meta.title.slice(0, 80));
      setImportInfo({
        title: d.meta?.title, license: d.meta?.license,
        message: d.message ?? (d.source ? "Sumber Pine terambil." : "Sumber tidak tersedia."),
        mapped: d.parsed?.mapped ?? [], unmapped: d.parsed?.unmapped ?? [], notes: d.parsed?.notes ?? [],
      });
      if (d.parsed?.spec) applyParsedSpec(d.parsed.spec);
    } catch {
      setError("Gagal menghubungi server Lab");
    } finally { setBusy(false); }
  }

  async function parsePine() {
    setError(""); setBusy(true);
    try {
      const res = await fetch("/api/lab/parse-pine", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: pineSrc, symbol: symbols[0], interval: intervals[0], name, tvUrl: tvUrl || undefined }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setError(
          d.error ? `${d.error} · pastikan kode Pine lengkap mulai dari baris //@version atau strategy()/indicator().` : `Gagal parse Pine (HTTP ${res.status})`
        );
        return;
      }
      const p: ParsedPine = d.parsed;
      // Auto-detect nama dari strategy("Nama ...") / komentar judul di kode Pine.
      const nm = typeof (p.spec as { name?: unknown } | undefined)?.name === "string" ? (p.spec as { name: string }).name : null;
      if (nm && (name === "Eksperimen Lab" || !name.trim())) setName(nm.slice(0, 80));
      setImportInfo({
        message: p.ok ? "Pine terparse · builder sudah diisi otomatis." : "Pine terparse sebagian · cek catatan di bawah.",
        mapped: p.mapped, unmapped: p.unmapped, notes: p.notes,
      });
      if (p.spec) applyParsedSpec(p.spec);
    } catch {
      setError("Gagal menghubungi server Lab");
    } finally { setBusy(false); }
  }

  async function runBacktest() {
    setError(""); setResults([]); setBusy(true);
    try {
      const spec = {
        name, symbols, interval: intervals[0], intervals,
        direction,
        from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`,
        entryConditions: conds, sl, tp,
        source: importInfo ? "PINE_IMPORT" : "MANUAL_BLOCK",
        tvUrl: tvUrl || undefined, pineSource: pineSrc || undefined,
      };
      const res = await fetch("/api/lab/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { setError(d.error ?? "Backtest gagal"); return; }
      const rs: LabResult[] = Array.isArray(d.results) && d.results.length > 0
        ? d.results.map((x: { result: LabResult }) => x.result)
        : [d.result as LabResult];
      setResults(rs);
      setActiveTf(`${rs[0]!.spec.symbol}-${rs[0]!.spec.interval}`);
      loadHistory();
    } catch {
      setError("Gagal menghubungi server Lab");
    } finally { setBusy(false); }
  }

  const gatePassed = result ? result.stats.validation.every((v) => v.ok) : true;

  // Tahap 3: kolom DataTable riwayat eksperimen.
  const historyColumns: ColumnDef<typeof history[number], any>[] = useMemo(() => [
    { accessorKey: "createdAt", header: "Waktu", cell: (info) => <span style={{ color: colors.textMuted, fontSize: 11 }}>{new Date(info.getValue() as number).toISOString().slice(0, 16).replace("T", " ")}</span> },
    { accessorKey: "spec.name", header: "Nama", cell: (info) => <span style={{ fontFamily: fonts.main }}>{(info.row.original as any).spec.name}</span> },
    { id: "symbol", header: "Simbol", cell: (info) => { const s = (info.row.original as any).spec; return `${s.symbol} ${s.interval}`; } },
    { accessorKey: "stats.sampleCount", header: "n", meta: { align: "right" }, cell: (info) => (info.row.original as any).stats.sampleCount },
    { accessorKey: "stats.winrate", header: "WR", meta: { align: "right" }, cell: (info) => fmtPct((info.row.original as any).stats.winrate) },
    { accessorKey: "stats.profitFactor", header: "PF", meta: { align: "right" }, cell: (info) => { const pf = (info.row.original as any).stats.profitFactor; return Number.isFinite(pf) ? pf.toFixed(2) : "·"; } },
    { accessorKey: "stats.sumR", header: "Sum R", meta: { align: "right" }, cell: (info) => { const v = (info.row.original as any).stats.sumR; return <span style={{ color: v >= 0 ? colors.up : colors.down }}>{fmtR(v)}</span>; } },
    { id: "load", header: "", cell: (info) => <Btn tone="default" title="Muat spek eksperimen ini ke builder" onClick={() => applyParsedSpec((info.row.original as any).spec)}>MUAT</Btn> },
  ], []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── IMPOR: link TradingView / Pine (CP-9) ── */}
      <Panel title="IMPOR · LINK TRADINGVIEW / PINE (OPEN-SOURCE ONLY)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 8 }}>
          <div>
            <span style={label}>URL SCRIPT TRADINGVIEW</span>
            <input style={input} value={tvUrl} onChange={(e) => setTvUrl(e.target.value)}
              placeholder="https://www.tradingview.com/script/..." />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <Btn disabled={busy || !tvUrl.trim()} onClick={parseLink}>AMBIL LINK</Btn>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <span style={label}>ATAU TEMPEL KODE PINE (LEBIH ANDAL · HALAMAN TV MEMUAT KODE VIA JS)</span>
            <textarea style={{ ...input, height: 74, resize: "vertical" }} value={pineSrc}
              onChange={(e) => setPineSrc(e.target.value)} placeholder="//@version=5&#10;strategy(&quot;...&quot;)" />
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <Btn disabled={busy || !pineSrc.trim()} onClick={parsePine}>PARSE PINE → ISI BUILDER</Btn>
          </div>
          {importInfo && (
            <div style={{ gridColumn: "1 / -1", background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 8, fontSize: 11.5, fontFamily: fonts.mono }}>
              {importInfo.title && <div style={{ color: colors.text }}>Judul: {importInfo.title} · Lisensi: <b style={{ color: importInfo.license === "open-source" ? colors.up : colors.down }}>{importInfo.license ?? "unknown"}</b></div>}
              {importInfo.message && <div style={{ color: colors.warn, marginTop: 3 }}>{importInfo.message}</div>}
              {importInfo.mapped.length > 0 && <div style={{ color: colors.up, marginTop: 3 }}>Dikenali ({importInfo.mapped.length}): {importInfo.mapped.slice(0, 6).join(" | ")}</div>}
              {importInfo.unmapped.length > 0 && <div style={{ color: colors.down, marginTop: 3 }}>TIDAK dikenali ({importInfo.unmapped.length}) · tidak dikarang: {importInfo.unmapped.slice(0, 6).join(" | ")}</div>}
              {importInfo.notes.map((n, i) => <div key={i} style={{ color: colors.textMuted, marginTop: 2 }}>▸ {n}</div>)}
            </div>
          )}
        </div>
      </Panel>

      {/* ── BUILDER blok eksperimen (T-25) ── */}
      <Panel title="BUILDER EKSPERIMEN">
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 1fr 1fr 1fr 1.2fr", gap: 8 }}>
          <div><span style={label}>NAMA</span><input style={input} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <span style={label}>SYMBOL (BISA MULTI, MAKS 5)</span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {symbols.map((sy) => (
                <span key={sy} style={{
                  fontSize: 11, padding: "4px 7px", borderRadius: 5, fontFamily: fonts.mono, fontWeight: 600,
                  background: colors.upBg, color: colors.up, border: `1px solid ${colors.up}`,
                }}>
                  {sy}{" "}
                  <button type="button" onClick={() => setSymbols((cur) => (cur.length > 1 ? cur.filter((x) => x !== sy) : cur))}
                    style={{ background: "none", border: "none", color: colors.down, cursor: "pointer", fontWeight: 700 }}>✕</button>
                </span>
              ))}
              <input style={{ ...input, width: 150, padding: "4px 7px" }} value={symbolDraft}
                onChange={(e) => setSymbolDraft(e.target.value.toUpperCase())} list="lab-pair-list"
                placeholder="tambah pair…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const sy = symbolDraft.trim().toUpperCase();
                    if (sy && !symbols.includes(sy) && symbols.length < 5) { setSymbols((cur) => [...cur, sy]); setSymbolDraft(""); }
                  }
                }} />
              {symbolDraft.trim().length >= 4 && !symbols.includes(symbolDraft.trim().toUpperCase()) && symbols.length < 5 && (
                <button type="button" onClick={() => { setSymbols((cur) => [...cur, symbolDraft.trim().toUpperCase()]); setSymbolDraft(""); }}
                  style={{ fontSize: 11, padding: "4px 8px", cursor: "pointer", borderRadius: 5, border: `1px solid ${colors.borderLight}`, background: colors.bgInput, color: colors.text }}>+ TAMBAH</button>
              )}
            </div>
            <datalist id="lab-pair-list">
              {pairList.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
          <div>
            <span style={label}>TIMEFRAME (BISA MULTI)</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {INTERVALS.map((iv) => {
                const on = intervals.includes(iv);
                return (
                  <button key={iv} type="button" onClick={() =>
                    setIntervals((cur) => (cur.includes(iv) ? (cur.length > 1 ? cur.filter((x) => x !== iv) : cur) : [...cur, iv]))
                  } style={{
                    fontSize: 11, padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontFamily: fonts.mono, fontWeight: 600,
                    border: `1px solid ${on ? colors.up : colors.borderLight}`,
                    background: on ? colors.upBg : colors.bgInput, color: on ? colors.up : colors.textMuted,
                  }}>{iv}</button>
                );
              })}
            </div>
          </div>
          <div><span style={label}>DARI (UTC)</span><input style={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><span style={label}>SAMPAI (UTC)</span><input style={input} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div><span style={label}>ARAH</span>
            <select style={input} value={direction} onChange={(e) => setDirection(e.target.value as "LONG" | "SHORT" | "BOTH")}>
              <option value="LONG">LONG</option><option value="SHORT">SHORT</option><option value="BOTH">BOTH</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <span style={label}>KONDISI ENTRY (SEMUA HARUS TRUE PADA BAR YANG SAMA · AND)</span>
          {conds.map((c, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1.4fr 32px", gap: 6, marginBottom: 6 }}>
              <select style={input} value={c.left.indicator ?? "VALUE"} onChange={(e) => {
                const v = e.target.value;
                setCond(i, { left: v === "VALUE" ? { kind: "VALUE", value: 0 } : { kind: "INDICATOR", indicator: v as LabIndicator, period: 14, source: "close" } });
              }}>
                {INDICATORS.map((x) => <option key={x} value={x}>{x}</option>)}
                <option value="VALUE">VALUE</option>
              </select>
              <input style={input} type="number" placeholder="period" value={c.left.period ?? ""} disabled={c.left.kind === "VALUE"}
                onChange={(e) => setCond(i, { left: { ...c.left, period: numInput(e.target.value) } })} />
              <select style={input} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as LabOperator })}>
                {OPERATORS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <select style={input} value={c.right.indicator ?? "VALUE"} onChange={(e) => {
                const v = e.target.value;
                setCond(i, { right: v === "VALUE" ? { kind: "VALUE", value: c.right.value ?? 0 } : { kind: "INDICATOR", indicator: v as LabIndicator, period: 14, source: "close" } });
              }}>
                <option value="VALUE">VALUE</option>
                {INDICATORS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input style={input} type="number" placeholder="period" value={c.right.period ?? ""} disabled={c.right.kind === "VALUE"}
                onChange={(e) => setCond(i, { right: { ...c.right, period: numInput(e.target.value) } })} />
              <input style={input} type="number" placeholder="nilai (VALUE)" value={c.right.kind === "VALUE" ? c.right.value ?? "" : ""} disabled={c.right.kind !== "VALUE"}
                onChange={(e) => setCond(i, { right: { kind: "VALUE", value: numInput(e.target.value) } })} />
              <Btn tone="danger" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}>✕</Btn>
            </div>
          ))}
          <Btn tone="ghost" onClick={() => setConds((cs) => [...cs, defaultCondition()])}>+ KONDISI</Btn>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr", gap: 8, alignItems: "end" }}>
          <div>
            <span style={label}>STOP LOSS</span>
            <div style={{ display: "flex", gap: 6 }}>
              <select style={{ ...input, width: 130 }} value={sl.kind} onChange={(e) => {
                const k = e.target.value as LabExitSpec["kind"];
                setSl(k === "ATR_MULT" ? { kind: "ATR_MULT", atrPeriod: 14, mult: 1 } : { kind: k, value: k === "PRICE" ? 0 : 1 });
              }}>
                <option value="PCT">% ENTRY</option><option value="R_MULT">R MULT</option><option value="ATR_MULT">ATR MULT</option><option value="PRICE">HARGA ABSOLUT</option>
              </select>
              {sl.kind === "ATR_MULT" ? (
                <>
                  <input style={input} type="number" value={sl.atrPeriod ?? ""} onChange={(e) => setSl({ kind: "ATR_MULT", atrPeriod: numInput(e.target.value), mult: sl.mult })} />
                  <input style={input} type="number" value={sl.mult ?? ""} onChange={(e) => setSl({ kind: "ATR_MULT", atrPeriod: sl.atrPeriod, mult: numInput(e.target.value) })} />
                </>
              ) : (
                <input style={input} type="number" step="0.1" value={sl.value ?? ""} onChange={(e) => setSl({ kind: sl.kind, value: numInput(e.target.value) } as LabExitSpec)} />
              )}
            </div>
          </div>
          <div>
            <span style={label}>TAKE PROFIT</span>
            <div style={{ display: "flex", gap: 6 }}>
              <select style={{ ...input, width: 130 }} value={tp.kind} onChange={(e) => {
                const k = e.target.value as LabExitSpec["kind"];
                setTp(k === "ATR_MULT" ? { kind: "ATR_MULT", atrPeriod: 14, mult: 2 } : { kind: k, value: k === "PRICE" ? 0 : k === "PCT" ? 2 : 1.5 });
              }}>
                <option value="R_MULT">R MULT</option><option value="PCT">% ENTRY</option><option value="ATR_MULT">ATR MULT</option><option value="PRICE">HARGA ABSOLUT</option>
              </select>
              {tp.kind === "ATR_MULT" ? (
                <>
                  <input style={input} type="number" value={tp.atrPeriod ?? ""} onChange={(e) => setTp({ kind: "ATR_MULT", atrPeriod: numInput(e.target.value), mult: tp.mult })} />
                  <input style={input} type="number" value={tp.mult ?? ""} onChange={(e) => setTp({ kind: "ATR_MULT", atrPeriod: tp.atrPeriod, mult: numInput(e.target.value) })} />
                </>
              ) : (
                <input style={input} type="number" step="0.1" value={tp.value ?? ""} onChange={(e) => setTp({ kind: tp.kind, value: numInput(e.target.value) } as LabExitSpec)} />
              )}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <Btn tone="primary" disabled={busy} onClick={runBacktest}>
              {busy ? "MEMPROSES…" : "▶ RUN BACKTEST"}
            </Btn>
          </div>
        </div>
      </Panel>

      {error && (
        <div style={{ border: `1px solid ${colors.down}`, background: colors.downBg, color: colors.down, padding: "8px 12px", borderRadius: 6, fontSize: 12 }}>
          ERROR: {error}
        </div>
      )}

      {/* ── GATE VALIDASI (T-30): gagal = tanpa angka ── */}
      {result && !gatePassed && (
        <Panel title="GATE VALIDASI">
          <div style={{ fontSize: 12 }}>
            <b style={{ color: colors.down }}>GATE VALIDASI GAGAL · ANGKA TIDAK DITAMPILKAN.</b>
            {result.stats.validation.filter((v) => !v.ok).map((v, i) => (
              <div key={i} style={{ marginTop: 4, color: colors.warn }}>✕ {v.name}: {v.detail}</div>
            ))}
          </div>
        </Panel>
      )}

      {/* ── HASIL (T-26/T-27) ── */}
      {result && gatePassed && (
        <Panel title={`HASIL · ${result.spec.name} · ${result.spec.symbol} · ${result.spec.direction} · n=${result.stats.sampleCount} · sumR ${fmtR(result.stats.sumR)}`}>
          <div style={{ display: "grid", gap: 10 }}>
            {results.length > 1 && (
              <>
                <div>
                  <span style={label}>TIME FRAME (KLIK UNTUK GANTI)</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {results.map((r) => (
                      <button key={`${r.spec.symbol}-${r.spec.interval}`} type="button" onClick={() => setActiveTf(`${r.spec.symbol}-${r.spec.interval}`)} style={{
                        fontSize: 11, padding: "6px 10px", borderRadius: 5, cursor: "pointer", fontFamily: fonts.mono, fontWeight: 600,
                        border: `1px solid ${r.spec.interval === activeTf ? colors.up : colors.borderLight}`,
                        background: `${r.spec.symbol}-${r.spec.interval}` === activeTf ? colors.upBg : colors.bgInput,
                        color: `${r.spec.symbol}-${r.spec.interval}` === activeTf ? colors.up : colors.textMuted,
                      }}>
                        {r.spec.symbol} {r.spec.interval} · n={r.stats.sampleCount} · {fmtR(r.stats.sumR)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span style={label}>PERBANDINGAN ANTAR TIME FRAME (SAME SPEC)</span>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={{ ...th, textAlign: "left" }}>PAIR · TF</th><th style={th}>n</th><th style={th}>WINRATE</th>
                      <th style={th}>PF</th><th style={th}>SUM R</th><th style={th}>AVG R</th><th style={th}>MAX DD</th><th style={th}>HOLD</th>
                    </tr></thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={`${r.spec.symbol}-${r.spec.interval}`} onClick={() => setActiveTf(`${r.spec.symbol}-${r.spec.interval}`)} style={{ cursor: "pointer", background: `${r.spec.symbol}-${r.spec.interval}` === activeTf ? colors.bgInput : "transparent" }}>
                          <td style={{ ...td, textAlign: "left", fontWeight: 700, color: `${r.spec.symbol}-${r.spec.interval}` === activeTf ? colors.up : colors.text }}>{r.spec.symbol} · {r.spec.interval}</td>
                          <td style={td}>{r.stats.sampleCount}</td>
                          <td style={td}>{fmtPct(r.stats.winrate)}</td>
                          <td style={td}>{Number.isFinite(r.stats.profitFactor) ? r.stats.profitFactor.toFixed(2) : "∞"}</td>
                          <td style={{ ...td, color: r.stats.sumR >= 0 ? colors.up : colors.down }}>{fmtR(r.stats.sumR)}</td>
                          <td style={td}>{fmtR(r.stats.avgR)}</td>
                          <td style={td}>{r.stats.maxDdR.toFixed(2)}R</td>
                          <td style={td}>{r.stats.avgHoldBars.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div style={{ ...card, overflow: "hidden" }}>
              <CandleChart result={result} />
            </div>
            <div>
              <span style={label}>KURVA EKUITAS (R)</span>
              <div style={{ ...card, overflow: "hidden" }}>
                <EquityChart equity={result.equity} />
              </div>
            </div>
            <StatsTable result={result} />
            <div>
              <span style={label}>GATE VALIDASI ANGKA (SEMUA WAJIB OK)</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {result.stats.validation.map((v, i) => (
                  <span key={i} style={{
                    fontSize: 10, padding: "3px 7px", borderRadius: 4, fontFamily: fonts.mono, fontWeight: 600,
                    background: v.ok ? colors.upBg : colors.downBg, color: v.ok ? colors.up : colors.down,
                  }} title={v.detail}>{v.ok ? "✓" : "✕"} {v.name}</span>
                ))}
              </div>
            </div>
            {result.caveats.length > 0 && (
              <div>
                <span style={label}>CAVEAT JUJUR</span>
                {result.caveats.map((c, i) => (
                  <div key={i} style={{ fontSize: 11, color: colors.warn, marginTop: 2 }}>⚠ {c}</div>
                ))}
              </div>
            )}
            <details>
              <summary style={{ cursor: "pointer", fontSize: 11.5, color: colors.textMuted }}>Daftar trade ({result.trades.length}) · angka oleh server</summary>
              <div style={{ maxHeight: 260, overflow: "auto", marginTop: 6 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: "left" }}>#</th><th style={{ ...th, textAlign: "left" }}>SISI</th>
                      <th style={th}>ENTRY</th><th style={th}>EXIT</th><th style={{ ...th, textAlign: "left" }}>ALASAN</th>
                      <th style={th}>R</th><th style={th}>%</th><th style={th}>HOLD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i}>
                        <td style={{ ...td, textAlign: "left", color: colors.textMuted }}>{i + 1}</td>
                        <td style={{ ...td, textAlign: "left", color: t.direction === "LONG" ? colors.up : colors.down }}>{t.direction}</td>
                        <td style={td}>{fmtPrice(t.entryPrice)}</td>
                        <td style={td}>{fmtPrice(t.exitPrice)}</td>
                        <td style={{ ...td, textAlign: "left", fontFamily: fonts.main }}>{t.exitReason}</td>
                        <td style={{ ...td, color: t.rMultiple >= 0 ? colors.up : colors.down }}>{fmtR(t.rMultiple)}</td>
                        <td style={td}>{fmtPct(t.pnlPct)}</td>
                        <td style={td}>{t.holdBars}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </Panel>
      )}

      {/* ── RIWAYAT (T-24) · DataTable Tahap 3 ── */}
      <Panel title="RIWAYAT EKSPERIMEN">
        {history.length === 0 ? (
          <EmptyState>Belum ada eksperimen tersimpan.</EmptyState>
        ) : (
          <DataTable
            columns={historyColumns}
            data={history}
            maxHeight={240}
            emptyText="Belum ada eksperimen tersimpan."
          />
        )}
      </Panel>
    </div>
  );
}
