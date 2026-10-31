// apps/server/src/strategies/researchSwing/rswPlans.ts — T0.5 (18 Okt 2026).
//
// Produser rencana RSW-01/02/03: memetakan sinyal riset (rswSignals) ke
// StrategyPlan agar bisa dikonsumsi engine ArtaTrade (buildSwingStrategyPlans +
// replay). Exit policy = RR23 riset 1:3 — TP1 @ 2R take 50%, SL ke entry
// (breakeven), runner 50% ke TPmax @ 3R. Ladder dieksekusi oleh replay
// (swingLadderLevelsFromTp1 + simulateLadderExit saat swingExitPolicy=RR23,
// yang mana adalah default). TIDAK di sini — modul ini hanya menurunkan
// entry/SL/tp1 dari sinyal.
//
// PAPER-ONLY: evaluator ini diekspos ke lane PAPER. LIVE tetap S-03/S-05
// sampai semua kandidat lolos gate (lihat allowedSwingStrategies).
//
// Model RSW-03: seed riset FROZEN (research/swing_paper_algo_seed.json, 11 beta,
// SHORT-only, trainedBefore < cutoff Apr 2025). Refit bulanan adalah runtime
// concern yang terpisah; seed dipakai sebagai baseline deterministik di sini.

import { rrPolicyForMode, type SetupMode } from "../../config/setupEngine.js";
import { STRATEGY_NAMES } from "../strategyCatalog.js";
import type { StrategyContext, StrategyPlan } from "../setupStrategies.js";
import type { Bar as EngBar } from "../../universe/eligibility.js";
import type { Bar } from "./rswPrimitives.js";
import { algoSignals, h4Signals, type RswSignal, type AlgoSignal, type AlgoModel } from "./rswSignals.js";

/**
 * Seed model Ridge RSW-03 — research/swing_paper_algo_seed.json.
 * SHORT-only (longLabels=0), trainedBefore 1743465600000, transferToRR23.
 * Nilai beta dipasang apa adanya dari oracle Python (jangan diubah tangan).
 */
export const RSW_ALGO_SEED: AlgoModel = {
  beta: [
    0.20497282018592458, 4.2294111217780885e-19, -0.030104993109635467, 0.025072505802751055,
    -1.7647200146013453e-05, 0.06801557803111866, -0.07169735705908042, 0.009429396920499294,
    -0.0007095880878233128, 0.049424380703418445, 0.018474817831315334,
  ],
  trainedBefore: 1743465600000,
  trainingTarget: 0.8,
  forwardTransfer: true,
};

/**
 * Kunci context swing yang membawa input RSW (H4 + BTC D1 + H1).
 * Catatan: `StrategyContext.swing` memakai `Bar` engine (`openTime`), sedangkan
 * evaluator RSW memakai `Bar` riset (`time`). Konversi dilakukan di
 * `buildRswPlans` via `engToRswBar`.
 */
export interface RswSwingData {
  h1Bars: EngBar[];
  h4Bars?: EngBar[];
  /** H1 panjang (>= 801 bar) untuk RSW-03; fallback h1Bars. */
  h1BarsLong?: EngBar[];
  btcDailyBars?: EngBar[];
}

/** Konversi Bar engine (`openTime`) → Bar riset (`time`). */
function engToRswBar(b: EngBar): Bar {
  return { time: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

/**
 * Turunkan StrategyPlan dari satu sinyal RSW dengan exit RR23.
 * tp1 pada tp1R mode SWING (2R); ladder 50/2R → BE → 50/3R dijalankan replay.
 */
function planFromSignal(
  symbol: string,
  sig: RswSignal | AlgoSignal,
  mode: SetupMode
): StrategyPlan {
  const side = sig.side;
  const sign = side === "LONG" ? 1 : -1;
  const rDistance = Math.abs(sig.entry - sig.sl);
  const policy = rrPolicyForMode(mode, sig.strategyId);
  const tp1 = sig.entry + sign * policy.tp1R * rDistance;
  const slPct = rDistance / sig.entry;
  const quality = Number.isFinite((sig as RswSignal).priority)
    ? Math.max(0, Math.min(100, (sig as RswSignal).priority! * 8))
    : 50;
  return {
    strategyId: sig.strategyId,
    strategyName: STRATEGY_NAMES[sig.strategyId] ?? sig.strategyId,
    mode,
    matched: true,
    side,
    entryType: "LIMIT_ZONE",
    entryPrice: sig.entry,
    slPrice: sig.sl,
    tp1Price: tp1,
    slPct,
    slAtrPct: sig.atr / sig.entry,
    rDistance,
    rr1: policy.tp1R,
    quality,
    zoneType: null,
    zoneTop: null,
    zoneBottom: null,
    zoneScore: 0,
    slBasis: "ATR_R_MULTIPLE",
    tpBasis: "R_MULTIPLE",
    reasons: [
      `RSW_${sig.strategyId}_RESEARCH_SIGNAL`,
      `entry=${sig.entry}`,
      `sl=${sig.sl}`,
      `rr23_tp1=${policy.tp1R}R_50pct_be_runner_3R`,
    ],
    tfSummary: `RSW ${sig.strategyId} (${side}) — sinyal riset H4/AlgoChief + seed Ridge`,
  };
}

/**
 * Bangun rencana RSW dari context SWING yang membawa h4Bars + btcDailyBars
 * (+ h1Bars untuk RSW-03). Tanpa h4Bars, tidak ada sinyal RSW (gagal TERTUTUP,
 * tidak pernah mengarang sinyal). Tanpa btcDailyBars, kaki BOS_LONG RSW-01
 * (BTC_D1_ALIGN) otomatis tersaring — kaki PHEN SHORT tetap hidup.
 *
 * Return kosong bila tidak ada sinyal pada bar terakhir (forward convention).
 */
export function buildRswPlans(
  ctx: StrategyContext,
  allowedIds: string[],
  model: AlgoModel = RSW_ALGO_SEED
): StrategyPlan[] {
  const swing = (ctx as { swing?: RswSwingData }).swing;
  const h4Eng = swing?.h4Bars;
  if (!h4Eng || h4Eng.length < 200) return [];
  const symbol = (ctx.analysis as { symbol?: string }).symbol ?? "";
  const allow = new Set(allowedIds.map((s) => s.toUpperCase()));
  // Konversi Bar engine (openTime) -> Bar riset (time) di batas modul.
  const h4: Bar[] = h4Eng.map(engToRswBar);
  const btcDaily: Bar[] = (swing?.btcDailyBars ?? []).map(engToRswBar);
  // RSW-03 butuh >= 801 bar H1 (seed deque AlgoChief) — pakai h1BarsLong bila
  // ada; fallback h1Bars (biasanya cuma ~300 bar jendela MTF -> RSW-03 off).
  const h1: Bar[] = (swing?.h1BarsLong ?? swing?.h1Bars ?? []).map(engToRswBar);

  const out: StrategyPlan[] = [];
  // RSW-01 / RSW-02 : sinyal H4 (PHEN + BOS), forward (bar H4 terakhir).
  const h4s = h4Signals(symbol, h4, btcDaily);
  for (const sig of h4s) {
    if (!allow.has(sig.strategyId)) continue;
    out.push(planFromSignal(symbol, sig, "SWING"));
  }
  // RSW-03 : sinyal AlgoChief (H1), forward (bar H1 terakhir).
  if (allow.has("RSW-03") && h1.length >= 801) {
    const alg = algoSignals(symbol, h1, h4, model);
    for (const sig of alg) out.push(planFromSignal(symbol, sig, "SWING"));
  }
  return out;
}
