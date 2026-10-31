// tests/eventReplay.test.ts — Big Brain 15 Okt 2026: event replay (futuretest).
// Jendela shock = fakta historis hard-coded. Event di luar cakupan dataset
// WAJIB dilaporkan NOT_COVERED, bukan dihitung dari data yang tidak ada.
import { describe, it, expect } from "vitest";
import { runEventReplay, CRYPTO_SHOCK_EVENTS, type CryptoShockEvent } from "../src/backtest/validation/eventReplay.js";
import type { HistoricalDataset } from "../src/backtest/historicalReplay.js";

const fees = { makerRate: 0.0002, takerRate: 0.0005 };

/** Dataset sintetis yang jendela OOS-nya mencakup window dari..to. */
function datasetAround(fromMs: number, toMs: number, padBeforeMs = 6 * 3600000, padAfterMs = 6 * 3600000): HistoricalDataset {
  const start = fromMs - padBeforeMs;
  const end = toMs + padAfterMs;
  const bars = [];
  for (let t = start; t < end; t += 60000) {
    const open = 100 + Math.sin(t / 3600000) * 3;
    bars.push({ openTime: t, open, high: open + 0.5, low: open - 0.5, close: open + 0.05, volume: 100 });
  }
  return {
    schemaVersion: 1,
    source: "unit-test fixture (not market evidence)",
    downloadedAt: end + 86400000,
    symbol: "BTCUSDT",
    intervalMs: 60000,
    bars,
    funding: [],
    fundingCoverage: { from: start, to: end },
    rules: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, maxLeverage: 25 },
    outOfSampleFrom: fromMs - 3600000,
    outOfSampleTo: toMs + 3600000,
    trainingEndedAt: fromMs - 3600000,
    embargoMs: 60000,
    universeSelection: "test fixture",
  };
}

describe("eventReplay", () => {
  it("katalog jendela shock kronologis, valid, dan tidak kosong", () => {
    expect(CRYPTO_SHOCK_EVENTS.length).toBeGreaterThanOrEqual(5);
    for (const ev of CRYPTO_SHOCK_EVENTS) {
      expect(ev.toMs).toBeGreaterThan(ev.fromMs);
      expect(ev.key).toBeTruthy();
      expect(ev.name).toBeTruthy();
      // Semua tanggal harus UTC epoch realistis (2020-2025).
      expect(ev.fromMs).toBeGreaterThan(Date.UTC(2020, 0, 1));
      expect(ev.fromMs).toBeLessThan(Date.UTC(2026, 0, 1));
    }
    // Kronologis
    for (let i = 1; i < CRYPTO_SHOCK_EVENTS.length; i++) {
      expect(CRYPTO_SHOCK_EVENTS[i]!.fromMs).toBeGreaterThan(CRYPTO_SHOCK_EVENTS[i - 1]!.toMs);
    }
  });

  it("event yang tidak tercakup dataset dilaporkan NOT_COVERED tanpa fabrikasi angka", () => {
    // Dataset 2025 — tidak mencakup jendela shock manapun (2020-2024).
    const d = datasetAround(Date.UTC(2025, 0, 10), Date.UTC(2025, 0, 11));
    const report = runEventReplay(d, "S-03", "SCALP", fees);
    expect(report.coveredCount).toBe(0);
    expect(report.notCoveredKeys.length).toBe(CRYPTO_SHOCK_EVENTS.length);
    for (const ev of report.events) {
      expect(ev.coverage).toBe("NOT_COVERED");
      expect(ev.winrate).toBeNull();
      expect(ev.netPnlUsd).toBeNull();
      expect(ev.worstNetR).toBeNull();
      expect(ev.buyAndHoldPct).toBeNull();
    }
    expect(report.totalNetPnlUsd).toBe(0);
  });

  it("event tercakup dihitung dari trade yang benar-benar entry di dalam jendela", () => {
    const custom: CryptoShockEvent[] = [
      {
        key: "TEST_SHOCK",
        name: "Test Shock",
        fromMs: Date.UTC(2025, 0, 10, 0, 0),
        toMs: Date.UTC(2025, 0, 10, 12, 0),
        description: "jendela uji",
      },
    ];
    const d = datasetAround(custom[0]!.fromMs, custom[0]!.toMs);
    const report = runEventReplay(d, "S-03", "SCALP", fees, { events: custom });
    expect(report.notCoveredKeys).toEqual([]);
    expect(report.events).toHaveLength(1);
    const ev = report.events[0]!;
    expect(ev.coverage).toBe("COVERED");
    expect(ev.tradeCount).toBeGreaterThanOrEqual(0);
    // Angka hanya boleh ada bila ada trade (tanpa 0 palsu yang terlihat seperti data).
    if (ev.tradeCount === 0) {
      expect(ev.winrate).toBeNull();
      expect(ev.netPnlUsd).toBeNull();
    } else {
      expect(ev.winrate).not.toBeNull();
      expect(ev.worstNetR).not.toBeNull();
      expect(ev.maxDdUsd).not.toBeNull();
    }
    // Buy-and-hold harus terhitung dari bar dataset (fixture punya harga ~100).
    expect(ev.buyAndHoldPct).not.toBeNull();
    expect(Math.abs(ev.buyAndHoldPct!)).toBeLessThan(50);
  });

  it("replayErrors dari validator dataset diteruskan apa adanya", () => {
    const d = datasetAround(Date.UTC(2025, 0, 10), Date.UTC(2025, 0, 11));
    d.bars[5]!.openTime += 60000; // gap → NON_CONTIGUOUS_BARS
    const report = runEventReplay(d, "S-03", "SCALP", fees);
    expect(report.replayErrors).toContain("NON_CONTIGUOUS_BARS");
    // Trade kosong — tidak ada hasil fabrikasi.
    expect(report.totalNetPnlUsd).toBe(0);
  });

  it("totalNetPnlUsd = jumlah netPnl trade di dalam jendela tercakup saja", () => {
    const custom: CryptoShockEvent[] = [
      { key: "W1", name: "W1", fromMs: Date.UTC(2025, 0, 10, 0, 0), toMs: Date.UTC(2025, 0, 10, 6, 0), description: "" },
    ];
    const d = datasetAround(custom[0]!.fromMs, custom[0]!.toMs);
    const report = runEventReplay(d, "S-03", "SCALP", fees, { events: custom });
    const sum = report.events
      .filter((e) => e.coverage === "COVERED")
      .reduce((s, e) => s + (e.netPnlUsd ?? 0), 0);
    expect(Math.abs(report.totalNetPnlUsd - sum)).toBeLessThan(0.01);
  });
});
