// apps/web/src/components/TopMoversTable.tsx
// Tabel Top Gainers/Losers — Tema B (Tahap 3): DataTable sortable, kolom
// angka mono rata kanan, PnL/24h berwarna up/dn. Props & perilaku sama.
import React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, card, cardHead, pctColor } from "../theme.js";
import { DataTable } from "./DataTable.js";

export interface TopMoverItem {
  symbol: string;
  price: number;
  chg24hPct: number;
  volume24hUsd: number;
  regime: "TRENDING" | "RANGING" | "VOLATILE" | "UNCERTAIN";
  eligible: boolean;
  eligibleReason: string | null;
}

interface Props {
  title: string;
  type: "gainers" | "losers";
  list: TopMoverItem[];
  priceFlash: Record<string, "flash-up" | "flash-down">;
  onTrade: (symbol: string) => void;
}

const REGIME_STYLE: Record<TopMoverItem["regime"], { bg: string; fg: string }> = {
  TRENDING: { bg: colors.accentSoft, fg: colors.accent },
  VOLATILE: { bg: colors.downBg, fg: colors.down },
  RANGING: { bg: "rgba(92,104,144,0.15)", fg: colors.textMuted },
  UNCERTAIN: { bg: colors.warnBg, fg: colors.warn },
};

const fmtP = (p: number) => {
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return "$" + p.toFixed(4);
  return "$" + p.toFixed(6);
};

// 23 Okt 2026: volume 24h ditampilkan LENGKAP (pemisah ribuan), bukan
// disingkat "12.3M". Operator butuh angka presisi untuk membandingkan
// volume pair dengan lantai VOLUME_MIN_USD miliknya.
const fmtV = (v: number) =>
  Number.isFinite(Number(v)) && Number(v) > 0 ? `$${Math.round(Number(v)).toLocaleString("en-US")}` : "·";

export function TopMoversTable({ title, type, list, priceFlash, onTrade }: Props) {
  const isGain = type === "gainers";
  const themeColor = isGain ? colors.up : colors.down;
  const bgHeader = isGain ? colors.upBg : colors.downBg;

  const columns: ColumnDef<TopMoverItem, any>[] = [
    {
      id: "pair", header: "PAIR", accessorFn: (m) => m.symbol,
      cell: ({ row }) => {
        const m = row.original;
        const flashCls = priceFlash[m.symbol];
        // Arah tick hanya di warna teks pair (tenang, tanpa flash background).
        const pairColor = flashCls === "flash-up" ? colors.up : flashCls === "flash-down" ? colors.down : colors.textStrong;
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5, color: pairColor, fontFamily: fonts.mono, transition: "color 0.4s ease" }}>{m.symbol}</span>
            {m.eligible && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 2, background: colors.upBg, color: colors.up, letterSpacing: "0.4px" }}>PERP</span>
            )}
          </span>
        );
      },
    },
    { id: "price", header: "HARGA REAL-TIME", meta: { align: "right" }, accessorFn: (m) => m.price, cell: ({ row }) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{fmtP(row.original.price)}</span> },
    {
      id: "chg", header: "24H CHG", meta: { align: "right" }, accessorFn: (m) => m.chg24hPct,
      cell: ({ row }) => {
        const c = row.original.chg24hPct;
        return <span style={{ fontWeight: 700, color: pctColor(c) }}>{c >= 0 ? "+" : ""}{c.toFixed(2)}%</span>;
      },
    },
    { id: "vol", header: "VOLUME 24H", meta: { align: "right" }, accessorFn: (m) => m.volume24hUsd, cell: ({ row }) => fmtV(row.original.volume24hUsd) },
    {
      id: "regime", header: "REGIME", accessorFn: (m) => m.regime,
      cell: ({ row }) => {
        const reg = REGIME_STYLE[row.original.regime] ?? REGIME_STYLE.RANGING;
        return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 2, background: reg.bg, color: reg.fg, letterSpacing: "0.4px", whiteSpace: "nowrap" }}>{row.original.regime}</span>;
      },
    },
    {
      id: "aksi", header: "AKSI", meta: { align: "center" }, enableSorting: false,
      cell: ({ row }) => (
        <button
          onClick={(e) => { e.stopPropagation(); onTrade(row.original.symbol); }}
          style={{
            fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 2, cursor: "pointer",
            fontFamily: fonts.main, background: colors.accentSoft, color: colors.accent,
            border: `1px solid rgba(224,34,44,0.4)`,
          }}
        >
          TRADE
        </button>
      ),
    },
  ];

  return (
    <div style={{ flex: 1, minWidth: 320, ...card, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ ...cardHead, background: bgHeader, color: themeColor, fontSize: 12.5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>{title}</span>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 2, background: colors.bgInput, color: colors.textMuted, letterSpacing: "0.5px" }}>
            BINANCE FUTURES
          </span>
        </div>
        <span style={{ fontSize: 10.5, fontFamily: fonts.mono, fontWeight: 600 }}>COUNT: {list.length}/20</span>
      </div>
      <DataTable
        columns={columns}
        data={list}
        maxHeight={580}
        emptyText="Memuat data real-time Binance Futures..."
        onRowClick={(m) => onTrade(m.symbol)}
      />
    </div>
  );
}