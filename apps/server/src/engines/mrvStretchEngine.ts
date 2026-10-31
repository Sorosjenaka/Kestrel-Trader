// apps/server/src/engines/mrvStretchEngine.ts
// MESIN S-04 — MEAN-REVERSION STRETCH + TREND GATE (spek:
// docs/S-04-mrv-stretch-trend-gate.md; port "Adaptive Dual Engine - Momentum +
// Mean Reversion [BT]" patelanishp, mode Mean Reversion).
//
// Mesin deterministik murni (tanpa I/O, tanpa LLM, tanpa angka uang) yang
// mengevaluasi gate entry S-04 pada close bar 5m yang SUDAH TUTUP:
//   LONG : close < EMA40 - 0.5*ATR14   DAN RSI2 < 15
//          DAN close > EMA200          DAN D_CLOSE > D_EMA50
//   SHORT: close > EMA40 + 0.5*ATR14   DAN RSI2 > 85
//          DAN close < EMA200          DAN D_CLOSE < D_EMA50
// Semua kondisi harus TRUE bersamaan; tidak ada syarat jam/menit/kalender —
// sinyal valid 24/7 termasuk weekend (spek §3). Tidak ada filter sesi apa pun
// di modul ini; satu-satunya pemakaian waktu adalah batas tutup bar/hari UTC
// (aturan ANTI-REPAINT di bawah).
//
// ATURAN ANTI-REPAINT (wajib, spek §1):
//  - D_CLOSE / D_EMA50 diambil HANYA dari candle harian UTC yang SUDAH TUTUP
//    (hari yang sedang berjalan TIDAK PERNAH dipakai — terbukti 0 perubahan
//    nilai intra-hari pada 2.465 batas hari).
//  - Bar 5m yang sedang berjalan tidak dipakai untuk deteksi (includeLastBar
//    hanya untuk data backtest yang semuanya sudah tutup) — sama seperti
//    fibRetracementEngine.
//  - Deret indikator pada indeks i hanya membaca bar <= i (anti-lookahead).
//
// EXIT (spek §4 — TIDAK BERUBAH, model ArtaTrade): R = 1.0 * ATR14 pada bar
// sinyal (k=1, permintaan operator "trade cepat"), SL = entry -/+ 1.0R,
// TP = entry +/- 1.5R, single target 100%. Angka resmi tp1R ada di
// setupEngine (rrByMode/strategyGateOverrides = 1.5); konstanta di sini hanya
// referensi (preseden: FIB_RR di fibRetracementEngine). Bila SL dan TP sama-
// sama tersentuh dalam satu bar, scan melaporkan DUA kasus (sl_first dan
// tp_first) seperti format backtest S-03 (spek §4).
//
// Posisi: SATU posisi dalam satu waktu (no pyramiding, spek §3) — ditegakkan
// scanMrvStretch; sinyal yang muncul saat posisi masih terbuka dihitung
// (skippedSignals) tetapi tidak pernah membuka posisi kedua.
import type { Bar } from "../universe/eligibility.js";
import { emaSeries, rsiSeries } from "./indicatorLibrary.js";
import { calculateAtrSeries } from "./regimeTrendEngine.js";

// ── Parameter pra-registrasi riset (spek §1-§4) ──────────────────────────────
/** EMA cepat pada close 5m. */
export const MRV_EMA_FAST = 40;
/** EMA lambat = filter tren pada close 5m. */
export const MRV_EMA_SLOW = 200;
/** RSI jangka pendek (Wilder). */
export const MRV_RSI_PERIOD = 2;
/** LONG butuh RSI2 < ambang ini (oversold ekstrem). */
export const MRV_RSI_LONG_MAX = 15;
/** SHORT butuh RSI2 > ambang ini (overbought ekstrem). */
export const MRV_RSI_SHORT_MIN = 85;
/** ATR Wilder pada 5m. */
export const MRV_ATR_PERIOD = 14;
/** Stretch = 0.5 * ATR14 menjauh dari EMA40. */
export const MRV_STRETCH_ATR = 0.5;
/** k=1 (spek §5): R = 1.0 * ATR14 pada bar sinyal. */
export const MRV_K = 1.0;
/** SL = 1.0R (model ArtaTrade). */
export const MRV_SL_R = 1.0;
/** TP = 1.7R, single target 100% (model ArtaTrade; angka resmi di setupEngine).
 *  11 Okt 2026 — perintah operator: TP 1.7R (sebelumnya 1.5R). */
export const MRV_TP_R = 1.7;
/** EMA pada close harian UTC (bar yang SUDAH TUTUP). */
export const MRV_DAILY_EMA = 50;
/** Batas minimum bar 5m tertutup: seed EMA200 (SMA(period) ala Pine). */
export const MRV_MIN_M5_BARS = MRV_EMA_SLOW;
/** Batas minimum hari UTC lengkap untuk seed D_EMA50. */
export const MRV_MIN_DAILY_BARS = MRV_DAILY_EMA;

export const MRV_DAY_MS = 86_400_000;
const MRV_DEFAULT_INTERVAL_MS = 300_000;

export interface MrvStretchInput {
  /** Seri bar 5m ascending (openTime naik). */
  m5Bars: Bar[];
  /**
   * Opsional: bar harian UTC dari feed klines 1d. Bila tidak diberikan, bar
   * harian di-agregasi dari m5Bars (hari wajib lengkap 288 bar 5m).
   */
  dailyBars?: Bar[];
  /** Waktu keputusan (ms). Default = close bar terakhir pada seri. */
  nowMs?: number;
  /** Interval bar 5m (default 300_000). */
  intervalMs?: number;
  /**
   * true = bar terakhir ikut dievaluasi (data backtest yang semuanya sudah
   * tutup). Default false: klines live selalu menyertakan candle berjalan.
   */
  includeLastBar?: boolean;
}

/** Konteks HTF harian (anti-repaint: hanya hari yang SUDAH TUTUP). */
export interface MrvHtf {
  /** Close hari UTC terakhir yang sudah tutup. */
  dClose: number;
  /** EMA(50) pada deret close harian yang sudah tutup. */
  dEma50: number;
  /** Jumlah hari lengkap yang dipakai. */
  closedDays: number;
}

export interface MrvStretchGateResult {
  signal: "LONG" | "SHORT" | null;
  /** Kode alasan deterministik (audit): alasan reject ATAU detail sinyal. */
  reasons: string[];
  /** Indeks bar evaluasi (bar 5m terakhir yang sudah tutup), -1 bila tidak ada. */
  barIndex: number;
  close: number | null;
  ema40: number | null;
  ema200: number | null;
  rsi2: number | null;
  /** ATR14 (Wilder) pada bar sinyal — dasar R = k * ATR14. */
  atr14: number | null;
  htf: MrvHtf | null;
}

export interface MrvStretchSignal {
  barIndex: number;
  side: "LONG" | "SHORT";
}

export interface MrvStretchTrade {
  side: "LONG" | "SHORT";
  signalBarIndex: number;
  /** Fill entry = OPEN bar berikutnya (spek §3). */
  entryBarIndex: number;
  entryPrice: number;
  /** ATR14 pada bar sinyal. */
  atr14: number;
  /** R = MRV_K * ATR14 pada bar sinyal (spek §4). */
  r: number;
  slPrice: number;
  tp1Price: number;
  exitBarIndex: number;
  exitPrice: number;
  outcome: "TP1" | "SL";
  /** true bila SL & TP tersentuh pada bar exit yang sama. */
  ambiguous: boolean;
  /** Kasus kedua untuk bar ambigu (sl_first + tp_first, spek §4). */
  altOutcome: "TP1" | "SL" | null;
  altExitPrice: number | null;
}

export interface MrvStretchScanResult {
  trades: MrvStretchTrade[];
  /** SEMUA sinyal gate (termasuk yang dilewati karena posisi masih buka). */
  signals: MrvStretchSignal[];
  ambiguousBars: number;
  skippedSignalsWhileInPosition: number;
}

interface DailyBucket { openTime: number; open: number; high: number; low: number; close: number; volume: number }

// ── Bar harian UTC (anti-repaint) ────────────────────────────────────────────

/**
 * Agregasi 5m -> harian UTC; HANYA hari yang (a) sudah lewat batas tutupnya
 * (dayEnd <= decisionTime) DAN (b) cakupan bar-nya LENGKAP (288 bar 5m,
 * dimulai tepat di midnight UTC) yang dianggap sah. Hari parsial / sedang
 * berjalan dibuang — tidak pernah masuk D_CLOSE/D_EMA50.
 */
function aggregateCompleteDaily(m5Bars: Bar[], intervalMs: number, decisionTime: number): DailyBucket[] {
  const perDay = MRV_DAY_MS / intervalMs;
  const out: DailyBucket[] = [];
  let bucket = -1;
  let group: Bar[] = [];
  const flush = () => {
    if (bucket < 0) return;
    const dayEnd = bucket + MRV_DAY_MS;
    if (group.length === perDay && group[0]!.openTime === bucket && dayEnd <= decisionTime) {
      out.push({
        openTime: bucket,
        open: group[0]!.open,
        high: Math.max(...group.map((b) => b.high)),
        low: Math.min(...group.map((b) => b.low)),
        close: group[group.length - 1]!.close,
        volume: group.reduce((n, b) => n + b.volume, 0),
      });
    }
  };
  for (const b of m5Bars) {
    const next = Math.floor(b.openTime / MRV_DAY_MS) * MRV_DAY_MS;
    if (next !== bucket) { flush(); group = []; bucket = next; }
    group.push(b);
  }
  flush();
  return out;
}

/** Bar harian dari feed klines 1d: hanya bar midnight-UTC yang sudah tutup. */
function closedDailyFromKlines(dailyBars: Bar[], decisionTime: number): DailyBucket[] {
  const out: DailyBucket[] = [];
  for (const b of dailyBars) {
    const dayStart = Math.floor(b.openTime / MRV_DAY_MS) * MRV_DAY_MS;
    if (b.openTime !== dayStart) continue; // bukan candle harian UTC yang sah
    if (dayStart + MRV_DAY_MS > decisionTime) continue; // hari sedang berjalan -> DILARANG (anti-repaint)
    out.push({ openTime: dayStart, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

interface DailyContext {
  days: DailyBucket[];
  /** dayEnd[k] = batas tutup hari k (exclusive) — kenaikan monotone. */
  dayEnds: number[];
  dCloses: number[];
  /** ema(daily_close, 50) per hari; NaN sebelum seed penuh. */
  dEma50s: number[];
}

function buildDailyContext(input: MrvStretchInput, decisionTime: number, intervalMs: number): DailyContext {
  const days = input.dailyBars && input.dailyBars.length > 0
    ? closedDailyFromKlines(input.dailyBars, decisionTime)
    : aggregateCompleteDaily(input.m5Bars, intervalMs, decisionTime);
  const dayEnds = days.map((d) => d.openTime + MRV_DAY_MS);
  const dCloses = days.map((d) => d.close);
  const dEma50s = emaSeries(dCloses, MRV_DAILY_EMA);
  return { days, dayEnds, dCloses, dEma50s };
}

/** Indeks hari terakhir yang sudah tutup pada/before decisionTime; -1 bila belum ada. */
function lastClosedDayIndex(ctx: DailyContext, decisionTime: number): number {
  let lo = 0, hi = ctx.dayEnds.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.dayEnds[mid]! <= decisionTime) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function htfAt(ctx: DailyContext, decisionTime: number): MrvHtf | null {
  const k = lastClosedDayIndex(ctx, decisionTime);
  if (k < 0) return null;
  const ema50 = ctx.dEma50s[k];
  if (ema50 === undefined || Number.isNaN(ema50)) return null;
  return { dClose: ctx.dCloses[k]!, dEma50: ema50, closedDays: k + 1 };
}

/**
 * Resolusi D_CLOSE / D_EMA50 pada waktu keputusan — aturan anti-repaint spek §1.
 * Konstan di dalam satu hari UTC (hari berjalan tidak pernah dipakai).
 */
export function resolveDailyHtf(input: MrvStretchInput): { htf: MrvHtf | null; reasons: string[] } {
  const intervalMs = input.intervalMs ?? MRV_DEFAULT_INTERVAL_MS;
  const n = input.m5Bars.length;
  const decisionTime = input.nowMs ?? (n > 0 ? input.m5Bars[n - 1]!.openTime + intervalMs : 0);
  const reasons: string[] = [];
  const ctx = buildDailyContext(input, decisionTime, intervalMs);
  if (ctx.days.length < MRV_MIN_DAILY_BARS) {
    reasons.push("MRV_INSUFFICIENT_DAILY_BARS");
    return { htf: null, reasons };
  }
  const htf = htfAt(ctx, decisionTime);
  if (!htf) {
    reasons.push("MRV_HTF_UNAVAILABLE");
    return { htf: null, reasons };
  }
  return { htf, reasons };
}

// ── Gate entry (spek §2) ─────────────────────────────────────────────────────

/** Indeks bar evaluasi: bar 5m terakhir yang SUDAH TUTUP pada nowMs. */
function evaluationBarIndex(bars: Bar[], intervalMs: number, nowMs: number | undefined, includeLastBar: boolean): number {
  const n = bars.length;
  if (n === 0) return -1;
  if (nowMs !== undefined) {
    for (let i = n - 1; i >= 0; i--) if (bars[i]!.openTime + intervalMs <= nowMs) return i;
    return -1;
  }
  return includeLastBar ? n - 1 : n - 2;
}

/**
 * Evaluasi gate S-04 pada close bar 5m yang sudah tutup (spek §2). Semua
 * kondisi LONG/SHORT harus TRUE bersamaan; tanpa syarat jam/kalender.
 */
export function evaluateMrvStretchGate(input: MrvStretchInput): MrvStretchGateResult {
  const intervalMs = input.intervalMs ?? MRV_DEFAULT_INTERVAL_MS;
  const bars = input.m5Bars;
  const empty: MrvStretchGateResult = {
    signal: null, reasons: [], barIndex: -1,
    close: null, ema40: null, ema200: null, rsi2: null, atr14: null, htf: null,
  };
  const end = evaluationBarIndex(bars, intervalMs, input.nowMs, input.includeLastBar ?? false);
  if (end < 0) return { ...empty, reasons: ["MRV_NO_CLOSED_BAR"] };
  if (end + 1 < MRV_MIN_M5_BARS) return { ...empty, barIndex: end, reasons: ["MRV_INSUFFICIENT_M5_BARS"] };

  // Deret indikator dari bar tertutup 0..end (anti-lookahead: nilai pada indeks
  // i hanya membaca bar <= i; seed SMA(period) ala Pine, sama dengan library).
  const closes = bars.slice(0, end + 1).map((b) => b.close);
  const emaFast = emaSeries(closes, MRV_EMA_FAST);
  const emaSlow = emaSeries(closes, MRV_EMA_SLOW);
  const rsi = rsiSeries(closes, MRV_RSI_PERIOD);
  // calculateAtrSeries: atrs[m] menempel pada bar index m + period.
  const atrRaw = calculateAtrSeries(bars.slice(0, end + 1), MRV_ATR_PERIOD);
  const atrAt = (i: number): number | null => {
    const v = atrRaw[i - MRV_ATR_PERIOD];
    return v === undefined || !Number.isFinite(v) ? null : v;
  };

  const decisionTime = input.nowMs ?? bars[end]!.openTime + intervalMs;
  const daily = buildDailyContext(input, decisionTime, intervalMs);
  const htf = htfAt(daily, decisionTime);

  const close = closes[end]!;
  const e40 = emaFast[end];
  const e200 = emaSlow[end];
  const r2 = rsi[end];
  const atr = atrAt(end);
  const base: Omit<MrvStretchGateResult, "signal" | "reasons"> = {
    barIndex: end,
    close,
    ema40: e40 === undefined || Number.isNaN(e40) ? null : e40,
    ema200: e200 === undefined || Number.isNaN(e200) ? null : e200,
    rsi2: r2 === undefined || Number.isNaN(r2) ? null : r2,
    atr14: atr,
    htf,
  };

  const reasons: string[] = [];
  if (!htf) {
    reasons.push(daily.days.length < MRV_MIN_DAILY_BARS ? "MRV_INSUFFICIENT_DAILY_BARS" : "MRV_HTF_UNAVAILABLE");
    return { ...base, signal: null, reasons };
  }
  if (base.ema40 === null || base.ema200 === null || base.rsi2 === null || atr === null) {
    reasons.push("MRV_INSUFFICIENT_M5_BARS");
    return { ...base, signal: null, reasons };
  }

  const stretch = MRV_STRETCH_ATR * atr;
  const longStretch = close < base.ema40 - stretch;
  const longRsi = base.rsi2 < MRV_RSI_LONG_MAX;
  const longTrend = close > base.ema200;
  const longHtf = htf.dClose > htf.dEma50;
  const shortStretch = close > base.ema40 + stretch;
  const shortRsi = base.rsi2 > MRV_RSI_SHORT_MIN;
  const shortTrend = close < base.ema200;
  const shortHtf = htf.dClose < htf.dEma50;

  if (longStretch && longRsi && longTrend && longHtf) {
    return {
      ...base,
      signal: "LONG",
      reasons: [
        "MRV_LONG",
        `MRV_RSI2_${base.rsi2.toFixed(2)}`,
        `MRV_STRETCH_ATR_${((base.ema40 - close) / atr).toFixed(3)}`,
        "MRV_EMA200_TREND_OK",
        `MRV_HTF_D_CLOSE_${htf.dClose.toFixed(8)}`,
        `MRV_HTF_D_EMA50_${htf.dEma50.toFixed(8)}`,
      ],
    };
  }
  if (shortStretch && shortRsi && shortTrend && shortHtf) {
    return {
      ...base,
      signal: "SHORT",
      reasons: [
        "MRV_SHORT",
        `MRV_RSI2_${base.rsi2.toFixed(2)}`,
        `MRV_STRETCH_ATR_${((close - base.ema40) / atr).toFixed(3)}`,
        "MRV_EMA200_TREND_OK",
        `MRV_HTF_D_CLOSE_${htf.dClose.toFixed(8)}`,
        `MRV_HTF_D_EMA50_${htf.dEma50.toFixed(8)}`,
      ],
    };
  }

  if (!longStretch) reasons.push("MRV_LONG_STRETCH_FAIL");
  if (!longRsi) reasons.push("MRV_LONG_RSI_FAIL");
  if (!longTrend) reasons.push("MRV_LONG_EMA200_FAIL");
  if (!longHtf) reasons.push("MRV_LONG_HTF_FAIL");
  if (!shortStretch) reasons.push("MRV_SHORT_STRETCH_FAIL");
  if (!shortRsi) reasons.push("MRV_SHORT_RSI_FAIL");
  if (!shortTrend) reasons.push("MRV_SHORT_EMA200_FAIL");
  if (!shortHtf) reasons.push("MRV_SHORT_HTF_FAIL");
  return { ...base, signal: null, reasons };
}

// ── Scan posisi (uji §7 & reproduksi; exit model ArtaTrade §4) ───────────────

/**
 * Scan deterministik satu seri 5m: entry di OPEN bar setelah sinyal (spek §3),
 * SL 1.0R / TP 1.5R dengan R = k*ATR14 pada bar sinyal (spek §4), SATU posisi
 * dalam satu waktu (FSM kronologis per bar — exit diselesaikan bar per bar,
 * bukan lompat ke depan). Bar yang menyentuh SL dan TP dilaporkan sebagai DUA
 * kasus (sl_first + tp_first). Murni tanpa I/O — dipakai test penerimaan §7 dan
 * reproduksi riset; jalur live memakai funnel plan/risk engine yang ada.
 */
export function scanMrvStretch(input: MrvStretchInput): MrvStretchScanResult {
  const intervalMs = input.intervalMs ?? MRV_DEFAULT_INTERVAL_MS;
  const bars = input.m5Bars;
  const trades: MrvStretchTrade[] = [];
  const signals: MrvStretchSignal[] = [];
  let ambiguousBars = 0;
  let skippedSignalsWhileInPosition = 0;

  const closes = bars.map((b) => b.close);
  const emaFast = emaSeries(closes, MRV_EMA_FAST);
  const emaSlow = emaSeries(closes, MRV_EMA_SLOW);
  const rsi = rsiSeries(closes, MRV_RSI_PERIOD);
  const atrRaw = calculateAtrSeries(bars, MRV_ATR_PERIOD);
  const daily = buildDailyContext(input, input.nowMs ?? MRV_DAY_MS * 365 * 100, intervalMs);

  const lastEval = evaluationBarIndex(bars, intervalMs, input.nowMs, input.includeLastBar ?? true);

  interface OpenPos {
    trade: Omit<MrvStretchTrade, "exitBarIndex" | "exitPrice" | "outcome" | "ambiguous" | "altOutcome" | "altExitPrice">;
  }
  let open: OpenPos | null = null;

  for (let i = 0; i <= lastEval; i++) {
    // 1) Selesaikan exit posisi terbuka pada bar ini (SL/TP intrabar).
    if (open && i >= open.trade.entryBarIndex) {
      const b = bars[i]!;
      const side = open.trade.side;
      const slHit = side === "LONG" ? b.low <= open.trade.slPrice : b.high >= open.trade.slPrice;
      const tpHit = side === "LONG" ? b.high >= open.trade.tp1Price : b.low <= open.trade.tp1Price;
      if (slHit || tpHit) {
        const ambiguous = slHit && tpHit;
        if (ambiguous) ambiguousBars++;
        // Kasus pesimis (sl_first) sebagai outcome utama; kasus kedua dicatat
        // terpisah (spek §4: laporkan DUA kasus seperti format backtest S-03).
        const outcome: "TP1" | "SL" = ambiguous || slHit ? "SL" : "TP1";
        trades.push({
          ...open.trade,
          exitBarIndex: i,
          exitPrice: outcome === "SL" ? open.trade.slPrice : open.trade.tp1Price,
          outcome,
          ambiguous,
          altOutcome: ambiguous ? "TP1" : null,
          altExitPrice: ambiguous ? open.trade.tp1Price : null,
        });
        open = null;
      }
    }

    // 2) Gate pada close bar i (hanya bar <= i; HTF harian yang sudah tutup).
    const close = closes[i]!;
    const e40 = emaFast[i], e200 = emaSlow[i], r2 = rsi[i];
    const atr = atrRaw[i - MRV_ATR_PERIOD];
    if (e40 === undefined || Number.isNaN(e40) || e200 === undefined || Number.isNaN(e200)
        || r2 === undefined || Number.isNaN(r2) || atr === undefined || !Number.isFinite(atr)) continue;
    const decisionTime = bars[i]!.openTime + intervalMs;
    const htf = htfAt(daily, decisionTime);
    if (!htf) continue;

    const stretch = MRV_STRETCH_ATR * atr;
    let side: "LONG" | "SHORT" | null = null;
    if (close < e40 - stretch && r2 < MRV_RSI_LONG_MAX && close > e200 && htf.dClose > htf.dEma50) side = "LONG";
    else if (close > e40 + stretch && r2 > MRV_RSI_SHORT_MIN && close < e200 && htf.dClose < htf.dEma50) side = "SHORT";
    if (!side) continue;

    // 3) Sinyal tercatat apa adanya; posisi baru hanya saat flat (no pyramiding).
    signals.push({ barIndex: i, side });
    if (open) { skippedSignalsWhileInPosition++; continue; }
    const entryBar = bars[i + 1];
    if (!entryBar) continue; // tidak ada bar berikutnya untuk fill (spek §3)

    const r = MRV_K * atr;
    const entryPrice = entryBar.open;
    const slPrice = side === "LONG" ? entryPrice - MRV_SL_R * r : entryPrice + MRV_SL_R * r;
    const tp1Price = side === "LONG" ? entryPrice + MRV_TP_R * r : entryPrice - MRV_TP_R * r;
    open = {
      trade: {
        side, signalBarIndex: i, entryBarIndex: i + 1, entryPrice,
        atr14: atr, r, slPrice, tp1Price,
      },
    };
  }

  return { trades, signals, ambiguousBars, skippedSignalsWhileInPosition };
}
