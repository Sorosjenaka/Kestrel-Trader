// apps/server/src/api/routes/positionsLifecycle.test.ts — 26 Okt 2026 (TAHAP 2/8)
// Regresi derivePositionLifecycle: target TP1 mengikuti policy tersimpan
// (RR23 50% / legacy 40% / SCALP single-target 100%), BUKAN hardcode 50%.
import { describe, expect, it } from "vitest";
import { derivePositionLifecycle } from "./positions.js";

const RR23_ATTRS = JSON.stringify({ swingExitPolicy: "SWING_50_2R_BE_50_3R_V1" });

describe("derivePositionLifecycle", () => {
  it("SCALP single-target: tp1TargetQty = 100% qty awal", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 10, originalQty: 10, mode: "SCALP",
      source: "PAPER_AI", entryAttrs: null, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(10);
    expect(p.lifecycle).toBe("OPEN");
  });

  it("SWING RR23: TP1 50% floor step; PARTIALLY_CLOSED setelah TP1", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 20.6, originalQty: 41.2,
      tp1FilledAt: new Date(), tp1FillPrice: 1.2,
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 0.1,
    });
    expect(p.lifecycle).toBe("PARTIALLY_CLOSED");
    expect(p.tp1TargetQty).toBeCloseTo(20.6, 9);
    expect(p.closedQty).toBeCloseTo(20.6, 9);
    expect(p.remainingQty).toBeCloseTo(20.6, 9);
  });

  it("SWING legacy tanpa marker RR23: TP1 40% floor step", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 100, originalQty: 100,
      mode: "SWING", source: "PAPER_AI", entryAttrs: null, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(40);
  });

  it("SWING RR23 dengan source non-PAPER/LIVE tidak dianggap RR23 (identitas historis)", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 100, originalQty: 100,
      mode: "SWING", source: "MANUAL", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(40);
  });

  it("fase TP1 < 1 step -> degradasi single-target", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 1, originalQty: 1,
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(1);
  });

  it("CLOSED tetap CLOSED walau tp1FilledAt terisi", () => {
    const p = derivePositionLifecycle({
      status: "CLOSED", qty: 0, originalQty: 10, tp1FilledAt: new Date(),
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(p.lifecycle).toBe("CLOSED");
    expect(p.closedQty).toBe(10);
    expect(p.remainingQty).toBe(0);
  });
});