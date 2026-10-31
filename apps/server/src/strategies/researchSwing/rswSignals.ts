// apps/server/src/strategies/researchSwing/rswSignals.ts — T0.5 (18 Okt 2026).
//
// Port TypeScript dari generator sinyal RSW-01/02/03 (riset Python).
// Sumber (oracle parity):
//   - swing_v29_h4_features.py : generate_h4, day_levels, prior_day_sweep
//   - swing_v29_h4.py          : allow (BTC_D1_ALIGN / PROFILE_CONTEXT)
//   - swing_paper_signals.py   : stop, h4_signals, algo_signals
//
// DUA MODE:
//  - FORWARD (h4Signals / algoSignals)   : hanya bar TERAKHIR (convention riset
//    swing_forward_paper.py). Dipakai lane PAPER ArtaTrade.
//  - HISTORICAL (rswHistoricalSignals)   : SEMUA bar/edge — untuk backtest/gate
//    di engine TS (runStrategyBacktest). Pemetaan keluarga -> RSW identik dengan
//    h4_signals, hanya filter "last bar" yang dilepas.
//
// RR23 (riset 1:3) dipakai sebagai exit policy: TP1 @ 2R take 50%, SL -> entry
// (breakeven), runner 50% ke TPmax @ 3R. Lihat SWING_RR23_POLICY di engine.

import type { Bar, DailyRegime, H4Context, NalRow, VolumeProfile } from "./rswPrimitives.js";
import {
  DAY,
  HOUR,
  STEP,
  algoEvents,
  aggregate,
  atrSeries,
  context,
  dailyRegime,
  ema,
  equalSweep,
  nalSpectrum,
  profile,
  supertrendDirections,
  vector,
} from "./rswPrimitives.js";

// ---- tipe -----------------------------------------------------------------

export type Side = "LONG" | "SHORT";

export interface VolumeContext extends VolumeProfile {
  vwap720h: number;
  vwap96h: number;
  rvol: number;
  clv: number;
  open: number;
  high: number;
  low: number;
  profileLookbackBars: number;
  profileCandleMs: number;
  featureAvailableAt: number;
  profileProxy: boolean;
}

export interface H4EventRow {
  symbol: string;
  time: number;
  side: Side;
  close: number;
  atr: number;
  structuralSl: number;
  structureLevel: number;
  trend: number;
  adx: number;
  priority: number;
  volumeContext: VolumeContext;
  btcDailyContext: DailyRegime | null;
  event: string;
  previousDayLevelAvailableAt: number | null;
  entryAdaptationVersion: number;
  triggerCandleMs: number;
}

export interface RswSignal extends H4EventRow {
  strategyId: string;
  entry: number;
  sl: number;
}

export interface AlgoSignal {
  symbol: string;
  time: number;
  side: Side;
  close: number;
  atr: number;
  structuralSl: number;
  mean20: number;
  adx: number;
  trend: number;
  entry: number;
  sl: number;
  priority: number;
  strategyId: string;
  modelVector: number[];
  modelTrainedBefore: number;
  modelTrainingTarget: number | null;
  forwardTransfer: boolean;
}

export interface AlgoModel {
  beta: number[];
  trainedBefore: number;
  trainingTarget: number | null;
  forwardTransfer?: boolean;
}

export interface DayLevel {
  high: number;
  low: number;
  availableAt: number;
}

export type DayLevels = Record<number, DayLevel>;

// ---- day levels / prior day sweep (swing_v29_h4_features.py) ---------------

export function dayLevels(daily: Bar[]): DayLevels {
  const out: DayLevels = {};
  for (const b of daily) {
    out[b.time + DAY] = { high: b.high, low: b.low, availableAt: b.time + DAY };
  }
  return out;
}

export function priorDaySweep(bar: Bar, levels: DayLevels): [number, number | null, number | null] {
  const known = levels[Math.floor(bar.time / DAY) * DAY];
  if (known === undefined) return [0, null, null];
  const clv = (bar.close - bar.low) / Math.max(bar.high - bar.low, 1e-12);
  if (bar.low < known.low && known.low < bar.close && bar.close > bar.open && clv >= 0.65)
    return [1, known.low, known.availableAt];
  if (bar.high > known.high && known.high > bar.close && bar.close < bar.open && clv <= 0.35)
    return [-1, known.high, known.availableAt];
  return [0, null, known.availableAt];
}

// ---- generate_h4 (swing_v29_h4_features.py) -------------------------------

const FAMILIES = [
  "ALGO_LIMIT",
  "PHEN_FADE_LIMIT",
  "BOS_LIMIT_RETEST",
  "NAL_LIMIT",
  "NAMBOU_RANGE_LIMIT",
] as const;

type Family = (typeof FAMILIES)[number];

interface RawEvent {
  family: Family;
  s: number;
  level: number;
  structural: number | null;
  event: string;
}

export function generateH4(
  symbol: string,
  bars: Bar[],
  btcDaily: DailyRegime[],
  levels: DayLevels,
  warmup = 800
): Record<Family, H4EventRow[]> {
  const closes = bars.map((b) => b.close);
  const average = ema(closes, 20);
  const atr = atrSeries(bars, 14);
  const trend = context(bars);
  const nal: NalRow[] = nalSpectrum(closes);
  const gold = supertrendDirections(bars);
  const dailyTimes = btcDaily.map((r) => r.availableAt);
  const results = Object.fromEntries(FAMILIES.map((f) => [f, [] as H4EventRow[]])) as Record<
    Family,
    H4EventRow[]
  >;
  const last = new Map<string, number>();
  const armed: Record<number, { index: number; level: number } | null> = { 1: null, [-1]: null };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i < Math.max(warmup, 200) || !atr[i]) continue;
    const prior = bars.slice(i - 24, i);
    const prior20 = bars.slice(i - 20, i);
    const past = bars.slice(i - 180, i);
    if (past.length !== 180) continue;
    if (past[0]!.time !== b.time - 180 * STEP) continue;
    if (past[past.length - 1]!.time + STEP !== b.time) continue;
    const meanVolume = prior20.reduce((a, x) => a + x.volume, 0) / 20;
    if (meanVolume <= 0) continue;
    const rvol = b.volume / meanVolume;
    const clv = (b.close - b.low) / Math.max(b.high - b.low, 1e-12);
    const high = Math.max(...prior20.map((x) => x.high));
    const low = Math.min(...prior20.map((x) => x.low));
    const vol96 = prior.reduce((a, x) => a + x.volume, 0);
    if (vol96 <= 0) continue;
    const vwap96 =
      prior.reduce((a, x) => a + ((x.high + x.low + x.close) / 3) * x.volume, 0) / vol96;

    const events: RawEvent[] = [];
    for (const s of [1, -1]) {
      const body = s * (b.close - b.open) > 0;
      const location = s === 1 ? clv : 1 - clv;
      const touched = s === 1 ? b.low <= average[i]! : b.high >= average[i]!;
      const goldBias = gold[i] === -1 ? 1 : -1;
      if (
        trend[i]!.bias === s &&
        goldBias === s &&
        body &&
        location >= 0.6 &&
        touched &&
        s * (b.close - average[i]!) > 0 &&
        rvol >= 0.8
      ) {
        events.push({ family: "ALGO_LIMIT", s, level: average[i]!, structural: null, event: "GOLD_ST_EMA_PULLBACK" });
      }
      const level = s === 1 ? high : low;
      if (high - low <= 4 * atr[i]! && s * (b.close - level) > 0.1 * atr[i]! && rvol >= 1.2 && body) {
        events.push({
          family: "PHEN_FADE_LIMIT",
          s,
          level,
          structural: s === 1 ? low - 0.1 * atr[i]! : high + 0.1 * atr[i]!,
          event: "COMPRESSED_RANGE_BREAK",
        });
      }
      let arm = armed[s];
      if (arm && i - arm.index > 8) {
        armed[s] = null;
        arm = null;
      }
      if (arm && i - arm.index > 0 && i - arm.index <= 8) {
        const touchedBos = s === 1 ? b.low <= arm.level + 0.1 * atr[i]! : b.high >= arm.level - 0.1 * atr[i]!;
        if (touchedBos && s * (b.close - arm.level) > 0 && location >= 0.6 && rvol >= 0.8) {
          let stop =
            s === 1
              ? Math.min(...bars.slice(i - 4, i + 1).map((x) => x.low)) - 0.1 * atr[i]!
              : Math.max(...bars.slice(i - 4, i + 1).map((x) => x.high)) + 0.1 * atr[i]!;
          stop = s === 1 ? Math.min(stop, arm.level - 0.1 * atr[i]!) : Math.max(stop, arm.level + 0.1 * atr[i]!);
          events.push({ family: "BOS_LIMIT_RETEST", s, level: arm.level, structural: stop, event: "BREAK_THEN_RETEST" });
          armed[s] = null;
        }
      }
      if (s * (b.close - level) > 0 && s * (bars[i - 1]!.close - level) <= 0) {
        armed[s] = { index: i, level };
      }
      if (
        nal[i]!.state === s &&
        s * (bars[i - 1]!.close - vwap96) <= 0 &&
        s * (b.close - vwap96) > 0 &&
        body &&
        rvol >= 0.8
      ) {
        events.push({ family: "NAL_LIMIT", s, level: vwap96, structural: null, event: "NAL_VWAP96_CROSS" });
      }
    }

    let [sweep, sweepLevel] = equalSweep(prior, b, atr[i]!);
    let kind = "EQUAL_EXTREMES_SWEEP";
    let dayAvailable: number | null = null;
    if (!sweep) {
      const [sw, lv, da] = priorDaySweep(b, levels);
      sweep = sw;
      sweepLevel = lv;
      dayAvailable = da;
      kind = "PREVIOUS_DAY_SWEEP";
    }
    if (sweep && rvol >= 0.8) {
      events.push({
        family: "NAMBOU_RANGE_LIMIT",
        s: sweep,
        level: sweepLevel!,
        structural: sweep === 1 ? b.low - 0.1 * atr[i]! : b.high + 0.1 * atr[i]!,
        event: kind,
      });
    }

    if (!events.length) continue;
    const p = profile(past);
    if (p === null) continue;
    const volume: VolumeContext = {
      ...p,
      vwap720h: p.vwap72,
      profileLastClose: past[past.length - 1]!.time + STEP,
      vwap96h: vwap96,
      rvol,
      clv,
      open: b.open,
      high: b.high,
      low: b.low,
      profileLookbackBars: 180,
      profileCandleMs: STEP,
      featureAvailableAt: b.time + STEP,
      profileProxy: true,
    };
    const t = b.time + STEP;
    // bisect.bisect_right(dailyTimes, t) - 1
    let lo = 0;
    let hi = dailyTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dailyTimes[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    const d = lo - 1;
    const daily = d >= 0 ? btcDaily[d]! : null;

    for (const ev of events) {
      const key = `${ev.family}\u0000${ev.s}`;
      const lastAt = last.get(key);
      if (lastAt !== undefined && i - lastAt < 3) continue;
      last.set(key, i);
      let structural = ev.structural;
      if (structural === null) {
        structural =
          ev.s === 1
            ? Math.min(...bars.slice(i - 4, i + 1).map((x) => x.low)) - 0.1 * atr[i]!
            : Math.max(...bars.slice(i - 4, i + 1).map((x) => x.high)) + 0.1 * atr[i]!;
      }
      results[ev.family].push({
        symbol,
        time: t,
        side: ev.s === 1 ? "LONG" : "SHORT",
        close: b.close,
        atr: atr[i]!,
        structuralSl: structural,
        structureLevel: ev.level,
        trend: trend[i]!.bias,
        adx: trend[i]!.adx,
        priority: Math.min(rvol, 3) * 5 + Math.abs(b.close - average[i]!) / atr[i]!,
        volumeContext: volume,
        btcDailyContext: daily,
        event: ev.event,
        previousDayLevelAvailableAt: ev.event === "PREVIOUS_DAY_SWEEP" ? dayAvailable : null,
        entryAdaptationVersion: 29,
        triggerCandleMs: STEP,
      });
    }
  }
  return results;
}

// ---- allow (swing_v29_h4.py) ---------------------------------------------

export const FILTERS = ["CONTROL", "BTC_D1_ALIGN", "PROFILE_CONTEXT"] as const;
export type FilterKind = (typeof FILTERS)[number];

export function allow(r: H4EventRow & { strategyId?: string }, kind: FilterKind): boolean {
  if (kind === "CONTROL") return true;
  if (!FILTERS.includes(kind)) throw new Error(`ALLOW_UNKNOWN_FILTER ${kind}`);
  const s = r.side === "LONG" ? 1 : -1;
  const c = r.volumeContext;
  if (kind === "BTC_D1_ALIGN") {
    const b = r.btcDailyContext;
    if (b === null) return false;
    return b.bias === s;
  }
  const clv = s === 1 ? c.clv : 1 - c.clv;
  if (c.rvol < 1 || clv < 0.6) return false;
  if (r.strategyId === "NAMBOU_RANGE_LIMIT") {
    return s === 1 ? c.low < c.val && c.val < r.close : c.high > c.vah && c.vah > r.close;
  }
  return r.trend !== -s && s * (r.close - c.poc) > 0 && s * (r.close - c.vwap96h) > 0;
}

// ---- stop / h4_signals / algo_signals (swing_paper_signals.py) ------------

export function stop(row: H4EventRow, structural = false): RswSignal | null {
  const sign = row.side === "LONG" ? 1 : -1;
  let distance = Math.max(1.5 * row.atr, 0.01 * row.close);
  if (structural) {
    const raw = sign * (row.close - row.structuralSl);
    if (raw <= 0) return null;
    distance = Math.max(distance, raw);
  }
  if (distance / row.close > 0.06) return null;
  return {
    ...row,
    strategyId: "",
    entry: row.close,
    sl: row.close - sign * distance,
  };
}

/**
 * Forward adapter: hanya bar H4 terakhir (convention swing_forward_paper.py).
 *
 * 24 Okt 2026 — FIX SHADOWING RSW-02 (disetujui operator 23 Okt 2026).
 *
 * BUG LAMA: satu sinyal PHEN_FADE_LIMIT SHORT pushed menjadi DUA plan
 * identik (RSW-01 + RSW-02) lewat
 *     for (const sid of ["RSW-01", "RSW-02"]) result.push(...)
 * Keduanya punya entry/sl/priority identik -> quality identik ->
 * selectBestPlan() (setupStrategies.ts) mengambil plan PERTAMA -> RSW-01
 * selalu menang. RSW-02 structurally shadowed: 0% peluang entry.
 *
 * BUKTI (master_v2, 43.901 baris backtest beku + probe offline 38 simbol):
 *   - 3.955 kunci (symbol, entryTime) SHORT
 *   - 3.955 pasangan entry+sl IDENTIK, 0 beda, 0 sinyal SHORT eksklusif RSW-02
 *   - RSW-01 SHORT executed=201 PF=1.352 sumR=+43.14  <- edge nyata
 *   - RSW-02 SHORT executed=0   (semua hilang DUP_SYMBOL 2.299 / SLOT 1.656)
 *   - Probe offline research/probe_rsw02_ownership.py:
 *     shortSignalRows=7.916 uniqueShortKeys=3.958 duplicationRatio=2.0
 *     identicalEntrySl=3.958 differingEntrySl=0
 *
 * FIX: kaki SHORT PHEN_FADE_LIMIT sekarang DIMILIKI RSW-01 SAJA. RSW-01
 * adalah pemilik yang terbukti punya edge (PF 1.352). RSW-02 tidak lagi
 * menghasilkan plan duplikat, sehingga tidak ada dua plan identik yang
 * bertarung, dan tidak ada slot/duplikat-symbol yang terbuang sia-sia.
 *
 * kaki LONG tetap milik masing-masing pemilik:
 *   - BOS_LIMIT_RETEST LONG + BTC_D1_ALIGN -> RSW-01
 *   - PHEN_FADE_LIMIT LONG + PROFILE_CONTEXT -> RSW-02
 */
export function h4Signals(symbol: string, bars: Bar[], btcDaily: Bar[]): RswSignal[] {
  const generated = generateH4(symbol, bars, dailyRegime(btcDaily), {});
  const result: RswSignal[] = [];
  const lastTime = bars[bars.length - 1]!.time + 4 * HOUR;
  for (const raw of generated.PHEN_FADE_LIMIT) {
    if (raw.time !== lastTime) continue;
    if (raw.side === "SHORT") {
      const r = stop(raw);
      // 24 Okt 2026: SHORT PHEN = milik RSW-01 SAJA (lihat catatan di atas).
      if (r) result.push({ ...r, strategyId: "RSW-01" });
    } else if (allow({ ...raw, strategyId: "PHEN_FADE_LIMIT" }, "PROFILE_CONTEXT")) {
      const r = stop(raw, true);
      if (r) result.push({ ...r, strategyId: "RSW-02" });
    }
  }
  for (const raw of generated.BOS_LIMIT_RETEST) {
    if (raw.time !== lastTime || raw.side !== "LONG") continue;
    const r = stop(raw);
    if (r && allow(r, "BTC_D1_ALIGN")) result.push({ ...r, strategyId: "RSW-01" });
  }
  return result;
}

/** Forward adapter RSW-03: hanya edge AlgoChief pada bar H1 terakhir. */
export function algoSignals(
  symbol: string,
  bars: Bar[],
  h4: Bar[],
  model: AlgoModel
): AlgoSignal[] {
  if (bars.length < 801 || h4.length < 200) return [];
  const signed = new Map(
    algoEvents(bars).map((e) => [e.index, e.sign] as [number, number])
  );
  const i = bars.length - 1;
  if (signed.get(i) !== -1) return [];
  return algoSignalAt(symbol, bars, h4, model, i);
}

/**
 * Historikal RSW: semua bar (bukan hanya bar terakhir).
 * Pemetaan keluarga -> strategi identik dengan h4Signals.
 *
 * 24 Okt 2026 — ownership kaki SHORT PHEN disamakan dengan h4Signals
 * (lihat catatan panjang di h4Signals): SHORT PHEN = RSW-01 SAJA.
 * Kalau tidak, scanner/backtest mengukur aturan yang tidak lagi dipakai
 * produksi -> angka SL% dan hitungan sinyal jadi tidak mewakili runtime.
 */
export function rswHistoricalH4Signals(
  symbol: string,
  bars: Bar[],
  btcDaily: Bar[]
): RswSignal[] {
  const generated = generateH4(symbol, bars, dailyRegime(btcDaily), {});
  const result: RswSignal[] = [];
  for (const raw of generated.PHEN_FADE_LIMIT) {
    if (raw.side === "SHORT") {
      const r = stop(raw);
      if (r) result.push({ ...r, strategyId: "RSW-01" });
    } else if (allow({ ...raw, strategyId: "PHEN_FADE_LIMIT" }, "PROFILE_CONTEXT")) {
      const r = stop(raw, true);
      if (r) result.push({ ...r, strategyId: "RSW-02" });
    }
  }
  for (const raw of generated.BOS_LIMIT_RETEST) {
    if (raw.side !== "LONG") continue;
    const r = stop(raw);
    if (r && allow(r, "BTC_D1_ALIGN")) result.push({ ...r, strategyId: "RSW-01" });
  }
  return result;
}

/**
 * Historikal RSW-03: semua edge AlgoChief SHORT pada stream H1.
 * Logika per-edge identik dengan algo_signals pada bar terakhir.
 */
export function rswHistoricalAlgoSignals(
  symbol: string,
  bars: Bar[],
  h4: Bar[],
  model: AlgoModel
): AlgoSignal[] {
  if (bars.length < 801 || h4.length < 200) return [];
  const signed = new Map(algoEvents(bars).map((e) => [e.index, e.sign] as [number, number]));
  const result: AlgoSignal[] = [];
  for (const i of [...signed.keys()].sort((a, b) => a - b)) {
    if (signed.get(i) !== -1) continue;
    const s = algoSignalAt(symbol, bars, h4, model, i);
    result.push(...s);
  }
  return result;
}

function algoSignalAt(
  symbol: string,
  bars: Bar[],
  h4: Bar[],
  model: AlgoModel,
  i: number
): AlgoSignal[] {
  const b = bars[i]!;
  const t = b.time + HOUR;
  const ctx = context(h4);
  const times = ctx.map((r) => r.time);
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const j = lo - 1;
  if (j < 199 || ctx[j]!.adx >= 25) return [];
  const atr = atrSeries(bars, 14)[i] ?? null;
  const mean = ema(bars.map((r) => r.close), 20)[i]!;
  if (!atr) return [];
  const structural = Math.max(...bars.slice(i - 4, i + 1).map((r) => r.high)) + 0.25 * atr;
  const entry = b.close + 0.25 * atr;
  const distance = Math.max(structural - entry, 1.5 * atr, 0.0125 * entry);
  if (structural <= entry || distance / entry > 0.06) return [];
  const volume = bars.slice(i - 19, i + 1).reduce((a, r) => a + r.volume, 0) / 20;
  if (volume <= 0) return [];
  const row = {
    symbol,
    time: t,
    side: "SHORT" as Side,
    close: b.close,
    atr,
    structuralSl: structural,
    mean20: mean,
    adx: ctx[j]!.adx,
    trend: ctx[j]!.bias,
    entry,
    sl: entry + distance,
    priority: Math.min(b.volume / volume, 3) * 5 + Math.abs(b.close - mean) / atr,
    strategyId: "RSW-03",
  };
  const x = vector(row);
  const score = x.reduce((a, v, k) => a + v * model.beta[k]!, 0);
  if (score < 0) return [];
  return [
    {
      ...row,
      priority: score,
      modelVector: x,
      modelTrainedBefore: model.trainedBefore,
      modelTrainingTarget: model.trainingTarget,
      forwardTransfer: model.forwardTransfer ?? false,
    },
  ];
}

/** Muat model seed riset (swing_paper_algo_seed.json) dengan validasi bentuk. */
export function parseAlgoModel(seed: {
  trainedBefore: number;
  transferToRR23?: boolean;
  trainingTargetR?: number;
  model: { beta: number[]; longLabels?: number };
}): AlgoModel {
  const beta = seed.model.beta;
  if (!Array.isArray(beta) || beta.length !== 11 || beta.some((v) => !Number.isFinite(v))) {
    throw new Error("ALGO_SEED_BAD_BETA");
  }
  return {
    beta,
    trainedBefore: seed.trainedBefore,
    trainingTarget: seed.trainingTargetR ?? null,
    forwardTransfer: seed.transferToRR23 ?? false,
  };
}

// re-export untuk convenience test/parity
export { aggregate, dailyRegime };
