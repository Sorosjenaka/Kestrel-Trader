import { describe, expect, it } from "vitest";
import { atr, ema, normalizeKlines, rsi, rvol, sma, takerSellBase, volumeSma, type Candle } from "./chartMath.js";

const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
  time: i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + (i % 3), volume: 10 + i,
  quoteVolume: 0, takerBuyBase: 0, takerBuyQuote: 0,
}));

describe("chart math", () => {
  it("normalizes Binance kline arrays and rejects duplicate/out-of-order rows", () => {
    const raw = [
      [1700000000000, "100", "102", "99", "101", "12", 0, "1200", 4, "5", "500", "0"],
      [1700000000000, "100", "102", "99", "101", "12", 0, "1200", 4, "5", "500", "0"],
      [1700003600000, "101", "103", "100", "102", "14", 0, "1400", 5, "6", "600", "0"],
    ];
    const out = normalizeKlines(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ time: 1700000000, open: 100, high: 102, low: 99, close: 101, volume: 12, quoteVolume: 1200 });
  });

  it("computes SMA with a documented warm-up", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(volumeSma(candles, 3)[2]).toBeCloseTo((10 + 11 + 12) / 3);
  });

  it("computes RVOL from the previous 20 bars", () => {
    const values = Array.from({ length: 21 }, (_, i) => i === 20 ? 30 : 10);
    const out = rvol(values, 20);
    expect(out[19]).toBeNull();
    expect(out[20]).toBeCloseTo(3);
  });

  it("computes EMA/Rsi/ATR deterministically", () => {
    const e = ema([1, 2, 3], 2);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeCloseTo(1.6666666667);
    expect(rsi([1, 2, 3, 4, 5], 2).at(-1)).toBe(100);
    expect(rsi([1, 1, 1, 1], 2).at(-1)).toBe(50);
    expect(atr(candles, 3).at(-1)).toBeGreaterThan(0);
  });

  it("derives taker sell from the same executed-base volume without double counting", () => {
    const c = { ...candles[0]!, volume: 100, takerBuyBase: 37 };
    expect(takerSellBase(c)).toBe(63);
    expect(takerSellBase({ ...c, takerBuyBase: 100 })).toBe(0);
  });
});
