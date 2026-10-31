import type { HistoricalDataset, ReplayOutput } from "../historicalReplay.js";
import { replayHistoricalDataset, validateHistoricalDataset } from "../historicalReplay.js";
import type { StrategyMode, FeeStructure } from "../backtestEngine.js";
import type { CpcvConfig, CpcvFoldResult, CpcvReport } from "./cpcvTypes.js";

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const visit = (start: number, selected: number[]) => {
    if (selected.length === k) { out.push(selected.slice()); return; }
    for (let i = start; i <= n - (k - selected.length); i++) visit(i + 1, [...selected, i]);
  };
  visit(0, []);
  return out;
}

/** Fixed-strategy holdout replay. No model is fitted, so this does not certify
 * parameter selection. Every selected test group is replayed, with the original
 * pre-OOS history retained for closed-bar indicator warmup. Training ranges are
 * purged around each held-out group, including a post-test embargo. */
export function runCpcvValidation(
  dataset: HistoricalDataset, strategyId: string, mode: StrategyMode,
  fees: FeeStructure, config: CpcvConfig,
): CpcvReport {
  if (!Number.isInteger(config.nGroups) || config.nGroups < 2 || config.nGroups > 12
    || !Number.isInteger(config.kTestGroups) || config.kTestGroups < 1 || config.kTestGroups >= config.nGroups
    || ![config.purgeWindowMs, config.embargoMs].every(n => Number.isFinite(n) && n >= 0)) throw new Error("INVALID_CPCV_CONFIG");
  const pre = validateHistoricalDataset(dataset);
  if (pre.length) throw new Error(`INVALID_CPCV_DATASET:${pre.join(",")}`);
  const first = dataset.bars.findIndex(b => b.openTime >= dataset.outOfSampleFrom);
  const after = dataset.bars.findIndex(b => b.openTime >= dataset.outOfSampleTo);
  const end = after < 0 ? dataset.bars.length : after;
  const count = end - first;
  if (first < 0 || count < config.nGroups) throw new Error("INSUFFICIENT_CPCV_OOS_BARS");
  const groups: [number, number][] = Array.from({ length: config.nGroups }, (_, g) => [
    first + Math.floor(g * count / config.nGroups), first + Math.floor((g + 1) * count / config.nGroups),
  ]);
  const folds: CpcvFoldResult[] = [];
  for (const [foldId, selected] of combinations(config.nGroups, config.kTestGroups).entries()) {
    const testIndices = selected.map(g => groups[g]!);
    const excluded = new Set<number>();
    for (const [start, stop] of testIndices) {
      const from = dataset.bars[start]!.openTime - config.purgeWindowMs;
      const to = dataset.bars[stop - 1]!.openTime + dataset.intervalMs + config.purgeWindowMs + config.embargoMs;
      for (let i = first; i < end; i++) if (dataset.bars[i]!.openTime >= from && dataset.bars[i]!.openTime < to) excluded.add(i);
    }
    const trainIndices: [number, number][] = [];
    let rangeStart: number | null = null;
    for (let i = first; i <= end; i++) {
      if (i < end && !excluded.has(i)) { if (rangeStart === null) rangeStart = i; }
      else if (rangeStart !== null) { trainIndices.push([rangeStart, i]); rangeStart = null; }
    }
    const output: ReplayOutput = { trades: [], errors: [], ambiguousBars: 0, rejectedSignals: 0, openTradesExcluded: 0, fundingUsd: 0 };
    for (const [start, stop] of testIndices) {
      const from = dataset.bars[start]!.openTime;
      const to = dataset.bars[stop - 1]!.openTime + dataset.intervalMs;
      const sub = replayHistoricalDataset({ ...dataset, outOfSampleFrom: from, outOfSampleTo: to }, {
        strategyId, mode, fees, initialEquityUsd: 200, targetRiskUsd: 1, slippageBps: 5,
      });
      output.trades.push(...sub.trades);
      output.errors.push(...sub.errors);
      output.ambiguousBars += sub.ambiguousBars;
      output.rejectedSignals += sub.rejectedSignals;
      output.openTradesExcluded += sub.openTradesExcluded;
      output.fundingUsd += sub.fundingUsd;
    }
    output.trades.sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime());
    output.errors = [...new Set(output.errors)];
    if (!output.trades.length) output.errors.push("NO_CLOSED_TRADES");
    const pnls = output.trades.map(t => t.netPnlUsd);
    if (!pnls.every(Number.isFinite)) output.errors.push("NON_FINITE_TRADE_PNL");
    const netPnlUsd = pnls.reduce((a, b) => a + b, 0);
    const mean = netPnlUsd / (pnls.length || 1);
    const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnls.length || 1);
    folds.push({ foldId, trainIndices, testIndices, output, metrics: {
      netPnlUsd, winRate: pnls.length ? pnls.filter(p => p > 0).length / pnls.length : 0,
      sharpeLike: variance > 0 ? mean / Math.sqrt(variance) : 0,
    } });
  }
  const pnls = folds.map(f => f.metrics.netPnlUsd);
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length);
  const min = Math.min(...pnls), max = Math.max(...pnls);
  const consistency = mean ? Math.max(0, 1 - std / Math.abs(mean)) : 0;
  return {
    config, folds,
    aggregated: { meanNetPnl: mean, stdDevNetPnl: std, minNetPnl: min, maxNetPnl: max, consistencyScore: consistency },
    isValidated: folds.every(f => f.output.errors.length === 0 && f.output.trades.length > 0) && min > 0 && consistency > .5,
    limitations: ["FIXED_STRATEGY_HOLDOUT_NO_PARAMETER_FITTING", "EQUITY_RESETS_PER_TEST_GROUP", "OPEN_TRADE_LABELS_PURGED_FROM_TRAINING_RANGES_BY_CONFIGURED_TIME_WINDOW"],
  };
}
