// @vitest-environment node
// apps/web/src/lib/realtimePnl.test.ts
//
// Kontrak rumus realtime PnL (LONG & SHORT). Angka di sini dikunci supaya
// perubahan formula tidak diam-diam membalik tanda PnL sebuah posisi.
import { describe, expect, it } from "vitest";
import {
  aggregatePnl,
  computeRealtimePnl,
  decimalsForTick,
  fmtPctSigned,
  fmtPriceTick,
  fmtUsdSigned,
  priceFromEntryPct,
  roiPct,
  unrealizedUsd,
} from "./realtimePnl.js";

describe("unrealizedUsd — LONG", () => {
  it("LONG untung saat mark > entry: (mark-entry)*qty", () => {
    expect(unrealizedUsd({ side: "LONG", entryPrice: 100, qty: 2 }, 110)).toBeCloseTo(20, 6);
  });

  it("LONG rugi saat mark < entry", () => {
    expect(unrealizedUsd({ side: "LONG", entryPrice: 100, qty: 2 }, 90)).toBeCloseTo(-20, 6);
  });

  it("LONG mark == entry -> 0 (bukan null)", () => {
    expect(unrealizedUsd({ side: "LONG", entryPrice: 100, qty: 2 }, 100)).toBe(0);
  });
});

describe("unrealizedUsd — SHORT", () => {
  it("SHORT untung saat mark < entry: (entry-mark)*qty", () => {
    expect(unrealizedUsd({ side: "SHORT", entryPrice: 100, qty: 2 }, 90)).toBeCloseTo(20, 6);
  });

  it("SHORT rugi saat mark > entry", () => {
    expect(unrealizedUsd({ side: "SHORT", entryPrice: 100, qty: 2 }, 110)).toBeCloseTo(-20, 6);
  });

  it("kontrak pos box: SHORT entry 2.9336 qty 445 mark 2.9715 -> uPnL -16.8655", () => {
    const u = unrealizedUsd({ side: "SHORT", entryPrice: 2.9336, qty: 445 }, 2.9715);
    expect(u).toBeCloseTo(-16.8655, 4);
    expect(fmtUsdSigned(u)).toBe("-$16.87");
  });
});

describe("unrealizedUsd — mark tidak valid selalu null", () => {
  it.each([null, undefined, Number.NaN, 0, -5])("mark=%p -> null", (mark) => {
    expect(unrealizedUsd({ side: "LONG", entryPrice: 100, qty: 2 }, mark as number | null)).toBeNull();
    expect(unrealizedUsd({ side: "SHORT", entryPrice: 100, qty: 2 }, mark as number | null)).toBeNull();
  });
});

describe("roiPct — ROI terhadap margin (entry*qty/leverage)", () => {
  it("LONG: uPnL 20, notional 200, lev 5 -> margin 40 -> ROI +50%", () => {
    // entry 100 * qty 2 = 200 notional; /5 = 40 margin; 20/40 = 50%
    expect(roiPct(20, 100, 2, 5)).toBeCloseTo(50, 6);
  });

  it("SHORT: uPnL 20, margin 40 -> ROI +50% (arah tidak mengubah ROI)", () => {
    expect(roiPct(20, 100, 2, 5)).toBeCloseTo(50, 6);
  });

  it("rugi -> ROI negatif", () => {
    expect(roiPct(-20, 100, 2, 5)).toBeCloseTo(-50, 6);
  });

  it("leverage 1x -> ROI = uPnL/notional", () => {
    expect(roiPct(20, 100, 2, 1)).toBeCloseTo(10, 6); // 20/200
  });

  it("leverage null/0 -> null (margin tak diketahui)", () => {
    expect(roiPct(20, 100, 2, null)).toBeNull();
    expect(roiPct(20, 100, 2, 0)).toBeNull();
  });

  it("uPnL null atau notional 0 -> null", () => {
    expect(roiPct(null, 100, 2, 5)).toBeNull();
    expect(roiPct(20, 0, 2, 5)).toBeNull();
    expect(roiPct(20, 100, 0, 5)).toBeNull();
  });
});

describe("priceFromEntryPct — gerak harga polos dari entry", () => {
  it("mark naik 10% -> +10% (berlaku sama utk LONG & SHORT)", () => {
    expect(priceFromEntryPct(100, 110)).toBeCloseTo(10, 6);
  });

  it("mark turun 10% -> -10%", () => {
    expect(priceFromEntryPct(100, 90)).toBeCloseTo(-10, 6);
  });

  it("mark null / entry 0 -> null", () => {
    expect(priceFromEntryPct(100, null)).toBeNull();
    expect(priceFromEntryPct(0, 110)).toBeNull();
  });
});

describe("computeRealtimePnl — gabungan untuk satu posisi", () => {
  it("LONG profit konsisten: uPnL +20, ROI +50%, harga +10%", () => {
    const r = computeRealtimePnl({ side: "LONG", entryPrice: 100, qty: 2, leverage: 5 }, 110);
    expect(r.uPnL).toBeCloseTo(20, 6);
    expect(r.roiPct).toBeCloseTo(50, 6);
    expect(r.pricePct).toBeCloseTo(10, 6);
    expect(r.mark).toBe(110);
  });

  it("SHORT profit konsisten: uPnL +20, ROI +50%, harga -10%", () => {
    const r = computeRealtimePnl({ side: "SHORT", entryPrice: 100, qty: 2, leverage: 5 }, 90);
    expect(r.uPnL).toBeCloseTo(20, 6);
    expect(r.roiPct).toBeCloseTo(50, 6);
    expect(r.pricePct).toBeCloseTo(-10, 6);
  });

  it("mark tidak valid -> semua null, mark null", () => {
    const r = computeRealtimePnl({ side: "LONG", entryPrice: 100, qty: 2, leverage: 5 }, null);
    expect(r.uPnL).toBeNull();
    expect(r.roiPct).toBeNull();
    expect(r.pricePct).toBeNull();
    expect(r.mark).toBeNull();
  });

  it("leverage null -> uPnL tetap, ROI null", () => {
    const r = computeRealtimePnl({ side: "SHORT", entryPrice: 100, qty: 2, leverage: null }, 90);
    expect(r.uPnL).toBeCloseTo(20, 6);
    expect(r.roiPct).toBeNull();
  });
});

describe("aggregatePnl — total untuk StatCard", () => {
  it("menjumlah uPnL & ROI margin terbobot beberapa posisi", () => {
    const rows = [
      { pos: { side: "LONG", entryPrice: 100, qty: 2, leverage: 5 }, mark: 110 }, // u +20, margin 40
      { pos: { side: "SHORT", entryPrice: 100, qty: 2, leverage: 5 }, mark: 90 }, // u +20, margin 40
    ];
    const a = aggregatePnl(rows);
    expect(a.uPnL).toBeCloseTo(40, 4);
    expect(a.roiPct).toBeCloseTo(50, 2); // 40 / 80 margin
  });

  it("tanpa posisi valid -> null (bukan 0)", () => {
    expect(aggregatePnl([])).toEqual({ uPnL: null, roiPct: null });
    expect(aggregatePnl([{ pos: { side: "LONG", entryPrice: 100, qty: 2, leverage: 5 }, mark: null }]))
      .toEqual({ uPnL: null, roiPct: null });
  });
});

describe("format presisi", () => {
  it("decimalsForTick sesuai tickSize", () => {
    expect(decimalsForTick(0.1)).toBe(1);
    expect(decimalsForTick(0.01)).toBe(2);
    expect(decimalsForTick(0.00001)).toBe(5);
    expect(decimalsForTick(null)).toBe(2);
    expect(decimalsForTick(0)).toBe(2);
  });

  it("fmtPriceTick memakai presisi tickSize", () => {
    expect(fmtPriceTick(0.0187, 0.0001)).toBe("0.0187");
    expect(fmtPriceTick(2.9336, 0.0001)).toBe("2.9336");
    expect(fmtPriceTick(62000.5, 0.1)).toBe("62000.5");
    expect(fmtPriceTick(null, 0.1)).toBe("·");
  });

  it("fmtUsdSigned & fmtPctSigned bertanda, null -> '·'", () => {
    expect(fmtUsdSigned(20)).toBe("+$20.00");
    expect(fmtUsdSigned(-16.8655)).toBe("-$16.87");
    expect(fmtUsdSigned(0)).toBe("+$0.00");
    expect(fmtUsdSigned(null)).toBe("·");
    expect(fmtPctSigned(5.26997)).toBe("+5.27%");
    expect(fmtPctSigned(-10.5399)).toBe("-10.54%");
    expect(fmtPctSigned(null)).toBe("·");
  });
});
