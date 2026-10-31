/** Descriptive closed-PAPER win frequency. This is not a forecast or LLM confidence. */
export function wilson95(wins: number, n: number): { lowerPct: number; upperPct: number } | null {
  if (!Number.isInteger(wins) || !Number.isInteger(n) || n <= 0 || wins < 0 || wins > n) return null;
  const z = 1.959963984540054;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const radius = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return { lowerPct: 100 * Math.max(0, center - radius), upperPct: 100 * Math.min(1, center + radius) };
}

export interface ProbabilityTrade { mode: string; pnlUsd: number }

export function summarizeObservedProbability(trades: ProbabilityTrade[]) {
  const valid = trades.filter((t) => Number.isFinite(t.pnlUsd));
  const wins = valid.filter((t) => t.pnlUsd > 0);
  const losses = valid.filter((t) => t.pnlUsd <= 0);
  const n = valid.length;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlUsd, 0) / wins.length : null;
  const avgLoss = losses.length ? -losses.reduce((a, t) => a + t.pnlUsd, 0) / losses.length : null;
  const breakEvenPct = avgWin !== null && avgLoss !== null && avgWin + avgLoss > 0
    ? 100 * avgLoss / (avgWin + avgLoss) : null;
  const observedWinRatePct = n ? 100 * wins.length / n : null;
  const interval = wilson95(wins.length, n);
  return {
    sampleCount: n,
    wins: wins.length,
    observedWinRatePct,
    wilson95Pct: interval,
    breakEvenWinRatePct: breakEvenPct,
    observedEdgePctPoints: observedWinRatePct !== null && breakEvenPct !== null ? observedWinRatePct - breakEvenPct : null,
    averageWinUsd: avgWin,
    averageLossUsd: avgLoss,
    netPnlUsd: valid.reduce((a, t) => a + t.pnlUsd, 0),
    // Even 500 in-sample outcomes are not proof of calibrated next-trade odds.
    predictiveWinProbabilityPct: null,
    outOfSampleValidated: false,
    minimumEvaluationSamples: 500,
    descriptiveOnly: true,
  };
}
