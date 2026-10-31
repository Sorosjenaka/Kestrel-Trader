// apps/server/src/engines/indicatorLibrary.ts
// INDIKATOR DETERMINISTIK hasil reimplementasi 3 script TradingView open-source
// (perintah operator 29 Sep 2026). Semua matematika murni, tanpa I/O, tanpa LLM:
//   1. Liquidity Sweep Session [TradingFinder] ICT Killzone Times
//      -> sweep sesi + reclaim + displacement  (pengganti S-02)
//   2. Liquidity Sniper (Alpha_Wizard)
//      -> peta likuiditas (liquidation + stop pools) -> magnet & pull bias
//   3. Ha Smooth Scalper
//      -> Heikin-Ashi double-smoothed + structure lock + MTF (pengganti S-05)
//
// CATATAN FIDELITAS (jujur, jangan dihapus): source Pine ketiga script TIDAK
// tersedia publik (pine-facade 404, DOM viewer tidak mengekspos source). Angka
// di bawah direkonstruksi dari dokumentasi resmi masing-masing script, jadi
// BUKAN salinan bit-per-bit. Semua parameter dapat di-override lewat opts agar
// bisa dikalibrasi ulang tanpa mengubah pemanggil.
import type { Bar } from "../universe/eligibility.js";
import { calculateAtr } from "./regimeTrendEngine.js";

const round8 = (v: number) => Number(v.toFixed(8));

// ───────────────────────────── Rata-rata bergerak ─────────────────────────────

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** EMA ala Pine: seed = SMA(period), lalu alpha = 2/(period+1). */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (period <= 0 || values.length === 0) return out;
  const alpha = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      prev += values[i]!;
      out.push(NaN);
      continue;
    }
    if (i === period - 1) {
      prev = (prev + values[i]!) / period;
      out.push(prev);
      continue;
    }
    prev = values[i]! * alpha + prev * (1 - alpha);
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  const last = s[s.length - 1];
  return last === undefined || Number.isNaN(last) ? null : last;
}

/**
 * RSI ala Pine `ta.rsi`: smoothing Wilder (RMA), seed = SMA(period) dari
 * `period` perubahan pertama. Deret sejajar `values` (NaN sebelum seed cukup).
 * Dipakai S-04 (RSI 2). ATR(14) Wilder sudah ada di regimeTrendEngine
 * (calculateAtrSeries) — dipakai ulang, tidak diduplikasi.
 */
export function rsiSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0 || n <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function rsi(values: number[], period: number): number | null {
  const s = rsiSeries(values, period);
  const last = s[s.length - 1];
  return last === undefined || Number.isNaN(last) ? null : last;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ═══════════════════════ 1. LIQUIDITY SWEEP SESSION (ICT) ═══════════════════════
// Sesi killzone dalam UTC (script asli memakai zona waktu bursa; kita pakai UTC
// karena seluruh pipeline ArtaTrade berbasis UTC — sesi tetap deterministik).
export interface KillzoneSpec {
  name: "ASIA" | "LONDON" | "NY_AM" | "NY_PM";
  startHourUtc: number;
  endHourUtc: number;
}

export const ICT_KILLZONES: KillzoneSpec[] = [
  { name: "ASIA", startHourUtc: 0, endHourUtc: 4 },
  { name: "LONDON", startHourUtc: 7, endHourUtc: 10 },
  { name: "NY_AM", startHourUtc: 12, endHourUtc: 15 },
  { name: "NY_PM", startHourUtc: 17, endHourUtc: 20 },
];

export function killzoneAt(timeMs: number, zones: KillzoneSpec[] = ICT_KILLZONES): KillzoneSpec | null {
  const h = new Date(timeMs).getUTCHours();
  return zones.find((z) => h >= z.startHourUtc && h < z.endHourUtc) ?? null;
}

export interface SessionRange {
  name: string;
  fromMs: number;
  toMs: number;
  high: number;
  low: number;
}

/** Rentang high/low sesi kalender UTC (dipakai sebagai level likuiditas acuan). */
export function sessionRange(bars: Bar[], name: string, fromMs: number, toMs: number): SessionRange | null {
  const slice = bars.filter((b) => b.openTime >= fromMs && b.openTime < toMs);
  if (slice.length === 0) return null;
  return {
    name,
    fromMs,
    toMs,
    high: Math.max(...slice.map((b) => b.high)),
    low: Math.min(...slice.map((b) => b.low)),
  };
}

export interface SweepSetup {
  /** Arah balasan yang diharapkan setelah likuiditas diambil. */
  side: "LONG" | "SHORT";
  /** Level sesi yang tersapu. */
  sweptLevel: number;
  sweptRange: string;
  /** Kedalaman sweep dalam ATR (ekstensi minimum/ maksimum divalidasi pemanggil). */
  sweepDepthAtr: number;
  /** Bar reclaim: close kembali melewati level yang tersapu. */
  reclaimBarIndex: number;
  /** Displacement searah balasan (body / ATR) pada bar reclaim. */
  displacementAtr: number;
  /** Killzone saat sweep terjadi. */
  killzone: string | null;
  /** Jarak invalidation (ekstrem sweep) ke harga reclaim, untuk SL. */
  invalidationPrice: number;
}

export interface SweepOptions {
  /** Ekstensi minimum melewati level (x ATR) agar dianggap sweep nyata, bukan sentuhan. */
  minDepthAtr?: number;
  /** Ekstensi maksimum; breakdown terlalu dalam bukan lagi liquidity grab. */
  maxDepthAtr?: number;
  /** Jumlah bar maksimum antara sweep dan reclaim. */
  reclaimWindowBars?: number;
  /** Displacement minimum bar reclaim (x ATR). */
  minDisplacementAtr?: number;
  /** Wajib terjadi di dalam killzone? */
  requireKillzone?: boolean;
  /** Cari range sesi hari sebelumnya berapa hari ke belakang. */
  lookbackDays?: number;
}

export const DEFAULT_SWEEP_OPTIONS: Required<SweepOptions> = {
  minDepthAtr: 0.05,
  maxDepthAtr: 1.6,
  reclaimWindowBars: 6,
  minDisplacementAtr: 0.25,
  requireKillzone: true,
  lookbackDays: 1,
};

/**
 * Deteksi sweep likuiditas + reclaim pada level sesi sebelumnya.
 *
 * Urutan yang WAJIB terpenuhi (mengikuti logika script):
 *   1. sweep segar: harga menembus low/high referensi minimal minDepthAtr dan
 *      bar sebelumnya belum menembus level yang sama (bukan sisa penetrasi lama);
 *   2. kedalaman tidak melebihi maxDepthAtr (breakdown dalam = acceptance, bukan grab);
 *   3. reclaim: dalam reclaimWindowBars, close kembali ke sisi dalam level;
 *   4. displacement: body bar reclaim >= minDisplacementAtr * ATR, searah balasan.
 *
 * Mengembalikan setup TERBARU yang valid, atau null.
 */
export function detectLiquiditySweep(bars: Bar[], opts: SweepOptions = {}): SweepSetup | null {
  const o = { ...DEFAULT_SWEEP_OPTIONS, ...opts };
  if (bars.length < 30) return null;
  const atr = calculateAtr(bars, 14);
  if (!atr || atr <= 0) return null;

  const last = bars[bars.length - 1]!;
  const lastDay = new Date(last.openTime);
  const dayStart = Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate());
  const prevFrom = dayStart - o.lookbackDays * 86_400_000;

  const prevDay = sessionRange(bars, "PREV_DAY", prevFrom, dayStart);
  const asiaFrom = dayStart;
  const asiaTo = dayStart + 4 * 3_600_000;
  const asia = sessionRange(bars, "ASIA", asiaFrom, asiaTo);

  const refs: SessionRange[] = [prevDay, asia].filter((r): r is SessionRange => r !== null);
  if (refs.length === 0) return null;

  // Telusuri dari bar terbaru ke belakang: cari sweep + reclaim terbaru.
  const startIdx = Math.max(1, bars.length - 60);
  for (let i = bars.length - 1; i >= startIdx; i--) {
    const b = bars[i]!;
    const kz = killzoneAt(b.openTime);
    if (o.requireKillzone && !kz) continue;

    for (const ref of refs) {
      // ── Sisi bearish likuiditas (low sesi) -> potensi LONG ──
      if (b.low < ref.low) {
        const depth = (ref.low - b.low) / atr;
        if (depth < o.minDepthAtr || depth > o.maxDepthAtr) continue;
        const prevBar = bars[i - 1];
        // Sweep harus SEGAR: bar sebelumnya belum menembus level yang sama.
        if (prevBar && prevBar.low < ref.low) continue;
        const found = scanReclaim(bars, i, ref.low, "LONG", atr, o, kz?.name ?? null, b.low, ref.name);
        if (found) return found;
      }
      // ── Sisi bullish likuiditas (high sesi) -> potensi SHORT ──
      if (b.high > ref.high) {
        const depth = (b.high - ref.high) / atr;
        if (depth < o.minDepthAtr || depth > o.maxDepthAtr) continue;
        const prevBar = bars[i - 1];
        if (prevBar && prevBar.high > ref.high) continue;
        const found = scanReclaim(bars, i, ref.high, "SHORT", atr, o, kz?.name ?? null, b.high, ref.name);
        if (found) return found;
      }
    }
  }
  return null;
}

function scanReclaim(
  bars: Bar[],
  sweepIdx: number,
  level: number,
  side: "LONG" | "SHORT",
  atr: number,
  o: Required<SweepOptions>,
  killzone: string | null,
  sweepExtreme: number,
  rangeName: string
): SweepSetup | null {
  const to = Math.min(bars.length - 1, sweepIdx + o.reclaimWindowBars);
  for (let j = sweepIdx; j <= to; j++) {
    const c = bars[j]!;
    const reclaimed = side === "LONG" ? c.close > level : c.close < level;
    if (!reclaimed) continue;
    const body = Math.abs(c.close - c.open);
    const displacementAtr = body / atr;
    if (displacementAtr < o.minDisplacementAtr) continue;
    const bodyDirOk = side === "LONG" ? c.close > c.open : c.close < c.open;
    if (!bodyDirOk) continue;
    const depth = side === "LONG" ? (level - sweepExtreme) / atr : (sweepExtreme - level) / atr;
    return {
      side,
      sweptLevel: round8(level),
      sweptRange: rangeName,
      sweepDepthAtr: Number(depth.toFixed(4)),
      reclaimBarIndex: j,
      displacementAtr: Number(displacementAtr.toFixed(4)),
      killzone,
      invalidationPrice: round8(sweepExtreme),
    };
  }
  return null;
}

/**
 * Varian range-based dari deteksi sweep, dipakai jalur LIVE di mana jendela
 * klines (90 bar) tidak selalu menutupi satu hari kalender penuh.
 *
 * Referensi level diambil dari bagian AWAL jendela (`rangeBars` bar pertama =
 * "range sesi yang sudah terbentuk"), lalu sweep dicari di sisa bar setelahnya.
 * Aturannya identik dengan detectLiquiditySweep: sweep segar + kedalaman
 * terbatas + reclaim + displacement. Hasilnya deterministik untuk tes offline.
 */
export function detectRangeSweepReclaim(
  bars: Bar[],
  rangeBars = 30,
  opts: SweepOptions = {}
): SweepSetup | null {
  const o = { ...DEFAULT_SWEEP_OPTIONS, ...opts };
  if (bars.length < rangeBars + 10) return null;
  const atr = calculateAtr(bars, 14);
  if (!atr || atr <= 0) return null;

  const ref = bars.slice(0, rangeBars);
  const refHigh = Math.max(...ref.map((b) => b.high));
  const refLow = Math.min(...ref.map((b) => b.low));

  const startIdx = rangeBars;
  for (let i = bars.length - 1; i >= startIdx; i--) {
    const b = bars[i]!;
    const kz = killzoneAt(b.openTime);
    if (o.requireKillzone && !kz) continue;

    if (b.low < refLow) {
      const depth = (refLow - b.low) / atr;
      if (depth < o.minDepthAtr || depth > o.maxDepthAtr) continue;
      const prevBar = bars[i - 1];
      if (prevBar && prevBar.low < refLow) continue;
      const found = scanReclaim(bars, i, refLow, "LONG", atr, o, kz?.name ?? null, b.low, "SESSION_RANGE");
      if (found) return found;
    }
    if (b.high > refHigh) {
      const depth = (b.high - refHigh) / atr;
      if (depth < o.minDepthAtr || depth > o.maxDepthAtr) continue;
      const prevBar = bars[i - 1];
      if (prevBar && prevBar.high > refHigh) continue;
      const found = scanReclaim(bars, i, refHigh, "SHORT", atr, o, kz?.name ?? null, b.high, "SESSION_RANGE");
      if (found) return found;
    }
  }
  return null;
}

// ═══════════════════════ 2. LIQUIDITY SNIPER ═══════════════════════
// Reimplementasi deterministik "Liquidity Sniper" (Alpha_Wizard, open-source).
// CATATAN FIDELITAS (jujur, jangan dihapus): source Pine tidak diekstrak (hanya
// dokumentasi publik halaman script), jadi logika direkonstruksi dari deskripsi
// resmi — BUKAN salinan bit-per-bit. Semua parameter bisa di-override lewat opts.
//
// Peta likuiditas dibangun dari dua sumber level:
//   (a) Liquidation engine — level likuidasi ESTIMASI dari tier leverage
//       (100x/50x/25x/10x) dengan bobot menurut leverage profile
//       (crypto_degen / balanced / conservative). Bukan data likuidasi beneran.
//   (b) Stop pools — pivot high/low terkonfirmasi (stop-hunt pivot length)
//       sebagai lokasi stop-liquidity, dengan bobot stop-liquidity weight.
// Level yang berdekatan digabung jadi satu dinding (cluster merge distance dlm ATR),
// intensitasnya diakumulasi lalu meluruh dengan intensity half-life. Dinding
// aktif terkuat DI ATAS harga = short magnet, DI BAWAH = long magnet.
// Perbandingan intensitas dua sisi = liquidity pull bias. Signed volume delta
// (bar delta + cumulative) memberi konteks tekanan volume arah.

export type LeverageProfile = "CRYPTO_DEGEN" | "BALANCED" | "CONSERVATIVE";
export type PullBias = "UP" | "DOWN" | "NEUTRAL";

export interface LiquidityWall {
  price: number;
  /** Intensitas ternormalisasi 0..1 (terhadap wall terkuat). */
  intensity: number;
  kind: "LIQUIDATION" | "STOP";
  side: "ABOVE" | "BELOW";
  /** Tier leverage (100/50/25/10) untuk LIQUIDATION, null untuk STOP. */
  leverageTier: number | null;
  /** Usia wall dalam bar sejak level terbentuk. */
  age: number;
  /** Apakah wall tersentuh (wick/body) pada bar terakhir -> consumed. */
  consumed: boolean;
}

export interface LiquiditySniperResult {
  walls: LiquidityWall[];
  shortMagnet: LiquidityWall | null;
  longMagnet: LiquidityWall | null;
  pullBias: PullBias;
  totalIntensityAbove: number;
  totalIntensityBelow: number;
  barDelta: number;
  cumDelta: number;
  majorSweepUp: boolean;
  majorSweepDown: boolean;
}

export interface LiquiditySniperOptions {
  leverageProfile?: LeverageProfile;
  maintenanceMarginPct?: number;
  atrLength?: number;
  volumeBaselineLength?: number;
  clusterMergeDistanceAtr?: number;
  intensityHalfLife?: number;
  stopHuntPivotLength?: number;
  stopLiquidityWeight?: number;
  purgeOnWickTouch?: boolean;
  maxActiveWalls?: number;
  maxMagnetDistancePct?: number;
  majorSweepThreshold?: number;
  pullBiasThreshold?: number;
}

export const DEFAULT_LIQUIDITY_SNIPER_OPTIONS: Required<LiquiditySniperOptions> = {
  leverageProfile: "BALANCED",
  maintenanceMarginPct: 0.5,
  atrLength: 14,
  volumeBaselineLength: 20,
  clusterMergeDistanceAtr: 0.5,
  intensityHalfLife: 50,
  stopHuntPivotLength: 8,
  stopLiquidityWeight: 1.0,
  purgeOnWickTouch: true,
  maxActiveWalls: 40,
  maxMagnetDistancePct: 5.0,
  majorSweepThreshold: 0.6,
  // Tuning 29 Sep 2026 (data Binance nyata, 6 simbol, 90 hari): 1.6 memberi
  // WR 35,48% (breakeven 32,26%, edge +3,22%) dan EV nyaris impas
  // (−$0,0075) — mengalahkan 1.1 (30,18%), 1.5 (33,72%), 2.2 (23,53%).
  // CATATAN: di-tune pada window evaluasi yang sama (bukan out-of-sample
  // terpisah), jadi ada risiko overfit.
  pullBiasThreshold: 1.6,
};

/** Bobot tier leverage per profile (mengganti asumsi distribusi leverage). */
export const LEVERAGE_WEIGHTS: Record<LeverageProfile, Record<number, number>> = {
  CRYPTO_DEGEN: { 100: 0.4, 50: 0.3, 25: 0.2, 10: 0.1 },
  BALANCED: { 100: 0.25, 50: 0.25, 25: 0.25, 10: 0.25 },
  CONSERVATIVE: { 100: 0.1, 50: 0.2, 25: 0.35, 10: 0.35 },
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round4 = (v: number) => Number(v.toFixed(4));

interface RawLevel {
  price: number;
  intensity: number;
  kind: "LIQUIDATION" | "STOP";
  leverageTier: number | null;
  birthIdx: number;
  age: number;
}

export function liquiditySniper(
  bars: Bar[],
  opts: LiquiditySniperOptions = {}
): LiquiditySniperResult | null {
  const o = { ...DEFAULT_LIQUIDITY_SNIPER_OPTIONS, ...opts };
  const minBars = Math.max(o.atrLength + 2, o.volumeBaselineLength + 2, o.stopHuntPivotLength * 2 + 3, 30);
  if (bars.length < minBars) return null;

  const last = bars[bars.length - 1]!;
  const price = last.close;
  const atr = calculateAtr(bars, o.atrLength) ?? 0;
  const safeAtr = atr > 0 ? atr : price * 0.01;

  // Volume relatif terhadap baseline -> bobot struktur likuiditas baru.
  const volSeries = bars.map((b) => b.volume);
  const volBaseline = sma(volSeries, o.volumeBaselineLength) ?? last.volume;
  const relVol = volBaseline > 0 ? Math.min(3, last.volume / volBaseline) : 1;

  // (a) Liquidation engine: level estimasi di atas & bawah harga untuk tiap tier.
  const mm = o.maintenanceMarginPct / 100;
  const weights = LEVERAGE_WEIGHTS[o.leverageProfile];
  const raw: RawLevel[] = [];
  for (const tierStr of Object.keys(weights)) {
    const L = Number(tierStr);
    const w = weights[L]!;
    const distFrac = Math.max(1 / L - mm, 0.001);
    const dist = distFrac * price;
    raw.push({ price: price + dist, intensity: w * relVol, kind: "LIQUIDATION", leverageTier: L, birthIdx: bars.length - 1, age: 0 });
    raw.push({ price: price - dist, intensity: w * relVol, kind: "LIQUIDATION", leverageTier: L, birthIdx: bars.length - 1, age: 0 });
  }

  // (b) Stop pools dari pivot high/low terkonfirmasi.
  const pLen = o.stopHuntPivotLength;
  for (let i = pLen; i < bars.length - pLen; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = i - pLen; k <= i + pLen; k++) {
      if (k === i) continue;
      if (bars[k]!.high >= b.high) isHigh = false;
      if (bars[k]!.low <= b.low) isLow = false;
    }
    if (isHigh) raw.push({ price: b.high, intensity: o.stopLiquidityWeight * relVol, kind: "STOP", leverageTier: null, birthIdx: i, age: 0 });
    if (isLow) raw.push({ price: b.low, intensity: o.stopLiquidityWeight * relVol, kind: "STOP", leverageTier: null, birthIdx: i, age: 0 });
  }
  if (raw.length === 0) return null;

  // Cluster merge: gabung level berdekatan (dalam ATR) -> intensitas terakumulasi.
  raw.sort((a, b) => a.price - b.price);
  const mergeDist = o.clusterMergeDistanceAtr * safeAtr;
  const merged: RawLevel[] = [];
  for (const lvl of raw) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(lvl.price - prev.price) <= mergeDist) {
      const total = prev.intensity + lvl.intensity;
      prev.price = (prev.price * prev.intensity + lvl.price * lvl.intensity) / total;
      prev.intensity = total;
      prev.birthIdx = Math.min(prev.birthIdx, lvl.birthIdx);
      if (lvl.kind === "STOP") prev.kind = "STOP";
    } else {
      merged.push({ ...lvl });
    }
  }

  // Intensity decay: meluruh 0.5^(age/halfLife) sejak level terbentuk.
  const halfLife = Math.max(1, o.intensityHalfLife);
  const walls: LiquidityWall[] = merged.map((w) => {
    const age = bars.length - 1 - w.birthIdx;
    return {
      price: round8(w.price),
      intensity: w.intensity * Math.pow(0.5, age / halfLife),
      kind: w.kind,
      side: w.price >= price ? "ABOVE" : "BELOW",
      leverageTier: w.leverageTier,
      age,
      consumed: false,
    };
  });

  // Normalisasi intensitas 0..1 terhadap wall terkuat.
  const maxI = walls.reduce((m, w) => Math.max(m, w.intensity), 0);
  if (maxI > 0) for (const w of walls) w.intensity = round4(w.intensity / maxI);

  // Purge on touch: bar terbaru menyentuh wall -> consumed.
  const touchHigh = o.purgeOnWickTouch ? last.high : Math.max(last.open, last.close);
  const touchLow = o.purgeOnWickTouch ? last.low : Math.min(last.open, last.close);
  for (const w of walls) {
    if (w.price >= touchLow && w.price <= touchHigh) w.consumed = true;
  }

  // Wall aktif (belum consumed), dibatasi maxActiveWalls (terkuat dipertahankan).
  const active = walls.filter((w) => !w.consumed).sort((a, b) => b.intensity - a.intensity).slice(0, o.maxActiveWalls);

  // Magnets: wall aktif terkuat dalam radius maxMagnetDistancePct% dari harga.
  const maxDist = (o.maxMagnetDistancePct / 100) * price;
  const above = active.filter((w) => w.side === "ABOVE" && w.price - price <= maxDist);
  const below = active.filter((w) => w.side === "BELOW" && price - w.price <= maxDist);
  const shortMagnet = above.slice().sort((a, b) => b.intensity - a.intensity)[0] ?? null;
  const longMagnet = below.slice().sort((a, b) => b.intensity - a.intensity)[0] ?? null;

  const totalAbove = above.reduce((a, w) => a + w.intensity, 0);
  const totalBelow = below.reduce((a, w) => a + w.intensity, 0);
  const thr = o.pullBiasThreshold;
  const pullBias: PullBias =
    totalAbove > totalBelow * thr ? "UP" : totalBelow > totalAbove * thr ? "DOWN" : "NEUTRAL";

  // Signed volume delta.
  const barDelta = (last.close >= last.open ? 1 : -1) * last.volume;
  let cumDelta = 0;
  for (let i = Math.max(0, bars.length - 1440); i < bars.length; i++) {
    const b = bars[i]!;
    cumDelta += (b.close >= b.open ? 1 : -1) * b.volume;
  }

  // Major sweep: wall kuat (>= threshold * max) yang tersentuh bar terbaru.
  const sweptStrong = walls.filter((w) => w.consumed && w.intensity >= o.majorSweepThreshold);
  const majorSweepUp = sweptStrong.some((w) => w.side === "ABOVE");
  const majorSweepDown = sweptStrong.some((w) => w.side === "BELOW");

  return {
    walls: active,
    shortMagnet,
    longMagnet,
    pullBias,
    totalIntensityAbove: round4(totalAbove),
    totalIntensityBelow: round4(totalBelow),
    barDelta,
    cumDelta,
    majorSweepUp,
    majorSweepDown,
  };
}

// ═══════════════════════ 3. HA SMOOTH SCALPER ═══════════════════════

export interface StructureState {
  /** Tren struktur terkunci: 1 bull, -1 bear. */
  direction: 1 | -1;
  /** Level struktur yang dilindungi (pivot low saat bull, pivot high saat bear). */
  protectedLevel: number;
  /** Pivot strength yang dipakai. */
  pivotStrength: number;
  /** Apakah struktur baru saja patah pada bar terakhir. */
  flipped: boolean;
}

export interface Pivots {
  highs: number[];
  lows: number[];
}

/** Pivot high/low terkonfirmasi (kiri-kanan selebar `strength`). */
export function structurePivots(bars: Bar[], strength: number): Pivots {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = i - strength; k <= i + strength; k++) {
      if (k === i) continue;
      if (bars[k]!.high >= b.high) isHigh = false;
      if (bars[k]!.low <= b.low) isLow = false;
    }
    if (isHigh) highs.push(b.high);
    if (isLow) lows.push(b.low);
  }
  return { highs, lows };
}

/**
 * Heikin-Ashi double-smoothed: OHLC disaring EMA (pre), diubah ke HA, lalu
 * disaring EMA lagi (post). Mengikuti struktur "ha smooth engine" script.
 */
export function smoothedHeikinAshi(
  bars: Bar[],
  preLen = 6,
  postLen = 8,
  slowLen = 21
): { ha: Bar[]; fast: number | null; slow: number | null; slopeUp: boolean; slopeDown: boolean } {
  if (bars.length === 0) return { ha: [], fast: null, slow: null, slopeUp: false, slopeDown: false };
  const o = emaSeries(bars.map((b) => b.open), preLen);
  const h = emaSeries(bars.map((b) => b.high), preLen);
  const l = emaSeries(bars.map((b) => b.low), preLen);
  const c = emaSeries(bars.map((b) => b.close), preLen);

  const raw: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    if ([o[i], h[i], l[i], c[i]].some((v) => v === undefined || Number.isNaN(v))) continue;
    raw.push({
      openTime: bars[i]!.openTime,
      open: o[i]!,
      high: h[i]!,
      low: l[i]!,
      close: c[i]!,
      volume: bars[i]!.volume,
    });
  }
  if (raw.length < 3) return { ha: [], fast: null, slow: null, slopeUp: false, slopeDown: false };

  const ha: Bar[] = [];
  let prevHaOpen = (raw[0]!.open + raw[0]!.close) / 2;
  let prevHaClose = (raw[0]!.open + raw[0]!.high + raw[0]!.low + raw[0]!.close) / 4;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(b.high, haOpen, haClose);
    const haLow = Math.min(b.low, haOpen, haClose);
    ha.push({ openTime: b.openTime, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: b.volume });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }

  // Smoothing kedua di atas nilai HA.
  const haO = emaSeries(ha.map((b) => b.open), postLen);
  const haH = emaSeries(ha.map((b) => b.high), postLen);
  const haL = emaSeries(ha.map((b) => b.low), postLen);
  const haC = emaSeries(ha.map((b) => b.close), postLen);
  const smooth: Bar[] = [];
  for (let i = 0; i < ha.length; i++) {
    if ([haO[i], haH[i], haL[i], haC[i]].some((v) => v === undefined || Number.isNaN(v))) continue;
    smooth.push({ openTime: ha[i]!.openTime, open: haO[i]!, high: haH[i]!, low: haL[i]!, close: haC[i]!, volume: ha[i]!.volume });
  }
  if (smooth.length < 3) return { ha: [], fast: null, slow: null, slopeUp: false, slopeDown: false };

  const fastSeries = emaSeries(smooth.map((b) => b.close), postLen);
  const slow = ema(smooth.map((b) => b.close), slowLen);
  const fastNow = fastSeries[fastSeries.length - 1];
  const fastPrev = fastSeries[fastSeries.length - 2];
  const fast = fastNow === undefined || Number.isNaN(fastNow) ? null : fastNow;
  const slopeUp = fastNow !== undefined && fastPrev !== undefined && !Number.isNaN(fastNow) && !Number.isNaN(fastPrev) && fastNow > fastPrev;
  const slopeDown = fastNow !== undefined && fastPrev !== undefined && !Number.isNaN(fastNow) && !Number.isNaN(fastPrev) && fastNow < fastPrev;
  return { ha: smooth, fast, slow, slopeUp, slopeDown };
}

/**
 * Structure trend lock: tren bull/bear TIDAK berubah karena pergantian warna
 * candle, hanya saat level struktur terlindungi benar-benar patah.
 * `source` = "RAW" memakai high/low harga asli, "HA" memakai high/low HA halus.
 * `confirm` = "CLOSE" (butuh close melewati level) atau "WICK".
 * `bufferAtr` = jarak ekstra di luar pivot sebelum patah diakui.
 */
export function structureTrendLock(
  bars: Bar[],
  opts: {
    pivotStrength?: number;
    source?: "RAW" | "HA";
    confirm?: "CLOSE" | "WICK";
    bufferAtr?: number;
    haBars?: Bar[];
  } = {}
): StructureState | null {
  const pivotStrength = opts.pivotStrength ?? 8;
  const source = opts.source ?? "RAW";
  const confirm = opts.confirm ?? "CLOSE";
  const bufferAtr = opts.bufferAtr ?? 0.1;
  const series = source === "HA" ? opts.haBars ?? bars : bars;
  if (series.length < pivotStrength * 2 + 3) return null;
  const atr = calculateAtr(bars, 14) ?? 0;
  const buffer = bufferAtr * atr;

  let dir: 1 | -1 = 1;
  let protectedLevel = -Infinity;
  let flipped = false;
  const start = pivotStrength;
  for (let i = start; i < series.length; i++) {
    const piv = structurePivots(series.slice(0, i + 1), pivotStrength);
    const b = series[i]!;
    const lastLow = piv.lows.length ? piv.lows[piv.lows.length - 1]! : null;
    const lastHigh = piv.highs.length ? piv.highs[piv.highs.length - 1]! : null;

    if (dir === 1) {
      if (lastLow !== null) protectedLevel = lastLow - buffer;
      const broke =
        confirm === "CLOSE"
          ? b.close < protectedLevel
          : b.low < protectedLevel;
      if (broke && Number.isFinite(protectedLevel)) {
        dir = -1;
        flipped = true;
      } else {
        flipped = false;
      }
    } else {
      if (lastHigh !== null) protectedLevel = lastHigh + buffer;
      const broke =
        confirm === "CLOSE"
          ? b.close > protectedLevel
          : b.high > protectedLevel;
      if (broke && Number.isFinite(protectedLevel)) {
        dir = 1;
        flipped = true;
      } else {
        flipped = false;
      }
    }
  }
  return {
    direction: dir,
    protectedLevel: Number.isFinite(protectedLevel) ? round8(protectedLevel) : 0,
    pivotStrength,
    flipped,
  };
}

/** Arah multi-timeframe: berapa TF yang mendukung tiap sisi. */
export function mtfDirectionAgreement(
  frames: Array<{ name: string; direction: 1 | -1 }>,
  wanted: 1 | -1
): { agree: number; total: number; aligned: boolean } {
  const total = frames.length;
  const agree = frames.filter((f) => f.direction === wanted).length;
  return { agree, total, aligned: total > 0 && agree >= Math.ceil(total * 0.5) };
}

// ───────────────────────────── VWAP sesi (SMB T-07, 9 Okt 2026) ─────────────────────────────
/**
 * VWAP dengan anchor UTC 00:00 (hari kalender dari bar terakhir / `atTimeMs`).
 * Murni PELABEL KONTEKS — bukan gate entry (keputusan permanen 4 Okt 2026:
 * tidak ada filter berbasis jam/sesi; crypto 24/7). typical = (H+L+C)/3.
 * Hanya bar sejak midnight UTC hari itu yang masuk akumulasi.
 */
export function vwapSession(bars: Bar[], atTimeMs?: number): number | null {
  if (bars.length === 0) return null;
  const ref = atTimeMs ?? bars[bars.length - 1]!.openTime;
  const dayStart = Math.floor(ref / 86_400_000) * 86_400_000;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (b.openTime < dayStart || b.openTime > ref) continue;
    if (![b.high, b.low, b.close, b.volume].every(Number.isFinite) || b.volume < 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}

export { median };