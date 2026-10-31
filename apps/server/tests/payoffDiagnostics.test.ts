import { describe, expect, it } from "vitest";
import { summarizePayoffTrades } from "../src/analytics/payoffDiagnostics.js";

describe("fee-inclusive payoff diagnostics", () => {
  it("menunjukkan win rate impas dari payoff aktual, bukan target tetap", () => {
    const result = summarizePayoffTrades([
      { pnlUsd: 0.75, rMultiple: 0.7, feeUsd: 0.03, closeReason: "BE" },
      { pnlUsd: 1.5, rMultiple: 1.4, feeUsd: 0.03, closeReason: "TP2" },
      { pnlUsd: -1.25, rMultiple: -1.2, feeUsd: 0.05, closeReason: "SL" },
      { pnlUsd: -1.25, rMultiple: -1.2, feeUsd: 0.05, closeReason: "SL" },
    ]);
    expect(result.sampleCount).toBe(4);
    expect(result.winRatePct).toBe(50);
    expect(result.netPnlUsd).toBeCloseTo(-0.25);
    expect(result.avgWinUsd).toBeCloseTo(1.125);
    expect(result.avgLossUsd).toBeCloseTo(1.25);
    expect(result.breakEvenWinRatePct).toBeCloseTo(52.63158);
    expect(result.exitCounts).toEqual({ BE: 1, TP2: 1, SL: 2 });
  });

  it("tidak mengarang titik impas bila belum ada kedua jenis outcome", () => {
    expect(summarizePayoffTrades([]).breakEvenWinRatePct).toBeNull();
    expect(summarizePayoffTrades([{ pnlUsd: 1, rMultiple: 1, feeUsd: 0, closeReason: "TP2" }]).breakEvenWinRatePct).toBeNull();
  });
});
