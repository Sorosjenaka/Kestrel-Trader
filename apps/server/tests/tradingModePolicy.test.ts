import { describe, expect, it } from "vitest";
import { configuredTradingModes, resolveEntryMode } from "../src/api/tradingMode.js";
import { resolveMarginPolicy } from "../src/risk/riskEngine.js";

describe("mode boundaries for manual sizing", () => {
  it("defaults omitted mode to the active single lane and rejects disabled lanes", () => {
    expect(resolveEntryMode(undefined, "SWING")).toEqual({ allowed: true, mode: "SWING" });
    expect(resolveEntryMode("SCALP", "SWING")).toMatchObject({ allowed: false, status: 403 });
    expect(resolveEntryMode("SWING", "SCALP")).toMatchObject({ allowed: false, status: 403 });
    expect(configuredTradingModes("BOTH")).toEqual({ scalp: true, swing: true });
    for (const mode of ["BOTH", "", null, 1, {}, "scalp"]) {
      expect(resolveEntryMode(mode, "BOTH")).toMatchObject({ allowed: false, status: 400 });
    }
  });

  it("requires structural SWING SL and never substitutes randomized scalp geometry", () => {
    const base = { mode: "SWING", equityUsd: 200, maxLeverage: 25, seed: "BTCUSDT" };
    expect(resolveMarginPolicy(base)).toMatchObject({ mode: "SWING", allowed: false, reason: "SWING_STRUCTURAL_SL_REQUIRED" });
    const plan = resolveMarginPolicy({ ...base, structuralSlPct: 0.05 });
    expect(plan).toMatchObject({ mode: "SWING", allowed: true, slPct: 0.05 });
    expect(plan.targetRiskUsd).toBeLessThanOrEqual(1);
    expect(plan.marginUsd).toBeLessThanOrEqual(2);
    expect(plan.notionalUsd * 0.05).toBeCloseTo(plan.targetRiskUsd, 4);
    expect(resolveMarginPolicy({ ...base, structuralSlPct: 0.01 })).toMatchObject({ allowed: false, reason: "RISK_FLOOR_MARGIN_CAP" });
    for (const structuralSlPct of [0, -0.01, Number.NaN, 0.201]) {
      expect(resolveMarginPolicy({ ...base, structuralSlPct }).allowed).toBe(false);
    }
  });

  it("keeps SCALP sizing independent of supplied swing geometry", () => {
    const base = { mode: "SCALP", equityUsd: 200, score: 85, seed: "BTCUSDT" };
    expect(resolveMarginPolicy({ ...base, structuralSlPct: 0.15 })).toEqual(resolveMarginPolicy(base));
  });
});
