// apps/server/src/strategies/researchSwing/rswPrimitives.ts — T0.5 (18 Okt 2026).
//
// Port TypeScript dari primitif numerik riset Python yang FROZEN, untuk evaluator
// RSW-01/02/03. Setiap fungsi adalah translasi langsung (baris-demi-baris) dari
// modul riset agar hasil numerik identik. Modul sumber (oracle parity):
//   - additional_gold_nal.py   : atr_series (Pine ta.atr), nal_spectrum, supertrend_directions
//   - swing_confluence_candidates.py : ema
//   - swing_v2_features.py     : aggregate, rma, context, HOUR
//   - swing_v27_daily_regime.py: daily_regime
//   - swing_v18_features.py    : profile
//   - swing_v24_entries.py     : equal_sweep
//   - additional_phen_algo.py  : algo_events
//   - swing_v5_ev_gate.py      : vector, ridge
//
// ATURAN PARITY: jangan "memperbaiki" rumus. Seed EMA dari nilai pertama; ATR =
// SMA-seeded Wilder RMA pada True Range (Pine); ADX via RMA. Semua ditulis agar
// output cocok dengan Python pada fixture riset (lihat rswParity.test.ts).

/** Satu bar OHLCV. time = epoch ms open bar. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const STEP = 4 * HOUR; // H4

/** EMA dengan seed dari nilai pertama (bukan SMA). `value = current` saat seed. */
export function ema(values: number[], length: number): number[] {
  const result: number[] = [];
  let value: number | null = null;
  const alpha = 2 / (length + 1);
  for (const current of values) {
    value = value === null ? current : value + alpha * (current - value);
    result.push(value);
  }
  return result;
}

/** Wilder RMA. Seed = mean `length` nilai pertama, lalu smoothing (n-1)/n. */
export function rma(values: (number | null)[], length: number): (number | null)[] {
  const output: (number | null)[] = [];
  const seed: number[] = [];
  let previous: number | null = null;
  for (const x of values) {
    if (x === null || x === undefined) {
      output.push(null);
      continue;
    }
    if (previous === null) {
      seed.push(x);
      if (seed.length === length) previous = seed.reduce((a, b) => a + b, 0) / length;
    } else {
      previous = (previous * (length - 1) + x) / length;
    }
    output.push(previous);
  }
  return output;
}

/**
 * Pine `ta.atr`: True Range lalu SMA-seeded Wilder RMA.
 * Bar pertama TR = high-low (tanpa prior close). Seed memakai fsum (exact) di
 * Python; di sini memakai compensated sum agar mendekati bit-exact.
 */
export function atrSeries(bars: Bar[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  const seed: number[] = [];
  let previous: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    let tr = bar.high - bar.low;
    if (i) {
      const priorClose = bars[i - 1]!.close;
      tr = Math.max(tr, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    }
    if (previous === null) {
      seed.push(tr);
      if (seed.length === length) previous = fsum(seed) / length;
    } else {
      previous = (previous * (length - 1) + tr) / length;
    }
    result[i] = previous;
  }
  return result;
}

/** Compensated (Neumaier) sum — mendekati Python `math.fsum` untuk seed ATR. */
function fsum(values: number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of values) {
    const t = sum + x;
    if (Math.abs(sum) >= Math.abs(x)) c += sum - t + x;
    else c += x - t + sum;
    sum = t;
  }
  return sum + c;
}

/**
 * Agregasi sub-bar 15m ke interval yang lebih besar (H1/H4/D1).
 * Translasi langsung `aggregate` di swing_v2_features.py: grup per bucket interval,
 * hanya terima grup yang LENGKAP (jumlah sub-bar = interval/15m, berurutan).
 */
export function aggregate(rows: Bar[], interval: number): Bar[] {
  const groups = new Map<number, Bar[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.time / interval) * interval;
    let g = groups.get(bucket);
    if (!g) {
      g = [];
      groups.set(bucket, g);
    }
    g.push(row);
  }
  const result: Bar[] = [];
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const need = interval / 900_000;
  for (const time of keys) {
    const items = groups.get(time)!;
    if (items.length !== need) continue;
    if (items[0]!.time !== time) continue;
    if (items[items.length - 1]!.time + 900_000 !== time + interval) continue;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const x of items) {
      if (x.high > high) high = x.high;
      if (x.low < low) low = x.low;
      volume += x.volume;
    }
    result.push({
      time,
      open: items[0]!.open,
      high,
      low,
      close: items[items.length - 1]!.close,
      volume,
    });
  }
  return result;
}

export interface H4Context {
  time: number;
  bias: number;
  adx: number;
  atr: number;
}

/**
 * Konteks H4: bias EMA50/EMA200 + ADX14. Timestamp = bar.time + 4*HOUR.
 * Translasi `context` di swing_v2_features.py.
 */
export function context(bars: Bar[]): H4Context[] {
  const closes = bars.map((b) => b.close);
  const fast = ema(closes, 50);
  const slow = ema(closes, 200);
  const atr = atrSeries(bars, 14);
  const plus = [0];
  const minus = [0];
  for (let i = 1; i < bars.length; i++) {
    const u = bars[i]!.high - bars[i - 1]!.high;
    const d = bars[i - 1]!.low - bars[i]!.low;
    plus.push(u > d && u > 0 ? u : 0);
    minus.push(d > u && d > 0 ? d : 0);
  }
  const p = rma(plus, 14);
  const m = rma(minus, 14);
  const dx: (number | null)[] = p.map((a, i) => {
    const b = m[i]!;
    if (a === null || a === undefined) return null;
    return a + b ? (100 * Math.abs(a - b)) / (a + b) : 0;
  });
  const adx = rma(dx, 14);
  const result: H4Context[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    let sign = 0;
    if (b.close > fast[i]! && fast[i]! > slow[i]! && i >= 3 && fast[i]! > fast[i - 3]!) sign = 1;
    else if (b.close < fast[i]! && fast[i]! < slow[i]! && i >= 3 && fast[i]! < fast[i - 3]!) sign = -1;
    result.push({
      time: b.time + 4 * HOUR,
      bias: sign,
      adx: adx[i] ?? 0,
      atr: atr[i] ?? 0,
    });
  }
  return result;
}

export interface DailyRegime {
  availableAt: number;
  bias: number;
  close: number;
  ema50: number;
  ema200: number;
  closedDailyBars: number;
}

/** Bias regime BTC D1 (EMA50/EMA200). Translasi `daily_regime` di swing_v27_daily_regime.py. */
export function dailyRegime(bars: Bar[]): DailyRegime[] {
  const closes = bars.map((b) => b.close);
  const fast = ema(closes, 50);
  const slow = ema(closes, 200);
  const result: DailyRegime[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 199) continue;
    let bias = 0;
    if (closes[i]! > fast[i]! && fast[i]! > slow[i]! && fast[i]! > fast[i - 3]!) bias = 1;
    else if (closes[i]! < fast[i]! && fast[i]! < slow[i]! && fast[i]! < fast[i - 3]!) bias = -1;
    result.push({
      availableAt: bars[i]!.time + DAY,
      bias,
      close: closes[i]!,
      ema50: fast[i]!,
      ema200: slow[i]!,
      closedDailyBars: i + 1,
    });
  }
  return result;
}

export interface NalRow {
  state: number;
  composite: number | null;
  momenta: number[] | null;
}

/**
 * NAL momentum spectrum (horizon golden-ratio 12/medium/slow, stdev30, agreement).
 * Translasi `nal_spectrum` di additional_gold_nal.py.
 */
export function nalSpectrum(closes: number[]): NalRow[] {
  const phi = (1 + Math.sqrt(5)) / 2;
  const medium = Math.max(13, Math.floor(12 * phi + 0.5));
  const slow = Math.max(medium + 1, Math.floor(medium * phi + 0.5));
  const horizons = [12, medium, slow];
  const weightSum = phi * phi + phi + 1;
  const weights = [(phi * phi) / weightSum, phi / weightSum, 1 / weightSum];
  const returns: (number | null)[] = [null];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i]! / closes[i - 1]!));
  let state = 0;
  const rows: NalRow[] = [];
  const maxNeed = Math.max(30, slow);
  for (let i = 0; i < closes.length; i++) {
    let momenta: number[] | null = null;
    let composite: number | null = null;
    if (i >= maxNeed) {
      const win = returns.slice(i - 29, i + 1);
      const mean = win.reduce<number>((a, b) => a + (b ?? 0), 0) / 30;
      const sigma = Math.sqrt(win.reduce<number>((a, b) => a + ((b ?? 0) - mean) ** 2, 0) / 30);
      if (sigma > 0) {
        momenta = horizons.map(
          (length) => Math.log(closes[i]! / closes[i - length]!) / (sigma * Math.sqrt(length))
        );
        composite = momenta.reduce((a, m, k) => a + m * weights[k]!, 0);
        if (momenta.every((m) => m > 0) && composite > 0.5) state = 1;
        else if (momenta.every((m) => m < 0) && composite < 0) state = -1;
      }
    }
    rows.push({ state, composite, momenta });
  }
  return rows;
}

/**
 * Pine `ta.supertrend` direction: -1 bullish, +1 bearish.
 * Translasi `supertrend_directions` di additional_gold_nal.py.
 */
export function supertrendDirections(bars: Bar[], factor = 3, period = 10): (number | null)[] {
  const atr = atrSeries(bars, period);
  const directions: (number | null)[] = new Array(bars.length).fill(null);
  let previousUpper: number | null = null;
  let previousLower: number | null = null;
  let previousLine: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (atr[i] === null || atr[i] === undefined) continue;
    const mid = (bar.high + bar.low) / 2;
    let upper = mid + factor * atr[i]!;
    let lower = mid - factor * atr[i]!;
    let direction: number;
    if (previousUpper === null) {
      direction = 1;
    } else {
      if (!(lower > previousLower! || bars[i - 1]!.close < previousLower!)) lower = previousLower!;
      if (!(upper < previousUpper || bars[i - 1]!.close > previousUpper)) upper = previousUpper;
      if (previousLine === previousUpper) {
        direction = bar.close > upper ? -1 : 1;
      } else {
        direction = bar.close < lower ? 1 : -1;
      }
    }
    previousUpper = upper;
    previousLower = lower;
    previousLine = direction === -1 ? lower : upper;
    directions[i] = direction;
  }
  return directions;
}

/** Equal extremes sweep (NAMBOU). Translasi `equal_sweep` di swing_v24_entries.py. */
export function equalSweep(prior: Bar[], b: Bar, atr: number): [number, number | null] {
  const low = Math.min(...prior.map((x) => x.low));
  const high = Math.max(...prior.map((x) => x.high));
  const lows = prior.map((x, i) => (x.low <= low + 0.2 * atr ? i : -1)).filter((i) => i >= 0);
  const highs = prior.map((x, i) => (x.high >= high - 0.2 * atr ? i : -1)).filter((i) => i >= 0);
  const clv = (b.close - b.low) / Math.max(b.high - b.low, 1e-12);
  if (lows.length >= 2 && lows[lows.length - 1]! - lows[0]! >= 3 && b.low < low && low < b.close && b.close > b.open && clv >= 0.65)
    return [1, low];
  if (highs.length >= 2 && highs[highs.length - 1]! - highs[0]! >= 3 && b.high > high && high > b.close && b.close < b.open && clv <= 0.35)
    return [-1, high];
  return [0, null];
}

export interface VolumeProfile {
  poc: number;
  val: number;
  vah: number;
  vwap72: number;
  profileVolume: number;
  profileStart: number;
  profileLastClose: number;
}

/**
 * Profil volume 24-bin (typical-price). Translasi `profile` di swing_v18_features.py.
 * rows = [time, open, high, low, close, volume].
 */
export function profile(rows: Bar[], bins = 24): VolumeProfile | null {
  const low = Math.min(...rows.map((r) => r.low));
  const high = Math.max(...rows.map((r) => r.high));
  const width = Math.max((high - low) / bins, 1e-12);
  const weights = new Array(bins).fill(0) as number[];
  for (const r of rows) {
    const typical = (r.high + r.low + r.close) / 3;
    const bucket = Math.min(bins - 1, Math.max(0, Math.floor((typical - low) / width)));
    weights[bucket] += r.volume;
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  // peak: max weight, tie -> lower index (Python key=(weights[k], -k))
  let peak = 0;
  for (let k = 1; k < bins; k++) {
    if (weights[k]! > weights[peak]!) peak = k;
  }
  let left = peak;
  let right = peak;
  let covered = weights[peak]!;
  while (covered < 0.7 * total && (left > 0 || right < bins - 1)) {
    if (right < bins - 1 && (left === 0 || weights[right + 1]! > weights[left - 1]!)) {
      right += 1;
      covered += weights[right]!;
    } else {
      left -= 1;
      covered += weights[left]!;
    }
  }
  const vwap =
    rows.reduce((a, r) => a + ((r.high + r.low + r.close) / 3) * r.volume, 0) / total;
  return {
    poc: low + (peak + 0.5) * width,
    val: low + left * width,
    vah: low + (right + 1) * width,
    vwap72: vwap,
    profileVolume: total,
    profileStart: rows[0]!.time,
    profileLastClose: rows[rows.length - 1]!.time + 900_000,
  };
}

export interface AlgoEdge {
  index: number;
  sign: number;
}

/**
 * AlgoChief rising-edge BUY/SELL. Translasi `algo_events` di additional_phen_algo.py.
 * Hanya memancarkan saat edge (bull naik / bear naik), bukan saat kondisi bertahan.
 */
export function algoEvents(bars: Bar[]): AlgoEdge[] {
  const result: AlgoEdge[] = [];
  let previousBull = false;
  let previousBear = false;
  const changes: number[] = []; // maxlen 10
  const volume10: number[] = []; // maxlen 10
  const volume50: number[] = []; // maxlen 50
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    pushCap(volume10, bar.volume, 10);
    pushCap(volume50, bar.volume, 50);
    if (i) {
      const prev = bars[i - 1]!;
      pushCap(changes, bar.close > prev.close ? 1 : bar.close < prev.close ? -1 : 0, 10);
    }
    let bull = false;
    let bear = false;
    if (i >= 49 && changes.length === 10) {
      const avg50 = volume50.reduce((a, b) => a + b, 0) / 50;
      const volDiff = avg50 > 0 ? ((volume10.reduce((a, b) => a + b, 0) / 10 - avg50) / avg50) * 100 : 0;
      const base = bars[i - 10]!.close;
      const priceChange = base > 0 ? ((bar.close - base) / base) * 100 : 0;
      bull = countSign(changes, 1) >= 7 && volDiff >= 10 && priceChange >= 2;
      bear = countSign(changes, -1) >= 7 && volDiff >= 10 && priceChange <= -2;
    }
    if (bull && !previousBull) result.push({ index: i, sign: 1 });
    if (bear && !previousBear) result.push({ index: i, sign: -1 });
    previousBull = bull;
    previousBear = bear;
  }
  return result;
}

function pushCap(arr: number[], v: number, cap: number): void {
  arr.push(v);
  if (arr.length > cap) arr.shift();
}
function countSign(arr: number[], sign: number): number {
  let n = 0;
  for (const x of arr) if (x === sign) n++;
  return n;
}

/** Fitur model Ridge (11 dimensi). Translasi `vector` di swing_v5_ev_gate.py. */
export function vector(s: {
  side: string;
  close: number;
  mean20: number;
  atr: number;
  priority: number;
  adx: number;
  trend: number;
  entry: number;
  structuralSl: number;
}): number[] {
  const sign = s.side === "LONG" ? 1 : -1;
  const clip = (x: number, a = -3, b = 3) => Math.max(a, Math.min(b, x));
  const mean = clip((sign * (s.close - s.mean20)) / s.atr / 3);
  const vol = clip((s.priority - Math.abs(s.close - s.mean20) / s.atr) / 5 - 1);
  const adx = clip((s.adx - 25) / 25);
  const trend = sign * s.trend;
  return [
    1,
    sign,
    trend,
    adx,
    vol,
    mean,
    clip(s.atr / s.entry / 0.01),
    clip((sign * (s.entry - s.structuralSl)) / s.atr / 3),
    mean * trend,
    adx * trend,
    mean * vol,
  ];
}

/**
 * Solver Ridge (Gaussian elimination dengan partial pivoting).
 * Translasi `ridge` di swing_v5_ev_gate.py. Melempar bila pivot < 1e-12 (assert Python).
 */
export function ridge(xs: number[][], ys: number[], penalty: number): number[] {
  const n = xs.length;
  const d = xs[0]!.length;
  const matrix: number[][] = Array.from({ length: d }, () => new Array(d + 1).fill(0) as number[]);
  for (let r = 0; r < xs.length; r++) {
    const x = xs[r]!;
    const y = ys[r]!;
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < d; k++) matrix[j]![k] += x[j]! * x[k]!;
      matrix[j]![d] += x[j]! * y;
    }
  }
  for (let j = 1; j < d; j++) matrix[j]![j] += n * penalty;
  for (let j = 0; j < d; j++) {
    let pivot = j;
    for (let k = j + 1; k < d; k++) if (Math.abs(matrix[k]![j]!) > Math.abs(matrix[pivot]![j]!)) pivot = k;
    const tmp = matrix[j]!;
    matrix[j] = matrix[pivot]!;
    matrix[pivot] = tmp;
    if (Math.abs(matrix[j]![j]!) <= 1e-12) throw new Error(`RIDGE_SINGULAR_PIVOT ${matrix[j]![j]}`);
    const scale = matrix[j]![j]!;
    matrix[j] = matrix[j]!.map((v) => v / scale);
    for (let k = 0; k < d; k++) {
      if (k === j) continue;
      const ratio = matrix[k]![j]!;
      matrix[k] = matrix[k]!.map((a, idx) => a - ratio * matrix[j]![idx]!);
    }
  }
  return matrix.map((row) => row[d]!);
}
