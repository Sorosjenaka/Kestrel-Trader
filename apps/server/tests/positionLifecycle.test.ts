// 25 Okt 2026 — regression test lifecycle parent position (perintah operator TP1):
// TP1 terisi + sisa OPEN -> PARTIALLY_CLOSED; final -> status CLOSED apa adanya;
// partial TIDAK boleh dihitung trade baru. Field turunan display saja.
//
// 26 Okt 2026 (TAHAP 2): tp1TargetQty TIDAK lagi hardcode 50% — mengikuti
// policy tersimpan (entryAttrs.swingExitPolicy) + mode + quantityStep:
// SWING RR23 = 50% floor step; SWING legacy = 40% floor step; SCALP
// single-target = 100%. Fixture lama tanpa mode = posisi legacy tanpa policy
// ladder yang diketahui -> single-target (tidak mengarang fraksi ladder).
import { describe, expect, it } from "vitest";
import { derivePositionLifecycle } from "../src/api/routes/positions.js";

const RR23_ATTRS = JSON.stringify({ swingExitPolicy: "SWING_50_2R_BE_50_3R_V1" });

describe("derivePositionLifecycle", () => {
  it("TP1 terisi (50%) + sisa OPEN -> PARTIALLY_CLOSED dengan metrik partial", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 179, originalQty: 358,
      tp1FilledAt: new Date("2026-10-25T10:00:00Z"), tp1FillPrice: 0.0752,
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(p.lifecycle).toBe("PARTIALLY_CLOSED");
    expect(p.closedQty).toBe(179);
    expect(p.remainingQty).toBe(179);
    expect(p.tp1TargetQty).toBe(179); // RR23: 50% initialQty floor step
    expect(p.status).toBe("OPEN"); // status DB tidak diubah
  });

  it("qty tersisa < originalQty tanpa tp1FilledAt tetap PARTIALLY_CLOSED (partial fill nyata)", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 100, originalQty: 150, tp1FilledAt: null,
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(p.lifecycle).toBe("PARTIALLY_CLOSED");
    expect(p.closedQty).toBe(50);
    expect(p.remainingQty).toBe(100);
    expect(p.tp1TargetQty).toBe(75);
  });

  it("OPEN penuh tanpa partial -> tetap OPEN", () => {
    const p = derivePositionLifecycle({ status: "OPEN", qty: 10, originalQty: 10, tp1FilledAt: null });
    expect(p.lifecycle).toBe("OPEN");
    expect(p.closedQty).toBe(0);
    expect(p.remainingQty).toBe(10);
  });

  it("CLOSED (final TP2/SL) -> lifecycle = status DB, bukan PARTIALLY_CLOSED", () => {
    const p = derivePositionLifecycle({
      status: "CLOSED", qty: 0, originalQty: 53.2,
      tp1FilledAt: new Date("2026-10-24T00:00:00Z"),
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 0.1,
    });
    expect(p.lifecycle).toBe("CLOSED");
    expect(p.closedQty).toBe(53.2);
    expect(p.remainingQty).toBe(0);
    expect(p.tp1TargetQty).toBeCloseTo(26.6, 9);
  });

  it("legacy tanpa originalQty -> tidak mengarang metrik", () => {
    const p = derivePositionLifecycle({ status: "OPEN", qty: 5, originalQty: null, tp1FilledAt: null });
    expect(p.lifecycle).toBe("OPEN");
    expect(p.closedQty).toBeNull();
    expect(p.remainingQty).toBeNull();
    expect(p.tp1TargetQty).toBeNull();
  });

  it("SCALP single-target: tp1TargetQty = 100% (bukan dipaksa 50%)", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 100, originalQty: 100, tp1FilledAt: null,
      mode: "SCALP", source: "PAPER_AI", entryAttrs: null, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(100);
  });

  it("SWING legacy tanpa marker RR23: tp1TargetQty = 40% floor step", () => {
    const p = derivePositionLifecycle({
      status: "OPEN", qty: 100, originalQty: 100, tp1FilledAt: null,
      mode: "SWING", source: "PAPER_AI", entryAttrs: null, quantityStep: 1,
    });
    expect(p.tp1TargetQty).toBe(40);
  });

  it("posisi tanpa mode/policy (legacy DB) -> single-target, tidak mengarang fraksi ladder", () => {
    const p = derivePositionLifecycle({ status: "OPEN", qty: 100, originalQty: 150, tp1FilledAt: null });
    expect(p.lifecycle).toBe("PARTIALLY_CLOSED");
    expect(p.tp1TargetQty).toBe(150);
  });
});