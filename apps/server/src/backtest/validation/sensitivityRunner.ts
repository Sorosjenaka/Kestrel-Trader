import type { HistoricalDataset } from "../historicalReplay.js";
import type { StrategyMode, FeeStructure } from "../backtestEngine.js";

export interface SensitivityPoint {
  params: Record<string, number>;
  netPnlUsd: number;
  sharpeLike: number;
}

export interface SensitivityReport {
  strategyId: string;
  bestParams: Record<string, number>;
  worstParams: Record<string, number>;
  points: SensitivityPoint[];
  stabilityScore: number;
  status: "UNSUPPORTED";
  reasons: string[];
}

/** RR is operator-locked. Global SL mutations cannot isolate a replay from the
 * trading process. Do not rank parameter labels that the engine never consumed. */
export function runSensitivityAnalysis(
  _dataset: HistoricalDataset, strategyId: string, _mode: StrategyMode, _fees: FeeStructure,
): SensitivityReport {
  return {
    strategyId, bestParams: {}, worstParams: {}, points: [], stabilityScore: 0,
    status: "UNSUPPORTED",
    reasons: ["RR_LOCKED_BY_OPERATOR", "NO_ISOLATED_APPROVED_REPLAY_PARAMETER_GRID"],
  };
}
