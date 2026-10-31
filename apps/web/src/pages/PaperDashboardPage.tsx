// apps/web/src/pages/PaperDashboardPage.tsx · Dashboard PAPER (27 Okt 2026).
//
// 27 Okt 2026 sore (koreksi operator): tab LIVE harus LIVE-ONLY. Semua
// simulasi dipindah ke tab PAPER ini: lane PAPER (simulasi di DB utama) dan
// forward-paper (worker riset terisolasi, wallet terpisah per strategi).
//
// Tab ini TIDAK menampilkan exposure riil di exchange: saldo/posisi live
// ada di tab LIVE. Yang tampil di sini murni simulasi.
//
// Tahap 3 redesign tema B "X / ink": tabel forward-paper manual -> <DataTable>
// (sortable), header -> <PageHead> (eyebrow + judul serif + desc), badge PAPER
// netral (sand), placeholder kosong "·" (bukan em dash).
// Data binding, endpoint, polling 10 detik, dan handler load() TIDAK diubah.
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { Panel, PageHead, Btn, Badge } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import {
  type LaneReport, type ForwardWorkerRow,
  usd, pct, pnlColor, hhmm, age, StatCard, LaneHeader, LaneTable, LaneTrades,
} from "./liveShared.js";
import { EquityCurve } from "../components/EquityCurve.js";
import { LivePositionChart } from "./LivePositionChart.js";

interface PaperDashboardReport extends LaneReport {
  exchangeBalanceUsd: number | null;
  exchangeAvailableUsd: number | null;
  exchangeStatus: "OK" | "UNAVAILABLE";
  exchangeError?: string;
}

/** Placeholder kosong tema B: titik tengah, bukan em dash. */
const DOT = "·";
/**
 * Helper liveShared.tsx (yang tidak boleh diubah) masih mengembalikan em dash
 * sebagai placeholder kosong. Normalkan ke "·" supaya tema B konsisten,
 * tanpa mengubah file helper itu sendiri.
 */
const dotify = (s: string): string => (s === "·" ? DOT : s);

export function PaperDashboardPage() {
  const [report, setReport] = useState<PaperDashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");

  const fetchReport = async () => {
    try {
      const res = await fetch("/api/live/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PaperDashboardReport;
      setReport(data);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString("id-ID"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    let alive = true;
    const poll = () => { if (!alive) return; fetchReport(); };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        poll();
        id = setInterval(poll, 10000);
      } else if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    let id: ReturnType<typeof setInterval> | null = null;
    if (document.visibilityState === "visible") {
      poll();
      id = setInterval(poll, 10000);
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const paper = report?.paper;
  const workers = report?.forwardPaper.workers ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        eyebrow="LIVE / PAPER"
        title="Paper Dashboard"
        desc="Murni simulasi, tidak ada exposure riil di exchange. Lane PAPER = simulasi di DB utama; forward-paper = worker riset terisolasi dengan wallet terpisah per strategi. Exposure nyata ada di tab LIVE. READ-ONLY."
        right={
          <>
            <Badge bg={colors.sandBg} fg={colors.sand}>PAPER</Badge>
            <Btn onClick={fetchReport}>REFRESH</Btn>
          </>
        }
      />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatCard
          label="LANE PAPER"
          value={paper?.status ?? DOT}
          valueColor={paper?.status === "OK" ? colors.textStrong : colors.down}
          sub={`posisi ${paper?.openPositions ?? 0}/${paper?.maxPositions ?? 0}`}
        />
        <StatCard
          label="FORWARD PAPER"
          value={report?.forwardPaper.status ?? DOT}
          valueColor={report?.forwardPaper.status === "OK" ? colors.textStrong : colors.down}
          sub={`${workers.filter((w) => w.status === "OK").length}/${workers.length} worker OK`}
        />
        <StatCard
          label="ENTRY AKTIF"
          value={report?.entryActivity.activePrefix ?? DOT}
          valueColor={colors.warn}
          sub={report?.entryActivity.paperDbLaneFrozen ? "lane PAPER DB utama beku" : "lane PAPER menerima entry"}
        />
        <StatCard label="UPDATE" value={updatedAt || DOT} valueColor={colors.text} />
      </div>

      {error && (
        <div style={{ background: colors.downBg, border: `1px solid ${colors.down}`, borderRadius: 6, padding: "10px 14px", color: colors.down, fontSize: 12 }}>
          Gagal mengambil data: {error}
        </div>
      )}

      {report && report.entryActivity.paperDbLaneFrozen && (
        <div style={{ background: colors.warnBg, border: `1px solid ${colors.warn}`, borderRadius: 6, padding: "10px 14px", color: colors.warn, fontSize: 11.5, lineHeight: 1.6 }}>
          <strong>LANE PAPER (DB utama) FROZEN</strong>
          <br />
          {report.entryActivity.note}
        </div>
      )}

      {/* LANE PAPER */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <LaneHeader
          title="LANE PAPER · simulasi di DB utama (tidak ada di exchange)"
          lane={paper ?? { status: "UNAVAILABLE", openPositions: 0, maxPositions: 0, closedTrades: 0, winRatePct: null, netPnlUsd: 0, equityUsd: 0, unrealizedPnlUsd: 0, lastEntryAt: null, lastTradeAt: null, positions: [], trades: [], exchangeOnlyPositions: [] }}
          accent={colors.accent}
          note={`posisi ${paper?.openPositions ?? 0}/${paper?.maxPositions ?? 0} • equity ${dotify(usd(paper?.equityUsd))} • net ${dotify(usd(paper?.netPnlUsd))} • WR ${dotify(pct(paper?.winRatePct))} • entry terakhir ${dotify(age(paper?.lastEntryAt))} lalu`}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <StatCard label="POSISI PAPER" value={paper?.openPositions ?? DOT} sub={`kapasitas ${paper?.maxPositions ?? DOT}`} />
          <StatCard label="EQUITY PAPER" value={dotify(usd(paper?.equityUsd ?? null))} sub="modal simulasi + PnL lane PAPER" />
          <StatCard label="PNL REALISASI" value={dotify(usd(paper?.netPnlUsd ?? null))} valueColor={pnlColor(paper?.netPnlUsd)} sub={`${paper?.closedTrades ?? 0} trade`} />
          <StatCard label="UNREALIZED" value={dotify(usd(paper?.unrealizedPnlUsd ?? null))} valueColor={pnlColor(paper?.unrealizedPnlUsd)} sub="mark price live" />
          <StatCard label="WIN RATE" value={dotify(pct(paper?.winRatePct ?? null))} sub="lane PAPER saja" />
          <StatCard label="ENTRY TERAKHIR" value={dotify(age(paper?.lastEntryAt))} sub={paper?.lastEntryAt ? new Date(paper.lastEntryAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "belum ada entry"} />
        </div>
        {paper && (
          <Panel title="KURVA EQUITY PAPER · dari trade tertutup lane PAPER">
            <EquityCurve
              startEquity={paper.equityUsd - paper.netPnlUsd}
              trades={paper.trades.map((t) => ({ createdAt: t.createdAt, pnlUsd: t.pnlUsd }))}
              currentEquity={paper.equityUsd}
              color={colors.up}
            />
          </Panel>
        )}
        {paper && <LaneTable lane={paper} emptyText="Tidak ada posisi PAPER terbuka." />}
        {paper && <LaneTrades lane={paper} />}
        {paper && (
          <LivePositionChart positions={paper.positions.map((pt) => ({
            key: `paper-${pt.id}`, symbol: pt.symbol, side: pt.side, qty: pt.qty,
            entryPrice: pt.entryPrice, slPrice: pt.slPrice, tp1Price: pt.tp1Price, tp2Price: pt.tp2Price,
            marginUsd: pt.marginUsd, leverage: pt.leverage, unrealizedPnlUsd: pt.unrealizedPnlUsd,
            strategyId: pt.strategyId, source: pt.source, openedAt: pt.openedAt,
          }))} />
        )}
      </div>

      {/* FORWARD PAPER */}
      <ForwardPaperPanel workers={workers} status={report?.forwardPaper.status ?? DOT} error={report?.forwardPaper.error} />

      <div style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono, lineHeight: 1.6 }}>
        PAPER DASHBOARD • READ-ONLY • simulasi saja · saldo & posisi riil exchange ada di tab LIVE
        <br />
        Forward-paper memakai wallet terpisah per strategi dan TIDAK dijumlahkan ke lane manapun
      </div>
    </div>
  );
}

function ForwardPaperPanel({ workers, status, error }: {
  workers: ForwardWorkerRow[]; status: string; error?: string;
}) {
  // Tahap 3: kolom DataTable untuk worker forward-paper. Semua kolom lama
  // (13 kolom) tetap ada dengan nilai yang sama, angka rata kanan.
  const cols: ColumnDef<ForwardWorkerRow, any>[] = useMemo(() => [
    {
      accessorKey: "strategyId", header: "STRATEGI",
      cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{i.getValue() as string}</span>,
    },
    { accessorKey: "port", header: "PORT", meta: { align: "right" } },
    {
      accessorKey: "status", header: "STATUS",
      cell: (i) => {
        const v = i.getValue() as ForwardWorkerRow["status"];
        return (
          <Badge bg={v === "OK" ? colors.upBg : colors.downBg} fg={v === "OK" ? colors.up : colors.down}>
            {v}
          </Badge>
        );
      },
    },
    {
      accessorKey: "running", header: "RUNNING",
      cell: (i) => (i.getValue()
        ? <span style={{ color: colors.up, fontWeight: 600 }}>YA</span>
        : <span style={{ color: colors.textMuted }}>TIDAK</span>),
    },
    {
      accessorKey: "liveEnabled", header: "LIVE ENABLED",
      cell: (i) => (i.getValue()
        ? <span style={{ color: colors.down, fontWeight: 600 }}>YA</span>
        : <span style={{ color: colors.textMuted }}>TIDAK</span>),
    },
    {
      accessorKey: "equityUsd", header: "EQUITY", meta: { align: "right" },
      cell: (i) => dotify(usd(i.getValue() as number | null)),
    },
    {
      accessorKey: "cashUsd", header: "CASH", meta: { align: "right" },
      cell: (i) => dotify(usd(i.getValue() as number | null)),
    },
    {
      accessorKey: "reservedMarginUsd", header: "MARGIN RESERVED", meta: { align: "right" },
      cell: (i) => dotify(usd(i.getValue() as number | null)),
    },
    {
      accessorKey: "trades", header: "TRADES", meta: { align: "right" },
      cell: (i) => { const v = i.getValue() as number | null; return v == null ? DOT : String(v); },
    },
    {
      accessorKey: "winRatePct", header: "WR", meta: { align: "right" },
      cell: (i) => dotify(pct(i.getValue() as number | null)),
    },
    {
      accessorKey: "netPnlUsd", header: "NET PNL", meta: { align: "right" },
      cell: (i) => {
        const v = i.getValue() as number | null;
        return <span style={{ color: pnlColor(v) }}>{dotify(usd(v, 4))}</span>;
      },
    },
    { accessorKey: "openPositions", header: "POSISI", meta: { align: "right" } },
    {
      accessorKey: "lastCycleAt", header: "LAST CYCLE",
      cell: (i) => {
        const v = i.getValue() as number | null;
        return v ? hhmm(new Date(v).toISOString()) : DOT;
      },
    },
  ], []);

  return (
    <Panel
      title="FORWARD PAPER · worker riset terisolasi (wallet terpisah per strategi, TIDAK dijumlahkan ke lane mana pun)"
      extra={
        <Badge bg={status === "OK" ? colors.upBg : colors.downBg} fg={status === "OK" ? colors.up : colors.down}>
          {status}
        </Badge>
      }
      bodyStyle={{ padding: 0 }}
    >
      {error && (
        <div style={{ padding: "8px 12px", fontSize: 10.5, color: colors.down, fontFamily: fonts.mono }}>{error}</div>
      )}
      <DataTable
        columns={cols}
        data={workers}
        maxHeight={460}
        emptyText="Tidak ada data forward-paper worker."
      />
    </Panel>
  );
}
