// Unit test Market Intelligence (master task Fase 9). npx vitest run src/agents/marketIntel.test.ts
import { describe, it, expect } from "vitest";
import {
  computeBreadth, classifyRelativeStrength, classifyRegime, computeLiquidityFeature, computeDataQuality,
} from "./marketIntel.js";

describe("computeBreadth", () => {
  it("menghitung pos/neg dan coverage; null dikecualikan bukan dihitung negatif", () => {
    const r = computeBreadth([1.2, -0.5, null, NaN, 0.1]);
    expect(r.positive).toBe(2);
    expect(r.negative).toBe(1);
    expect(r.valid).toBe(3);
    expect(r.coverage_ratio).toBeCloseTo(3 / 5);
  });
  it("daftar kosong → coverage 0, bukan NaN", () => {
    expect(computeBreadth([])).toEqual({ positive: 0, negative: 0, valid: 0, coverage_ratio: 0 });
  });
});

describe("classifyRelativeStrength", () => {
  it("BTC > benchmark +0.25% → STRONG", () => {
    expect(classifyRelativeStrength(1.0, 0.5).classification).toBe("STRONG");
  });
  it("BTC < benchmark -0.25% → WEAK", () => {
    expect(classifyRelativeStrength(-0.5, 0.5).classification).toBe("WEAK");
  });
  it("di dalam ±0.25% → NEUTRAL", () => {
    expect(classifyRelativeStrength(0.5, 0.4).classification).toBe("NEUTRAL");
  });
  it("data hilang → UNKNOWN, bukan 0 palsu", () => {
    expect(classifyRelativeStrength(null, 0.5).classification).toBe("UNKNOWN");
  });
});

describe("classifyRegime", () => {
  const trendUp = Array.from({ length: 24 }, (_, i) => 100 + i * 1.2);
  it("tren naik konsisten → TREND_UP", () => {
    expect(classifyRegime(trendUp, null).label).toBe("TREND_UP");
  });
  it("harga sideways bergantian → RANGE", () => {
    const range = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101];
    expect(classifyRegime(range, null).label).toBe("RANGE");
  });
  it("data terlalu sedikit → UNKNOWN", () => {
    expect(classifyRegime([100, 101, 102], null).label).toBe("UNKNOWN");
  });
  it("volatilitas ekstrem menimpa tren → EXTREME", () => {
    const wild = Array.from({ length: 24 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.06 : -0.05)));
    expect(classifyRegime(wild, null).label).toBe("EXTREME");
  });
});

describe("computeLiquidityFeature", () => {
  const depth = {
    bids: [["99.9", "10"], ["99.5", "2"]] as [string, string][],
    asks: [["100.1", "5"], ["100.6", "1"]] as [string, string][],
  };
  it("imbalance dalam [-1,1] dan notional dekat-mid dihitung", () => {
    const f = computeLiquidityFeature("TESTUSDT", depth);
    expect(f.imbalance).not.toBeNull();
    expect(f.imbalance!).toBeGreaterThan(0); // 999 vs 501 bid > ask
    expect(f.bidNotionalNear).toBe(999);
    expect(f.askNotionalNear).toBe(501);
    expect(f.stale).toBe(false);
    expect(f.walls.length).toBeGreaterThan(0);
    expect(f.walls[0]!.notionalUsd).toBe(999);
  });
  it("depth kosong → stale true, imbalance null (bukan 0 palsu)", () => {
    const f = computeLiquidityFeature("TESTUSDT", { bids: [], asks: [] });
    expect(f.stale).toBe(true);
    expect(f.imbalance).toBeNull();
  });
});

describe("computeDataQuality", () => {
  const ok = { coverage: 1, universeTarget: 25, depthOk: 3, depthTried: 3, liqState: "CONNECTED", generatedAtMs: Date.now(), lastTickerAgeMs: 1000 };
  it("semua sehat → FRESH", () => {
    expect(computeDataQuality(ok).status).toBe("FRESH");
  });
  it("coverage rendah → PARTIAL dengan missing_features", () => {
    const d = computeDataQuality({ ...ok, coverage: 0.4 });
    expect(d.status).toBe("PARTIAL");
    expect(d.missing_features).toContain("universe_coverage<50%");
  });
  it("stream likuidasi putus → missing liquidation_stream", () => {
    const d = computeDataQuality({ ...ok, liqState: "DISCONNECTED" });
    expect(d.missing_features).toContain("liquidation_stream");
  });
  it("ticker stale tua → STALE", () => {
    expect(computeDataQuality({ ...ok, coverage: 0.4, lastTickerAgeMs: 500_000 }).status).toBe("STALE");
  });
});
