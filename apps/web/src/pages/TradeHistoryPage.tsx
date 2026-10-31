// apps/web/src/pages/TradeHistoryPage.tsx
// Trading History & Strategy Analytics — design system "ArtaTrade Terminal"
// (gaya TradingView dark, 14 Okt 2026).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { historyUrl } from "../lib/modePresentation";
import { smoothLinePath, smoothAreaPath, smoothSeries } from "../lib/smoothPath";
import { colors, fonts, card, table, th, td, badge } from "../theme.js";
import { Panel, Badge, Btn, Select, StatCell } from "../components/ui.js";
import { apiFetch } from "../lib/api.js";

export interface TradeFill {
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

export interface TradeRecord {
  id: number;
  positionId: number;
  symbol: string;
  mode: string;
  side: string;
  strategyId: string;
  strategyName: string;
  /** Kunci kanonik era-aware (server) — untuk filter setelah renumber 6 Okt 2026. */
  strategyKey?: string;
  riskUsd: number;
  entryAvg: number;
  exitAvg: number;
  rMultiple: number;
  pnlUsd: number;
  feeUsd: number;
  win: boolean;
  exitReason: string;
  cumEquity: number;
  createdAt: string;
  // T-5.16: provenance + rincian harga entry/exit per fill
  source?: string;
  fillMode?: "PAPER" | "EXCHANGE";
  mfeR?: number;
  maeR?: number;
  holdMinutes?: number;
  fills?: TradeFill[];
  entryDetail?: {
    avgPrice: number | null;
    recordedPrice: number | null;
    qty: number | null;
    notional: number | null;
    leverage: number | null;
    marginUsd: number | null;
    openedAt: string | null;
    slPrice: number | null;
    tp1Price: number | null;
    tp2Price: number | null;
    slPct: number | null;
    entryType: string | null;
    zoneType: string | null;
    zoneTop: number | null;
    zoneBottom: number | null;
    feeUsd: number;
    fills: TradeFill[];
  };
  exitDetail?: {
    avgPrice: number | null;
    recordedAvg: number | null;
    lastFillPrice: number | null;
    reason: string;
    closedAt: string | null;
    holdMinutes: number;
    remainingQty: number | null;
    feeUsd: number;
    tp1: { price: number | null; filledAt: string | null; qty: number | null; feeUsd: number | null; realizedPnlUsd: number | null };
    beMoved: boolean;
    finalSlPrice: number | null;
    fills: TradeFill[];
  };
  fees?: { entryUsd: number; exitUsd: number; totalUsd: number; recordedUsd: number };
  risk?: { riskUsd: number; rMultiple: number; mfeR: number; maeR: number };
  /** Budget risiko NET ($) saat entry; null = legacy (R basis jarak harga saja). */
  riskBudgetUsd?: number | null;
  /** R ternormalisasi ke budget ($1) = pnlUsd / riskBudgetUsd (opsi b, 29 Sep 2026). */
  rMultipleBudget?: number | null;
}

export interface AnalyticsSummary {
  totalTrades: number;
  /** Jendela tampilan tabel (200 baris terakhir) — audit 6 Okt 2026. */
  visibleTrades?: number;
  winCount: number;
  lossCount: number;
  winRatePct: number;
  netPnlUsd: number;
  profitFactor: number;
  maxDrawdownUsd: number;
  startingEquityUsd: number;
  currentEquityUsd: number;
  avgR: number;
  paperPayoff?: {
    sampleCount: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    netPnlUsd: number;
    feeUsd: number;
    profitFactor: number | null;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    avgWinR: number | null;
    avgLossR: number | null;
    breakEvenWinRatePct: number | null;
    exitCounts: Record<string, number>;
    provenance: string;
  };
  // T-5.16: provenance data (DEMO dikecualikan dari history & equity)
  dataProvenance?: { includeDemo: boolean; demoExcludedCount: number; note: string };
  strategyStats: Array<{
    id: string;
    name: string;
    trades: number;
    wins: number;
    pnl: number;
    winRate: number;
  }>;
  byMode?: {
    SCALP: {
      totalTrades: number;
      winCount: number;
      lossCount: number;
      winRatePct: number;
      netPnlUsd: number;
      profitFactor: number;
      avgR: number;
    };
    SWING: {
      totalTrades: number;
      winCount: number;
      lossCount: number;
      winRatePct: number;
      netPnlUsd: number;
      profitFactor: number;
      avgR: number;
    };
  };
  mode?: string;
}

export interface EquityPoint {
  tradeId: number;
  time: string;
  equity: number;
  pnl: number;
}

export interface PaperDaySummary {
  labelWib: string;
  fromUtc: string;
  toUtc: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  avgR: number | null;
  byMode: { SCALP: { trades: number; netPnlUsd: number }; SWING?: { trades: number; netPnlUsd: number } };
}

export interface PaperDailySnapshot {
  timeZone: "Asia/Jakarta";
  boundaryLocalTime: string;
  cutoverAtUtc: string;
  previous: PaperDaySummary;
  current: PaperDaySummary;
  cutoverSnapshot: {
    closedTradeCountBeforeCutover: number | null;
    closedPaperNetPnlUsdBeforeCutover: number | null;
  };
}

/** Satu baris per sesi 07:00 WIB sejak periode PAPER $200 (dihitung server). */
export interface PaperDaySession {
  labelWib: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnlUsd: number;
  avgR: number | null;
  byMode: { SCALP: { trades: number; netPnlUsd: number }; SWING?: { trades: number; netPnlUsd: number } };
  cumEquityUsd: number;
}

/** Sesi PAPER berbatas 07:00 WIB (= 00:00 UTC). Karena cutover tepat di tengah malam UTC,
 *  tanggal UTC dari createdAt SUDAH menjadi label sesi WIB — mis. label "2026-09-28"
 *  mencakup 07:00 WIB 28 Sep sampai 07:00 WIB 29 Sep. Dipakai oleh tabel history dan CSV
 *  agar batas harinya identik dengan snapshot server. */
export function sessionLabelWib(createdAt: string | Date): string {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "-";
}

/** Rentang jam sesi dalam WIB untuk header grup tabel (mis. 28 Sep 07.00 -> 29 Sep 07.00 WIB). */
export function sessionRangeWib(labelWib: string): string {
  const start = new Date(`${labelWib}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return labelWib;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(start)} -> ${fmt(end)} WIB`;
}

/** Format harga full-presisi untuk kolom tabel (maks 8 desimal, bukan 3 bawaan toLocaleString).
 *  BUG yang dilaporkan operator: kolom ENTRY/EXIT tampil $0.002 / $0.009 (kepotong)
 *  padahal DB menyimpan 0.00210719 / 0.00925513. Penyebab: Number.toLocaleString()
 *  TANPA opsi = maksimum 3 desimal. Helper ini dipakai kolom tabel utama. */
function formatPriceColumn(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "-";
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
}

/** Scroll horizontal untuk tombol ◀ KIRI / KANAN ▶ pada tabel yang kolomnya
 *  tidak muat layar (permintaan operator 9 Okt 2026: "buat ada klik kolom kanan
 *  atau kiri biar bisa gw lihat keseluruhan"). Container harus punya overflowX:auto. */
function scrollTableBy(ref: React.RefObject<HTMLDivElement | null>, dir: number) {
  const el = ref.current;
  if (!el) return;
  el.scrollBy({ left: dir * Math.max(240, Math.round(el.clientWidth * 0.8)), behavior: "smooth" });
}

/** Tabel fill (harga eksekusi apa adanya) untuk panel detail trade. */
function TradeFillTable({ fills, title, color }: { fills: TradeFill[] | undefined; title: string; color: string }) {
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? "-" : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
  const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "-");
  return (
    <div style={{ flex: 1, minWidth: 300 }}>
      <div style={{ fontSize: 11, fontFamily: fonts.mono, color, fontWeight: 700, marginBottom: 4, letterSpacing: "0.4px" }}>{title}</div>
      {!fills || fills.length === 0 ? (
        <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>tidak ada fill tercatat</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: fonts.mono }}>
          <thead>
            <tr style={{ color: colors.textMuted }}>
              <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 600 }}>WAKTU</th>
              <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 600 }}>SISI/TIPE</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 600 }}>QTY</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 600 }}>HARGA FILL</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 600 }}>DIMINTA</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 600 }}>FEE</th>
              <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 600 }}>EKSEKUSI</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f, i) => (
              <tr key={`${f.clientOrderId}-${i}`} style={{ color: colors.text }}>
                <td style={{ padding: "2px 4px" }}>{when(f.filledAt ?? f.createdAt)}</td>
                <td style={{ padding: "2px 4px" }}>
                  {f.side} {f.type}
                  {f.reduceOnly ? " (reduce-only)" : ""}
                </td>
                <td style={{ padding: "2px 4px", textAlign: "right" }}>{f.qty}</td>
                <td style={{ padding: "2px 4px", textAlign: "right", color: colors.warn, fontWeight: 700 }}>
                  {fmt(f.fillPrice ?? f.requestPrice)}
                </td>
                <td style={{ padding: "2px 4px", textAlign: "right", color: colors.textMuted }}>{fmt(f.requestPrice)}</td>
                <td style={{ padding: "2px 4px", textAlign: "right" }}>${(f.feeUsd ?? 0).toFixed(4)}</td>
                <td style={{ padding: "2px 4px" }}>
                  <span style={badge(f.fillMode === "EXCHANGE" ? colors.upBg : colors.accentSoft, f.fillMode === "EXCHANGE" ? colors.up : colors.purple)}>
                    {f.fillMode}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Panel rincian harga ENTRY & EXIT per trade (T-5.16) — semua angka apa adanya dari fill. */
export function TradeDetailPanel({ t }: { t: TradeRecord }) {
  const fmt = (v: number | null | undefined, digits = 8) =>
    v === null || v === undefined ? "-" : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: digits })}`;
  const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "-");
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, fontFamily: fonts.mono, padding: "1px 0" }}>
      <span style={{ color: colors.textMuted }}>{label}</span>
      <span style={{ color: colors.textStrong, fontWeight: 700, textAlign: "right" }}>{value}</span>
    </div>
  );
  const e = t.entryDetail;
  const x = t.exitDetail;
  return (
    <div style={{ background: colors.bgInput, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 10, display: "flex", flexWrap: "wrap", gap: 14 }}>
      <div style={{ flex: 1, minWidth: 280 }}>
        <div style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.up, fontWeight: 700, marginBottom: 4, letterSpacing: "0.4px" }}>
          ENTRY DETAIL ({t.side} {t.mode})
        </div>
        {row("Harga entry (rata-rata fill)", fmt(e?.avgPrice ?? t.entryAvg))}
        {row("Harga entry tercatat di posisi", fmt(e?.recordedPrice))}
        {row("Qty awal", e?.qty ?? "-")}
        {row("Notional / leverage", `${fmt(e?.notional, 2)} / ${e?.leverage ?? "-"}x`)}
        {row("Margin", fmt(e?.marginUsd, 2))}
        {row("SL (jarak)", `${fmt(e?.slPrice)} (${e?.slPct ? (e.slPct * 100).toFixed(2) + "%" : "-"})`)}
        {(() => {
          const tp1 = e?.tp1Price ?? null;
          const tp2 = e?.tp2Price ?? null;
          // RR klasik (29 Sep 2026): satu target — tp2 == tp1. Trade lama (legacy)
          // bisa masih punya TP1 != TP2, biarkan tampil apa adanya dengan label legacy.
          const single = tp1 != null && tp2 != null && tp1 === tp2;
          return single
            ? row("TP (single target · RR klasik)", fmt(tp1))
            : row("TP (legacy split)", `${fmt(tp1)} / ${fmt(tp2)}`);
        })()}
        {row("Tipe entry · strategi", `${e?.entryType ?? "-"} · ${t.strategyId} ${t.strategyName}`)}
        {row("POI zona", e?.zoneType ? `${e.zoneType} ${e.zoneBottom ?? ""}-${e.zoneTop ?? ""}` : "tidak pakai zona")}
        {row("Waktu entry", when(e?.openedAt ?? t.createdAt))}
        {row("Fee entry", `$${(e?.feeUsd ?? 0).toFixed(4)}`)}
      </div>
      <div style={{ flex: 1, minWidth: 280 }}>
        <div style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.down, fontWeight: 700, marginBottom: 4, letterSpacing: "0.4px" }}>
          EXIT DETAIL ({t.pnlUsd >= 0 ? "PROFIT" : "LOSS"} · {t.exitReason})
        </div>
        {row("Harga exit (rata-rata fill)", fmt(x?.avgPrice ?? t.exitAvg))}
        {row("Fill exit terakhir", fmt(x?.lastFillPrice))}
        {row("Harga exit tercatat", fmt(x?.recordedAvg))}
        {row("Sisa qty saat exit", x?.remainingQty ?? "-")}
        {row("TP2/final", "RR23: 3R (50% sisa setelah TP1 2R)")}
        {row("Waktu exit", when(x?.closedAt))}
        {row("Hold", `${x?.holdMinutes ?? t.holdMinutes ?? "-"} menit`)}
        {row("TP fill (harga/qty)", `${fmt(x?.tp1?.price ?? null)} / ${x?.tp1?.qty ?? "-"}`)}
        {row("Realized TP (net)", `$${(x?.tp1?.realizedPnlUsd ?? 0).toFixed(4)}`)}
        {row("Fee exit / total fee", `$${(x?.feeUsd ?? 0).toFixed(4)} / $${(t.fees?.totalUsd ?? t.feeUsd).toFixed(4)}`)}
        {row("R / MFE / MAE", `${t.rMultiple.toFixed(2)}R / ${(t.risk?.mfeR ?? t.mfeR ?? 0).toFixed(2)}R / ${(t.risk?.maeR ?? t.maeR ?? 0).toFixed(2)}R`)}
        {row("Budget risiko (NET)",
          t.riskBudgetUsd != null
            ? `$${t.riskBudgetUsd.toFixed(4)} · R ternormalisasi ${t.rMultipleBudget != null ? `${t.rMultipleBudget >= 0 ? "+" : ""}${t.rMultipleBudget.toFixed(2)}R` : "-"}`
            : "legacy (tak tercatat)")}
        {row("Sumber data", `${t.source ?? "LIVE_AI"} · eksekusi ${t.fillMode ?? "PAPER"}`)}
      </div>
      <div style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 14, marginTop: 4 }}>
        <TradeFillTable fills={e?.fills ?? t.fills?.filter((f) => !f.reduceOnly)} title="FILL ENTRY (DARI BURSa/MESIN)" color={colors.up} />
        <TradeFillTable fills={x?.fills ?? t.fills?.filter((f) => f.reduceOnly)} title="FILL EXIT (TP tunggal / SL · BE hanya legacy)" color={colors.down} />
      </div>
    </div>
  );
}

export function TradeHistoryPage() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [dailySnapshot, setDailySnapshot] = useState<PaperDailySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [modeFilter, setModeFilter] = useState<string>("ALL");
  const [strategyFilter, setStrategyFilter] = useState<string>("ALL");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("ALL");
  const [periodFilter, setPeriodFilter] = useState<"ALL" | "PREVIOUS" | "CURRENT">("ALL");
  const [hoveredPoint, setHoveredPoint] = useState<EquityPoint | null>(null);
  // T-5.16: trade yang sedang dibuka panel detail entry/exit-nya.
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);
  // 9 Okt 2026: riwayat SEMUA sesi sejak periode PAPER $200 + ref scroll tabel.
  const [dailySessions, setDailySessions] = useState<PaperDaySession[]>([]);
  const sessionTableRef = useRef<HTMLDivElement | null>(null);
  const tradeTableRef = useRef<HTMLDivElement | null>(null);

  const requestedMode = useRef(modeFilter);
  requestedMode.current = modeFilter;
  const historyRequest = useRef(0);
  const fetchTrades = useCallback(async () => {
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
        setDailySessions(data.dailySessions || []);
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
    setHoveredPoint(null);
    setExpandedTradeId(null);
    fetchTrades();
    const timer = window.setInterval(fetchTrades, 60_000);
    return () => { window.clearInterval(timer); historyRequest.current++; };
  }, [fetchTrades]);

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

  const handleResetTrades = async () => {
    if (!window.confirm("Mulai periode PAPER baru dari $200? Posisi PAPER akan ditutup pada harga mark terkini. Riwayat lama disembunyikan dari dashboard tetapi tetap disimpan untuk jurnal pembelajaran.")) return;
    try {
      const res = await apiFetch("/api/trades/reset", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        fetchTrades();
        alert(`Periode PAPER baru dimulai. ${data.closedPositionsCount} posisi ditutup; ${data.archivedTrades} trade lama tetap tersimpan untuk pembelajaran.`);
      } else {
        alert(`Reset belum selesai: ${data.error || "server error"}${data.symbols?.length ? ` (${data.symbols.join(", ")})` : ""}`);
      }
    } catch (e) {
      console.error("Gagal reset trades", e);
    }
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
        fetchTrades();
      } else {
        alert(`Gagal membersihkan: ${data.error || "Server error"}`);
      }
    } catch (e) {
      console.error("Gagal purge non-strategi", e);
    }
  };

  const filteredTrades = trades.filter((t) => {
    if (periodFilter !== "ALL") {
      if (!dailySnapshot || !["PAPER_AI", "PAPER_MANUAL"].includes(t.source ?? "")) return false;
      const day = periodFilter === "CURRENT" ? dailySnapshot.current : dailySnapshot.previous;
      const closedAt = Date.parse(t.createdAt);
      if (!(closedAt >= Date.parse(day.fromUtc) && (periodFilter === "CURRENT" ? closedAt <= Date.parse(day.toUtc) : closedAt < Date.parse(day.toUtc)))) return false;
    }
    if (modeFilter !== "ALL" && t.mode !== modeFilter) return false;
    // Filter memakai kunci kanonik: trade era lama (eks S-03/S-04) ikut kelompok
    // strategi barunya (S-01/S-02) — konsisten dengan kartu statistik di atas.
    if (strategyFilter !== "ALL" && (t.strategyKey ?? t.strategyId) !== strategyFilter) return false;
    if (outcomeFilter === "WIN" && !t.win) return false;
    if (outcomeFilter === "LOSS" && t.win) return false;
    if (outcomeFilter === "BEP" && !t.exitReason.includes("BE")) return false;
    return true;
  });

  // SVG Equity Curve Calculation
  const renderEquityChart = () => {
    if (equityCurve.length < 2) {
      return (
        <div style={{ padding: "36px 16px", textAlign: "center", background: colors.bgInput, border: `1px dashed ${colors.borderLight}`, borderRadius: 6 }}>
          <div style={{ fontSize: 13, fontFamily: fonts.mono, color: colors.warn, fontWeight: 700, letterSpacing: "0.4px" }}>
            [STATUS: BERSIH / REAL-MARKET READY]
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4, fontFamily: fonts.mono }}>
            Riwayat periode lama disimpan untuk pembelajaran. Kurva periode PAPER baru terbentuk saat trade simulasi berikutnya selesai. Saldo awal: $200.00.
          </div>
        </div>
      );
    }

    const width = 880;
    const height = 180;
    const padding = 28;

    const equities = equityCurve.map((p) => p.equity);
    const minVal = Math.min(...equities) * 0.98;
    const maxVal = Math.max(...equities) * 1.02;
    const range = maxVal - minVal || 1;

    const getX = (idx: number) => padding + (idx / (equityCurve.length - 1)) * (width - padding * 2);
    const getY = (val: number) => height - padding - ((val - minVal) / range) * (height - padding * 2);

    // Line MULUS (perataan deret + kurva bezier) tanpa titik-titik bulat
    // (permintaan operator 9 Okt). Tooltip hover tetap memakai data asli.
    const smoothed = smoothSeries(equityCurve.map((p) => p.equity), Math.max(3, Math.round(equityCurve.length * 0.05)));
    const curve: Array<[number, number]> = smoothed.map((v, idx) => [getX(idx), getY(v)]);
    const linePath = smoothLinePath(curve, 0.3);
    const areaPath = smoothAreaPath(curve, height - padding, 0.3);
    // Warna kurva mengikuti arah equity (naik = ijo TV, turun = merah TV).
    const equityUp = (equities[equities.length - 1] ?? 0) >= (equities[0] ?? 0);
    const lineColor = equityUp ? colors.up : colors.down;

    return (
      <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 180, display: "block" }}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(35,42,56,0.7)" strokeDasharray="3 3" />
          <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="rgba(35,42,56,0.7)" strokeDasharray="3 3" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(35,42,56,0.7)" strokeDasharray="3 3" />

          {/* Area fill */}
          <path d={areaPath} fill="url(#eqGrad)" />

          {/* Curve line · mulus, tanpa titik bulat */}
          <path
            d={linePath}
            fill="none"
            stroke={lineColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Hover tak terlihat: tooltip tetap jalan tanpa titik bulat */}
          {equityCurve.map((p, idx) => (
            <circle
              key={idx}
              cx={getX(idx)}
              cy={getY(p.equity)}
              r={9}
              fill="transparent"
              onMouseEnter={() => setHoveredPoint(p)}
              onMouseLeave={() => setHoveredPoint(null)}
              style={{ cursor: "pointer" }}
            />
          ))}
        </svg>

        {hoveredPoint && (
          <div style={{
            position: "absolute", top: 10, right: 20, background: colors.bgPanel,
            border: `1px solid ${colors.borderLight}`,
            padding: "8px 14px", borderRadius: 6, fontSize: 13, fontFamily: fonts.mono, color: colors.textStrong,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
          }}>
            <div style={{ fontWeight: 700, color: colors.textMuted }}>Trade #{hoveredPoint.tradeId}</div>
            <div>Equity: <strong style={{ color: colors.textStrong }}>${hoveredPoint.equity.toFixed(2)}</strong></div>
            <div>PnL: <span style={{ fontWeight: 700, color: hoveredPoint.pnl >= 0 ? colors.up : colors.down }}>{hoveredPoint.pnl >= 0 ? "+" : ""}${hoveredPoint.pnl.toFixed(2)}</span></div>
          </div>
        )}
      </div>
    );
  };

  const pnlColor = (v: number) => (v > 0 ? colors.up : v < 0 ? colors.down : colors.textMuted);
  const kpiAccent = [colors.accent, colors.purple, colors.warn, colors.up, colors.down];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 1. Header Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 6px 0", fontSize: 18, color: colors.textStrong, fontWeight: 700 }}>
            TRADING HISTORY & STRATEGY ANALYTICS
          </h2>
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>
            Riwayat dan statistik dipisahkan menurut mode SCALP 5m dan SWING 1h. Pilihan tab tidak mengubah lane trading yang berjalan.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={handlePurgeNonStrategy}
            style={{ fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontFamily: fonts.main, background: colors.accentSoft, color: colors.purple, border: `1px solid transparent` }}
            title="Hapus trade CLOSED beralasan KILL/LIQ_GAP/TIMEOUT/FUNDING agar history 100% outcome strategi (winrate & balance terkoreksi otomatis)"
          >
            BERSIHKAN NON-STRATEGI
          </button>
          <Btn onClick={handleResetTrades} tone="danger" title="Reset periode PAPER ke $200">PERIODE PAPER BARU $200</Btn>
          <Btn onClick={exportCsv} tone="primary">EXPORT CSV</Btn>
        </div>
      </div>

      {/* 0. MODE SELECTION TABS (Pemisahan Gaya Trading: SEMUA, SWING, SCALPING) */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", background: colors.bgPanel, padding: "10px 14px", borderRadius: 8, border: `1px solid ${colors.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: fonts.mono, color: colors.textMuted, marginRight: 4, letterSpacing: "0.5px" }}>
          PILIH GAYA TRADE:
        </span>
        <button
          onClick={() => { setModeFilter("ALL"); setStrategyFilter("ALL"); }}
          style={{
            padding: "8px 18px",
            fontSize: 12.5,
            fontWeight: 700,
            fontFamily: fonts.mono,
            borderRadius: 6,
            cursor: "pointer",
            border: `1px solid ${modeFilter === "ALL" ? colors.accent : colors.border}`,
            background: modeFilter === "ALL" ? colors.accent : colors.bgInput,
            color: modeFilter === "ALL" ? "#ffffff" : colors.text,
            transition: "all 0.15s ease",
          }}
        >
          SEMUA RIWAYAT (ALL)
        </button>
        <button
          onClick={() => { setModeFilter("SWING"); setStrategyFilter("ALL"); }}
          style={{
            padding: "8px 18px",
            fontSize: 12.5,
            fontWeight: 700,
            fontFamily: fonts.mono,
            borderRadius: 6,
            cursor: "pointer",
            border: `1px solid ${modeFilter === "SWING" ? colors.up : colors.border}`,
            background: modeFilter === "SWING" ? colors.up : colors.bgInput,
            color: modeFilter === "SWING" ? "#000000" : colors.text,
            transition: "all 0.15s ease",
          }}
        >
          MODE SWING PAPER (POLARIS · ORION · VEGA · DRACO)
        </button>
        <button
          onClick={() => { setModeFilter("SCALP"); setStrategyFilter("ALL"); }}
          style={{
            padding: "8px 18px",
            fontSize: 12.5,
            fontWeight: 700,
            fontFamily: fonts.mono,
            borderRadius: 6,
            cursor: "pointer",
            border: `1px solid ${modeFilter === "SCALP" ? colors.warn : colors.border}`,
            background: modeFilter === "SCALP" ? colors.warn : colors.bgInput,
            color: modeFilter === "SCALP" ? "#000000" : colors.text,
            transition: "all 0.15s ease",
          }}
        >
          MODE SCALPING (5M · Sniper S-02)
        </button>
      </div>

      {dailySnapshot && (
        <Panel
          title="SNAPSHOT PAPER SEMUA MODE // BATAS HARI 07.00 WIB (ASIA/JAKARTA)"
          extra={<Badge bg={colors.warnBg} fg={colors.warn}>07:00 WIB</Badge>}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
            {([{ name: "KEMARIN", day: dailySnapshot.previous }, { name: "SEKARANG", day: dailySnapshot.current }] as const).map(({ name, day }) => (
              <div key={name} style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 10 }}>
                <div style={{ color: colors.textStrong, fontWeight: 700, fontSize: 12 }}>{name} · sesi <span style={{ fontFamily: fonts.mono }}>{day.labelWib}</span></div>
                <div style={{ fontSize: 12, marginTop: 4, fontFamily: fonts.mono, color: colors.text }}>{day.tradeCount} trade tertutup · <span style={{ color: colors.up }}>{day.wins}W</span>/<span style={{ color: colors.down }}>{day.losses}L</span> · WR {day.winRatePct?.toFixed(1) ?? "·"}%</div>
                <div style={{ color: day.netPnlUsd >= 0 ? colors.up : colors.down, fontWeight: 700, marginTop: 4, fontFamily: fonts.mono }}>Net {day.netPnlUsd >= 0 ? "+" : ""}${day.netPnlUsd.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, fontFamily: fonts.mono }}>
                  SWING {day.byMode.SWING?.trades ?? 0} (${(day.byMode.SWING?.netPnlUsd ?? 0).toFixed(2)}) · SCALP {day.byMode.SCALP.trades} (${day.byMode.SCALP.netPnlUsd.toFixed(2)})
                </div>
              </div>
            ))}
          </div>
          {dailySessions.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ color: colors.textMuted, fontSize: 11, fontWeight: 700, letterSpacing: "0.5px" }}>
                  RIWAYAT SEMUA SESI // {dailySessions.length} SESI SEJAK PERIODE PAPER $200
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn onClick={() => scrollTableBy(sessionTableRef, -1)} tone="ghost" title="Geser kolom tabel sesi ke kiri">◀ KIRI</Btn>
                  <Btn onClick={() => scrollTableBy(sessionTableRef, 1)} tone="ghost" title="Geser kolom tabel sesi ke kanan">KANAN ▶</Btn>
                </div>
              </div>
              <div ref={sessionTableRef} style={{ overflowX: "auto", marginTop: 6, border: `1px solid ${colors.border}`, borderRadius: 6 }}>
                <table style={{ ...table, minWidth: 780, fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: colors.bgInput }}>
                      <th style={th}>SESI (07.00 WIB)</th>
                      <th style={{ ...th, textAlign: "right" }}>TRADE</th>
                      <th style={{ ...th, textAlign: "right" }}>W/L</th>
                      <th style={{ ...th, textAlign: "right" }}>WR</th>
                      <th style={{ ...th, textAlign: "right" }}>NET ($)</th>
                      <th style={{ ...th, textAlign: "right" }}>AVG R</th>
                      <th style={{ ...th, textAlign: "right" }}>SWING</th>
                      <th style={{ ...th, textAlign: "right" }}>EQUITY AKHIR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailySessions.map((s) => (
                      <tr key={s.labelWib}>
                        <td style={{ ...td, color: colors.text }}>{s.labelWib}</td>
                        <td style={{ ...td, textAlign: "right", color: colors.text }}>{s.tradeCount}</td>
                        <td style={{ ...td, textAlign: "right", color: colors.text }}>
                          <span style={{ color: colors.up }}>{s.wins}</span>/<span style={{ color: colors.down }}>{s.losses}</span>
                        </td>
                        <td style={{ ...td, textAlign: "right", color: colors.text }}>{s.winRatePct?.toFixed(1) ?? "·"}%</td>
                        <td style={{ ...td, textAlign: "right", fontWeight: 700, color: s.netPnlUsd >= 0 ? colors.up : colors.down }}>{s.netPnlUsd >= 0 ? "+" : ""}${s.netPnlUsd.toFixed(2)}</td>
                        <td style={{ ...td, textAlign: "right", color: (s.avgR ?? 0) >= 0 ? colors.up : colors.down }}>{s.avgR != null ? `${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}R` : "·"}</td>
                        <td style={{ ...td, textAlign: "right", color: colors.textMuted }}>{s.byMode.SWING?.trades ?? 0} (${(s.byMode.SWING?.netPnlUsd ?? 0).toFixed(2)})</td>
                        <td style={{ ...td, textAlign: "right", fontWeight: 700, color: colors.textStrong }}>${s.cumEquityUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 6 }}>
                Equity akhir per sesi = modal awal $200.00 + kumulatif net PAPER tertutup sejak reset periode. Klik ◀ KIRI / KANAN ▶ bila kolom tidak muat di layar.
              </div>
            </div>
          )}
          <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 8 }}>
            Cutover {new Date(dailySnapshot.cutoverAtUtc).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" })} WIB ·
            {" "}PnL kumulatif trade PAPER tertutup sebelum cutover: {dailySnapshot.cutoverSnapshot.closedPaperNetPnlUsdBeforeCutover === null
              ? "·" : `$${dailySnapshot.cutoverSnapshot.closedPaperNetPnlUsdBeforeCutover.toFixed(2)}`}. Posisi terbuka dan TP yang belum menjadi trade tertutup tidak masuk snapshot ini.
          </div>
        </Panel>
      )}

      {/* PAPER payoff is separated from legacy rows and uses every closed trade. */}
      {analytics?.paperPayoff && analytics.paperPayoff.sampleCount > 0 && (
        <Panel
          title={`PAYOFF PAPER_AI // ${analytics.paperPayoff.sampleCount} TRADE TERTUTUP (SIMULASI)`}
          extra={<Badge bg={analytics.paperPayoff.netPnlUsd >= 0 ? colors.upBg : colors.downBg} fg={analytics.paperPayoff.netPnlUsd >= 0 ? colors.up : colors.down}>NET {analytics.paperPayoff.netPnlUsd >= 0 ? "+" : ""}${analytics.paperPayoff.netPnlUsd.toFixed(2)}</Badge>}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 22px", fontSize: 12.5, fontFamily: fonts.mono, color: colors.text }}>
            <span>Win rate: <strong style={{ color: (analytics.paperPayoff.winRatePct ?? 0) >= 50 ? colors.up : colors.down }}>{analytics.paperPayoff.winRatePct?.toFixed(1) ?? "·"}%</strong></span>
            <span>Impas pada payoff teramati: {analytics.paperPayoff.breakEvenWinRatePct?.toFixed(1) ?? "·"}%</span>
            <span>Rata-rata win: <span style={{ color: colors.up }}>${analytics.paperPayoff.avgWinUsd?.toFixed(2) ?? "·"} ({analytics.paperPayoff.avgWinR?.toFixed(2) ?? "·"}R)</span></span>
            <span>Rata-rata loss: <span style={{ color: colors.down }}>${analytics.paperPayoff.avgLossUsd?.toFixed(2) ?? "·"} ({analytics.paperPayoff.avgLossR?.toFixed(2) ?? "·"}R)</span></span>
            <span>SL {analytics.paperPayoff.exitCounts.SL ?? 0} · TP {analytics.paperPayoff.exitCounts.TP1_TP2 ?? analytics.paperPayoff.exitCounts.TP2 ?? 0} · legacy BE {analytics.paperPayoff.exitCounts.BE ?? 0}</span>
          </div>
          <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 7 }}>Titik impas dihitung dari rata-rata win/loss net pada sampel ini; bukan prediksi win rate berikutnya. Fee PAPER estimasi, funding belum terverifikasi. KPI di bawah memakai hingga 200 trade terbaru dari seluruh sumber.</div>
        </Panel>
      )}

      {/* 2. Executive KPI Cards (Reaktif terhadap Opsi Gaya Trade) */}
      {analytics && (() => {
        const modeKpi = modeFilter === "SWING" ? analytics.byMode?.SWING : modeFilter === "SCALP" ? analytics.byMode?.SCALP : null;
        const totalTradesVal = modeKpi ? modeKpi.totalTrades : analytics.totalTrades;
        const winCountVal = modeKpi ? modeKpi.winCount : analytics.winCount;
        const lossCountVal = modeKpi ? modeKpi.lossCount : analytics.lossCount;
        const winRatePctVal = modeKpi ? modeKpi.winRatePct : analytics.winRatePct;
        const netPnlUsdVal = modeKpi ? modeKpi.netPnlUsd : analytics.netPnlUsd;
        const profitFactorVal = modeKpi ? modeKpi.profitFactor : analytics.profitFactor;
        const avgRVal = modeKpi ? modeKpi.avgR : analytics.avgR;

        const modeTitle = modeFilter === "SWING" ? "SWING (4H / 1H)" : modeFilter === "SCALP" ? "SCALPING 5M" : "SEMUA ERA";
        const modeSub = modeFilter === "SWING" ? "Cohort SWING PAPER (Polaris, Orion, Vega, Draco)" : modeFilter === "SCALP" ? "Cohort SCALPING 5m (S-02 aktif; S-01 arsip)" : "Semua mode sejak reset periode";

        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <div style={{ ...card, padding: "12px 16px", borderTop: `2px solid ${kpiAccent[0]}` }}>
              <StatCell label={`TOTAL TRADES (${modeTitle})`} value={totalTradesVal} sub={<span style={{ fontFamily: fonts.mono }}><span style={{ color: colors.up }}>{winCountVal}W</span> / <span style={{ color: colors.down }}>{lossCountVal}L</span></span>} />
            </div>

            <div style={{ ...card, padding: "12px 16px", borderTop: `2px solid ${kpiAccent[1]}` }}>
              <StatCell label="WIN RATE %" value={`${winRatePctVal}%`} valueColor={winRatePctVal >= 50 ? colors.up : colors.down} sub={modeSub} />
            </div>

            <div style={{ ...card, padding: "12px 16px", borderTop: `2px solid ${kpiAccent[2]}` }}>
              <StatCell label="NET PROFIT (USD)" value={`${netPnlUsdVal >= 0 ? "+" : ""}$${netPnlUsdVal.toFixed(2)}`} valueColor={pnlColor(netPnlUsdVal)} sub={modeFilter === "ALL" ? `Start $${analytics.startingEquityUsd}` : `Net hasil ${modeTitle}`} />
            </div>

            <div style={{ ...card, padding: "12px 16px", borderTop: `2px solid ${kpiAccent[3]}` }}>
              <StatCell label="PROFIT FACTOR" value={`${profitFactorVal}x`} valueColor={profitFactorVal < 1 ? colors.down : profitFactorVal >= 1.5 ? colors.up : colors.warn} sub="Gross W / Gross L" />
            </div>

            <div style={{ ...card, padding: "12px 16px", borderTop: `2px solid ${kpiAccent[4]}` }}>
              <StatCell label="AVERAGE R" value={`${avgRVal >= 0 ? "+" : ""}${avgRVal}R`} valueColor={pnlColor(avgRVal)} sub="Per trade" />
            </div>
          </div>
        );
      })()}

      {/* 3. Equity Growth Curve Section */}
      <Panel
        title={`EQUITY GROWTH LINE CHART ($) // ${modeFilter === "SWING" ? "KHUSUS MODE SWING" : modeFilter === "SCALP" ? "KHUSUS MODE SCALPING 5M" : "SEMUA ERA (SCALP LAMA + SWING BARU)"}`}
        extra={<span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>{equityCurve.length} Titik Data Ekuitas</span>}
      >
        {renderEquityChart()}
      </Panel>

      {/* 4. Strategy Performance Breakdown (Dipisahkan sesuai Mode) */}
      {analytics && (
        <Panel title={`STRATEGY PERFORMANCE BREAKDOWN // ${modeFilter === "SWING" ? "MODE SWING (ORION/VEGA/DRACO)" : modeFilter === "SCALP" ? "MODE SCALPING 5M (S-02)" : "SEMUA STRATEGI"}`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            {analytics.strategyStats.filter((st) => {
              if (st.id === "S-00" || st.id === "S-99") return false;
              if (modeFilter === "SWING") return ["RSW-01", "RSW-02", "RSW-03"].includes(st.id);
              // 20 Okt 2026: S-03 Fibonacci & S-04 MRV dihapus dari katalog aktif.
              // ID-nya tetap punya arti historis -> trade era itu dipetakan ke bucket
              // arsip "S-99" (canonicalStrategyKey), bukan ke ID aktif.
              if (modeFilter === "SCALP") return ["S-01", "S-02"].includes(st.id);
              return true;
            }).map((st) => {
              const active = ["RSW-01", "RSW-02", "RSW-03"].includes(st.id);
              const modeTag = ["S-01", "S-02"].includes(st.id) ? "SCALP 5m" : ["RSW-01", "RSW-02", "RSW-03"].includes(st.id) ? "SWING 4h" : "SWING & SCALP";
              return (
                <div key={st.id} style={{ background: colors.bgInput, border: `1px solid ${active ? colors.up : colors.border}`, padding: "10px 14px", borderRadius: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: colors.textStrong, fontFamily: fonts.mono }}>{st.id}</span>
                    <span style={badge(active ? colors.upBg : "rgba(120,123,134,0.15)", active ? colors.up : colors.textMuted)}>
                      {modeTag}
                    </span>
                    <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>{st.trades} trades</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: colors.text, marginTop: 4 }}>{st.name}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12.5, fontFamily: fonts.mono }}>
                    <span>WR: <strong style={{ color: st.winRate >= 50 ? colors.up : colors.down }}>{st.winRate}%</strong></span>
                    <span style={{ fontWeight: 700, color: pnlColor(st.pnl) }}>{st.pnl >= 0 ? "+" : ""}${st.pnl.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
      {/* 5. Filter Controls & Trade Log Table */}
      <Panel
        title="TRADE LOG"
        extra={
          <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
            Showing {filteredTrades.length} of {trades.length} trades
            {analytics && analytics.totalTrades > trades.length
              ? ` (jendela tampilan ${trades.length} terakhir · total ${analytics.totalTrades} trade, statistik di atas dihitung dari SEMUA trade)`
              : ""}
          </span>
        }
      >
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.5px", color: colors.textMuted }}>FILTERS:</span>
            <Select value={periodFilter} onChange={(v) => setPeriodFilter(v as "ALL" | "PREVIOUS" | "CURRENT")}>
              <option value="ALL">Semua tanggal</option>
              <option value="PREVIOUS">Kemarin · 07.00 WIB</option>
              <option value="CURRENT">Sekarang · 07.00 WIB</option>
            </Select>
            <Select value={strategyFilter} onChange={setStrategyFilter}>
              <option value="ALL">Semua strategi pada mode terpilih</option>
              <option value="RSW-01">RSW-01: BOS D1 + PHEN Locked / Orion (SWING)</option>
              <option value="RSW-02">RSW-02: PHEN Profile + PHEN Locked / Vega (SWING)</option>
              <option value="RSW-03">RSW-03: AlgoChief Fade + Ridge / Draco (SWING)</option>
              <option value="S-02">S-02: Liquidity Sniper (SCALP - aktif)</option>
              <option value="S-01">S-01: Liquidity Sweep Reclaim (arsip - hard-gated)</option>
              <option value="S-99">S-99: Arsip / nonaktif (termasuk S-03 Fibonacci, S-04 MRV &amp; S-05 Polaris, retired 20 Okt 2026)</option>
            </Select>

            <Select value={modeFilter} onChange={setModeFilter}>
              <option value="ALL">All Modes</option>
              <option value="SWING">SWING 1h</option>
              <option value="SCALP">SCALP 5m</option>
            </Select>

            <Select value={outcomeFilter} onChange={setOutcomeFilter}>
              <option value="ALL">All Outcomes</option>
              <option value="WIN">Wins Only</option>
              <option value="LOSS">Losses Only</option>
              <option value="BEP">Break-Even legacy (pra 29 Sep 2026)</option>
            </Select>
          </div>
        </div>

        {/* Provenance & rincian fill (T-5.16) */}
        <div style={{ marginBottom: 10, fontSize: 11, fontFamily: fonts.mono, color: colors.textMuted, lineHeight: 1.6 }}>
          Harga ENTRY/EXIT di kolom tabel = <b style={{ color: colors.text }}>rata-rata fill yang tercatat</b> (bukan estimasi). Klik{" "}
          <b style={{ color: colors.accent }}>▶ DETAIL</b> untuk melihat setiap fill (harga, qty, fee, waktu) beserta level SL/TP/TP2 & POI zona.
          Badge <b style={{ color: colors.purple }}>PAPER</b> = eksekusi simulasi internal (executor tanpa exchange client),{" "}
          <b style={{ color: colors.up }}>EXCHANGE</b> = order bursa nyata. Data <b>DEMO</b> pipeline uji dikecualikan otomatis
          {analytics?.dataProvenance?.demoExcludedCount ? ` (${analytics.dataProvenance.demoExcludedCount} baris disembunyikan)` : ""}.
        </div>
        {/* Trade Table */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 6 }}>
          <Btn onClick={() => scrollTableBy(tradeTableRef, -1)} tone="ghost" title="Geser kolom tabel trade ke kiri">◀ KOL KIRI</Btn>
          <Btn onClick={() => scrollTableBy(tradeTableRef, 1)} tone="ghost" title="Geser kolom tabel trade ke kanan">KOL KANAN ▶</Btn>
        </div>
        <div ref={tradeTableRef} style={{ overflowX: "auto" }}>
          {/* minWidth: kolom tetap pada lebar alaminya lalu container scroll ·
              tanpa ini browser meremas 11 kolom sampai muat (kolom kepotong). */}
          <table style={{ ...table, minWidth: 1180 }}>
            <thead>
              <tr>
                <th style={th}>#ID</th>
                <th style={th}>TIME</th>
                <th style={th}>SYMBOL</th>
                <th style={th}>STRATEGY</th>
                <th style={th}>MODE</th>
                <th style={th}>ENTRY (avg fill)</th>
                <th style={th}>EXIT (avg fill)</th>
                <th style={th}>PNL ($)</th>
                <th style={th}>R-MULT</th>
                <th style={th}>REASON</th>
                <th style={{ ...th, textAlign: "center" }}>DETAIL</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrades.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ padding: "36px 12px", textAlign: "center", color: colors.textMuted, fontSize: 12.5 }}>
                    Tidak ada riwayat trade. Seluruh data dummy telah dibersihkan. Riwayat real trading akan tercatat otomatis saat AI membuka dan menutup posisi di pasar Binance Futures.
                  </td>
                </tr>
              ) : (
                filteredTrades.map((t, idx) => {
                  const label = sessionLabelWib(t.createdAt);
                  const prevLabel = idx > 0 ? sessionLabelWib(filteredTrades[idx - 1]!.createdAt) : null;
                  return (
                  <React.Fragment key={t.id}>
                    {label !== prevLabel && (
                      <tr>
                        <td colSpan={11} style={{ padding: "8px 12px", fontSize: 11, fontFamily: fonts.mono, fontWeight: 700, color: colors.warn, letterSpacing: "0.5px", background: colors.warnBg, borderTop: `1px solid ${colors.border}`, borderBottom: `1px solid ${colors.border}` }}>
                          SESI PAPER {label} · {sessionRangeWib(label)}
                        </td>
                      </tr>
                    )}
                    <tr style={{ background: expandedTradeId === t.id ? colors.bgPanelHover : "transparent" }}>
                      <td style={{ ...td, color: colors.textMuted }}>#{t.id}</td>
                      <td style={td}>{new Date(t.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" })} WIB</td>
                      <td style={{ ...td, fontWeight: 700, color: colors.textStrong }}>{t.symbol}</td>
                      <td style={td}>
                        <span style={{ fontWeight: 700, color: colors.accent }} title={t.strategyName ?? ""}>{t.strategyId}</span>
                        {t.strategyName && (
                          <span style={{ display: "block", fontSize: 10, fontWeight: 400, color: colors.textMuted, fontFamily: fonts.main }}>
                            {t.strategyName}
                          </span>
                        )}
                      </td>
                      <td style={td}>
                        <span style={badge(t.mode === "SWING" ? colors.upBg : colors.warnBg, t.mode === "SWING" ? colors.up : colors.warn)}>
                          {t.mode === "SWING" ? "SWING 1h" : t.mode === "SCALP" ? "SCALP 5m" : t.mode}
                        </span>
                      </td>
                      <td style={{ ...td, color: colors.text }} title={`entry avg fill presisi: ${t.entryDetail?.avgPrice ?? t.entryAvg}`}>
                        {formatPriceColumn(t.entryDetail?.avgPrice ?? t.entryAvg)}
                      </td>
                      <td style={{ ...td, color: colors.text }} title={`exit avg fill presisi: ${t.exitDetail?.avgPrice ?? t.exitAvg}`}>
                        {formatPriceColumn(t.exitDetail?.avgPrice ?? t.exitAvg)}
                      </td>
                      <td style={{ ...td, fontWeight: 700, color: pnlColor(t.pnlUsd) }}>
                        {t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)}
                      </td>
                      <td style={{ ...td, fontWeight: 700, color: (t.rMultipleBudget ?? t.rMultiple) >= 0 ? colors.up : colors.down }}>
                        {t.rMultipleBudget != null ? (
                          <>
                            {t.rMultipleBudget >= 0 ? "+" : ""}{t.rMultipleBudget.toFixed(2)}R
                            <div style={{ fontSize: 10, fontWeight: 400, color: colors.textMuted }}>
                              basis jarak {t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R
                            </div>
                          </>
                        ) : (
                          <>{t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R</>
                        )}
                      </td>
                      <td style={td}>
                        <span style={badge(
                          t.exitReason.includes("TP") ? colors.upBg : t.exitReason.includes("BE") ? colors.warnBg : colors.downBg,
                          t.exitReason.includes("TP") ? colors.up : t.exitReason.includes("BE") ? colors.warn : colors.down
                        )}>
                          {t.exitReason}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                        <button
                          onClick={() => setExpandedTradeId(expandedTradeId === t.id ? null : t.id)}
                          title="Lihat detail harga entry & exit (setiap fill)"
                          style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", cursor: "pointer", borderRadius: 6, fontFamily: fonts.main, background: colors.accentSoft, color: colors.accent, border: "1px solid transparent" }}
                        >
                          {expandedTradeId === t.id ? "▼ DETAIL" : "▶ DETAIL"}
                        </button>
                      </td>
                    </tr>
                    {expandedTradeId === t.id && (
                      <tr>
                        <td colSpan={11} style={{ padding: "10px 12px 16px" }}>
                          <TradeDetailPanel t={t} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
