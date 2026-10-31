import { describe, expect, it } from "vitest";
import { buildTradeForensicBundle, type ForensicBar } from "../src/learning/tradeForensics.js";
import type { TradeForEvaluation } from "../src/learning/postMortemEvaluator.js";

const minute = 60_000;
const start = Date.UTC(2026, 0, 1);
function bar(index: number, overrides: Partial<ForensicBar> = {}): ForensicBar {
  return { openTime: start + index * minute, open: 100, high: 102, low: 98, close: 100, volume: 10, ...overrides };
}
function trade(overrides: Partial<TradeForEvaluation> = {}): TradeForEvaluation {
  return {
    id: 7, positionId: 7, symbol: "SOLUSDT", mode: "SCALP", side: "LONG", riskUsd: 1,
    entryAvg: 100, exitAvg: 99, rMultiple: -1, pnlUsd: -1, feeUsd: 0.05, holdMinutes: 2,
    win: false, closeReason: "SL", source: "PAPER_AI", accountingQuality: "SIMULATED",
    fundingVerified: false, excursionsVerified: false, openedAt: new Date(start + 30_000),
    closedAt: new Date(start + 150_000), createdAt: new Date(start + 150_000),
    plannedSlPrice: 95, plannedTp1Price: 105, ...overrides,
  };
}
const symbols = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BTCDOMUSDT"];
function bundle(targetBars: ForensicBar[], overrides: Partial<TradeForEvaluation> = {}) {
  return buildTradeForensicBundle({
    trade: trade(overrides), interval: "1m",
    barsBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, targetBars])), fetchedAt: new Date(start),
  });
}
function fact(value: ReturnType<typeof bundle>, id: string) { return value.facts.find((item) => item.id === id)!; }

describe("evidence-bounded trade forensics", () => {
  it("requires every expected unique candle and keeps same-candle level order ambiguous", () => {
    const bars = Array.from({ length: 9 }, (_, index) => bar(index));
    bars[1] = bar(1, { low: 94, high: 106 });
    const result = bundle(bars);
    expect(result.coverage.SOLUSDT).toEqual({ expectedBars: 3, receivedBars: 3, complete: true });
    expect(fact(result, "path.sl_level_touched")).toMatchObject({ value: true, status: "DERIVED" });
    expect(fact(result, "path.stop_tp1_same_bar")).toMatchObject({ value: true, status: "DERIVED" });
    expect(fact(result, "path.stop_tp1_same_bar").method).toContain("intrabar sequence");
    expect(fact(result, "path.post_stop_entry_reclaim_within_6_bars")).toMatchObject({ value: false, status: "DERIVED" });
    expect(fact(result, "benchmark.BTCUSDT.return_pct").status).toBe("DERIVED");
    expect(result.limitation).toContain("never proof of stop hunting");
  });

  it("does not call missing SL/TP data a confirmed non-touch and exposes candle gaps", () => {
    const bars = [bar(0), bar(2), ...Array.from({ length: 6 }, (_, index) => bar(index + 3))];
    const result = bundle(bars, { plannedSlPrice: null, plannedTp1Price: null });
    expect(result.coverage.SOLUSDT).toEqual({ expectedBars: 3, receivedBars: 2, complete: false });
    expect(fact(result, "path.sl_level_touched")).toMatchObject({ value: null, status: "UNKNOWN" });
    expect(fact(result, "path.stop_tp1_same_bar")).toMatchObject({ value: null, status: "UNKNOWN" });
    expect(fact(result, "benchmark.BTCUSDT.return_pct")).toMatchObject({ value: null, status: "UNKNOWN" });
  });

  it("computes ATR only from fully closed candles strictly before entry", () => {
    const bars = Array.from({ length: 16 }, (_, index) => bar(index, {
      open: 100, close: 100, high: 101, low: 99,
      ...(index === 15 ? { high: 500, low: 1 } : {}),
    }));
    const result = bundle(bars, { openedAt: new Date(start + 15 * minute + 15_000), closedAt: new Date(start + 16 * minute) });
    expect(fact(result, "entry.atr14")).toMatchObject({ value: 2, status: "DERIVED" });
    expect(fact(result, "entry.sl_atr_ratio")).toMatchObject({ value: 2.5, status: "DERIVED" });
  });

  it("sanitizes hallucinated evidence refs without discarding valid citations", async () => {
    const { validateEvidenceRefs } = await import("../src/learning/tradeForensics.js");
    const allowed = new Set(["trade.pnl_usd", "trade.r_multiple"]);
    expect(validateEvidenceRefs(["trade.pnl_usd", "invented.id", "trade.pnl_usd", "trade.r_multiple"], allowed))
      .toEqual(["trade.pnl_usd", "trade.r_multiple"]);
    expect(validateEvidenceRefs(["invented.id"], allowed)).toBeNull();
    expect(validateEvidenceRefs(Array.from({ length: 20 }, () => "trade.pnl_usd"), allowed)).toEqual(["trade.pnl_usd"]);
  });
});
