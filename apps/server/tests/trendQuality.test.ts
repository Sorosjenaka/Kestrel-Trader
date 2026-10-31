// tests/trendQuality.test.ts — Big Brain Tahap B2 (14 Okt 2026)
import { describe, it, expect } from "vitest";
import {
  calculateEfficiencyRatio,
  TrendQualityClassifier,
  ER_ENTER_TRENDING,
  ER_EXIT_TRENDING,
} from "../src/engines/trendQuality.js";
import { Bar } from "../src/universe/eligibility.js";

function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ openTime: i * 300_000, open: c, high: c, low: c, close: c, volume: 1 }));
}

describe("calculateEfficiencyRatio", () => {
  it("tren lurus sempurna -> ER = 1", () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 + i);
    expect(calculateEfficiencyRatio(bars(closes))).toBe(1);
  });

  it("zigzag bolak-balik (sideways murni) -> ER ~ 0", () => {
    const closes: number[] = [];
    for (let i = 0; i < 32; i++) closes.push(i % 2 === 0 ? 100 : 101);
    const er = calculateEfficiencyRatio(bars(closes))!;
    expect(er).toBeLessThan(0.1);
  });

  it("tren riil dgn pullback -> ER di antara 0 dan 1", () => {
    // naik 1 tiap bar tapi tiap 5 bar turun 3 (pullback) -> ER moderat
    let c = 100;
    const closes: number[] = [];
    for (let i = 0; i < 31; i++) {
      c += i % 5 === 4 ? -3 : 2;
      closes.push(c);
    }
    const er = calculateEfficiencyRatio(bars(closes))!;
    expect(er).toBeGreaterThan(0.1);
    expect(er).toBeLessThan(1);
  });

  it("bar tidak cukup -> null; harga beku -> null", () => {
    expect(calculateEfficiencyRatio(bars([1, 2, 3]))).toBeNull();
    expect(calculateEfficiencyRatio(bars(Array(31).fill(100)))).toBeNull();
  });

  it("ambang default sesuai plan B2 (belum gate, nunggu validasi)", () => {
    expect(ER_ENTER_TRENDING).toBe(0.35);
    expect(ER_EXIT_TRENDING).toBe(0.25);
  });
});

describe("TrendQualityClassifier (hysteresis)", () => {
  it("naik ke TRENDING hanya di ER >= enterAt", () => {
    const cls = new TrendQualityClassifier();
    // sideways murni
    const zz: number[] = [];
    for (let i = 0; i < 40; i++) zz.push(i % 2 === 0 ? 100 : 101);
    expect(cls.update(bars(zz)).quality).toBe("SIDEWAYS");
    // tren lurus 31 bar
    const tr = Array.from({ length: 31 }, (_, i) => 200 + i);
    expect(cls.update(bars(tr)).quality).toBe("TRENDING");
  });

  it("anti-flicker: tren tetap TRENDING saat ER turun sedikit di bawah enterAt", () => {
    const cls = new TrendQualityClassifier();
    cls.seed("TRENDING");
    // Konstruksi eksak: 6 langkah +1, 12 langkah +0.5, 12 langkah -0.5
    // -> net = 6, path = 18 -> ER = 0.3333 (di antara exit 0.25 & enter 0.35)
    const closes2: number[] = [0];
    for (let i = 0; i < 30; i++) {
      if (i < 6) closes2.push(closes2[i]! + 1);
      else if (i < 18) closes2.push(closes2[i]! + 0.5);
      else closes2.push(closes2[i]! - 0.5);
    }
    const snap = cls.update(bars(closes2));
    expect(snap.er!).toBeGreaterThan(ER_EXIT_TRENDING);
    expect(snap.er!).toBeLessThan(ER_ENTER_TRENDING);
    expect(snap.quality).toBe("TRENDING"); // hysteresis: tidak flip ke SIDEWAYS
  });

  it("keluar TRENDING hanya saat ER < exitAt", () => {
    const cls = new TrendQualityClassifier();
    cls.seed("TRENDING");
    const zz: number[] = [];
    for (let i = 0; i < 40; i++) zz.push(i % 2 === 0 ? 100 : 101);
    expect(cls.update(bars(zz)).quality).toBe("SIDEWAYS");
  });

  it("bar tidak cukup -> UNAVAILABLE tanpa mengubah state", () => {
    const cls = new TrendQualityClassifier();
    cls.seed("TRENDING");
    const snap = cls.update(bars([1, 2, 3]));
    expect(snap.quality).toBe("UNAVAILABLE");
    expect(cls.current()).toBe("TRENDING");
  });
});
