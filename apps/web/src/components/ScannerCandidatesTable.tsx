// apps/web/src/components/ScannerCandidatesTable.tsx
// Tabel kandidat scanner, Tema B (Tahap 3 redesign).
//
// Tahap 3: <table> manual -> <DataTable> (TanStack Table + virtual).
// SEMANTIK SEL TIDAK BERUBAH: nilai, title tooltip, dan fallback "n/a"/"·"
// persis sama seperti versi lama (dijaga test ScannerCandidatesTable.test.tsx).
// Perbedaan hanya di PRESENTASI: kolom angka rata kanan, badge status pakai
// token netral (bukan rgba hardcode), placeholder kosong "·" (bukan em dash).
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, card, cardHead, badge } from "../theme.js";
import { DataTable } from "./DataTable.js";

export interface CandidateItem {
  symbol: string;
  score: number;
  mode: "SCALP" | "SWING";
  regime: string;
  zoneScore?: number;
  triggerScore?: number;
  trendScore?: number;
  knnProb?: number | null;
  status?: string;
  // Big Brain B (14 Okt 2026): fitur persepsi baru dari /api/markets/scan.
  er?: number | null;
  pocDistanceBins?: number | null;
  oiChangePct?: number | null;
  betaBtc?: number | null;
  // 24 Okt 2026: status eksplisit per metrik. "·" tanpa alasan membuat
  // operator tidak bisa membedakan "metrik tak tersedia" dari "komputasi
  // mati". Kolom kini menampilkan ringkasan status jujur saat nilainya null.
  erStatus?: MetricStatus | null;
  oiStatus?: MetricStatus | null;
  oiReason?: string | null;
  betaStatus?: MetricStatus | null;
  betaReason?: string | null;
  knnN?: number | null;
  knnLabel?: string | null;
}

/** Status komputasi satu metrik persepsi (mirrors server PerceptionStatus). */
export type MetricStatus = "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED";

/** Placeholder netral untuk sel tanpa nilai (TEMA B: tanpa em dash). */
const DOT = "·";

/**
 * Ringkasan jujur untuk sel metrik yang tidak punya nilai.
 * Sengaja TIDAK mengarang angka dan TIDAK menyembunyikan status, hanya
 * memberi label singkat yang bisa dibaca operator.
 */
function metricFallback(
  status: MetricStatus | null | undefined,
  reason?: string | null
): { text: string; title: string } {
  switch (status) {
    case "OK":
      return { text: DOT, title: "Nilai tersedia tetapi nol/kosong" };
    case "FETCH_FAILED":
      return { text: "n/a", title: `Data tidak dapat diambil (${reason ?? "fetch gagal"})` };
    case "INSUFFICIENT_SAMPLES":
      return { text: "n/a", title: `Data kurang untuk perhitungan (${reason ?? "butuh lebih banyak sampel"})` };
    case "NO_DATA":
      return { text: "n/a", title: `Tidak ada data (${reason ?? "sumber tidak tersedia"})` };
    default:
      return { text: DOT, title: "Status tidak dilaporkan" };
  }
}

interface Props {
  candidates: CandidateItem[];
  onTrade: (symbol: string) => void;
}

export function ScannerCandidatesTable({ candidates, onTrade }: Props) {
  // Virtualizer TanStack butuh scroll container terukur: saat SSR (render
  // statis, mis. test) highet-nya 0 sehingga TIDAK ada baris yang dirender.
  // Aktifkan virtual hanya SETELAH mount di browser; sebelum itu tabel
  // dirender normal supaya isi tetap terlihat di SSR & non-JS.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Jaga agar definisi kolom STABIL antar-render: MarketsPage meng-render
  // ulang tiap tick SSE, dan onTrade dibuat ulang tiap render.
  const onTradeRef = useRef(onTrade);
  onTradeRef.current = onTrade;

  const columns = useMemo<ColumnDef<CandidateItem, any>[]>(() => {
    // Tooltip sel: title menempel pada isi sel (bukan <td>), dibuat selebar
    // sel supaya area hover tetap sama seperti versi <table> lama.
    const tip = (title: string, node: React.ReactNode) => (
      <span title={title} style={{ display: "inline-block", width: "100%", textAlign: "inherit" }}>{node}</span>
    );

    return [
      {
        id: "symbol", header: "SIMBOL", accessorFn: (c) => c.symbol,
        cell: ({ row }) => (
          <span style={{ fontWeight: 700, fontSize: 12.5, color: colors.textStrong, fontFamily: fonts.mono }}>
            {row.original.symbol}
          </span>
        ),
      },
      {
        id: "arah", header: "ARAH", accessorFn: (c) => ((c.trendScore ?? 50) >= 50 ? 1 : 0),
        cell: ({ row }) => {
          const isLong = (row.original.trendScore ?? 50) >= 50;
          return (
            <span style={{ fontWeight: 700, color: isLong ? colors.up : colors.down, fontFamily: fonts.mono }}>
              {isLong ? "▲ LONG" : "▼ SHORT"}
            </span>
          );
        },
      },
      {
        id: "smc", header: "SMC", meta: { align: "center" },
        accessorFn: (c) => c.zoneScore ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => (
          <span style={{ fontFamily: fonts.mono, color: colors.text }}>{row.original.zoneScore ?? DOT}</span>
        ),
      },
      {
        id: "squeeze", header: "SQUEEZE", meta: { align: "center" },
        accessorFn: (c) => c.triggerScore ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => (
          <span style={{ fontFamily: fonts.mono, color: colors.text }}>{row.original.triggerScore ?? DOT}</span>
        ),
      },
      {
        id: "zlema", header: "ZLEMA", meta: { align: "center" },
        accessorFn: (c) => c.trendScore ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => (
          <span style={{ fontFamily: fonts.mono, color: colors.text }}>{row.original.trendScore ?? DOT}</span>
        ),
      },
      {
        id: "knn", header: "KNN", meta: { align: "right" },
        accessorFn: (c) => c.knnProb ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const c = row.original;
          // 24 Okt 2026: hitung sel sekali supaya nilai & status jujur.
          // KNN: `c.knnProb` 0 adalah nilai SAH (0% win rate dari 5 analog),
          // bukan "tidak ada". Cek lama memakai falsy check sehingga 0%
          // tampil kosong. Sekarang 0% tampil "0%".
          const knnText = c.knnProb != null
            ? `${(c.knnProb * 100).toFixed(0)}%`
            : metricFallback(
                c.knnLabel && c.knnLabel.startsWith("KNN_POOL") && c.knnLabel.endsWith("LT_50")
                  ? "INSUFFICIENT_SAMPLES"
                  : c.knnLabel === "KNN_POOL_NO_MTF" ? "NO_DATA" : null,
                c.knnLabel
              ).text;
          const knnTitle = c.knnProb != null
            ? `Probabilitas win dari ${c.knnN ?? "?"} analog terdekat${c.knnN ? ` (${c.knnN >= 50 ? "cukup bukti" : "di bawah ambang 50"})` : ""}. Bukan probabilitas terkalibrasi.`
            : `KNN tidak punya cukup bukti: ${c.knnLabel ?? "tidak dilaporkan"}`;
          return tip(
            knnTitle,
            <span style={{ fontFamily: fonts.mono, color: c.knnProb != null ? colors.up : colors.textMuted, fontWeight: 700 }}>
              {knnText}
            </span>
          );
        },
      },
      {
        id: "er", header: () => <span title="Kaufman Efficiency Ratio (kualitas tren)">ER</span>,
        meta: { align: "right" },
        accessorFn: (c) => c.er ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const c = row.original;
          const erFb = metricFallback(c.erStatus, null);
          return tip(
            c.er != null ? "Kaufman Efficiency Ratio (30 bar, TF struktur 5m)" : erFb.title,
            <span style={{ fontFamily: fonts.mono, color: c.er != null && c.er >= 0.35 ? colors.up : colors.textMuted }}>
              {c.er != null ? c.er.toFixed(2) : erFb.text}
            </span>
          );
        },
      },
      {
        id: "oi", header: () => <span title="Perubahan Open Interest ~30 menit">OI%</span>,
        meta: { align: "right" },
        accessorFn: (c) => c.oiChangePct ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const c = row.original;
          const oiFb = metricFallback(c.oiStatus, c.oiReason);
          return tip(
            c.oiChangePct != null ? "Perubahan Open Interest ~30 menit (histori 5m Binance)" : oiFb.title,
            <span style={{ fontFamily: fonts.mono, color: c.oiChangePct != null && Math.abs(c.oiChangePct) >= 1 ? colors.warn : colors.textMuted }}>
              {c.oiChangePct != null ? `${c.oiChangePct >= 0 ? "+" : ""}${c.oiChangePct.toFixed(2)}%` : oiFb.text}
            </span>
          );
        },
      },
      {
        id: "beta", header: () => <span title="Beta vs BTC (return log 5m)">BETA</span>,
        meta: { align: "right" },
        accessorFn: (c) => c.betaBtc ?? Number.NEGATIVE_INFINITY,
        cell: ({ row }) => {
          const c = row.original;
          const betaFb = metricFallback(c.betaStatus, c.betaReason);
          return tip(
            c.betaBtc != null ? "Beta vs BTC (return log 5m)" : betaFb.title,
            <span style={{ fontFamily: fonts.mono, color: colors.textMuted }}>
              {c.betaBtc != null ? c.betaBtc.toFixed(2) : betaFb.text}
            </span>
          );
        },
      },
      {
        id: "skor", header: "SKOR", meta: { align: "right" }, accessorFn: (c) => c.score,
        cell: ({ row }) => {
          const s = row.original.score;
          return <span style={badge(s >= 75 ? colors.upBg : colors.warnBg, s >= 75 ? colors.up : colors.warn)}>{s}</span>;
        },
      },
      {
        id: "regime", header: "REGIME", accessorFn: (c) => c.regime,
        cell: ({ row }) => (
          <span style={{ color: colors.textMuted, fontSize: 10.5, fontFamily: fonts.mono }}>{row.original.regime}</span>
        ),
      },
      {
        id: "status", header: "STATUS", meta: { align: "center" }, enableSorting: false,
        accessorFn: (c) => c.status || "READY",
        cell: ({ row }) => {
          const st = row.original.status || "READY";
          // READY = cyan (aktif), NO_DATA = merah (gagal), sisanya netral.
          const tone = st === "READY"
            ? { bg: colors.upBg, fg: colors.up }
            : st === "NO_DATA"
              ? { bg: colors.downBg, fg: colors.down }
              : { bg: colors.bgInput, fg: colors.textMuted };
          return <span style={badge(tone.bg, tone.fg)}>{st}</span>;
        },
      },
      {
        id: "aksi", header: "AKSI", meta: { align: "center" }, enableSorting: false,
        cell: ({ row }) => (
          <button
            onClick={(e) => { e.stopPropagation(); onTradeRef.current(row.original.symbol); }}
            title="Buka setup trade untuk pair ini"
            style={{
              fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 2, cursor: "pointer",
              fontFamily: fonts.main, background: colors.accentSoft, color: colors.accent,
              border: `1px solid ${colors.borderLight}`,
            }}
          >
            TRADE
          </button>
        ),
      },
    ];
  }, []);

  return (
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={cardHead}>
        <span>KANDIDAT SETUP LIVE MARKET SCANNER & KONFLUENSI AI</span>
        <span style={{ fontSize: 10, fontFamily: fonts.mono, color: colors.textMuted }}>
          KANDIDAT: {candidates.length}
        </span>
      </div>
      <div
        style={{
          padding: "8px 12px 0", fontSize: 9.5, fontFamily: fonts.mono, fontWeight: 500,
          letterSpacing: "0.12em", color: colors.textDim, textTransform: "uppercase",
        }}
      >
        KONFLUENSI AI + ER + OI + BETA-BTC (SWING 1h)
      </div>
      {/* Virtual aktif setelah mount: scan bisa menghasilkan banyak kandidat,
          tabel di-virtualize dengan tinggi maksimum 460px. Sebelum mount
          (SSR / render statis) tabel dirender penuh agar isi tidak hilang. */}
      <DataTable
        columns={columns}
        data={candidates}
        virtual={mounted}
        maxHeight={460}
        emptyText="Pemindai aktif sedang menganalisis seluruh kontrak Binance Futures USDT..."
      />
      <div
        style={{
          padding: "7px 12px", borderTop: `1px solid ${colors.border}`,
          fontSize: 9.5, fontFamily: fonts.mono, color: colors.textDim, letterSpacing: "0.06em",
        }}
      >
        {candidates.length} baris · klik judul kolom untuk mengurutkan
      </div>
    </div>
  );
}
