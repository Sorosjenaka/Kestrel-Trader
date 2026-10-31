// RSW evaluator -> plan dispatch on the same frozen parity fixture.
// Proves the runtime plan adapter consumes the evaluator output for each RSW
// identity; the separate rswPaperEntryPath test proves sizing/fill downstream.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "../src/universe/eligibility.js";
import { aggregate, DAY, HOUR } from "../src/strategies/researchSwing/rswPrimitives.js";
import { parseAlgoModel } from "../src/strategies/researchSwing/rswSignals.js";
import { buildRswPlans } from "../src/strategies/researchSwing/rswPlans.js";
import type { StrategyContext } from "../src/strategies/setupStrategies.js";

const ROOT = join(__dirname, "..", "..", "..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "research", "data", "rsw-parity", "avax-h1h4d1.json"), "utf8")) as {
  signals: Array<{ symbol: string; time: number; side: "LONG" | "SHORT"; strategyId: string }>;
};

function load15(symbol: string): Bar[] {
  const rows = readFileSync(join(ROOT, "data", "swing-v16", "bars-long-history", `${symbol}-15m.csv`), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => line.split(",").map(Number));
  return rows.filter((x) => x.length >= 6 && Number.isFinite(x[0])).map((x) => ({ time: x[0]!, open: x[1]!, high: x[2]!, low: x[3]!, close: x[4]!, volume: x[5]! }));
}

function ctx(symbol: string, h4: Bar[], h1: Bar[], btcD1: Bar[]): StrategyContext {
  return {
    analysis: { symbol, mode: "SWING", side: "LONG", price: h4.at(-1)!.close, usable: true, reason: null, tfSummary: "RSW fixture", biasAligned: true, analyzedAt: h4.at(-1)!.openTime, timeframes: [], trigger: null, structure: null, bias: null, confirm: null, confirmAligned: true, zoneScore: 0, triggerScore: 0, trendScore: 50, compositeScore: 50, bestZone: null, zoneAnalysis: null, atrTrigger: null, atrStructure: null } as unknown as StrategyContext["analysis"],
    price: h4.at(-1)!.close, mode: "SWING", swing: { h1Bars: h4, h4Bars: h4, h1BarsLong: h1, btcDailyBars: btcD1 },
  };
}

describe("RSW frozen evaluator -> plan dispatch", () => {
  const symbol = "AVAXUSDT";
  const m15 = load15(symbol);
  const h4All = aggregate(m15, 4 * HOUR);
  const h1All = aggregate(m15, HOUR);
  const btcD1 = aggregate(load15("BTCUSDT"), DAY);
  const model = parseAlgoModel(JSON.parse(readFileSync(join(ROOT, "research", "swing_paper_algo_seed.json"), "utf8")));

  for (const sid of ["RSW-01", "RSW-02", "RSW-03"]) {
    it(`${sid}: evaluator signal is routed to the matching plan identity`, () => {
      const ref = FIXTURE.signals.find((s) => s.strategyId === sid);
      expect(ref).toBeDefined();
      const time = ref!.time;
      const h4 = h4All.filter((b) => b.time < time);
      const h1 = h1All.filter((b) => b.time < time);
      const d1 = btcD1.filter((b) => b.time + DAY <= time);
      const plans = buildRswPlans(ctx(symbol, h4.map((b) => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), h1.map((b) => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), d1.map((b) => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))), [sid], model);
      const own = plans.filter((p) => p.strategyId === sid);
      expect(own.length, `${sid} produced no plan; all=${plans.map((p) => p.strategyId).join(",")}`).toBeGreaterThan(0);
      expect(own[0]!.matched).toBe(true);
      expect(own[0]!.side).toBe(ref!.side);
      if (sid === "RSW-03") expect(own.every((p) => p.side === "SHORT")).toBe(true);
    });
  }
});
