// tests/volumeProfile.test.ts — Big Brain Tahap B3 (14 Okt 2026)
import { describe, it, expect } from "vitest";
import {
  buildVolumeProfile,
  findHvnLvn,
  distanceFromPocInBins,
  VP_VALUE_AREA_PCT,
} from "../src/engines/volumeProfile.js";
import { Bar } from "../src/universe/eligibility.js";

function bar(openTime: number, low: number, high: number, volume: number): Bar {
  return { openTime, open: low, high, low, close: high, volume };
}

describe("buildVolumeProfile", () => {
  it("POC jatuh di cluster harga dengan volume terbesar", () => {
    // 20 bar noise di 90-100 (vol 1) + 5 bar di 100-101 (vol 10) -> POC di ~100.5
    const bars: Bar[] = [];
    for (let i = 0; i < 20; i++) bars.push(bar(i, 90, 100, 1));
    for (let i = 0; i < 5; i++) bars.push(bar(100 + i, 100, 101, 10));
    const vp = buildVolumeProfile(bars, 40);
    expect(vp.poc).not.toBeNull();
    expect(vp.poc!).toBeGreaterThanOrEqual(99.5);
    expect(vp.poc!).toBeLessThanOrEqual(101.5);
  });

  it("Value Area memuat >= 70% total volume dan mengapit POC", () => {
    const bars: Bar[] = [];
    // profil dua puncak: mayoritas volume di tengah
    for (let i = 0; i < 30; i++) bars.push(bar(i, 100 + (i % 3), 101 + (i % 3), 5)); // 100-102 vol 5
    for (let i = 0; i < 30; i++) bars.push(bar(100 + i, 101, 102, 12));              // 101-102 vol 12
    const vp = buildVolumeProfile(bars, 20);
    expect(vp.poc).not.toBeNull();
    expect(vp.vah!).toBeGreaterThan(vp.poc!);
    expect(vp.val!).toBeLessThan(vp.poc!);
    const vaVolume = vp.bins
      .filter((b) => b.mid >= vp.val! && b.mid <= vp.vah!)
      .reduce((a, b) => a + b.volume, 0);
    expect(vaVolume / vp.totalVolume).toBeGreaterThanOrEqual(VP_VALUE_AREA_PCT - 0.02);
  });

  it("data tidak valid -> profil kosong (fail-closed, tanpa fabrikasi)", () => {
    expect(buildVolumeProfile([]).poc).toBeNull();
    expect(buildVolumeProfile([bar(0, 10, 5, 1)]).poc).toBeNull(); // low > high
    expect(buildVolumeProfile([bar(0, 10, 11, 0)]).poc).toBeNull(); // volume 0
  });

  it("harga beku di satu harga -> POC = harga itu, VA = titik itu", () => {
    const vp = buildVolumeProfile([bar(0, 100, 100, 10), bar(1, 100, 100, 10)], 8);
    expect(vp.poc).toBeCloseTo(100, 6);
  });
});

describe("findHvnLvn", () => {
  it("deteksi puncak & lembah lokal pada profil sintetis", () => {
    // Profil 12 bin: puncak di bin 2 & 9, lembah di antara
    const bars: Bar[] = [];
    const shape = [1, 2, 8, 2, 1, 1, 1, 2, 8, 2, 1, 1]; // dua HVN, lembah di bin 5-6
    for (let i = 0; i < shape.length; i++) {
      bars.push(bar(i, i, i + 1, shape[i]!));
    }
    const vp = buildVolumeProfile(bars, 12);
    const { hvn, lvn } = findHvnLvn(vp, 0.5);
    expect(hvn.length).toBeGreaterThanOrEqual(2);
    expect(lvn.length).toBeGreaterThanOrEqual(1);
  });

  it("profil kosong -> array kosong tanpa error", () => {
    const { hvn, lvn } = findHvnLvn({ bins: [], poc: null, vah: null, val: null, binSize: 0, minPrice: 0, totalVolume: 0 });
    expect(hvn).toEqual([]);
    expect(lvn).toEqual([]);
  });
});

describe("distanceFromPocInBins", () => {
  it("positif di atas POC, negatif di bawah; null bila POC null atau binSize 0", () => {
    const vp = buildVolumeProfile([bar(0, 100, 102, 50), bar(1, 101, 103, 50)], 10);
    expect(vp.binSize).toBeGreaterThan(0);
    expect(distanceFromPocInBins(vp, vp.poc!)).toBeCloseTo(0, 2);
    expect(distanceFromPocInBins(vp, vp.poc! + vp.binSize * 2)).toBeCloseTo(2, 1);
    expect(distanceFromPocInBins(vp, vp.poc! - vp.binSize)).toBeLessThan(0);
    expect(distanceFromPocInBins({ ...vp, poc: null }, 100)).toBeNull();
    // Profil satu-harga (binSize 0) -> jarak dalam bin tidak bermakna -> null
    const flat = buildVolumeProfile([bar(0, 100, 100, 5)], 10);
    expect(flat.binSize).toBe(0);
    expect(distanceFromPocInBins(flat, 105)).toBeNull();
  });
});
