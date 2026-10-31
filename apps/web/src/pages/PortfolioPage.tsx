// Portfolio — KPI + posisi terbuka (Tema B). Data & polling TIDAK diubah:
// tetap /api/overview 20 detik + mark live via binanceWs. Tahap 3 redesign:
// tabel posisi jadi DataTable (sortable), header PageHead dengan X.
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors } from "../theme.js";
import { Panel, Delta, StatCell, Btn, PageHead } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { FlashValue } from "../components/FlashValue.js";
import { FeedBadge } from "../components/FeedBadge.js";
import { HistoryWorkspace } from "./HistoryWorkspace.js";
import { useMarkPrices } from "../lib/useMarkPrices.js";

interface Overview {
  equity?: { startingUsd?: number; currentUsd?: number; cumulativePnlUsd?: number; dailyPnlUsd?: number; drawdownUsd?: number };
  floating?: { totalPnlUsd?: number; positions?: Array<{ id: number; symbol: string; pnlUsd: number }> };
  positions?: Array<{ id: number; symbol: string; side: string; mode: string; source?: string; strategyId?: string; entryPrice: number; markPrice?: number; slPrice: number; tp1Price: number; marginUsd?: number; qty?: number; priceTick?: number }>;
}

type PosRow = NonNullable<Overview["positions"]>[number] & {
  mark: number;
  floating: number | null;
  roi: number | null;
  pricePct: number | null;
};

function digits(tick?: number, entry?: number): number {
  const t = Number(tick);
  if (Number.isFinite(t) && t > 0) return Math.min(8, Math.max(0, Math.round(-Math.log10(t))));
  const v = Number(entry);
  return !Number.isFinite(v) || v <= 0 ? 2 : v < 0.01 ? 6 : v < 1 ? 5 : v < 1000 ? 4 : 2;
}
function px(v: number | undefined, tick?: number, entry?: number): string {
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: digits(tick, entry), maximumFractionDigits: digits(tick, entry) }) : "·";
}
const money = (n?: number) => `$${Number(n ?? 0).toFixed(2)}`;
const pctColor = (v: number | null) => (v == null ? colors.textMuted : v > 0 ? colors.up : v < 0 ? colors.down : colors.textMuted);

export function PortfolioPage({ sub = "overview", onSub }: { sub?: string; onSub: (s: "overview" | "history") => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sub === "history") return;
    let alive = true;
    /*
       30 Okt 2026 (perintah operator poin 1): Portfolio memakai akun LIVE
       Binance — bukan akun simulasi ($200). Sumber: /api/live/dashboard
       (exchangeBalanceUsd + lane LIVE). Angka simulasi tidak pernah tampil.
    */
    const adapt = (d: any): Overview => ({
      equity: {
        startingUsd: undefined,
        currentUsd: Number(d?.exchangeBalanceUsd ?? d?.live?.equityUsd ?? 0),
        cumulativePnlUsd: Number(d?.live?.netPnlUsd ?? 0),
      },
      floating: {
        totalPnlUsd: Number(d?.live?.unrealizedPnlUsd ?? 0),
        positions: (d?.live?.positions ?? []).map((p: any) => ({ id: Number(p.id), symbol: String(p.symbol), pnlUsd: Number(p.unrealizedPnlUsd ?? 0) })),
      },
      positions: (d?.live?.positions ?? []).map((p: any) => ({
        id: Number(p.id), symbol: String(p.symbol), side: String(p.side), mode: String(p.mode),
        source: String(p.source ?? "LIVE_"), strategyId: p.strategyId ?? undefined,
        entryPrice: Number(p.entryPrice), slPrice: Number(p.slPrice), tp1Price: Number(p.tp1Price),
        marginUsd: Number(p.marginUsd), qty: Number(p.qty),
      })),
    });
    fetch("/api/live/dashboard", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (!alive) return;
      setOv(adapt(d));
      setError(d ? null : "live dashboard unavailable");
    }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : "portfolio unavailable"); });
    const id = window.setInterval(() => void fetch("/api/live/dashboard", { cache: "no-store" }).then((r) => r.json()).then((d) => { if (alive) setOv(adapt(d)); }).catch(() => {}), 20_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [sub]);

  const eq = ov?.equity;
  // 30 Okt 2026 (B2, perintah operator): hanya baris LIVE yang tampil —
  // baris paper (source PAPER_*) tidak ditampilkan (paper trading dimatikan).
  const open = (ov?.positions ?? []).filter((p) => String(p.source ?? "").startsWith("LIVE_"));
  const symbols = useMemo(() => [...new Set(open.map((p) => p.symbol))].sort(), [open]);
  // Mark price realtime: WS publik Binance Futures -> fallback hub backend.
  const { marks, status } = useMarkPrices(symbols);

  // Floating PnL: pakai mark live bila semua posisi punya mark; fallback angka server.
  const rows: PosRow[] = open.map((p) => {
    const mark = marks.get(p.symbol)?.mark ?? Number(p.markPrice);
    const qty = Number(p.qty);
    const computed = Number.isFinite(mark) && mark > 0 && Number.isFinite(qty)
      ? (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * qty : null;
    const overviewPnl = ov?.floating?.positions?.find((x) => x.id === p.id)?.pnlUsd;
    const f = computed !== null ? computed : (Number.isFinite(Number(overviewPnl)) ? Number(overviewPnl) : null);
    const margin = Number(p.marginUsd);
    const roi = f !== null && Number.isFinite(margin) && margin > 0 ? (f / margin) * 100 : null;
    const pricePct = Number.isFinite(mark) && mark > 0 && p.entryPrice > 0
      ? ((mark - p.entryPrice) / p.entryPrice) * 100 : null;
    return { ...p, mark, floating: f, roi, pricePct };
  });
  const hasLiveMarks = open.every((p) => Number(marks.get(p.symbol)?.mark) > 0);
  const floatingTotal = hasLiveMarks
    ? rows.reduce((sum, r) => sum + (r.floating ?? 0), 0)
    : (ov?.floating?.totalPnlUsd ?? 0);

  const columns = useMemo<ColumnDef<PosRow, any>[]>(() => [
    {
      id: "symbol", header: "Symbol", accessorFn: (r) => r.symbol,
      cell: ({ row }) => (
        <span>
          <span className="position-symbol">{row.original.symbol}</span>
          <div className="tiny muted">#{row.original.id}</div>
        </span>
      ),
    },
    {
      id: "side", header: "Side", accessorFn: (r) => r.side,
      cell: ({ row }) => <span style={{ color: row.original.side === "LONG" ? colors.up : colors.down }}>{row.original.side}</span>,
    },
    { id: "mode", header: "Mode", accessorFn: (r) => r.mode, cell: ({ getValue }) => <span className="muted">{getValue<string>()}</span> },
    { id: "entry", header: "Entry", meta: { align: "right" }, accessorFn: (r) => r.entryPrice, cell: ({ row }) => px(row.original.entryPrice, row.original.priceTick, row.original.entryPrice) },
    { id: "mark", header: "Mark", meta: { align: "right" }, accessorFn: (r) => r.mark, cell: ({ row }) => px(row.original.mark, row.original.priceTick, row.original.entryPrice) },
    { id: "sl", header: "SL", meta: { align: "right" }, accessorFn: (r) => r.slPrice, cell: ({ row }) => <span style={{ color: colors.down }}>{px(row.original.slPrice, row.original.priceTick, row.original.entryPrice)}</span> },
    { id: "tp1", header: "TP1", meta: { align: "right" }, accessorFn: (r) => r.tp1Price, cell: ({ row }) => <span style={{ color: colors.up }}>{px(row.original.tp1Price, row.original.priceTick, row.original.entryPrice)}</span> },
    { id: "margin", header: "Margin", meta: { align: "right" }, accessorFn: (r) => r.marginUsd ?? 0, cell: ({ row }) => money(row.original.marginUsd) },
    {
      id: "floating", header: "Floating", meta: { align: "right" },
      accessorFn: (r) => r.floating ?? 0,
      cell: ({ row }) => {
        const f = row.original.floating;
        return (
          <FlashValue value={f} style={{ color: pctColor(f) }}>
            {f === null ? "·" : `${f >= 0 ? "+" : ""}${f.toFixed(2)}`}
          </FlashValue>
        );
      },
    },
    {
      id: "roi", header: "ROI", meta: { align: "right" },
      accessorFn: (r) => r.roi ?? 0,
      cell: ({ row }) => {
        const v = row.original.roi;
        return (
          <FlashValue value={v} style={{ color: pctColor(v) }}>
            {v === null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
          </FlashValue>
        );
      },
    },
    {
      id: "pricePct", header: "Δ ENTRY", meta: { align: "right" },
      accessorFn: (r) => r.pricePct ?? 0,
      cell: ({ row }) => {
        const v = row.original.pricePct;
        return <span style={{ color: pctColor(v) }}>{v === null ? "·" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}</span>;
      },
    },
  ], []);

  // 29 Okt 2026 (fix) — early return WAJIB setelah semua hook. Sebelumnya
  // `if (sub === "history") return <HistoryWorkspace />` berada SEBELUM
  // useMemo kolom, sehingga React menghitung hook lebih sedikit saat
  // sub=history → "Rendered fewer hooks than expected" dan halaman Portfolio
  // history crash. Hook tidak boleh dilewati antar render.
  if (sub === "history") return <HistoryWorkspace />;

  return (
    <div className="page">
      <PageHead
        eyebrow="PORTFOLIO / OVERVIEW"
        title="Portfolio"
        desc="Equity, open positions, and account evidence"
        right={<Btn tone="ghost" onClick={() => onSub("history")}>Full history →</Btn>}
      />

      <div className="metric-strip">
        <div><StatCell label="Equity" value={money(eq?.currentUsd)} sub="saldo akun LIVE Binance" /></div>
        <div><StatCell label="Realized P&L" value={<Delta value={eq?.cumulativePnlUsd ?? 0} suffix=" USD" digits={2} />} sub={<span>Floating <Delta value={floatingTotal} suffix=" USD" digits={2} /></span>} /></div>
        <div><StatCell label="Open exposure" value={open.length} sub={`${open.filter((p) => p.mode === "SWING").length} swing · ${open.filter((p) => p.mode !== "SWING").length} scalp`} /></div>
        <div><StatCell label="Floating P&L" value={<Delta value={floatingTotal} suffix=" USD" digits={2} />} sub={`${open.length}/20 open positions`} /></div>
      </div>

      <Panel title="Open positions" extra={symbols.length ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><FeedBadge status={status} /><span className="tiny mono muted">LIVE MARKS · SORTABLE</span></span> : <span className="tiny mono muted">LIVE MARKS · SORTABLE</span>} bodyStyle={{ padding: 0 }}>
        <DataTable columns={columns} data={rows} maxHeight={520} emptyText="Tidak ada posisi terbuka." />
      </Panel>

      {error && <div className="tiny" style={{ color: colors.down }}>{error}</div>}
    </div>
  );
}