// Unit test Position Overlay (Part C). npx vitest run src/exec/positionOverlay.test.ts
import { describe, it, expect } from "vitest";
import { toPositionOverlay, computeTrailPrice } from "./positionOverlay.js";
import { withSwingRr23Attrs } from "../strategies/swing/researchExitPolicy.js";

const base = {
  id: 42, symbol: "BTCUSDT", mode: "SWING", side: "LONG", entryPrice: 100,
  qty: 0.5, originalQty: 1.0, slPrice: 90, tp1Price: 115, tp2Price: 130,
  tp1FilledAt: null as Date | null, tp1FillPrice: null as number | null,
  beMoved: false, trailActive: false, trailPeak: null as number | null,
};

describe("toPositionOverlay", () => {
  it("RR23: 50/50, TP2/final 3R, no TPMAX runner", () => {
    const o = toPositionOverlay({ ...base, source: "PAPER_AI", entryAttrs: withSwingRr23Attrs() });
    expect(o.tp1Qty).toBe(0.5);
    expect(o.tp2Qty).toBe(0.5);
    expect(o.tpMaxQty).toBe(0);
    expect(o.tp2Price).toBe(130);
    expect(o.tpMaxPrice).toBe(130);
    expect(o.ladderNote).toContain("RR23");
  });
  it("legacy split ladder 40/30/30 dari originalQty", () => {
    const o = toPositionOverlay(base);
    expect(o.tp1Qty).toBe(0.4);
    expect(o.tp2Qty).toBe(0.3);
    expect(o.tpMaxQty).toBeCloseTo(0.3);
    expect(o.originalQty).toBe(1.0);
  });
  it("originalQty kosong → fallback qty", () => {
    const o = toPositionOverlay({ ...base, originalQty: null, qty: 0.8 });
    expect(o.tp1Qty).toBeCloseTo(0.32);
  });
  it("BEP hanya tampil bila beMoved (stop adjustment terkonfirmasi)", () => {
    expect(toPositionOverlay(base).bepConfirmed).toBe(false);
    expect(toPositionOverlay(base).bepPrice).toBeNull();
    const moved = toPositionOverlay({ ...base, beMoved: true });
    expect(moved.bepConfirmed).toBe(true);
    expect(moved.bepPrice).toBe(100);
  });
  it("trailing hanya bila trailActive; level = peak ∓ 1R", () => {
    expect(toPositionOverlay(base).trailPrice).toBeNull();
    const t = toPositionOverlay({ ...base, trailActive: true, trailPeak: 110 });
    expect(t.trailPrice).toBeCloseTo(100); // LONG: 110 - 1R(10)
    const s = toPositionOverlay({ ...base, side: "SHORT", trailActive: true, trailPeak: 95 });
    expect(s.trailPrice).toBeCloseTo(105); // SHORT: 95 + 1R(10)
  });
  it("protectionConfirmed butuh SL & TP valid", () => {
    expect(toPositionOverlay(base).protectionConfirmed).toBe(true);
    expect(toPositionOverlay({ ...base, slPrice: 0 }).protectionConfirmed).toBe(false);
  });
});

describe("ladder TP multi-target & sumber posisi (14 Okt)", () => {
  it("tp2Price DB kosong → TP2 diproyeksikan dari R; TPMax = entry ± 3×offset TP1 (fix 15 Okt)", () => {
    // base: entry 100, sl 90 → R=10, LONG, tp1 115 → offset 15
    const o = toPositionOverlay({ ...base, tp2Price: null as unknown as number });
    const R = Math.abs(base.entryPrice - base.slPrice);
    expect(o.tp2Price).toBeCloseTo(base.tp1Price + 0.5 * R, 6);
    const offset = Math.abs(base.tp1Price - base.entryPrice);
    expect(o.tpMaxPrice).toBeCloseTo(base.entryPrice + 3 * offset, 6);
    // 3 target tidak collapse ke satu harga
    expect(new Set([o.tp1Price, o.tp2Price, o.tpMaxPrice]).size).toBe(3);
  });
  it("arah SHORT: proyeksi ke bawah (target makin jauh dari entry)", () => {
    const o = toPositionOverlay({ ...base, side: "SHORT", slPrice: 110, tp1Price: 95, tp2Price: null as unknown as number });
    const R = 10;
    expect(o.tp2Price).toBeCloseTo(95 - 0.5 * R, 6);
    // TPMax = entry - 3×offset(5) = 85
    expect(o.tpMaxPrice).toBeCloseTo(100 - 3 * 5, 6);
  });
  it("tp2Price DB terisi → dipakai apa adanya; TPMax tetap turunan 3×offset (fix 15 Okt)", () => {
    const o = toPositionOverlay({ ...base, tp2Price: 123.45 });
    expect(o.tp2Price).toBe(123.45);
    const offset = Math.abs(base.tp1Price - base.entryPrice);
    expect(o.tpMaxPrice).toBeCloseTo(base.entryPrice + 3 * offset, 6);
  });
  it("source MANUAL dilabeli apa adanya; ladderNote menjelaskan TP tunggal", () => {
    const o = toPositionOverlay({ ...base, source: "MANUAL", tp2Price: null as unknown as number });
    expect(o.source).toBe("MANUAL");
    expect(o.ladderNote).toContain("legacy");
    const o2 = toPositionOverlay({ ...base, source: "ENGINE", tp2Price: 123.45 });
    expect(o2.ladderNote).toContain("state engine");
  });
});

describe("computeTrailPrice", () => {
  it("arah LONG di bawah peak, SHORT di atas peak", () => {
    expect(computeTrailPrice("LONG", 120, 100, 90)).toBe(110);
    expect(computeTrailPrice("SHORT", 80, 100, 110)).toBe(90);
  });
});
