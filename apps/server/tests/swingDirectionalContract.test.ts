// Contract-level direction checks for the three active SWING subjects. This is
// not a trade simulation; it prevents a later adapter change from silently
// making Draco LONG-capable or relabeling RSW-01/02 as SHORT-only.
//
// 21 Okt 2026 (Phase 2 plan audit): S-05 (Polaris) dipindahkan ke arsip, jadi
// kontrak aktif sekarang 3 subjek. Polaris tetap punya identitas yang bisa
// dicari untuk label trade historis.
import { describe, expect, it } from "vitest";
import { SWING_EVAL_STRATEGIES, SWING_EVAL_IDS, ARCHIVED_SWING_STRATEGIES, swingEvalIdentity } from "../src/learning/swingEvalRegistry.js";

describe("three active SWING direction contract", () => {
  it("keeps the exact three IDs and names without an Arta prefix", () => {
    expect(SWING_EVAL_IDS).toEqual(["RSW-01", "RSW-02", "RSW-03"]);
    expect(SWING_EVAL_STRATEGIES.map((s) => [s.strategyId, s.displayName])).toEqual([
      ["RSW-01", "Orion"], ["RSW-02", "Vega"], ["RSW-03", "Draco"],
    ]);
    expect(SWING_EVAL_STRATEGIES.every((s) => !s.displayName.startsWith("Arta"))).toBe(true);
  });

  it("allows both directions only where the frozen evaluator supports them", () => {
    const byId = Object.fromEntries(SWING_EVAL_STRATEGIES.map((s) => [s.strategyId, s]));
    expect(byId["RSW-01"]!.supportedDirections).toBe("BOTH");
    expect(byId["RSW-02"]!.supportedDirections).toBe("BOTH");
    expect(byId["RSW-03"]!.supportedDirections).toBe("SHORT_ONLY");
    expect(byId["RSW-03"]!.longComponent).toBeNull();
  });

  it("keeps the archived identities out of the active cohort", () => {
    expect(SWING_EVAL_STRATEGIES.some((s) => s.strategyId === "S-03")).toBe(false);
    expect(SWING_EVAL_STRATEGIES.some((s) => s.strategyId === "S-05")).toBe(false);
  });

  it("keeps Polaris resolvable for historical trade labels", () => {
    // S-05 tidak lagi bisa di-evaluate, tapi display name-nya tetap harus bisa
    // dicari supaya breakdown trade lama tidak berubah jadi kode mentah.
    expect(swingEvalIdentity("S-05")?.displayName).toBe("Polaris");
    expect(ARCHIVED_SWING_STRATEGIES.find((s) => s.strategyId === "S-05")?.researchOnly).toBe(true);
  });
});
