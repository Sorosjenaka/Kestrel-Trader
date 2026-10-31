// 16 Okt 2026 — Big Brain: DecisionLog lane SWING. Unit test pemetaan keputusan
// + fitur; integrasi wiring di autonomousTradingBot berupa fail-open helper
// (regresi: swingLane.test.ts, decisionLog.test.ts).
import { describe, expect, it } from "vitest";
import { mapSwingDecisionToDecisionLog, buildSwingDecisionFeatures } from "../src/learning/swingDecisionFeatures.js";
import type { MtfAnalysis } from "../src/engines/multiTimeframeAnalyzer.js";
import type { Bar } from "../src/universe/eligibility.js";

function analysis(): MtfAnalysis {
  return {
    symbol: "BTCUSDT", mode: "SWING", timeframes: [], confirm: null, confirmAligned: false,
    trigger: { interval: "1h", role: "TRIGGER", available: true, bars: 100, atr: 2.5, atrPct: 1.8, regime: "BULLISH", trend: "UP", trendScore: 70, zlema: 100, adx: 28, chop: 38, shieldActive: false, zoneScore: 1, bestZone: null, usableZones: [], squeezeOn: false, squeezeRelease: false, squeezeDirection: "NEUTRAL", squeezeTarget: null, triggerScore: 55, barsData: [] },
    structure: { interval: "4h", role: "STRUCTURE", available: true, bars: 100, atr: 8, atrPct: 2.2, regime: "BULLISH", trend: "UP", trendScore: 65, zlema: 100, adx: 26.5, chop: 41, shieldActive: false, zoneScore: 1, bestZone: null, usableZones: [], squeezeOn: false, squeezeRelease: false, squeezeDirection: "NEUTRAL", squeezeTarget: null, triggerScore: 50, barsData: [] },
    bias: { interval: "1d", role: "BIAS", available: true, bars: 100, atr: 20, atrPct: 3, regime: "BULLISH", trend: "UP", trendScore: 60, zlema: 100, adx: 30, chop: 35, shieldActive: false, zoneScore: 1, bestZone: null, usableZones: [], squeezeOn: false, squeezeRelease: false, squeezeDirection: "NEUTRAL", squeezeTarget: null, triggerScore: 50, barsData: [] },
    zoneScore: 2, triggerScore: 55, trendScore: 66, compositeScore: 61,
    biasAligned: true, side: "LONG", bestZone: null, zoneAnalysis: null,
    atrTrigger: 2.5, atrStructure: 8, price: 100, usable: true, reason: null,
    tfSummary: "test", analyzedAt: 0,
  } as unknown as MtfAnalysis;
}

const h1Bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({
  openTime: i * 3_600_000, open: 100 + i * 0.1, high: 100.5 + i * 0.1,
  low: 99.5 + i * 0.1, close: 100.2 + i * 0.1, volume: 10,
}));

describe("mapSwingDecisionToDecisionLog", () => {
  it("4 keputusan swing -> kosakata DecisionLog", () => {
    expect(mapSwingDecisionToDecisionLog("ENTRY_OPENED")).toBe("GO");
    expect(mapSwingDecisionToDecisionLog("ENTRY_REJECTED")).toBe("NO_GO");
    expect(mapSwingDecisionToDecisionLog("SKIP_ENTRY_GAP")).toBe("SKIPPED");
    expect(mapSwingDecisionToDecisionLog("SIGNAL_NO_PLAN")).toBe("SKIPPED");
  });
});

describe("buildSwingDecisionFeatures", () => {
  it("fitur terisi dari MtfAnalysis; mode SWING; tanpa fabrikasi knn/drex", () => {
    const f = buildSwingDecisionFeatures({
      symbol: "BTCUSDT", side: "LONG", strategyId: "S-05", decision: "GO",
      analysis: analysis(), h1Bars, price: 130,
    });
    expect(f.mode).toBe("SWING");
    expect(f.decision).toBe("GO");
    expect(f.strategyId).toBe("S-05");
    expect(f.compositeScore).toBe(61);
    expect(f.trendScore).toBe(66);
    expect(f.regime).toBe("BULLISH");
    expect(f.choppiness).toBe(41);
    expect(f.adx).toBe(26.5);
    expect(f.atrPct).toBe(1.8);
    expect(f.er).not.toBeNull(); // h1Bars trending -> ER finite
    expect(f.pocDistanceBins).not.toBeNull();
    // jujur null/absent — lane SWING tidak menghitung ini
    expect(f.knnProb ?? null).toBeNull();
    expect(f.drexProb ?? null).toBeNull();
    expect(f.oiChangePct ?? null).toBeNull();
    expect(f.betaBtc ?? null).toBeNull();
    expect(f.macroAllowed ?? null).toBeNull();
    expect(f.cooldownAgeMs ?? null).toBeNull();
  });

  it("SIGNAL_NO_PLAN: strategyId null + rejectReason terbawa", () => {
    const f = buildSwingDecisionFeatures({
      symbol: "ETHUSDT", side: "SHORT", strategyId: null, decision: "SKIPPED",
      rejectReason: "S-05:pivot belum konvergen", analysis: analysis(), h1Bars, price: 100,
    });
    expect(f.strategyId).toBeNull();
    expect(f.rejectReason).toBe("S-05:pivot belum konvergen");
    expect(f.decision).toBe("SKIPPED");
  });

  it("bar kosong / harga tak valid -> ER & PoC null (tanpa error)", () => {
    const f = buildSwingDecisionFeatures({
      symbol: "X", side: "LONG", strategyId: null, decision: "SKIPPED",
      analysis: analysis(), h1Bars: [], price: NaN,
    });
    expect(f.er).toBeNull();
    expect(f.pocDistanceBins).toBeNull();
  });

  it("field non-finite dari analysis -> null (tanpa fabrikasi)", () => {
    const a = analysis();
    a.structure.chop = NaN;
    a.trigger.atrPct = undefined as unknown as number;
    const f = buildSwingDecisionFeatures({
      symbol: "X", side: "LONG", strategyId: null, decision: "GO", analysis: a, h1Bars, price: 100,
    });
    expect(f.choppiness).toBeNull();
    expect(f.atrPct).toBeNull();
    expect(f.compositeScore).toBe(61); // field lain tetap terisi
  });
});
