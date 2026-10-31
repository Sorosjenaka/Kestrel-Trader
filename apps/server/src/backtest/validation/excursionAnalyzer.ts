// apps/server/src/backtest/validation/excursionAnalyzer.ts
// Analisis Maximum Adverse Excursion (MAE) dan Maximum Favorable Excursion (MFE).
// Digunakan untuk optimasi SL/TP berbasis data empiris, bukan aturan statis.

import type { Bar } from "../../universe/eligibility.js";
import type { StrategyPlan } from "../../strategies/setupStrategies.js";

export interface ExcursionMetrics {
  maeR: number; // Max adverse excursion in R multiples (negative value)
  mfeR: number; // Max favorable excursion in R multiples (positive value)
  timeToMfeBars: number; // Bars until peak profit reached
  timeToMaeBars: number; // Bars until worst drawdown reached
  exitReason: "TP_HIT" | "SL_HIT" | "TIMEOUT" | "MANUAL";
}

/**
 * Simulates intrabar movement conservatively to estimate MAE/MFE.
 * Assumes OHLC sequence: Open -> High/Low (worst case first depending on side) -> Close.
 * For LONG: Worst case is O->L->H->C. Best case is O->H->L->C.
 * We use Conservative Approach: Assume price goes to Low before High for Long (and vice versa for Short)
 * unless we have tick data. This gives realistic (pessimistic) MAE estimates.
 */
export function calculateExcursions(
  plan: StrategyPlan,
  bars: Bar[],
  entryIndex: number,
  exitIndex: number,
  rDistance: number
): ExcursionMetrics | null {
  if (!plan || !bars || entryIndex < 0 || exitIndex >= bars.length || rDistance <= 0) return null;

  const side = plan.side;
  const entryPrice = plan.entryPrice;
  
  let currentWorst = entryPrice;
  let currentBest = entryPrice;
  let timeToWorst = 0;
  let timeToBest = 0;

  // Iterate through holding period
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i];
    
    if (side === "LONG") {
      // Conservative: Check Low first (potential stop hit), then High
      if (bar.low < currentWorst) {
        currentWorst = bar.low;
        timeToWorst = i - entryIndex;
      }
      if (bar.high > currentBest) {
        currentBest = bar.high;
        timeToBest = i - entryIndex;
      }
    } else {
      // SHORT
      if (bar.high > currentWorst) {
        currentWorst = bar.high;
        timeToWorst = i - entryIndex;
      }
      if (bar.low < currentBest) {
        currentBest = bar.low;
        timeToBest = i - entryIndex;
      }
    }
  }

  // Convert prices to R multiples relative to initial risk
  // MAE should be negative (loss potential), MFE positive (gain potential)
  const maePriceDist = side === "LONG" ? (entryPrice - currentWorst) : (currentWorst - entryPrice);
  const mfePriceDist = side === "LONG" ? (currentBest - entryPrice) : (entryPrice - currentBest);

  const maeR = -(maePriceDist / rDistance); // Negative because it's adverse
  const mfeR = mfePriceDist / rDistance;

  // Determine exit reason roughly based on final bar vs levels
  const lastBar = bars[exitIndex];
  let exitReason: ExcursionMetrics["exitReason"] = "TIMEOUT";
  if (side === "LONG") {
    if (lastBar.close >= plan.tp1Price) exitReason = "TP_HIT";
    else if (lastBar.low <= plan.slPrice) exitReason = "SL_HIT";
  } else {
    if (lastBar.close <= plan.tp1Price) exitReason = "TP_HIT";
    else if (lastBar.high >= plan.slPrice) exitReason = "SL_HIT";
  }

  return {
    maeR,
    mfeR,
    timeToMfeBars: timeToBest,
    timeToMaeBars: timeToWorst,
    exitReason
  };
}

export interface AggregatedExcursionStats {
  strategyId: string;
  count: number;
  avgMaeR: number;
  p95MaeR: number; // 95th percentile of worst losses (closest to 0 means tightest stops needed)
  avgMfeR: number;
  p95MfeR: number;
  recommendedSlBufferR: number; // Based on distribution tail
  recommendedTpEfficiency: number; // % of MFE captured at TP
}

/**
 * Aggregates excursion metrics across many trades to suggest optimal SL/TP buffers.
 */
export function aggregateExcursionStats(trades: { plan: StrategyPlan; metrics: ExcursionMetrics }[]): Map<string, AggregatedExcursionStats> {
  const groups = new Map<string, { maes: number[]; mfes: number[]; capturedAtTp: number[] }>();

  for (const t of trades) {
    const id = t.plan.strategyId;
    if (!groups.has(id)) groups.set(id, { maes: [], mfes: [], capturedAtTp: [] });
    const g = groups.get(id)!;
    g.maes.push(Math.abs(t.metrics.maeR)); // Store absolute magnitude for sorting
    g.mfes.push(t.metrics.mfeR);
    
    // Efficiency: How much of MFE was realized? (Approximate: if TP hit, 100% of TP/R. If SL, 0%. If Timeout, variable)
    // Simplified: Just store MFE for now, efficiency calculation requires exact PnL which might be in parent object.
    g.capturedAtTp.push(t.metrics.exitReason === "TP_HIT" ? 1 : 0);
  }

  const results = new Map<string, AggregatedExcursionStats>();

  for (const [id, data] of groups.entries()) {
    if (data.maes.length === 0) continue;

    const sortedMaes = [...data.maes].sort((a, b) => a - b);
    const sortedMfes = [...data.mfes].sort((a, b) => a - b);
    
    const n = sortedMaes.length;
    const p95Index = Math.floor(n * 0.95);
    
    // Avg MAE (magnitude)
    const avgMaeMag = data.maes.reduce((a, b) => a + b, 0) / n;
    // P95 MAE: The worst 5% of excursions. If SL is set tighter than this, we cut winners early.
    const p95MaeMag = sortedMaes[p95Index] || sortedMaes[n - 1];

    const avgMfe = data.mfes.reduce((a, b) => a + b, 0) / n;
    const p95Mfe = sortedMfes[p95Index] || sortedMfes[n - 1];

    results.set(id, {
      strategyId: id,
      count: n,
      avgMaeR: -avgMaeMag, // Restore negative sign convention
      p95MaeR: -p95MaeMag,
      avgMfeR: avgMfe,
      p95MfeR: p95Mfe,
      // Recommendation: Set SL buffer slightly above P95 MAE to avoid premature stop-outs
      recommendedSlBufferR: Math.ceil(p95MaeMag * 10) / 10 + 0.1, 
      recommendedTpEfficiency: data.capturedAtTp.reduce((a,b)=>a+b,0) / n
    });
  }

  return results;
}