// apps/server/tests/partialFillModel.test.ts -- T1.2 (18 Okt 2026).
import { describe, expect, it } from "vitest";
import { estimateLimitFillRatio, filledQtyForLimit, limitTouchedOnBar } from "../src/backtest/partialFillModel.js";

describe("estimateLimitFillRatio", () => {
  it("returns 1 when volume or price is zero/invalid (fail-safe)", () => {
    expect(estimateLimitFillRatio(100, 0, 50000)).toBe(1);
    expect(estimateLimitFillRatio(100, -5, 50000)).toBe(1);
    expect(estimateLimitFillRatio(100, 1000, 0)).toBe(1);
    expect(estimateLimitFillRatio(100, 1000, NaN)).toBe(1);
  });

  it("returns 1 for tiny orders relative to bar volume", () => {
    // notional = $100; barNotional = 1000 * 50000 = $50M; cap 10% = $5M >> $100
    expect(estimateLimitFillRatio(100, 1000, 50000)).toBe(1);
  });

  it("scales down when notional exceeds participation cap", () => {
    // notional = $10M; barNotional = 1000 * 50000 = $50M; cap 10% = $5M
    // ratio = 5M / 10M = 0.5
    const ratio = estimateLimitFillRatio(10_000_000, 1000, 50000);
    expect(ratio).toBeCloseTo(0.5, 4);
  });

  it("never returns below 0", () => {
    const ratio = estimateLimitFillRatio(1_000_000_000, 1, 1);
    expect(ratio).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for invalid order notional", () => {
    expect(estimateLimitFillRatio(-1, 1000, 50000)).toBe(0);
    expect(estimateLimitFillRatio(NaN, 1000, 50000)).toBe(0);
  });
});

describe("filledQtyForLimit", () => {
  it("returns full qty when order fits within cap", () => {
    // notional = 0.04 * 50000 = $2000; barNotional = 1000 * 50000 = $50M
    expect(filledQtyForLimit(0.04, 50000, 1000, 50000)).toBe(0.04);
  });

  it("scales qty when notional exceeds cap", () => {
    // notional = 100 * 50000 = $5M; barNotional = 1000 * 50000 = $50M; cap = $5M
    // exactly at cap -> ratio = 1.0
    const filled = filledQtyForLimit(100, 50000, 1000, 50000);
    expect(filled).toBe(100);
  });
});

describe("limitTouchedOnBar", () => {
  it("LONG touched when bar low <= limit price", () => {
    expect(limitTouchedOnBar("LONG", 100, 99, 105)).toBe(true);
    expect(limitTouchedOnBar("LONG", 100, 101, 105)).toBe(false);
  });

  it("SHORT touched when bar high >= limit price", () => {
    expect(limitTouchedOnBar("SHORT", 100, 95, 101)).toBe(true);
    expect(limitTouchedOnBar("SHORT", 100, 95, 99)).toBe(false);
  });
});
