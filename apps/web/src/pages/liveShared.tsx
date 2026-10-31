// apps/web/src/pages/liveShared.tsx — tipe + komponen dasar yang dipakai
// halaman LIVE dan PAPER (27 Okt 2026).
//
// Dipisah karena LIVE harus LIVE-ONLY (hanya exposure nyata di exchange) dan
// PAPER harus PAPER-ONLY (simulasi + forward-paper). Semula keduanya dalam
// satu halaman sehingga operator melihat campur.
//
// Semua angka ditampilkan apa adanya: sumber yang gagal = UNAVAILABLE + alasan,
// bukan nol palsu.
import { useMemo } from "react";
import type React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { Panel, Badge } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { FlashValue } from "../components/FlashValue.js";
import { FeedBadge } from "../components/FeedBadge.js";
import { useMarkPrices } from "../lib/useMarkPrices.js";

export interface LanePositionRow {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  qty: number;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number | null;
  notional: number;
  marginUsd: number;
  leverage: number;
  unrealizedPnlUsd: number | null;
  strategyId: string | null;
  openedAt: string;
  source: string;
}

export interface LaneTradeRow {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  pnlUsd: number;
  rMultiple: number;
  feeUsd: number;
  win: boolean;
  closeReason: string | null;
  strategyId: string | null;
  createdAt: string;
  source: string;
}

export interface LaneStats {
  status: "OK" | "UNAVAILABLE";
  error?: string;
  openPositions: number;
  maxPositions: number;
  closedTrades: number;
  winRatePct: number | null;
  netPnlUsd: number;
  equityUsd: number;
  unrealizedPnlUsd: number;
  lastEntryAt: string | null;
  lastTradeAt: string | null;
  positions: LanePositionRow[];
  trades: LaneTradeRow[];
  /** Posisi ada di exchange tapi belum punya baris DB (belum ter-track supervisor). */
  exchangeOnlyPositions: ExchangeOnlyPosition[];
}

/** Posisi di exchange tanpa baris DB — level SL/TP dari algo order. */
export interface ExchangeOnlyPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  markPrice: number | null;
  leverage: string | null;
  marginType: string | null;
  slPrice: number | null;
  tpPrices: number[];
  untracked: boolean;
}

export interface ForwardWorkerRow {
  strategyId: string;
  port: number;
  status: "OK" | "UNAVAILABLE";
  error?: string;
  running: boolean;
  liveEnabled: boolean;
  equityUsd: number | null;
  cashUsd: number | null;
  reservedMarginUsd: number | null;
  initialBalanceUsd: number | null;
  maxPositions: number | null;
  trades: number | null;
  winRatePct: number | null;
  netPnlUsd: number | null;
  openPositions: number;
  lastCycleAt: number | null;
  bankrupt: boolean;
  errors: string[];
}

export interface LiveActivityRow {
  id: number;
  kind: "ORDER" | "POSITION" | "EVENT";
  symbol: string;
  side: string | null;
  type: string | null;
  status: string;
  qty: number | null;
  price: number | null;
  live: boolean;
  source: string | null;
  at: string;
  detail: string | null;
}

export interface EntryActivity {
  activePrefix: "PAPER" | "LIVE";
  activeDbLane: "live" | "paper";
  paperDbLaneFrozen: boolean;
  note: string;
}

export interface LaneReport {
  executionMode: "PAPER" | "LIVE";
  armed: boolean;
  canTrade: boolean;
  guardReasons: string[];
  entryActivity: EntryActivity;
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
      /** Semua order live yang pernah dikirim (termasuk NEW/CANCELED). */
      liveOrdersTotal: number;
      /** Order live yang BENAR-BENAR MASUK (FILLED). */
      liveOrdersFilled: number;
      liveOrdersCanceled: number;
      /** Order live yang masih resting di book (NEW, belum terisi). */
      liveOrdersOpen: number;
      liveOrdersRejected: number;
      livePositionsTotal: number;
      livePositionsOpen: number;
      /** Waktu order live terakhir yang MASUK. */
      lastLiveOrderAt: string | null;
      lastFilledOrder: {
        id: number; symbol: string; side: string | null;
        type: string | null; qty: number | null; price: number | null; at: string;
      } | null;
    };
  };
}

export const usd = (n: number | null | undefined, digits = 2): string =>
  n == null || !Number.isFinite(n) ? "·" : `$${n.toFixed(digits)}`;

export const num = (n: number | null | undefined, digits = 4): string =>
  n == null || !Number.isFinite(n) ? "·" : n.toFixed(digits);

export const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "·" : `${n.toFixed(2)}%`;

export const pnlColor = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? colors.textMuted : n > 0 ? colors.up : n < 0 ? colors.down : colors.textMuted;

export function hhmm(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "·";
  }
}

/** Umur event (ISO) dalam bahasa manusia, mis. "3j 12m" / "45d". */
export function age(iso: string | null | undefined): string {
  if (!iso) return "·";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "·";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}j`;
}

export function StatCard({ label, value, sub, valueColor, badge }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; valueColor?: string; badge?: React.ReactNode;
}) {
  return (
    <div style={{ background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 2, padding: "10px 14px", minWidth: 150 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>{label}</div>
        {badge}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.mono, color: valueColor ?? colors.textStrong, margin: "2px 0" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: colors.textMuted }}>{sub}</div>}
    </div>
  );
}

export function LaneHeader({ title, lane, accent, note }: {
  title: string; lane: LaneStats; accent: string; note: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: accent }}>{title}</span>
      <Badge bg={lane.status === "OK" ? colors.upBg : colors.downBg} fg={lane.status === "OK" ? colors.up : colors.down}>
        {lane.status}
      </Badge>
      <span style={{ fontSize: 11, color: colors.textMuted }}>{note}</span>
      {lane.error && <span style={{ fontSize: 11, color: colors.down }}>{lane.error}</span>}
    </div>
  );
}

/** Baris posisi + hasil hitung PnL/ROI realtime dari feed mark (WS + hub). */
type LaneLiveRow = LanePositionRow & { mark: number | null; livePnl: number | null; roi: number | null };

export function LaneTable({ lane, emptyText, onPick, onLacak }: {
  lane: LaneStats; emptyText: string; onPick?: (symbol: string) => void;
  /** Tombol LACAK TRADE (read-only) per baris — membuka trace di Control Room. */
  onLacak?: (symbol: string) => void;
}) {
  // Mark price realtime: WS publik Binance Futures (primadona) -> fallback hub
  // backend. Badge DELAYED tampil bila angka berasal dari cadangan.
  const symbols = useMemo(() => lane.positions.map((p) => p.symbol), [lane.positions]);
  const { marks, status } = useMarkPrices(symbols);

  const rows = useMemo<LaneLiveRow[]>(
    () => lane.positions.map((p) => {
      const mark = marks.get(p.symbol)?.mark ?? null;
      const qty = Number(p.qty);
      const livePnl = mark != null && Number.isFinite(qty)
        ? (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * qty
        : (p.unrealizedPnlUsd ?? null);
      const margin = Number(p.marginUsd);
      const roi = livePnl != null && Number.isFinite(margin) && margin > 0 ? (livePnl / margin) * 100 : null;
      return { ...p, mark, livePnl, roi };
    }),
    [lane.positions, marks],
  );

  const cols = useMemo<ColumnDef<LaneLiveRow, any>[]>(() => {
    const base: ColumnDef<LaneLiveRow, any>[] = [
      { accessorKey: "symbol", header: "SYMBOL", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span> },
      { accessorKey: "side", header: "SIDE", cell: (i) => <span style={{ color: (i.getValue() as string) === "LONG" ? colors.up : colors.down, fontWeight: 700 }}>{i.getValue() as string}</span> },
      { accessorKey: "mode", header: "MODE" },
      { accessorKey: "strategyId", header: "STRATEGY", cell: (i) => (i.getValue() as string | null) ?? "·" },
      { accessorKey: "qty", header: "QTY", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 4) },
      { accessorKey: "entryPrice", header: "ENTRY", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 6) },
      { accessorKey: "mark", header: "MARK", meta: { align: "right" }, cell: (i) => num(i.getValue() as number | null, 6) },
      { accessorKey: "slPrice", header: "SL", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 6) },
      { accessorKey: "tp1Price", header: "TP1", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 6) },
      { accessorKey: "notional", header: "NOTIONAL", meta: { align: "right" }, cell: (i) => usd(i.getValue() as number) },
      { accessorKey: "marginUsd", header: "MARGIN", meta: { align: "right" }, cell: (i) => usd(i.getValue() as number) },
      {
        accessorKey: "livePnl", header: "UNREALIZED", meta: { align: "right" },
        cell: (i) => {
          const v = i.getValue() as number | null;
          return <FlashValue value={v} style={{ color: pnlColor(v) }}>{v == null ? "·" : usd(v)}</FlashValue>;
        },
      },
      {
        accessorKey: "roi", header: "ROI", meta: { align: "right" },
        cell: (i) => {
          const v = i.getValue() as number | null;
          return <FlashValue value={v} style={{ color: pnlColor(v) }}>{pct(v)}</FlashValue>;
        },
      },
      { accessorKey: "openedAt", header: "OPENED", cell: (i) => hhmm(i.getValue() as string) },
    ];
    if (onLacak) {
      base.push({
        id: "lacak", header: "AUDIT", meta: { align: "right" }, enableSorting: false,
        cell: (i) => (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLacak(i.row.original.symbol); }}
            title={`Buka trace ${i.row.original.symbol} di Control Room (read-only)`}
            style={{
              background: "transparent", border: `1px solid ${colors.up}`, color: colors.up,
              borderRadius: 2, cursor: "pointer", fontSize: 9, fontWeight: 700,
              letterSpacing: "0.1em", padding: "3px 7px", fontFamily: fonts.mono, whiteSpace: "nowrap",
            }}
          >
            LACAK TRADE →
          </button>
        ),
      });
    }
    return base;
  }, [onLacak]);
  return (
    <Panel
      title="POSISI TERBUKA"
      extra={symbols.length ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><FeedBadge status={status} /><span style={{ fontSize: 9, color: colors.textDim, fontFamily: fonts.mono }}>PnL · ROI REALTIME</span></span> : undefined}
      bodyStyle={{ padding: 0 }}
    >
      <DataTable
        columns={cols}
        data={rows}
        emptyText={emptyText}
        maxHeight={420}
        onRowClick={onPick ? (r) => onPick(r.symbol) : undefined}
      />
    </Panel>
  );
}

export function LaneTrades({ lane }: { lane: LaneStats }) {
  const cols = useMemo<ColumnDef<LaneTradeRow, any>[]>(() => [
    { accessorKey: "createdAt", header: "WAKTU", cell: (i) => hhmm(i.getValue() as string) },
    { accessorKey: "symbol", header: "SYMBOL", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span> },
    { accessorKey: "side", header: "SIDE", cell: (i) => <span style={{ color: (i.getValue() as string) === "LONG" ? colors.up : colors.down }}>{i.getValue() as string}</span> },
    { accessorKey: "strategyId", header: "STRATEGY", cell: (i) => (i.getValue() as string | null) ?? "·" },
    { accessorKey: "closeReason", header: "CLOSE", cell: (i) => (i.getValue() as string | null) ?? "·" },
    { accessorKey: "rMultiple", header: "R", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 3) },
    {
      accessorKey: "pnlUsd", header: "PNL", meta: { align: "right" },
      cell: (i) => { const v = i.getValue() as number; return <span style={{ color: pnlColor(v), fontWeight: 600 }}>{usd(v, 4)}</span>; },
    },
    { accessorKey: "feeUsd", header: "FEE", meta: { align: "right" }, cell: (i) => usd(i.getValue() as number, 4) },
    { accessorKey: "win", header: "HASIL", cell: (i) => (i.getValue() as boolean) ? "WIN" : "LOSS" },
  ], []);
  return (
    <Panel title="TRADE TERAKHIR" bodyStyle={{ padding: 0 }}>
      <DataTable columns={cols} data={lane.trades} emptyText="Belum ada trade tertutup di lane ini." maxHeight={380} />
    </Panel>
  );
}


/**
 * Posisi yang ada di exchange tapi BELUM punya baris DB — supervisor tidak
 * melacak exit-nya (mis. fill terjadi saat service restart). Ditampilkan
 * mencolok supaya operator tahu ada exposure yang tak terlacak.
 */
export function ExchangeOnlyPanel({ items, onPick }: {
  items: ExchangeOnlyPosition[]; onPick?: (symbol: string) => void;
}) {
  const cols = useMemo<ColumnDef<ExchangeOnlyPosition, any>[]>(() => [
    { accessorKey: "symbol", header: "SYMBOL", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span> },
    { accessorKey: "side", header: "SIDE", cell: (i) => <span style={{ color: (i.getValue() as string) === "LONG" ? colors.up : colors.down, fontWeight: 700 }}>{i.getValue() as string}</span> },
    { accessorKey: "qty", header: "QTY", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 4) },
    { accessorKey: "entryPrice", header: "ENTRY", meta: { align: "right" }, cell: (i) => num(i.getValue() as number, 6) },
    { accessorKey: "markPrice", header: "MARK", meta: { align: "right" }, cell: (i) => num(i.getValue() as number | null, 6) },
    {
      accessorKey: "slPrice", header: "SL", meta: { align: "right" },
      cell: (i) => { const v = i.getValue() as number | null; return <span style={{ color: colors.down }}>{v == null ? "TIDAK ADA" : num(v, 6)}</span>; },
    },
    {
      id: "tp", header: "TP", meta: { align: "right" },
      cell: (i) => { const tps = i.row.original.tpPrices; return <span style={{ color: colors.up }}>{tps.length ? tps.map((t) => num(t, 6)).join(" / ") : "·"}</span>; },
    },
    { accessorKey: "leverage", header: "LEVERAGE", cell: (i) => (i.getValue() as string | null) ?? "·" },
    { accessorKey: "marginType", header: "MARGIN", cell: (i) => (i.getValue() as string | null) ?? "·" },
  ], []);
  if (items.length === 0) return null;
  return (
    <Panel
      title="POSISI TANPA DB · ada di exchange, TIDAK di-track supervisor"
      extra={
        <Badge bg={colors.warnBg} fg={colors.warn}>
          {items.length} POSISI
        </Badge>
      }
      bodyStyle={{ padding: 0 }}
    >
      <div style={{ padding: "8px 12px", fontSize: 10.5, color: colors.warn, lineHeight: 1.6, borderBottom: `1px solid ${colors.border}` }}>
        Posisi berikut punya exposure riil di exchange tapi tidak punya baris Position di DB ·
        supervisor TIDAK memantau exit-nya. Level SL/TP diambil dari algo order yang terpasang
        di exchange. Tutup manual lewat exchange bila perlu.
      </div>
      <DataTable columns={cols} data={items} maxHeight={320} onRowClick={onPick ? (r) => onPick(r.symbol) : undefined} />
    </Panel>
  );
}
