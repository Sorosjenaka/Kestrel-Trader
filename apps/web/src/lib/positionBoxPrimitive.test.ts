// @vitest-environment node
// apps/web/src/lib/positionBoxPrimitive.test.ts
// Kontrak spec bagian I:
// - autoscaleInfo() SELALU null (level masuk skala via autoscaleInfoProvider).
// - setPosition(null) -> paneViews() kosong (box dilepas bersih).
import { describe, expect, it } from "vitest";
import {
  buildEdgePills,
  buildLevelPills,
  buildUPnLText,
  findEntryBarTime,
  fmtR,
  fmtSignedPct,
  PositionBoxPrimitive,
  resolvePillYs,
} from "./positionBoxPrimitive.js";

const pos = {
  positionId: 3239,
  side: "SHORT" as const,
  entryPrice: 2.9336,
  slPrice: 3.0882,
  tp1Price: 2.6244,
  tp2Price: 2.4698,
  qty: 445,
  entryTimeSec: 1793213100,
};

describe("PositionBoxPrimitive kontrak", () => {
  it("autoscaleInfo() === null (tidak menyumbang ke skala)", () => {
    const box = new PositionBoxPrimitive();
    expect(box.autoscaleInfo(0 as never, 100 as never)).toBeNull();
    box.setPosition(pos);
    expect(box.autoscaleInfo(0 as never, 100 as never)).toBeNull();
  });

  it("setPosition(null) -> paneViews kosong", () => {
    const box = new PositionBoxPrimitive();
    box.setPosition(pos);
    expect(box.paneViews().length).toBeGreaterThan(0); // ada box
    box.setPosition(null);
    expect(box.paneViews()).toEqual([]);
    box.setPosition([pos]);
    expect(box.paneViews().length).toBe(2); // layer zona + label
    box.setPosition([]);
    expect(box.paneViews()).toEqual([]);
  });
});

describe("label pill (teks dikunci kontrak spec)", () => {
  it("SL/ENTRY/TP1/TP2 sesuai format: 'SL 3.0882 · -1R · +5.27%' dst", () => {
    const pills = buildLevelPills(pos);
    const byKind = Object.fromEntries(pills.map((p) => [p.kind, p.text]));
    expect(byKind.sl).toBe("SL 3.0882 · -1R · +5.27%");
    expect(byKind.entry).toBe("SHORT · ENTRY 2.9336 · 445");
    expect(byKind.tp1).toBe("TP1 2.6244 · 2R · -10.54%");
    expect(byKind.tp2).toBe("TP2 2.4698 · 3R · -15.81%");
  });

  it("pill uPnL live: 'uPnL -0.25R · -1.29% · $-9.48'", () => {
    // SHORT entry 2.9336, qty 445, harga 2.9715 -> rugi
    const text = buildUPnLText(pos, 2.9715);
    expect(text).toBe("uPnL -0.25R · -1.29% · $-16.87");
  });

  it("format: fmtR bulat/pecahan dan persen bertanda", () => {
    expect(fmtR(2)).toBe("2R");
    expect(fmtR(-1)).toBe("-1R");
    expect(fmtR(-0.245)).toBe("-0.25R");
    expect(fmtSignedPct(5.26997)).toBe("+5.27%");
    expect(fmtSignedPct(-10.5399)).toBe("-10.54%");
  });

  it("anti-tumpuk pill: jarak min 20px", () => {
    const out = resolvePillYs([10, 15, 100], 20);
    expect(out[1]! - out[0]!).toBeGreaterThanOrEqual(20);
    expect(out[2]).toBe(100);
  });

  it("findEntryBarTime: binary search bar entry", () => {
    const bars = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];
    expect(findEntryBarTime(bars, 250)).toBe(200);
    expect(findEntryBarTime(bars, 400)).toBe(400);
    expect(findEntryBarTime(bars, 50)).toBeNull();
    expect(findEntryBarTime([], 50)).toBeNull();
  });
});

describe("pill tepi ▲/▼ — HANYA saat FIT LEVELS OFF", () => {
  // priceToY: SL di luar atas (y<0), TP1 di dalam layar, TP2 di luar bawah.
  const yOf = (price: number): number | null =>
    price === pos.slPrice ? -30 : price === pos.tp1Price ? 100 : price === pos.tp2Price ? 300 : null;
  const level = { slPrice: pos.slPrice, tp1Price: pos.tp1Price, tp2Price: pos.tp2Price };

  it("FIT LEVELS ON → tidak ada pill tepi", () => {
    expect(buildEdgePills(level, true, yOf, 200)).toEqual([]);
  });

  it("FIT LEVELS OFF → pill ▲ untuk level di atas, ▼ untuk level di bawah; level di dalam layar tidak di-pill", () => {
    const out = buildEdgePills(level, false, yOf, 200);
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toMatch(/^▲ SL 3\.0882/);
    expect(out[0]!.y).toBe(12);
    expect(out[1]!.text).toMatch(/^▼ TP2 2\.4698/);
    expect(out[1]!.y).toBe(200 - 12);
    // TP1 (y=100, di dalam layar 200) tidak memunculkan pill.
    expect(out.some((p) => p.text.includes("TP1"))).toBe(false);
  });

  it("level null tidak di-pill, dan tanpa level keluar layar → kosong", () => {
    const inside = (price: number): number | null => (price ? 50 : null);
    expect(buildEdgePills(level, false, inside, 200)).toEqual([]);
    expect(buildEdgePills({ slPrice: null, tp1Price: null, tp2Price: null }, false, yOf, 200)).toEqual([]);
  });

  it("setFitLevels mengendalikan output lewat primitive (kontrak)", () => {
    const box = new PositionBoxPrimitive();
    expect(box.isFitLevels()).toBe(true);
    box.setFitLevels(false);
    expect(box.isFitLevels()).toBe(false);
    box.setFitLevels(true);
    expect(box.isFitLevels()).toBe(true);
  });
});
