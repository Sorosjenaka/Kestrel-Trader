import { describe, expect, it } from "vitest";
import { isAlgoFilled, planLiveLadder } from "../src/exec/liveLadder.js";

describe("planLiveLadder (port ladder paper -> LIVE)", () => {
  it("membagi 40/30/30 dan TPMAX = entry + 3×offset TP1 (LONG)", () => {
    const p = planLiveLadder({ qty: 100, stepSize: 0.001, entryPrice: 100, tp1Price: 101, side: "LONG" });
    expect(p).not.toBeNull();
    expect(p!.tp1Qty).toBeCloseTo(40, 9);
    expect(p!.tp2Qty).toBeCloseTo(30, 9);
    expect(p!.runnerQty).toBeCloseTo(30, 9);
    expect(p!.tpMaxPrice).toBeCloseTo(103, 9);
  });

  it("RR23: 50/50, no TPMAX runner, final TP2 = exec price", () => {
    const p = planLiveLadder({ qty: 101, stepSize: 1, entryPrice: 100, tp1Price: 102, side: "LONG", swingExitPolicy: "RR23" });
    expect(p!.tp1Qty).toBe(50);
    expect(p!.tp2Qty).toBe(51);
    expect(p!.runnerQty).toBe(0);
    expect(p!.tpMaxPrice).toBeNull();
  });

  it("SHORT: TPMAX di bawah entry", () => {
    const p = planLiveLadder({ qty: 100, stepSize: 0.01, entryPrice: 100, tp1Price: 99, side: "SHORT" });
    expect(p!.tpMaxPrice).toBeCloseTo(97, 9);
    expect(p!.runnerQty).toBeCloseTo(30, 9);
  });

  it("kuantisasi stepSize dihormati (floor)", () => {
    const p = planLiveLadder({ qty: 10, stepSize: 3, entryPrice: 100, tp1Price: 101, side: "LONG" });
    // 40% = 4 -> floor 3; 30% = 3; runner = 4
    expect(p!.tp1Qty).toBe(3);
    expect(p!.tp2Qty).toBe(3);
    expect(p!.runnerQty).toBe(4);
  });

  it("qty terlalu kecil / TP salah sisi => null (fallback single-target)", () => {
    expect(planLiveLadder({ qty: 1, stepSize: 1, entryPrice: 100, tp1Price: 101, side: "LONG" })).toBeNull();
    expect(planLiveLadder({ qty: 100, stepSize: 0.01, entryPrice: 100, tp1Price: 99, side: "LONG" })).toBeNull();
    expect(planLiveLadder({ qty: 100, stepSize: 0.01, entryPrice: 100, tp1Price: null, side: "LONG" })).toBeNull();
  });
});

describe("isAlgoFilled", () => {
  it("mengenali status eksekusi exchange", () => {
    for (const s of ["FILLED", "filled", "EXECUTED", "COMPLETED", "FINISHED"]) expect(isAlgoFilled(s)).toBe(true);
  });

  it("status resting/unknown bukan fill", () => {
    // 26 Okt 2026 (TAHAP 1A): TRIGGERED TIDAK lagi dihitung filled — trigger
    // hanya membuktikan harga menyentuh level dan child order dikirim ke book
    // (TAKE_PROFIT LIMIT bisa resting/partial setelah trigger). Bukti fill
    // sesungguhnya = actualPrice/actualQty via parseAlgoFillEvidence
    // (regresi: src/exec/liveLadder.test.ts).
    for (const s of ["NEW", "WORKING", "ACTIVE", "TRIGGERED", "", null, undefined, "CANCELED"]) expect(isAlgoFilled(s)).toBe(false);
  });
});
