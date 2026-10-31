// apps/server/tests/mrvStretchEngine.test.ts
// TEST PENERIMAAN S-04 (spek docs/S-04-mrv-stretch-trend-gate.md, §7 subset):
//   [x] anti-repaint D_CLOSE/D_EMA50: 0 perubahan intra-hari; hari berjalan
//       TIDAK PERNAH dipakai (baik dari agregasi 5m maupun klines 1d).
//   [x] syarat entry (spek §2) pada bar sintetis — LONG & SHORT, tiap kondisi
//       dimatikan satu per satu (harus tepat satu kondisi yang gagal).
//   [x] TIDAK ADA syarat jam/menit/kalender di gate (uji perilaku: geser
//       timestamp = hasil identik, termasuk weekend; + audit statis sumber).
//   [x] invarian sl < entry < tp untuk kedua sisi (jalur plan ArtaTrade:
//       clampSlToBand validate-only + buildTargets + validatePlan).
//   [x] satu posisi dalam satu waktu (no pyramiding) + fill entry = open bar
//       berikutnya; harga exit berada di dalam range bar exit-nya.
//   [x] bar ambigu (SL & TP tersentuh pada bar yang sama) -> DUA kasus
//       (sl_first + tp_first, spek §4).
// TIDAK diuji di sini (divalidasi EKSTERNAL terhadap dataset 709.920 bar):
//   reproduksi baris n/WR/PF §5, PF teoritis == terukur, sum(pnl) == gross.
// FEE_RATE = 0 adalah aturan operator — tidak ada biaya yang masuk gate.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Bar } from "../src/universe/eligibility.js";
import type { MtfAnalysis, TfSnapshot } from "../src/engines/multiTimeframeAnalyzer.js";
import {
  evaluateMrvStretchGate,
  resolveDailyHtf,
  scanMrvStretch,
  MRV_DAY_MS,
  MRV_K,
  MRV_SL_R,
  MRV_TP_R,
} from "../src/engines/mrvStretchEngine.js";
import { rsi, rsiSeries } from "../src/engines/indicatorLibrary.js";
import {
  buildStrategyPlans,
  evaluateMrvStretch,
  type StrategyContext,
} from "../src/strategies/setupStrategies.js";

const IV = 300_000;

// ── Builder bar sintetis ─────────────────────────────────────────────────────

interface SeriesOpts {
  n: number;
  slope: number;
  t0: number;
  crash?: { at: number; drops: number[] };
  wick?: number;
}

/** Deret 5m: naik monoton `slope` per bar; `crash.drops` menimpa delta di bar tsb. */
function mkSeries(opts: SeriesOpts): Bar[] {
  const bars: Bar[] = [];
  let c = 100;
  for (let i = 0; i < opts.n; i++) {
    const open = c;
    let close = open + opts.slope;
    if (opts.crash && i >= opts.crash.at && i - opts.crash.at < opts.crash.drops.length) {
      close = open + opts.crash.drops[i - opts.crash.at]!;
    }
    const w = opts.wick ?? 0.01;
    bars.push({
      openTime: opts.t0 + i * IV,
      open,
      high: Math.max(open, close) + w,
      low: Math.min(open, close) - w,
      close,
      volume: 1000,
    });
    c = close;
  }
  return bars;
}

/** Bar harian UTC midnight-anchored; `trend` > 0 = D_CLOSE > D_EMA50. */
function mkDaily(n: number, trend: number, t0 = 0): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const open = 100 + k * trend;
    out.push({
      openTime: t0 + k * MRV_DAY_MS,
      open,
      high: open + trend,
      low: open - Math.abs(trend) - 0.1,
      close: open + trend,
      volume: 1000,
    });
  }
  return out;
}

/** Cermin harga (kasus SHORT = pola LONG terbalik). */
const mirror = (center: number) => (b: Bar): Bar => ({
  openTime: b.openTime,
  open: center * 2 - b.open,
  high: center * 2 - b.low,
  low: center * 2 - b.high,
  close: center * 2 - b.close,
  volume: b.volume,
});

const T0 = 60 * MRV_DAY_MS; // m5 mulai SETELAH 60 hari harian -> semua hari sudah tutup
const LONG_DAILY = () => mkDaily(60, 0.6);
/** Pola LONG bekerja: uptrend 0.03/bar, crash [-1.2, -0.9] di bar 230..231. */
const longBars = () => mkSeries({ n: 232, slope: 0.03, t0: T0, crash: { at: 230, drops: [-1.2, -0.9] } });

function gateOver(bars: Bar[], daily?: Bar[], nowMs?: number) {
  return evaluateMrvStretchGate({ m5Bars: bars, dailyBars: daily, nowMs, includeLastBar: true });
}

const longFailCodes = (reasons: string[]) => reasons.filter((r) => r.startsWith("MRV_LONG_") && r.endsWith("_FAIL"));

// ── 1. Kondisi entry (spek §2) ──────────────────────────────────────────────

describe("S-04 gate entry (spek §2) — kondisi pada bar sintetis", () => {
  it("LONG: stretch + RSI2<15 + close>EMA200 + D_CLOSE>D_EMA50 -> sinyal LONG", () => {
    const g = gateOver(longBars(), LONG_DAILY());
    expect(g.signal).toBe("LONG");
    expect(g.rsi2!).toBeLessThan(15);
    expect(g.close!).toBeLessThan(g.ema40! - 0.5 * g.atr14!); // stretch 0.5*ATR14
    expect(g.close!).toBeGreaterThan(g.ema200!);
    expect(g.htf!.dClose).toBeGreaterThan(g.htf!.dEma50);
    expect(g.reasons[0]).toBe("MRV_LONG");
  });

  it("SHORT (pola cermin): keempat kondisi terbalik -> sinyal SHORT", () => {
    const g = gateOver(longBars().map(mirror(207)), LONG_DAILY().map(mirror(207)));
    expect(g.signal).toBe("SHORT");
    expect(g.rsi2!).toBeGreaterThan(85);
    expect(g.close!).toBeGreaterThan(g.ema40! + 0.5 * g.atr14!);
    expect(g.close!).toBeLessThan(g.ema200!);
    expect(g.htf!.dClose).toBeLessThan(g.htf!.dEma50);
    expect(g.reasons[0]).toBe("MRV_SHORT");
  });

  it("D (HTF) gagal: D_CLOSE<D_EMA50 -> tolak; tepat satu kondisi LONG yang gagal", () => {
    const g = gateOver(longBars(), mkDaily(60, -0.6));
    expect(g.signal).toBeNull();
    expect(longFailCodes(g.reasons)).toEqual(["MRV_LONG_HTF_FAIL"]);
  });

  it("C (trend) gagal: close<EMA200 (crash terlalu dalam) -> tolak; hanya EMA200 yang gagal", () => {
    const deep = mkSeries({ n: 232, slope: 0.03, t0: T0, crash: { at: 230, drops: [-4.5, -3.5] } });
    const g = gateOver(deep, LONG_DAILY());
    expect(g.signal).toBeNull();
    expect(longFailCodes(g.reasons)).toEqual(["MRV_LONG_EMA200_FAIL"]);
  });

  it("B (RSI) gagal: stretch tercapai tapi RSI2 >= 15 (dip diselingi bar hijau) -> tolak; hanya RSI yang gagal", () => {
    // [-1.0, +0.95, -1.3]: kedalaman cukup untuk stretch, tapi RSI2 ~ 24.
    const wobble = mkSeries({ n: 233, slope: 0.03, t0: T0, crash: { at: 230, drops: [-1.0, 0.95, -1.3] } });
    const g = gateOver(wobble, LONG_DAILY());
    expect(g.signal).toBeNull();
    expect(longFailCodes(g.reasons)).toEqual(["MRV_LONG_RSI_FAIL"]);
  });

  it("A (stretch) gagal: RSI2 ekstrem tapi harga belum 0.5*ATR di bawah EMA40 -> tolak; hanya stretch yang gagal", () => {
    // Kecil turun (-0.2, -0.15) dengan wick besar (ATR ~3.8): RSI2 ~ 6, stretch tidak tercapai.
    const shallow = mkSeries({ n: 232, slope: 0.03, t0: T0, crash: { at: 230, drops: [-0.2, -0.15] }, wick: 1.9 });
    const g = gateOver(shallow, LONG_DAILY());
    expect(g.signal).toBeNull();
    expect(longFailCodes(g.reasons)).toEqual(["MRV_LONG_STRETCH_FAIL"]);
  });

  it("SHORT: setiap kondisi punya kode gagalnya sendiri (cermin dari kasus LONG)", () => {
    const fail = (bars: Bar[], daily: Bar[]) =>
      gateOver(bars.map(mirror(207)), daily.map(mirror(207))).reasons.filter(
        (r) => r.startsWith("MRV_SHORT_") && r.endsWith("_FAIL")
      );
    expect(fail(longBars(), mkDaily(60, -0.6))).toEqual(["MRV_SHORT_HTF_FAIL"]);
    expect(fail(mkSeries({ n: 232, slope: 0.03, t0: T0, crash: { at: 230, drops: [-4.5, -3.5] } }), LONG_DAILY())).toEqual(["MRV_SHORT_EMA200_FAIL"]);
    expect(fail(mkSeries({ n: 233, slope: 0.03, t0: T0, crash: { at: 230, drops: [-1.0, 0.95, -1.3] } }), LONG_DAILY())).toEqual(["MRV_SHORT_RSI_FAIL"]);
    expect(fail(mkSeries({ n: 232, slope: 0.03, t0: T0, crash: { at: 230, drops: [-0.2, -0.15] }, wick: 1.9 }), LONG_DAILY())).toEqual(["MRV_SHORT_STRETCH_FAIL"]);
  });

  it("gagal tertutup saat data kurang: bar 5m < 200 atau hari lengkap < 50", () => {
    const short = gateOver(mkSeries({ n: 100, slope: 0.03, t0: T0, crash: { at: 98, drops: [-1.2, -0.9] } }), LONG_DAILY());
    expect(short.signal).toBeNull();
    expect(short.reasons).toContain("MRV_INSUFFICIENT_M5_BARS");

    const fewDays = gateOver(longBars(), mkDaily(20, 0.6));
    expect(fewDays.signal).toBeNull();
    expect(fewDays.reasons).toContain("MRV_INSUFFICIENT_DAILY_BARS");
  });
});

// ── 2. Anti-repaint HTF (spek §1, §7 butir 1) ───────────────────────────────

describe("anti-repaint D_CLOSE/D_EMA50 (spek §1)", () => {
  it("0 perubahan intra-hari: hari berjalan TIDAK dipakai meski bar-hari sudah lengkap di data", () => {
    // 57 hari lengkap (288 bar/hari). Saat evaluasi berada DI DALAM hari ke-56,
    // hari itu sudah "lengkap" di array (backtest hindsight) tetapi WAJIB diabaikan.
    const perDay = 288;
    const bars: Bar[] = [];
    let c = 100;
    let t = 0;
    for (let i = 0; i < 57 * perDay; i++) {
      const open = c;
      const close = open + 0.05;
      bars.push({ openTime: t, open, high: close + 0.01, low: open - 0.01, close, volume: 1000 });
      t += IV;
      c = close;
    }
    const probes = [60_000, 12 * 3_600_000, 23 * 3_600_000 + 59 * 60_000].map(
      (off) => resolveDailyHtf({ m5Bars: bars, nowMs: 56 * MRV_DAY_MS + off }).htf
    );
    for (const htf of probes) {
      expect(htf).not.toBeNull();
      expect(htf!).toEqual(probes[0]!); // 0 perubahan intra-hari
      expect(htf!.closedDays).toBe(56); // hari ke-56 belum tutup
    }
    // Setelah hari ke-56 tutup, nilainya BARU boleh berubah.
    const after = resolveDailyHtf({ m5Bars: bars, nowMs: 57 * MRV_DAY_MS }).htf!;
    expect(after.closedDays).toBe(57);
    expect(after.dClose).not.toBe(probes[0]!.dClose);
  });

  it("klines 1d: candle harian yang sedang berjalan diabaikan apa pun close-nya", () => {
    const closed = mkDaily(60, 0.6); // hari 0..59
    const formingA: Bar = { openTime: 60 * MRV_DAY_MS, open: 136, high: 140, low: 135, close: 139, volume: 1 };
    const formingB: Bar = { ...formingA, close: 200, high: 205 }; // perubahan liar intra-hari
    const now = 60 * MRV_DAY_MS + 12 * 3_600_000;
    const a = resolveDailyHtf({ m5Bars: [], dailyBars: [...closed, formingA], nowMs: now }).htf!;
    const b = resolveDailyHtf({ m5Bars: [], dailyBars: [...closed, formingB], nowMs: now }).htf!;
    expect(a).toEqual(b);
    expect(a.dClose).toBe(closed[closed.length - 1]!.close); // hari terakhir yang SUDAH tutup
    expect(a.dClose).not.toBe(formingA.close);
  });
});

// ── 3. Tanpa syarat jam/menit/kalender (spek §3, §7 butir 2) ────────────────

describe("tanpa syarat jam/menit/kalender dalam gate (spek §3)", () => {
  const base = () => gateOver(longBars(), LONG_DAILY(), 65 * MRV_DAY_MS);
  const signature = (g: ReturnType<typeof evaluateMrvStretchGate>) =>
    JSON.stringify({ s: g.signal, r: g.reasons, c: g.close, f: g.ema40, w: g.ema200, i: g.rsi2, a: g.atr14, h: g.htf });

  it("menggeser jam bar 5m (+1j, +7j) tidak mengubah hasil — tidak ada filter jam", () => {
    const shift = (ms: number) =>
      evaluateMrvStretchGate({
        m5Bars: longBars().map((b) => ({ ...b, openTime: b.openTime + ms })),
        dailyBars: LONG_DAILY(),
        nowMs: 65 * MRV_DAY_MS,
        includeLastBar: true,
      });
    expect(signature(base())).toBe(signature(shift(3_600_000)));
    expect(signature(base())).toBe(signature(shift(7 * 3_600_000)));
    expect(base().signal).toBe("LONG");
  });

  it("menggeser kalender (+1 hari, +3 hari, +10 hari termasuk weekend) tidak mengubah hasil", () => {
    for (const days of [1, 3, 10, 20]) {
      const d = days * MRV_DAY_MS;
      const g = evaluateMrvStretchGate({
        m5Bars: longBars().map((b) => ({ ...b, openTime: b.openTime + d })),
        dailyBars: LONG_DAILY().map((b) => ({ ...b, openTime: b.openTime + d })),
        nowMs: 65 * MRV_DAY_MS + d,
        includeLastBar: true,
      });
      expect(signature(g)).toBe(signature(base()));
    }
  });

  it("sinyal yang sama saat seri jatuh di hari weekend (Sabtu/Minggu) — 24/7", () => {
    // Geser agar bar sinyal jatuh pada hari Sabtu/Minggu (dicek via getUTCDay
    // di test — kalender hanya boleh dibaca di sini, TIDAK di gate).
    const weekendShift = 5 * MRV_DAY_MS;
    const shifted = longBars().map((b) => ({ ...b, openTime: b.openTime + weekendShift }));
    const signalAt = shifted[shifted.length - 1]!.openTime;
    expect([0, 6]).toContain(new Date(signalAt).getUTCDay()); // Sabtu/Minggu
    const weekday = signature(base());
    const weekend = signature(evaluateMrvStretchGate({
      m5Bars: shifted,
      dailyBars: LONG_DAILY().map((b) => ({ ...b, openTime: b.openTime + weekendShift })),
      nowMs: 65 * MRV_DAY_MS + weekendShift,
      includeLastBar: true,
    }));
    expect(weekend).toBe(weekday);
  });

  it("audit statis: engine tidak membaca jam/hari/kalender Date sama sekali", () => {
    const src = readFileSync(new URL("../src/engines/mrvStretchEngine.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new Date|Date\.(now|parse)|\.get(Day|Hours|Month|Date|FullYear|UTC)/);
  });
});

// ── 4. Scan: satu posisi, fill next-bar-open, exit dalam range bar (§3-§4) ──

/** Skenario dua setup: crash -> hold lama (sinyal-sinyal diabaikan) -> crash lagi. */
function twoSetupSeries(): Bar[] {
  const bars: Bar[] = [];
  let c = 100;
  let t = T0;
  const push = (delta: number, hi: number, lo: number) => {
    const o = c;
    const cl = o + delta;
    bars.push({ openTime: t, open: o, high: Math.max(o, cl) + hi, low: Math.min(o, cl) - lo, close: cl, volume: 1000 });
    t += IV;
    c = cl;
  };
  for (let i = 0; i < 220; i++) push(0.03, 0.01, 0.01);                     // uptrend
  for (const d of [0.4, -0.35, 0.45, -0.4, 0.35, -0.3, 0.4, -0.35, 0.3, -0.25]) push(d, 1.2, 1.2); // vol -> ATR besar
  push(-1.2, 0.05, 0.1); push(-0.9, 0.05, 0.1);                              // crash 1 -> sinyal
  for (let i = 0; i < 7; i++) push(-0.05, 0.25, 0.25);                       // drift (posisi terbuka)
  push(-0.35, 0.15, 0.15); push(-0.3, 0.15, 0.15);                           // sinyal saat posisi masih buka
  for (let i = 0; i < 24; i++) push(0.15, 0.1, 0.1);                         // rally -> TP
  push(-1.2, 0.05, 0.1); push(-0.9, 0.05, 0.1);                              // crash 2 -> sinyal
  for (let i = 0; i < 16; i++) push(0.6, 0.1, 0.1);                          // rally -> TP
  return bars;
}

describe("scan S-04: satu posisi dalam satu waktu (spek §3) + exit ArtaTrade (§4)", () => {
  const bars = twoSetupSeries();
  const scan = scanMrvStretch({ m5Bars: bars, dailyBars: LONG_DAILY(), includeLastBar: true });

  it("sinyal saat posisi terbuka TIDAK membuka posisi kedua (no pyramiding)", () => {
    expect(scan.signals.length).toBeGreaterThan(scan.trades.length);
    expect(scan.skippedSignalsWhileInPosition).toBeGreaterThanOrEqual(1);
    expect(scan.trades.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < scan.trades.length; k++) {
      expect(scan.trades[k]!.entryBarIndex).toBeGreaterThan(scan.trades[k - 1]!.exitBarIndex);
    }
  });

  it("fill entry = open bar berikutnya; SL = 1.0R; TP = 1.7R; R = 1.0*ATR14 bar sinyal", () => {
    for (const tr of scan.trades) {
      expect(tr.entryBarIndex).toBe(tr.signalBarIndex + 1);
      expect(tr.entryPrice).toBe(bars[tr.entryBarIndex]!.open);
      expect(tr.r).toBeCloseTo(MRV_K * tr.atr14, 10);
      if (tr.side === "LONG") {
        expect(tr.slPrice).toBeCloseTo(tr.entryPrice - MRV_SL_R * tr.r, 8);
        expect(tr.tp1Price).toBeCloseTo(tr.entryPrice + MRV_TP_R * tr.r, 8);
        expect(tr.slPrice).toBeLessThan(tr.entryPrice);
        expect(tr.tp1Price).toBeGreaterThan(tr.entryPrice);
      } else {
        expect(tr.slPrice).toBeCloseTo(tr.entryPrice + MRV_SL_R * tr.r, 8);
        expect(tr.tp1Price).toBeCloseTo(tr.entryPrice - MRV_TP_R * tr.r, 8);
        expect(tr.slPrice).toBeGreaterThan(tr.entryPrice);
        expect(tr.tp1Price).toBeLessThan(tr.entryPrice);
      }
    }
  });

  it("harga exit (level SL/TP) berada di dalam range bar exit-nya", () => {
    for (const tr of scan.trades) {
      const b = bars[tr.exitBarIndex]!;
      expect(tr.exitPrice).toBeGreaterThanOrEqual(b.low - 1e-9);
      expect(tr.exitPrice).toBeLessThanOrEqual(b.high + 1e-9);
    }
  });

  it("bar ambigu (SL & TP pada bar sama) dilaporkan DUA kasus: sl_first + tp_first (spek §4)", () => {
    // Setup LONG standar lalu satu bar raksasa yang menyentuh SL dan TP sekaligus.
    const seq = longBars();
    const last = seq[seq.length - 1]!;
    const monster: Bar = {
      openTime: last.openTime + IV,
      open: last.close,
      high: last.close + 5,
      low: last.close - 5,
      close: last.close + 0.05,
      volume: 1000,
    };
    const out = scanMrvStretch({ m5Bars: [...seq, monster], dailyBars: LONG_DAILY(), includeLastBar: true });
    const amb = out.trades.filter((t) => t.ambiguous);
    expect(amb.length).toBeGreaterThanOrEqual(1);
    const t = amb[0]!;
    expect(out.ambiguousBars).toBeGreaterThanOrEqual(1);
    // Dua kasus: pesimis (SL dulu) + optimis (TP dulu).
    expect(t.outcome).toBe("SL");
    expect(t.altOutcome).toBe("TP1");
    expect(t.exitPrice).toBe(t.slPrice);
    expect(t.altExitPrice).toBe(t.tp1Price);
  });
});

// ── 5. Plan S-04 = model exit ArtaTrade (spek §4) ───────────────────────────

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

function mkAnalysis(bars: Bar[], analyzedAt: number, over: Partial<MtfAnalysis> = {}): MtfAnalysis {
  const structure = snap({ interval: "5m", role: "STRUCTURE", barsData: bars });
  const trigger = snap({ interval: "1m", role: "TRIGGER", barsData: bars });
  const bias = snap({ interval: "15m", role: "BIAS", barsData: bars });
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
    bestZone: null,
    zoneAnalysis: null,
    atrTrigger: 1,
    atrStructure: 1,
    price: bars[bars.length - 1]!.close,
    usable: true,
    reason: null,
    tfSummary: "SCALP: 1m + 3m + 5m + 15m",
    analyzedAt,
    ...over,
  };
}

/** Context siap S-04: analyzedAt tepat setelah bar terakhir tutup (anti-repaint). */
function ctxFor(bars: Bar[], daily: Bar[]): StrategyContext {
  const analyzedAt = bars[bars.length - 1]!.openTime + IV + 1000;
  const analysis = mkAnalysis(bars, analyzedAt);
  return { analysis, price: analysis.price, mode: "SCALP", mrv: { m5Bars: bars, dailyBars: daily } };
}

describe("plan S-04 (setupStrategies) — exit model ArtaTrade: SL 1.0R / TP 1.7R", () => {
  it("20 Okt 2026 (operator hapus S-04): plan MRV retired fail-closed — tidak match walau gate engine lolos, TIDAK crash", () => {
    const bars = longBars();
    const daily = LONG_DAILY();
    const ctx = ctxFor(bars, daily);
    const plan = evaluateMrvStretch(ctx);
    // Gate engine (evaluateMrvStretchGate) MASIH hidup dan bisa lolos — itu
    // yang diuji file mrvStretchEngine (arsip, bukan dihapus).
    const gate = evaluateMrvStretchGate({ m5Bars: bars, dailyBars: daily, nowMs: ctx.analysis.analyzedAt });
    expect(gate.atr14).toBeGreaterThan(0);
    // Tapi S-04 DIHAPUS dari katalog aktif -> plan retired: matched=false +
    // STRATEGY_RETIRED. Kalau tidak, S-04 masih bisa entry = perintah operator
    // dilanggar. Tidak boleh crash (TypeError dari spec null) — AU1-02.
    expect(plan.strategyId).toBe("S-04");
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    // Tidak ada level harga karangan pada plan retired.
    expect(plan.slPrice).toBe(0);
    expect(plan.tp1Price).toBe(0);
    expect(plan.quality).toBe(0);
  });

  it("20 Okt 2026 (operator hapus S-04): cermin SHORT juga retired — tidak ada entry S-04 di kedua arah", () => {
    const bars = longBars().map(mirror(207));
    const daily = LONG_DAILY().map(mirror(207));
    const ctx = ctxFor(bars, daily);
    const plan = evaluateMrvStretch(ctx);
    // S-04 dihapus -> tidak ada lagi entry LONG maupun SHORT.
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    expect(plan.slPrice).toBe(0);
    expect(plan.tp1Price).toBe(0);
  });

  it("20 Okt 2026 (operator hapus S-04): tanpa ctx.mrv + jendela MTF 90 bar -> retired (bukan MRV_INSUFFICIENT_M5_BARS)", () => {
    const bars = longBars().slice(-80); // jendela standar MTF (90 bar) — kurang dari 200
    const analysis = mkAnalysis(bars, bars[bars.length - 1]!.openTime + IV + 1000);
    const plan = evaluateMrvStretch({ analysis, price: analysis.price, mode: "SCALP" });
    // S-04 dihapus total -> alasan penolakan adalah STRATEGY_RETIRED, bukan
    // gate bar MRV. Gate bar MRV sudah tidak relevan karena strateginya mati.
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    expect(plan.reasons).not.toContain("MRV_INSUFFICIENT_M5_BARS");
  });

  it("buildStrategyPlans: katalog aktif 20 Okt 2026 = 5 strategi, S-03/S-04/S-05 dihapus total", () => {
    const ctx = ctxFor(longBars(), LONG_DAILY());
    const all = buildStrategyPlans(ctx);
    // 20 Okt 2026 (operator hapus S-03 + S-04, lalu "polaris hapus juga"):
    // katalog aktif final = 5 strategi (S-01, S-02, RSW-01/02/03).
    // S-03/S-04/S-05 tidak lagi muncul sebagai plan — semuanya dihapus dari
    // katalog (mode SCALP ctx: hanya S-01/S-02 + placeholder RSW).
    expect(all.map((p) => p.strategyId).sort()).toEqual(["RSW-01", "RSW-02", "RSW-03", "S-01", "S-02"]);
    expect(all.map((p) => p.strategyId)).not.toContain("S-03");
    expect(all.map((p) => p.strategyId)).not.toContain("S-04");
    expect(all.map((p) => p.strategyId)).not.toContain("S-05");

    // Allowlist tetap bekerja: strategi yang TIDAK di allowlist kena
    // NOT_IN_ALLOWLIST. S-04 sebagai allowlist TIDAK lagi resurrect strategi
    // yang sudah dihapus dari katalog (tidak muncul sama sekali).
    const only = buildStrategyPlans(ctx, Date.now(), ["S-01"]);
    expect(only.find((p) => p.strategyId === "S-02")!.reasons).toContain("NOT_IN_ALLOWLIST");
    expect(only.find((p) => p.strategyId === "S-04")).toBeUndefined();
    const onlyS04 = buildStrategyPlans(ctx, Date.now(), ["S-04"]);
    expect(onlyS04.find((p) => p.strategyId === "S-04")).toBeUndefined();
  });
});

// ── 6. Helper RSI Wilder (indicatorLibrary) ─────────────────────────────────

describe("rsi/rsiSeries (Wilder/RMA, seed SMA(period))", () => {
  it("naik terus = 100; turun terus = 0; vektor kecil cocok dengan hitungan Wilder", () => {
    expect(rsi([1, 2, 3, 4, 5], 2)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 2)).toBe(0);
    // perubahan [+1, -0.5] -> avgGain 0.5, avgLoss 0.25 -> RSI = 100 - 100/(1+2).
    expect(rsi([1, 2, 1.5], 2)).toBeCloseTo(66.6666, 3);
  });

  it("deret sejajar input; NaN sebelum seed cukup", () => {
    const s = rsiSeries([1, 2, 1.5, 1.4], 2);
    expect(s).toHaveLength(4);
    expect(Number.isNaN(s[0]!)).toBe(true);
    expect(Number.isNaN(s[1]!)).toBe(true);
    expect(s[2]).toBeCloseTo(66.6666, 3);
  });
});
