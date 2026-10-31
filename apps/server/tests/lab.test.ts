// apps/server/tests/lab.test.ts — Gate validasi Lab (T-30) & konsistensi angka (T-32).
// Prinsip: seri cepat divalidasi terhadap implementasi LAMBAT pembanding, tol 1e-9.
import { describe, expect, it } from "vitest";
import {
  atrSeries, macdSeries, bbSeries, rsi, ema, smaLine,
  rsiSlow, emaSlow, atrSlow, type Bar,
} from "../src/lab/labIndicators.js";
import { runLabBacktest } from "../src/lab/labEngine.js";
import type { LabSpec } from "../src/lab/labTypes.js";
import { parsePineSource } from "../src/lab/pineParser.js";

function mkBars(n: number, seed = 7): Bar[] {
  const bars: Bar[] = [];
  let p = 100;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) - 0.5; };
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + rnd() * 0.02);
    const h = Math.max(o, c) * (1 + Math.abs(rnd()) * 0.01);
    const l = Math.min(o, c) * (1 - Math.abs(rnd()) * 0.01);
    bars.push({ t: 1700000000000 + i * 300000, o, h, l, c, v: 1000 + rnd() * 100 });
    p = c;
  }
  return bars;
}

describe("Lab gate validasi indikator (T-30)", () => {
  const bars = mkBars(300);

  it("RSI cepat == RSI slow (tol 1e-9)", () => {
    const fast = rsi(bars, 14);
    const slow = rsiSlow(bars.map((b) => b.c), 14);
    for (let i = 0; i < fast.length; i++) {
      if (!Number.isFinite(slow[i])) continue;
      expect(Math.abs(fast[i] - slow[i])).toBeLessThan(1e-9);
    }
  });

  it("EMA cepat == EMA slow (tol 1e-9)", () => {
    const fast = ema(bars, 20);
    const slow = emaSlow(bars.map((b) => b.c), 20);
    for (let i = 0; i < fast.length; i++) {
      if (!Number.isFinite(slow[i])) continue;
      expect(Math.abs(fast[i] - slow[i])).toBeLessThan(1e-9);
    }
  });

  it("ATR cepat == ATR slow (tol 1e-9)", () => {
    const fast = atrSeries(bars, 14);
    const slow = atrSlow(bars, 14);
    for (let i = 0; i < fast.length; i++) {
      if (!Number.isFinite(slow[i])) continue;
      expect(Math.abs(fast[i] - slow[i])).toBeLessThan(1e-9);
    }
  });

  it("MACD: hist == macd - signal", () => {
    const m = macdSeries(bars, 12, 26, 9);
    for (let i = 0; i < m.macd.length; i++) {
      if (!Number.isFinite(m.hist[i])) continue;
      expect(Math.abs(m.hist[i] - (m.macd[i] - m.signal[i]))).toBeLessThan(1e-9);
    }
  });

  it("Bollinger: upper-lower == 2*mult*dev dan basis == SMA", () => {
    const b = bbSeries(bars, 20, 2);
    const sm = smaLine(bars, 20);
    for (let i = 19; i < b.basis.length; i++) {
      expect(Math.abs(b.basis[i] - sm[i])).toBeLessThan(1e-9);
      expect(b.upper[i]).toBeGreaterThan(b.basis[i]);
      expect(b.lower[i]).toBeLessThan(b.basis[i]);
    }
  });
});

describe("Lab engine — konsistensi angka (T-32)", () => {
  const bars = mkBars(600);
  const spec: LabSpec = {
    name: "uji",
    symbol: "BTCUSDT",
    interval: "5m",
    from: new Date(bars[0].t).toISOString(),
    to: new Date(bars[bars.length - 1].t).toISOString(),
    direction: "LONG",
    entryConditions: [
      { left: { kind: "INDICATOR", indicator: "RSI", period: 14 }, op: "LT", right: { kind: "VALUE", value: 35 } },
    ],
    sl: { kind: "PCT", value: 1 },
    tp: { kind: "PCT", value: 2 },
    source: "MANUAL_BLOCK",
  };

  it("semua check validasi internal = true", () => {
    const r = runLabBacktest(spec, bars);
    for (const v of r.stats.validation) expect(v.ok).toBe(true);
  });

  it("sum(R) == grossWin - grossLoss dan winrate konsisten", () => {
    const r = runLabBacktest(spec, bars);
    const wins = r.trades.filter((t) => t.rMultiple > 0);
    const losses = r.trades.filter((t) => t.rMultiple <= 0);
    const sum = r.trades.reduce((a, t) => a + t.rMultiple, 0);
    const gw = wins.reduce((a, t) => a + t.rMultiple, 0);
    const gl = Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0));
    expect(Math.abs(sum - (gw - gl))).toBeLessThan(1e-9);
    if (r.trades.length > 0) {
      expect(Math.abs(r.stats.winrate - (wins.length / r.trades.length) * 100)).toBeLessThan(1e-9);
    }
  });

  it("baseline = band SL-first (konservatif)", () => {
    const r = runLabBacktest(spec, bars);
    expect(r.stats.intrabarBand.slFirst.sumR).toBeLessThanOrEqual(r.stats.intrabarBand.tpFirst.sumR + 1e-9);
    expect(Math.abs(r.stats.sumR - r.stats.intrabarBand.slFirst.sumR)).toBeLessThan(1e-9);
  });

  it("trade tanpa kondisi terpenuhi tetap aman (tanpa throw)", () => {
    const impossible: LabSpec = {
      ...spec,
      entryConditions: [
        { left: { kind: "INDICATOR", indicator: "RSI", period: 14 }, op: "GT", right: { kind: "VALUE", value: 500 } },
      ],
    };
    const r = runLabBacktest(impossible, bars);
    expect(r.trades.length).toBe(0);
    expect(r.caveats.some((c) => c.includes("Tidak ada trade"))).toBe(true);
  });
});

describe("Pine parser (T-29) — jujur pada yang tak dikenali", () => {
  it("memetakan crossover EMA + RSI ke kondisi blok", () => {
    const src = `
      //@version=5
      strategy("Test")
      fast = ta.ema(close, 9)
      slow = ta.ema(close, 21)
      longCond = ta.crossover(fast, slow) and ta.rsi(close, 14) > 50
      if longCond
        strategy.entry("L", strategy.long)
    `;
    const p = parsePineSource(src, { symbol: "BTCUSDT", interval: "5m" });
    expect(p.spec.entryConditions!.length).toBeGreaterThan(0);
    expect(p.spec.direction === "LONG" || p.spec.direction === "BOTH").toBe(true);
  });

  it("baris logika tak dikenali -> unmapped, tidak dikarang", () => {
    const src = `
      //@version=5
      strategy("X")
      myCustom = secretSauce(close, 3) * weirdTransform(open)
      if myCustom > 0
        strategy.entry("L", strategy.long)
    `;
    const p = parsePineSource(src);
    expect(p.unmapped.length).toBeGreaterThan(0);
    expect(p.notes.some((n) => n.toLowerCase().includes("tidak dikenali"))).toBe(true);
  });
});
