// apps/server/tests/multiTimeframe.test.ts - Unit test analisis multi-timeframe (T-5.15).
import { describe, expect, it } from "vitest";
import {
  analyzeMultiTimeframe,
  analyzeTimeframe,
  clearMtfCache,
  klinesToBars,
  type KlineFetcher,
} from "../src/engines/multiTimeframeAnalyzer.js";
import { getTimeframePlan, SCALP_TIMEFRAMES } from "../src/config/timeframes.js";

/** Bikin lilin Binance mentah (array) dengan tren naik bertahap. */
function makeKlines(count: number, opts: { start?: number; step?: number; t0?: number; volume?: number; intervalMs?: number } = {}) {
  const start = opts.start ?? 100;
  const step = opts.step ?? 0.25;
  const t0 = opts.t0 ?? 1700000000000;
  const intervalMs = opts.intervalMs ?? 60_000;
  const out: unknown[][] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    out.push([t0 + i * intervalMs, open, high, low, close, opts.volume ?? 1000 + i * 10, t0 + i * intervalMs + intervalMs - 1]);
    price = close;
  }
  return out;
}

/** Fetcher stub: semua interval tren naik, kecuali yang diminta kosong. */
function stubFetcher(emptyFor: string[] = []): KlineFetcher {
  return async (_symbol: string, interval: string, limit: number) => {
    if (emptyFor.includes(interval)) return [];
    return makeKlines(limit, { intervalMs: interval === "1m" ? 60_000 : interval === "3m" ? 180_000 : interval === "5m" ? 300_000 : interval === "15m" ? 900_000 : 3_600_000 });
  };
}

describe("Peta timeframe mesin setup (T-5.15)", () => {
  it("SCALP menganalisis 1m (trigger) + 3m (konfirmasi) + 5m (struktur) + 15m (bias) + makro 1h", () => {
    const plan = getTimeframePlan("SCALP");
    expect(plan.specs.map((s) => `${s.role}:${s.interval}`)).toEqual(["TRIGGER:1m", "CONFIRM:3m", "STRUCTURE:5m", "BIAS:15m"]);
    expect(plan.macroIntervals).toEqual(["1h"]);
    expect(plan.summary).toContain("1m");
    expect(plan.summary).toContain("5m");
    expect(plan.summary).toContain("15m");
    // Limit 90: cukup untuk semua indikator (ADX/Chop 28, zona 60) + weight REST 1.
    expect(SCALP_TIMEFRAMES.specs.every((s) => s.limit >= 80)).toBe(true);
  });
});

describe("analyzeMultiTimeframe (T-5.15)", () => {
  it("konversi lilin: baris rusak / non-numerik dibuang", () => {
    const bars = klinesToBars([
      [1700000000000, 1, 2, 0.5, 1.5, 10],
      ["x", "y", "z", "w", "v", "u"],
      [1700000060000, 1, 2, 0.5, 0, 10], // close 0 -> dibuang
      null,
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(1.5);
  });

  it("analisis lengkap 4 TF: usable, arah, skor 0-100, ringkasan TF benar", async () => {
    clearMtfCache();
    const a = await analyzeMultiTimeframe("BTCUSDT", "SCALP", stubFetcher(), { skipCache: true, now: 1700000000000 });
    expect(a.usable).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.timeframes).toHaveLength(4);
    expect(a.trigger.interval).toBe("1m");
    expect(a.structure.interval).toBe("5m");
    expect(a.bias.interval).toBe("15m");
    expect(a.trigger.role).toBe("TRIGGER");
    expect(a.structure.role).toBe("STRUCTURE");
    expect(a.bias.role).toBe("BIAS");
    for (const s of [a.zoneScore, a.triggerScore, a.trendScore, a.compositeScore]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
    expect(a.compositeScore).toBe(Math.round(a.trendScore * 0.30 + a.zoneScore * 0.30 + a.triggerScore * 0.25 + Math.min(98, Math.max(20, Math.round(a.confirm!.trendScore))) * 0.15));
    expect(a.tfSummary).toContain("SCALP: 1m");
    expect(a.price).toBeGreaterThan(0);
    expect(["LONG", "SHORT"]).toContain(a.side);
  });

  it("degradasi aman: klines bias (15m) kosong -> usable false + alasan jelas", async () => {
    clearMtfCache();
    const a = await analyzeMultiTimeframe("ETHUSDT", "SCALP", stubFetcher(["15m"]), { skipCache: true, now: 1700000000000 });
    expect(a.usable).toBe(false);
    expect(a.reason).toContain("INSUFFICIENT_KLINES");
    expect(a.reason).toContain("15m");
    expect(a.bias.available).toBe(false);
  });

  it("cache: panggilan kedua memakai cache, skipCache memaksa hitung ulang", async () => {
    clearMtfCache();
    const fetcher = stubFetcher();
    const first = await analyzeMultiTimeframe("SOLUSDT", "SCALP", fetcher, { cacheTtlMs: 60_000, now: 1700000000000 });
    const second = await analyzeMultiTimeframe("SOLUSDT", "SCALP", fetcher, { cacheTtlMs: 60_000, now: 1700000000001 });
    expect(second).toBe(first);
    const fresh = await analyzeMultiTimeframe("SOLUSDT", "SCALP", fetcher, { skipCache: true, now: 1700000000002 });
    expect(fresh).not.toBe(first);
  });

  it("analyzeTimeframe: bar kurang dari 30 -> snapshot kosong (tidak crash)", () => {
    const snap = analyzeTimeframe("XRPUSDT", "5m", "STRUCTURE", makeKlines(12).map((k: any) => ({ openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] })));
    expect(snap.available).toBe(false);
    expect(snap.bars).toBe(12);
  });
});
