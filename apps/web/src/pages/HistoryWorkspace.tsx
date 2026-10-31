// apps/web/src/pages/HistoryWorkspace.tsx
// 29 Okt 2026 · Tahap 3 redesign Tema B ("X / ink").
//
// KONSEP: control surface terminal, sekarang di theme B:
//   - context bar (identitas + pill status + aksi kanan)
//   - toolbar filter (inline-select mono, compact)
//   - KPI strip dense (tabular mono, bukan kartu besar)
//   - equity curve: EChart (line + area gradien + tooltip titik hover)
//   - strategy breakdown + riwayat sesi + trade log: DataTable (sortable, trade log virtual)
//
// ATURAN EVIDENCE (skill production-trading-ops rule 12): SEMUA nilai yang
// dirender versi lama wajib tetap dirender dengan SEMANTIK YANG SAMA:
// nama strategi teknis, kode alasan mesin (Casing asli), dan qualifier arah.
// Tidak ada label "lebih ramah" yang menghapus bukti.
//
// Sumber data: TradeHistoryPage (fetch + state). File ini murni presentasi.
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { EChartsOption } from "echarts";
import { historyUrl } from "../lib/modePresentation";
import { colors, fonts } from "../theme.js";
import { Badge, Panel } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { EChart } from "../components/EChart.js";
import { apiFetch } from "../lib/api.js";
import {
  sessionLabelWib,
  sessionRangeWib,
  TradeDetailPanel,
  type TradeRecord,
  type AnalyticsSummary,
  type EquityPoint,
  type PaperDailySnapshot,
} from "./TradeHistoryPage.js";

/* ------------------------------------------------------------------ */
/* Local types (server shape)                                          */
/* ------------------------------------------------------------------ */

interface TradeFill {
  clientOrderId: string;
  exchangeOrderId?: string | null;
  side: string;
  type: string;
  qty: number;
  requestPrice: number;
  fillPrice?: number | null;
  reduceOnly: boolean;
  feeUsd?: number | null;
  status: string;
  createdAt: string;
  filledAt?: string | null;
  fillMode: "PAPER" | "EXCHANGE";
}

interface TradeDetailPanelProps {
  t: TradeRecord;
}

type StrategyStat = NonNullable<AnalyticsSummary["strategyStats"]>[number];

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "·";
  const n = Number(v);
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs < 0.0001 ? 8 : abs < 0.01 ? 6 : abs < 1 ? 5 : abs < 1000 ? 4 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const pnlColor = (v: number) => (v > 0 ? colors.up : v < 0 ? colors.down : colors.textMuted);

function ModeTag({ mode, strategyId }: { mode: string; strategyId?: string | null }) {
  const isSwing = mode === "SWING";
  const cls = isSwing ? "context-pill paper" : "context-pill market";
  // 25 Okt 2026: label timeframe mengikuti signalTimeframe strategi per record
  // (registry swingEvalRegistry), BUKAN satu angka untuk seluruh mode:
  // RSW-01/RSW-02 sinyal H4 (PHEN/BOS), RSW-03 AlgoChief H1, S-03/S-05 H1.
  const tf = strategyId === "RSW-01" || strategyId === "RSW-02" ? "4H"
    : strategyId === "RSW-03" || strategyId === "S-03" || strategyId === "S-05" ? "1H"
    : "";
  return <span className={cls}>{mode === "SWING" ? (tf ? `SWING ${tf}` : "SWING") : mode === "SCALP" ? "SCALP 5M" : mode}</span>;
}

function OutcomeTag({ win, exitReason }: { win: boolean; exitReason: string }) {
  const color = win ? colors.up : colors.down;
  return (
    <span style={{ color, fontWeight: 700, fontFamily: fonts.mono, fontSize: 10 }}>
      {exitReason || (win ? "WIN" : "LOSS")}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Equity curve (EChart: line + area gradien + tooltip titik hover)  */
/* ------------------------------------------------------------------ */

function EquityCurve({ curve }: { curve: EquityPoint[] }) {
  const option = useMemo<EChartsOption>(() => {
    const equities = curve.map((p) => p.equity);
    const up = (equities[equities.length - 1] ?? 0) >= (equities[0] ?? 0);
    const lineColor = up ? colors.up : colors.down;
    return {
      backgroundColor: "transparent",
      animationDuration: 400,
      grid: { top: 18, right: 14, bottom: 26, left: 58 },
      xAxis: {
        type: "category",
        data: curve.map((p) => `#${p.tradeId}`),
        boundaryGap: false,
        axisLabel: { color: colors.textDim, fontSize: 9.5, fontFamily: fonts.mono, hideOverlap: true },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: {
          color: colors.textDim,
          fontSize: 9.5,
          fontFamily: fonts.mono,
          formatter: (v: number) => `$${v.toFixed(2)}`,
        },
        splitLine: { lineStyle: { color: colors.border } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: colors.bgPanel,
        borderColor: colors.borderLight,
        textStyle: { color: colors.textStrong, fontSize: 11, fontFamily: fonts.mono },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const idx = list[0]?.dataIndex ?? 0;
          const p = curve[idx];
          if (!p) return "";
          const pnlTone = p.pnl >= 0 ? colors.up : colors.down;
          return [
            `<div style="color:${colors.textMuted};font-weight:700">TRADE #${p.tradeId}</div>`,
            `EQUITY: <b>$${p.equity.toFixed(2)}</b>`,
            `PNL: <b style="color:${pnlTone}">${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}</b>`,
          ].join("<br/>");
        },
      },
      series: [
        {
          type: "line",
          data: equities,
          smooth: 0.25,
          symbol: "circle",
          symbolSize: 4,
          showSymbol: curve.length <= 80,
          lineStyle: { width: 1.6, color: lineColor, cap: "round", join: "round" },
          itemStyle: { color: lineColor, borderColor: colors.bgPanel, borderWidth: 1 },
          emphasis: { focus: "series", scale: 1.8 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${lineColor}3D` },
                { offset: 1, color: `${lineColor}00` },
              ],
            },
          },
        },
      ],
    };
  }, [curve]);

  if (curve.length < 2) {
    return (
      <div style={{ padding: "30px 14px", textAlign: "center", border: `1px dashed ${colors.borderLight}`, borderRadius: 2 }}>
        <div style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.warn, fontWeight: 700, letterSpacing: ".08em" }}>[STATUS: BERSIH / REAL-MARKET READY]</div>
        <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, fontFamily: fonts.mono }}>
          Riwayat periode lama disimpan untuk pembelajaran. Kurva periode arsip baru terbentuk saat trade berikutnya selesai. Saldo mengikuti akun LIVE.
        </div>
      </div>
    );
  }
  return <EChart option={option} style={{ width: "100%", height: 210 }} />;
}

/* ------------------------------------------------------------------ */
/* Main workspace                                                      */
/* ------------------------------------------------------------------ */

export function HistoryWorkspace() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [dailySnapshot, setDailySnapshot] = useState<PaperDailySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [modeFilter, setModeFilter] = useState<string>("ALL");
  const [strategyFilter, setStrategyFilter] = useState<string>("ALL");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("ALL");
  const [periodFilter, setPeriodFilter] = useState<"ALL" | "PREVIOUS" | "CURRENT">("ALL");
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const tradeTableRef = useRef<HTMLDivElement | null>(null);

  const requestedMode = useRef(modeFilter);
  requestedMode.current = modeFilter;
  const historyRequest = useRef(0);

  const fetchTrades = React.useCallback(async () => {
    const requestId = ++historyRequest.current;
    try {
      const res = await fetch(historyUrl(modeFilter));
      if (res.ok) {
        const data = await res.json();
        if (requestId !== historyRequest.current || requestedMode.current !== modeFilter) return;
        setTrades(data.trades || []);
        setAnalytics(data.analytics || null);
        setEquityCurve(data.equityCurve || []);
        setDailySnapshot(data.dailySnapshot || null);
        setLastSync(Date.now());
      }
    } catch (e) {
      console.error("Gagal mengambil data trade", e);
    } finally {
      if (requestId === historyRequest.current && requestedMode.current === modeFilter) setLoading(false);
    }
  }, [modeFilter]);

  useEffect(() => {
    setLoading(true);
    setTrades([]);
    setAnalytics(null);
    setEquityCurve([]);
    setExpandedTradeId(null);
    fetchTrades();
    const timer = window.setInterval(fetchTrades, 60_000);
    return () => { window.clearInterval(timer); historyRequest.current++; };
  }, [fetchTrades]);

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      // 30 Okt 2026 (B2, perintah operator): hanya baris LIVE yang tampil —
      // baris paper (PAPER_*) tidak ditampilkan (paper trading dimatikan).
      if (!String(t.source ?? "").startsWith("LIVE_")) return false;
      if (periodFilter !== "ALL") {
        // Filter jendela hari (07:00 WIB) berlaku untuk baris LIVE yang tersisa.
        if (!dailySnapshot) return false;
        const day = periodFilter === "CURRENT" ? dailySnapshot.current : dailySnapshot.previous;
        const closedAt = Date.parse(t.createdAt);
        if (!(closedAt >= Date.parse(day.fromUtc) && (periodFilter === "CURRENT" ? closedAt <= Date.parse(day.toUtc) : closedAt < Date.parse(day.toUtc)))) return false;
      }
      if (modeFilter !== "ALL" && t.mode !== modeFilter) return false;
      if (strategyFilter !== "ALL" && (t.strategyKey ?? t.strategyId) !== strategyFilter) return false;
      if (outcomeFilter === "WIN" && !t.win) return false;
      if (outcomeFilter === "LOSS" && t.win) return false;
      if (outcomeFilter === "BEP" && !t.exitReason.includes("BE")) return false;
      return true;
    });
  }, [trades, periodFilter, dailySnapshot, modeFilter, strategyFilter, outcomeFilter]);

  const exportCsv = () => {
    if (filteredTrades.length === 0) return;
    const header = "ID,ClosedAtUTC,SessionLabel_0700WIB,Symbol,Side,Mode,StrategyID,StrategyName,Entry,Exit,PnL_USD,R_Multiple,ExitReason\n";
    const rows = filteredTrades.map((t) =>
      [t.id, t.createdAt, sessionLabelWib(t.createdAt), t.symbol, t.side, t.mode, t.strategyId, `"${t.strategyName}"`, t.entryAvg, t.exitAvg, t.pnlUsd, t.rMultiple, t.exitReason].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `privatetrade_history_${modeFilter.toLowerCase()}_${periodFilter.toLowerCase()}_displayed_${Date.now()}.csv`;
    link.click();
  };

  const handlePurgeNonStrategy = async () => {
    const IMPURE = ["KILL", "LIQ_GAP", "TIMEOUT", "FUNDING"];
    const victims = trades.filter((t) => IMPURE.includes(t.exitReason));
    if (victims.length === 0) {
      alert("Bersih: tidak ada trade KILL/LIQ_GAP/TIMEOUT/FUNDING di history.");
      return;
    }
    const byReason = IMPURE.map((r) => {
      const n = victims.filter((t) => t.exitReason === r).length;
      return n > 0 ? `${n} ${r}` : null;
    }).filter(Boolean).join(", ");
    if (!window.confirm(`Hapus ${victims.length} trade non-strategi (${byReason}) beserta posisinya?\nTersisa hanya TP/SL/BE/TREND_FLIP. Winrate & balance terkoreksi otomatis. Learnings tetap disimpan.`)) return;
    try {
      const res = await apiFetch("/api/trades/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasons: IMPURE }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        alert(`Bersih: ${data.tradesDeleted} trade + ${data.positionsDeleted} posisi dihapus. Sisa ${data.remainingTrades} trade strategi.`);
        void fetchTrades();
      } else {
        alert(`Gagal membersihkan: ${data.error || "Server error"}`);
      }
    } catch (e) {
      console.error("Gagal purge non-strategi", e);
    }
  };

  // Geser tabel DataTable secara horizontal (tombol ◀ KIRI / ▶ KANAN).
  // DataTable membungkus tabelnya sendiri, jadi wrapper dipakai untuk mencari
  // elemen scroll internal (komponen tidak diubah).
  const scrollTableBy = (wrap: React.RefObject<HTMLDivElement | null>, dir: number) => {
    const inner = wrap.current?.firstElementChild as HTMLElement | null;
    if (inner) inner.scrollBy({ left: dir * 320, behavior: "smooth" });
  };

  // --- KPI derivation (logika identik versi lama) ---------------------
  const modeKpi = modeFilter === "SWING" ? analytics?.byMode?.SWING : modeFilter === "SCALP" ? analytics?.byMode?.SCALP : null;
  const totalTradesVal = modeKpi ? modeKpi.totalTrades : (analytics?.totalTrades ?? 0);
  const winCountVal = modeKpi ? modeKpi.winCount : (analytics?.winCount ?? 0);
  const lossCountVal = modeKpi ? modeKpi.lossCount : (analytics?.lossCount ?? 0);
  const winRatePctVal = modeKpi ? modeKpi.winRatePct : (analytics?.winRatePct ?? 0);
  const netPnlUsdVal = modeKpi ? modeKpi.netPnlUsd : (analytics?.netPnlUsd ?? 0);
  const profitFactorVal = modeKpi ? modeKpi.profitFactor : (analytics?.profitFactor ?? 0);
  const avgRVal = modeKpi ? modeKpi.avgR : (analytics?.avgR ?? 0);
  // 25 Okt 2026: cohort SWING campur timeframe (RSW-01/02 sinyal H4, RSW-03 H1)
  // jadi jangan mengklaim satu timeframe untuk seluruh mode.
  const modeTitle = modeFilter === "SWING" ? "SWING (4H / 1H)" : modeFilter === "SCALP" ? "SCALPING 5M" : "SEMUA ERA";
  const modeSub = modeFilter === "SWING" ? "Cohort SWING (Polaris, Orion, Vega, Draco)" : modeFilter === "SCALP" ? "Cohort SCALPING 5m (S-02 aktif; S-01 arsip)" : "Semua mode sejak reset periode";

  const strategyRows = (analytics?.strategyStats ?? []).filter((st) => {
    if (st.id === "S-00" || st.id === "S-99") return false;
    if (modeFilter === "SWING") return ["RSW-01", "RSW-02", "RSW-03"].includes(st.id);
    if (modeFilter === "SCALP") return ["S-01", "S-02"].includes(st.id);
    return true;
  });

  const syncAge = lastSync ? `${Math.max(0, Math.round((Date.now() - lastSync) / 1000))}S AGO` : "·";

  /* ---------------------------------------------------------------- */
  /* Kolom DataTable                                                   */
  /* ---------------------------------------------------------------- */

  // TRADE LOG: kolom sama persis dengan tabel manual sebelumnya. Grup sesi
  // PAPER yang dulu jadi baris header dipindah ke kolom SESI (label sesi WIB
  // + rentang jam), jadi teks sesi tidak hilang.
  const tradeColumns: ColumnDef<TradeRecord, any>[] = useMemo(() => [
    {
      id: "sesi",
      header: "SESI",
      accessorFn: (r) => sessionLabelWib(r.createdAt),
      cell: ({ row }) => {
        const label = sessionLabelWib(row.original.createdAt);
        const range = sessionRangeWib(label);
        return (
          <span title={`SESI ${label} · ${range}`} style={{ display: "inline-block" }}>
            <span style={{ fontWeight: 700, color: colors.warn, fontSize: 10 }}>SESI {label}</span>
            <span style={{ display: "block", fontSize: 9, color: colors.textMuted }}>{range}</span>
          </span>
        );
      },
    },
    { accessorKey: "id", header: "#ID", cell: ({ row }) => <span style={{ color: colors.textMuted }}>#{row.original.id}</span> },
    {
      accessorKey: "createdAt",
      header: "TIME",
      cell: ({ row }) => (
        <span>{new Date(row.original.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" })} WIB</span>
      ),
    },
    {
      accessorKey: "symbol",
      header: "SYMBOL",
      cell: ({ row }) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{row.original.symbol}</span>,
    },
    {
      accessorKey: "strategyId",
      header: "STRATEGY",
      cell: ({ row }) => (
        <span style={{ display: "inline-block" }}>
          <span style={{ fontWeight: 700, color: colors.accent }} title={row.original.strategyName ?? ""}>{row.original.strategyId}</span>
          {row.original.strategyName && (
            <span style={{ display: "block", fontSize: 9, fontWeight: 400, color: colors.textMuted, fontFamily: fonts.main }}>{row.original.strategyName}</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "mode",
      header: "MODE",
      cell: ({ row }) => <ModeTag mode={row.original.mode} strategyId={row.original.strategyId} />,
    },
    {
      id: "entry",
      header: "ENTRY (AVG FILL)",
      meta: { align: "right" },
      accessorFn: (r) => r.entryDetail?.avgPrice ?? r.entryAvg,
      cell: ({ row }) => (
        <span title={`entry avg fill presisi: ${row.original.entryDetail?.avgPrice ?? row.original.entryAvg}`}>
          {fmtPrice(row.original.entryDetail?.avgPrice ?? row.original.entryAvg)}
        </span>
      ),
    },
    {
      id: "exit",
      header: "EXIT (AVG FILL)",
      meta: { align: "right" },
      accessorFn: (r) => r.exitDetail?.avgPrice ?? r.exitAvg,
      cell: ({ row }) => (
        <span title={`exit avg fill presisi: ${row.original.exitDetail?.avgPrice ?? row.original.exitAvg}`}>
          {fmtPrice(row.original.exitDetail?.avgPrice ?? row.original.exitAvg)}
        </span>
      ),
    },
    {
      accessorKey: "pnlUsd",
      header: "PNL ($)",
      meta: { align: "right" },
      cell: ({ row }) => (
        <span style={{ fontWeight: 700, color: pnlColor(row.original.pnlUsd) }}>
          {row.original.pnlUsd >= 0 ? "+" : ""}${row.original.pnlUsd.toFixed(2)}
        </span>
      ),
    },
    {
      accessorKey: "rMultiple",
      header: "R-MULT",
      meta: { align: "right" },
      cell: ({ row }) => (
        <span style={{ color: pnlColor(row.original.rMultiple) }}>{row.original.rMultiple.toFixed(3)}R</span>
      ),
    },
    {
      accessorKey: "exitReason",
      header: "REASON",
      cell: ({ row }) => <OutcomeTag win={row.original.win} exitReason={row.original.exitReason} />,
    },
    {
      id: "detail",
      header: "DETAIL",
      meta: { align: "center" },
      cell: ({ row }) => {
        const expanded = expandedTradeId === row.original.id;
        return (
          <button
            className="workspace-ghost"
            onClick={(e) => { e.stopPropagation(); setExpandedTradeId(expanded ? null : row.original.id); }}
            title="Lihat rincian entry/exit/fill"
          >
            {expanded ? "▼" : "▶"} DETAIL
          </button>
        );
      },
    },
  ], [expandedTradeId]);

  // STRATEGY BREAKDOWN: kolom sama seperti tabel manual sebelumnya.
  const strategyColumns: ColumnDef<StrategyStat, any>[] = useMemo(() => [
    {
      id: "id",
      header: "STRATEGI",
      accessorFn: (r) => r.id,
      cell: ({ row }) => (
        <span style={{ color: ["RSW-01", "RSW-02", "RSW-03"].includes(row.original.id) ? colors.up : colors.text, fontWeight: 700 }}>
          {row.original.id}
        </span>
      ),
    },
    {
      id: "name",
      header: "NAMA",
      accessorFn: (r) => r.name,
      cell: ({ row }) => <span title={row.original.name}>{row.original.name}</span>,
    },
    { id: "trades", header: "TRADES", meta: { align: "right" }, accessorFn: (r) => r.trades, cell: ({ row }) => row.original.trades },
    {
      id: "winRate",
      header: "WIN RATE",
      meta: { align: "right" },
      accessorFn: (r) => r.winRate,
      cell: ({ row }) => (
        <span style={{ color: row.original.winRate >= 50 ? colors.up : colors.down }}>{row.original.winRate}%</span>
      ),
    },
    {
      id: "pnl",
      header: "PNL (USD)",
      meta: { align: "right" },
      accessorFn: (r) => r.pnl,
      cell: ({ row }) => (
        <span style={{ fontWeight: 700, color: pnlColor(row.original.pnl) }}>
          {row.original.pnl >= 0 ? "+" : ""}${row.original.pnl.toFixed(2)}
        </span>
      ),
    },
    {
      id: "mode",
      header: "MODE",
      accessorFn: (r) => {
        // 25 Okt 2026: TF per strategi. RSW-03 AlgoChief sinyal H1, RSW-01/02 H4.
        if (["S-01", "S-02"].includes(r.id)) return "SCALP 5M";
        if (["RSW-01", "RSW-02"].includes(r.id)) return "SWING 4H";
        if (r.id === "RSW-03") return "SWING 1H";
        return "SWING & SCALP";
      },
      cell: ({ row }) => {
        const active = ["RSW-01", "RSW-02", "RSW-03"].includes(row.original.id);
        const modeTag = ["S-01", "S-02"].includes(row.original.id) ? "SCALP 5M" : ["RSW-01", "RSW-02"].includes(row.original.id) ? "SWING 4H" : row.original.id === "RSW-03" ? "SWING 1H" : "SWING & SCALP";
        return <span className={active ? "context-pill paper" : "context-pill market"}>{modeTag}</span>;
      },
    },
  ], []);


  // Trade yang detailnya sedang dibuka (dirender di bawah tabel).
  const expandedTrade = useMemo(
    () => (expandedTradeId == null ? null : filteredTrades.find((t) => t.id === expandedTradeId) ?? null),
    [expandedTradeId, filteredTrades],
  );

  return (
    <div className="workspace-page">
      {/* ── CONTEXT BAR ─────────────────────────────────────────── */}
      <div className="workspace-context">
        <div className="workspace-context-left">
          <div>
            <div className="workspace-title">TRADING HISTORY &amp; STRATEGY ANALYTICS</div>
            <div className="workspace-sub">
              {modeTitle} · {modeSub} · pilihan tab tidak mengubah lane trading yang berjalan.
            </div>
          </div>
          <span className="context-pill market">AKUN LIVE · <i /></span>
          <span className="context-pill paper">ARSIP EKSEKUSI</span>
          <span className="context-pill locked">DATA LIVE</span>
        </div>
        <div className="workspace-context-right">
          <span className="mono tiny muted">SYNC {syncAge}</span>
          <button className="workspace-ghost" onClick={() => void fetchTrades()} disabled={loading}>REFRESH</button>
          <button
            className="workspace-ghost"
            onClick={handlePurgeNonStrategy}
            title="Hapus trade CLOSED beralasan KILL/LIQ_GAP/TIMEOUT/FUNDING agar history 100% outcome strategi (winrate & balance terkoreksi otomatis)"
          >
            BERSIHKAN NON-STRATEGI
          </button>
          <button className="workspace-ghost" onClick={exportCsv} title="Export baris yang sedang difilter ke CSV">EXPORT CSV</button>
        </div>
      </div>

      {/* ── TOOLBAR (mode + filter) ─────────────────────────────── */}
      <div className="workspace-toolbar">
        <div className="workspace-toolbar-left">
          <div className="layout-switch" role="group" aria-label="Gaya trade">
            {([
              ["ALL", "SEMUA"],
              ["SWING", "SWING"],
              ["SCALP", "SCALP 5M"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                className={modeFilter === id ? "active" : ""}
                onClick={() => { setModeFilter(id); setStrategyFilter("ALL"); }}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="inline-select">
            STRATEGI
            <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
              <option value="ALL">SEMUA</option>
              <option value="RSW-01">RSW-01: BOS D1 + PHEN Locked / Orion (SWING)</option>
              <option value="RSW-02">RSW-02: PHEN Profile + PHEN Locked / Vega (SWING)</option>
              <option value="RSW-03">RSW-03: AlgoChief Fade + Ridge / Draco (SWING)</option>
              <option value="S-02">S-02: Liquidity Sniper (SCALP · aktif)</option>
              <option value="S-01">S-01: Liquidity Sweep Reclaim (arsip · hard-gated)</option>
              <option value="S-99">S-99: Arsip / nonaktif (termasuk S-03 Fibonacci, S-04 MRV &amp; S-05 Polaris, retired 20 Okt 2026)</option>
            </select>
          </label>

          <label className="inline-select">
            OUTCOME
            <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)}>
              <option value="ALL">SEMUA</option>
              <option value="WIN">WIN</option>
              <option value="LOSS">LOSS</option>
              <option value="BEP">BE (LEGACY)</option>
            </select>
          </label>

          <label className="inline-select">
            PERIODE
            <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value as "ALL" | "PREVIOUS" | "CURRENT")}>
              <option value="ALL">SEMUA TANGGAL</option>
              <option value="PREVIOUS">KEMARIN · 07.00 WIB</option>
              <option value="CURRENT">SEKARANG · 07.00 WIB</option>
            </select>
          </label>

          <span className="workspace-muted">
            {filteredTrades.length} / {trades.length} BARIS
            {analytics && analytics.totalTrades > trades.length ? ` · TOTAL ${analytics.totalTrades} TRADE` : ""}
          </span>
        </div>
      </div>

      {/* ── KPI STRIP (dense, tabular) ─────────────────────────── */}
      <Panel
        bodyStyle={{ padding: 0 }}
        style={{ borderTop: `2px solid ${colors.accent}` }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))" }}>
          {[
            { label: `TOTAL TRADES (${modeTitle})`, value: String(totalTradesVal), sub: `${winCountVal}W / ${lossCountVal}L`, color: colors.textStrong },
            { label: "WIN RATE %", value: `${winRatePctVal}%`, sub: modeSub, color: winRatePctVal >= 50 ? colors.up : colors.down },
            { label: "NET PROFIT (USD)", value: `${netPnlUsdVal >= 0 ? "+" : ""}$${netPnlUsdVal.toFixed(2)}`, sub: analytics ? `Start $${analytics.startingEquityUsd}` : "·", color: pnlColor(netPnlUsdVal) },
            { label: "PROFIT FACTOR", value: `${profitFactorVal}x`, sub: "Gross W / Gross L", color: profitFactorVal < 1 ? colors.down : profitFactorVal >= 1.5 ? colors.up : colors.warn },
            { label: "AVERAGE R", value: `${avgRVal >= 0 ? "+" : ""}${avgRVal}R`, sub: "Per trade", color: pnlColor(avgRVal) },
          ].map((k) => (
            <div key={k.label} style={{ padding: "9px 12px", borderRight: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: 8.5, color: colors.textMuted, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>{k.label}</div>
              <div style={{ fontSize: 17, fontFamily: fonts.mono, color: k.color, fontWeight: 650, margin: "2px 0 1px", lineHeight: 1.2 }}>{k.value}</div>
              <div style={{ fontSize: 9.5, color: colors.textMuted, fontFamily: fonts.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={k.sub}>{k.sub}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* ── EQUITY CURVE ───────────────────────────────────────── */}
      <Panel
        title={`EQUITY GROWTH ($) // ${modeFilter === "SWING" ? "KHUSUS MODE SWING" : modeFilter === "SCALP" ? "KHUSUS MODE SCALPING 5M" : "SEMUA ERA (SCALP LAMA + SWING BARU)"}`}
        extra={<span className="workspace-muted">{equityCurve.length} TITIK DATA EKUITAS</span>}
      >
        <EquityCurve curve={equityCurve} />
      </Panel>

      {/* ── STRATEGY BREAKDOWN (baris data, bukan kartu) ───────── */}
      {analytics && strategyRows.length > 0 && (
        <Panel
          title={`STRATEGY PERFORMANCE BREAKDOWN // ${modeFilter === "SWING" ? "MODE SWING (ORION/VEGA/DRACO)" : modeFilter === "SCALP" ? "MODE SCALPING 5M (S-02)" : "SEMUA STRATEGI"}`}
          extra={<span className="workspace-muted">{strategyRows.length} STRATEGI</span>}
          bodyStyle={{ padding: 0 }}
        >
          <DataTable
            columns={strategyColumns}
            data={strategyRows}
            maxHeight={420}
            emptyText="Tidak ada strategi pada filter ini."
            onRowClick={(st) => {
              const active = ["RSW-01", "RSW-02", "RSW-03"].includes(st.id);
              setStrategyFilter(st.id);
              setModeFilter(active ? "SWING" : modeFilter);
            }}
          />
      {/* 30 Okt 2026 (B2): panel PAPER PAYOFF dan SNAPSHOT/RIWAYAT SESI PAPER
          dibuang · paper trading dimatikan, hanya LIVE yang tampil. State/kolom
          sesi paper ikut dihapus (dead code). dailySnapshot tetap dipakai
          filter jendela hari (07:00 WIB) untuk baris LIVE. */}

        </Panel>
      )}


      {/* ── TRADE LOG ──────────────────────────────────────────── */}
      <Panel
        title="TRADE LOG"
        extra={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="workspace-muted">
              {filteredTrades.length} / {trades.length} TRADE
              {analytics && analytics.totalTrades > trades.length ? ` · JENDELA ${trades.length} TERAKHIR · TOTAL ${analytics.totalTrades} TRADE` : ""}
            </span>
            <button className="workspace-ghost" onClick={() => scrollTableBy(tradeTableRef, -1)} title="Geser kolom tabel trade ke kiri">◀ KIRI</button>
            <button className="workspace-ghost" onClick={() => scrollTableBy(tradeTableRef, 1)} title="Geser kolom tabel trade ke kanan">KANAN ▶</button>
          </div>
        }
        bodyStyle={{ padding: 0 }}
      >
        <div style={{ padding: "8px 12px", color: colors.textMuted, fontSize: 9.5, fontFamily: fonts.mono, lineHeight: 1.6, borderBottom: `1px solid ${colors.border}` }}>
          Harga ENTRY/EXIT di kolom tabel = <b style={{ color: colors.text }}>rata-rata fill yang tercatat</b> (bukan estimasi). Klik baris atau <b style={{ color: colors.accent }}>▶ DETAIL</b> untuk melihat setiap fill (harga, qty, fee, waktu) beserta level SL/TP/TP2 &amp; POI zona. Badge <b style={{ color: colors.purple }}>ARSIP</b> = eksekusi simulasi internal (executor tanpa exchange client), <b style={{ color: colors.up }}>EXCHANGE</b> = order bursa nyata. Data <b>DEMO</b> pipeline uji dikecualikan otomatis{analytics?.dataProvenance?.demoExcludedCount ? ` (${analytics.dataProvenance.demoExcludedCount} baris disembunyikan)` : ""}.
        </div>

        <div ref={tradeTableRef}>
          <DataTable
            columns={tradeColumns}
            data={filteredTrades}
            virtual
            maxHeight={520}
            estimateRowHeight={49}
            emptyText={loading ? "MEMUAT RIWAYAT…" : "Tidak ada riwayat trade. Seluruh data dummy telah dibersihkan. Riwayat real trading akan tercatat otomatis saat AI membuka dan menutup posisi di pasar Binance Futures."}
            onRowClick={(t) => setExpandedTradeId(expandedTradeId === t.id ? null : t.id)}
          />
        </div>

        {expandedTrade && (
          <div style={{ padding: "10px 12px", borderTop: `1px solid ${colors.border}` }}>
            <TradeDetailPanel t={expandedTrade} />
          </div>
        )}
      </Panel>
    </div>
  );
}