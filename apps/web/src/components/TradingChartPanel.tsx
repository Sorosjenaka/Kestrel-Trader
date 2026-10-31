import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries,
  createChart, type CandlestickData, type HistogramData, type IChartApi,
  type ISeriesApi, type LineData, type UTCTimestamp,
} from "lightweight-charts";
import { normalizeKlines, sma, rvol, ema, rsi, atr, volumeSma, type Candle } from "../lib/chartMath.js";
import { fetchKlineRows } from "../lib/klineCache.js";
import { subscribeKlineStreamMulti, type StreamCandle, type StreamState } from "../lib/klineStream.js";
import { beginTransition, sampleTransition, type InterpState, type Ohlc } from "../lib/smoothOhlc.js";
import { PositionBoxPrimitive, type PositionBoxState } from "../lib/positionBoxPrimitive.js";
import { computeAutoscaleRange, crosshairFmtWib, positionFooterLabel, tickFmt, tickMarkFmtWib } from "../lib/positionMath.js";
import { LastPriceTag } from "./LastPriceTag.js";

export interface ChartIndicators {
  volume: boolean;
  volumeSma20: boolean;
  rvol20: boolean;
  ema20: boolean;
  ema50: boolean;
  rsi14: boolean;
  atr14: boolean;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  atrPeriod: number;
  volumeSmaPeriod: number;
}

export interface ChartPanelConfig {
  id: string;
  symbol: string;
  interval: string;
  indicators: ChartIndicators;
}

export interface ChartPosition {
  id: number; symbol: string; side: "LONG" | "SHORT"; mode: string;
  entryPrice: number; markPrice?: number; slPrice: number | null; tp1Price: number | null;
  tp2Price?: number | null; qty?: number; marginUsd?: number; status?: string;
  source?: string; strategyId?: string; openedAt?: string; pnlUsd?: number | null; pnlR?: number | null;
  priceTick?: number; riskBudgetUsd?: number | null; originalRiskUsd?: number | null; leverage?: number; notional?: number; originalQty?: number | null;
  tp1FilledAt?: string | null; beMoved?: boolean;
}

type Tool = "crosshair" | "hline" | "trend" | "rect" | "ruler" | "select";
type Anchor = { time: number; price: number };
type Drawing = { id: string; type: Exclude<Tool, "crosshair" | "select">; anchors: Anchor[]; color: string };

const DEFAULT_INDICATORS: ChartIndicators = {
  volume: true, volumeSma20: true, rvol20: false, ema20: true, ema50: false,
  rsi14: false, atr14: false, emaFast: 20, emaSlow: 50, rsiPeriod: 14, atrPeriod: 14, volumeSmaPeriod: 20,
};
const PANEL_STORAGE = "arta.workspace.panels.v3";
// Canonical Binance USDⓈ-M display ticks. Runtime replaces these with the
// exchange-info row from /api/binance/symbol-info; the map avoids a visible
// low-precision frame before that first response.
const SYMBOL_TICKS: Record<string, number> = {
  BTCUSDT: 0.1, ETHUSDT: 0.01, SOLUSDT: 0.01, XRPUSDT: 0.0001,
  BNBUSDT: 0.01, DOGEUSDT: 0.00001, AVAXUSDT: 0.001, LINKUSDT: 0.001,
  ADAUSDT: 0.0001, TONUSDT: 0.0001, SYNUSDT: 0.00001, HANAUSDT: 0.00001,
};
function tickDigits(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2;
  return Math.min(8, Math.max(0, Math.round(-Math.log10(tick))));
}
function fmtPrice(v: number | undefined | null, tick: number): string {
  if (!Number.isFinite(Number(v))) return "·";
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: tickDigits(tick), maximumFractionDigits: tickDigits(tick) });
}

export const DEFAULT_PANEL: ChartPanelConfig = { id: "p1", symbol: "BTCUSDT", interval: "1h", indicators: { ...DEFAULT_INDICATORS } };

function apiInterval(interval: string): string {
  return interval === "1D" ? "1d" : interval;
}
function normalizeInterval(interval: string): string {
  return interval.toLowerCase();
}
function intervalMs(interval: string): number {
  if (interval === "1D" || interval === "1d") return 86_400_000;
  const n = Number(interval);
  if (Number.isFinite(n) && n > 0) return n * 60_000;
  if (interval === "1h") return 3_600_000;
  if (interval === "4h") return 14_400_000;
  if (interval === "1d" || interval === "D") return 86_400_000;
  return 3_600_000;
}
function storageKey(panel: ChartPanelConfig): string {
  return `${PANEL_STORAGE}.drawings.${panel.id}.${panel.symbol}.${panel.interval}`;
}

/*
   23 Okt 2026 · Format sumbu waktu ala Binance Futures.
   Binance (dan TradingView) memakai label yang BERGANTI sesuai resolusi:
   - tick < 1 jam  : hanya jam:menit   -> "14:30"
   - tick >= 1 jam : tanggal + jam     -> "Oct 23 14:00" / dalam locale id: "23 Okt 14:00"
   - tick >= 1 hari: tanggal saja      -> "Oct 23"
   - tick >= 1 bln : bulan + tahun     -> "Oct 2026"
   Kita tidak menampilkan detik (Binance juga tidak) kecuali TF 1m.
*/
const MONTHS_ID = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"] as const;
function fmtTick(t: number): string {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t * 1000); // lightweight-charts time = Unix SECONDS
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const dd = d.getUTCDate();
  const mon = MONTHS_ID[d.getUTCMonth()] ?? "";
  return `${dd} ${mon} ${hh}:${mm}`;
}
/** Label ringkas untuk sumbu X (dipakai tickMarkFormatter). */
function fmtAxisTick(time: number, kind: "minute" | "hour" | "day" | "month"): string {
  const d = new Date(time * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const mon = MONTHS_ID[d.getUTCMonth()] ?? "";
  if (kind === "minute") return `${hh}:${mm}`;
  if (kind === "hour") return `${d.getUTCDate()} ${mon} ${hh}:${mm}`;
  if (kind === "day") return `${d.getUTCDate()} ${mon}`;
  return `${mon} ${d.getUTCFullYear()}`;
}
function fmt(v: number | undefined | null, digits = 2): string {
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }) : "·";
}
function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}
/**
 * 23 Okt 2026: volume 24h futures dalam USD — angka LENGKAP (permintaan
 * operator), bukan ringkasan K/M/B, supaya operator bisa membandingkan
 * likuiditas pair secara presisi.
 */
function fmtUsdFull(v: number | undefined | null): string {
  if (!Number.isFinite(Number(v)) || Number(v) <= 0) return "·";
  return `$${Math.round(Number(v)).toLocaleString("en-US")}`;
}
function lineData(candles: Candle[], values: Array<number | null>): LineData<UTCTimestamp>[] {
  const out: LineData<UTCTimestamp>[] = [];
  for (let i = 0; i < candles.length; i++) {
    const value = values[i];
    if (value !== null && Number.isFinite(value)) out.push({ time: candles[i]!.time as UTCTimestamp, value });
  }
  return out;
}
function sanitizeDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const types = new Set(["hline", "trend", "rect", "ruler"]);
  return raw.flatMap((d): Drawing[] => {
    if (!d || typeof d !== "object") return [];
    const item = d as Partial<Drawing>;
    if (typeof item.id !== "string" || !types.has(String(item.type)) || !Array.isArray(item.anchors)) return [];
    const anchors = item.anchors.flatMap((a): Anchor[] => {
      if (!a || typeof a !== "object") return [];
      const time = Number((a as Anchor).time); const price = Number((a as Anchor).price);
      return Number.isFinite(time) && time > 0 && Number.isFinite(price) && price > 0 ? [{ time, price }] : [];
    });
    if (!anchors.length || (item.type !== "hline" && anchors.length < 2)) return [];
    return [{ id: item.id, type: item.type as Drawing["type"], anchors: item.type === "hline" ? [anchors[0]!] : anchors.slice(0, 2), color: typeof item.color === "string" ? item.color : "#3AA8F2" }];
  });
}
function drawingDistance(d: Drawing, x: number, y: number, toXY: (a: Anchor) => { x: number; y: number } | null): number {
  const pts = d.anchors.map(toXY).filter((p): p is { x: number; y: number } => p !== null);
  if (!pts.length) return Infinity;
  if (d.type === "hline") return Math.abs(y - pts[0]!.y);
  if (d.type === "rect") {
    const a = pts[0]!; const b = pts[1] ?? a;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    return Math.max(minX - x, x - maxX, minY - y, y - maxY, 0);
  }
  if (pts.length < 2) return Math.hypot(pts[0]!.x - x, pts[0]!.y - y);
  const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(1, dx * dx + dy * dy)));
  return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
}

export function TradingChartPanel({
  panel, active, positions, liveTicker, onSelect, onChange, onExpand, compact = false,
}: {
  panel: ChartPanelConfig;
  active: boolean;
  positions: ChartPosition[];
  /*
     23 Okt 2026 (Tahap 8 · "semua angka harus hidup"):
     liveTicker sekarang membawa data lengkap (mark, 24h%, vol, funding, arah)
     supaya header panel bisa menampilkan ticker Bloomberg-style, bukan cuma
     mark price. Field opsional -> panel tanpa feed tetap aman.
  */
  liveTicker?: {
    symbol?: string;
    markPrice?: number;
    lastPrice?: number;
    lastUpdated?: number;
    chg24hPct?: number;
    high24h?: number;
    low24h?: number;
    volume24h?: number;
    fundingRate?: number | null;
    direction?: "UP" | "DOWN" | "FLAT";
  } | null;
  onSelect: () => void;
  onChange: (patch: Partial<ChartPanelConfig>) => void;
  onExpand?: () => void;
  compact?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const volSmaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rvolRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaFastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaSlowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const atrRef = useRef<ISeriesApi<"Line"> | null>(null);
  const positionBoxRef = useRef<PositionBoxPrimitive | null>(null);
  const fitLevelsRef = useRef(true);
  const attachedSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const primitiveReadyRef = useRef(false);
  const lastKeyRef = useRef("");
  /** Spacing bar default (terbaca). Dipakai untuk reset zoom saat TF berubah. */
  const defaultBarSpacing = compact ? 5 : 7;
  const dataKeyRef = useRef("");
  const lastDataRef = useRef<{ key: string; candles: Candle[] }>({ key: "", candles: [] });
  const candlesRef = useRef<Candle[]>([]);
  const loadOlderRef = useRef<() => void>(() => {});
  const olderLoadingRef = useRef(false);
  const currentPanelKeyRef = useRef(`${panel.symbol}:${panel.interval}`);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [dataState, setDataState] = useState<"LOADING" | "READY" | "STALE" | "ERROR">("LOADING");
  const [error, setError] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const [size, setSize] = useState({ w: 600, h: compact ? 260 : 440 });
  const [chartEpoch, setChartEpoch] = useState(0);
  const [tool, setTool] = useState<Tool>("crosshair");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [draft, setDraft] = useState<Anchor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Drawing[][]>([]);
  const [future, setFuture] = useState<Drawing[][]>([]);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  /*
     30 Okt 2026 (chart Binance-style): harga & closeTime candle berjalan
     disimpan di REF, bukan state — tick kline 4-5x/detik tidak boleh
     me-render ulang seluruh panel. LastPriceTag membaca ref ini 5x/detik.
  */
  const liveBarPriceRef = useRef<number | null>(null);
  const liveBarCloseTimeRef = useRef<number | null>(null);
  const [fitLevels, setFitLevels] = useState(() => {
    try { return localStorage.getItem("arta.chart.fitLevels") !== "false"; } catch { return true; }
  });
  /*
     23 Okt 2026 (Tahap 8 · Bloomberg-style): flash arah harga di header panel.
     Hijau = mark naik, merah = turun, mengikuti direction dari feed.
     Pakai key = symbol+timestamp supaya re-render tidak me-reset animasi.
  */
  const [tickFlash, setTickFlash] = useState<{ cls: "flash-up" | "flash-down"; at: number } | null>(null);
  const lastMarkRef = useRef<number>(0);
  const [streamState, setStreamState] = useState<StreamState>("CONNECTING");
  const streamStateRef = useRef<StreamState>("CONNECTING");
  const streamHealthyRef = useRef(false);
  const streamFlushRef = useRef<number | null>(null);
  const lastStreamStatusAtRef = useRef(0);
  const [tickSize, setTickSize] = useState(() => SYMBOL_TICKS[panel.symbol] ?? 0.01);
  /*
     23 Okt 2026 (permintaan operator: gerak candle harus natural/smooth).
     Lightweight Charts tidak menginterpolasi: series.update() menulis nilai
     final seketika -> candle terakhir melompat tiap tick. Modul smoothOhlc
     membuat perpindahan harga jadi CONTINUOUS (easing + rAF), seperti demo
     TradingAgents. Hanya bar TERAKHIR yang dianimasikan; bar tertutup immutable.
  */
  const interpRef = useRef<InterpState | null>(null);
  const interpRafRef = useRef<number | null>(null);
  const interpCandleRef = useRef<{ time: number; ohlc: Ohlc } | null>(null);
  /*
     23 Okt 2026: readout OHLC di header di-update LANGSUNG via DOM (ref),
     bukan lewat setState. Kalau lewat setState, tiap frame animasi memicu
     re-render React -> pada layout 8 monitor itu 8x render per frame
     (sangat berat) dan efek samping: state update membatalkan effect.
     DOM write di rAF murah dan tidak memicu render.
  */
  const ohlcReadoutRef = useRef<HTMLSpanElement | null>(null);
  /**
   * 23 Okt 2026: daftar simbol untuk dropdown.
   * Sebelumnya hard-coded 10 simbol -> pair yang sedang di posisi/dipantau
   * (SPKUSDT, TAOUSDT, ILVUSDT, TURTLEUSDT, ...) TIDAK bisa dipilih di chart,
   * padahal itu pair yang operator lihat di tabel posisi.
   * Sekarang diambil dari backend (semua pair universe), dengan fallback
   * daftar bawaan kalau endpoint gagal.
   */
  const [symbolOptions, setSymbolOptions] = useState<string[]>([
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "ADAUSDT", "TONUSDT",
  ]);
  /** tickSize dalam ref supaya painter bisa memformat tanpa stale closure. */
  const tickSizeRef = useRef(0.01);
  /*
     Painter terpadu (23 Okt 2026). Semua penulisan ke seri candle HARUS lewat
     sini supaya:
       - kline WS dan overlay mark-price tidak saling menimpa,
       - setiap perubahan dianimasikan (smooth) dari posisi sebelumnya,
       - high/low dijaga >= max(open,close) / <= min(open,close).
  */
  const paintTargetRef = useRef<{ time: number; ohlc: Ohlc; volume: number } | null>(null);
  const paintRafRef = useRef<number | null>(null);
  const paintAliveRef = useRef(true);

  const paintNow = useCallback((time: number, ohlc: Ohlc, volume: number) => {
    const hi = Math.max(ohlc.high, ohlc.open, ohlc.close);
    const lo = Math.min(ohlc.low, ohlc.open, ohlc.close);
    try {
      candleRef.current?.update({ time: time as UTCTimestamp, open: ohlc.open, high: hi, low: lo, close: ohlc.close });
    } catch {}
    try {
      volumeRef.current?.update({ time: time as UTCTimestamp, value: volume, color: ohlc.close >= ohlc.open ? "rgba(58,168,242,.45)" : "rgba(242,65,74,.45)" });
    } catch {}
  }, []);
  /** Minta paint animasi menuju target; aman dipanggil dari event & effect. */
  const requestPaint = useCallback((time: number, target: Ohlc, volume: number) => {
    paintTargetRef.current = { time, ohlc: target, volume };
    const prev = interpCandleRef.current;
    const from: Ohlc = prev && prev.time === time ? prev.ohlc : target;
    const state = beginTransition(from, target, Date.now());
    interpCandleRef.current = { time, ohlc: { ...target } };
    if (!state) {
      paintNow(time, target, volume);
      return;
    }
    interpRef.current = state;
    if (paintRafRef.current !== null) cancelAnimationFrame(paintRafRef.current);
    const step = () => {
      if (!paintAliveRef.current) { paintRafRef.current = null; return; }
      const s = interpRef.current;
      const tgt = paintTargetRef.current;
      if (!s || !tgt) { paintRafRef.current = null; return; }
      const { ohlc, completed } = sampleTransition(s, Date.now());
      const hi = Math.max(ohlc.high, ohlc.open, ohlc.close);
      const lo = Math.min(ohlc.low, ohlc.open, ohlc.close);
      paintNow(tgt.time, { open: ohlc.open, high: hi, low: lo, close: ohlc.close }, tgt.volume);
      interpCandleRef.current = { time: tgt.time, ohlc: { open: ohlc.open, high: hi, low: lo, close: ohlc.close } };
      // Header readout: tulis langsung ke DOM (murah, tanpa re-render React).
      const el = ohlcReadoutRef.current;
      if (el) {
        el.textContent = `O ${fmtPrice(tgt.ohlc.open, tickSizeRef.current)} H ${fmtPrice(hi, tickSizeRef.current)} L ${fmtPrice(lo, tickSizeRef.current)} C ${fmtPrice(ohlc.close, tickSizeRef.current)}`;
      }
      if (completed) {
        interpRef.current = null;
        paintRafRef.current = null;
        paintNow(tgt.time, tgt.ohlc, tgt.volume);
        return;
      }
      paintRafRef.current = requestAnimationFrame(step);
    };
    paintRafRef.current = requestAnimationFrame(step);
  }, [paintNow]);
  const [redrawTick, setRedraw] = useState(0);
  const dragRef = useRef<{ id: string; anchor: number; start: Anchor } | null>(null);

  // Load only annotations; never account/ARM/trading state.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey(panel));
      const parsed = raw ? JSON.parse(raw) : null;
      setDrawings(parsed?.schemaVersion === 2 ? sanitizeDrawings(parsed.drawings) : []);
    } catch { setDrawings([]); }
    setDraft([]); setSelectedId(null); setTool("crosshair");
  }, [panel.id, panel.symbol, panel.interval]);
  useEffect(() => {
    try { localStorage.setItem(storageKey(panel), JSON.stringify({ schemaVersion: 2, drawings })); } catch { /* storage may be disabled */ }
  }, [drawings, panel]);
  // Ambil daftar simbol lengkap (23 Okt 2026) supaya pair yang sedang di
  // posisi PAPER bisa dipilih di chart.
  useEffect(() => {
    let alive = true;
    fetch("/api/markets/symbols", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const list: string[] = Array.isArray(d?.symbols) ? d.symbols : [];
        if (!list.length) return;
        setSymbolOptions((prev) => {
          const merged = new Set<string>(prev);
          for (const s of list) merged.add(s);
          return [...merged].sort();
        });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 23 Okt 2026: tick size asli per simbol dari /api/binance/symbol-info.
  // Fallback 0.01 (2 desimal) membuat pair harga kecil tampil salah
  // (SPKUSDT 0.0187 -> "0.02"). Route itu dulu 404 -> HARUS ada server-side.
  useEffect(() => {
    let alive = true;
    setTickSize(SYMBOL_TICKS[panel.symbol] ?? 0.01);
    fetch(`/api/binance/symbol-info?symbol=${encodeURIComponent(panel.symbol)}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (alive && Number(d?.tickSize) > 0) setTickSize(Number(d.tickSize)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [panel.symbol]);
  useEffect(() => {
    candleRef.current?.applyOptions({ priceFormat: { type: "price", precision: tickDigits(tickSize), minMove: tickSize } });
    tickSizeRef.current = tickSize;
  }, [tickSize, chartEpoch]);

  useEffect(() => {
    const key = `${panel.symbol}:${apiInterval(panel.interval)}`;
    let alive = true;
    setStreamState("CONNECTING"); streamStateRef.current = "CONNECTING"; streamHealthyRef.current = false;
    // Simbol/TF baru: buang harga bar lama supaya label kanan tidak memakai
    // harga pair sebelumnya sebelum tick pertama datang.
    liveBarPriceRef.current = null;
    liveBarCloseTimeRef.current = null;
    /*
       23 Okt 2026: paint helper.
       - paintCandle()  : tulis OHLC+volume sekali (bar tertutup / bar baru).
       - startSmoothPaint(): animasi kontinu dari posisi saat ini ke OHLC baru
         memakai rAF + easing. interpolated high/low dijaga >= open/close supaya
         body & wick tidak pernah "salah bentuk" saat interpolasi.
    */
    const paintCandle = (c: Candle) => {
      requestPaint(c.time, { open: c.open, high: c.high, low: c.low, close: c.close }, c.volume);
    };
    const startSmoothPaint = (c: Candle) => {
      requestPaint(c.time, { open: c.open, high: c.high, low: c.low, close: c.close }, c.volume);
    };
    const flush = () => {
      if (streamFlushRef.current !== null) return;
      streamFlushRef.current = window.setTimeout(() => {
        streamFlushRef.current = null;
        /*
           23 Okt 2026: setCandles pada running bar memicu re-render React
           (dan memaksa hydrate effect jalan) di SETIAP panel. Pada layout 8
           monitor itu 8x render per tick · mahal, dan menyediakan jalan bagi
           close mentah menimpa interpolasi.

           Sekarang state candles hanya berubah kalau:
             - bar BARU muncul (time lebih besar), atau
             - running bar benar-benar sudah CLOSED.
           Running bar yang masih hidup digambar langsung ke canvas oleh
           painter terpadu, jadi React tidak perlu tahu soal perubahan itu.
        */
        if (!alive) return;
        const cur = candlesRef.current;
        const prev = lastDataRef.current.candles;
        const curLast = cur.at(-1);
        const prevLast = prev.at(-1);
        const barChanged = !curLast || !prevLast || curLast.time !== prevLast.time;
        const closed = curLast ? (prevLast?.time === curLast.time && prevLast?.close !== curLast.close && curLast.close === curLast.open) : false;
        if (barChanged || closed) setCandles(cur);
      }, 450);
    };
    const apply = (sc: StreamCandle) => {
      if (!alive || sc.symbol !== panel.symbol || normalizeInterval(apiInterval(panel.interval)) !== sc.interval) return;
      const candle: Candle = { time: sc.time, open: sc.open, high: sc.high, low: sc.low, close: sc.close, volume: sc.volume, quoteVolume: sc.quoteVolume, takerBuyBase: sc.takerBuyBase, takerBuyQuote: sc.takerBuyQuote };
      /*
         30 Okt 2026: label harga kanan memakai close kline terakhir (angka
         Binance persis) + closeTime untuk countdown. Ditulis ke REF agar
         tidak memicu render panel tiap tick.
      */
      liveBarPriceRef.current = candle.close;
      liveBarCloseTimeRef.current = sc.closeTime > 0 ? sc.closeTime : candle.time * 1000 + intervalMs(panel.interval);
      const current = candlesRef.current;
      if (!current.length) {
        candlesRef.current = [candle];
        candlesKeyRef.current = `${panel.symbol}:${panel.interval}`;
        setCandles([candle]);
        return;
      }
      const last = current.at(-1)!;
      if (candle.time < last.time) return;
      if (candle.time === last.time) {
        const next = [...current.slice(0, -1), candle];
        candlesRef.current = next;
        /*
           23 Okt 2026: bar yang sedang berjalan dianimasikan (smooth) alih-alih
           ditulis seketika. Bar yang sudah tutup (candle.time > last.time) TIDAK
           pernah dianimasikan · angka historis immutable.
        */
        if (!sc.closed) {
          startSmoothPaint(candle);
        } else {
          paintCandle(candle);
        }
        flush();
      } else {
        candlesRef.current = [...current, candle].slice(-1400);
        setCandles(candlesRef.current);
        // Bar baru: gambar langsung (tidak ada animasi untuk bar tertutup).
        paintCandle(candle);
      }
      if (Date.now() - lastStreamStatusAtRef.current > 5_000) {
        lastStreamStatusAtRef.current = Date.now();
        setLastSuccess(Date.now());
      }
    };
    const unsubscribe = subscribeKlineStreamMulti(panel.symbol, apiInterval(panel.interval), apply, (status) => {
      if (!alive) return;
      streamHealthyRef.current = status.state === "WS_ACTIVE";
      if (streamStateRef.current !== status.state) {
        streamStateRef.current = status.state;
        setStreamState(status.state);
      }
    });
    return () => {
      alive = false;
      streamHealthyRef.current = false;
      if (streamFlushRef.current !== null) { window.clearTimeout(streamFlushRef.current); streamFlushRef.current = null; }
      unsubscribe();
    };
  }, [panel.symbol, panel.interval, requestPaint]);

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#080A17" }, textColor: "#5C6890", fontSize: 12, fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { color: "rgba(53,60,75,.32)" }, horzLines: { color: "rgba(53,60,75,.32)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#353c4b", scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: {
        borderColor: "#353c4b",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: compact ? 5 : 9,
        minBarSpacing: 3,
        // Lightweight Charts v5 TickMarkType: 0=Year, 1=Month, 2=Day,
        // 3=Hour, 4=Minute, 5=Second. Labels use WIB, like the operator's
        // exchange workspace.
        tickMarkFormatter: (time: number, tickMarkType: number) => {
          switch (tickMarkType) {
            case 0: return tickMarkFmtWib(time, "year");
            case 1: return tickMarkFmtWib(time, "month");
            case 2: return tickMarkFmtWib(time, "day");
            case 3: return `${tickMarkFmtWib(time, "day")} ${tickFmt(time)}`;
            default: return tickFmt(time);
          }
        },
      },
      localization: { timeFormatter: (time: UTCTimestamp) => crosshairFmtWib(Number(time)) },
      // 29 Okt 2026 (fix) — autoSize: false. lightweight-charts v5 memasang
      // ResizeObserver internal saat autoSize aktif; observer itu bisa
      // fires setelah chart di-dispose saat panel di-unmount → "Object is
      // disposed" (fancy-canvas). Ukuran diteruskan manual lewat effect
      // di bawah (state `size`).
      autoSize: false,
      width: Math.max(1, Math.round(size.w)),
      height: Math.max(1, Math.round(size.h)),
    });
    chartRef.current = chart;
    // A new chart instance has empty series: force a full hydration even when
    // the panel's symbol/timeframe did not change (e.g. 1↔4↔8 layout).
    lastDataRef.current = { key: "", candles: [] };
    lastKeyRef.current = "";
    setChartEpoch((v) => v + 1);
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#3AA8F2", downColor: "#F2414A", borderVisible: false,
      wickUpColor: "#3AA8F2", wickDownColor: "#F2414A", priceLineVisible: false,
      priceFormat: { type: "price", precision: tickDigits(SYMBOL_TICKS[panel.symbol] ?? tickSize), minMove: SYMBOL_TICKS[panel.symbol] ?? tickSize },
      /*
         23 Okt 2026: sertakan SL/TP posisi dalam rentang harga auto-scale.
         Tanpa ini, TF dengan range harga sempit (mis. 5m) membuat koordinat
         SL/TP jatuh di luar area chart -> zona Entry/SL/TP tidak terlihat.
      */
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const res = original();
        const lv = setupLevelsRef.current;
        if (!res?.priceRange || !lv) return res;
        const range = computeAutoscaleRange(
          res.priceRange.minValue,
          res.priceRange.maxValue,
          [lv.entry, lv.sl, lv.tp1, lv.tp2],
          fitLevelsRef.current,
        );
        return { ...res, priceRange: range };
      },
    });
    candleRef.current = candle;
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false }, 1);
    volumeRef.current = volume;
    const volSma = chart.addSeries(LineSeries, { color: "#78c9e8", lineWidth: 1, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false }, 1);
    volSmaRef.current = volSma;
    const rvol = chart.addSeries(LineSeries, { color: "#d3c4f2", lineWidth: 1, priceScaleId: "rvol", priceLineVisible: false, lastValueVisible: false }, 1);
    rvolRef.current = rvol;
    const emaFast = chart.addSeries(LineSeries, { color: "#3AA8F2", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    emaFastRef.current = emaFast;
    const emaSlow = chart.addSeries(LineSeries, { color: "#d3c4f2", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    emaSlowRef.current = emaSlow;
    // RSI/ATR lower panes are created lazily only when enabled. Creating them
    // up-front left two empty panes under the chart in the default workspace.
    try {
      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      chart.priceScale("rvol").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.72 } });
    } catch { /* optional overlay scales */ }

    const resize = () => setSize({ w: hostRef.current?.clientWidth ?? 600, h: hostRef.current?.clientHeight ?? 440 });
    const ro = new ResizeObserver(resize);
    if (hostRef.current) ro.observe(hostRef.current);
    resize();
    const onMove = (param: Parameters<Parameters<IChartApi["subscribeCrosshairMove"]>[0]>[0]) => {
      const p = param.time ? candles.find((c) => c.time === param.time) : null;
      setHover(p ?? null);
    };
    chart.subscribeCrosshairMove(onMove);
    const onRange = (range: { from: number; to: number } | null) => {
      setRedraw((v) => v + 1);
      if (range && range.from < 8 && candlesRef.current.length > 0) loadOlderRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      /*
        29 Okt 2026 (fix) · lightweight-charts v5 memakai `autoSize: true`,
        yang memasang ResizeObserver internal pada elemen host. Saat panel
        di-unmount, observer internal bisa masih fires SATU KALI setelah
        `chart.remove()` → library memanggil resizeCanvasElement pada binding
        yang sudah di-dispose → lempar "Error: Object is disposed"
        (fancy-canvas/canvas-element-bitmap-size.mjs:40) → error tak
        tertangani memblankai seluruh konsol.

        Perbaikan: lepaskan observer internal DULU (autoSize → false) sehingga
        chart tidak lagi memasang ResizeObserver sendiri · yang sudah di-
        disconnect di atas · baru panggil chart.remove(). Resize chart tetap
        mengikuti ukuran React (lihat blok `resize`).
      */
      try { chart.applyOptions({ autoSize: false }); } catch { /* chart sudah hilang */ }
      try { chart.remove(); } catch { /* ignore */ }
      chartRef.current = null; candleRef.current = null; volumeRef.current = null; volSmaRef.current = null; rvolRef.current = null;
      emaFastRef.current = null; emaSlowRef.current = null; rsiRef.current = null; atrRef.current = null;
    };
  }, [compact]);

  useEffect(() => { candlesRef.current = candles; }, [candles]);

  /*
    29 Okt 2026 (fix) · dengan `autoSize: false` (lihat cleanup di bawah),
    chart tidak lagi mengikuti ukuran host secara otomatis. Ukurannya
    diteruskan manual dari state `size` (diisi ResizeObserver pada host).
    Tanpa ini chart akan memakai ukuran default 600x440 dan tidak
    mengikuti panel yang di-resize.
  */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.applyOptions({ autoSize: false, width: Math.max(1, Math.round(size.w)), height: Math.max(1, Math.round(size.h)) });
    } catch { /* chart sudah di-dispose */ }
  }, [size.w, size.h, chartEpoch]);
  /*
     23 Okt 2026 (BUG FIX GANTI TIMEFRAME): key asal dari state `candles`.
     Tanpa ini, saat TF berubah (mis. 1h -> 5m):
       - effect hydrate jalan dengan `candles` LAMA (data 1h) lalu menulis
         lastDataRef = { key: TF-BARU, candles: TF-LAMA }..canIncrement jadi
         true dan 797 dari 800 bar TF baru TIDAK PERNAH digambar -> chart
         hancur (cuma sisa beberapa bar).
       - loadOlder memakai candlesRef lama -> 800 bar 1h + 499 bar 5m tercampur.
     Sekarang hydrate hanya melukis data yang key-nya cocok.
  */
  const candlesKeyRef = useRef("");
  const loadOlder = useCallback(async () => {
    const first = candlesRef.current[0];
    if (!first || olderLoadingRef.current || !hasMore) return;
    const targetKey = `${panel.symbol}:${panel.interval}`;
    /* 23 Okt 2026: jangan paging bar milik TF/symbol lain. */
    if (candlesKeyRef.current && candlesKeyRef.current !== targetKey) return;
    const range = chartRef.current?.timeScale().getVisibleLogicalRange();
    olderLoadingRef.current = true;
    setOlderLoading(true);
    try {
      const rows = await fetchKlineRows(panel.symbol, apiInterval(panel.interval), 500, first.time * 1000 - 1);
      if (currentPanelKeyRef.current !== targetKey) return; // stale response A cannot paint panel B
      const older = normalizeKlines(rows).filter((c) => c.time < first.time);
      if (!older.length) { setHasMore(false); return; }
      /*
         23 Okt 2026: merge aman. Data lama (TF sebelumnya) tidak boleh ikut:
         sort + dedup by time, dan buang bar yang bukan milik TF aktif.
      */
      const byTime = new Map<number, Candle>();
      for (const c of [...older, ...candlesRef.current]) byTime.set(c.time, c);
      const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
      candlesRef.current = merged;
      setCandles(merged);
      // Keep the user's analysed window stable when an older prefix is prepended.
      if (range) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (currentPanelKeyRef.current === targetKey) chartRef.current?.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
      }));
    } catch { setHasMore(false); }
    finally { olderLoadingRef.current = false; setOlderLoading(false); }
  }, [panel.symbol, panel.interval, hasMore]);
  useEffect(() => { currentPanelKeyRef.current = `${panel.symbol}:${panel.interval}`; loadOlderRef.current = () => void loadOlder(); }, [loadOlder, panel.symbol, panel.interval]);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const key = `${panel.symbol}:${panel.interval}`;
    // 23 Okt 2026: set SEBELUM fetch supaya rAF scrollToRealTime (dan guard
    // loadOlder) tidak melihat key lama.
    currentPanelKeyRef.current = key;
    if (dataKeyRef.current !== key) {
      // Never paint a new symbol's live tick over the previous symbol's OHLC.
      // Clear the series before the first fetch of the new key.
      dataKeyRef.current = key;
      lastDataRef.current = { key: "", candles: [] };
      // 23 Okt 2026: viewport harus ikut di-reset, kalau tidak fitContent()
      // tidak akan dipanggil untuk TF/symbol baru (lastKeyRef masih key lama)
      // -> area kiri chart kosong.
      lastKeyRef.current = "";
      // 23 Okt 2026: ref HARUS ikut dikosongkan sinkron. Kalau tidak, ref
      // masih memegang bar TF lama (mis. 1h) dan loadOlder()/apply() akan
      // mencampur data TF lama dengan TF baru -> chart hancur & bar salah.
      candlesRef.current = [];
      candlesKeyRef.current = "";
      setCandles([]);
      setLivePrice(null);
      setDataState("LOADING");
      candleRef.current?.setData([]);
      volumeRef.current?.setData([]);
      for (const ref of [volSmaRef, rvolRef, emaFastRef, emaSlowRef, rsiRef, atrRef]) {
        try { ref.current?.setData([]); } catch {}
      }
    }
    const load = async (initial: boolean, retry = 0) => {
      if (initial) { setDataState("LOADING"); setError(null); }
      try {
        const rows = await fetchKlineRows(panel.symbol, apiInterval(panel.interval), 800);
        const next = normalizeKlines(rows);
        if (!alive || next.length === 0) throw new Error("NO_CANDLE_DATA");
        setCandles((prev) => {
          const a = prev.at(-1); const b = next.at(-1);
          if (prev.length === next.length && a?.time === b?.time && a?.open === b?.open && a?.high === b?.high && a?.low === b?.low && a?.close === b?.close && a?.volume === b?.volume) return prev;
          // The stream may already be ahead of this REST snapshot for the
          // running bar; keep the fresher bar instead of painting it back.
          if (a && b && a.time === b.time && prev.length === next.length) {
            const fresher = a.volume > b.volume || a.high > b.high || a.low < b.low ? a : b;
            return [...next.slice(0, -1), fresher];
          }
          return next;
        });
        // 23 Okt 2026: tandai data ini milik key aktif.
        candlesKeyRef.current = key;
        setLastSuccess(Date.now());
        setDataState("READY");
        setError(null);
      } catch (e) {
        if (!alive) return;
        if (retry < 2) {
          setDataState("LOADING");
          setError("RETRYING MARKET DATA");
          window.setTimeout(() => { if (alive) void load(false, retry + 1); }, 900 * (retry + 1));
          return;
        }
        setDataState((prev) => prev === "READY" ? "STALE" : "ERROR");
        setError(e instanceof Error ? e.message : "MARKET_DATA_ERROR");
      }
    };
    setHasMore(true);
    void load(true);
    // WS is the normal feed. REST polling is catch-up/fallback only and is
    // slowed to 30s while the stream is healthy; it never replaces the
    // stream as the source of the running bar. The effect depends on the
    // boolean health, not the raw streamState, so the 1s status heartbeat
    // can never recreate/refetch this loop.
    const wsHealthy = streamState === "WS_ACTIVE" || streamState === "WS_QUIET";
    const pollMs = wsHealthy ? 30_000 : active ? 5_000 : 15_000;
    timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(false); }, pollMs);
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [panel.symbol, panel.interval, active, streamState === "WS_ACTIVE" || streamState === "WS_QUIET"]);

  // Hydrate the chart after both the chart instance and the data exist. This
  // also covers a cache hit that resolves before the chart's first layout.
  /*
     23 Okt 2026 (BUG FIX PERGERAKAN): effect ini sebelumnya menulis
     `ref.update(candles.at(-1))` setiap kali `candles` berubah. Karena
     `flush()` men-set state candles tiap tick stream, React re-render ->
     effect ini menimpa HASIL INTERPOLASI dengan close mentah -> candle
     MELOMPAT (tidak natural) dan animasi rAF selalu kalah.

     Perbaikan: bar terakhir TIDAK pernah ditulis ulang lewat jalur ini
     (-> painter terpadu yang menangani animasi). Effect ini hanya:
       - setData() untuk dataset baru / setelah setData([]), atau
       - update() bar BARU saja (time lebih besar dari bar terakhir).
  */
  useEffect(() => {
    const ref = candleRef.current;
    if (!ref || candles.length === 0) return;
    const key = `${panel.symbol}:${panel.interval}`;
    /* 23 Okt 2026: jangan lukis data milik TF/symbol sebelumnya. */
    if (candlesKeyRef.current && candlesKeyRef.current !== key) return;
    const prev = lastDataRef.current;
    const lastCandle = candles.at(-1)!;
    const canIncrement = prev.key === key && prev.candles.length > 0 && candles.length >= prev.candles.length && candles.length - prev.candles.length <= 20;
    const asData = (c: Candle): CandlestickData<UTCTimestamp> => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    if (canIncrement) {
      // Hanya bar BARU yang digambar. Bar terakhir (running bar) digambar
      // oleh painter terpadu -> interpolasi tidak pernah ditimpa.
      const prevLastTime = prev.candles.at(-1)?.time;
      if (prevLastTime !== undefined && lastCandle.time > prevLastTime) {
        for (const c of candles.filter((x) => x.time > prevLastTime)) ref.update(asData(c));
      }
    } else {
      ref.setData(candles.map(asData));
      /*
         23 Okt 2026 (BUG FIX TAMPILAN TF): viewport harus di-RESET saat TF
         berubah, tapi BUKAN dengan fitContent().

         fitContent() memampatkan 800 bar ke dalam lebar chart (~1.4px per
         bar) -> body/wick candle tak terlihat ->chart terlihat "hancur".
         Yang benar: kembalikan zoom ke spacing terbaca (defaultBarSpacing)
         lalu anchor ke bar terakhir (scrollToRealTime).
      */
      if (lastKeyRef.current !== key) {
        lastKeyRef.current = key;
        chartRef.current?.timeScale().applyOptions({ barSpacing: defaultBarSpacing });
        requestAnimationFrame(() => {
          if (currentPanelKeyRef.current === key) {
            chartRef.current?.timeScale().scrollToRealTime();
          }
        });
      }
    }
    lastDataRef.current = { key, candles };
  }, [candles, chartEpoch, panel.symbol, panel.interval]);

  /*
     23 Okt 2026: live last-price overlay.
     BUG LAMA: effect ini menulis `close: price` LANGSUNG ke series setiap
     1 dtk (mark price hub), sehingga:
       (a) overcoming animasi kline -> candle melompat (tidak natural),
       (b) markPrice dicampur ke close kline -> angka TIDAK sama dengan
           Binance (close kline jadi bukan close Binance).
     PERBAIKAN: kline WS adalah sumber kebenaran saat WS_ACTIVE (close =
     close Binance persis). Overlay hanya:
       - fallback saat stream DEGRADED (polling), dan
       - jadi readout live di header, dianimasikan smooth.
  */
  useEffect(() => {
    if (liveTicker?.symbol && liveTicker.symbol !== panel.symbol) { setLivePrice(null); return; }
    const price = Number(liveTicker?.lastPrice ?? liveTicker?.markPrice);
    if (!Number.isFinite(price) || price <= 0 || candles.length === 0) { setLivePrice(null); return; }
    setLivePrice(price);
    // Saat stream sehat, JANGAN sentuh seri candle: close kline harus persis
    // sama dengan Binance. Overlay hanya relevan saat feed kline mati.
    if (streamStateRef.current === "WS_ACTIVE" || streamStateRef.current === "WS_QUIET") return;
    const last = candles.at(-1); const series = candleRef.current;
    if (!last || !series) return;
    const target: Ohlc = {
      open: last.open,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
    requestPaint(last.time, target, last.volume);
  }, [liveTicker?.symbol, liveTicker?.lastPrice, liveTicker?.markPrice, liveTicker?.lastUpdated, candles.length, panel.symbol]);

  /*
     30 Okt 2026: fallback label harga saat stream belum mengirim tick pertama
     (halaman baru dibuka / REST history baru selesai). Begitu tick WS masuk,
     ref sudah terisi dan nilai REST tidak menimpa lagi.
  */
  useEffect(() => {
    const key = `${panel.symbol}:${panel.interval}`;
    if (candlesKeyRef.current && candlesKeyRef.current !== key) return;
    const last = candles.at(-1);
    if (!last) return;
    if (liveBarPriceRef.current == null) liveBarPriceRef.current = last.close;
    if (liveBarCloseTimeRef.current == null) liveBarCloseTimeRef.current = last.time * 1000 + intervalMs(panel.interval);
  }, [candles, panel.symbol, panel.interval]);

  /*
     23 Okt 2026 (Tahap 8): flash arah harga di header panel.
     Feed mark price datang tiap ~1 dtk. Setiap perubahan arah (naik/turun)
     memicu kelas flash-up/flash-down selama ~700ms supaya operator langsung
     melihat tick tanpa harus membaca angka satu per satu. Naik = hijau, turun
     = merah.
     Reset lastMarkRef saat symbol berubah supaya delta tidak dihitung
     lintas symbol (yang akan memunculkan flash palsu).
  */
  useEffect(() => {
    const mark = Number(liveTicker?.markPrice ?? 0);
    if (!Number.isFinite(mark) || mark <= 0) return;
    const prev = lastMarkRef.current;
    lastMarkRef.current = mark;
    if (prev <= 0 || prev === mark) return;
    setTickFlash({ cls: mark > prev ? "flash-up" : "flash-down", at: Date.now() });
  }, [liveTicker?.markPrice, liveTicker?.symbol]);

  useEffect(() => { lastMarkRef.current = 0; }, [panel.symbol]);

  // Indicators are derived only from the same candle series. VISUAL ONLY.
  // Lower panes are lazy: a hidden RSI/ATR must not leave an empty pane.
  useEffect(() => {
    if (!candleRef.current || candles.length === 0) return;
    const chart = chartRef.current;
    if (!chart) return;
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const ind = panel.indicators;
    const setLine = (ref: React.RefObject<ISeriesApi<"Line"> | null>, values: Array<number | null>, visible: boolean) => {
      if (!ref.current) return;
      ref.current.setData(lineData(candles, values));
      ref.current.applyOptions({ visible });
    };
    volumeRef.current?.setData(candles.map((c): HistogramData<UTCTimestamp> => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? "rgba(58,168,242,.45)" : "rgba(242,65,74,.45)" })));
    volumeRef.current?.applyOptions({ visible: ind.volume });
    setLine(volSmaRef, volumeSma(candles, ind.volumeSmaPeriod), ind.volume && ind.volumeSma20);
    setLine(rvolRef, rvol(volumes, 20), ind.volume && ind.rvol20);
    setLine(emaFastRef, ema(closes, ind.emaFast), ind.ema20);
    setLine(emaSlowRef, ema(closes, ind.emaSlow), ind.ema50);
    if (ind.rsi14) {
      if (!rsiRef.current) rsiRef.current = chart.addSeries(LineSeries, { color: "#78c9e8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2);
      setLine(rsiRef, rsi(closes, ind.rsiPeriod), true);
    } else if (rsiRef.current) {
      try { chart.removeSeries(rsiRef.current); } catch {}
      rsiRef.current = null;
    }
    if (ind.atr14) {
      if (!atrRef.current) atrRef.current = chart.addSeries(LineSeries, { color: "#f2c779", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, rsiRef.current ? 3 : 2);
      setLine(atrRef, atr(candles, ind.atrPeriod), true);
    } else if (atrRef.current) {
      try { chart.removeSeries(atrRef.current); } catch {}
      atrRef.current = null;
    }
    try {
      const panes = chart.panes();
      if (panes[1]) panes[1].setHeight(ind.volume ? (compact ? 46 : 72) : 0);
      if (rsiRef.current && panes[2]) panes[2].setHeight(72);
      if (atrRef.current) {
        const idx = rsiRef.current ? 3 : 2;
        if (panes[idx]) panes[idx].setHeight(72);
      }
    } catch { /* pane API may differ across LWC patch versions */ }
  }, [candles, panel.indicators, chartEpoch, compact]);

  /*
     PositionBoxPrimitive renders the read-only engine levels as a
     TradingView-style position box. Manual drawings remain separate and
     cannot mutate these values.
  */
  const setupLevelsRef = useRef<{ entry: number; sl: number | null; tp1: number | null; tp2: number | null } | null>(null);

  // Engine levels are read-only. The position primitive owns the visible box,
  // labels and live shading; this effect only feeds its state.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const p = positions.find((x) => x.symbol === panel.symbol);
    const box = positionBoxRef.current ?? new PositionBoxPrimitive();
    if (!positionBoxRef.current) positionBoxRef.current = box;
    if (attachedSeriesRef.current !== series) {
      if (attachedSeriesRef.current) { try { attachedSeriesRef.current.detachPrimitive(box); } catch {} }
      series.attachPrimitive(box);
      attachedSeriesRef.current = series;
      primitiveReadyRef.current = true;
    }
    const state: PositionBoxState | null = p ? {
      positionId: p.id,
      side: p.side,
      entryPrice: p.entryPrice,
      slPrice: Number.isFinite(p.slPrice ?? NaN) && (p.slPrice ?? 0) > 0 ? (p.slPrice ?? null) : null,
      tp1Price: Number.isFinite(p.tp1Price ?? NaN) && (p.tp1Price ?? 0) > 0 ? (p.tp1Price ?? null) : null,
      tp2Price: Number.isFinite(p.tp2Price ?? NaN) && (p.tp2Price ?? 0) > 0 ? (p.tp2Price ?? null) : null,
      qty: p.qty ?? 0,
      entryTimeSec: p.openedAt ? new Date(p.openedAt).getTime() / 1000 : 0,
    } : null;
    setupLevelsRef.current = state ? { entry: state.entryPrice, sl: state.slPrice, tp1: state.tp1Price, tp2: state.tp2Price } : null;
    box.setPosition(state);
    fitLevelsRef.current = fitLevels;
    box.setFitLevels(fitLevels);
    box.setLastPrice(p?.markPrice ?? livePrice ?? null);
  }, [positions, panel.symbol, chartEpoch, livePrice, fitLevels]);

  useEffect(() => {
    return () => {
      const series = attachedSeriesRef.current ?? candleRef.current;
      const box = positionBoxRef.current;
      if (series && box) { try { series.detachPrimitive(box); } catch {} }
      attachedSeriesRef.current = null;
      primitiveReadyRef.current = false;
      positionBoxRef.current = null;
    };
  }, [compact]);

  useEffect(() => {
    positionBoxRef.current?.setLastPrice(livePrice);
  }, [livePrice]);

  const toXY = useCallback((a: Anchor) => {
    const chart = chartRef.current; const series = candleRef.current;
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(a.time as UTCTimestamp);
    const y = series.priceToCoordinate(a.price);
    return x === null || y === null ? null : { x: Number(x), y: Number(y) };
  }, []);

  const pointAt = (clientX: number, clientY: number): Anchor | null => {
    const host = hostRef.current; const chart = chartRef.current; const series = candleRef.current;
    if (!host || !chart || !series) return null;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left; const y = clientY - rect.top;
    const t = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (t === null || price === null || !Number.isFinite(Number(price)) || Number(price) <= 0) return null;
    return { time: Number(t), price: Number(price) };
  };

  const commit = (next: Drawing[]) => {
    setHistory((h) => [...h.slice(-30), drawings]);
    setFuture([]);
    setDrawings(next);
  };
  const addAnchor = (a: Anchor) => {
    if (tool === "crosshair") { setHover(candles.find((c) => Math.abs(c.time - a.time) < 1) ?? null); return; }
    if (tool === "select") {
      const xy = xyOf(a); const hit = drawings.map((d) => ({ d, dist: drawingDistance(d, xy.x, xy.y, toXY) })).sort((x, y) => x.dist - y.dist)[0];
      setSelectedId(hit && hit.dist <= 18 ? hit.d.id : null);
      return;
    }
    if (tool === "hline") {
      const d: Drawing = { id: crypto.randomUUID(), type: "hline", anchors: [a], color: "#3AA8F2" };
      commit([...drawings, d]); setSelectedId(d.id); return;
    }
    if (draft.length === 0) { setDraft([a]); return; }
    const d: Drawing = { id: crypto.randomUUID(), type: tool, anchors: [draft[0]!, a], color: tool === "rect" ? "#d3c4f2" : "#3AA8F2" };
    commit([...drawings, d]); setDraft([]); setSelectedId(d.id);
  };
  function xyOf(a: Anchor) { return toXY(a) ?? { x: -9999, y: -9999 }; }

  const deleteSelected = () => {
    if (!selectedId) return;
    commit(drawings.filter((d) => d.id !== selectedId)); setSelectedId(null);
  };
  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1]!;
    setFuture((f) => [drawings, ...f].slice(0, 30)); setHistory((h) => h.slice(0, -1)); setDrawings(prev); setSelectedId(null);
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[0]!;
    setHistory((h) => [...h.slice(-30), drawings]); setFuture((f) => f.slice(1)); setDrawings(next); setSelectedId(null);
  };
  const resetAnnotations = () => {
    // Scope is explicit: annotations only. This never calls wallet/ledger/order
    // reset paths. Keep it immediate so the toolbar cannot appear inert.
    commit([]); setDraft([]); setSelectedId(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.key === "Escape") { setDraft([]); setSelectedId(null); setTool("crosshair"); }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) { e.preventDefault(); deleteSelected(); }
      // Keyboard alternative for moving the selected annotation (Alt+Arrow).
      // It updates the UTC-time/price anchor, never an engine SL/TP level.
      if (selectedId && e.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const stepMs = intervalMs(panel.interval);
        const base = candlesRef.current.at(-1)?.close ?? 1;
        setHistory((h) => [...h.slice(-30), drawings]);
        setFuture([]);
        setDrawings((prev) => prev.map((d) => d.id === selectedId ? {
          ...d,
          anchors: d.anchors.map((a, i) => i === 0 ? {
            time: a.time + (e.key === "ArrowRight" ? stepMs / 1000 : e.key === "ArrowLeft" ? -stepMs / 1000 : 0),
            price: a.price * (1 + (e.key === "ArrowUp" ? 0.001 : e.key === "ArrowDown" ? -0.001 : 0)),
          } : a),
        } : d));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "crosshair") return;
    const a = pointAt(e.clientX, e.clientY);
    if (!a) return;
    if (tool === "select" && selectedId) {
      const d = drawings.find((x) => x.id === selectedId);
      if (d) {
        const near = d.anchors.findIndex((anchor) => { const p = toXY(anchor); return p && Math.hypot(p.x - (e.clientX - (hostRef.current?.getBoundingClientRect().left ?? 0)), p.y - (e.clientY - (hostRef.current?.getBoundingClientRect().top ?? 0))) < 14; });
        if (near >= 0) { setHistory((h) => [...h.slice(-30), drawings]); dragRef.current = { id: d.id, anchor: near, start: a }; e.currentTarget.setPointerCapture(e.pointerId); return; }
      }
    }
    addAnchor(a);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const a = pointAt(e.clientX, e.clientY);
    if (!a) return;
    setDrawings((prev) => prev.map((d) => d.id === drag.id ? { ...d, anchors: d.anchors.map((x, i) => i === drag.anchor ? { time: x.time + (a.time - drag.start.time), price: x.price + (a.price - drag.start.price) } : x) } : d));
  };
  const onPointerUp = () => { dragRef.current = null; };
  const visibleDrawings = useMemo(() => drawings.map((d) => ({ ...d, points: d.anchors.map(toXY) })), [drawings, toXY, size, chartEpoch, candles.length]);

  const last = candles.at(-1);
  const chartStatus = dataState === "READY" && lastSuccess && Date.now() - lastSuccess > 45_000 ? "STALE" : dataState;
  const periods = ["1m", "3m", "5m", "15m", "1h", "4h", "1D"];
  const selected = drawings.find((d) => d.id === selectedId);
  return (
    <section className={`chart-panel${active ? " active" : ""}${compact ? " compact" : ""}`} onMouseDown={onSelect}>
      <header className="chart-panel-head">
        <div className="chart-panel-symbol">
          <span className="panel-index">{panel.id.toUpperCase()}</span>
          <select aria-label={`Symbol ${panel.id}`} value={panel.symbol} onClick={(e) => e.stopPropagation()} onChange={(e) => onChange({ symbol: e.target.value.toUpperCase() })}>
            {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select aria-label={`Timeframe ${panel.id}`} value={panel.interval} onClick={(e) => e.stopPropagation()} onChange={(e) => onChange({ interval: e.target.value })}>
            {periods.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="chart-panel-meta">
          <span className={`data-state ${chartStatus.toLowerCase()}`}>{chartStatus === "READY" ? (streamState === "WS_ACTIVE" ? "BINANCE FUTURES · WS REALTIME" : streamState === "WS_QUIET" ? "WS REALTIME · QUIET" : streamState === "DEGRADED" ? "DEGRADED · POLLING FALLBACK" : streamState === "CONNECTING" ? "WS CONNECTING" : "POLLING") : chartStatus}</span>
          {/*
            23 Okt 2026 (Tahap 8 · "semua angka harus hidup"): baris ticker
            Bloomberg-style. Semua angka berasal dari feed futures (mark/24h/vol/
            funding/H-L), bukan placeholder. "·" = feed belum punya data untuk
            field itu, bukan nol.
          */}
          {liveTicker?.symbol === panel.symbol && (
            <span className="panel-ticker">
              <b className={`panel-ticker-mark${tickFlash ? ` ${tickFlash.cls}` : ""}`} key={tickFlash?.at ?? 0}>
                {fmtPrice(Number(liveTicker.markPrice ?? 0) > 0 ? Number(liveTicker.markPrice) : Number(liveTicker.lastPrice ?? 0), tickSize)}
              </b>
              <span className={Number(liveTicker.chg24hPct ?? 0) >= 0 ? "positive" : "negative"}>
                {Number(liveTicker.chg24hPct ?? 0) >= 0 ? "+" : ""}{Number(liveTicker.chg24hPct ?? 0).toFixed(2)}%
              </span>
              <span className="muted">VOL {fmtUsdFull(liveTicker.volume24h ?? 0)}</span>
              <span className={liveTicker.fundingRate === null || liveTicker.fundingRate === undefined ? "muted" : Number(liveTicker.fundingRate) >= 0 ? "positive" : "negative"}>
                FUND {(liveTicker.fundingRate === null || liveTicker.fundingRate === undefined) ? "·" : `${(Number(liveTicker.fundingRate) * 100).toFixed(4)}%`}
              </span>
              <span className="muted">H {fmtPrice(liveTicker.high24h ?? 0, tickSize)} L {fmtPrice(liveTicker.low24h ?? 0, tickSize)}</span>
            </span>
          )}
          {last && <span className="mono tiny muted" ref={ohlcReadoutRef}>O {fmtPrice(last.open, tickSize)} H {fmtPrice(last.high, tickSize)} L {fmtPrice(last.low, tickSize)} C {fmtPrice(last.close, tickSize)}</span>}
          <span className="mono tiny volume-readout">VOL {fmtVol(last?.volume ?? 0)}</span>
          <button className="chart-tool-button" onClick={(e) => { e.stopPropagation(); setIndicatorOpen(!indicatorOpen); }} aria-expanded={indicatorOpen}>INDIKATOR</button>
          <button className={`chart-tool-button${fitLevels ? " active" : ""}`} onClick={(e) => { e.stopPropagation(); const next = !fitLevels; setFitLevels(next); fitLevelsRef.current = next; try { localStorage.setItem("arta.chart.fitLevels", String(next)); } catch {} positionBoxRef.current?.setFitLevels(next); chartRef.current?.priceScale("right").applyOptions({ autoScale: true }); }} aria-pressed={fitLevels}>FIT LEVELS {fitLevels ? "ON" : "OFF"}</button>
          {onExpand && <button className="chart-tool-button" onClick={(e) => { e.stopPropagation(); onExpand(); }} aria-label="Fokus chart">⛶</button>}
        </div>
      </header>
      <div className="chart-tools" role="toolbar" aria-label={`Drawing tools ${panel.id}`}>
        {([
          ["crosshair", "CROSS", "Crosshair"], ["select", "SELECT", "Select / move drawing"], ["hline", "HLINE", "Horizontal price line"],
          ["trend", "TREND", "Trendline"], ["rect", "ZONE", "Rectangle zone"], ["ruler", "RULER", "Measure"],
        ] as const).map(([id, label, title]) => (
          <button key={id} className={tool === id ? "active" : ""} title={title} onClick={(e) => { e.stopPropagation(); setTool(id as Tool); setDraft([]); if (id === "crosshair") setSelectedId(null); }}>{label}</button>
        ))}
        <button onClick={(e) => { e.stopPropagation(); undo(); }} disabled={!history.length} title="Undo">↶</button>
        <button onClick={(e) => { e.stopPropagation(); redo(); }} disabled={!future.length} title="Redo">↷</button>
        <button onClick={(e) => { e.stopPropagation(); deleteSelected(); }} disabled={!selectedId} title="Delete selected">DEL</button>
        <button onClick={(e) => { e.stopPropagation(); resetAnnotations(); }} title="Reset panel annotations">RESET</button>
        <span className="chart-tool-hint" data-tool={tool} data-draft={draft.length}>{tool === "trend" ? "TREND: klik titik 1 lalu titik 2" : tool === "rect" ? "ZONE: klik dua sudut" : tool === "ruler" ? "RULER: klik dua titik" : tool === "hline" ? "HLINE: klik satu harga" : tool === "select" ? "SELECT: klik objek, lalu DEL/geser" : "CROSS: chart bebas zoom/pan"} · {draft.length ? `${draft.length}/2 TITIK · ` : ""}{drawings.length} ANOTASI</span>
      </div>
      {indicatorOpen && (
        <div className="indicator-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Indikator chart">
          <div className="indicator-title">INDIKATOR <span>VISUAL ONLY</span></div>
          {([
            ["volume", "Volume Binance"], ["volumeSma20", `Volume SMA${panel.indicators.volumeSmaPeriod}`], ["rvol20", "RVOL20"],
            ["ema20", `EMA${panel.indicators.emaFast}`], ["ema50", `EMA${panel.indicators.emaSlow}`], ["rsi14", `RSI${panel.indicators.rsiPeriod}`], ["atr14", `ATR${panel.indicators.atrPeriod}`],
          ] as const).map(([key, label]) => (
            <label key={key}><input type="checkbox" checked={Boolean(panel.indicators[key])} onChange={(e) => onChange({ indicators: { ...panel.indicators, [key]: e.target.checked } })} /> {label}</label>
          ))}
          <div className="indicator-periods">
            <label>EMA fast <input type="number" min="2" max="200" value={panel.indicators.emaFast} onChange={(e) => onChange({ indicators: { ...panel.indicators, emaFast: Math.max(2, Math.min(200, Number(e.target.value) || 20)) } })} /></label>
            <label>EMA slow <input type="number" min="3" max="300" value={panel.indicators.emaSlow} onChange={(e) => onChange({ indicators: { ...panel.indicators, emaSlow: Math.max(3, Math.min(300, Number(e.target.value) || 50)) } })} /></label>
            <label>RSI <input type="number" min="2" max="50" value={panel.indicators.rsiPeriod} onChange={(e) => onChange({ indicators: { ...panel.indicators, rsiPeriod: Math.max(2, Math.min(50, Number(e.target.value) || 14)) } })} /></label>
            <label>ATR <input type="number" min="2" max="50" value={panel.indicators.atrPeriod} onChange={(e) => onChange({ indicators: { ...panel.indicators, atrPeriod: Math.max(2, Math.min(50, Number(e.target.value) || 14)) } })} /></label>
          </div>
          <div className="indicator-source">Sumber candle + volume: Binance USDⓈ-M public klines. Tidak mengubah evaluator.</div>
        </div>
      )}
      <div className="chart-canvas-wrap" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div ref={hostRef} className="chart-canvas-host" />
        {/* Label harga terakhir + countdown candle (ala Binance/TradingView) */}
        <LastPriceTag
          seriesRef={candleRef}
          priceRef={liveBarPriceRef}
          closeTimeRef={liveBarCloseTimeRef}
          tickSize={tickSize}
          height={size.h}
          resetKey={`${panel.symbol}:${panel.interval}`}
        />
        {tool !== "crosshair" && <div className="chart-draw-layer" aria-label="Drawing canvas" />}
        <svg className="chart-draw-svg" width={size.w} height={size.h} aria-hidden="true">
          {/*
            23 Okt 2026: Entry/SL/TP ditampilkan via price line tipis TradingView-style
            (lihat useEffect di bawah) · bukan zone <rect> besar. Di sini hanya
            gambar anotasi manual (hline, rect, trendline, ruler, dll).
          */}
          {visibleDrawings.map((d) => {
            const pts = d.points;
            if (!pts.length) return null;
            const selectedLine = d.id === selectedId;
            const stroke = selectedLine ? "#3AA8F2" : d.color;
            if (d.type === "hline" && pts[0]) return <g key={d.id}><line x1={0} x2={size.w} y1={pts[0].y} y2={pts[0].y} stroke={stroke} strokeWidth={selectedLine ? 2 : 1} strokeDasharray={selectedLine ? "4 3" : "none"} /><text x={size.w - 8} y={pts[0].y - 4} textAnchor="end" fill="#3AA8F2" fontSize="11" fontFamily="monospace">H {fmtPrice(d.anchors[0]?.price, tickSize)}</text></g>;
            if (d.type === "rect" && pts[0] && pts[1]) {
              const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
              return <g key={d.id}><rect x={x} y={y} width={Math.abs(pts[1].x - pts[0].x)} height={Math.abs(pts[1].y - pts[0].y)} fill="rgba(211,196,242,.08)" stroke={stroke} strokeWidth={selectedLine ? 2 : 1} /></g>;
            }
            if ((d.type === "trend" || d.type === "ruler") && pts[0] && pts[1]) {
              const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
              const pct = d.anchors[0]?.price ? ((d.anchors[1]!.price - d.anchors[0].price) / d.anchors[0].price) * 100 : 0;
              return <g key={d.id}><line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={stroke} strokeWidth={selectedLine ? 2 : 1} />{d.type === "ruler" && <text x={midX + 6} y={midY - 6} fill="#f3eddf" fontSize="11" fontFamily="monospace">{pct >= 0 ? "+" : ""}{pct.toFixed(2)}% · {Math.round(Math.abs(d.anchors[1]!.time - d.anchors[0]!.time) / (intervalMs(panel.interval) / 1000))} bars</text>}</g>;
            }
            return null;
          })}
          {draft[0] && toXY(draft[0]) && <circle cx={toXY(draft[0])!.x} cy={toXY(draft[0])!.y} r="3" fill="#3AA8F2" />}
          {selected && <circle cx={toXY(selected.anchors[0]!)?.x ?? 0} cy={toXY(selected.anchors[0]!)?.y ?? 0} r="5" fill="none" stroke="#f3eddf" strokeWidth="1" />}
        </svg>
        {hover && <div className="chart-ohlc-float">O {fmtPrice(hover.open, tickSize)} · H {fmtPrice(hover.high, tickSize)} · L {fmtPrice(hover.low, tickSize)} · C {fmtPrice(hover.close, tickSize)} · VOL {fmtVol(hover.volume)} · TAKER BUY {fmtVol(hover.takerBuyBase)} · SELL {fmtVol(Math.max(0, hover.volume - hover.takerBuyBase))}</div>}
        {dataState !== "READY" && <div className={`chart-state-overlay ${dataState.toLowerCase()}`}>{dataState === "LOADING" ? "Memuat candle Binance…" : error ?? "Data pasar tidak tersedia"}</div>}
      </div>
      <footer className="chart-panel-foot"><span>Binance USDⓈ-M public klines · {streamState} · {candles.length} BARS · TB/TS dari field taker</span><span>{lastSuccess ? `LAST OK ${new Date(lastSuccess).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })} WIB` : "BELUM ADA DATA"}</span><span>{positionFooterLabel(positions.find((p) => p.symbol === panel.symbol)?.mode, positions.some((p) => p.symbol === panel.symbol))}</span><button className="chart-tool-button" onClick={(e) => { e.stopPropagation(); void loadOlder(); }} disabled={olderLoading || !hasMore} title="Muat history lebih lama">{olderLoading ? "LOADING…" : hasMore ? "OLDER" : "NO OLDER DATA"}</button></footer>
    </section>
  );
}
