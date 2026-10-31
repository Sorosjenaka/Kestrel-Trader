// tests/feeAwareGate.test.ts — T0.4 (18 Okt 2026): gate fee-aware net EV.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_SAMPLES,
  evaluateNetEvGate,
  NET_EV_GATE_ID,
} from "../src/backtest/feeAwareGate.js";
import { calculateMetrics, type TradeResult } from "../src/backtest/backtestEngine.js";

function metrics(over: Partial<import("../src/backtest/backtestEngine.js").BacktestMetrics> = {}) {
  return {
    sampleCount: 600,
    winCount: 240,
    lossCount: 360,
    winrate: 40,
    evUsd: 0.02,
    evR: 0.05,
    maxDdUsd: 12,
    totalGrossPnlUsd: 40,
    totalFeesUsd: 28,
    totalFundingUsd: 0,
    totalNetPnlUsd: 12,
    ...over,
  };
}

describe("evaluateNetEvGate (T0.4)", () => {
  it("konstanta gate terdefinisi", () => {
    expect(NET_EV_GATE_ID).toBe("T0.4_NET_EV_FEE_AWARE");
    expect(DEFAULT_MIN_SAMPLES).toBe(500);
  });

  it("SUPPORTIVE: sampel cukup, metrik valid, net EV > 0", () => {
    const r = evaluateNetEvGate(metrics());
    expect(r.gatePassed).toBe(true);
    expect(r.verdict).toBe("SUPPORTIVE");
    expect(r.failedGateReasons).toEqual([]);
    expect(r.minSamples).toBe(DEFAULT_MIN_SAMPLES);
  });

  it("TIDAK mematok winrate — WR 38% tetap SUPPORTIVE bila net EV > 0", () => {
    // RR23 SWING beroperasi ~37-39% WR; gate FR-14 (60%) akan menolaknya.
    const r = evaluateNetEvGate(metrics({ winrate: 38, winCount: 228, lossCount: 372 }));
    expect(r.gatePassed).toBe(true);
    expect(r.verdict).toBe("SUPPORTIVE");
  });

  it("REFUTED: sampel cukup tapi net EV <= 0", () => {
    const r = evaluateNetEvGate(metrics({ evUsd: -0.01, totalNetPnlUsd: -6 }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("REFUTED");
    expect(r.failedGateReasons).toContain("EV_NET_FEE_LE_0");
  });

  it("REFUTED: net EV == 0 dianggap tidak lolos (butuh > 0, bukan >= 0)", () => {
    const r = evaluateNetEvGate(metrics({ evUsd: 0, totalNetPnlUsd: 0 }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("REFUTED");
    expect(r.failedGateReasons).toContain("EV_NET_FEE_LE_0");
  });

  it("INCONCLUSIVE: sampel kurang — EV tidak dinilai, verdict INCONCLUSIVE", () => {
    const r = evaluateNetEvGate(metrics({ sampleCount: 100, winCount: 40, lossCount: 60 }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.failedGateReasons).toContain("SAMPLES_LT_500");
    // EV belum dibaca sebagai REFUTED walau bisa negatif pada sampel kecil.
    expect(r.failedGateReasons).not.toContain("EV_NET_FEE_LE_0");
  });

  it("INCONCLUSIVE: metrik tak terhingga (NaN/Infinity)", () => {
    const r = evaluateNetEvGate(metrics({ evUsd: Number.NaN }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.failedGateReasons).toContain("NON_FINITE_METRICS");
  });

  it("INCONCLUSIVE: hitungan tidak valid (win+loss != sample)", () => {
    const r = evaluateNetEvGate(metrics({ winCount: 10, lossCount: 10, sampleCount: 600 }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.failedGateReasons).toContain("INVALID_COUNTS");
  });

  it("sampel kurang + EV negatif tetap INCONCLUSIVE (sampel mendahului EV)", () => {
    const r = evaluateNetEvGate(metrics({ sampleCount: 5, winCount: 1, lossCount: 4, evUsd: -1 }));
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.failedGateReasons).toContain("SAMPLES_LT_500");
    expect(r.failedGateReasons).not.toContain("EV_NET_FEE_LE_0");
  });

  it("minSamples bisa dioverride (mis. gate eksplorasi SWING)", () => {
    const r = evaluateNetEvGate(metrics({ sampleCount: 100, winCount: 40, lossCount: 60 }), { minSamples: 50 });
    expect(r.gatePassed).toBe(true);
    expect(r.verdict).toBe("SUPPORTIVE");
    expect(r.minSamples).toBe(50);
    // Nama alasan mengikuti ambang yang dipakai.
    expect(evaluateNetEvGate(metrics({ sampleCount: 20 }), { minSamples: 50 }).failedGateReasons).toContain("SAMPLES_LT_50");
  });

  it("minSamples tidak valid -> fallback default 500", () => {
    expect(evaluateNetEvGate(metrics(), { minSamples: Number.NaN }).minSamples).toBe(DEFAULT_MIN_SAMPLES);
    expect(evaluateNetEvGate(metrics(), { minSamples: -3 }).minSamples).toBe(DEFAULT_MIN_SAMPLES);
    expect(evaluateNetEvGate(metrics(), { minSamples: 0 }).minSamples).toBe(DEFAULT_MIN_SAMPLES);
  });

  it("nol sampel -> INCONCLUSIVE, bukan klaim", () => {
    const r = evaluateNetEvGate(metrics({ sampleCount: 0, winCount: 0, lossCount: 0, evUsd: 0, totalNetPnlUsd: 0 }));
    expect(r.gatePassed).toBe(false);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.failedGateReasons).toContain("SAMPLES_LT_500");
  });
});

// Integrasi ringan: gate membaca keluaran calculateMetrics apa adanya (tanpa hitung ulang).
describe("evaluateNetEvGate + calculateMetrics (integrasi)", () => {
  function trade(net: number): TradeResult {
    return {
      symbol: "BTCUSDT", direction: "LONG", entryPrice: 100, exitPrice: 100,
      entryAt: new Date(0), exitAt: new Date(1), exitReason: "TP1", slPct: 0.008,
      effectiveNotional: 100, effectiveRiskUsd: 1, grossR: net, grossPnlUsd: net,
      feesUsd: 0, netPnlUsd: net, netR: net, isWin: net > 0,
    };
  }

  it("deret trade dengan EV bersih positif -> SUPPORTIVE", () => {
    const trades = Array.from({ length: 520 }, (_, i) => trade(i % 5 === 0 ? 2 : -0.4));
    const r = evaluateNetEvGate(calculateMetrics(trades));
    // EV = (104*2 + 416*-0.4)/520 = (208 - 166.4)/520 > 0
    expect(calculateMetrics(trades).evUsd).toBeGreaterThan(0);
    expect(r.verdict).toBe("SUPPORTIVE");
  });

  it("deret trade dengan EV bersih negatif -> REFUTED", () => {
    const trades = Array.from({ length: 520 }, (_, i) => trade(i % 5 === 0 ? 1 : -0.5));
    const r = evaluateNetEvGate(calculateMetrics(trades));
    expect(calculateMetrics(trades).evUsd).toBeLessThan(0);
    expect(r.verdict).toBe("REFUTED");
    expect(r.failedGateReasons).toContain("EV_NET_FEE_LE_0");
  });
});
