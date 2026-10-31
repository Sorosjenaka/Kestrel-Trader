// Deterministic chart-only math. None of these functions feed the trading
// evaluator or mutate policy; the chart labels them VISUAL ONLY.
export interface Candle {
  time: number; // UTC seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  takerBuyBase: number;
  takerBuyQuote: number;
}

export function normalizeKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const time = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) continue;
    if (time < 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < Math.max(open, close) || low > Math.min(open, close)) continue;
    const seconds = Math.floor(time / 1000);
    if (out.length && seconds <= out[out.length - 1]!.time) continue;
    out.push({
      time: seconds, open, high, low, close, volume,
      quoteVolume: Number(row[7]) || 0,
      takerBuyBase: Number(row[9]) || 0,
      takerBuyQuote: Number(row[10]) || 0,
    });
  }
  return out;
}

export function sma(values: number[], period: number): Array<number | null> {
  if (period <= 0) return values.map(() => null);
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function rvol(values: number[], period = 20): Array<number | null> {
  return values.map((v, i) => {
    if (i < period) return null;
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += values[j]!;
    const mean = sum / period;
    return mean > 0 ? v / mean : null;
  });
}

export function ema(values: number[], period: number): Array<number | null> {
  if (period <= 0) return values.map(() => null);
  const out: Array<number | null> = [];
  let prev: number | null = null;
  const alpha = 2 / (period + 1);
  for (const v of values) {
    prev = prev === null ? v : prev + alpha * (v - prev);
    out.push(prev);
  }
  return out;
}

function wilder(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  let seed: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    if (prev === null) {
      seed.push(v);
      if (seed.length === period) prev = seed.reduce((a, b) => a + b, 0) / period;
      out.push(prev);
    } else {
      prev = (prev * (period - 1) + v) / period;
      out.push(prev);
    }
  }
  return out;
}

export function rsi(closes: number[], period = 14): Array<number | null> {
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = wilder(gains, period);
  const al = wilder(losses, period);
  const out: Array<number | null> = [null];
  for (let i = 0; i < ag.length; i++) {
    const g = ag[i]; const l = al[i];
    if (g === null || l === null) { out.push(null); continue; }
    if (g === 0 && l === 0) out.push(50); // flat market is neutral, not zero/100
    else if (l === 0) out.push(100);
    else if (g === 0) out.push(0);
    else out.push(100 - 100 / (1 + g / l));
  }
  return out;
}

export function atr(candles: Candle[], period = 14): Array<number | null> {
  const tr = candles.map((c, i) => {
    if (!i) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return wilder(tr, period);
}

export function volumeSma(candles: Candle[], period = 20): Array<number | null> {
  return sma(candles.map((c) => c.volume), period);
}

export function quoteVolume(c: Candle): number {
  return c.quoteVolume > 0 ? c.quoteVolume : c.volume * c.close;
}

export function candleBodyDirection(c: Candle): "UP" | "DOWN" | "FLAT" {
  return c.close > c.open ? "UP" : c.close < c.open ? "DOWN" : "FLAT";
}

/** Binance taker-buy is a subset of executed base volume. Never double count. */
export function takerSellBase(c: Candle): number {
  return Math.max(0, c.volume - c.takerBuyBase);
}
