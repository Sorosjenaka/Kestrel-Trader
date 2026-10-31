// apps/web/src/pages/HeatmapPage.tsx
// MICROSTRUCTURE DASHBOARD — 5 modul order flow real-time via SSE backend.
//
// Panel 1: ORDER FLOW · DETAIL — CVD multi-line, aggression, team read
// Panel 2: WALL LIFELINES — lifecycle wall L2, depth profile, events
// Panel 3: LIQUIDATION MAP · ±15% — histogram likuidasi HL on-chain / Vike
// Panel 4: LARGE TRADES FEED + VOLUME PROFILE — tape besar & profil volume
// Panel 5: TIER & FLOW — imbalance per tier, delta per exchange, divergence
//
// Aturan mutlak: 100% data dari SSE backend (bukan browser REST ke exchange).
// Semua chart digambar tangan di canvas (tanpa recharts/d3/chart.js).
// Tema: operator terminal ArtaTrade (--canvas #0B0C10, monospace tabular).
//
// 24 Okt 2026 — REWRITE DAPATABILITY (permintaan operator: "sulit dibaca,
// angka tidak kelihatan") + PERFORMA (hilang 2 loop requestAnimationFrame
// tak berujung; chart kini digambar ulang HANYA saat data berubah).
//
// Yang diperbaiki di rewrite ini:
//   1. Font dinaikkan: sumbu 9px -> 11px, label 9.5/10px -> 11/12px,
//      nilai utama 19px -> 22px. Angka tabular rata kanan.
//   2. LEGEND untuk setiap chart. Sebelumnya 7 garis CVD tanpa keterangan
//      sama sekali — mustahil dibaca.
//   3. Sumbu waktu (HH:MM) + sumbu nilai ($) + garis nol + sumbu harga kedua.
//   4. Tooltip hover (crosshair) — nilai persis di kursor, bukan tebakan.
//   5. Divergence table kolom kosong diperbaiki: field API sebenarnya
//      buyerExchange/sellerExchange/spreadUsd (bukan exchangeA/exchangeB/note).
//   6. topLongClustersBelow / topShortClustersAbove kini ditampilkan.
//   7. Loop rAF tak berujung dihapus: render hanya saat data berubah
//      (rAF 60x/detik sebelumnya membakar CPU walau data 1.5 detik).
//   8. Polling REST & SSE dijeda saat tab browser tidak terlihat.

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { noDashText } from "../lib/textDash.js";
import { Panel, Badge, Select, PageHead } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import {
  fmtUsd, fmtUsdFull, fmtSigned, fmtPrice, fmtPct, hhmmss, hhmm, signColor,
  KeyRow, DivergenceTable, ClusterColumns, LiqCumTable, TH, TD, TD_R, TH_R,
} from "./heatmapTables.js";

/**
 * 29 Okt 2026 (tahap 3 redesign Tema B) — palet chart kanvas.
 *
 * Token hex WAJIB (HERMES_PROMPT bagian 4): profit/naik = cyan #3AA8F2,
 * loss/turun = merah #F2414A, aksen merah #E0222C, peringatan #D0628A.
 * HIJAU DILARANG. Warna lama (#6ee7b7 / #ff6b6b / #4fc3f7 / #ef5350 /
 * #f3c969) diganti ke palet tema B di bawah.
 *
 * "Harga" (sumbu kanan, sebelumnya kuning) memakai warn #D0628A — tetap
 * berbeda dari cyan/merah agar tidak tertukar dengan arah.
 */
const CHART = {
  bg: "#080A17",          // = colors.bgPanel
  grid: "#161727",        // = colors.border
  gridSoft: "#111427",    // = colors.bgInput
  axisText: "#5C6890",    // = colors.textDim
  axisTextStrong: "#97A7D0", // = colors.textMuted
  zero: "#262A44",        // = colors.borderLight
  price: "#D0628A",       // = colors.warn — garis harga (sumbu kanan)
  priceDim: "#7A4E63",    // warn redup untuk label sumbu harga
  up: "#3AA8F2",          // = colors.up (cyan) — BID / beli / profit
  down: "#F2414A",        // = colors.down — ASK / jual / loss
  upFill: "rgba(58,168,242,0.42)",
  downFill: "rgba(242,65,74,0.42)",
  upFillSoft: "rgba(58,168,242,0.62)",
  downFillSoft: "rgba(242,65,74,0.62)",
  liqLong: "#F2414A",     // long dilikuidasi = merah
  liqShort: "#3AA8F2",    // short dilikuidasi = cyan
  liqLongFill: "rgba(242,65,74,0.72)",
  liqShortFill: "rgba(58,168,242,0.72)",
  neutral: "#9AB2E4",     // = colors.sand — VAH/VAL, marker netral
  neutralDim: "#5C6890",
} as const;

/** Warna cadangan per exchange (dipakai bila seri tidak membawa warna).
 *  Backend mengirim warna sendiri; ini hanya cadangan agar legend tetap
 *  terbaca. Palet tema B, tanpa hijau. */
const EXCHANGE_FALLBACK: Record<string, string> = {
  BINANCE: "#F0B90B",
  BYBIT: "#F7931A",
  OKX: "#9AB2E4",
  GATE: "#3AA8F2",
  KUCOIN: "#3AA8F2",
  COINBASE: "#E0222C",
  BITGET: "#D0628A",
  HYPERLIQUID: "#3AA8F2",
};

const SYMBOLS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "WLD", "ZEC"] as const;
type Sym = (typeof SYMBOLS)[number];
type ModuleId = "orderflow" | "walls" | "liquidation" | "trades" | "tierflow";

const MODULE_TABS: { id: ModuleId; label: string; desc: string }[] = [
  { id: "orderflow", label: "ORDER FLOW", desc: "Delta agresif (CVD) gabungan 10 venue, bandingkan dengan harga." },
  { id: "walls", label: "WALL LIFELINES", desc: "Dinding likuiditas: muncul → geser → ditarik → dimakan." },
  { id: "liquidation", label: "LIQ MAP", desc: "Peta likuidasi ±15% di sekitar mark price." },
  { id: "trades", label: "LARGE TRADES + VP", desc: "Transaksi besar (tape) + profil volume 1 jam." },
  { id: "tierflow", label: "TIER & FLOW", desc: "Ketidakseimbangan per tier & antar exchange." },
];

// ── Hooks data ──────────────────────────────────────────────────────────────

/** SSE live. Terputus saat tab disembunyikan (hemat CPU), menyambung lagi
 *  saat tab terlihat kembali.
 *
 *  24 Okt 2026 — fallback REST. Backend & frontend sekarang di-deploy
 *  BERBEDA (frontend duluan, backend masih build lama), sehingga route
 *  "stream" belum tentu ada di server yang sedang jalan. Kalau SSE
 *  gagal, hook ini otomatis polling endpoint REST yang setara (payload-nya
 *  identik — keduanya memanggil producer yang sama di backend), lalu
 *  otomatis kembali ke SSE begitu backend-nya sudah punya route stream.
 *  Tanpa ini, panel LIQ MAP / LARGE TRADES + VP / TIER & FLOW kosong total
 *  selama backend belum di-restart. */
function useSse<T>(path: string, restFallback?: string): { data: T | null; stale: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(true);
  const lastAt = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let restTimer: ReturnType<typeof setTimeout> | null = null;
    let restBusy = false;
    let paused = document.visibilityState === "hidden";

    const stopRest = () => {
      if (restTimer) { clearTimeout(restTimer); restTimer = null; }
      restBusy = false;
    };

    /** Mulai fallback REST bila belum jalan (SSE putus ATAU stream error). */
    const ensureRest = () => {
      if (restFallback && !restTimer && alive && !paused) pollRest();
    };

    /** Polling REST — hanya jalan kalau SSE tidak bisa konek. */
    const pollRest = () => {
      if (!alive || paused || !restFallback) return;
      if (restBusy) return;
      restBusy = true;
      fetch(restFallback)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json) => {
          if (!alive) return;
          setData(json);
          lastAt.current = Date.now();
          setStale(false);
        })
        .catch(() => { /* endpoint REST juga belum ada · coba lagi nanti */ })
        .finally(() => {
          restBusy = false;
          if (alive && !paused) restTimer = setTimeout(pollRest, 4000);
        });
    };

    const connect = () => {
      if (!alive || paused || es) return;
      es = new EventSource(path);
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          // 26 Okt 2026 (TAHAP 3A): frame {type,error} TIDAK boleh dianggap
          // data segar. Error tidak memperbarui timestamp data valid; snapshot
          // valid terakhir dipertahankan dengan status stale, dan fallback
          // REST dijalankan (transport bisa saja hidup sementara sumber error).
          if (msg && msg.error !== undefined) {
            setStale(true);
            if (msg.lastValid && msg.lastValid.data !== undefined) setData(msg.lastValid.data);
            ensureRest();
            return;
          }
          setData(msg.data ?? msg);
          lastAt.current = Date.now();
          setStale(false);
          // SSE hidup lagi (frame data valid) -> hentikan polling REST.
          stopRest();
        } catch { /* skip frame rusak */ }
      };
      es.onerror = () => {
        setStale(true);
        es?.close();
        es = null;
        if (alive && !paused) {
          // Fallback: pakai REST selagi route /stream belum ada di backend.
          ensureRest();
          retry = setTimeout(connect, 3000);
        }
      };
    };
    const disconnect = () => {
      if (retry) { clearTimeout(retry); retry = null; }
      es?.close();
      es = null;
      stopRest();
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") { paused = true; disconnect(); setStale(true); }
      else { paused = false; connect(); }
    };

    if (!paused) connect();
    document.addEventListener("visibilitychange", onVis);

    const w = setInterval(() => {
      if (lastAt.current && Date.now() - lastAt.current > 8000) setStale(true);
    }, 2000);
    return () => {
      alive = false;
      disconnect();
      clearInterval(w);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [path, restFallback]);

  return { data, stale };
}

// CATATAN (24 Okt 2026): hook `useRest` (polling REST periodik) DIHAPUS.
// Seluruh 5 modul mikrostruktur sekarang memakai SSE dari backend
// (orderflow, walls, liquidation-map, large-trades, volume-profile,
// tier-flow) sesuai spesifikasi: "push via SSE, hapus polling REST lambat
// di browser". Polling 3-5 detik per endpoint juga menahan koneksi browser
// dan membuat antrean (6 koneksi per origin) di browser.
//
// Pengecualian: `useSse` sekarang menerima `restFallback` — dipakai HANYA
// saat SSE gagal (route /stream belum ada di backend yang jalan). Setelah
// backend di-restart, polling REST berhenti sendiri dan aliran kembali
// murni SSE.

// ── Canvas helpers ──────────────────────────────────────────────────────────

function setupCanvas(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = cv.clientWidth, cssH = cv.clientHeight;
  if (!cssW || !cssH) return null;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CHART.bg;
  ctx.fillRect(0, 0, cssW, cssH);
  return ctx;
}

/** Isi tooltip. */
type Tip = { x: number; y: number; title?: string; rows: { label: string; value: string; color?: string }[] } | null;

/**
 * Kanvas chart generik.
 *  - Digambar ulang HANYA ketika `redrawKey` berubah (data baru) atau ukuran
 *    kanvas berubah. Tidak ada loop requestAnimationFrame tak berujung.
 *  - Overlay tooltip/anotasi digambar sebagai HTML di atas kanvas supaya
 *    teks tetap tajam (tidak ikut di-rasterisasi canvas).
 */
function ChartCanvas({
  height, redrawKey, draw, tip, onMove, onLeave, footer,
}: {
  height: number;
  redrawKey: string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  tip?: Tip;
  onMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onLeave?: () => void;
  footer?: ReactNode;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const render = () => {
      const ctx = setupCanvas(cv);
      if (!ctx) return;
      drawRef.current(ctx, cv.clientWidth, cv.clientHeight);
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [redrawKey]);

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={cvRef}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        style={{
          width: "100%", height, display: "block",
          borderRadius: 6, border: `1px solid ${colors.border}`,
        }}
      />
      {tip && <ChartTip tip={tip} />}
      {footer}
    </div>
  );
}

/** Tooltip HTML di atas kanvas. */
function ChartTip({ tip }: { tip: NonNullable<Tip> }) {
  const flipX = tip.x > 320;
  return (
    <div
      style={{
        position: "absolute",
        left: flipX ? undefined : tip.x + 14,
        right: flipX ? tip.x + 14 : undefined,
        top: Math.max(4, tip.y - 10),
        pointerEvents: "none",
        background: "rgba(4,5,15,0.96)",
        border: `1px solid ${colors.borderLight}`,
        borderRadius: 6,
        padding: "8px 10px",
        minWidth: 190,
        boxShadow: "0 0 0 1px rgba(224,34,44,.10), 0 30px 80px rgba(0,0,0,.6)",
        zIndex: 5,
      }}
    >
      {tip.title && (
        <div style={{ fontSize: 11, fontWeight: 700, color: colors.textStrong, fontFamily: fonts.mono, marginBottom: 5, letterSpacing: "0.04em" }}>
          {tip.title}
        </div>
      )}
      {tip.rows.map((r, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11.5, fontFamily: fonts.mono, lineHeight: 1.7 }}>
          <span style={{ color: colors.textMuted }}>{r.label}</span>
          <span style={{ color: r.color ?? colors.text, fontWeight: 700 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Komponen UI kecil ───────────────────────────────────────────────────────

function LivePill({ stale, detail }: { stale: boolean; detail?: string }) {
  const bg = stale ? colors.warnBg : colors.upBg;
  const fg = stale ? colors.warn : colors.up;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Badge bg={bg} fg={fg}>{stale ? "STALE" : "LIVE"}</Badge>
      {detail && (
        <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>{detail}</span>
      )}
    </span>
  );
}

/** Kotak angka utama (label kecil di atas, nilai besar mono di bawah). */
function StatTile({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div
      style={{
        flex: 1, minWidth: 132,
        background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 6,
        padding: "9px 12px",
      }}
    >
      <div style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.09em" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? colors.textStrong, fontFamily: fonts.mono, lineHeight: 1.25, marginTop: 2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/** Item legend: kotak warna + nama + nilai live. */
function LegendItem({ color, label, value, valueColor }: { color: string; label: string; value: string; valueColor?: string }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 5,
        padding: "4px 9px", fontSize: 11.5, fontFamily: fonts.mono,
      }}
    >
      <span style={{ width: 11, height: 11, borderRadius: 2, background: color, flex: "0 0 auto", boxShadow: `0 0 6px ${color}55` }} />
      <span style={{ color: colors.textMuted, letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ color: valueColor ?? colors.text, fontWeight: 700 }}>{value}</span>
    </span>
  );
}

// ── Kolom DataTable (tahap 3 redesign Tema B) ──────────────────────────────

/** Tabel agresi taker: window, beli, jual, porsi beli, jumlah trade, rasio. */
const aggressionColumns: ColumnDef<any, any>[] = [
  { accessorKey: "window", header: "Window", cell: (i) => <span style={{ color: colors.text, fontWeight: 700 }}>{i.getValue() as string}</span> },
  { accessorKey: "takerBuyUsd", header: "Beli $", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.up }}>{fmtUsd(i.getValue() as number)}</span> },
  { accessorKey: "takerSellUsd", header: "Jual $", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.down }}>{fmtUsd(i.getValue() as number)}</span> },
  { accessorKey: "buySharePct", header: "Beli %", meta: { align: "right" }, cell: (i) => fmtPct(i.getValue() as number) },
  { accessorKey: "trades", header: "Trade", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.textMuted }}>{i.getValue() as number}</span> },
  { accessorKey: "buySellRatio", header: "Rasio", meta: { align: "right" }, cell: (i) => { const v = i.getValue() as number | null; return <span style={{ color: v != null && v > 1 ? colors.up : colors.down, fontWeight: 700 }}>{v != null ? v.toFixed(2) : "·"}</span>; } },
];

/** Event wall: waktu, jenis event, sisi, harga, notional, jarak, umur. */
const wallEventColumns: ColumnDef<any, any>[] = [
  { accessorKey: "t", header: "Waktu", cell: (i) => <span style={{ color: colors.textMuted }}>{hhmmss(i.getValue() as number)}</span> },
  { accessorKey: "kind", header: "Event", cell: (i) => { const k = String(i.getValue()); return <span style={{ color: k === "eaten" ? CHART.neutral : k === "pulled" ? colors.warn : k === "moved" ? colors.accent : colors.up, fontWeight: 700 }}>{k.toUpperCase()}</span>; } },
  { accessorKey: "side", header: "Sisi", cell: (i) => { const v = String(i.getValue()); return <span style={{ color: v === "BID" ? colors.up : colors.down, fontWeight: 700 }}>{v}</span>; } },
  { accessorKey: "price", header: "Harga", meta: { align: "right" }, cell: (i) => fmtPrice(i.getValue() as number) },
  { accessorKey: "notionalUsd", header: "Notional", meta: { align: "right" }, cell: (i) => fmtUsd(i.getValue() as number) },
  { accessorKey: "distPct", header: "Jarak", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.textMuted }}>{fmtPct(i.getValue() as number, 3)}</span> },
  { accessorKey: "lifeSec", header: "Hidup (dtk)", meta: { align: "right" }, cell: (i) => { const v = i.getValue() as number | null; return <span style={{ color: colors.textMuted }}>{v != null ? v.toFixed(1) : "·"}</span>; } },
];

/** Tape transaksi besar: waktu, venue, sisi, harga, nilai USD. */
const largeTradeColumns: ColumnDef<any, any>[] = [
  { accessorKey: "t", header: "Waktu", cell: (i) => <span style={{ color: colors.textMuted }}>{hhmmss(i.getValue() as number)}</span> },
  { accessorKey: "venue", header: "Venue", cell: (i) => <span style={{ color: colors.text }}>{i.getValue() as string}</span> },
  { accessorKey: "takerSide", header: "Sisi", cell: (i) => { const v = String(i.getValue()); return <span style={{ color: v === "BUY" ? colors.up : colors.down, fontWeight: 700 }}>{v}</span>; } },
  { accessorKey: "price", header: "Harga", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.textMuted }}>{fmtPrice(i.getValue() as number)}</span> },
  { accessorKey: "usd", header: "Nilai $", meta: { align: "right" }, cell: (i) => <span style={{ color: colors.text, fontWeight: 700 }}>{fmtUsd(i.getValue() as number)}</span> },
];

// ── Panel 1: Order Flow ─────────────────────────────────────────────────────

function OrderFlowPanel({ symbol }: { symbol: Sym }) {
  const { data, stale } = useSse<any>(
    `/api/orderflow/${symbol}/stream?window=15m`,
    `/api/orderflow/${symbol}?window=15m`,
  );
  const [tip, setTip] = useState<Tip>(null);
  const geomRef = useRef<{ minT: number; maxT: number; plotL: number; plotW: number } | null>(null);

  const series: { venue: string; color: string; points: { t: number; v: number }[] }[] = data?.series ?? [];
  const priceSeries: { t: number; v: number }[] = data?.priceSeries ?? [];

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!series.length) return;
    const padL = 84, padR = 84, padT = 14, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    let minV = Infinity, maxV = -Infinity, minT = Infinity, maxT = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.v < minV) minV = p.v;
        if (p.v > maxV) maxV = p.v;
        if (p.t < minT) minT = p.t;
        if (p.t > maxT) maxT = p.t;
      }
    }
    for (const p of priceSeries) {
      if (p.t < minT) minT = p.t;
      if (p.t > maxT) maxT = p.t;
    }
    if (!Number.isFinite(minV)) return;
    if (minV > 0) minV = 0;
    if (maxV < 0) maxV = 0;
    const rangeV = maxV - minV || 1;
    const rangeT = maxT - minT || 1;
    const xOf = (t: number) => padL + ((t - minT) / rangeT) * plotW;
    const yOf = (v: number) => padT + plotH - ((v - minV) / rangeV) * plotH;
    geomRef.current = { minT, maxT, plotL: padL, plotW };

    // ── Grid horizontal + label nilai ($) di kiri ──────────────────────────
    ctx.strokeStyle = CHART.grid; ctx.lineWidth = 1;
    ctx.font = `11px ${fonts.mono}`;
    ctx.textBaseline = "middle";
    const GRID = 5;
    for (let i = 0; i <= GRID; i++) {
      const v = maxV - (rangeV / GRID) * i;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = CHART.axisText;
      ctx.textAlign = "right";
      ctx.fillText(fmtUsd(v), padL - 8, y);
    }

    // ── Grid vertikal + label waktu (HH:MM) di bawah ───────────────────────
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const TICKS = 6;
    for (let i = 0; i <= TICKS; i++) {
      const t = minT + (rangeT / TICKS) * i;
      const x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = CHART.gridSoft;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = CHART.axisText;
      ctx.fillText(hhmm(t), x, padT + plotH + 8);
    }

    // ── Garis nol ──────────────────────────────────────────────────────────
    if (minV < 0 && maxV > 0) {
      const zy = Math.round(yOf(0)) + 0.5;
      ctx.strokeStyle = CHART.zero; ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + plotW, zy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CHART.axisTextStrong; ctx.font = `10px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("0", padL + 4, zy - 2);
    }

    // ── Overlay harga (sumbu kanan, kuning) ───────────────────────────────
    if (priceSeries.length > 1) {
      let pMin = Infinity, pMax = -Infinity;
      for (const p of priceSeries) { if (p.v < pMin) pMin = p.v; if (p.v > pMax) pMax = p.v; }
      const pRange = pMax - pMin || 1;
      const yPrice = (v: number) => padT + plotH - ((v - pMin) / pRange) * plotH;
      ctx.strokeStyle = CHART.price; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let i = 0; i < priceSeries.length; i++) {
        const x = xOf(priceSeries[i]!.t), y = yPrice(priceSeries[i]!.v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
      // label harga di kanan
      ctx.fillStyle = CHART.price; ctx.font = `11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const v of [pMax, (pMax + pMin) / 2, pMin]) {
        ctx.fillText(fmtPrice(v), padL + plotW + 8, yPrice(v));
      }
      ctx.textAlign = "center";
      ctx.fillStyle = CHART.priceDim; ctx.font = `10px ${fonts.mono}`; ctx.textBaseline = "top";
      ctx.fillText("HARGA", padL + plotW + 30, padT);
    }

    // ── Garis CVD ──────────────────────────────────────────────────────────
    ctx.lineJoin = "round";
    for (const s of series) {
      if (s.points.length < 2) continue;
      const isAll = s.venue === "ALL";
      const isAgg = s.venue === "SPOT Σ" || s.venue === "PERP Σ";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = isAll ? 2.5 : isAgg ? 1.2 : 1.6;
      ctx.globalAlpha = isAll ? 1 : isAgg ? 0.7 : 0.92;
      ctx.setLineDash(isAgg ? [4, 3] : []);
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const x = xOf(s.points[i]!.t), y = yOf(s.points[i]!.v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Label nama seri di ujung kanan garis (hanya ALL & 4 venue utama).
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = `bold 11px ${fonts.mono}`;
    for (const s of series) {
      if (s.venue === "SPOT Σ" || s.venue === "PERP Σ") continue;
      if (!s.points.length) continue;
      const last = s.points[s.points.length - 1]!;
      ctx.fillStyle = s.color;
      ctx.fillText(s.venue, Math.min(xOf(last.t) + 6, w - 26), yOf(last.v));
    }
  }, [series, priceSeries]);

  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget;
    const g = geomRef.current;
    if (!g || !series.length) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < g.plotL || mx > g.plotL + g.plotW) { setTip(null); return; }
    const t = g.minT + ((mx - g.plotL) / g.plotW) * (g.maxT - g.minT);

    const rows: { label: string; value: string; color?: string }[] = [];
    for (const s of series) {
      if (!s.points.length) continue;
      let best = s.points[0]!, bd = Infinity;
      for (const p of s.points) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
      rows.push({ label: s.venue, value: fmtSigned(best.v), color: signColor(best.v) });
    }
    if (priceSeries.length) {
      let best = priceSeries[0]!, bd = Infinity;
      for (const p of priceSeries) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
      rows.push({ label: "Harga", value: fmtPrice(best.v), color: CHART.price });
    }
    setTip({ x: mx, y: my, title: `Waktu ${hhmm(t)} UTC`, rows });
  }, [series, priceSeries]);

  const agg: any[] = data?.aggression ?? [];
  const tr: any[] = data?.teamRead ?? [];
  // 25 Okt 2026 — FIX kartu "AKSI BELI 1M": sebelumnya mengambil baris
  // TERAKHIR array aggression, yaitu window 1H (aggressionRows diurutkan
  // 1M, 5M, 15M, 1H). Akibatnya kartu berlabel 1M menampilkan angka 1 jam
  // dan tidak cocok dengan baris 1M di tabel agresi. Sekarang mengambil
  // baris 1M yang sebenarnya.
  const lastAgg =
    agg.find((r: any) => r.window === "1M") ?? (agg.length ? agg[agg.length - 1] : null);
  const cvd = data?.cvd;

  // Nilai live tiap seri = titik terakhir (CVD kumulatif terkini).
  const legendItems = series.map((s) => {
    const last = s.points.length ? s.points[s.points.length - 1]!.v : null;
    return { venue: s.venue, color: s.color, value: last == null ? "·" : fmtSigned(last) };
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: colors.text, fontFamily: fonts.mono, letterSpacing: "0.06em", fontWeight: 700 }}>
          1 · ORDER FLOW · {symbol} · {data?.venuesTrading ?? "?"}/{data?.venuesExpected ?? "?"} venue aktif
        </span>
        <LivePill stale={stale} detail={data ? `riwayat ${data.historyMinutes}m` : undefined} />
      </div>

      {/* Ringkasan angka utama */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <StatTile label="Δ TOTAL 15M" value={fmtSigned(cvd?.allVenues ?? 0)} sub="agresif net 10 venue" color={signColor(cvd?.allVenues ?? 0)} />
        <StatTile label="Δ SPOT" value={fmtSigned(cvd?.spotSum ?? 0)} sub="taker spot" color={signColor(cvd?.spotSum ?? 0)} />
        <StatTile label="Δ PERP" value={fmtSigned(cvd?.perpSum ?? 0)} sub="taker perpetual" color={signColor(cvd?.perpSum ?? 0)} />
        <StatTile
          label="AKSI BELI 1M"
          value={lastAgg?.buySharePct != null ? `${lastAgg.buySharePct.toFixed(1)}%` : "·"}
          sub={`${lastAgg?.trades ?? "·"} trade / menit`}
          color={(lastAgg?.buySharePct ?? 50) >= 50 ? colors.up : colors.down}
        />
      </div>

      {/* Legend · tanpa ini chart tidak bisa dibaca sama sekali */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {legendItems.map((it) => (
          <LegendItem
            key={it.venue}
            color={it.color}
            label={it.venue}
            value={it.value}
            valueColor={it.value.startsWith("+") ? colors.up : it.value.startsWith("-") ? colors.down : colors.textMuted}
          />
        ))}
        <LegendItem color={CHART.price} label="HARGA" value="sumbu kanan" valueColor={colors.warn} />
      </div>

      <ChartCanvas
        height={280}
        redrawKey={`of-${symbol}-${data?.generatedAt ?? 0}`}
        draw={draw}
        tip={tip}
        onMove={onMove}
        onLeave={() => setTip(null)}
      />

      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 6 }}>
        Arahkan kursor ke grafik untuk melihat angka persis di titik itu. Garis putih = gabungan semua venue.
      </div>

      {/* Tabel agresi */}
      <div style={{ marginTop: 12 }}>
        <DataTable
          columns={aggressionColumns}
          data={agg}
          maxHeight={320}
          emptyText="Belum ada data agresi untuk jendela ini."
        />
      </div>

      {/* Team read */}
      {tr.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          {tr.map((r: any) => (
            <div key={r.timeframe} style={{ flex: "1 1 260px", padding: "10px 12px", background: colors.bgInput, borderRadius: 6, border: `1px solid ${colors.border}` }}>
              <div style={{ color: colors.textStrong, fontWeight: 700, fontSize: 12, fontFamily: fonts.mono, marginBottom: 6 }}>TIMEFRAME {r.timeframe}</div>
              <KeyRow label="Δ harga" value={fmtPct(r.priceChangePct, 3)} color={signColor(r.priceChangePct ?? 0)} />
              <KeyRow label="CVD gabungan" value={fmtSigned(r.allVenueCvdDelta)} color={signColor(r.allVenueCvdDelta)} />
              <KeyRow label="CVD spot" value={fmtSigned(r.spotCvd)} color={signColor(r.spotCvd)} />
              <KeyRow label="CVD perp" value={fmtSigned(r.perpCvd)} color={signColor(r.perpCvd)} />
              <KeyRow label="Struktur" value={`${r.engineStructure?.label ?? "·"} · ${r.flowVsPrice}`} color={colors.text} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel 2: Wall Lifelines ─────────────────────────────────────────────────

function WallLifelinesPanel({ symbol }: { symbol: Sym }) {
  const { data, stale } = useSse<any>(
    `/api/walls/${symbol}/stream`,
    `/api/walls/${symbol}`,
  );
  const [tip, setTip] = useState<Tip>(null);
  const depthRef = useRef<any[]>([]);
  const geomRef = useRef<{ minPx: number; maxPx: number; padL: number; plotH: number; padT: number } | null>(null);

  const depths: any[] = data?.depth ?? [];

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!depths.length) return;
    const padL = 96, padR = 96, padT = 16, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    const maxScaled = Math.max(...depths.map((d) => d.scaled), 1);
    const minPx = Math.min(...depths.map((d) => d.price));
    const maxPx = Math.max(...depths.map((d) => d.price));
    const rangePx = maxPx - minPx || 1;
    const yOf = (p: number) => padT + plotH - ((p - minPx) / rangePx) * plotH;
    geomRef.current = { minPx, maxPx, padL, plotH, padT };

    // Sumbu harga di kiri.
    ctx.font = `11px ${fonts.mono}`; ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i++) {
      const p = minPx + (rangePx / 5) * i;
      const y = Math.round(yOf(p)) + 0.5;
      ctx.strokeStyle = CHART.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = CHART.axisText; ctx.textAlign = "right";
      ctx.fillText(fmtPrice(p), padL - 10, y);
    }

    // Sumbu $ notional di kanan (panjang bar = √$).
    const maxNotional = Math.max(...depths.map((d) => d.notionalUsd ?? 0), 1);
    ctx.textAlign = "left"; ctx.fillStyle = CHART.axisText;
    for (let i = 0; i <= 2; i++) {
      const v = maxNotional * (1 - i / 2);
      ctx.fillText(fmtUsd(v), padL + plotW + 10, padT + (plotH / 2) * i);
    }
    ctx.fillStyle = CHART.priceDim; ctx.font = `10px ${fonts.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("NOTIONAL", padL + plotW + 40, padT);

    // Bar bids (kiri) & asks (kanan).
    const halfW = plotW / 2;
    for (const d of depths) {
      const y = yOf(d.price);
      const barW = (d.scaled / maxScaled) * (halfW - 12);
      const x = d.side === "BID" ? padL + halfW - barW : padL + halfW;
      ctx.fillStyle = d.side === "BID" ? CHART.upFill : CHART.downFill;
      ctx.fillRect(x, y - 1.5, barW, 3);
      if (d.isWall) {
        const eaten = d.state === "EATEN", pulled = d.state === "PULLED";
        ctx.fillStyle = eaten ? CHART.neutral : pulled ? CHART.price : CHART.up;
        ctx.font = `bold 12px ${fonts.mono}`;
        ctx.textAlign = d.side === "BID" ? "right" : "left";
        ctx.textBaseline = "middle";
        const tx = d.side === "BID" ? x - 6 : x + barW + 6;
        ctx.fillText(eaten || pulled ? "×" : "◆", tx, y);
      }
    }

    // Garis mid.
    const mid = data?.mid;
    if (mid) {
      const midY = Math.round(yOf(mid)) + 0.5;
      ctx.strokeStyle = CHART.price; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, midY); ctx.lineTo(padL + plotW, midY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CHART.price; ctx.font = `bold 11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText(`mid ${fmtPrice(mid)}`, padL + 6, midY - 4);
    }

    // Label sisi.
    ctx.font = `bold 11px ${fonts.mono}`; ctx.textBaseline = "top";
    ctx.fillStyle = colors.up; ctx.textAlign = "right";
    ctx.fillText("◀ BID (beli)", padL + halfW - 10, padT + plotH + 8);
    ctx.fillStyle = colors.down; ctx.textAlign = "left";
    ctx.fillText("ASK (jual) ▶", padL + halfW + 10, padT + plotH + 8);
  }, [depths, data?.mid]);

  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g || !depths.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const mx = e.clientX - rect.left;
    // Cari level harga terdekat secara vertikal.
    let best: any = null, bd = Infinity;
    for (const d of depths) {
      const y = g.padT + g.plotH - ((d.price - g.minPx) / (g.maxPx - g.minPx || 1)) * g.plotH;
      const dist = Math.abs(y - my);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (!best || bd > 8) { setTip(null); return; }
    const rows: { label: string; value: string; color?: string }[] = [
      { label: "Sisi", value: best.side === "BID" ? "BID (beli)" : "ASK (jual)", color: best.side === "BID" ? colors.up : colors.down },
      { label: "Notional", value: fmtUsdFull(best.notionalUsd), color: colors.text },
    ];
    if (best.isWall) {
      rows.push({ label: "Wall", value: best.state ?? "ACTIVE", color: best.state === "EATEN" ? CHART.neutral : best.state === "PULLED" ? colors.warn : CHART.up });
    }
    setTip({ x: mx, y: my, title: fmtPrice(best.price), rows });
  }, [depths]);

  const s = data?.summary;
  const events: any[] = (data?.events ?? []).slice(0, 20);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: colors.text, fontFamily: fonts.mono, letterSpacing: "0.06em", fontWeight: 700 }}>
          2 · WALL LIFELINES · {symbol} · {data?.venue ?? "BINANCE_PERP"}
        </span>
        <LivePill stale={stale} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <StatTile label="WALL AKTIF" value={String(s?.active ?? 0)} color={colors.textStrong} />
        <StatTile label="MUNCUL" value={String(s?.appeared ?? 0)} sub="total event" color={colors.up} />
        <StatTile label="DITARIK" value={String(s?.pulled ?? 0)} sub={fmtUsd(s?.totalPulledUsd ?? 0)} color={colors.warn} />
        <StatTile label="DIMAKAN" value={String(s?.eaten ?? 0)} sub={fmtUsd(s?.totalEatenUsd ?? 0)} color={CHART.neutral} />
        <StatTile
          label="TERBESAR AKTIF"
          value={fmtUsd(s?.largestActiveUsd ?? 0)}
          sub={s?.largestActiveSide ? `${s.largestActiveSide} @ ${fmtPrice(s.largestActivePrice)}` : "·"}
          color={s?.largestActiveSide === "BID" ? colors.up : s?.largestActiveSide === "ASK" ? colors.down : colors.textStrong}
        />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <LegendItem color={CHART.up} label="◆ WALL AKTIF" value="belum hilang" valueColor={CHART.up} />
        <LegendItem color={CHART.price} label="× DITARIK" value="wall hilang" valueColor={colors.warn} />
        <LegendItem color={CHART.neutral} label="× DIMAKAN" value="terEksekusi" valueColor={CHART.neutral} />
        <LegendItem color={CHART.up} label="BAR BID" value="bids" valueColor={colors.up} />
        <LegendItem color={CHART.down} label="BAR ASK" value="asks" valueColor={colors.down} />
      </div>

      <ChartCanvas
        height={240}
        redrawKey={`wl-${symbol}-${data?.updatedAt ?? 0}`}
        draw={draw}
        tip={tip}
        onMove={onMove}
        onLeave={() => setTip(null)}
      />

      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 6 }}>
        Panjang bar sebanding dengan √(notional $) supaya dinding besar tidak menutupi yang kecil. Arahkan kursor untuk angka detail.
      </div>

      {events.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={wallEventColumns}
            data={events}
            maxHeight={320}
            emptyText="Belum ada event wall."
          />
        </div>
      )}
    </div>
  );
}

// ── Panel 3: Liquidation Map ────────────────────────────────────────────────

function LiquidationMapPanel({ symbol }: { symbol: Sym }) {
  const { data, stale } = useSse<any>(
    `/api/liquidation-map/${symbol}/stream`,
    `/api/liquidation-map/${symbol}`,
  );
  const [tip, setTip] = useState<Tip>(null);
  const binsRef = useRef<any[]>([]);
  const geomRef = useRef<{ bins: any[]; padL: number; plotW: number; maxVal: number; padT: number; plotH: number } | null>(null);

  const bins: any[] = data?.bins ?? [];

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!bins.length) return;
    const padL = 92, padR = 20, padT = 16, padB = 40;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    const maxVal = Math.max(...bins.map((b) => Math.max(b.longUsd, b.shortUsd)), 1);
    const barW = plotW / bins.length;
    const midY = padT + plotH / 2;
    geomRef.current = { bins, padL, plotW, maxVal, padT, plotH };

    // Sumbu $ di kiri (atas = short, bawah = long).
    ctx.font = `11px ${fonts.mono}`; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const v = maxVal * (1 - i / 2);
      const y = padT + (plotH / 2) * i;
      ctx.fillStyle = CHART.axisText;
      ctx.fillText(fmtUsd(v), padL - 10, y);
    }
    ctx.fillStyle = CHART.axisText; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("NOTIONAL", 6, padT - 2);

    // Bar per bin: short ke atas, long ke bawah.
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i]!;
      const x = padL + i * barW;
      const longH = (b.longUsd / maxVal) * (plotH / 2);
      ctx.fillStyle = CHART.liqLongFill;
      ctx.fillRect(x, midY, Math.max(1, barW - 1), longH);
      const shortH = (b.shortUsd / maxVal) * (plotH / 2);
      ctx.fillStyle = CHART.liqShortFill;
      ctx.fillRect(x, midY - shortH, Math.max(1, barW - 1), shortH);
    }

    // Garis tengah (mark).
    ctx.strokeStyle = CHART.zero; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, Math.round(midY) + 0.5); ctx.lineTo(padL + plotW, Math.round(midY) + 0.5); ctx.stroke();

    // Garis mark price.
    if (data?.markPrice) {
      // Mark di tengah histogram (pita ±15% di sekitar mark).
      const mx = padL + plotW / 2;
      ctx.strokeStyle = CHART.price; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CHART.price; ctx.font = `bold 11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`mark ${fmtPrice(data.markPrice)}`, Math.min(mx + 6, w - 110), padT);
    }

    // Sumbu harga di bawah (5 label).
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = `11px ${fonts.mono}`;
    const step = Math.max(1, Math.floor(bins.length / 5));
    for (let i = 0; i < bins.length; i += step) {
      const b = bins[i]!;
      const x = padL + i * barW + barW / 2;
      ctx.fillStyle = CHART.axisText;
      ctx.fillText(fmtPrice(b.price), x, padT + plotH + 8);
    }
    ctx.fillStyle = CHART.neutralDim; ctx.font = `10px ${fonts.mono}`;
    ctx.textAlign = "left"; ctx.fillText("-15% (bawah mark)", padL, padT + plotH + 26);
    ctx.textAlign = "right"; ctx.fillText("+15% (atas mark)", padL + plotW, padT + plotH + 26);
  }, [bins, data?.markPrice]);

  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g || !g.bins.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const barW = g.plotW / g.bins.length;
    const idx = Math.floor((mx - g.padL) / barW);
    if (idx < 0 || idx >= g.bins.length) { setTip(null); return; }
    const b = g.bins[idx]!;
    setTip({
      x: mx, y: my,
      title: `Harga ${fmtPrice(b.price)} (${fmtPct(b.distPct, 2)} dari mark)`,
      rows: [
        { label: "LONG dilikuidasi", value: fmtUsdFull(b.longUsd), color: CHART.liqLong },
        { label: "SHORT dilikuidasi", value: fmtUsdFull(b.shortUsd), color: CHART.liqShort },
        { label: "Total", value: fmtUsdFull((b.longUsd ?? 0) + (b.shortUsd ?? 0)), color: colors.text },
      ],
    });
  }, []);

  const cum: any[] = data?.cum ?? [];
  const below: any[] = data?.topLongClustersBelow ?? [];
  const above: any[] = data?.topShortClustersAbove ?? [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: colors.text, fontFamily: fonts.mono, letterSpacing: "0.06em", fontWeight: 700 }}>
          3 · LIQ MAP · ±15% · {symbol} · sumber: {data?.source ?? "·"}
        </span>
        <LivePill
          stale={stale || (data?.stale ?? true)}
          detail={data?.magnetDirection && data.magnetDirection !== "NONE" ? `magnet ${data.magnetDirection === "UP" ? "▲ ATAS" : "▼ BAWAH"}` : undefined}
        />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <StatTile label="MARK PRICE" value={fmtPrice(data?.markPrice ?? null)} sub={data?.updatedAt ? `update ${hhmmss(data.updatedAt)}` : "·"} color={colors.warn} />
        <StatTile label="OPEN POSISI" value={data?.openPositions != null ? String(data.openPositions) : "·"} sub={data?.openValueUsd != null ? fmtUsd(data.openValueUsd) : "·"} />
        <StatTile
          label="MAGNET"
          value={data?.magnetDirection === "UP" ? "▲ ATAS" : data?.magnetDirection === "DOWN" ? "▼ BAWAH" : "·"}
          sub="sisi dengan likuidasi terbesar"
          color={data?.magnetDirection === "UP" ? colors.up : data?.magnetDirection === "DOWN" ? colors.down : colors.textMuted}
        />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <LegendItem color={CHART.liqLong} label="MERAH (BAWAH MARK)" value="LONG dilikuidasi" valueColor={CHART.liqLong} />
        <LegendItem color={CHART.liqShort} label="CYAN (ATAS MARK)" value="SHORT dilikuidasi" valueColor={CHART.liqShort} />
        <LegendItem color={CHART.price} label="MARK PRICE" value="mark price" valueColor={colors.warn} />
      </div>

      <ChartCanvas
        height={230}
        redrawKey={`liq-${symbol}-${data?.updatedAt ?? 0}`}
        draw={draw}
        tip={tip}
        onMove={onMove}
        onLeave={() => setTip(null)}
      />

      <div style={{ fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 6, lineHeight: 1.6 }}>
        Di bawah mark = LONG dilikuidasi (harga turun). Di atas mark = SHORT dilikuidasi (harga naik). Arahkan kursor ke bar untuk angka per bin.
      </div>

      {/* Kumulatif per pita */}
      <LiqCumTable cum={cum} />

      {/* Cluster teratas · sebelumnya tidak pernah ditampilkan */}
      <ClusterColumns below={below} above={above} />

      {data?.note && <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 8, fontFamily: fonts.mono }}>{data.note}</div>}
    </div>
  );
}

// ── Panel 4: Large Trades + Volume Profile ──────────────────────────────────

function LargeTradesVolumePanel({ symbol }: { symbol: Sym }) {
  const trades = useSse<any>(
    `/api/large-trades/stream?symbol=${symbol}&tier=MEDIUM&range=1h`,
    `/api/large-trades?symbol=${symbol}&tier=MEDIUM&range=1h`,
  );
  const vp = useSse<any>(
    `/api/volume-profile/${symbol}/stream?range=1h`,
    `/api/volume-profile/${symbol}?range=1h`,
  );
  const [tip, setTip] = useState<Tip>(null);
  const geomRef = useRef<{ bins: any[]; padL: number; plotW: number; maxTotal: number; padT: number; plotH: number } | null>(null);

  const bins: any[] = vp.data?.bins ?? [];

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!bins.length) return;
    const padL = 96, padR = 20, padT = 16, padB = 42;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    const maxTotal = Math.max(...bins.map((b) => b.totalUsd), 1);
    const barH = plotH / bins.length;
    const halfW = plotW / 2;
    geomRef.current = { bins, padL, plotW, maxTotal, padT, plotH };

    // Bar: BUY kiri (hijau), SELL kanan (merah).
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i]!;
      const y = padT + i * barH;
      const buyW = (b.buyUsd / maxTotal) * (halfW - 12);
      const sellW = (b.sellUsd / maxTotal) * (halfW - 12);
      ctx.fillStyle = CHART.upFillSoft;
      ctx.fillRect(padL + halfW - buyW, y, buyW, Math.max(1, barH - 1));
      ctx.fillStyle = CHART.downFillSoft;
      ctx.fillRect(padL + halfW, y, sellW, Math.max(1, barH - 1));
    }

    // Sumbu $ di bawah.
    ctx.font = `11px ${fonts.mono}`; ctx.textBaseline = "top"; ctx.textAlign = "center";
    ctx.fillStyle = CHART.axisText;
    ctx.fillText(fmtUsd(maxTotal), padL + halfW - 20, padT + plotH + 6);
    ctx.fillText(fmtUsd(maxTotal), padL + halfW + 20, padT + plotH + 6);
    ctx.fillStyle = CHART.neutralDim; ctx.font = `10px ${fonts.mono}`;
    ctx.textAlign = "right"; ctx.fillText("◀ BELI", padL + halfW - 10, padT + plotH + 24);
    ctx.textAlign = "left"; ctx.fillText("JUAL ▶", padL + halfW + 10, padT + plotH + 24);

    // Garis tengah.
    ctx.strokeStyle = CHART.zero; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(padL + halfW) + 0.5, padT); ctx.lineTo(Math.round(padL + halfW) + 0.5, padT + plotH); ctx.stroke();

    // Sumbu harga di kiri.
    ctx.font = `11px ${fonts.mono}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const step = Math.max(1, Math.floor(bins.length / 6));
    for (let i = 0; i < bins.length; i += step) {
      ctx.fillStyle = CHART.axisText;
      ctx.fillText(fmtPrice(bins[i]!.price), padL - 10, padT + i * barH + barH / 2);
    }

    // POC.
    if (vp.data?.pocPrice) {
      const pocIdx = bins.findIndex((b) => b.price === vp.data.pocPrice);
      if (pocIdx >= 0) {
        const pocY = padT + pocIdx * barH + barH / 2;
        ctx.strokeStyle = CHART.price; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(padL, pocY); ctx.lineTo(padL + plotW, pocY); ctx.stroke();
        ctx.fillStyle = CHART.price; ctx.font = `bold 11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(`POC ${fmtPrice(vp.data.pocPrice)}`, padL + 6, pocY - 3);
      }
    }

    // VAH / VAL.
    for (const [label, price] of [["VAH", vp.data?.vahPrice], ["VAL", vp.data?.valPrice]] as const) {
      if (!price) continue;
      let idx = 0, bd = Infinity;
      bins.forEach((b, i) => { const d = Math.abs(b.price - price); if (d < bd) { bd = d; idx = i; } });
      const y = padT + idx * barH + barH / 2;
      ctx.strokeStyle = CHART.zero; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CHART.axisTextStrong; ctx.font = `11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`${label} ${fmtPrice(price)}`, padL + 6, y + 3);
    }
  }, [bins, vp.data]);

  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g || !g.bins.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const barH = g.plotH / g.bins.length;
    const idx = Math.floor((my - g.padT) / barH);
    if (idx < 0 || idx >= g.bins.length) { setTip(null); return; }
    const b = g.bins[idx]!;
    setTip({
      x: mx, y: my,
      title: `Harga ${fmtPrice(b.price)}`,
      rows: [
        { label: "Beli", value: fmtUsdFull(b.buyUsd), color: colors.up },
        { label: "Jual", value: fmtUsdFull(b.sellUsd), color: colors.down },
        { label: "Total", value: fmtUsdFull(b.totalUsd), color: colors.text },
      ],
    });
  }, []);

  const tradeList: any[] = (trades.data?.trades ?? []).slice(0, 15);
  const floorUsd = trades.data?.floorUsd;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: colors.text, fontFamily: fonts.mono, letterSpacing: "0.06em", fontWeight: 700 }}>
          4 · LARGE TRADES + VOLUME PROFILE · {symbol}
        </span>
        <LivePill stale={trades.stale || vp.stale} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(340px,1fr) minmax(420px,1.2fr)", gap: 16 }}>
        {/* Tape */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em" }}>
              TAPE TRANSAKSI BESAR · ≥{floorUsd != null ? fmtUsd(floorUsd) : "$50K"}
            </span>
            <LivePill stale={trades.stale} detail={`${trades.data?.count ?? 0} trade / 1 jam`} />
          </div>
          <div style={{ maxHeight: 300 }}>
            <DataTable
              columns={largeTradeColumns}
              data={tradeList}
              maxHeight={300}
              emptyText="Belum ada transaksi pada ambang tersebut dalam 1 jam terakhir."
            />
          </div>
          {tradeList.length === 0 && (
            <div style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono, padding: "14px 0" }}>
              Belum ada transaksi pada ambang tersebut dalam 1 jam terakhir.
            </div>
          )}
        </div>

        {/* Volume profile */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em" }}>
              VOLUME PROFILE 1J · {bins.length} bin
            </span>
            <LivePill stale={vp.stale} detail={vp.data ? `total ${fmtUsd(vp.data.totalUsd)}` : undefined} />
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <LegendItem color={CHART.up} label="CYAN" value="volume beli" valueColor={colors.up} />
            <LegendItem color={CHART.down} label="MERAH" value="volume jual" valueColor={colors.down} />
            <LegendItem color={CHART.price} label="POC" value="harga tertinggi volume" valueColor={colors.warn} />
            <LegendItem color={CHART.neutral} label="VAH / VAL" value="batas value area" valueColor={colors.text} />
          </div>
          <ChartCanvas
            height={300}
            redrawKey={`vp-${symbol}-${vp.data?.updatedAt ?? 0}`}
            draw={draw}
            tip={tip}
            onMove={onMove}
            onLeave={() => setTip(null)}
          />
          <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px" }}>
              <KeyRow label="POC" value={fmtPrice(vp.data?.pocPrice ?? null)} color={colors.warn} />
              <KeyRow label="Volume POC" value={fmtUsd(vp.data?.pocVolumeUsd ?? 0)} />
              <KeyRow label="Porsi beli di POC" value={fmtPct(vp.data?.pocBuySharePct)} />
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <KeyRow label="VAH" value={fmtPrice(vp.data?.vahPrice ?? null)} />
              <KeyRow label="VAL" value={fmtPrice(vp.data?.valPrice ?? null)} />
              <KeyRow label="Posisi harga" value={vp.data?.priceVsValueArea ?? "·"} color={colors.text} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Panel 5: Tier & Flow ────────────────────────────────────────────────────

function TierFlowPanel({ symbol }: { symbol: Sym }) {
  const { data, stale } = useSse<any>(
    `/api/tier-flow/${symbol}/stream?range=1h`,
    `/api/tier-flow/${symbol}?range=1h`,
  );
  const [tip, setTip] = useState<Tip>(null);
  const geomRef = useRef<{ series: any[]; minT: number; maxT: number; padL: number; plotW: number } | null>(null);

  const series: any[] = data?.perExchange ?? [];

  const draw = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (!series.length) return;
    const padL = 92, padR = 92, padT = 16, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    let minV = Infinity, maxV = -Infinity, minT = Infinity, maxT = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v;
        if (p.t < minT) minT = p.t; if (p.t > maxT) maxT = p.t;
      }
    }
    if (!Number.isFinite(minV)) return;
    if (minV > 0) minV = 0;
    if (maxV < 0) maxV = 0;
    const rangeV = maxV - minV || 1;
    const rangeT = maxT - minT || 1;
    const xOf = (t: number) => padL + ((t - minT) / rangeT) * plotW;
    const yOf = (v: number) => padT + plotH - ((v - minV) / rangeV) * plotH;
    geomRef.current = { series, minT, maxT, padL, plotW };

    // Grid + sumbu nilai.
    ctx.font = `11px ${fonts.mono}`; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = maxV - (rangeV / 4) * i;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = CHART.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = CHART.axisText; ctx.textAlign = "right";
      ctx.fillText(fmtUsd(v), padL - 8, y);
    }
    // Grid waktu.
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= 5; i++) {
      const t = minT + (rangeT / 5) * i;
      const x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = CHART.gridSoft;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = CHART.axisText;
      ctx.fillText(hhmm(t), x, padT + plotH + 8);
    }
    // Garis nol.
    if (minV < 0 && maxV > 0) {
      const zy = Math.round(yOf(0)) + 0.5;
      ctx.strokeStyle = CHART.zero; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + plotW, zy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Garis per exchange.
    for (const s of series) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const x = xOf(s.points[i].t), y = yOf(s.points[i].v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const last = s.points[s.points.length - 1]!;
      ctx.fillStyle = s.color; ctx.font = `bold 11px ${fonts.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(s.exchange, Math.min(xOf(last.t) + 6, w - 70), yOf(last.v));
    }
  }, [series]);

  const onMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geomRef.current;
    if (!g || !g.series.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < g.padL || mx > g.padL + g.plotW) { setTip(null); return; }
    const t = g.minT + ((mx - g.padL) / g.plotW) * (g.maxT - g.minT);
    const rows: { label: string; value: string; color?: string }[] = [];
    for (const s of g.series) {
      if (!s.points.length) continue;
      let best = s.points[0]!, bd = Infinity;
      for (const p of s.points) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
      rows.push({ label: s.exchange, value: fmtSigned(best.v), color: signColor(best.v) });
    }
    setTip({ x: mx, y: my, title: `Waktu ${hhmm(t)} UTC`, rows });
  }, []);

  const tiers: any[] = data?.tiers ?? [];
  const alerts: any[] = data?.divergenceAlerts ?? [];
  const bias = data?.whaleRetailBias;
  const totals: any[] = data?.perExchangeTotals ?? [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: colors.text, fontFamily: fonts.mono, letterSpacing: "0.06em", fontWeight: 700 }}>
          5 · TIER & FLOW · {symbol} · {bias?.bias ?? "·"}
        </span>
        <LivePill stale={stale} detail={bias?.note} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <StatTile
          label="WHALE NET"
          value={fmtSigned(bias?.whaleDelta ?? 0)}
          sub="mega+whale+large"
          color={signColor(bias?.whaleDelta ?? 0)}
        />
        <StatTile
          label="RITEL NET"
          value={fmtSigned(bias?.retailDelta ?? 0)}
          sub="medium+small"
          color={signColor(bias?.retailDelta ?? 0)}
        />
        <StatTile
          label="SELISIH"
          value={fmtSigned((bias?.whaleDelta ?? 0) - (bias?.retailDelta ?? 0))}
          sub="whale − ritel"
          color={signColor((bias?.whaleDelta ?? 0) - (bias?.retailDelta ?? 0))}
        />
      </div>

      {/* Tier imbalance */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {tiers.map((t: any) => {
          const total = (t.buyUsd ?? 0) + (t.sellUsd ?? 0);
          const buyPct = total > 0 ? (t.buyUsd / total) * 100 : 50;
          return (
            <div key={t.tier} style={{ flex: "1 1 190px", background: colors.bgInput, borderRadius: 6, padding: "10px 12px", border: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: 12, color: colors.textStrong, fontWeight: 700, fontFamily: fonts.mono, marginBottom: 6 }}>{t.tier}</div>
              <div style={{ height: 10, display: "flex", borderRadius: 3, overflow: "hidden", background: colors.bg }}>
                <div style={{ width: `${buyPct}%`, background: CHART.upFillSoft }} />
                <div style={{ width: `${100 - buyPct}%`, background: CHART.downFillSoft }} />
              </div>
              <div style={{ fontSize: 11.5, fontFamily: fonts.mono, marginTop: 6, lineHeight: 1.7 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: colors.up }}>Beli {fmtUsd(t.buyUsd)}</span>
                  <span style={{ color: colors.textMuted }}>{fmtPct(buyPct)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: colors.down }}>Jual {fmtUsd(t.sellUsd)}</span>
                  <span style={{ color: colors.textMuted }}>{t.trades} trade</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ color: colors.textMuted }}>Net</span>
                  <span style={{ color: signColor(t.netDeltaUsd), fontWeight: 700 }}>{fmtSigned(t.netDeltaUsd)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Chart per-exchange + legenda nilai */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {totals.map((t: any) => {
          const s = series.find((x) => x.exchange === t.exchange);
          return (
            <LegendItem
              key={t.exchange}
              color={s?.color ?? EXCHANGE_FALLBACK[t.exchange] ?? CHART.axisText}
              label={t.exchange}
              value={fmtSigned(t.delta)}
              valueColor={signColor(t.delta)}
            />
          );
        })}
      </div>

      <ChartCanvas
        height={200}
        redrawKey={`tf-${symbol}-${data?.generatedAt ?? 0}`}
        draw={draw}
        tip={tip}
        onMove={onMove}
        onLeave={() => setTip(null)}
      />

      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 6 }}>
        Net delta kumulatif per exchange (garis di atas nol = net beli, di bawah = net jual). Arahkan kursor untuk nilai per titik waktu.
      </div>

      {/* Tabel divergensi · kolom sebelumnya kosong karena nama field salah */}
      <DivergenceTable alerts={alerts} minSpreadUsd={data?.divergenceMinSpreadUsd} />
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

// ── Panel AI read (TAHAP 4D, 26 Okt 2026) ───────────────────────────────────
/** Hasil analisis AI lima panel dari /api/panel-ai/:symbol. */
interface PanelAiRowUi {
  panel: string; symbol: string; status: "LLM_SUCCESS" | "FALLBACK" | "STALE" | "UNAVAILABLE";
  model: string | null; text: string; generatedAt: string; latencyMs: number | null;
}
function usePanelAi(symbol: string): { panels: Record<string, PanelAiRowUi | null>; fresh: boolean; generatedAt: string } {
  const [state, setState] = useState<{ panels: Record<string, PanelAiRowUi | null>; fresh: boolean; generatedAt: string }>({ panels: {}, fresh: false, generatedAt: "" });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      fetch(`/api/panel-ai/${symbol}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json) => { if (alive) setState({ panels: json.panels ?? {}, fresh: !!json.fresh, generatedAt: json.generatedAt ?? "" }); })
        .catch(() => { /* route belum tersedia di backend lama */ })
        .finally(() => { if (alive) timer = setTimeout(load, 15_000); });
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [symbol]);
  return state;
}

function PanelAiCard({ title, row }: { title: string; row: PanelAiRowUi | null }) {
  const statusColor = row?.status === "LLM_SUCCESS" ? colors.up
    : row?.status === "FALLBACK" ? colors.warn
    : colors.textMuted;
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: "8px 10px", marginBottom: 8, background: colors.bgPanel ?? "transparent" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: colors.textStrong, fontFamily: fonts.mono }}>{title}</span>
        {row ? (
          <>
            <span style={{ fontSize: 10, color: statusColor, fontFamily: fonts.mono }}>{row.status}</span>
            {row.model && <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>{row.model}</span>}
            <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>
              {row.generatedAt ? new Date(row.generatedAt).toLocaleTimeString() : ""}
              {row.latencyMs != null ? ` · ${row.latencyMs}ms` : ""}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>BELUM ADA · menunggu trigger (kandidat/siklus analyst) atau POST /api/panel-ai/{`{SYMBOL}`}/trigger</span>
        )}
      </div>
      {row && (
        <div style={{ fontSize: 11.5, color: colors.text, fontFamily: fonts.mono, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
          {noDashText(row.text)}
        </div>
      )}
      {row?.status === "FALLBACK" && (
        <div style={{ fontSize: 10, color: colors.warn, fontFamily: fonts.mono, marginTop: 4 }}>
          Catatan: fallback deterministik · BUKAN hasil LLM.
        </div>
      )}
    </div>
  );
}

function PanelAiSection({ symbol }: { symbol: Sym }) {
  const { panels, fresh, generatedAt } = usePanelAi(symbol);
  return (
    <Panel
      title={`AI ANALYSIS · 5 PANEL + GABUNGAN · ${symbol}`}
      extra={<span style={{ fontSize: 10.5, color: fresh ? colors.up : colors.textMuted, fontFamily: fonts.mono }}>{fresh ? "FRESH" : "STALE/KOSONG"}{generatedAt ? ` · ${new Date(generatedAt).toLocaleTimeString()}` : ""}</span>}
    >
      <PanelAiCard title="ORDER FLOW" row={panels.orderflow ?? null} />
      <PanelAiCard title="WALL LIFELINES" row={panels.walls ?? null} />
      <PanelAiCard title="LIQ MAP" row={panels.liqmap ?? null} />
      <PanelAiCard title="LARGE TRADES + VOLUME PROFILE" row={panels.largetrades_vp ?? null} />
      <PanelAiCard title="TIER & FLOW" row={panels.tierflow ?? null} />
      <PanelAiCard title="GABUNGAN (thesis/counter/horizon/invalidasi)" row={panels.combined ?? null} />
    </Panel>
  );
}

export function HeatmapPage() {
  const [symbol, setSymbol] = useState<Sym>("BTC");
  const [activeModule, setActiveModule] = useState<ModuleId>("orderflow");
  const active = MODULE_TABS.find((m) => m.id === activeModule) ?? MODULE_TABS[0]!;

  return (
    <div>
      <PageHead
        title="MICROSTRUCTURE · ORDER FLOW"
        desc="5 modul real-time dari 10 venue via SSE backend. Data 100% live WS/REST exchange · tanpa mock."
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Select value={symbol} onChange={(v) => setSymbol(v as Sym)}>
              {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </div>
        }
      />

      {/* Module tabs · bernomor + keterangan singkat */}
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${colors.border}`, marginBottom: 10, overflowX: "auto" }}>
        {MODULE_TABS.map((m, i) => {
          const on = m.id === activeModule;
          return (
            <button
              key={m.id}
              onClick={() => setActiveModule(m.id)}
              style={{
                appearance: "none", background: "transparent", border: 0,
                borderBottom: `2px solid ${on ? colors.accent : "transparent"}`,
                color: on ? colors.textStrong : colors.textMuted,
                fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "10px 14px", cursor: "pointer", fontFamily: fonts.mono, whiteSpace: "nowrap",
              }}
            >
              {i + 1} · {m.label}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono, marginBottom: 12 }}>
        {active.desc}
      </div>

      <Panel
        title={`${active.label} · ${symbol}`}
        extra={<span style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono }}>SSE 1.5s · CANVAS</span>}
      >
        {activeModule === "orderflow" && <OrderFlowPanel symbol={symbol} />}
        {activeModule === "walls" && <WallLifelinesPanel symbol={symbol} />}
        {activeModule === "liquidation" && <LiquidationMapPanel symbol={symbol} />}
        {activeModule === "trades" && <LargeTradesVolumePanel symbol={symbol} />}
        {activeModule === "tierflow" && <TierFlowPanel symbol={symbol} />}
      </Panel>

      <div style={{ marginTop: 12 }}>
        <PanelAiSection symbol={symbol} />
      </div>

      <div style={{ marginTop: 12, fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono, lineHeight: 1.7 }}>
        Semua data berasal dari 10 venue WebSocket yang berjalan 24/7 di backend (Binance Futures/Spot, Hyperliquid, Coinbase, Bybit, OKX, Gate, Bitget, KuCoin).
        Tidak ada REST polling ke exchange dari browser. Likuidasi memakai Hyperliquid on-chain sampling + Vike API (bila key tersedia).
        Canvas digambar tangan, di-render ulang hanya saat data berubah.
      </div>
    </div>
  );
}
