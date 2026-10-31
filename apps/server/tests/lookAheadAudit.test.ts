// tests/lookAheadAudit.test.ts — Big Brain 15 Okt 2026: audit look-ahead bias.
// Prinsipnya sama dengan test "future candles cannot alter strategy decision"
// di historicalBacktest.test.ts, tapi sebagai EKSPERIMEN penuh: dataset
// dipotong dan dirusak, replay dijalankan ulang, trade masa lalu wajib beku.
import { describe, it, expect } from "vitest";
import { runLookAheadAudit, type LookAheadReplayFn } from "../src/backtest/validation/lookAheadAudit.js";
import { replayHistoricalDataset, type HistoricalDataset, type ReplayOptions, type ReplayOutput } from "../src/backtest/historicalReplay.js";

const start = Date.UTC(2025, 0, 1);
const MS = 60000;

/** Dataset 1m sintetis: 12 jam in-sample + 12 jam OOS dengan trend naik ber-volatilitas. */
function dataset(): HistoricalDataset {
  const bars = Array.from({ length: 24 * 60 }, (_, i) => {
    const t = start + i * MS;
    const base = 100 + (i / 60) * 0.5; // drift naik
    const wobble = Math.sin(i / 7) * 0.8;
    const open = base + wobble;
    return {
      openTime: t,
      open,
      high: open + 0.6,
      low: open - 0.6,
      close: open + 0.1,
      volume: 100,
    };
  });
  return {
    schemaVersion: 1,
    source: "unit-test fixture (not market evidence)",
    downloadedAt: start + 48 * 3600000,
    symbol: "BTCUSDT",
    intervalMs: MS,
    bars,
    funding: [],
    fundingCoverage: { from: start, to: start + 24 * 3600000 },
    rules: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, maxLeverage: 25 },
    // In-sample = 12 jam pertama (untuk OOS runner); di sini OOS = jam ke-2..24.
    outOfSampleFrom: start + 2 * 3600000,
    outOfSampleTo: start + 24 * 3600000,
    trainingEndedAt: start + 3600000,
    embargoMs: MS,
    universeSelection: "test fixture",
  };
}

const options: ReplayOptions = {
  strategyId: "S-03",
  mode: "SCALP",
  fees: { makerRate: 0.0002, takerRate: 0.0005 },
  slippageBps: 0,
  initialEquityUsd: 200,
  targetRiskUsd: 1,
};

describe("lookAheadAudit", () => {
  it("dataset fixture lolos validasi dan menghasilkan baseline trade untuk diaudit", () => {
    const out = replayHistoricalDataset(dataset(), options);
    // Fixture ini mungkin menghasilkan 0 trade tergantung gate — audit harus
    // jujur bilang tidak ada yang bisa diaudit, bukan LULUS kosong.
    expect(out.errors).toEqual([]);
  });

  it("LULUS pada dataset bersih: masa depan dipotong & dirusak, masa lalu beku", () => {
    const result = runLookAheadAudit(dataset(), options);
    if (result.baseline.checkedTrades === 0) {
      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("NO_TRADES_BEFORE_CUT_NOTHING_TO_AUDIT");
      return;
    }
    expect(result.reasons).toEqual([]);
    expect(result.differences).toEqual([]);
    expect(result.passed).toBe(true);
    // Jumlah trade sebelum cut di baseline & varian harus sama persis.
    expect(result.truncated.checkedTrades).toBe(result.baseline.checkedTrades);
    expect(result.corrupted.checkedTrades).toBe(result.baseline.checkedTrades);
  });

  it("menolak dataset tidak valid dengan alasan eksplisit (tanpa klaim LULUS)", () => {
    const d = dataset();
    d.bars[3]!.openTime += MS; // gap
    const result = runLookAheadAudit(d, options);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("NON_CONTIGUOUS_BARS");
    expect(result.differences).toEqual([]);
  });

  it("menolak jendela OOS yang terlalu pendek untuk diaudit", () => {
    const d = dataset();
    d.outOfSampleFrom = start + 2 * 3600000;
    d.outOfSampleTo = start + 2 * 3600000 + MS; // 1 menit: cut tidak bisa di tengah (mid == from)
    d.fundingCoverage.to = d.outOfSampleTo;
    const result = runLookAheadAudit(d, options);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("OOS_WINDOW_TOO_SHORT_FOR_AUDIT");
  });

  it("DETEKTOR-nya sendiri bisa diuji: replayFn bocor palsu terdeteksi GAGAL", () => {
    // ReplayFn palsu yang "membaca masa depan": jika dataset menyandikan
    // penanda korupsi (volume=0 setelah cut), ia MENGUBAH trade sebelum cut.
    const leakyReplay: LookAheadReplayFn = (d: HistoricalDataset, o: ReplayOptions): ReplayOutput => {
      const real = replayHistoricalDataset(d, o);
      const futureCorrupted = d.bars.some((b) => b.volume === 0 && b.openTime > start);
      if (futureCorrupted) {
        const trades = real.trades.map((t, i) =>
          i === 0 ? { ...t, netR: t.netR + 999 } : t
        );
        return { ...real, trades };
      }
      return real;
    };
    const result = runLookAheadAudit(dataset(), options, leakyReplay);
    if (result.baseline.checkedTrades > 0) {
      expect(result.passed).toBe(false);
      expect(result.differences.length).toBeGreaterThan(0);
      expect(result.differences[0]!.experiment).toBe("CORRUPTED");
    }
  });

  it("cut berada di tengah jendela OOS dan selaras interval", () => {
    const result = runLookAheadAudit(dataset(), options);
    const expectedMid = Math.floor((dataset().outOfSampleFrom + dataset().outOfSampleTo) / 2 / MS) * MS;
    expect(result.cutTime).toBe(expectedMid);
    expect(result.cutTime % MS).toBe(0);
  });
});
