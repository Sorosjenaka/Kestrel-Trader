// apps/server/tests/swingLane.test.ts
// T-06 — Lane SWING S-05: allowlist dua-lane, cap 2 global, spacing entry
// (PAPER off / LIVE 60 menit sejak 15 Okt 2026), analyzer bar 1h tertutup
// (anti-lookahead), dan fail-closed tanpa sinyal.
// Jalur SCALP wajib TIDAK BERUBAH perilakunya (regresi).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  allowedStrategiesFor,
  canOpenTradingLane,
  SwingEntrySpacingGuard,
  SWING_ENTRY_SPACING_MS_LIVE,
} from "../src/exec/slotFillPolicy.js";
import { env } from "../src/core/env.js";
import { analyzeSwingTimeframe, klinesToBars, type KlineFetcher } from "../src/engines/multiTimeframeAnalyzer.js";
import {
  runSwingBreakoutSignals,
  type SwingSignal,
} from "../src/strategies/swingBreakoutEngine.js";
import type { Bar } from "../src/universe/eligibility.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/swing/", import.meta.url));
const APR_1_MS = Date.parse("2026-04-01T00:00:00Z");

function loadBars(sym: string): Bar[] {
  const text = readFileSync(join(FIXTURES, `${sym}-1h.csv`), "utf8");
  const bars: Bar[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row) continue;
    const cells = row.split(",");
    const t = Number(cells[0]);
    if (!Number.isFinite(t) || t < 1.5e12) continue;
    const open = Number(cells[1]);
    const high = Number(cells[2]);
    const low = Number(cells[3]);
    const close = Number(cells[4]);
    const volume = Number(cells[5]);
    if (![open, high, low, close, volume].every(Number.isFinite)) continue;
    bars.push({ openTime: t, open, high, low, close, volume });
  }
  return bars.filter((b) => b.openTime >= APR_1_MS);
}

/** Stub klines Binance: kembalikan bar sebagai array mentah [t,o,h,l,c,v]. */
function stubFetcher(bars: Bar[]): KlineFetcher {
  return async () =>
    bars.map((b) => [b.openTime, b.open, b.high, b.low, b.close, b.volume]);
}

describe("T-06 — allowlist dua-lane", () => {
  it("SWING = RSW-01/02/03 saja; S-03/S-04/S-05 dihapus 20 Okt 2026", () => {
    // 20 Okt 2026 operator: "polaris hapus juga / yang S-05 itu" -> S-05
    // Polaris ikut dihapus. Tersisa tiga strategi riset di lane SWING.
    expect(allowedStrategiesFor("SWING")).toEqual(["RSW-01", "RSW-02", "RSW-03"]);
    expect(allowedStrategiesFor("SWING")).not.toContain("S-03");
    expect(allowedStrategiesFor("SWING")).not.toContain("S-04");
    expect(allowedStrategiesFor("SWING")).not.toContain("S-05");
  });

  it("SCALP: S-02 aktif; S-01 hard-gated (EV negatif) dan S-03 dihapus (20 Okt)", () => {
    const list = allowedStrategiesFor("SCALP");
    expect(list).not.toContain("S-01");
    expect(list).toContain("S-02");
    expect(list).not.toContain("S-03"); // 20 Okt 2026: Fibonacci dihapus
    expect(list).not.toContain("S-05");
  });
});

describe("T-06 — cap SWING global (canOpenTradingLane)", () => {
  // 14 Okt 2026: cap SWING kini dari env.SWING_MAX_POSITIONS (paper = 20,
  // permintaan operator). Test pin cap EKSPLISIT lewat arg ke-5 supaya tidak
  // ikut berubah saat env operator berubah.
  it("0-1 posisi SWING open + total < maks -> SWING boleh buka (cap eksplisit 2)", () => {
    expect(canOpenTradingLane("SWING", { SCALP: 0, SWING: 0 }, 20, true, 2)).toBe(true);
    expect(canOpenTradingLane("SWING", { SCALP: 5, SWING: 1 }, 20, true, 2)).toBe(true);
  });

  it("2 posisi SWING open -> DITOLAK walau slot total masih kosong (cap eksplisit 2)", () => {
    expect(canOpenTradingLane("SWING", { SCALP: 0, SWING: 2 }, 20, true, 2)).toBe(false);
    expect(canOpenTradingLane("SWING", { SCALP: 17, SWING: 2 }, 20, true, 2)).toBe(false);
  });

  // 15 Okt 2026 (revisi operator sore): max open posisi paper = 20 — default
  // tanpa env eksplisit mengikuti env.SWING_MAX_POSITIONS (=20 di .env).
  it("cap default (env, paper = 20): SWING<=19 diterima, SWING=20 ditolak bila slot total 20", () => {
    expect(canOpenTradingLane("SWING", { SCALP: 0, SWING: 1 }, 20)).toBe(true);
    expect(canOpenTradingLane("SWING", { SCALP: 0, SWING: 19 }, 20)).toBe(true);
    expect(canOpenTradingLane("SWING", { SCALP: 0, SWING: 20 }, 20)).toBe(false); // cap SWING = 20
    expect(canOpenTradingLane("SWING", { SCALP: 1, SWING: 19 }, 20)).toBe(false); // total = 20, slot penuh
  });

  it("slot total penuh -> SWING ditolak meski count-nya 0", () => {
    expect(canOpenTradingLane("SWING", { SCALP: 20, SWING: 0 }, 20)).toBe(false);
  });

  it("SCALP tidak berubah: boleh sampai kapasitas penuh, cap SWING tak mempengaruhi", () => {
    expect(canOpenTradingLane("SCALP", { SCALP: 19, SWING: 2 }, 20)).toBe(true);
    expect(canOpenTradingLane("SCALP", { SCALP: 20, SWING: 2 }, 20)).toBe(false);
  });
});

describe("T-06 — spacing entry swing: PAPER off, LIVE 15 menit (28 Okt 2026)", () => {
  function withExecutionMode(mode: "PAPER" | "LIVE", fn: () => void): void {
    const prev = env.BINANCE_EXECUTION_MODE;
    env.BINANCE_EXECUTION_MODE = mode;
    try {
      fn();
    } finally {
      env.BINANCE_EXECUTION_MODE = prev;
    }
  }

  it("konstanta LIVE = 15 menit (60->15, perintah operator 28 Okt 2026)", () => {
    expect(SWING_ENTRY_SPACING_MS_LIVE).toBe(900_000);
  });

  it("PAPER: spacing OFF — tidak pernah memblokir, msRemaining = 0", () => {
    withExecutionMode("PAPER", () => {
      const g = new SwingEntrySpacingGuard();
      const t0 = 1_700_000_000_000;
      g.record(t0);
      expect(g.isBlocked(t0 + 1)).toBe(false);
      expect(g.isBlocked(t0 + 1_000)).toBe(false);
      expect(g.msRemaining(t0 + 1)).toBe(0);
      // seed posisi lama pun tidak memblokir di PAPER
      const g2 = new SwingEntrySpacingGuard();
      g2.seed(t0 - 60_000);
      expect(g2.isBlocked(t0)).toBe(false);
    });
  });

  it("LIVE: blocked < 15 mnt, bebas >= 15 mnt (anti konvoi)", () => {
    withExecutionMode("LIVE", () => {
      const g = new SwingEntrySpacingGuard();
      const t0 = 1_700_000_000_000;
      expect(g.isBlocked(t0)).toBe(false); // belum ada entry
      g.record(t0);
      expect(g.isBlocked(t0 + SWING_ENTRY_SPACING_MS_LIVE - 1)).toBe(true);
      expect(g.isBlocked(t0 + SWING_ENTRY_SPACING_MS_LIVE)).toBe(false);
      expect(g.msRemaining(t0 + 5 * 60_000)).toBe(10 * 60_000);
    });
  });

  it("LIVE: seed(null) tidak memblokir; seed waktu lama memblokir sesuai umurnya", () => {
    withExecutionMode("LIVE", () => {
      const g = new SwingEntrySpacingGuard();
      const t0 = 1_700_000_000_000;
      g.seed(null);
      expect(g.isBlocked(t0)).toBe(false);
      g.seed(t0 - 10 * 60_000);
      expect(g.isBlocked(t0)).toBe(true);
      expect(g.isBlocked(t0 + 5 * 60_000)).toBe(false);
    });
  });
});

describe("T-06 — analyzer lane SWING (bar 1h tertutup, anti-lookahead)", () => {
  const bars = loadBars("BTCUSDT");
  const sigs: SwingSignal[] = runSwingBreakoutSignals(bars);
  expect(sigs.length).toBeGreaterThan(50);
  const last = sigs[sigs.length - 1]!;

  it("bar tertutup terakhir = sinyal -> usable, mode SWING, arah = sinyal", async () => {
    const slice = bars.slice(0, last.index + 1);
    const now = slice[slice.length - 1]!.openTime + 2 * 3_600_000; // bar sudah tutup
    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(slice), { now, skipCache: true });
    expect(analysis.mode).toBe("SWING");
    expect(analysis.usable).toBe(true);
    expect(analysis.side).toBe(last.side);
    expect(analysis.reason).toBeNull();
    expect(analysis.price).toBe(slice[slice.length - 1]!.close);
  });

  it("bar berjalan (belum tutup) DIPOTONG — hasil identik dengan seri tertutup", async () => {
    const slice = bars.slice(0, last.index + 1);
    const lastBar = slice[slice.length - 1]!;
    // Bar berjalan: buka tepat 1 jam setelah bar tertutup terakhir.
    const running: Bar = { openTime: lastBar.openTime + 3_600_000, open: lastBar.close * 1.05, high: lastBar.close * 1.06, low: lastBar.close * 0.99, close: lastBar.close * 1.04, volume: 1000 };
    const withRunning = [...slice, running];
    const now = running.openTime + 60_000; // bar berjalan BELUM tutup
    const a = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(withRunning), { now, skipCache: true });
    const b = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(slice), { now, skipCache: true });
    expect(a.usable).toBe(true);
    expect(a.price).toBe(b.price);
    expect(a.side).toBe(b.side);
    expect(a.trigger.barsData.length).toBe(b.trigger.barsData.length);
  });

  it("20 Okt 2026 (AU1-01) — gate usable lane SWING = KECUKUPAN DATA, bukan sinyal S-05. Tanpa sinyal S-05, analisis tetap usable (biar RSW-01/02/03 bisa dievaluasi)", async () => {
    const afterIdx = last.index + 1;
    const slice = bars.slice(0, afterIdx + 1);
    const now = slice[slice.length - 1]!.openTime + 2 * 3_600_000;
    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(slice), { now, skipCache: true });
    // S-03 Fibonacci dihapus dari katalog (perintah operator 20 Okt 2026).
    // Gate usable TIDAK lagi memuat cabang "setup fib armed" DAN TIDAK lagi
    // memaksa "ada sinyal S-05": usable = kelengkapan data (parity dengan
    // composeMtfAnalysis di jalur replay/backtest).
    //
    // Konsekuensi yang DIUJI di sini: analisis cukup data tetap usable
    // walau tidak ada sinyal S-05 — karena gate inilah yang sebelumnya
    // memblokir RSW-01/02/03 (AU1-01, BLOCKER).
    expect(analysis.usable).toBe(true);
    expect(analysis.reason).toBeNull();
    // 20 Okt 2026 (BUG-5): Skor kini deterministik dari snapshot, bukan
    // dari sinyal S-05. compositeScore = weighted blend trend/zone/trigger,
    // triggerScore langsung dari snapshot.triggerScore (clamp 20-98).
    expect(analysis.compositeScore).toBeGreaterThan(0);
    expect(analysis.triggerScore).toBeGreaterThan(0);
  });

  it("seri datar tanpa sinyal S-05 -> tetap usable (kelengkapan data cukup), skor deterministik dari snapshot", async () => {
    // Semua nilai identik -> tidak ada pivot unik (maxCount>1) -> tidak ada
    // setup fib, dan tidak ada breakout. Warmup 130 bar terpenuhi.
    const flat: Bar[] = Array.from({ length: 160 }, (_, i) => ({
      openTime: 1_700_000_000_000 + i * 3_600_000,
      open: 99.5, high: 100, low: 99, close: 99.5, volume: 1000,
    }));
    const now = flat[flat.length - 1]!.openTime + 2 * 3_600_000;
    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(flat), { now, skipCache: true });
    // Data cukup -> usable=true.
    // 20 Okt 2026 (BUG-5): Skor deterministik dari snapshot (bukan 0 karena
    // tidak ada sinyal S-05). triggerScore dari analyzeTimeframe clamp 20-98.
    // Analisis TIDAK mengarang trigger apa pun (tetap fail-closed di
    // level strategi: evaluateSwingBreakout push SWING_NO_SIGNAL_ON_LAST_CLOSED_H1).
    expect(analysis.usable).toBe(true);
    expect(analysis.reason).toBeNull();
    expect(analysis.compositeScore).toBeGreaterThanOrEqual(0);
    expect(analysis.triggerScore).toBeGreaterThan(0);
  });

  it("data di bawah warmup mesin -> usable=false, INSUFFICIENT_KLINES:1h", async () => {
    const slice = bars.slice(0, 50);
    const now = slice[slice.length - 1]!.openTime + 2 * 3_600_000;
    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(slice), { now, skipCache: true });
    expect(analysis.usable).toBe(false);
    expect(analysis.reason).toBe("INSUFFICIENT_KLINES:1h");
  });

  it("klinesToBars mengonversi stub array mentah dengan benar", () => {
    const converted = klinesToBars([[1_700_000_000_000, "100", "110", "95", "105", "12"]]);
    expect(converted.length).toBe(1);
    expect(converted[0]!.close).toBe(105);
  });
});
