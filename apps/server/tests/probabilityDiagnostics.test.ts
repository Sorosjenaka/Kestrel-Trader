import { describe, expect, it } from "vitest";
import { summarizeObservedProbability, wilson95 } from "../src/analytics/probabilityDiagnostics.js";

describe("observed PAPER probability diagnostics", () => {
  it("keeps a small or losing cohort descriptive, never predictive", () => {
    const result = summarizeObservedProbability([
      { mode: "SCALP", pnlUsd: 1 },
      { mode: "SCALP", pnlUsd: -2 },
      { mode: "SCALP", pnlUsd: 0 },
    ]);
    expect(result.sampleCount).toBe(3);
    expect(result.observedWinRatePct).toBeCloseTo(100 / 3);
    expect(result.breakEvenWinRatePct).toBeCloseTo(50);
    expect(result.netPnlUsd).toBe(-1);
    expect(result.wilson95Pct!.lowerPct).toBeLessThan(result.observedWinRatePct!);
    expect(result.wilson95Pct!.upperPct).toBeGreaterThan(result.observedWinRatePct!);
    expect(result.predictiveWinProbabilityPct).toBeNull();
    expect(result.outOfSampleValidated).toBe(false);
  });

  it("handles empty and extreme binomial samples", () => {
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(2, 1)).toBeNull();
    expect(wilson95(0, 5)!.lowerPct).toBe(0);
    expect(wilson95(5, 5)!.upperPct).toBe(100);
  });
});
