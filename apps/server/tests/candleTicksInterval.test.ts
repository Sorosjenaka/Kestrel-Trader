import { describe, it, expect } from "vitest";
import { applyCandleTick, intervalMsFor, type ChartCandle } from "../../web/src/lib/candleTicks.js";

/*
  23 Okt 2026 — test untuk bucketing candle live.

  Bug nyata: intervalMs dihitung sebagai Number(timeframe) * 60_000, jadi
  label non-menit ("1h", "4h", "1d", "D") jadi NaN -> applyCandleTick
  selalu return candles apa adanya -> chart live MATI (tidak pernah update)
  untuk timeframe per jam/hari.

  NativeQuantChart mengirim timeframe mentah ("60" = menit, "240", "D").
  Satuan waktu candle di NativeQuantChart = MILIDIK (Binance openTime),
  dan openTime selalu ALIGNED ke awal interval.
*/

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** ms yang tepat di awal interval 1 jam (472223 * 3600000). */
const hourAligned = 472_223 * HOUR;
/** ms yang tepat di awal hari ke-19675. */
const dayAligned = 19_675 * DAY;

const base: ChartCandle = { time: hourAligned, open: 100, high: 100, low: 100, close: 100, volume: 5 };
const baseDay: ChartCandle = { time: dayAligned, open: 100, high: 100, low: 100, close: 100, volume: 5 };

describe("intervalMsFor", () => {
  it("menerima label menit", () => {
    expect(intervalMsFor("1m")).toBe(60_000);
    expect(intervalMsFor("5m")).toBe(300_000);
    expect(intervalMsFor("15m")).toBe(900_000);
  });

  it("menerima label jam & hari (sebelumnya NaN)", () => {
    expect(intervalMsFor("1h")).toBe(HOUR);
    expect(intervalMsFor("4h")).toBe(4 * HOUR);
    expect(intervalMsFor("1d")).toBe(DAY);
    expect(intervalMsFor("D")).toBe(DAY);
  });

  it("menerima angka menit mentah yang dipakai NativeQuantChart", () => {
    expect(intervalMsFor("60")).toBe(HOUR);
    expect(intervalMsFor("240")).toBe(4 * HOUR);
  });

  it("tidak return NaN untuk input apa pun", () => {
    for (const tf of ["", "abc", "xyz", "1h", "D", "60", "5m"]) {
      expect(Number.isNaN(intervalMsFor(tf))).toBe(false);
    }
  });
});

describe("applyCandleTick", () => {
  it("MENGUPDATI close/high/low saat tick di bar yang sama (TF 1h)", () => {
    const out = applyCandleTick([base], 105, base.time + 1000, "1h");
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(105);
    expect(out[0]!.high).toBe(105);
    expect(out[0]!.low).toBe(100);
  });

  it("MENGUPDATI untuk TF 'D' (sebelumnya tidak pernah berubah)", () => {
    const out = applyCandleTick([baseDay], 105, baseDay.time + 1000, "D");
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(105);
    expect(out[0]!.high).toBe(105);
  });

  it("MENGUPDATI untuk TF '1h' (sebelumnya tidak pernah berubah)", () => {
    const out = applyCandleTick([base], 107, base.time + 500, "1h");
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(107);
  });

  it("MEMBUAT bar baru di interval berikutnya", () => {
    const next = base.time + HOUR;
    const out = applyCandleTick([base], 110, next, "1h");
    expect(out).toHaveLength(2);
    expect(out[1]!.time).toBe(next);
    expect(out[1]!.open).toBe(110);
    expect(out[1]!.close).toBe(110);
    expect(out[1]!.volume).toBe(0);
  });

  it("menolak tick yang lebih lama dari bar terakhir (out-of-order)", () => {
    const out = applyCandleTick([base], 90, base.time - HOUR, "1h");
    expect(out).toEqual([base]);
  });

  it("menolak input tidak valid tanpa melempar error", () => {
    expect(applyCandleTick([base], 0, base.time, "1h")).toEqual([base]);
    expect(applyCandleTick([base], -5, base.time, "1h")).toEqual([base]);
    expect(applyCandleTick([], 105, base.time, "1h")).toEqual([]);
    expect(applyCandleTick([base], 105, 0, "1h")).toEqual([base]);
  });

  it("volume pada bar yang sedang berjalan tidak di럽us (hanya dari kline)", () => {
    const out = applyCandleTick([base], 105, base.time + 1000, "1h");
    expect(out[0]!.volume).toBe(5);
  });
});
