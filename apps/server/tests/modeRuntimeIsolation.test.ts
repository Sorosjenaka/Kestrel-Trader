import { describe, expect, it, vi } from "vitest";
import { evaluateMrvStretchGate } from "../src/engines/mrvStretchEngine.js";
import { countPositionsByMode, loadScalpMrvContext } from "../src/strategies/modeContext.js";
import { rrPolicyForMode } from "../src/config/setupEngine.js";
import { calculateOrderPlan } from "../src/risk/riskEngine.js";
import { swingLadderLevelsFromTp1 } from "../src/backtest/historicalReplay.js";
import { buildStrategyPlans } from "../src/strategies/setupStrategies.js";
import { getStrategySpec, strategiesForMode } from "../src/strategies/strategyCatalog.js";
import type { MtfAnalysis } from "../src/engines/multiTimeframeAnalyzer.js";

describe("runtime mode isolation", () => {
  it("counts a shared S-03 strategy by persisted mode, including legacy scalp rows", () => {
    const positions = [{ mode: "SCALP", strategyId: "S-03" }, { mode: "SWING", strategyId: "S-03" },
      { mode: "SWING", strategyId: "S-05" }, { mode: null, strategyId: "S-03" }];
    expect(countPositionsByMode(positions)).toEqual({ SCALP: 2, SWING: 2 });
  });
  it("retains scalp 1.7R and swing research 2R/BE/3R through actual risk sizing", () => {
    // 20 Okt 2026: override S-03 (Fibonacci) dihapus dari setupEngine,
    // jadi tidak ada lagi tp1R spesifik per-strategi untuk S-03.
    expect(rrPolicyForMode("SCALP", "S-03").tp1R).toBe(1.7); // fallback mode SCALP
    expect(rrPolicyForMode("SWING", "S-03").tp1R).toBe(2); // fallback mode SWING
    const plan = calculateOrderPlan({ symbol: "BTCUSDT", mode: "SWING", strategyId: "S-03",
      side: "LONG", entryPrice: 100, slPrice: 97, equityUsd: 200, targetRiskUsd: 1, leverageTarget: 10,
      symbolRules: { symbol: "BTCUSDT", tickSize: 0.0001, stepSize: 0.001, minNotional: 5,
        maxLeverage: 25, leverageUpdatedAt: Date.now() } });
    expect(plan.allowed).toBe(true);
    expect(plan.tp1Price).toBe(106);
    expect(swingLadderLevelsFromTp1("LONG", 100, plan.tp1Price, true)).toEqual({ tp2: 109, tpMax: 109 });
  });
  it("catalog exposes both composite Fibonacci identities and dispatches only mode evaluators", () => {
    // 20 Okt 2026: S-03 Fibonacci dihapus dari katalog aktif.
    expect(strategiesForMode("SWING").map((spec) => spec.id)).not.toContain("S-03");
    expect(getStrategySpec("S-03", "SWING")).toBeNull();
    const analysis = { usable: false, side: "LONG", tfSummary: "test" } as MtfAnalysis;
    const plans = buildStrategyPlans({ mode: "SWING", price: 100, analysis }, 0, ["S-02", "S-03"]);
    expect(plans.find((plan) => plan.strategyId === "S-02")?.reasons).toContain("MODE_NOT_SCALP");
    expect(plans.filter((plan) => plan.matched)).toHaveLength(0);
  });
  it("fetches adequate dedicated MRV windows only when enabled and coalesces requests", async () => {
    const fetcher = vi.fn(async (_symbol: string, interval: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => [Date.UTC(2026, 0, 1) + i * (interval === "1d" ? 86400000 : 300000), 100, 101, 99, 100, 10]));
    expect(await loadScalpMrvContext("DISABLED", ["S-03"], fetcher, 0)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([loadScalpMrvContext("MRVTEST", ["S-04"], fetcher, 0),
      loadScalpMrvContext("MRVTEST", ["S-04"], fetcher, 0)]);
    expect(first?.m5Bars).toHaveLength(300);
    expect(first?.dailyBars).toHaveLength(100);
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("MRV excludes open/future M5 and daily bars at the analysis decision time", async () => {
    const start = Date.UTC(2026, 0, 1);
    const context = await loadScalpMrvContext("MRVCLOSED", ["S-04"], async (_symbol, interval, limit) =>
      Array.from({ length: limit }, (_, i) => [start + i * (interval === "1d" ? 86400000 : 300000), 100, 101, 99, 100, 10]), 0);
    const result = evaluateMrvStretchGate({ ...context!, nowMs: start + 86400000 });
    expect(result.barIndex).toBe(287);
    expect(result.reasons).toContain("MRV_INSUFFICIENT_DAILY_BARS");
    expect(result.signal).toBeNull();
  });
  it("fails closed and retries after failed MRV fetching", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await loadScalpMrvContext("MRVFAIL", ["S-04"], fetcher, 0)).toEqual({ m5Bars: [], dailyBars: [] });
    await loadScalpMrvContext("MRVFAIL", ["S-04"], fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
