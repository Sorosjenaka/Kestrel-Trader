import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
const state = vi.hoisted(() => ({ empty: false, error: false }));
vi.mock("../src/backtest/historicalReplay.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/backtest/historicalReplay.js")>();
  return { ...actual, replayHistoricalDataset: vi.fn((d, options) => {
    const errors = actual.validateHistoricalDataset(d);
    if (state.error) errors.push("TEST_REPLAY_ERROR");
    const trade = { entryAt: new Date(d.outOfSampleFrom), exitAt: new Date(d.outOfSampleFrom + 60000), netPnlUsd: 1, netR: 1, grossPnlUsd: 1, feesUsd: 0 };
    return { trades: errors.length || state.empty ? [] : [trade], errors, ambiguousBars: 0, rejectedSignals: 0, openTradesExcluded: 0, fundingUsd: 0 };
  }) };
});
import { replayHistoricalDataset, validateHistoricalDataset, type HistoricalDataset } from "../src/backtest/historicalReplay.js";
import { runCpcvValidation } from "../src/backtest/validation/cpcvRunner.js";
import { runOutOfSampleValidation } from "../src/backtest/validation/oosRunner.js";
import { runSensitivityAnalysis } from "../src/backtest/validation/sensitivityRunner.js";
import { runStressTest } from "../src/backtest/validation/stressTester.js";

const minute = 60000, base = 1700000040000;
function dataset(): HistoricalDataset {
  return { schemaVersion: 1, source: "OFFLINE_FIXTURE", symbol: "BTCUSDT", downloadedAt: base + 100 * minute,
    intervalMs: minute, bars: Array.from({ length: 90 }, (_, i) => ({ openTime: base + i * minute, open: 100, high: 101, low: 99, close: 100, volume: 1 })),
    funding: [], fundingCoverage: { from: base, to: base + 90 * minute },
    rules: { tickSize: .01, stepSize: .001, minQty: .001, minNotional: 5, maxLeverage: 25 },
    outOfSampleFrom: base + 20 * minute, outOfSampleTo: base + 90 * minute,
    trainingEndedAt: base + 10 * minute, embargoMs: minute, universeSelection: "predeclared fixture" };
}
const fees = { makerRate: .0002, takerRate: .0005 };
beforeEach(() => { vi.clearAllMocks(); state.empty = false; state.error = false; });

describe("validation data and verdict integrity", () => {
  it("replays a valid IS window and OOS window with real validator acceptance", () => {
    const d = dataset();
    expect(validateHistoricalDataset(d)).toEqual([]);
    const out = runOutOfSampleValidation(d, "S-01", "SCALP", fees);
    expect(out.status).toBe("CONSISTENT");
    expect(out.reasons).toEqual([]);
    expect(out.inSample!.tradeCount).toBe(1);
    for (const [window] of vi.mocked(replayHistoricalDataset).mock.calls) expect(validateHistoricalDataset(window)).toEqual([]);
    expect(d.trainingEndedAt).toBe(base + 10 * minute);
  });
  it("CPCV replays every selected test group, preserves warmup and funding, and purges training", () => {
    const d = dataset(), config = { nGroups: 3, kTestGroups: 2, purgeWindowMs: minute, embargoMs: 2 * minute };
    const out = runCpcvValidation(d, "S-01", "SCALP", fees, config);
    expect(out.folds).toHaveLength(3);
    expect(replayHistoricalDataset).toHaveBeenCalledTimes(6);
    for (const [window, opts] of vi.mocked(replayHistoricalDataset).mock.calls) {
      expect(validateHistoricalDataset(window)).toEqual([]);
      expect(window.bars).toBe(d.bars);
      expect(window.fundingCoverage).toBe(d.fundingCoverage);
      expect(opts.targetRiskUsd).toBe(1);
    }
    for (const fold of out.folds) for (const [start, end] of fold.trainIndices) for (let i = start; i < end; i++) {
      for (const [testStart, testEnd] of fold.testIndices) {
        const from = d.bars[testStart]!.openTime - minute;
        const to = d.bars[testEnd - 1]!.openTime + minute + minute + 2 * minute;
        expect(d.bars[i]!.openTime < from || d.bars[i]!.openTime >= to).toBe(true);
      }
    }
    expect(out.folds.every(f => f.output.trades.length === 2)).toBe(true);
  });
  it("CPCV never validates an empty/error fold", () => {
    state.empty = true;
    const out = runCpcvValidation(dataset(), "S-01", "SCALP", fees, { nGroups: 2, kTestGroups: 1, purgeWindowMs: 0, embargoMs: 0 });
    expect(out.isValidated).toBe(false);
    expect(out.folds.every(f => f.output.errors.includes("NO_CLOSED_TRADES"))).toBe(true);
  });
  it.each(["empty", "error"])("stress fails closed for %s replay instead of reporting resilience", kind => {
    state.empty = kind === "empty"; state.error = kind === "error";
    const out = runStressTest(dataset(), "S-01", "SCALP", fees);
    expect(out.isResilient).toBe(false);
    expect(out.baseline.passed).toBe(false);
    expect(out.baseline.errors.length).toBeGreaterThan(0);
    for (const [, opts] of vi.mocked(replayHistoricalDataset).mock.calls) expect(opts.targetRiskUsd).toBe(1);
  });
  it("marks unavailable sensitivity explicitly and does not run identical fake grids", () => {
    const out = runSensitivityAnalysis(dataset(), "S-01", "SCALP", fees);
    expect(out.status).toBe("UNSUPPORTED");
    expect(out.points).toEqual([]);
    expect(out.bestParams).toEqual({});
    expect(replayHistoricalDataset).not.toHaveBeenCalled();
  });
});
