import { describe, expect, it } from "vitest";
import {
  progressiveThresholdsFor,
  resolveAutoLevel,
  levelFromCount,
  levelFromQuality,
  reviewFloorFor,
  parseLevelOverride,
} from "../src/exec/progressivePolicy.js";

describe("Kebijakan eksplorasi progresif L0-L5", () => {
  it("ambang naik bertahap 45 -> 68, KNN 0 -> 55%", () => {
    expect([0, 1, 2, 3, 4, 5].map((l) => progressiveThresholdsFor(l as 0 | 1 | 2 | 3 | 4 | 5).minScore))
      .toEqual([45, 50, 55, 60, 64, 68]);
    expect(progressiveThresholdsFor(0).minKnn).toBe(0);
    expect(progressiveThresholdsFor(5).minKnn).toBe(0.55);
  });

  it("review floor L0 menilai semua (40), L5 selektif (55+)", () => {
    expect(reviewFloorFor(20, 0)).toBe(40);
    expect(reviewFloorFor(20, 5)).toBe(55);
    expect(reviewFloorFor(0, 5)).toBe(68);
  });

  it("L0-L2 boleh exploration GO + macro override + sideways review; L3+ tidak", () => {
    expect(progressiveThresholdsFor(0).allowExplorationGo).toBe(true);
    expect(progressiveThresholdsFor(2).allowExplorationGo).toBe(true);
    expect(progressiveThresholdsFor(3).allowExplorationGo).toBe(false);
    expect(progressiveThresholdsFor(0).allowMacroOverride).toBe(true);
    expect(progressiveThresholdsFor(2).allowMacroOverride).toBe(false);
    expect(progressiveThresholdsFor(0).allowSidewaysReview).toBe(true);
    expect(progressiveThresholdsFor(3).allowSidewaysReview).toBe(false);
    expect(progressiveThresholdsFor(0).requireStrictPlan).toBe(true);
    expect(progressiveThresholdsFor(3).requireStrictPlan).toBe(true);
  });

  it("tanpa bukti = L0 (eksplorasi); performa buruk menahan level rendah", () => {
    expect(resolveAutoLevel({ verifiedTrades: 0, winrate: null, expectancyUsd: null })).toBe(0);
    expect(resolveAutoLevel({ verifiedTrades: 1000, winrate: 0.3, expectancyUsd: -0.5 })).toBe(0);
    expect(levelFromCount(0)).toBe(0);
    expect(levelFromCount(30)).toBe(1);
    expect(levelFromCount(1000)).toBe(5);
  });

  it("performa bagus menaikkan level bertahap", () => {
    expect(levelFromQuality({ verifiedTrades: 600, winrate: 0.6, expectancyUsd: 0.2 })).toBe(5);
    expect(levelFromQuality({ verifiedTrades: 600, winrate: 0.56, expectancyUsd: 0.06 })).toBe(4);
    expect(resolveAutoLevel({ verifiedTrades: 600, winrate: 0.56, expectancyUsd: 0.06 })).toBe(4);
    // Banyak trade tapi kualitas pas-pasan -> tertahan (min dari count & quality).
    expect(resolveAutoLevel({ verifiedTrades: 1000, winrate: 0.5, expectancyUsd: 0.01 })).toBe(3);
  });

  it("parse override 0-5 / AUTO", () => {
    expect(parseLevelOverride("0")).toBe(0);
    expect(parseLevelOverride("5")).toBe(5);
    expect(parseLevelOverride("AUTO")).toBe("AUTO");
    expect(parseLevelOverride("ngaco")).toBe("AUTO");
  });
});
