// apps/server/tests/swingBreakoutSetup.test.ts
// S-05 "Swing Breakout Pattern" (Polaris) — DIHAPUS dari katalog aktif
// 20 Okt 2026 (perintah operator: "polaris hapus juga / yang S-05 itu").
//
// Bukti penghapusan (research/out/master_v2, executed-only): n=1.391,
// PF 0.7503, P(EV<=0)=99.9%, 2026 PF 0.452, walk-forward train 0.867 ->
// test 0.642 = EDGE NEGATIF setelah constraint produksi.
//
// Yang diuji di sini (setelah penghapusan):
//   1. Jalur ENTRY: evaluateSwingBreakout() fail-closed — matched=false,
//      alasan STRATEGY_RETIRED, TIDAK crash, TIDAK ada level harga karangan.
//      Pola sama dengan S-03/S-04 (AU1-02: `getStrategySpec()` null + `!`
//      = TypeError runtime).
//   2. Jalur REPLAY HISTORIS: evaluateSwingBreakoutArchive() masih bisa
//      menghitung plan S-05 dari mesin (dipakai historicalReplay ONLY) —
//      operator akan meracik backtest dari strategi lain, jadi mesinnya
//      harus tetap hidup DI LUAR katalog aktif.
//   3. Mesinnya sendiri (paritas 1:1 dengan riset) tetap teruji di
//      swingBreakoutEngine.test.ts — file ini tidak mengulanginya.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  buildStrategyPlans,
  evaluateSwingBreakout,
  evaluateSwingBreakoutArchive,
  type StrategyContext,
} from "../src/strategies/setupStrategies.js";
import {
  runSwingBreakoutSignals,
  SWING_WARMUP,
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
    if (!Number.isFinite(t) || t < 1.5e12) continue; // header/non-data dilewati
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

/** MtfAnalysis minimal untuk evaluator (field tak dipakai S-05 boleh kosong). */
function swingCtx(bars: Bar[], livePrice: number, mode: "SCALP" | "SWING" = "SWING"): StrategyContext {
  const analysis = {
    symbol: "BTCUSDT",
    mode,
    side: "LONG" as const,
    price: livePrice,
    usable: true,
    reason: null,
    tfSummary: "SWING: 1h (trigger breakout, struktur channel) — test fixture",
    biasAligned: true,
    analyzedAt: bars.length ? bars[bars.length - 1]!.openTime : 0,
    timeframes: [],
    trigger: null,
    structure: null,
    bias: null,
    confirm: null,
    confirmAligned: true,
    zoneScore: 0,
    triggerScore: 0,
    trendScore: 50,
    compositeScore: 50,
    bestZone: null,
    zoneAnalysis: null,
    atrTrigger: null,
    atrStructure: null,
  } as unknown as StrategyContext["analysis"];
  return { analysis, price: livePrice, mode, swing: { h1Bars: bars } };
}

const closeTo = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("S-05 retired 20 Okt 2026 — entry fail-closed, replay arsip tetap hidup", () => {
  const bars = loadBars("BTCUSDT");
  expect(bars.length).toBeGreaterThan(4000);

  it("ENTRY: evaluateSwingBreakout fail-closed — STRATEGY_RETIRED, tanpa crash, tanpa level karangan", () => {
    // Fixture berisi sinyal breakout nyata (>= 50 sinyal) — plan retired
    // HARUS tetap ditolak walau mesinnya punya sinyal valid.
    const sigs = runSwingBreakoutSignals(bars);
    expect(sigs.length).toBeGreaterThan(50);
    const last = sigs[sigs.length - 1]!;
    const slice = bars.slice(0, last.index + 1);
    const live = slice[slice.length - 1]!.close;

    const plan = evaluateSwingBreakout(swingCtx(slice, live));
    expect(plan.strategyId).toBe("S-05");
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    // Tidak ada level harga karangan (bukan plan entry).
    expect(plan.entryPrice).toBe(0);
    expect(plan.slPrice).toBe(0);
    expect(plan.tp1Price).toBe(0);
    expect(plan.quality).toBe(0);
  });

  it("ENTRY: retired juga saat data 1h kosong / mode SCALP — alasan tetap STRATEGY_RETIRED", () => {
    // Retired dicek SEBELUM gate data/mode: tidak ada jalur yang bisa
    // menghasilkan plan S-05 matched, dari input apa pun.
    for (const ctx of [
      swingCtx([], bars[bars.length - 1]!.close),
      swingCtx(bars, bars[bars.length - 1]!.close, "SCALP"),
      swingCtx(bars.slice(0, SWING_WARMUP - 1), bars[SWING_WARMUP - 2]!.close),
    ]) {
      const plan = evaluateSwingBreakout(ctx);
      expect(plan.matched).toBe(false);
      expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    }
  });

  it("ENTRY: dispatch — S-05 tidak muncul lagi di buildStrategyPlans (dihapus dari katalog)", () => {
    const sigs = runSwingBreakoutSignals(bars);
    const last = sigs[sigs.length - 1]!;
    const slice = bars.slice(0, last.index + 1);
    const ctx = swingCtx(slice, slice[slice.length - 1]!.close);
    const plans = buildStrategyPlans(ctx, Date.now(), ["S-05"]);
    // S-05 TIDAK ada di STRATEGY_SPECS lagi -> tidak ada plan S-05 sama sekali
    // (bukan plan retired — plan placeholder juga tidak dibuat karena spec
    //-nya hilang dari katalog).
    expect(plans.map((p) => p.strategyId)).not.toContain("S-05");
  });

  it("REPLAY ARSIP: evaluateSwingBreakoutArchive masih menghitung plan S-05 dari mesin", () => {
    // Jalur OFFLINE (historicalReplay) — mesin swingBreakoutEngine tetap hidup
    // supaya operator bisa meracik backtest dari strategi lain.
    const sigs = runSwingBreakoutSignals(bars);
    const last = sigs[sigs.length - 1]!;
    const slice = bars.slice(0, last.index + 1);
    const live = slice[slice.length - 1]!.close;

    const plan = evaluateSwingBreakoutArchive(swingCtx(slice, live));
    expect(plan.strategyId).toBe("S-05");
    expect(plan.matched, plan.reasons.join(",")).toBe(true);
    expect(plan.side).toBe(last.side);
    expect(plan.entryPrice).toBe(live);
    expect(closeTo(plan.slPrice, last.sl)).toBe(true);
    // Geometri R = 2x jarak entry->garis, TP1 ladder 2R (RR23).
    const dirn = last.side === "LONG" ? 1 : -1;
    const r = 2 * Math.abs(plan.entryPrice - last.opposite);
    expect(closeTo(plan.rDistance, r)).toBe(true);
    expect(closeTo(plan.tp1Price, plan.entryPrice + dirn * r * 2)).toBe(true);
    expect(plan.rr1).toBeCloseTo(2, 2);
    expect(plan.slPct).toBeGreaterThan(0);
    expect(plan.slPct).toBeLessThanOrEqual(0.2);
    if (plan.side === "LONG") {
      expect(plan.slPrice).toBeLessThan(plan.entryPrice);
      expect(plan.tp1Price).toBeGreaterThan(plan.entryPrice);
    } else {
      expect(plan.slPrice).toBeGreaterThan(plan.entryPrice);
      expect(plan.tp1Price).toBeLessThan(plan.entryPrice);
    }
  });
});
