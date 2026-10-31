// apps/server/src/backtest/validation/stressTester.ts
import type { HistoricalDataset } from "../historicalReplay.js";
import { replayHistoricalDataset, type ReplayOptions } from "../historicalReplay.js";
import type { StrategyMode, FeeStructure } from "../backtestEngine.js";
import { STRESS_PRESETS } from "./slippageModel.js";

export interface StressTestResult {
  scenarioName: string;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  winRate: number;
  totalTrades: number;
  avgSlippageBps: number;
  passed: boolean;
  errors: string[];
}

export interface StressTestReport {
  baseline: StressTestResult;
  scenarios: StressTestResult[];
  worstCase: StressTestResult;
  isResilient: boolean;
  limitations: string[];
}

const CRITICAL_MAX_DRAWDOWN_USD = 200;

export function runStressTest(
  dataset: HistoricalDataset,
  strategyId: string,
  mode: StrategyMode,
  feeStructure: FeeStructure,
): StressTestReport {
  
  const allResults: StressTestResult[] = [];
  let baselineResult: StressTestResult | null = null;

  for (const [key, scenario] of Object.entries(STRESS_PRESETS)) {
    const effectiveSlippageBps = 5 * scenario.volatilityMultiplier;

    const options: ReplayOptions = {
      mode,
      strategyId,
      fees: feeStructure,
      initialEquityUsd: 200,
      targetRiskUsd: 1,
      slippageBps: effectiveSlippageBps,
      tp1ROverride: undefined,
    };

    const output = replayHistoricalDataset(dataset, options);
    const trades = output.trades || [];
    const pnls = trades.map(t => t.netPnlUsd ?? 0);
    const wins = pnls.filter(p => p > 0).length;
    const total = pnls.length;
    
    let cumPnl = 0;
    let peakCumPnl = 0;
    let maxDD = 0;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > peakCumPnl) peakCumPnl = cumPnl;
      const dd = peakCumPnl - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    const result: StressTestResult = {
      scenarioName: key,
      netPnlUsd: pnls.reduce((a, b) => a + b, 0),
      maxDrawdownUsd: maxDD,
      winRate: total > 0 ? wins / total : 0,
      totalTrades: total,
      avgSlippageBps: effectiveSlippageBps,
      errors: [...output.errors, ...(total === 0 ? ["NO_CLOSED_TRADES"] : []), ...(!pnls.every(Number.isFinite) ? ["NON_FINITE_TRADE_PNL"] : [])],
      passed: output.errors.length === 0 && total > 0 && pnls.every(Number.isFinite)
        && maxDD <= CRITICAL_MAX_DRAWDOWN_USD && pnls.reduce((a,b)=>a+b,0) >= -CRITICAL_MAX_DRAWDOWN_USD
    };

    if (key === "NORMAL") baselineResult = result;
    else allResults.push(result);
  }

  if (!baselineResult) throw new Error("Baseline NORMAL scenario missing");
  const worstCase = allResults.length > 0 
    ? allResults.reduce((w, c) => c.maxDrawdownUsd > w.maxDrawdownUsd ? c : w, allResults[0])
    : baselineResult;

  return {
    baseline: baselineResult,
    scenarios: allResults,
    worstCase,
    isResilient: baselineResult.passed && allResults.length > 0 && allResults.every(r => r.passed),
    limitations: ["SLIPPAGE_STRESS_ONLY", "LATENCY_AND_LIQUIDITY_HAIRCUT_NOT_SIMULATED"],
  };
}
