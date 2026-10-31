// apps/server/tests/knnFeatures.test.ts - Kontrak fitur KNN latih-vs-query.
import { describe, expect, it } from "vitest";
import {
  buildKnnFeatures,
  lorentzianDistance,
  VOL_NORM_USD,
} from "../src/engines/knnAnalogEngine.js";

describe("buildKnnFeatures (kontrak latih-query KNN)", () => {
  it("memetakan skor + adx + volume ke vektor 5 dimensi", () => {
    const f = buildKnnFeatures({ zoneScore: 80, triggerScore: 70, trendScore: 75, adx: 30, volume24hUsd: 75_000_000 });
    expect(f).toHaveLength(5);
    expect(f[0]).toBe(80);
    expect(f[3]).toBe(30);
    expect(f[4]).toBeCloseTo(1.5, 4);
  });

  it("fallback netral bila data hilang + clamp volRatio [0.2, 5]", () => {
    const f = buildKnnFeatures({ zoneScore: NaN, triggerScore: 70, trendScore: 75, adx: null, volume24hUsd: null });
    expect(f[0]).toBe(50);
    expect(f[3]).toBe(20);
    expect(f[4]).toBe(1);
    expect(buildKnnFeatures({ zoneScore: 1, triggerScore: 1, trendScore: 1, volume24hUsd: 5_000_000_000 })[4]).toBe(5);
    expect(buildKnnFeatures({ zoneScore: 1, triggerScore: 1, trendScore: 1, volume24hUsd: 1_000 })[4]).toBe(0.2);
  });

  it("VOL_NORM_USD konsisten train vs query (jarak kecil untuk setup mirip)", () => {
    const a = buildKnnFeatures({ zoneScore: 80, triggerScore: 70, trendScore: 75, adx: 30, volume24hUsd: VOL_NORM_USD });
    const b = buildKnnFeatures({ zoneScore: 81, triggerScore: 69, trendScore: 75, adx: 31, volume24hUsd: VOL_NORM_USD });
    expect(lorentzianDistance(a, b)).toBeLessThan(2.5);
  });
});
