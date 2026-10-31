// apps/server/tests/entryAttrs.test.ts - uji OFFLINE T-01 (snapshot atribut entry) + T-13 (kunci SHORT Liquidity Sweep Reclaim).
// Semua pemanggilan murni; tidak ada DB, jaringan, maupun nominal uang.
import { describe, expect, it } from "vitest";
import {
  ATTRS_MIN_BARS,
  buildEntryAttrs,
  computeAtrRegime,
  computeVolumeRatio,
  extractReasonAttrs,
  parseEntryAttrs,
  type AttrBar,
} from "../src/exec/entryAttrs.js";
import { isStrategySideLocked } from "../src/exec/slotFillPolicy.js";

const flatBars = (n: number, vol = 100, hi = 10, lo = 9.5, close = 9.8): AttrBar[] =>
  Array.from({ length: n }, () => ({ high: hi, low: lo, close, volume: vol }));

describe("extractReasonAttrs", () => {
  it("membaca atribut trigger dari tag alasan plan", () => {
    const r = extractReasonAttrs([
      "SWEEP_LONG_PREV_DAY",
      "SWEEP_DEPTH_ATR_0.42",
      "RECLAIM_DISPLACEMENT_ATR_0.31",
      "KILLZONE_LONDON",
    ]);
    expect(r.sweepDepthAtr).toBe(0.42);
    expect(r.displacementAtr).toBe(0.31);
    expect(r.killzone).toBe("LONDON");
  });

  it("KILLZONE_ABSENT dan tag lain -> null", () => {
    const r = extractReasonAttrs(["KILLZONE_ABSENT", "AGGRESSIVE_TREND_FOLLOW_LONG"]);
    expect(r.killzone).toBeNull();
    expect(r.sweepDepthAtr).toBeNull();
    expect(r.displacementAtr).toBeNull();
  });
});

describe("computeVolumeRatio", () => {
  it("vol bar entry dibagi rata-rata 20 bar sebelumnya", () => {
    const bars = [...flatBars(20, 100), { high: 10, low: 9.5, close: 9.8, volume: 150 }];
    expect(computeVolumeRatio(bars)).toBe(1.5);
  });

  it("kurang dari 21 bar -> null", () => {
    expect(computeVolumeRatio(flatBars(20))).toBeNull();
  });

  it("rata-rata nol -> null (bukan Infinity)", () => {
    const bars = [...flatBars(20, 0), { high: 10, low: 9.5, close: 9.8, volume: 5 }];
    expect(computeVolumeRatio(bars)).toBeNull();
  });
});

describe("computeAtrRegime", () => {
  it("bar datar -> rezim ~1", () => {
    const regime = computeAtrRegime(flatBars(ATTRS_MIN_BARS + 20));
    expect(regime).not.toBeNull();
    expect(regime!).toBeGreaterThan(0.9);
    expect(regime!).toBeLessThan(1.1);
  });

  it("volatilitas bar terakhir meledak -> rezim > 1", () => {
    const bars = flatBars(ATTRS_MIN_BARS + 10);
    bars[bars.length - 1] = { high: 20, low: 5, close: 12, volume: 100 };
    const regime = computeAtrRegime(bars);
    expect(regime).not.toBeNull();
    expect(regime!).toBeGreaterThan(1);
  });

  it("data kurang -> null", () => {
    expect(computeAtrRegime(flatBars(ATTRS_MIN_BARS - 1))).toBeNull();
  });
});

describe("buildEntryAttrs + parseEntryAttrs", () => {
  it("snapshot lengkap tersimpan dan bisa dibaca kembali", () => {
    const reasons = ["SWEEP_DEPTH_ATR_0.2", "RECLAIM_DISPLACEMENT_ATR_0.5", "KILLZONE_NY_AM"];
    const raw = buildEntryAttrs({
      strategyId: "S-03",
      side: "LONG",
      quality: 62,
      biasAligned: true,
      reasons,
      bars: [...flatBars(21, 100), { high: 10, low: 9.5, close: 9.8, volume: 200 }],
      now: new Date("2026-10-04T00:00:00Z"),
    });
    const a = parseEntryAttrs(raw);
    expect(a).not.toBeNull();
    expect(a!.v).toBe(1);
    expect(a!.strategyId).toBe("S-03");
    expect(a!.side).toBe("LONG");
    expect(a!.quality).toBe(62);
    expect(a!.sweepDepthAtr).toBe(0.2);
    expect(a!.displacementAtr).toBe(0.5);
    expect(a!.killzone).toBe("NY_AM");
    expect(a!.biasAligned).toBe(true);
    expect(a!.volumeRatio).toBe(2);
    expect(a!.recordedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(a!.reasons).toEqual(reasons);
  });

  it("input minimal -> field tak terukur null, tidak melempar", () => {
    const a = parseEntryAttrs(buildEntryAttrs({}));
    expect(a).not.toBeNull();
    expect(a!.strategyId).toBeNull();
    expect(a!.volumeRatio).toBeNull();
    expect(a!.atrRegime).toBeNull();
    expect(a!.reasons).toEqual([]);
  });

  it("JSON rusak / versi beda / bukan string -> null", () => {
    expect(parseEntryAttrs("bukan json")).toBeNull();
    expect(parseEntryAttrs('{"v":99}')).toBeNull();
    expect(parseEntryAttrs(null)).toBeNull();
    expect(parseEntryAttrs(123)).toBeNull();
  });
});

describe("isStrategySideLocked (T-13)", () => {
  it("SHORT Liquidity Sweep Reclaim (S-01 sejak renumber 6 Okt 2026) terkunci PERMANEN", () => {
    // 21 Okt 2026 (Phase 4c): saklar env S03_SHORT_ENABLED dihapus total, jadi
    // kunci tidak bisa dibuka lagi oleh env apa pun. Argumen boolean dihapus.
    expect(isStrategySideLocked("S-01", "SHORT")).toBe(true);
    expect(isStrategySideLocked("s-01", "short")).toBe(true);
  });

  it("kombinasi lain tidak pernah terkunci", () => {
    expect(isStrategySideLocked("S-01", "LONG")).toBe(false);
    expect(isStrategySideLocked("S-02", "SHORT")).toBe(false);
    expect(isStrategySideLocked("S-03", "SHORT")).toBe(false);
    expect(isStrategySideLocked(null, null)).toBe(false);
    expect(isStrategySideLocked(undefined, undefined)).toBe(false);
  });
});
