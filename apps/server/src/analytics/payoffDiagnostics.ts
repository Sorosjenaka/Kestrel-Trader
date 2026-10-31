/** Descriptive, fee-inclusive closed-trade payoff statistics. No forecast. */
export interface PayoffTrade {
  pnlUsd: number;
  rMultiple: number;
  feeUsd: number;
  closeReason: string | null;
}

export function summarizePayoffTrades(trades: PayoffTrade[]) {
  const valid = trades.filter((t) => Number.isFinite(t.pnlUsd) && Number.isFinite(t.rMultiple));
  const wins = valid.filter((t) => t.pnlUsd > 0);
  const losses = valid.filter((t) => t.pnlUsd <= 0);
  const winUsd = wins.reduce((sum, t) => sum + t.pnlUsd, 0);
  const lossUsd = -losses.reduce((sum, t) => sum + t.pnlUsd, 0);
  const avgWinUsd = wins.length ? winUsd / wins.length : null;
  const avgLossUsd = losses.length ? lossUsd / losses.length : null;
  const breakEvenWinRatePct = avgWinUsd !== null && avgLossUsd !== null && avgWinUsd + avgLossUsd > 0
    ? 100 * avgLossUsd / (avgWinUsd + avgLossUsd) : null;
  const exitCounts: Record<string, number> = {};
  for (const trade of valid) {
    const reason = trade.closeReason || "UNKNOWN";
    exitCounts[reason] = (exitCounts[reason] ?? 0) + 1;
  }
  return {
    sampleCount: valid.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: valid.length ? 100 * wins.length / valid.length : null,
    netPnlUsd: winUsd - lossUsd,
    feeUsd: valid.reduce((sum, t) => sum + (Number.isFinite(t.feeUsd) ? t.feeUsd : 0), 0),
    profitFactor: lossUsd > 0 ? winUsd / lossUsd : null,
    avgWinUsd,
    avgLossUsd,
    avgWinR: wins.length ? wins.reduce((sum, t) => sum + t.rMultiple, 0) / wins.length : null,
    avgLossR: losses.length ? losses.reduce((sum, t) => sum + t.rMultiple, 0) / losses.length : null,
    breakEvenWinRatePct,
    exitCounts,
    provenance: "PAPER_AI / SIMULATED / CLOSED; fee estimated; funding unverified" as const,
  };
}
