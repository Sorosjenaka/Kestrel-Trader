// @vitest-environment node
// apps/web/src/lib/positionMath.test.ts
// Tes WAJIB spec fix/live-chart-binance-style (kontrak fungsi murni):
// mergeBars, tickFmt WIB, autoscale FIT LEVELS ON/OFF, pnlR SHORT, TP1 = 2R.
import { describe, expect, it } from "vitest";
import {
  computeAutoscaleRange,
  crosshairFmtWib,
  mergeBars,
  pnlR,
  positionFooterLabel,
  rMultiple,
  tickFmt,
  tickMarkFmtWib,
  unrealizedUsd,
} from "./positionMath.js";
import type { Candle } from "./chartMath.js";

const bar = (time: number, close = 100): Candle =>
  ({ time, open: close - 1, high: close + 1, low: close - 2, close, volume: 1, quoteVolume: 100, takerBuyBase: 0.5, takerBuyQuote: 50 });

describe("mergeBars (REST refresh = merge, bukan replace)", () => {
  it("dedup by time — snapshot lebih baru (b) menang — dan terurut menaik", () => {
    const a = [bar(300, 10), bar(100, 11), bar(200, 12)];
    const b = [bar(200, 99), bar(400, 13)];
    const merged = mergeBars(a, b);
    expect(merged.map((c) => c.time)).toEqual([100, 200, 300, 400]);
    expect(merged.find((c) => c.time === 200)!.close).toBe(99); // b menang
    expect(merged.find((c) => c.time === 100)!.close).toBe(11); // hanya di a
  });
});

describe("sumbu waktu WIB", () => {
  it("tickFmt 1793215800 -> \"02:30\" (Unix detik, offset +7)", () => {
    expect(tickFmt(1793215800)).toBe("02:30");
  });
  it("tickMarkFmtWib: intraday HH:MM, ganti hari \"29 Okt\"", () => {
    expect(tickMarkFmtWib(1793215800, "time")).toBe("02:30");
    expect(tickMarkFmtWib(1793215800, "day")).toBe("29 Okt");
    expect(tickMarkFmtWib(1793215800, "month")).toBe("29 Okt 2026");
  });
  it("crosshair \"29 Okt 02:30 WIB\"", () => {
    expect(crosshairFmtWib(1793215800)).toBe("29 Okt 02:30 WIB");
  });
});

describe("autoscale position box", () => {
  const candleMin = 2.93, candleMax = 2.99;
  const entry = 2.9336, sl = 3.0882, tp1 = 2.6244, tp2 = 2.4698;

  it("FIT LEVELS ON (default) mencakup SL & TP2 + padding 6%", () => {
    const r = computeAutoscaleRange(candleMin, candleMax, [entry, sl, tp1, tp2], true);
    expect(r.minValue).toBeLessThanOrEqual(tp2);
    expect(r.maxValue).toBeGreaterThanOrEqual(sl);
    const span = Math.max(candleMax, sl) - Math.min(candleMin, tp2);
    expect(Math.abs((r.maxValue - Math.max(candleMax, sl)) - span * 0.06)).toBeLessThan(1e-9);
    expect(Math.abs((Math.min(candleMin, tp2) - r.minValue) - span * 0.06)).toBeLessThan(1e-9);
  });

  it("FIT LEVELS OFF == range candle", () => {
    const r = computeAutoscaleRange(candleMin, candleMax, [entry, sl, tp1, tp2], false);
    expect(r).toEqual({ minValue: candleMin, maxValue: candleMax });
  });

  it("tanpa posisi == range candle", () => {
    const r = computeAutoscaleRange(candleMin, candleMax, [], true);
    expect(r).toEqual({ minValue: candleMin, maxValue: candleMax });
  });

  it("level null tidak ikut autoscale", () => {
    const r = computeAutoscaleRange(candleMin, candleMax, [null, undefined, entry], true);
    expect(r.maxValue).toBeGreaterThanOrEqual(candleMax);
    expect(r.minValue).toBeLessThanOrEqual(entry);
  });
});

describe("R-multiple posisi", () => {
  const pos = { side: "SHORT" as const, entryPrice: 2.9336, slPrice: 3.0882, tp1Price: 2.6244, tp2Price: 2.4698, qty: 445 };

  it("pnlR SHORT (entry 2.9336, SL 3.0882, last 2.9715) = -0.245R", () => {
    const r = pnlR(pos, 2.9715);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(-0.245, 3);
  });

  it("TP1 = 2R", () => {
    expect(rMultiple(pos, 2.6244)).toBeCloseTo(2, 9);
    expect(rMultiple(pos, 2.4698)).toBeCloseTo(3, 9); // TP2 = 3R
  });

  it("SL = -1R dan uPnL dolar SHORT: harga turun = untung", () => {
    expect(rMultiple(pos, 3.0882)).toBeCloseTo(-1, 9);
    expect(unrealizedUsd(pos, 2.9336 - 0.01546)).toBeCloseTo(0.01546 * 445, 6);
  });
});

describe("footer panel", () => {
  it("footer LIVE: posisi mode LIVE -> POSISI LIVE", () => {
    expect(positionFooterLabel("LIVE", true)).toBe("POSISI LIVE · LEVEL ENGINE");
    expect(positionFooterLabel("PAPER", true)).toBe("POSISI · LEVEL ENGINE");
    expect(positionFooterLabel("LIVE", false)).toBe("NO POSITION INSTRUMENT");
  });
});
