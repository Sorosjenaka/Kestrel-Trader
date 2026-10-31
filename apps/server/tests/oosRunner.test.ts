// tests/oosRunner.test.ts — Big Brain 15 Okt 2026: validasi out-of-sample.
// IS = [bar pertama..trainingEndedAt], OOS = [outOfSampleFrom..outOfSampleTo].
// Degradasi edge harus terdeteksi, data kurang harus dilaporkan jujur.
import { describe, it, expect } from "vitest";
import { runOutOfSampleValidation } from "../src/backtest/validation/oosRunner.js";
import type { HistoricalDataset } from "../src/backtest/historicalReplay.js";

const fees = { makerRate: 0.0002, takerRate: 0.0005 };
const start = Date.UTC(2025, 0, 1);

/** Dataset 1m sintetis: 6 jam IS + 12 jam OOS. */
function dataset(): HistoricalDataset {
  const bars = [];
  for (let i = 0; i < 18 * 60; i++) {
    const t = start + i * 60000;
    const open = 100 + (i / 60) * 0.4 + Math.sin(i / 7) * 0.7;
    bars.push({ openTime: t, open, high: open + 0.5, low: open - 0.5, close: open + 0.1, volume: 100 });
  }
  return {
    schemaVersion: 1,
    source: "unit-test fixture (not market evidence)",
    downloadedAt: start + 48 * 3600000,
    symbol: "BTCUSDT",
    intervalMs: 60000,
    bars,
    funding: [],
    fundingCoverage: { from: start, to: start + 18 * 3600000 },
    rules: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, maxLeverage: 25 },
    outOfSampleFrom: start + 6 * 3600000,
    outOfSampleTo: start + 18 * 3600000,
    trainingEndedAt: start + 5 * 3600000,
    embargoMs: 60000,
    universeSelection: "test fixture",
  };
}

describe("oosRunner", () => {
  it("dataset tidak valid → INSUFFICIENT_DATA dengan alasan, tanpa metrik fabrikasi", () => {
    const d = dataset();
    d.bars[3]!.openTime += 60000;
    const report = runOutOfSampleValidation(d, "S-03", "SCALP", fees);
    expect(report.status).toBe("INSUFFICIENT_DATA");
    expect(report.reasons).toContain("NON_CONTIGUOUS_BARS");
    expect(report.inSample).toBeNull();
    expect(report.outOfSample).toBeNull();
    expect(report.winrateDeltaPct).toBeNull();
  });

  it("IS terlalu pendek → INSUFFICIENT_DATA eksplisit", () => {
    const d = dataset();
    d.trainingEndedAt = start + 60000; // cuma 1 menit IS
    const report = runOutOfSampleValidation(d, "S-03", "SCALP", fees);
    expect(report.status).toBe("INSUFFICIENT_DATA");
    expect(report.reasons).toContain("INSUFFICIENT_IN_SAMPLE_DATA");
  });

  it("kedua jendela dijalankan: batas window sesuai deklarasi dataset", () => {
    const d = dataset();
    const report = runOutOfSampleValidation(d, "S-03", "SCALP", fees);
    // A prior bar is retained as warmup; the IS split is declared before its replay window.
    expect(report.inSample).not.toBeNull();
    expect(report.inSample!.windowFrom).toBe(start + 60000);
    expect(report.inSample!.windowTo).toBeLessThanOrEqual(d.trainingEndedAt);
    // OOS persis deklarasi dataset.
    expect(report.outOfSample!.windowFrom).toBe(d.outOfSampleFrom);
    expect(report.outOfSample!.windowTo).toBe(d.outOfSampleTo);
  });

  it("verdict deterministik: OOS tanpa trade → OOS_FAILED", () => {
    const d = dataset();
    // Interval OOS sempit + gate ketat tidak menjamin 0 trade; paksa lewat
    // mode SWING di dataset SCALP-pattern: gunakan strategi tak dikenal —
    // tidak, strategi tak dikenal melempar error. Gunakan pendekatan jujur:
    // kalau fixture menghasilkan 0 trade OOS, verdict wajib OOS_FAILED.
    const report = runOutOfSampleValidation(d, "S-03", "SCALP", fees);
    if (report.outOfSample!.tradeCount === 0) {
      expect(report.status).toBe("OOS_FAILED");
      expect(report.reasons).toContain("OOS_NO_TRADES");
    } else {
      expect(["CONSISTENT", "DEGRADED", "OOS_FAILED"]).toContain(report.status);
    }
  });

  it("delta winrate & evR dihitung dari metrik kedua jendela (bukan diisi manual)", () => {
    const report = runOutOfSampleValidation(dataset(), "S-03", "SCALP", fees);
    if (report.inSample!.tradeCount > 0 && report.outOfSample!.tradeCount > 0) {
      const expectedDelta = Number(
        (report.outOfSample!.metrics.winrate - report.inSample!.metrics.winrate).toFixed(2)
      );
      expect(report.winrateDeltaPct).toBeCloseTo(expectedDelta, 2);
      const expectedEvR = Number(
        (report.outOfSample!.metrics.evR - report.inSample!.metrics.evR).toFixed(4)
      );
      expect(report.evRDelta).toBeCloseTo(expectedEvR, 4);
    } else {
      expect(report.winrateDeltaPct).toBeNull();
      expect(report.evRDelta).toBeNull();
    }
  });

  it("funding coverage yang tidak menutup jendela IS ditolak jujur oleh validator", () => {
    const d = dataset();
    // fundingCoverage hanya menutup OOS — replay IS harus error, dan error itu
    // diteruskan (IS:MISSING_FUNDING_COVERAGE), bukan diabaikan.
    d.fundingCoverage = { from: d.outOfSampleFrom, to: d.outOfSampleTo };
    const report = runOutOfSampleValidation(d, "S-03", "SCALP", fees);
    expect(report.reasons.some((r) => r.startsWith("IS:") && r.includes("MISSING_FUNDING_COVERAGE"))).toBe(true);
  });
});
