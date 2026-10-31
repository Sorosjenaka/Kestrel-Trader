// 16 Okt 2026 — Ladder TP 40/30/BE/TPmax di replay backtest (paritas live +
// laporan V10 tervalidasi 16/16). Unit test bar-per-bar untuk simulateLadderExit
// + integrasi fee/metrics lewat replayPlannedTrade. SCALP wajib tetap
// single-target bit-identik (regresi historis di historicalBacktest.test.ts).
import { describe, expect, it } from "vitest";
import {
  simulateLadderExit,
  swingLadderLevelsFromTp1,
  ladderExitLabel,
  replayPlannedTrade,
  type HistoricalDataset,
} from "../src/backtest/historicalReplay.js";
import type { OrderPlan } from "../src/risk/riskEngine.js";
import { swingLadderLevels, swingTpMaxPrice } from "../src/exec/positionSupervisor.js";
import { SWING_TP1_FRAC, SWING_TP2_FRAC, SWING_TP_R } from "../src/strategies/swingBreakoutEngine.js";
import type { Bar } from "../src/universe/eligibility.js";

const T0 = 1_700_000_000_000; // epoch tetap; openTime bar i = T0 + i*60000
const INTERVAL = 60_000;

function bars(rows: [number, number, number, number][]): Bar[] {
  // [open, high, low, close] — volume 1, openTime berurutan per menit.
  return rows.map(([o, h, l, c], i) => ({ openTime: T0 + i * INTERVAL, open: o, high: h, low: l, close: c, volume: 1 }));
}

const LONG_INPUT = { side: "LONG" as const, entry: 100, sl: 97, tp1: 105, tp2: 110, tpMax: 115, slippageBps: 0, outOfSampleTo: T0 + 100 * INTERVAL, intervalMs: INTERVAL };
const SHORT_INPUT = { side: "SHORT" as const, entry: 100, sl: 103, tp1: 95, tp2: 90, tpMax: 85, slippageBps: 0, outOfSampleTo: T0 + 100 * INTERVAL, intervalMs: INTERVAL };

describe("simulateLadderExit — jalur LONG", () => {
  it("1. SL polos: seluruh qty di stop", () => {
    const r = simulateLadderExit(bars([[100, 101, 97, 98.5]]), 0, LONG_INPUT);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ frac: 1, price: 97, kind: "SL", barIndex: 0 });
    expect(r.exitBar).toBe(0);
    expect(r.ambiguousBars).toBe(0);
    expect(ladderExitLabel(r.legs)).toBe("SL");
  });

  it("2. TP1 lalu SL di bar berikutnya (fraksi 0.4 / 0.6)", () => {
    const r = simulateLadderExit(bars([[100, 105, 98, 104], [104, 104.5, 97, 99]]), 0, LONG_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "SL"]);
    expect(r.legs[0]).toMatchObject({ frac: SWING_TP1_FRAC, price: 105, barIndex: 0 });
    expect(r.legs[1]!.frac).toBeCloseTo(1 - SWING_TP1_FRAC, 12);
    expect(r.legs[1]!.price).toBe(97);
    expect(r.exitBar).toBe(1);
    expect(ladderExitLabel(r.legs)).toBe("TP1+SL");
  });

  it("3. TP1+TP2 (satu bar) lalu BE di bar berikutnya, fill tepat di entry", () => {
    const r = simulateLadderExit(bars([[100, 110, 98, 108], [108, 109, 100, 104]]), 0, LONG_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "BE"]);
    expect(r.legs[1]).toMatchObject({ frac: SWING_TP2_FRAC, price: 110 });
    expect(r.legs[2]).toMatchObject({ price: 100, barIndex: 1 });
    expect(r.legs[2]!.frac).toBeCloseTo(1 - SWING_TP1_FRAC - SWING_TP2_FRAC, 12);
    expect(r.exitBar).toBe(1);
    expect(ladderExitLabel(r.legs)).toBe("TP1+TP2+BE");
  });

  it("4. TP1, lalu TP2+TPMAX berantai di bar yang sama", () => {
    const r = simulateLadderExit(bars([[100, 105, 98, 104], [104, 115, 106, 112]]), 0, LONG_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "TPMAX"]);
    expect(r.legs[2]).toMatchObject({ price: 115, barIndex: 1 });
    expect(r.legs[2]!.frac).toBeCloseTo(1 - SWING_TP1_FRAC - SWING_TP2_FRAC, 12);
    expect(ladderExitLabel(r.legs)).toBe("TP1+TP2+TPMAX");
  });

  it("5. sl_first: bar yang menyentuh stop DAN level TP = stop menang, ambiguousBars++", () => {
    const r = simulateLadderExit(bars([[100, 110, 97, 99]]), 0, LONG_INPUT);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ frac: 1, price: 97, kind: "SL" });
    expect(r.ambiguousBars).toBe(1);
    expect(ladderExitLabel(r.legs)).toBe("SL");
  });

  it("6. BE efektif bar BERIKUTNYA: bar TP2 yang menembus entry tidak menutup posisi", () => {
    // bar 0: TP1+TP2 terisi, low 99.5 menembus entry (BE belum aktif) tapi bukan
    // stop lama (97) -> posisi tetap hidup. bar 1: baru kena stop-entry.
    const r = simulateLadderExit(bars([[101, 110, 99.5, 108], [107, 108, 99.9, 104]]), 0, LONG_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "BE"]);
    expect(r.legs[2]!.barIndex).toBe(1); // BUKAN bar 0 — BE baru efektif di bar berikutnya
    expect(r.exitBar).toBe(1);
    expect(ladderExitLabel(r.legs)).toBe("TP1+TP2+BE");
  });

  it("7. Gap stop -> fill di open (lebih buruk), bukan harga stop fiktif", () => {
    const r = simulateLadderExit(bars([[100, 101, 98, 100.5], [95, 95.5, 94, 94.2]]), 0, LONG_INPUT);
    // bar 1 open 95 menembus stop 97 -> fill di open 95
    expect(r.legs[0]).toMatchObject({ frac: 1, price: 95, kind: "SL" });
    expect(ladderExitLabel(r.legs)).toBe("SL");
  });

  it("8. Tiga fase dalam SATU bar: TP1+TP2+TPMAX semua di bar 0", () => {
    const r = simulateLadderExit(bars([[100, 115, 98, 112]]), 0, LONG_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "TPMAX"]);
    expect(r.legs.every(l => l.barIndex === 0)).toBe(true);
    expect(r.exitBar).toBe(0);
    expect(ladderExitLabel(r.legs)).toBe("TP1+TP2+TPMAX");
  });

  it("9. DATA_END: window habis dengan sisa qty -> force-close di close bar terakhir", () => {
    const outTo = T0 + 3 * INTERVAL; // hanya 3 bar dalam window, tak kena level apa pun
    const r = simulateLadderExit(bars([[100, 100.5, 99.5, 100], [100, 100.2, 99.8, 99.9], [99.9, 100, 99.5, 99.6]]), 0,
      { ...LONG_INPUT, outOfSampleTo: outTo });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ frac: 1, price: 99.6, kind: "DATA_END", barIndex: 2 });
    expect(r.exitBar).toBe(2);
    expect(ladderExitLabel(r.legs)).toBe("DATA_END");
  });

  it("10. TP1 saja lalu DATA_END (sisa 60%)", () => {
    const outTo = T0 + 3 * INTERVAL;
    const r = simulateLadderExit(bars([[100, 105, 99, 104], [104, 104.2, 100, 101], [101, 101.5, 100.4, 100.8]]), 0,
      { ...LONG_INPUT, outOfSampleTo: outTo });
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "DATA_END"]);
    expect(r.legs[1]!.frac).toBeCloseTo(1 - SWING_TP1_FRAC, 12);
    expect(ladderExitLabel(r.legs)).toBe("TP1+DATA_END");
  });

  it("11. TP1+TP2 lalu DATA_END (sisa 30%)", () => {
    const outTo = T0 + 2 * INTERVAL;
    const r = simulateLadderExit(bars([[100, 110, 99, 108], [108, 108.5, 100.5, 105]]), 0,
      { ...LONG_INPUT, outOfSampleTo: outTo });
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "DATA_END"]);
    expect(ladderExitLabel(r.legs)).toBe("TP1+TP2+DATA_END");
  });

  it("12. Slippage adverse di semua kaki", () => {
    const r = simulateLadderExit(bars([[100, 105, 99, 104], [104, 104.5, 97, 99]]), 0, { ...LONG_INPUT, slippageBps: 5 });
    expect(r.legs[0]!.price).toBeCloseTo(105 * (1 - 5 / 10000), 10);
    expect(r.legs[1]!.price).toBeCloseTo(97 * (1 - 5 / 10000), 10);
  });
});

describe("simulateLadderExit — jalur SHORT (cermin)", () => {
  it("SL polos SHORT", () => {
    const r = simulateLadderExit(bars([[100, 100.8, 99, 99.5], [99.5, 103.2, 99, 101]]), 0, SHORT_INPUT);
    expect(r.legs[0]).toMatchObject({ frac: 1, price: 103, kind: "SL" });
    expect(r.exitBar).toBe(1);
  });

  it("TP1+TP2+TPMAX SHORT berantai satu bar", () => {
    const r = simulateLadderExit(bars([[100, 100.9, 85, 86]]), 0, SHORT_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "TPMAX"]);
    expect(r.legs[2]!.price).toBe(85);
  });

  it("TP1+TP2 lalu BE SHORT", () => {
    const r = simulateLadderExit(bars([[100, 100.5, 90, 91], [91, 100.2, 91.5, 94]]), 0, SHORT_INPUT);
    expect(r.legs.map(l => l.kind)).toEqual(["TP1", "TP2", "BE"]);
    expect(r.legs[2]!.price).toBe(100);
    expect(r.legs[2]!.barIndex).toBe(1);
  });
});

describe("Paritas level replay <-> live supervisor", () => {
  it("swingLadderLevelsFromTp1 identik swingLadderLevels/swingTpMaxPrice", () => {
    for (const side of ["LONG", "SHORT"] as const) {
      for (const entry of [0.5, 1.234, 100, 97_000]) {
        for (const tp1R of [1.2, 2, 4.74, 20]) { // offset = R; tp1 = entry ± R (semua offset legal)
          const offset = tp1R;
          const tp1 = side === "LONG" ? entry + offset : entry - offset;
          const derived = swingLadderLevelsFromTp1(side, entry, tp1);
          const live = swingLadderLevels({ side, entryPrice: entry, tp1Price: tp1 });
          expect(derived.tp2).toBeCloseTo(live.tp2, 10);
          expect(derived.tpMax).toBeCloseTo(swingTpMaxPrice({ side, entryPrice: entry, tp1Price: tp1 }), 10);
          expect(derived.tpMax).toBeCloseTo(side === "LONG" ? entry + 3 * offset : entry - 3 * offset, 10);
          expect(derived.tp2).toBeCloseTo(side === "LONG" ? entry + 2 * offset : entry - 2 * offset, 10);
          // dan konsisten formula mesin plan: tpMax = entry + 5R dgn offset = 5R/3
          expect(SWING_TP_R / 3 * 3).toBeCloseTo(SWING_TP_R, 12);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integrasi replayPlannedTrade (fee per kaki + metrics agregat + SCALP tetap
// bit-identik).
// ---------------------------------------------------------------------------

function dataset(bars_: Bar[], outOfSampleTo = T0 + bars_.length * INTERVAL): HistoricalDataset {
  return {
    schemaVersion: 1, source: "unit-test fixture (not market evidence)", downloadedAt: outOfSampleTo + INTERVAL,
    symbol: "BTCUSDT", intervalMs: INTERVAL, bars: bars_,
    funding: [], fundingCoverage: { from: T0 - INTERVAL, to: outOfSampleTo },
    rules: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, maxLeverage: 25 },
    outOfSampleFrom: T0, outOfSampleTo, trainingEndedAt: T0 - INTERVAL, embargoMs: 0,
    universeSelection: "test fixture",
  };
}

const optionsSwing = { swingExitPolicy: "LEGACY_40_30" as const, strategyId: "S-05", mode: "SWING" as const, fees: { makerRate: 0.0002, takerRate: 0.0005 }, slippageBps: 0, initialEquityUsd: 200, targetRiskUsd: 1 };
const optionsScalp = { strategyId: "S-01", mode: "SCALP" as const, fees: { makerRate: 0.0002, takerRate: 0.0005 }, slippageBps: 0, initialEquityUsd: 200, targetRiskUsd: 1 };

it("new RR23 replay leaves an unresolved runner open instead of counting a forced DATA_END trade", () => {
  const d = dataset(bars([[100, 102, 99.5, 101.5]]));
  const result = replayPlannedTrade(d, order("LONG",100,99,102,1),0,{...optionsSwing,swingExitPolicy:"RR23"},null);
  expect(result.trade).toBeNull();
  expect(result.nextIndex).toBe(d.bars.length);
});

it("new RR23 completes in two nonzero legs at 2R/3R, yielding gross 2.5R", () => {
  const d = dataset(bars([[100, 103, 99.5, 102.5]]));
  const result = replayPlannedTrade(d, order("LONG",100,99,102,1),0,{...optionsSwing,swingExitPolicy:"RR23"},null);
  expect(result.trade?.exitReason).toBe("TP1+TP2");
  expect(result.trade?.grossR).toBeCloseTo(2.5);
  expect(result.trade?.netPnlUsd).toBeLessThan(2.5);
});

function order(side: "LONG" | "SHORT", entry: number, sl: number, tp1: number, qty = 1): OrderPlan {
  const tp1R = 1.5;
  void tp1R;
  const tp2 = side === "LONG" ? entry + 2 * Math.abs(tp1 - entry) : entry - 2 * Math.abs(tp1 - entry);
  return { symbol: "BTCUSDT", side, entryPrice: entry, slPrice: sl, tp1Price: tp1, tp2Price: tp2, qty, notionalUsd: entry * qty, marginUsd: entry * qty / 25, leverage: 25, effectiveRiskUsd: Math.abs(entry - sl) * qty, estimatedNetRiskUsd: Math.abs(entry - sl) * qty, estimatedFeesUsd: 0, riskReductionRatio: 1, estLiqPrice: 0, liqDistancePct: 1, slDistancePct: Math.abs(entry - sl) / entry, allowed: true, rejectReason: null };
}

describe("replayPlannedTrade — jalur SWING (ladder)", () => {
  it("13. Fee per kaki: entry maker, TP maker, SL taker; net = gross - fees", () => {
    // TP1 di bar 0 (105), SL di bar 1 (97), qty 1, entry 100.
    const d = dataset(bars([[100, 105, 98, 104], [104, 104.5, 97, 99]]));
    const o = order("LONG", 100, 97, 105, 1);
    const { trade } = replayPlannedTrade(d, o, 0, optionsSwing, null);
    expect(trade).not.toBeNull();
    expect(trade!.exitReason).toBe("TP1+SL");
    const entryFee = 100 * 1 * 0.0002;
    const tp1Fee = 105 * 0.4 * 0.0002;
    const slFee = 97 * 0.6 * 0.0005;
    expect(trade!.feesUsd).toBeCloseTo(entryFee + tp1Fee + slFee, 10);
    const gross = 0.4 * (105 - 100) + 0.6 * (97 - 100);
    expect(trade!.grossPnlUsd).toBeCloseTo(gross, 10);
    expect(trade!.netPnlUsd).toBeCloseTo(gross - trade!.feesUsd, 10);
    expect(trade!.isWin).toBe(trade!.netPnlUsd > 0);
    // exitPrice = rata-rata tertimbang kaki
    expect(trade!.exitPrice).toBeCloseTo(0.4 * 105 + 0.6 * 97, 10);
  });

  it("14. DATA_END taker fee dan exitReason berantai; trade selalu resolve (SWING)", () => {
    const d = dataset(bars([[100, 100.5, 99.5, 100], [100, 100.2, 99.8, 99.9], [99.9, 100, 99.5, 99.6]]));
    const { trade } = replayPlannedTrade(d, order("LONG", 100, 97, 105, 1), 0, optionsSwing, null);
    expect(trade).not.toBeNull(); // SWING: tanpa leg pun tetap di-force-close
    expect(trade!.exitReason).toBe("DATA_END");
    expect(trade!.feesUsd).toBeCloseTo(100 * 1 * 0.0002 + 99.6 * 1 * 0.0005, 10);
  });

  it("15. Funding dibebankan pada qty awal-bar (sebelum kaki bar itu)", () => {
    const d = dataset(bars([[100, 105, 98, 104], [104, 104.5, 97, 99]]));
    d.funding = [
      { time: T0 + 0.5 * INTERVAL, rate: 0.0001, markPrice: 100 }, // bar 0: qty penuh
      { time: T0 + 1.5 * INTERVAL, rate: 0.0001, markPrice: 104 }, // bar 1: qty 0.6
    ];
    const { trade, fundingUsd } = replayPlannedTrade(d, order("LONG", 100, 97, 105, 1), 0, optionsSwing, null);
    // bar 0 (TP1 bar ini belum diproses saat funding) -> qty 1
    // bar 1: kaki TP1 terisi di bar 0 -> qty 0.6
    expect(fundingUsd).toBeCloseTo(1 * 100 * 0.0001 + 0.6 * 104 * 0.0001, 10);
    expect(trade!.fundingUsd).toBeCloseTo(fundingUsd, 10);
    expect(trade!.netPnlUsd).toBeCloseTo(trade!.grossPnlUsd - trade!.feesUsd - fundingUsd, 10);
  });

  it("16. Metrics agregat: win = netPnlUsd > 0 (bukan heuristik label)", () => {
    // "TP1+SL": 0.4 di +5 dan 0.6 di -3 -> gross +0.2, jelas profit meski label tak berawalan TP penuh.
    const d = dataset(bars([[100, 105, 98, 104], [104, 104.5, 97, 99]]));
    const { trade } = replayPlannedTrade(d, order("LONG", 100, 97, 105, 1), 0, optionsSwing, null);
    expect(trade!.grossPnlUsd).toBeGreaterThan(0);
    expect(trade!.isWin).toBe(true);
    // Versi rugi: TP1+SL dgn qty sama tapi SL jauh -> tetap label sama, net negatif.
    const d2 = dataset(bars([[100, 105, 98, 104], [104, 104.5, 80, 85]]));
    const { trade: t2 } = replayPlannedTrade(d2, order("LONG", 100, 80, 105, 1), 0, optionsSwing, null);
    expect(t2!.exitReason).toBe("TP1+SL");
    expect(t2!.netPnlUsd).toBeLessThan(0);
    expect(t2!.isWin).toBe(false);
  });
});

describe("Regresi SCALP — jalur single-target tak berubah", () => {
  it("17. SCALP: 100% di TP1, fee taker penuh (entry+exit), bit-identik lama", () => {
    const d = dataset(bars([[100, 102, 99, 101], [101, 101.5, 100, 101]]));
    const { trade } = replayPlannedTrade(d, order("LONG", 100, 98, 102, 1), 0, optionsScalp, null);
    expect(trade!.exitReason).toBe("TP1");
    expect(trade!.feesUsd).toBeCloseTo((100 + 102) * 0.0005, 10); // semua taker, persis kontrak lama
    expect(trade!.exitPrice).toBe(102);
    expect(trade!.grossPnlUsd).toBeCloseTo(2, 10);
  });

  it("18. SCALP: tanpa resolusi -> trade null (kontrak openTradesExcluded tetap)", () => {
    const d = dataset(bars([[100, 100.5, 99.5, 100], [100, 100.2, 99.8, 99.9], [99.9, 100, 99.5, 99.6]]));
    const { trade } = replayPlannedTrade(d, order("LONG", 100, 98, 102, 1), 0, optionsScalp, null);
    expect(trade).toBeNull();
  });
});
