import { describe, expect, it } from "vitest";
import { brierScore, expectedCalibrationError } from "../src/analytics/calibration";

describe("calibration", () => {
  it("brier score dihitung tangan", () => {
    expect(brierScore([{ p: 0.8, outcome: 1 }, { p: 0.2, outcome: 0 }])).toBeCloseTo(0.04, 6);
    expect(brierScore([{ p: 0.5, outcome: 1 }, { p: 0.5, outcome: 0 }])).toBeCloseTo(0.25, 6);
  });

  it("prediksi sempurna -> brier 0", () => {
    expect(brierScore([{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }])).toBe(0);
  });

  it("ECE dihitung tangan", () => {
    // bin 0.9: conf .9 acc 1.0 (2 sampel), bin 0.1: conf .1 acc 0.0 (1 sampel)
    // ECE = (2/3)(0.1) + (1/3)(0.1) = 0.1
    const ece = expectedCalibrationError([
      { p: 0.9, outcome: 1 }, { p: 0.9, outcome: 1 }, { p: 0.1, outcome: 0 },
    ]);
    expect(ece).toBeCloseTo(0.1, 6);
  });

  it("confidence = accuracy per bin -> ECE 0", () => {
    expect(expectedCalibrationError([{ p: 0.5, outcome: 1 }, { p: 0.5, outcome: 0 }])).toBe(0);
  });

  it("input kosong -> 0, bukan NaN", () => {
    expect(brierScore([])).toBe(0);
    expect(expectedCalibrationError([])).toBe(0);
  });
});
