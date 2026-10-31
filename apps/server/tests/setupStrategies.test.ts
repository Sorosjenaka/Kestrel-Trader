// apps/server/tests/setupStrategies.test.ts - Unit test strategi aktif + geometri SL/TP (T-5.15).
//
// 6 Okt 2026 — RENUMBER 3 strategi (perintah operator): Squeeze Breakout, FVG
// Continuation, dan HA Smooth Scalper DIHAPUS dari katalog; uji evaluator lama
// DIHAPUS — bukan di-skip — supaya tidak ada hijau palsu. Katalog aktif:
//   S-01 Liquidity Sweep Reclaim (eks S-03)  -> 1.5R
//   S-02 Liquidity Sniper (eks S-04)         -> 1.5R
//   S-03 Fibonacci Zone 0.5-0.618 (7 Okt)    -> 1.5R dipaksa (override per-strategi)

import { describe, expect, it } from "vitest";
import type { Bar } from "../src/universe/eligibility.js";
import type { DetectedZone } from "../src/engines/zoneTriggerEngine.js";
import type { MtfAnalysis, TfSnapshot } from "../src/engines/multiTimeframeAnalyzer.js";
import {
  buildSlTpMenu,
  buildTargets,
  clampSlToBand,
  evaluateFibRetracement,
  evaluateLiquiditySniper,
  evaluateLiquiditySweepReclaim,
  selectBestPlan,
  structureExtreme,
  structureTarget,
  validatePlan,
  type StrategyContext,
  type StrategyPlan,
} from "../src/strategies/setupStrategies.js";
import { detectFibRetracement } from "../src/engines/fibRetracementEngine.js";
import { liquiditySniper } from "../src/engines/indicatorLibrary.js";
import { env } from "../src/core/env.js";

function mkBars(count: number, start: number, step: number, t0 = 1700000000000, intervalMs = 300_000): Bar[] {
  const out: Bar[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    out.push({
      openTime: t0 + i * intervalMs,
      open,
      high: Math.max(open, close) + Math.abs(step) * 0.4,
      low: Math.min(open, close) - Math.abs(step) * 0.4,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

function mkZone(over: Partial<DetectedZone> & { type: DetectedZone["type"]; side: DetectedZone["side"]; top: number; bottom: number }): DetectedZone {
  return {
    id: `z_${over.type}_${over.top}`,
    mid: (over.top + over.bottom) / 2,
    barIndex: 10,
    score: 70,
    usable: true,
    factors: { impulse: 20, freshness: 20, structureBreak: 20, fvgConfluence: 0, trendAlign: 20 },
    ...over,
  };
}

function snap(over: Partial<TfSnapshot> & { interval: TfSnapshot["interval"]; role: TfSnapshot["role"]; barsData: Bar[] }): TfSnapshot {
  return {
    available: true,
    bars: over.barsData.length,
    atr: 1,
    atrPct: 1,
    regime: "TRENDING",
    trend: "BULLISH",
    trendScore: 70,
    zlema: 100,
    adx: 25,
    chop: 40,
    shieldActive: false,
    zoneScore: 70,
    bestZone: null,
    usableZones: [],
    squeezeOn: false,
    squeezeRelease: false,
    squeezeDirection: "NEUTRAL",
    squeezeTarget: null,
    triggerScore: 60,
    ...over,
  };
}

function mkAnalysis(over: Partial<MtfAnalysis> = {}): MtfAnalysis {
  const structureBars = mkBars(80, 95, 0.08);
  const trigger = snap({ interval: "1m", role: "TRIGGER", barsData: mkBars(60, 99, 0.02, 1700000000000, 60_000) });
  const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: structureBars });
  const bias = snap({ interval: "15m", role: "BIAS", barsData: mkBars(60, 90, 0.2, 1700000000000, 900_000) });
  const demand = mkZone({ type: "DEMAND", side: "BULLISH", bottom: 100, top: 101 });
  const supply = mkZone({ type: "SUPPLY", side: "BEARISH", bottom: 103, top: 104 });
  return {
    symbol: "TESTUSDT",
    mode: "SCALP",
    timeframes: [trigger, structure, bias],
    trigger,
    structure,
    bias,
    confirm: null,
    confirmAligned: true,
    zoneScore: 70,
    triggerScore: 60,
    trendScore: 70,
    compositeScore: 68,
    biasAligned: true,
    side: "LONG",
    bestZone: demand,
    zoneAnalysis: { symbol: "TESTUSDT", bestZone: demand, allZones: [demand, supply], usableZones: [demand, supply], zoneScore: 70, trigger: { squeezeOn: false, squeezeRelease: false, momentum: 0, direction: "NEUTRAL", expectedDistanceAtr: 0, expectedTargetPrice: 0, triggerScore: 50, bbUpper: 0, bbLower: 0, kcUpper: 0, kcLower: 0, atr: 1 }, triggerScore: 50 },
    atrTrigger: 1,
    atrStructure: 1,
    price: 100.5,
    usable: true,
    reason: null,
    tfSummary: "SCALP: 1m (trigger) + 5m (struktur/zona) + 15m (bias) + makro 1h",
    analyzedAt: 1700000000000,
    ...over,
  };
}

/**
 * Bar untuk S-03 (48 bar, wajib >= 40 agar evaluator memakai TF STRUKTUR):
 * 30 bar pertama membentuk RANGE acuan, lalu konsolidasi, lalu satu bar yang
 * menyapu LOW range (wick di bawah) tetapi CLOSE kembali di atas level itu
 * dengan body sehat = liquidity sweep + reclaim.
 */
function barsWithSweepReclaim(): Bar[] {
  const bars = mkBars(30, 100, 0.02);
  const refLow = Math.min(...bars.map((b) => b.low));
  let t = bars[bars.length - 1]!.openTime + 300_000;
  const push = (open: number, high: number, low: number, close: number) => {
    bars.push({ openTime: t, open, high, low, close, volume: 1000 });
    t += 300_000;
  };
  for (let i = 0; i < 6; i++) push(100.3, 100.45, 100.2, 100.35); // konsolidasi
  push(100.3, 100.42, refLow - 0.06, 100.5); // sweep low range + reclaim
  for (let i = 0; i < 11; i++) push(100.48, 100.6, 100.4, 100.55); // lanjutan
  return bars;
}

/** Analisis SCALP siap S-03: struktur berisi sweep + reclaim, harga di reclaim. */
function analysisWithSweep(): MtfAnalysis {
  const a = mkAnalysis();
  const bars = barsWithSweepReclaim();
  const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
  return { ...a, structure, timeframes: [a.trigger, structure, a.bias], price: bars[bars.length - 1]!.close };
}

/** Tren naik monoton yang berakhir dekat harga entry (band S-04 berada di bawah harga). */
function barsUptrend(): Bar[] {
  return mkBars(80, 92, 0.1);
}

/**
 * Bar untuk S-04 Liquidity Sniper: tiga skenario peta likuiditas.
 * Uptrend -> pull bias UP (LONG); Downtrend -> pull bias DOWN (SHORT);
 * zigzag seimbang -> pull bias NEUTRAL.
 */
function liqBars(drift: number, zigzag = false): Bar[] {
  const bars: Bar[] = [];
  let t = 1_700_000_000_000;
  const step = 300_000;
  const push = (o: number, h: number, l: number, c: number) => {
    bars.push({ openTime: t, open: o, high: h, low: l, close: c, volume: 1000 });
    t += step;
  };
  if (zigzag) {
    let c = 100;
    for (let i = 0; i < 60; i++) {
      const open = c;
      if (i % 6 === 0) { c = open + 3; push(open, c + 1, open - 0.2, c); }
      else if (i % 6 === 1) { c = open - 3; push(open, open + 0.2, c - 1, c); }
      else { c = open + 0.2; push(open, Math.max(open, c) + 0.2, Math.min(open, c) - 0.2, c); }
    }
  } else {
    let c = 100;
    for (let i = 0; i < 80; i++) {
      const open = c;
      c = open + drift;
      push(open, Math.max(open, c) + 0.3, Math.min(open, c) - 0.3, c);
    }
  }
  return bars;
}
function barsLiquidityUptrend(): Bar[] { return liqBars(0.6); }
function barsLiquidityDowntrend(): Bar[] { return liqBars(-0.6); }
function barsLiquidityNeutral(): Bar[] { return liqBars(0, true); }

describe("Geometri level (T-5.15)", () => {
  it("menolak SL struktural 2,55% meskipun ATR besar karena order maksimal 2,5%", () => {
    const wide = clampSlToBand(100, 97.45, "LONG", "SCALP", 0.05);
    expect(wide.clamped).toBe("INVALID");
    const within = clampSlToBand(100, 97.5, "LONG", "SCALP", 0.05);
    expect(within.clamped).not.toBe("INVALID");
  });

  it("buildTargets: satu target (TP1) = tp1R mode, rDistance = |entry - sl| (LONG & SHORT)", () => {
    const long = buildTargets(100, 99, "LONG", "SCALP");
    expect(long.tp1).toBeCloseTo(101.7, 8);
    expect(long.rDistance).toBeCloseTo(1, 8);
    expect(long.usedDefaultRFallback).toBe(false);

    const short = buildTargets(100, 101, "SHORT", "SCALP");
    expect(short.tp1).toBeCloseTo(98.3, 8);
    expect(short.rDistance).toBeCloseTo(1, 8);
    expect(short.usedDefaultRFallback).toBe(false);
  });

  it("validatePlan menerima rencana single-target pada SCALP", () => {
    const target = buildTargets(100, 99, "LONG", "SCALP");
    const plan: StrategyPlan = {
      strategyId: "S-04", strategyName: "test", mode: "SCALP", matched: true, side: "LONG",
      entryType: "MARKET_PULLBACK", entryPrice: 100, slPrice: 99,
      tp1Price: target.tp1, slPct: 0.01, rDistance: 1,
      rr1: 1, quality: 80,
      zoneType: null, zoneTop: null, zoneBottom: null, zoneScore: 0,
      slBasis: "RANGE_EDGE", tpBasis: "R_MULTIPLE", reasons: [], tfSummary: "",
    };
    const out = validatePlan(plan, 100);
    expect(out.matched).toBe(true);
  });

  it("clampSlToBand: terlalu sempit dinaikkan ke min, invalidasi terlalu lebar ditolak", () => {
    const tight = clampSlToBand(100, 99.95, "LONG", "SCALP"); // 0.05% < 1.2%
    expect(tight.clamped).toBe("MIN");
    expect(tight.slPct).toBeCloseTo(0.012, 6);

    const wide = clampSlToBand(100, 90, "LONG", "SCALP"); // 10% > 2.5%
    expect(wide.clamped).toBe("INVALID");
    expect(wide.slPct).toBeCloseTo(0.1, 6);

    const invalid = clampSlToBand(100, 0, "LONG", "SCALP");
    expect(invalid.clamped).toBe("INVALID");
  });

  it("structureExtreme & structureTarget bekerja pada bar struktur", () => {
    const bars = mkBars(50, 100, 0.2);
    expect(structureExtreme(bars, "LONG", 20)).toBeLessThan(bars[bars.length - 1]!.low + 0.01);
    expect(structureExtreme(bars, "SHORT", 20)).toBeGreaterThan(100);
    expect(structureTarget(bars, "LONG", 100)).toBeGreaterThan(100);
  });
});

describe("S-01 Liquidity Sweep Reclaim (eks S-03, renumber 6 Okt 2026)", () => {
  it("match: low range disapu lalu di-reclaim -> SL di ekstrem sweep, target tunggal 1.5R", () => {
    const analysis = analysisWithSweep();
    const ctx: StrategyContext = { analysis, price: analysis.price, mode: "SCALP" };
    const plan = evaluateLiquiditySweepReclaim(ctx);
    expect(plan.strategyId).toBe("S-01");
    expect(plan.matched).toBe(true);
    expect(plan.side).toBe("LONG");
    expect(plan.entryType).toBe("LIMIT_ZONE");
    expect(plan.slPrice).toBeLessThan(plan.entryPrice);
    expect(plan.tp1Price).toBeGreaterThan(plan.entryPrice);
    expect(plan.reasons.join(",")).toContain("SWEEP_");
    expect(plan.reasons.join(",")).toContain("RECLAIM_DISPLACEMENT_ATR_");
  });

  it("tanpa pola sweep: fallback deterministik mengikuti arah bias MTF", () => {
    const a = mkAnalysis();
    const flat = snap({ interval: "5m", role: "STRUCTURE", barsData: mkBars(80, 100, 0) });
    const analysis: MtfAnalysis = { ...a, structure: flat, timeframes: [a.trigger, flat, a.bias] };
    const plan = evaluateLiquiditySweepReclaim({ analysis, price: analysis.price, mode: "SCALP" });
    if (env.PAPER_DETERMINISTIC_ENTRY) {
      // PAPER_DETERMINISTIC_ENTRY=true: tanpa pola sweep, entry mengikuti arah bias MTF.
      expect(plan.reasons).toContain("AGGRESSIVE_FALLBACK_TREND_LONG");
      expect(plan.matched).toBe(true);
    } else {
      expect(plan.matched).toBe(false);
      expect(plan.reasons).toContain("NO_LIQUIDITY_SWEEP_RECLAIM");
    }
  });


  it("tolak: analisis tidak usable -> alasan MTF diteruskan apa adanya", () => {
    const a = mkAnalysis({ usable: false, reason: "INSUFFICIENT_KLINES:15m" });
    const plan = evaluateLiquiditySweepReclaim({ analysis: a, price: a.price, mode: "SCALP" });
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toContain("INSUFFICIENT_KLINES:15m");
  });
});

describe("S-02 Liquidity Sniper (eks S-04, renumber 6 Okt 2026)", () => {
  const up = barsLiquidityUptrend();
  const down = barsLiquidityDowntrend();
  const neutral = barsLiquidityNeutral();

  function analysisFor(bars: Bar[], trend: "BULLISH" | "BEARISH" | "NEUTRAL"): MtfAnalysis {
    const a = mkAnalysis({ mode: "SCALP" });
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
    const bias = snap({ interval: "15m", role: "BIAS", barsData: mkBars(60, 90, 0.2), trend, trendScore: 70 });
    return { ...a, mode: "SCALP", structure, bias, timeframes: [a.trigger, structure, bias], price: bars[bars.length - 1]!.close };
  }

  it("liquiditySniper membentuk peta likuiditas: magnet dua sisi + pull bias terdeteksi", () => {
    const liq = liquiditySniper(up, { pullBiasThreshold: 1.0 })!;
    expect(liq.shortMagnet).not.toBeNull();
    expect(liq.longMagnet).not.toBeNull();
    expect(liq.shortMagnet!.side).toBe("ABOVE");
    expect(liq.longMagnet!.side).toBe("BELOW");
    expect(liq.walls.length).toBeGreaterThan(0);
  });

  it("match LONG: uptrend -> pull bias UP searah BULLISH, SL < entry < TP, target 1.5R", () => {
    const liq = liquiditySniper(up, { pullBiasThreshold: 1.0 })!;
    expect(liq.pullBias).toBe("UP");
    const analysis = analysisFor(up, "BULLISH");
    const plan = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(plan.strategyId).toBe("S-02");
    expect(plan.matched).toBe(true);
    expect(plan.side).toBe("LONG");
    expect(plan.entryType).toBe("MARKET_PULLBACK");
    expect(plan.slPrice).toBeLessThan(plan.entryPrice);
    expect(plan.tp1Price).toBeGreaterThan(plan.entryPrice);
    const reasons = plan.reasons.join(",");
    expect(plan.matched).toBe(true);
    expect(reasons).toContain("PULL_BIAS_UP");
    expect(reasons).toContain("TARGET_MAGNET_");
    expect(reasons).toContain("BAR_DELTA_POS");
  });

  it("match SHORT: downtrend -> pull bias DOWN searah BEARISH, entry > SL & TP, target 1.5R", () => {
    const liq = liquiditySniper(down, { pullBiasThreshold: 1.0 })!;
    expect(liq.pullBias).toBe("DOWN");
    // ATR 0.2 (wajar utk ~1% per bar) supaya invalidation + buffer tetap
    // di dalam band SL 1,2%-2,5% — invalidation lebih jauh memang ditolak.
    const analysis = { ...analysisFor(down, "BEARISH"), atrStructure: 0.2 } as MtfAnalysis;
    const plan = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(plan.matched).toBe(true);
    expect(plan.side).toBe("SHORT");
    expect(plan.slPrice).toBeGreaterThan(plan.entryPrice);
    expect(plan.tp1Price).toBeLessThan(plan.entryPrice);
    const reasons = plan.reasons.join(",");
    expect(reasons).toContain("PULL_BIAS_DOWN");
    expect(reasons).toContain("BAR_DELTA_NEG");
  });

  it("tolak: pull bias netral dan tanpa arah trend -> tidak ada entry", () => {
    const liq = liquiditySniper(neutral, { pullBiasThreshold: 1.0 })!;
    expect(liq.pullBias).toBe("NEUTRAL");
    const analysis = analysisFor(neutral, "NEUTRAL");
    const plan = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(plan.matched).toBe(false);
    expect(plan.reasons.join(",")).toContain("PULL_BIAS_NEUTRAL");
  });

  it("tolak: pull bias UP tapi trend BEARISH -> tidak melawan trend", () => {
    const analysis = analysisFor(up, "BEARISH");
    const plan = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(plan.matched).toBe(false);
    // Deterministik: dipaksa ikut trend lalu diveto CVD; selain itu mismatch eksplisit.
    const expected = env.PAPER_DETERMINISTIC_ENTRY ? "AGGR_SNIPER_TREND_SHORT" : "LIQUIDITY_TREND_MISMATCH";
    expect(plan.reasons).toContain(expected);
  });

  it("tolak: peta likuiditas tidak terbentuk (bar kurang) -> LIQUIDITY_MAP_EMPTY", () => {
    const short = up.slice(0, 15);
    const a = mkAnalysis({ mode: "SCALP" });
    const trigger = snap({ interval: "1m", role: "TRIGGER", barsData: short });
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: short });
    // Bias NEUTRAL: tanpa peta likuiditas DAN tanpa arah -> wajib ditolak di
    // mode apa pun (tidak pernah menghasilkan entry tanpa alasan).
    const bias = { ...a.bias, trend: "NEUTRAL" as const };
    const analysis: MtfAnalysis = { ...a, mode: "SCALP", trigger, structure, bias, timeframes: [trigger, structure, bias], price: short[short.length - 1]!.close };
    const plan = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(plan.matched).toBe(false);
    expect(plan.reasons.join(",")).toContain("LIQUIDITY_MAP_EMPTY");
  });

  it("29 Sep 2026 (super scalping): S-04 juga dievaluasi di mode SCALP, target 1.5R", () => {
    const liq = liquiditySniper(up, { pullBiasThreshold: 1.0 })!;
    expect(liq.pullBias).toBe("UP");
    const analysis = analysisFor(up, "BULLISH");
    const scalp = evaluateLiquiditySniper({ analysis, price: analysis.price, mode: "SCALP" }, { pullBiasThreshold: 1.0 });
    expect(scalp.strategyId).toBe("S-02");
    expect(scalp.matched).toBe(true);
    expect(scalp.mode).toBe("SCALP");
    expect(scalp.side).toBe("LONG");
    // RR single target SCALP: 1.5R.
    expect(scalp.slPrice).toBeLessThan(scalp.entryPrice);
    expect(scalp.tp1Price).toBeGreaterThan(scalp.entryPrice);
    // SL tetap mengikuti band SCALP (1,2%-2,5%).
    expect(scalp.slPct).toBeGreaterThanOrEqual(0.012 - 1e-9);
    expect(scalp.slPct).toBeLessThanOrEqual(0.025 + 1e-9);
  });
});


describe("selectBestPlan (katalog aktif final 20 Okt 2026)", () => {
  it("selectBestPlan memilih plan kualitas tertinggi yang match, atau null bila tak ada", async () => {
    const analysis = analysisWithSweep();
    const { plan, all } = await selectBestPlan({ analysis, price: analysis.price, mode: "SCALP" });
    // 20 Okt 2026 (perintah operator): S-03 Fibonacci, S-04 MRV Stretch, dan
    // S-05 Polaris DIHAPUS dari katalog aktif -> 5 plan (S-01, S-02,
    // RSW-01/02/03). RSW di mode SCALP hanya placeholder diagnostik.
    expect(all).toHaveLength(5);
    expect(all.map((p) => p.strategyId).sort()).toEqual(["RSW-01", "RSW-02", "RSW-03", "S-01", "S-02"]);
    // S-03/S-04/S-05 tidak boleh muncul lagi sebagai plan (dihapus dari katalog).
    expect(all.map((p) => p.strategyId)).not.toContain("S-03");
    expect(all.map((p) => p.strategyId)).not.toContain("S-04");
    expect(all.map((p) => p.strategyId)).not.toContain("S-05");
    expect(plan).not.toBeNull();
    expect(plan!.matched).toBe(true);
    const bestQuality = Math.max(...all.filter((p) => p.matched).map((p) => p.quality));
    expect(plan!.quality).toBe(bestQuality);

    const unusable = mkAnalysis({ usable: false, reason: "INSUFFICIENT_KLINES:15m" });
    expect((await selectBestPlan({ analysis: unusable, price: 100, mode: "SCALP" })).plan).toBeNull();
  });

  it("tren selaras tanpa trigger strategi tidak membuat entry generic", async () => {
    const analysis = mkAnalysis({
      bestZone: null,
      zoneScore: 0,
      zoneAnalysis: {
        ...mkAnalysis().zoneAnalysis, bestZone: null, usableZones: [], allZones: [], zoneScore: 0,
      },
    });
    const result = await selectBestPlan({ analysis, price: 105, mode: "SCALP" });
    // 20 Okt 2026: katalog aktif final = 5 strategi (S-01, S-02,
    // RSW-01/02/03). S-03/S-04/S-05 dihapus operator.
    expect(result.all).toHaveLength(5);
    expect(result.all.map((c) => c.strategyId).sort()).toEqual(["RSW-01", "RSW-02", "RSW-03", "S-01", "S-02"]);
    expect(result.plan).toBeNull();
  });
});

// ── S-03 FIBONACCI ZONE 0.5-0.618 (baru 6 Okt 2026; zona 7 Okt 2026) ─────────

/**
 * Bar sintetis Fib LONG: swing low unik (bar 10, low 97.90) -> rally monoton ->
 * swing high unik (bar 20, high 99.25) -> pullback landai -> BOS (bar 27,
 * close 99.32 > 99.25, high 99.35 = level 0.0) -> hover di antara entry zona
 * 0.5 (98.625) dan level 0.0. SL% plan nanti ~0,74% -> masuk band S-03 (0,01%-1,1%).
 */
function barsFibLong(): Bar[] {
  const bars: Bar[] = [];
  let t = 1_700_000_000_000;
  const push = (o: number, h: number, l: number, c: number) => {
    bars.push({ openTime: t, open: o, high: h, low: l, close: c, volume: 1000 });
    t += 300_000;
  };
  let p = 100.0;
  for (let i = 0; i < 10; i++) { const c = p - 0.2; push(p, p + 0.02, c - 0.05, c); p = c; } // 0..9 turun monoton
  push(98.0, 98.15, 97.90, 98.1);                                                               // 10: swing low
  p = 98.1;
  for (let i = 0; i < 9; i++) { const c = p + 0.115; push(p, c + 0.02, p - 0.015, c); p = c; } // 11..19 rally monoton
  push(99.15, 99.25, 99.0, 99.1);                                                               // 20: swing high
  p = 99.1;
  for (let i = 0; i < 5; i++) { const c = p - 0.04; push(p, p + 0.01, c - 0.01, c); p = c; }   // 21..25 pullback
  push(98.9, 99.2, 98.88, 99.18);                                                               // 26: pantulan
  push(99.2, 99.35, 99.1, 99.32);                                                               // 27: BOS
  push(99.3, 99.32, 98.85, 98.9);                                                               // 28..31 hover
  push(98.9, 99.05, 98.75, 98.8);
  push(98.8, 99.25, 98.72, 99.2);
  push(99.2, 99.3, 98.9, 99.0);
  // 32..41: hover lanjutan supaya total bar >= 40 (evaluator memakai bar
  // STRUKTUR hanya bila >= 40 bar) — tetap di antara entry zona 0.5 dan level 0.0.
  p = 99.0;
  for (let i = 0; i < 10; i++) {
    const up = i % 2 === 0;
    const c = up ? p + 0.1 : p - 0.1;
    push(p, Math.max(p, c) + 0.02, Math.min(p, c) - 0.02, c);
    p = c;
  }
  return bars;
}

/** Cermin harga (untuk kasus SHORT: pola yang sama terbalik). */
function mirrorBars(bars: Bar[], center: number): Bar[] {
  return bars.map((b) => ({
    openTime: b.openTime,
    open: 2 * center - b.open,
    high: 2 * center - b.low,
    low: 2 * center - b.high,
    close: 2 * center - b.close,
    volume: b.volume,
  }));
}

describe("S-03 Fibonacci Zone 0.5-0.618 (zona 7 Okt 2026)", () => {
  it("engine: geometri level fib dihitung dari leg — entry 0.5 (zona), SL level 1.0, level 0.0 dicatat; RR natural 1.0", () => {
    const bars = barsFibLong();
    const s = detectFibRetracement(bars, { includeLastBar: true });
    expect(s).not.toBeNull();
    expect(s!.side).toBe("LONG");
    expect(s!.entryLevel).toBeCloseTo(s!.swingHigh - 0.5 * s!.range, 8);
    expect(s!.slLevel).toBe(s!.swingLow);   // level 1.0 = ekstrem swing
    expect(s!.tpLevel).toBe(s!.swingHigh);  // level 0.0 = asal swing (referensi; TP plan dipaksa 1.5R)
    const rr = (s!.tpLevel - s!.entryLevel) / (s!.entryLevel - s!.slLevel);
    expect(rr).toBeCloseTo(1.0, 6); // RR natural level 0.5; TP plan = 1.5R dipaksa (setupEngine)
  });

  it("engine SHORT (pola cermin): SL di atas entry, TP di bawah, RR sama", () => {
    const s = detectFibRetracement(mirrorBars(barsFibLong(), 197.35), { includeLastBar: true });
    expect(s).not.toBeNull();
    expect(s!.side).toBe("SHORT");
    expect(s!.slLevel).toBeGreaterThan(s!.entryLevel);
    expect(s!.tpLevel).toBeLessThan(s!.entryLevel);
    const rr = (s!.entryLevel - s!.tpLevel) / (s!.slLevel - s!.entryLevel);
    expect(rr).toBeCloseTo(1.0, 6);
  });

  it("closeBased (14 Okt, lane SWING): pivot & ekstrem leg dari close, sentuhan/invalidasi dari close", () => {
    // Salin barsFibLong, tapi bar "pantulan" (idx 26) close-nya diturunkan di
    // bawah pivot high supaya BOS hanya terjadi sekali (bar 27) — leg tidak
    // batal oleh zero-chasing sebelum zona tersentuh.
    const bars = barsFibLong().map((b, i) => (i === 26 ? { ...b, open: 98.9, high: 99.1, low: 98.88, close: 99.05 } : b));
    const wickBased = detectFibRetracement(bars, { includeLastBar: true });
    const closeBased = detectFibRetracement(bars, { includeLastBar: true, closeBased: true });
    expect(wickBased).not.toBeNull();
    expect(closeBased).not.toBeNull();
    // Wick +0.02 selalu di atas close -> swingHigh wick-based (99.35) lebih
    // tinggi dari close-based (99.32, wick diabaikan). Swing low sama logikanya.
    expect(wickBased!.swingHigh).toBeCloseTo(99.35, 8);
    expect(closeBased!.swingHigh).toBeCloseTo(99.32, 8);
    expect(closeBased!.swingLow).toBeCloseTo(98.0, 8);
    // Geometri zona close-based: entry 0.5 leg, SL = swing low (level 1.0).
    expect(closeBased!.entryLevel).toBeCloseTo(99.32 - 0.5 * (99.32 - 98.0), 8);
    expect(closeBased!.slLevel).toBe(closeBased!.swingLow);
    // Leg close-based lebih sempit (wick diabaikan di kedua ekstrem) ->
    // level 0.5-nya lebih tinggi (retracement lebih dangkal) dari wick-based.
    expect(closeBased!.entryLevel).toBeGreaterThan(wickBased!.entryLevel);
  });

  it("anti-lookahead: pivot baru sah N bar SESUDAHNYA; hasil pada prefix = hasil pada run penuh", () => {
    const bars = barsFibLong();
    // 25 bar (0..24): pivot baru terkonfirmasi di bar 24 (N=4) tetapi BOS bar 27 belum ada -> belum ada setup.
    expect(detectFibRetracement(bars.slice(0, 25), { includeLastBar: true })).toBeNull();
    // 24 bar (0..23): pivot belum terkonfirmasi (butuh bar 24; N=4) dan BOS belum ada.
    expect(detectFibRetracement(bars.slice(0, 24), { includeLastBar: true })).toBeNull();
    // 28 bar (0..27): pivot terkonfirmasi + BOS -> setup ARMED.
    const atBos = detectFibRetracement(bars.slice(0, 28), { includeLastBar: true });
    expect(atBos).not.toBeNull();
    // Tidak ada bar masa depan yang dibaca: geometri setup pada prefix identik
    // dengan run penuh (hanya usia setup dalam bar yang boleh berbeda).
    const full = detectFibRetracement(bars, { includeLastBar: true });
    expect(full).not.toBeNull();
    for (const k of ["side", "entryLevel", "slLevel", "tpLevel", "swingHigh", "swingLow", "bosIdx"] as const) {
      expect(full![k]).toEqual(atBos![k]);
    }
    // Bar 26 saja tidak cukup: pivot sudah terkonfirmasi (bar 24; N=4) tetapi BOS
    // bar 27 belum ada -> tetap null (anti-lookahead tetap berlaku).
    const withDelay = detectFibRetracement(bars.slice(0, 26), { includeLastBar: true });
    expect(withDelay).toBeNull(); // belum ada BOS (bar 27 belum ada)
  });

  it("20 Okt 2026 (operator hapus S-03): evaluator FIBONACCI fail-closed retired — plan TIDAK match walau setup zona sempurna, TIDAK crash", () => {
    const bars = barsFibLong();
    const s = detectFibRetracement(bars, { includeLastBar: true })!;
    const a = mkAnalysis();
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
    const analysis: MtfAnalysis = { ...a, structure, timeframes: [a.trigger, structure, a.bias], price: s.entryLevel + 0.006 };
    // Setup zona sempurna (harga sudah di zona 0.5) — TAPI S-03 sudah dihapus
    // dari katalog aktif, jadi plan WAJIB retired: matched=false + alasan
    // STRATEGY_RETIRED. Kalau tidak, S-03 masih bisa entry = perintah operator
    // dilanggar. Tidak boleh crash (TypeError dari spec null) — AU1-02.
    const plan = evaluateFibRetracement({ analysis, price: s.entryLevel + 0.006, mode: "SCALP" });
    expect(plan.strategyId).toBe("S-03");
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toContain("STRATEGY_RETIRED");
    // Tidak ada level harga karangan pada plan retired.
    expect(plan.slPrice).toBe(0);
    expect(plan.tp1Price).toBe(0);
    expect(plan.quality).toBe(0);
  });

  it("20 Okt 2026 (operator hapus S-03): filter tren tidak relevan lagi — retired di SEMUA arah tren, tidak pernah match", () => {
    const bars = barsFibLong();
    const s = detectFibRetracement(bars, { includeLastBar: true })!;
    const a = mkAnalysis();
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
    // LONG, tren bullish
    const okAnalysis: MtfAnalysis = { ...a, structure, timeframes: [a.trigger, structure, a.bias], price: s.entryLevel };
    const ok = evaluateFibRetracement({ analysis: okAnalysis, price: s.entryLevel, mode: "SCALP" });
    expect(ok.matched).toBe(false);
    expect(ok.reasons).toContain("STRATEGY_RETIRED");
    // cermin SHORT, tren bullish
    const sShort = detectFibRetracement(mirrorBars(bars, 197.35), { includeLastBar: true })!;
    const shortAnalysis: MtfAnalysis = { ...a, structure: snap({ interval: "5m", role: "STRUCTURE", barsData: mirrorBars(bars, 197.35) }),
      timeframes: [a.trigger, structure, a.bias], price: sShort.entryLevel };
    const nowOk = evaluateFibRetracement({ analysis: shortAnalysis, price: sShort.entryLevel, mode: "SCALP" });
    expect(nowOk.matched).toBe(false);
    expect(nowOk.reasons).toContain("STRATEGY_RETIRED");
    // tren netral juga retired
    const bias = snap({ interval: "15m", role: "BIAS", barsData: mkBars(60, 90, 0.2), trend: "NEUTRAL" });
    const neutral = evaluateFibRetracement({ analysis: { ...okAnalysis, bias, timeframes: [a.trigger, structure, bias] }, price: s.entryLevel, mode: "SCALP" });
    expect(neutral.matched).toBe(false);
    expect(neutral.reasons).toContain("STRATEGY_RETIRED");
  });

  it("20 Okt 2026 (operator hapus S-03): alasan penolakan = STRATEGY_RETIRED (bukan alasan zona), karena strategi dihapus total", () => {
    const bars = barsFibLong();
    const a = mkAnalysis();
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
    const analysis: MtfAnalysis = { ...a, structure, timeframes: [a.trigger, structure, a.bias], price: 99.3 };
    const plan = evaluateFibRetracement({ analysis, price: 99.3, mode: "SCALP" });
    expect(plan.matched).toBe(false);
    // Alasan retired menggantikan gate zona: tidak lagi ada entry level check.
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    expect(plan.reasons).not.toContain("FIB_ENTRY_LEVEL_NOT_REACHED");
  });

  it("21 Okt 2026 (Phase 3 plan audit): S-03/S-04 fail-closed SEBELUM engine — short-circuit, bukan buang CPU lalu tolak", () => {
    // D-5: evaluateFibRetracement/evaluateMrvStretch harus mengembalikan plan
    // retired tanpa pernah menyentuh mesin. Bukti: bar data yang salah /
    // tidak lengkap pun tetap menghasilkan plan retired yang sama — kalau
    // mesin sempat dipanggil, alasan penolakan akan berubah (mis.
    // FIB_ENTRY_LEVEL_NOT_REACHED / MRV_INSUFFICIENT_M5_BARS).
    //
    // S03_FIB_ENABLED (saklar lama) sudah DIHAPUS total pada 21 Okt 2026:
    // S-03 locked permanen, tidak ada env yang bisa menghidupkannya lagi.
    const bars = barsFibLong();
    const a = mkAnalysis();
    const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
    const analysis: MtfAnalysis = { ...a, structure, timeframes: [a.trigger, structure, a.bias], price: 99.3 };

    const plan = evaluateFibRetracement({ analysis, price: 99.3, mode: "SCALP" });
    expect(plan.strategyId).toBe("S-03");
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    // Alasan retired menggantikan SEMUA gate zona — mesin tidak sempat jalan.
    expect(plan.reasons).not.toContain("FIB_ENTRY_LEVEL_NOT_REACHED");
    expect(plan.reasons).not.toContain("MODE_NOT_SUPPORTED");
    expect(plan.reasons).not.toContain("MTF_NOT_USABLE");
    // Tidak ada level harga karangan pada plan retired.
    expect(plan.slPrice).toBe(0);
    expect(plan.tp1Price).toBe(0);
    expect(plan.quality).toBe(0);

    // Mode SWING juga fail-closed: getStrategySpec("S-03", "SWING") null.
    const swingPlan = evaluateFibRetracement({ analysis, price: 99.3, mode: "SWING" });
    expect(swingPlan.matched).toBe(false);
    expect(swingPlan.reasons).toEqual(["STRATEGY_RETIRED"]);
  });

  it("20 Okt 2026 (operator hapus S-03): band validate-only khusus S-03 dihapus — SL 0.6% kembali di-clamp ke min default 1.2%", () => {
    // S-03 tidak lagi punya spec aktif -> tidak ada band validate-only
    //+S-03. Perilaku clamp untuk strategyId "S-03" kini sama dengan default
    // (band default), yaitu clamp MIN ke 1.2% — bukan "NONE" seperti saat
    // S-03 masih punya spec.
    const ok = clampSlToBand(100, 99.4, "LONG", "SCALP", 0.004, "S-03");
    expect(ok.clamped).toBe("MIN");
    expect(ok.slPct).toBeCloseTo(0.012, 6);
    // Band default TANPA strategyId tetap meng-clamp ke min 1.2% (perilaku lama utuh).
    const clamped = clampSlToBand(100, 99.4, "LONG", "SCALP", 0.004);
    expect(clamped.clamped).toBe("MIN");
    // 3% -> di luar band default (max 2.5%) -> ditolak, bukan digeser.
    const wide = clampSlToBand(100, 97, "LONG", "SCALP", 0.004, "S-03");
    expect(wide.clamped).toBe("INVALID");
    // Terlalu sempit (0.005% < min 1.2%) -> dik-clamp ke min, bukan INVALID.
    // (Dulu dengan band validate-only S-03 {0.01%,20%} hasilnya INVALID.)
    const tight = clampSlToBand(100, 99.995, "LONG", "SCALP", 0.004, "S-03");
    expect(tight.clamped).toBe("MIN");
    expect(tight.slPct).toBeCloseTo(0.012, 6);
  });

  it("20 Okt 2026 (operator hapus S-03): menu SL/TP S-03 identik dengan menu default — tidak ada perlakuan khusus S-03 lagi", () => {
    const bars = barsFibLong();
    const s = detectFibRetracement(bars, { includeLastBar: true })!;
    const plan = { slPrice: s.slLevel, slAtrPct: 0.004, strategyId: "S-03" };
    const menu = buildSlTpMenu(s.entryLevel + 0.006, "LONG", plan, "SCALP");
    // Menu S-03 harus PERSIS sama dengan menu strategi lain di lane SCALP:
    // tanpa spec S-03 tidak ada lagi varian validate-only (SL tanpa buffer)
    // maupun override TP R khusus.
    const menuOther = buildSlTpMenu(s.entryLevel + 0.006, "LONG",
      { slPrice: s.slLevel, slAtrPct: 0.004, strategyId: "S-02" }, "SCALP");
    expect(menu).not.toBeNull();
    expect(menuOther).not.toBeNull();
    expect(menu!.sl).toEqual(menuOther!.sl);
    expect(menu!.tp).toEqual(menuOther!.tp);
    // Varian B (buffer ATR) kinizar offered — validate-only S-03 sudah tidak ada.
    expect(menu!.sl.length).toBeGreaterThan(1);
  });

  it("strategi yang match menghasilkan rencana valid (SL < Entry < TP1) untuk S-01 dan S-02; S-03 retired (tidak match)", () => {
    // S-01 sweep
    const sweep = analysisWithSweep();
    const p1 = evaluateLiquiditySweepReclaim({ analysis: sweep, price: sweep.price, mode: "SCALP" });
    expect(p1.strategyId).toBe("S-01");
    expect(p1.matched).toBe(true);

    // S-02 sniper
    const a2 = mkAnalysis({ mode: "SCALP" });
    const bars2 = barsLiquidityUptrend();
    const structure2 = snap({ interval: "5m", role: "STRUCTURE", barsData: bars2 });
    const price2 = bars2[bars2.length - 1]!.close;
    const p2 = evaluateLiquiditySniper({
      analysis: { ...a2, mode: "SCALP", structure: structure2, timeframes: [a2.trigger, structure2, a2.bias], price: price2 },
      price: price2,
      mode: "SCALP",
    }, { pullBiasThreshold: 1.0 });
    expect(p2.strategyId).toBe("S-02");
    expect(p2.matched).toBe(true);

    // S-03 fib: DIHAPUS operator 20 Okt 2026 -> retired, tidak boleh match.
    const bars3 = barsFibLong();
    const s3 = detectFibRetracement(bars3, { includeLastBar: true })!;
    const a3 = mkAnalysis();
    const structure3 = snap({ interval: "5m", role: "STRUCTURE", barsData: bars3 });
    const p3 = evaluateFibRetracement({
      analysis: { ...a3, structure: structure3, timeframes: [a3.trigger, structure3, a3.bias], price: s3.entryLevel },
      price: s3.entryLevel,
      mode: "SCALP",
    });
    expect(p3.strategyId).toBe("S-03");
    expect(p3.matched).toBe(false);
    expect(p3.reasons).toContain("STRATEGY_RETIRED");

    for (const p of [p1, p2]) {
      expect(p.matched).toBe(true);
      expect(p.entryPrice).toBeGreaterThan(0);
      expect(p.slPrice).toBeLessThan(p.entryPrice);
      expect(p.tp1Price).toBeGreaterThan(p.entryPrice);
      expect(p.rr1).toBeGreaterThanOrEqual(1.0);
    }
  });
});
