// apps/server/src/backtest/validation/oosRunner.ts
// Big Brain — Out-of-Sample split eksplisit (prinsip artikel QuantGPT yang
// memisahkan in-sample vs out-of-sample; analogi crypto di sistem ini).
//
// KONTRAK (Golden Rule §10):
//  - Dataset HistoricalDataset SUDAH membawa deklarasi split:
//      bars[0]..trainingEndedAt  = IN-SAMPLE (riset/kalibrasi parameter)
//      outOfSampleFrom..outOfSampleTo = OUT-OF-SAMPLE (pengujian jujur)
//    Runner ini menjalankan replay DI KEDUA jendela dan melaporkan
//    degradasinya. Parameter TIDAK boleh dipilih berdasarkan OOS.
//  - Kalau data/funding tidak menutup jendela IS → dilaporkan gagal jujur
//    (IS_FUNDING_NOT_COVERED / INSUFFICIENT_IN_SAMPLE_DATA), bukan di-replay
//    setengah-setengah lalu diklaim.
import type { HistoricalDataset, ReplayOptions } from "../historicalReplay.js";
import { replayHistoricalDataset, validateHistoricalDataset } from "../historicalReplay.js";
import type { FeeStructure, StrategyMode } from "../backtestEngine.js";
import { calculateMetrics, type BacktestMetrics } from "../backtestEngine.js";

export interface OosWindowMetrics {
  windowFrom: number;
  windowTo: number;
  tradeCount: number;
  metrics: BacktestMetrics;
}

export interface OosValidationReport {
  strategyId: string;
  mode: StrategyMode;
  status: "CONSISTENT" | "DEGRADED" | "OOS_FAILED" | "INSUFFICIENT_DATA";
  inSample: OosWindowMetrics | null;
  outOfSample: OosWindowMetrics | null;
  winrateDeltaPct: number | null; // OOS - IS (negatif = degradasi)
  evRDelta: number | null;        // OOS - IS
  reasons: string[];
}

export interface OosRunOptions {
  slippageBps?: number;
  initialEquityUsd?: number;
  targetRiskUsd?: number;
  tp1ROverride?: number;
}

function cloneForWindow(d: HistoricalDataset, fromMs: number, toMs: number): HistoricalDataset {
  return {
    ...d,
    outOfSampleFrom: fromMs,
    outOfSampleTo: toMs,
    // An IS replay evaluates fixed parameters; it does not fit on this window.
    // Keep its validation split before the window, with the declared embargo.
    trainingEndedAt: Math.min(d.trainingEndedAt, fromMs - d.embargoMs - d.intervalMs),
    // fundingCoverage TIDAK diubah — kalau tidak menutup jendela ini,
    // validator akan menolak dengan jujur (MISSING_FUNDING_COVERAGE).
  };
}

function windowMetrics(
  d: HistoricalDataset,
  options: ReplayOptions,
  fromMs: number,
  toMs: number
): { metrics: BacktestMetrics; errors: string[] } {
  const out = replayHistoricalDataset(cloneForWindow(d, fromMs, toMs), options);
  return { metrics: calculateMetrics(out.trades), errors: out.errors };
}

export function runOutOfSampleValidation(
  dataset: HistoricalDataset,
  strategyId: string,
  mode: StrategyMode,
  fees: FeeStructure,
  opts: OosRunOptions = {}
): OosValidationReport {
  const reasons: string[] = [];
  const replayOptions: ReplayOptions = {
    strategyId,
    mode,
    fees,
    slippageBps: opts.slippageBps ?? 5,
    initialEquityUsd: opts.initialEquityUsd ?? 200,
    targetRiskUsd: opts.targetRiskUsd ?? 1,
    tp1ROverride: opts.tp1ROverride,
  };

  const pre = validateHistoricalDataset(dataset);
  if (pre.length > 0) {
    return {
      strategyId, mode, status: "INSUFFICIENT_DATA",
      inSample: null, outOfSample: null, winrateDeltaPct: null, evRDelta: null,
      reasons: pre,
    };
  }

  const intervalMs = dataset.intervalMs;
  // Jendela IN-SAMPLE: dari bar pertama sampai trainingEndedAt.
  // Keep the first available bar as warmup. The validator requires actual
  // history strictly before the window; opening before the data is invalid.
  const isFrom = dataset.bars[0]!.openTime + intervalMs;
  const isTo = Math.floor(dataset.trainingEndedAt / intervalMs) * intervalMs;
  const oosFrom = dataset.outOfSampleFrom;
  const oosTo = dataset.outOfSampleTo;

  if (isTo - isFrom < intervalMs * 9) {
    return {
      strategyId, mode, status: "INSUFFICIENT_DATA",
      inSample: null, outOfSample: null, winrateDeltaPct: null, evRDelta: null,
      reasons: ["INSUFFICIENT_IN_SAMPLE_DATA"],
    };
  }

  const isResult = windowMetrics(dataset, replayOptions, isFrom, isTo);
  if (isResult.errors.length > 0) {
    reasons.push(...isResult.errors.map((e) => "IS:" + e));
  }
  const oosResult = windowMetrics(dataset, replayOptions, oosFrom, oosTo);
  if (oosResult.errors.length > 0) {
    reasons.push(...oosResult.errors.map((e) => "OOS:" + e));
  }

  const inSample: OosWindowMetrics = {
    windowFrom: isFrom, windowTo: isTo,
    tradeCount: isResult.metrics.sampleCount, metrics: isResult.metrics,
  };
  const outOfSample: OosWindowMetrics = {
    windowFrom: oosFrom, windowTo: oosTo,
    tradeCount: oosResult.metrics.sampleCount, metrics: oosResult.metrics,
  };

  const winrateDeltaPct =
    isResult.metrics.sampleCount > 0 && oosResult.metrics.sampleCount > 0
      ? Number((oosResult.metrics.winrate - isResult.metrics.winrate).toFixed(2))
      : null;
  const evRDelta =
    isResult.metrics.sampleCount > 0 && oosResult.metrics.sampleCount > 0
      ? Number((oosResult.metrics.evR - isResult.metrics.evR).toFixed(4))
      : null;

  if (oosResult.metrics.sampleCount === 0) {
    reasons.push("OOS_NO_TRADES");
  }

  // Verdict — deterministik, tanpa area abu-abu:
  //  - OOS tanpa trade / error → OOS_FAILED
  //  - IS positif tapi OOS evR <= 0 → DEGRADED (edge tidak bertahan OOS)
  //  - IS & OOS sama-sama bertahan → CONSISTENT
  let status: OosValidationReport["status"];
  if (oosResult.metrics.sampleCount === 0 || reasons.some((r) => r.startsWith("OOS:"))) {
    status = "OOS_FAILED";
  } else if (isResult.errors.length > 0 || inSample.metrics.sampleCount === 0) {
    status = "INSUFFICIENT_DATA";
    reasons.push("IS_NO_TRADES");
  } else if (isResult.metrics.evR > 0 && oosResult.metrics.evR <= 0) {
    status = "DEGRADED";
  } else if (oosResult.metrics.evR <= 0) {
    status = "OOS_FAILED";
    reasons.push("OOS_NON_POSITIVE_EXPECTANCY");
  } else {
    status = "CONSISTENT";
  }

  return {
    strategyId, mode, status,
    inSample, outOfSample, winrateDeltaPct, evRDelta, reasons,
  };
}
