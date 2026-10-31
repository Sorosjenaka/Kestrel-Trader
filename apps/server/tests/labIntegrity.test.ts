import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
import { runLabBacktest } from "../src/lab/labEngine.js";
import { parsePineSource } from "../src/lab/pineParser.js";
import type { LabSpec } from "../src/lab/labTypes.js";
const bar = (t: number, h = 100.1, l = 99.9, c = 100) => ({ t: t * 60000, o: 100, h, l, c, v: 1 });
const spec: LabSpec = { name: "offline", symbol: "BTCUSDT", interval: "1m", from: "2026-01-01", to: "2026-01-02", direction: "LONG",
  entryConditions: [{ left: { kind: "VALUE", value: 1 }, op: "GT", right: { kind: "VALUE", value: 0 } }],
  sl: { kind: "PCT", value: 1 }, tp: { kind: "PCT", value: 2 }, source: "MANUAL_BLOCK" };
describe("Lab execution chronology", () => {
  it("honors a stop touched on the entry candle before a later target", () => {
    const out = runLabBacktest(spec, [bar(0), bar(1), bar(2, 100.1, 98, 99), bar(3, 103, 99.9, 102)]);
    expect(out.trades[0]).toMatchObject({ entryTime: 120000, exitTime: 120000, slPrice: 99, exitPrice: 99, exitReason: "SL" });
    expect(out.trades[0]!.rMultiple).toBeLessThan(-1);
  });
  it("freezes entry ATR before future entry-bar high/low is observed", () => {
    const atrSpec: LabSpec = { ...spec, sl: { kind: "ATR_MULT", atrPeriod: 2, mult: 1 } };
    const a = runLabBacktest(atrSpec, [bar(0), bar(1), bar(2, 101, 99), bar(3)]);
    const b = runLabBacktest(atrSpec, [bar(0), bar(1), bar(2, 120, 80), bar(3)]);
    expect(a.trades[0]!.slPrice).toBeCloseTo(99.8);
    expect(a.trades[0]!.slPrice).toBe(b.trades[0]!.slPrice);
  });
  it("interprets literal Pine stop/limit as absolute prices end to end", () => {
    const parsed = parsePineSource('if close > open\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", stop=99, limit=102)');
    expect(parsed.spec.sl).toEqual({ kind: "PRICE", value: 99 });
    expect(parsed.spec.tp).toEqual({ kind: "PRICE", value: 102 });
    const out = runLabBacktest({ ...spec, sl: parsed.spec.sl!, tp: parsed.spec.tp! }, [bar(0), bar(1), bar(2, 100.1, 99.5), bar(3, 103, 99.9, 102)]);
    expect(out.trades[0]).toMatchObject({ slPrice: 99, tpPrice: 102, exitReason: "TP" });
  });
  it("does not parse the numeric prefix of an unsupported Pine expression", () => {
    const out = parsePineSource('if close > open\nstrategy.exit("X", stop=99+offset, limit=102)');
    expect(out.spec.sl?.kind).not.toBe("PRICE");
    expect(out.notes.some(s => s.includes("SL tidak dikenali"))).toBe(true);
  });
});
