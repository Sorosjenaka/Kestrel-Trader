// apps/server/tests/rswPrimitives.test.ts — T0.5 (18 Okt 2026): unit test primitif RSW.
//
// Nilai golden diambil dari oracle Python (research/*.py) pada input yang sama,
// sehingga regresi numerik tertangkap lebih awal sebelum test parity penuh.
import { describe, expect, it } from "vitest";
import type { Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import {
  aggregate,
  atrSeries,
  context,
  dailyRegime,
  ema,
  equalSweep,
  nalSpectrum,
  profile,
  ridge,
  rma,
  supertrendDirections,
  vector,
} from "../src/strategies/researchSwing/rswPrimitives.js";

function close(a: number, b: number, tol = 1e-9): void {
  expect(Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12)).toBeLessThan(tol);
}

function bar(time: number, o: number, h: number, l: number, c: number, v: number): Bar {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

describe("ema (seed nilai pertama)", () => {
  it("ema3 golden [10,10.5,11.25,12.125,13.0625,14.03125]", () => {
    const out = ema([10, 11, 12, 13, 14, 15], 3);
    const want = [10, 10.5, 11.25, 12.125, 13.0625, 14.03125];
    out.forEach((v, i) => close(v, want[i]!));
  });
});

describe("rma (Wilder)", () => {
  it("rma3 golden [null,null,2.0,2.666...,3.444...,4.296...]", () => {
    const out = rma([1, 2, 3, 4, 5, 6], 3);
    expect(out[0]).toBe(null);
    expect(out[1]).toBe(null);
    close(out[2]!, 2.0);
    close(out[3]!, 2.6666666666666665);
    close(out[4]!, 3.444444444444444);
    close(out[5]!, 4.296296296296297);
  });
});

describe("atrSeries (Pine ta.atr)", () => {
  it("atr3 golden pada bar sintetis", () => {
    const bars = [
      bar(0, 10, 11, 9, 10.5, 100),
      bar(1, 10.5, 11.5, 10, 11, 120),
      bar(2, 11, 12, 10.5, 11.5, 90),
      bar(3, 11.5, 12.5, 11, 12, 110),
      bar(4, 12, 13, 11.5, 12.5, 130),
      bar(5, 12.5, 13.5, 12, 13, 100),
    ];
    const out = atrSeries(bars, 3);
    expect(out[0]).toBe(null);
    expect(out[1]).toBe(null);
    close(out[2]!, 1.6666666666666667);
    close(out[3]!, 1.6111111111111114);
    close(out[4]!, 1.5740740740740744);
    close(out[5]!, 1.549382716049383);
  });
});

describe("aggregate (15m -> interval)", () => {
  it("menggabungkan 4 sub-bar 15m menjadi 1 bar H1 lengkap", () => {
    const base = 3_600_000; // bucket H1
    const rows = [
      bar(base + 0, 1, 2, 0.5, 1.5, 10),
      bar(base + 900_000, 1.5, 3, 1, 2, 20),
      bar(base + 1_800_000, 2, 2.5, 1.5, 2.2, 30),
      bar(base + 2_700_000, 2.2, 2.8, 2, 2.5, 40),
    ];
    const out = aggregate(rows, 3_600_000);
    expect(out.length).toBe(1);
    expect(out[0]!.time).toBe(base);
    expect(out[0]!.open).toBe(1);
    expect(out[0]!.high).toBe(3);
    expect(out[0]!.low).toBe(0.5);
    expect(out[0]!.close).toBe(2.5);
    expect(out[0]!.volume).toBe(100);
  });

  it("menolak grup tidak lengkap (hanya 3 dari 4 sub-bar)", () => {
    const base = 3_600_000;
    const rows = [
      bar(base + 0, 1, 2, 0.5, 1.5, 10),
      bar(base + 900_000, 1.5, 3, 1, 2, 20),
      bar(base + 1_800_000, 2, 2.5, 1.5, 2.2, 30),
    ];
    expect(aggregate(rows, 3_600_000).length).toBe(0);
  });
});

describe("vector + ridge (model RSW-03)", () => {
  it("vector golden 11 dimensi", () => {
    const out = vector({
      side: "SHORT",
      close: 100,
      mean20: 101,
      atr: 2,
      priority: 8,
      adx: 30,
      trend: -1,
      entry: 100.5,
      structuralSl: 102,
    });
    const want = [
      1, -1, 1, 0.2, 0.5, 0.16666666666666666, 1.990049751243781, 0.25, 0.16666666666666666, 0.2,
      0.08333333333333333,
    ];
    expect(out.length).toBe(11);
    out.forEach((v, i) => close(v, want[i]!));
  });

  it("ridge golden 2-fitur", () => {
    const out = ridge(
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
      [3, 5, 7],
      0.1
    );
    close(out[0]!, 1.5882352941176374);
    close(out[1]!, 0.5882352941176536);
  });
});

describe("profile (24-bin VA)", () => {
  it("profile golden pada 30 bar seragam", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i * 900_000, 10, 11, 9, 10.5, 100] as const);
    const p = profile(rows.map((r) => bar(r[0], r[1], r[2], r[3], r[4], r[5])));
    expect(p).not.toBeNull();
    close(p!.poc, 10.125);
    close(p!.val, 10.083333333333334);
    close(p!.vah, 10.166666666666666);
    close(p!.vwap72, 10.166666666666666);
    close(p!.profileVolume, 3000);
  });

  it("mengembalikan null bila volume nol", () => {
    const rows = Array.from({ length: 5 }, (_, i) => bar(i * 900_000, 10, 11, 9, 10, 0));
    expect(profile(rows)).toBeNull();
  });
});

describe("primitif lain — smoke kontrak API", () => {
  it("context/dailyRegime/nalSpectrum/supertrendDirections/equalSweep terbentuk tanpa error", () => {
    const bars = Array.from({ length: 250 }, (_, i) =>
      bar(i * 4 * 3_600_000, 100 + i * 0.1, 101 + i * 0.1, 99 + i * 0.1, 100.5 + i * 0.1, 1000)
    );
    const ctx = context(bars);
    expect(ctx.length).toBe(250);
    expect(typeof ctx[249]!.adx).toBe("number");

    const regime = dailyRegime(bars);
    expect(regime.length).toBe(250 - 199);
    expect(typeof regime[0]!.bias).toBe("number");

    const nal = nalSpectrum(bars.map((b) => b.close));
    expect(nal.length).toBe(250);

    const gold = supertrendDirections(bars);
    expect(gold.length).toBe(250);

    const prior = bars.slice(-25, -1);
    const [sw, lvl] = equalSweep(prior, bars[249]!, 2);
    expect(typeof sw).toBe("number");
    expect(sw === 0 || lvl !== null).toBe(true);
  });
});
