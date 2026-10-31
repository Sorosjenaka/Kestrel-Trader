// apps/web/src/pages/LiveLiveOnlyPage.tsx — Dashboard LIVE (27 Okt 2026).
//
// 27 Okt 2026 sore (koreksi operator): tab LIVE harus LIVE-ONLY. Semula
// halaman ini menampilkan lane LIVE + lane PAPER + forward-paper dalam satu
// tab, sehingga operator melihat campur dan mengira "masih ada paper".
// Sekarang: tab LIVE = exposure riil di exchange saja. Simulasi ada di tab
// PAPER terpisah (PaperDashboardPage.tsx).
//
// Auto-refresh interval bisa diubah (5s/10s/30s/OFF) dan alert muncul untuk
// kejadian live BARU sejak tick sebelumnya.
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { Panel, PageHead, Btn, Badge } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import {
  type LaneReport, type LaneStats, type ForwardWorkerRow, type LiveActivityRow,
  usd, num, pct, pnlColor, hhmm, age, StatCard, LaneHeader, LaneTable, LaneTrades,
  ExchangeOnlyPanel,
} from "./liveShared.js";
import { LivePositionChart, type ChartPos } from "./LivePositionChart.js";
import { EquityCurve } from "../components/EquityCurve.js";
import { LiveMeshPanel } from "./LiveMeshPanel.js";
import { LiveOpsHeader, type OpsTab } from "../components/LiveOpsHeader.js";
import { ControlRoomSection } from "../components/ControlRoomSection.js";

interface MirrorPositionRow {
  symbol: string;
  db: {
    id: number; side: string; qty: number; entryPrice: number;
    slPrice: number; tp1Price: number; source: string;
  } | null;
  exchange: {
    positionAmt: number; entryPrice: number | null; markPrice: number | null;
    leverage: string | null; marginType: string | null;
  } | null;
  status: "COCOK" | "BEDA_QTY" | "BEDA_SISI" | "HANYA_DB" | "HANYA_EXCHANGE" | "TIDAK_DIBANDINGKAN";
  note: string;
}

interface LiveDashboardReport {
  generatedAt: string;
  executionMode: "PAPER" | "LIVE";
  armed: boolean;
  canTrade: boolean;
  guardReasons: string[];
  exchangeBalanceUsd: number | null;
  exchangeAvailableUsd: number | null;
  exchangeStatus: "OK" | "UNAVAILABLE";
  exchangeError?: string;
  entryActivity: {
    activePrefix: "PAPER" | "LIVE";
    activeDbLane: "live" | "paper";
    paperDbLaneFrozen: boolean;
    note: string;
  };
  live: LaneStats;
  paper: LaneStats;
  forwardPaper: {
    status: "OK" | "UNAVAILABLE";
    error?: string;
    workers: ForwardWorkerRow[];
  };
  activity: {
    status: "OK" | "UNAVAILABLE";
    error?: string;
    orders: LiveActivityRow[];
    positions: LiveActivityRow[];
    events: LiveActivityRow[];
    summary: {
      liveOrdersTotal: number;
      liveOrdersFilled: number;
      liveOrdersCanceled: number;
      liveOrdersOpen: number;
      liveOrdersRejected: number;
      livePositionsTotal: number;
      livePositionsOpen: number;
      lastLiveOrderAt: string | null;
      lastFilledOrder: {
        id: number; symbol: string; side: string | null;
        type: string | null; qty: number | null; price: number | null; at: string;
      } | null;
    };
  };
  mirror?: {
    generatedAt: string;
    exchange: {
      status: "OK" | "UNAVAILABLE";
      error?: string;
      walletBalance: number | null;
      availableBalance: number | null;
      positions: unknown[];
      openOrders: unknown[];
      openAlgoOrders: unknown[];
    };
    positions: MirrorPositionRow[];
  };
}

/** Panel mirror DB-vs-exchange · posisi DB yang tidak sama dengan exchange. */
function MirrorPanel({ mirror }: { mirror?: LiveDashboardReport["mirror"] }) {
  const cols = useMemo<ColumnDef<MirrorPositionRow, any>[]>(() => [
    { accessorKey: "symbol", header: "SYMBOL", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span> },
    {
      id: "status", header: "STATUS",
      cell: (i) => {
        const s = i.row.original.status;
        return <span style={{ color: isProblemStatus(s) ? colors.down : s === "COCOK" ? colors.up : colors.textMuted, fontWeight: 600 }}>{s}</span>;
      },
    },
    { id: "qtyDb", header: "QTY DB", meta: { align: "right" }, cell: (i) => i.row.original.db ? num(i.row.original.db.qty, 4) : "·" },
    { id: "qtyEx", header: "QTY EXCHANGE", meta: { align: "right" }, cell: (i) => i.row.original.exchange ? num(i.row.original.exchange.positionAmt, 4) : "·" },
    { id: "entryDb", header: "ENTRY DB", meta: { align: "right" }, cell: (i) => i.row.original.db ? num(i.row.original.db.entryPrice, 6) : "·" },
    { id: "entryEx", header: "ENTRY EXCHANGE", meta: { align: "right" }, cell: (i) => i.row.original.exchange ? num(i.row.original.exchange.entryPrice, 6) : "·" },
    { accessorKey: "note", header: "CATATAN", cell: (i) => (i.getValue() as string) || "·" },
  ], []);
  if (!mirror) return null;
  const rows = mirror.positions ?? [];
  // COCOK = identik; TIDAK_DIBANDINGKAN = posisi PAPER simulasi (memang tidak
  // ada di exchange, jadi bukan selisih). Keduanya BUKAN masalah.
  const bad = rows.filter((r) => isProblemStatus(r.status));
  // LIVE-only: baris PAPER (TIDAK_DIBANDINGKAN) tidak ditampilkan di tab LIVE.
  // 30 Okt 2026 (B2): paper trading dimatikan — tidak ada lagi catatan paper;
  // yang tampil = yang benar-benar dibandingkan (COCOK) dan yang bermasalah.
  const compared = rows.filter((r) => r.status !== "TIDAK_DIBANDINGKAN");
  return (
    <Panel
      title="MIRROR DB ↔ EXCHANGE · selisih posisi riil vs catatan lokal"
      extra={
        <Badge bg={bad.length === 0 ? colors.upBg : colors.downBg} fg={bad.length === 0 ? colors.up : colors.down}>
          {bad.length === 0 ? "COCOK" : `${bad.length} SELISIH`}
        </Badge>
      }
      bodyStyle={{ padding: 0 }}
    >
      <DataTable columns={cols} data={compared} maxHeight={340} emptyText="Tidak ada posisi pada sisi live untuk dibandingkan." />
    </Panel>
  );
}

/** COCOK = identik; TIDAK_DIBANDINGKAN = PAPER simulasi. Keduanya bukan masalah. */
function isProblemStatus(s: MirrorPositionRow["status"]): boolean {
  return s === "BEDA_QTY" || s === "BEDA_SISI" || s === "HANYA_DB" || s === "HANYA_EXCHANGE";
}

/**
 * Alert: event LANGSUNG yang perlu perhatian operator.
 * Hanya event yang BENAR-BENAR baru (dibanding tick sebelumnya) yang
 * ditampilkan, supaya banner tidak spam ulang event lama setiap poll.
 */
export interface LiveAlert {
  id: string;
  severity: "info" | "warn" | "error";
  title: string;
  detail: string;
  at: string;
}

function AlertBanner({ alerts, onDismiss }: { alerts: LiveAlert[]; onDismiss: (id: string) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {alerts.map((a) => {
        const tone = a.severity === "error" ? colors.down : a.severity === "warn" ? colors.warn : colors.accent;
        const bg = a.severity === "error" ? colors.downBg : a.severity === "warn" ? colors.warnBg : colors.accentSoft;
        return (
          <div
            key={a.id}
            role="alert"
            style={{
              background: bg, border: `1px solid ${tone}`, borderRadius: 6,
              padding: "9px 12px", color: tone, fontSize: 11.5,
              display: "flex", alignItems: "center", gap: 10, lineHeight: 1.5,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{a.title}</strong>
              {a.detail && <span style={{ marginLeft: 8, color: colors.text }}>{a.detail}</span>}
              <span style={{ marginLeft: 8, color: colors.textMuted, fontFamily: fonts.mono }}>
                {age(a.at)} lalu
              </span>
            </div>
            <button
              onClick={() => onDismiss(a.id)}
              title="Tutup alert"
              style={{
                background: "transparent", border: `1px solid ${tone}`, color: tone,
                borderRadius: 3, cursor: "pointer", fontSize: 10, padding: "3px 7px",
                fontFamily: fonts.mono, flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Panel aktivitas live: order executed, posisi live, event guard. */
function ActivityPanel({ activity }: { activity: LiveDashboardReport["activity"] }) {
  const s = activity.summary;
  const rows = useMemo(() =>
    [...activity.orders, ...activity.positions, ...activity.events]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 30),
    [activity.orders, activity.positions, activity.events]);
  const cols = useMemo<ColumnDef<LiveActivityRow, any>[]>(() => [
    { accessorKey: "at", header: "WAKTU", cell: (i) => hhmm(i.getValue() as string) },
    {
      accessorKey: "kind", header: "KIND",
      cell: (i) => {
        const k = i.getValue() as LiveActivityRow["kind"];
        return (
          <Badge bg={k === "ORDER" ? colors.accentSoft : k === "POSITION" ? colors.upBg : colors.warnBg}
            fg={k === "ORDER" ? colors.accent : k === "POSITION" ? colors.up : colors.warn}>
            {k}
          </Badge>
        );
      },
    },
    { accessorKey: "symbol", header: "SYMBOL", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span> },
    {
      accessorKey: "side", header: "SIDE",
      cell: (i) => {
        const v = i.getValue() as string | null;
        return <span style={{ color: v === "LONG" ? colors.up : v === "SHORT" ? colors.down : colors.textMuted }}>{v ?? "·"}</span>;
      },
    },
    { accessorKey: "type", header: "TYPE", cell: (i) => (i.getValue() as string | null) ?? "·" },
    {
      accessorKey: "status", header: "STATUS",
      cell: (i) => {
        const v = i.getValue() as string;
        return <span style={{ fontWeight: 600, color: v === "FILLED" ? colors.up : v === "CANCELED" || v === "REJECTED" ? colors.down : v === "OPEN" ? colors.warn : colors.text }}>{v}</span>;
      },
    },
    { accessorKey: "qty", header: "QTY", meta: { align: "right" }, cell: (i) => (i.getValue() as number | null) == null ? "·" : num(i.getValue() as number, 4) },
    { accessorKey: "price", header: "PRICE", meta: { align: "right" }, cell: (i) => (i.getValue() as number | null) == null ? "·" : num(i.getValue() as number, 6) },
    { accessorKey: "detail", header: "DETAIL", cell: (i) => (i.getValue() as string | null) ?? "·" },
  ], []);
  return (
    <Panel
      title="AKTIVITAS LIVE · order executed di exchange, posisi LIVE, event guard"
      extra={
        <Badge bg={activity.status === "OK" ? colors.upBg : colors.downBg} fg={activity.status === "OK" ? colors.up : colors.down}>
          {activity.status}
        </Badge>
      }
      bodyStyle={{ padding: 0 }}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderBottom: `1px solid ${colors.border}` }}>
        <StatCard label="ORDER MASUK" value={s.liveOrdersFilled} sub={`FILLED dari ${s.liveOrdersTotal} dikirim • ${s.liveOrdersOpen} open • ${s.liveOrdersCanceled} canceled`} />
        <StatCard label="POSISI LIVE" value={s.livePositionsOpen} sub={`dari ${s.livePositionsTotal} total`} />
        <StatCard
          label="ORDER TERAKHIR MASUK"
          value={s.lastFilledOrder ? age(s.lastFilledOrder.at) : "·"}
          sub={
            s.lastFilledOrder
              ? `${s.lastFilledOrder.side ?? ""} ${s.lastFilledOrder.symbol} ${num(s.lastFilledOrder.qty, 4)} @ ${num(s.lastFilledOrder.price, 6)}`
              : "belum ada order yang masuk"
          }
        />
      </div>
      <DataTable
        columns={cols}
        data={rows}
        maxHeight={420}
        emptyText="Belum ada aktivitas live tercatat."
      />
    </Panel>
  );
}

/** Interval poll (ms). Server cache TTL 20 dtk -> poll lebih cepat dari itu
 *  tidak menambah data baru, hanya menambah beban. */
const REFRESH_OPTIONS: Array<{ label: string; ms: number | null }> = [
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
  { label: "30s", ms: 30000 },
  { label: "OFF", ms: null },
];

export function LiveLiveOnlyPage() {
  const [opsTab, setOpsTab] = useState<OpsTab>("live");
  const [report, setReport] = useState<LiveDashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  /** Interval poll aktif; null = manual (OFF). */
  const [intervalMs, setIntervalMs] = useState<number | null>(10000);
  /** Alert yang belum di-dismiss operator. */
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  /**
   * Id event yang SUDAH pernah dib alerting. Ref ini preventing re-alert
   * event lama di setiap poll (banner akan spam kalau tidak).
   */
  const seenIdsRef = useRef<Set<string>>(new Set());
  /** Order live terakhir yang sudah di-alert (untuk deteksi order baru). */
  const lastOrderIdRef = useRef<number | null>(null);
  /** Tick pertama: jangan alert event yang sudah ada sebelum halaman dibuka. */
  const firstTickRef = useRef(true);

  const fetchReport = async () => {
    try {
      const res = await fetch("/api/live/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LiveDashboardReport;
      setReport(data);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString("id-ID"));
      detectAlerts(data);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Turunkan alert dari delta antar tick:
   *  - order LIVE baru (id lebih besar dari yang terakhir dilihat)
   *  - event severity warn/error baru
   *  - posisi LIVE baru
   * Event lama tidak pernah di-alert ulang.
   */
  const detectAlerts = (data: LiveDashboardReport) => {
    const fresh: LiveAlert[] = [];
    const isFirst = firstTickRef.current;
    firstTickRef.current = false;

    // 1) Order live baru
    for (const o of data.activity.orders) {
      const key = `order-${o.id}-${o.status}`;
      if (seenIdsRef.current.has(key)) continue;
      seenIdsRef.current.add(key);
      if (isFirst) continue; // tick pertama = baseline, bukan kejadian baru
      const filled = o.status === "FILLED";
      fresh.push({
        id: key,
        severity: filled ? "info" : o.status === "CANCELED" || o.status === "REJECTED" ? "warn" : "info",
        title: filled
          ? `ORDER LIVE FILLED · ${o.symbol} ${o.side ?? ""}`
          : `ORDER LIVE ${o.status} · ${o.symbol} ${o.side ?? ""}`,
        detail: `${o.type ?? ""} qty ${o.qty ?? "·"} @ ${o.price ?? "·"}`,
        at: o.at,
      });
    }
    lastOrderIdRef.current = data.activity.orders[0]?.id ?? lastOrderIdRef.current;

    // 2) Posisi live baru (dibuka)
    for (const p of data.activity.positions) {
      const key = `pos-${p.id}-${p.status}`;
      if (seenIdsRef.current.has(key)) continue;
      seenIdsRef.current.add(key);
      if (isFirst) continue;
      fresh.push({
        id: key,
        severity: p.status === "OPEN" ? "info" : "warn",
        title: `POSISI LIVE ${p.status} · ${p.symbol} ${p.side ?? ""}`,
        detail: `qty ${p.qty ?? "·"} @ ${p.price ?? "·"}${p.detail ? ` • ${p.detail}` : ""}`,
        at: p.at,
      });
    }

    // 3) Event guard/berbahaya baru
    for (const e of data.activity.events) {
      // COUNCIL_DECISION bukan alert: veto council adalah operasi normal
      // (dan bisa sangat sering) — pantauannya di mesh log + tabel aktivitas.
      if (e.type === "COUNCIL_DECISION") continue;
      const key = `event-${e.id}`;
      if (seenIdsRef.current.has(key)) continue;
      seenIdsRef.current.add(key);
      if (isFirst) continue;
      fresh.push({
        id: key,
        severity: e.status === "error" || e.status === "critical" ? "error" : "warn",
        title: `EVENT ${e.type}`,
        detail: `${e.symbol}${e.detail ? ` • ${e.detail}` : ""}`,
        at: e.at,
      });
    }

    if (fresh.length > 0) {
      setAlerts((prev) => [...fresh, ...prev].slice(0, 20));
    }
  };

  // Auto-refresh: interval bisa diubah/ dimatikan. Poll berhenti saat tab
  // tidak terlihat (hemat CPU di VPS) dan langsungPulih saat diklik lagi.
  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) fetchReport(); };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        poll();
        if (intervalMs !== null) id = setInterval(poll, intervalMs);
      } else if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    let id: ReturnType<typeof setInterval> | null = null;
    if (document.visibilityState === "visible") {
      poll();
      if (intervalMs !== null) id = setInterval(poll, intervalMs);
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // intervalMs sengaja jadi dependency: mengubah interval memulai timer baru.
  }, [intervalMs]);

  const live = report?.live;
  // Simbol terpilih dari klik baris tabel posisi → sinkron ke chart posisi.
  const [focusSymbol, setFocusSymbol] = useState<string | null>(null);
  const selectChartSymbol = (symbol: string) => setFocusSymbol(symbol);
  /**
   * Tombol LACAK TRADE (read-only): buka trace di Control Room. Tidak ada
   * request/mutasi apa pun; simbol dititipkan lewat sessionStorage lalu rute
   * Control Room yang membacanya untuk menampilkan timeline trade.
   */
  const lacakTrade = (symbol: string) => {
    try { sessionStorage.setItem("artatrade.lacak", symbol); } catch { /* storage disabled */ }
    // Control Room sudah digabung ke Live: pindah tab, bukan pindah rute.
    setOpsTab("lacak");
  };
  // Chart menerima dua sumber: baris DB (lane LIVE) + posisi exchange-only
  // (ada di exchange, belum ada baris DB — level SL/TP dari algo order).
  const chartPositions: ChartPos[] = [
    ...(live?.positions ?? []).map((pt) => ({
      key: `db-${pt.id}`, symbol: pt.symbol, side: pt.side, qty: pt.qty,
      entryPrice: pt.entryPrice, slPrice: pt.slPrice, tp1Price: pt.tp1Price, tp2Price: pt.tp2Price,
      marginUsd: pt.marginUsd, leverage: pt.leverage, unrealizedPnlUsd: pt.unrealizedPnlUsd,
      strategyId: pt.strategyId, source: pt.source, openedAt: pt.openedAt,
    })),
    ...(live?.exchangeOnlyPositions ?? []).map((x) => ({
      key: `xo-${x.symbol}`, symbol: x.symbol, side: x.side, qty: x.qty,
      entryPrice: x.entryPrice, slPrice: x.slPrice, tp1Price: x.tpPrices[0] ?? null,
      tp2Price: x.tpPrices[1] ?? null, marginUsd: null,
      leverage: x.leverage ? Number(x.leverage) : null, unrealizedPnlUsd: null,
      strategyId: null, source: "EXCHANGE_ONLY", openedAt: null,
    })),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        title="Live Dashboard"
        desc="Hanya exposure NYATA di exchange Binance: saldo, posisi live, order executed, chart posisi, dan selisih DB vs exchange. Simulasi dimatikan. READ-ONLY."
        right={
          <>
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono, letterSpacing: "0.08em" }}>REFRESH</span>
              {REFRESH_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  onClick={() => setIntervalMs(o.ms)}
                  title={o.ms === null ? "Matikan auto-refresh (manual saja)" : `Auto-refresh tiap ${o.label}`}
                  style={{
                    appearance: "none", cursor: "pointer",
                    background: intervalMs === o.ms ? colors.accent : "transparent",
                    color: intervalMs === o.ms ? "#07110d" : colors.textMuted,
                    border: `1px solid ${intervalMs === o.ms ? colors.accent : colors.border}`,
                    borderRadius: 3, fontSize: 10, fontWeight: 700, padding: "4px 7px",
                    fontFamily: fonts.mono,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <Btn onClick={fetchReport}>REFRESH SEKARANG</Btn>
          </>
        }
      />

      {/* 30 Okt 2026 (poin 3): header OPS + tab NETWORK/GRID/LACAK — Control
          Room digabung ke Live, bukan halaman/rute terpisah. */}
      <LiveOpsHeader tab={opsTab} onTab={setOpsTab} />

      {opsTab === "live" && (<>
      {/* ALERT · kejadian live baru sejak tick sebelumnya */}
      <AlertBanner
        alerts={alerts}
        onDismiss={(id) => setAlerts((prev) => prev.filter((a) => a.id !== id))}
      />
      {alerts.length > 0 && (
        <div style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono }}>
          {alerts.length} alert belum ditutup · klik ✕ untuk menutup satu per satu.
        </div>
      )}

      {/* MESH MISSION-CONTROL · status nyata semua proses + agen LLM/Drex */}
      <LiveMeshPanel />

      {/* STATUS UMUM */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatCard
          label="MODE EKSEKUSI"
          value={report?.executionMode ?? "…"}
          valueColor={report?.executionMode === "LIVE" ? colors.warn : colors.textStrong}
          badge={report ? (
            <Badge bg={report.exchangeStatus === "OK" ? colors.upBg : colors.downBg} fg={report.exchangeStatus === "OK" ? colors.up : colors.down}>
              EXCHANGE {report.exchangeStatus}
            </Badge>
          ) : undefined}
          sub={report?.exchangeError ?? "data langsung dari exchange Binance"}
        />
        <StatCard
          label="SALDO EXCHANGE"
          value={usd(report?.exchangeBalanceUsd ?? null)}
          sub={`avail ${usd(report?.exchangeAvailableUsd ?? null)}`}
        />
        <StatCard
          label="ARM"
          value={report?.armed ? "ON" : "OFF"}
          valueColor={report?.armed ? colors.up : colors.textMuted}
          sub={report?.canTrade ? "guard: bisa entry" : `guard: ${report?.guardReasons.length ?? 0} alasan`}
        />
        <StatCard
          label="UPDATE"
          value={updatedAt || "…"}
          valueColor={colors.text}
          sub={report?.generatedAt ? new Date(report.generatedAt).toISOString().slice(11, 19) + " UTC" : undefined}
        />
      </div>

      {error && (
        <div style={{ background: colors.downBg, border: `1px solid ${colors.down}`, borderRadius: 6, padding: "10px 14px", color: colors.down, fontSize: 12 }}>
          Gagal mengambil data: {error}
        </div>
      )}

      {report && report.guardReasons.length > 0 && (
        <div style={{ background: colors.warnBg, border: `1px solid ${colors.warn}`, borderRadius: 6, padding: "10px 14px", color: colors.warn, fontSize: 11.5 }}>
          GUARD: {report.guardReasons.join(" | ")}
        </div>
      )}

      {/* STATUS AKTIVITAS ENTRY · lane mana yang sedang menerima entry */}
      {report && (
        <div
          style={{
            background: colors.upBg, border: `1px solid ${colors.up}`,
            borderRadius: 6, padding: "10px 14px", color: colors.up,
            fontSize: 11.5, lineHeight: 1.6,
          }}
        >
          <strong>ENTRY AKTIF → lane {report.entryActivity.activePrefix}</strong>
          {" · "}
          Simulasi dimatikan (30 Okt 2026).
        </div>
      )}

      {/* LANE LIVE */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <LaneHeader
          title="LANE LIVE · exposure nyata di exchange"
          lane={live ?? { status: "UNAVAILABLE", openPositions: 0, maxPositions: 0, closedTrades: 0, winRatePct: null, netPnlUsd: 0, equityUsd: 0, unrealizedPnlUsd: 0, lastEntryAt: null, lastTradeAt: null, positions: [], trades: [], exchangeOnlyPositions: [] }}
          accent={colors.warn}
          note={`posisi ${live?.openPositions ?? 0}/${live?.maxPositions ?? 0} • equity ${usd(live?.equityUsd)} • net ${usd(live?.netPnlUsd)} • WR ${pct(live?.winRatePct)} • entry terakhir ${age(live?.lastEntryAt)} lalu`}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <StatCard label="POSISI LIVE" value={live?.openPositions ?? "·"} sub={`kapasitas ${live?.maxPositions ?? "·"}`} />
          <StatCard label="EQUITY LIVE" value={usd(live?.equityUsd ?? null)} sub="saldo exchange" />
          <StatCard label="PNL REALISASI" value={usd(live?.netPnlUsd ?? null)} valueColor={pnlColor(live?.netPnlUsd)} sub={`${live?.closedTrades ?? 0} trade`} />
          <StatCard label="UNREALIZED" value={usd(live?.unrealizedPnlUsd ?? null)} valueColor={pnlColor(live?.unrealizedPnlUsd)} sub="mark price live" />
          <StatCard label="WIN RATE" value={pct(live?.winRatePct ?? null)} sub="lane LIVE saja" />
          <StatCard label="ENTRY TERAKHIR" value={age(live?.lastEntryAt)} sub={live?.lastEntryAt ? new Date(live.lastEntryAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "belum ada entry"} />
        </div>
        {live && (
          <Panel title="KURVA EQUITY LIVE · dari trade tertutup lane LIVE">
            <EquityCurve
              startEquity={live.equityUsd - live.netPnlUsd}
              trades={live.trades.map((t) => ({ createdAt: t.createdAt, pnlUsd: t.pnlUsd }))}
              currentEquity={live.equityUsd}
            />
          </Panel>
        )}
        {live && (
          <LaneTable
            lane={live}
            emptyText="Tidak ada posisi LIVE terbuka."
            onPick={(symbol) => selectChartSymbol(symbol)}
            onLacak={(symbol) => lacakTrade(symbol)}
          />
        )}
        {live && <LaneTrades lane={live} />}
        {live && live.exchangeOnlyPositions.length > 0 && (
          <ExchangeOnlyPanel items={live.exchangeOnlyPositions} />
        )}
      </div>

      {/* CHART POSISI LIVE · klines Binance + level entry/SL/TP */}
      <LivePositionChart positions={chartPositions} focusSymbol={focusSymbol} />

      {/* AKTIVITAS LIVE */}
      {report && <ActivityPanel activity={report.activity} />}

      {/* MIRROR DB ↔ EXCHANGE */}
      <MirrorPanel mirror={report?.mirror} />


      <div style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono, lineHeight: 1.6 }}>
        LIVE DASHBOARD • READ-ONLY • hanya exposure nyata di exchange Binance · simulasi dimatikan
        <br />
        Sumber gagal = UNAVAILABLE + alasan (bukan angka nol) • refresh 5s/10s/30s/OFF • alert untuk kejadian live baru
      </div>
      </>)}

      {/* Tab NETWORK / GRID / LACAK TRADE — isi Control Room, satu section. */}
      {opsTab !== "live" && (
        <ControlRoomSection
          view={opsTab === "grid" ? "grid" : opsTab === "lacak" ? "lacak" : "network"}
          onView={setOpsTab}
        />
      )}
    </div>
  );
}
