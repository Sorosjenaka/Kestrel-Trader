// apps/server/src/lab/labIndicators.ts — Indikator deterministik untuk Lab (CP-7).
// Self-check gate: setiap indikator punya implementasi lambat pembanding (T-30).
import { sma, emaSeries, rsiSeries } from "../engines/indicatorLibrary.js";

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

/** ATR Wilder (Wilder smoothing = RMA). tr[0] = high-low (bukan NaN). */
export function atrSeries(bars: Bar[], period: number): number[] {
  const n = bars.length;
  const atr: number[] = new Array(n).fill(NaN);
  if (n === 0 || period <= 0) return atr;
  const tr: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) tr.push(bars[0].h - bars[0].l);
    else tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  // seed = SMA pertama, sisanya Wilder
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i < period - 1) { acc += tr[i]; continue; }
    if (i === period - 1) { acc += tr[i]; atr[i] = acc / period; continue; }
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/** MACD: EMA(fast) - EMA(slow), signal = EMA(signal) dari MACD, hist = macd - signal. */
export function macdSeries(bars: Bar[], fast = 12, slow = 26, signalP = 9): { macd: number[]; signal: number[]; hist: number[] } {
  const closes = bars.map((b) => b.c);
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macd = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  // EMA dari MACD, dihitung ulang dari array MACD (NaN-safe pada masa warmup)
  const signal = emaSeries(macd.map((v) => (Number.isFinite(v) ? v : 0)), signalP)
    .map((v, i) => (Number.isFinite(macd[i]) ? v : NaN));
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
}

/** Bollinger: basis SMA(period), dev = stdev populasi (ddof=0, sesuai Pine). */
export function bbSeries(bars: Bar[], period = 20, mult = 2): { upper: number[]; lower: number[]; basis: number[] } {
  const closes = bars.map((b) => b.c);
  const basis = closes.map((_, i) => (i >= period - 1 ? sma(closes.slice(i - period + 1, i + 1), period) : NaN)) as number[];
  const upper = basis.map((b, i) => {
    if (!Number.isFinite(b)) return NaN;
    const win = closes.slice(i - period + 1, i + 1);
    const mean = b;
    const variance = win.reduce((a, v) => a + (v - mean) ** 2, 0) / period; // populasi
    return b + mult * Math.sqrt(variance);
  });
  const lower = basis.map((b, i) => {
    if (!Number.isFinite(b)) return NaN;
    const win = closes.slice(i - period + 1, i + 1);
    const mean = b;
    const variance = win.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    return b - mult * Math.sqrt(variance);
  });
  return { upper, lower, basis };
}

/** RSI/EMA/SMA dibungkus agar satu pintu. */
export const rsi = (b: Bar[], p: number) => rsiSeries(b.map((x) => x.c), p);
export const ema = (b: Bar[], p: number) => emaSeries(b.map((x) => x.c), p);
export const smaLine = (b: Bar[], p: number) => b.map((_, i) => (i >= p - 1 ? sma(b.slice(i - p + 1, i + 1).map((x) => x.c), p) : NaN)) as number[];

// ── Implementasi LAMBAT PEMBANDING (gate validasi T-30) ──
// Loop jujur tanpa trik: dipakai test untuk memvalidasi seri cepat (tol 1e-9).

export function rsiSlow(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function emaSlow(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function atrSlow(bars: Bar[], period: number): number[] {
  const n = bars.length;
  const out: number[] = new Array(n).fill(NaN);
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    trs.push(i === 0 ? bars[0].h - bars[0].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  if (n < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += trs[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}
