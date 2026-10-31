// apps/server/tests/slotFill.test.ts - Uji kebijakan "ISI SLOT" (perintah operator 25 Sep 2026).
import { describe, expect, it } from "vitest";
import {
  slotFillThresholds,
  agentReviewScoreFloor,
  slotFillBudget,
  knnPasses,
  SLOT_FILL_MAX_PER_CYCLE,
  EntryOncePerPairGuard,
  TrendFlipSideCooldownGuard,
  PostCloseReentryCooldownGuard,
  SymbolProbationGuard,
  PROBATION_LOSS_STREAK,
  probationBlockUntil,
  REENTRY_COOLDOWN_MS,
  checkPairRedundancy,
  checkTradeVolume,
  setAdaptiveVolumeFloor,
  getTradeVolumeFloor,
  getAdaptiveVolumeFloor,
  minTradeVolumeUsd,
  checkChopVeto,
  isFreshEntryScan,
  isEntryCandidateReady,
  isAgentReviewCandidate,
  candidateGatesFor,
  MAX_ENTRY_SCAN_AGE_MS,
  modeMixLimits,
  canOpenTradingLane,
  prioritizeTradingLanes,
  selectRotatingTargets,
  scanGateMsFor,
  mtfWindowPlan,
} from "../src/exec/slotFillPolicy.js";
import { ScannerPool, type CandidateItem } from "../src/scanner/scannerPool.js";
import { env } from "../src/core/env.js";
import { allowedStrategiesFor } from "../src/exec/slotFillPolicy.js";
it("rotasi 111 pair mencakup seluruh universe tanpa duplikasi anchor", () => {
  const symbols = Array.from({ length: 111 }, (_, i) => `PAIR${i}`);
  let cursor = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const scan = selectRotatingTargets(symbols, cursor, 24, 24);
    expect(new Set(scan.targets).size).toBe(scan.targets.length);
    scan.targets.forEach((s) => seen.add(s));
    cursor = scan.nextCursor;
  }
  expect(seen.size).toBe(111);
});
import { checkAgentReviewMarketFit, checkModeMarketFit, MIN_SCALP_STRUCTURE_ATR_PCT } from "../src/exec/marketSelectionPolicy.js";

describe("Kapasitas slot SCALP 20/20 (satu lane, tanpa kuota mix)", () => {
  it("modeMixLimits: SCALP boleh mengisi seluruh kapasitas", () => {
    expect(modeMixLimits(20)).toEqual({ minEach: 20, maxPerMode: 20, relaxedMaxPerMode: 20 });
    expect(modeMixLimits(20, true).maxPerMode).toBe(20);
  });

  it("canOpenTradingLane: SCALP boleh dibuka sampai 20/20, ditolak hanya saat penuh", () => {
    expect(canOpenTradingLane("SCALP", { SCALP: 0 }, 20)).toBe(true);
    expect(canOpenTradingLane("SCALP", { SCALP: 12 }, 20)).toBe(true);
    expect(canOpenTradingLane("SCALP", { SCALP: 19 }, 20)).toBe(true);
    expect(canOpenTradingLane("SCALP", { SCALP: 20 }, 20)).toBe(false);
    // Total posisi tidak boleh melewati 20 walau relaksasi aktif.
    for (const used of [0, 5, 12, 19, 20]) {
      expect(canOpenTradingLane("SCALP", { SCALP: used }, 20, false)).toBe(used < 20);
    }
  });

  it("prioritizeTradingLanes: kandidat dikembalikan apa adanya (hanya satu lane)", () => {
    const candidates = Array.from({ length: 8 }, (_, n) => ({ mode: "SCALP" as const, id: `S${n}` }));
    expect(prioritizeTradingLanes(candidates, { SCALP: 0 }, 20).map((c) => c.id))
      .toEqual(candidates.map((c) => c.id));
  });

  it("selectRotatingTargets: rotasi universe tanpa duplikasi anchor", () => {
    const symbols = Array.from({ length: 12 }, (_, n) => `PAIR${n}`);
    const first = selectRotatingTargets(symbols, 0, 4, 4);
    expect(first.targets).toEqual(symbols.slice(0, 8));
    const second = selectRotatingTargets(symbols, first.nextCursor, 4, 4);
    expect(second.targets).toEqual([...symbols.slice(0, 4), ...symbols.slice(8, 12)]);
  });
});

describe("Kebijakan isi slot PROGRESIF (28 Sep 2026: ga ketat dulu, naik bertahap)", () => {
  it("L0 eksplorasi: ambang lunak 45/0% (LLM menilai semua)", () => {
    const t = slotFillThresholds(15, 20, 0);
    expect(t.tier).toBe("CRITICAL");
    expect(t.minScore).toBe(45);
    expect(t.minKnn).toBe(0);
    expect(t.directive).toContain("45");
  });

  it("L5 disiplin: kembali ketat 68/55%", () => {
    for (const e of [0, 3, 7, 15]) {
      const t = slotFillThresholds(e, 20, 5);
      expect(t.minScore).toBe(68);
      expect(t.minKnn).toBe(0.55);
    }
    expect(slotFillThresholds(0, 20, 5).tier).toBe("FULL");
    expect(slotFillThresholds(0, 20, 5).directive).toContain("SLOT PENUH");
  });

  it("level naik bertahap: 45 -> 50 -> 55 -> 60 -> 64 -> 68", () => {
    const scores = ([0, 1, 2, 3, 4, 5] as const).map((lv) => slotFillThresholds(10, 20, lv).minScore);
    expect(scores).toEqual([45, 50, 55, 60, 64, 68]);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it("tier tetap dari slot kosong (atur kadens scan, bukan bukti)", () => {
    expect(slotFillThresholds(0, 20, 0).tier).toBe("FULL");
    expect(slotFillThresholds(3, 20, 0).tier).toBe("NORMAL");
    expect(slotFillThresholds(7, 20, 0).tier).toBe("HIGH");
    expect(slotFillThresholds(15, 20, 0).tier).toBe("CRITICAL");
  });
});

function readyCandidate(symbol: string, now: number): CandidateItem {
  return {
    symbol, score: 75, mode: "SCALP", regime: "TRENDING", zoneScore: 75,
    triggerScore: 75, trendScore: 75, knnProb: null, knnN: 0,
    chop: 40, chopAdx: 25, biasChop: 40, biasAdx: 26, biasTrend: "BULLISH",
    structureAtrPct: 0.2,
    mtfAnalyzed: true, mtfAnalyzedAt: now,
    gatesPass: { volumeGate: true, regimeGate: true, trendGate: true, scoreGate: true, planGate: true, chopGate: true, volatilityGate: true },
    status: "READY", strategyId: "S-01",
    plan: { strategyId: "S-01", mode: "SCALP", matched: true } as CandidateItem["plan"],
  };
}

describe("Pengisian slot hanya memakai kandidat hasil filter yang segar", () => {
  const now = Date.parse("2026-09-27T00:00:00.000Z");
  const thresholdL0 = slotFillThresholds(10, 20, 0);
  const thresholdL5 = slotFillThresholds(10, 20, 5);

  it("menolak scan lama/kosong dan menerima scan segar", () => {
    expect(isFreshEntryScan(null, now)).toBe(false);
    expect(isFreshEntryScan(new Date(now - MAX_ENTRY_SCAN_AGE_MS - 1).toISOString(), now)).toBe(false);
    expect(isFreshEntryScan(new Date(now - 1000).toISOString(), now)).toBe(true);
  });

  it("L5 disiplin: menerima setup valid, menolak gate gagal & sideways", () => {
    const ready = readyCandidate("BTCUSDT", now);
    expect(isEntryCandidateReady(ready, thresholdL5, now, 5)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, gatesPass: { ...ready.gatesPass, chopGate: false } }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, gatesPass: { ...ready.gatesPass, volumeGate: false } }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, score: 67 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, knnProb: 0.54 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, knnProb: 0.55 }, thresholdL5, now, 5)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, chopAdx: 12 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, chop: 70 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, biasTrend: "NEUTRAL" }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, regime: "RANGING" }, thresholdL5, now, 5)).toBe(false);
  });

  it("20 Okt 2026: override S-03 (Fib 65/0.35) DIHAPUS — tidak ada lagi ambang khusus per-strategi", () => {
    const ready = readyCandidate("BTCUSDT", now);
    const fib = { ...readyCandidate("FIBUSDT", now), strategyId: "S-03",
      plan: { strategyId: "S-03", mode: "SCALP", matched: true } as CandidateItem["plan"] };
    // S-03 Fibonacci dihapus operator -> kandidat "S-03" tidak lagi punya
    // privilege ambang 65/0.35. Kontrak yang diuji: perlakuan S-03 IDENTIK
    // dengan S-01 (parity) — tidak ada strategist yang punya jalur lebih longgar
    // atau lebih ketat karena override yang sudah dihapus.
    const cases: [number, number][] = [[66, 0.4], [64, 0.4], [66, 0.34], [64, 0.1]];
    for (const [sc, kn] of cases) {
      for (const lv of [0, 5]) {
        const th = lv === 0 ? thresholdL0 : thresholdL5;
        expect(isEntryCandidateReady({ ...fib, score: sc, knnProb: kn }, th, now, lv))
          .toBe(isEntryCandidateReady({ ...ready, score: sc, knnProb: kn }, th, now, lv));
      }
    }
    // Angka batas terverifikasi (bukan cuma parity): L5 (skor 68, KNN 0.55)
    // menolak skor 66; L0 (skor 45, KNN 0) menerima skor 64.
    expect(isEntryCandidateReady({ ...fib, score: 66, knnProb: 0.4 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...fib, score: 64, knnProb: 0.1 }, thresholdL0, now, 0)).toBe(true);
    // Lantai review Arka: default progresif (L5 + 20 slot kosong = 55), bukan
    // override 65 yang sudah dihapus. Skor 54 ditolak, 66 diterima.
    expect(isAgentReviewCandidate({ ...fib, score: 54, status: "WAIT" }, 20, now, 5)).toBe(false);
    expect(isAgentReviewCandidate({ ...fib, score: 66, status: "WAIT" }, 20, now, 5)).toBe(true);
    // Pemetaan angka: TIDAK ADA override hidup -> selalu default. Override
    // yatim (S-03/S-04) yang masih ada = aturan mati yang bisa di-revive diam-diam.
    expect(candidateGatesFor("S-03", { minScore: 68, minKnn: 0.55 })).toEqual({ minScore: 68, minKnn: 0.55 });
    expect(candidateGatesFor("S-04", { minScore: 68, minKnn: 0.55 })).toEqual({ minScore: 68, minKnn: 0.55 });
    expect(candidateGatesFor("S-05", { minScore: 68, minKnn: 0.55 })).toEqual({ minScore: 68, minKnn: 0.55 });
    expect(candidateGatesFor("S-01", { minScore: 68, minKnn: 0.55 })).toEqual({ minScore: 68, minKnn: 0.55 });
    expect(candidateGatesFor(null, { minScore: 68, minKnn: 0.55 })).toEqual({ minScore: 68, minKnn: 0.55 });
  });

  it("L0 eksplorasi: skor/KNN/chop longgar lolos (LLM yang menilai)", () => {
    const ready = readyCandidate("BTCUSDT", now);
    expect(isEntryCandidateReady(ready, thresholdL0, now, 0)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, score: 46 }, thresholdL0, now, 0)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, score: 44 }, thresholdL0, now, 0)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, knnProb: 0.1 }, thresholdL0, now, 0)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, chopAdx: 12 }, thresholdL0, now, 0)).toBe(true);
    expect(isEntryCandidateReady({ ...ready, chop: 70 }, thresholdL0, now, 0)).toBe(false);
    expect(isEntryCandidateReady({ ...ready, chopAdx: null }, thresholdL0, now, 0)).toBe(false);
  });

  it("L0: Arka menilai hampir semua (lantai 40), L5: selektif (lantai 55+)", () => {
    const borderline = { ...readyCandidate("ARBORUSDT", now), score: 55, status: "WAIT",
      chop: 60, chopAdx: 17, biasChop: 50, biasAdx: 21, strategyId: null, plan: null,
      gatesPass: { ...readyCandidate("ARBORUSDT", now).gatesPass, planGate: false, chopGate: false, regimeGate: false } };
    expect(agentReviewScoreFloor(20, 0)).toBe(40);
    expect(agentReviewScoreFloor(7, 0)).toBe(42);
    expect(agentReviewScoreFloor(3, 0)).toBe(44);
    expect(agentReviewScoreFloor(20, 5)).toBe(55);
    expect(agentReviewScoreFloor(7, 5)).toBe(60);
    expect(agentReviewScoreFloor(3, 5)).toBe(64);
    expect(isAgentReviewCandidate(borderline, 20, now, 0)).toBe(true);
    expect(isAgentReviewCandidate({ ...borderline, score: 39 }, 20, now, 0)).toBe(false);
    expect(isAgentReviewCandidate({ ...borderline, score: 54 }, 20, now, 5)).toBe(false);
    expect(isAgentReviewCandidate({ ...borderline, chop: 76 }, 20, now, 0)).toBe(false);
    expect(checkAgentReviewMarketFit({ mode: "SCALP", structureChop: 60, structureAdx: 17,
      structureAtrPct: 0.2, biasChop: 50, biasAdx: 21, biasTrend: "BULLISH", biasRegime: "TRENDING" }, undefined, 0).allowed).toBe(true);
  });

  it("SCALP trending lolos; L5 menolak chop-60, L0 meloloskan ke LLM", () => {
    const trending = { ...readyCandidate("BTCUSDT", now), structureAtrPct: 0.01 };
    expect(isEntryCandidateReady(trending, thresholdL5, now, 5)).toBe(true);
    expect(isEntryCandidateReady({ ...trending, chop: 60 }, thresholdL5, now, 5)).toBe(false);
    expect(isEntryCandidateReady({ ...trending, chop: 60 }, thresholdL0, now, 0)).toBe(true);
    expect(checkModeMarketFit({ mode: "SCALP", structureChop: 60, structureAdx: 25,
      structureAtrPct: 0.01, biasChop: 40, biasAdx: 26, biasTrend: "BULLISH",
      biasRegime: "TRENDING" }, undefined, 5)).toEqual({ allowed: false, reason: "CHOP_HIGH" });
    expect(checkModeMarketFit({ mode: "SCALP", structureChop: 60, structureAdx: 25,
      structureAtrPct: 0.01, biasChop: 40, biasAdx: 26, biasTrend: "BULLISH",
      biasRegime: "TRENDING" }, undefined, 0)).toEqual({ allowed: true, reason: null });
    expect(checkModeMarketFit({ mode: "SCALP", structureChop: 40, structureAdx: 25,
      structureAtrPct: 0.5, biasChop: 60, biasAdx: 26,
      biasTrend: "BULLISH", biasRegime: "VOLATILE" }, undefined, 5).allowed).toBe(false);
  });

  it("kandidat READY menggantikan WAIT untuk pair sama tanpa menggandakan pair", async () => {
    const pool = new ScannerPool({ now: () => now });
    const scalpWait = { ...readyCandidate("BTCUSDT", now), status: "WAIT", strategyId: null, plan: null };
    const ethReady = readyCandidate("ETHUSDT", now);
    await pool.scanCycle(["BTCUSDT", "ETHUSDT"], "SCALP", async (symbol) => symbol === "BTCUSDT" ? scalpWait : ethReady);
    const btcReady = readyCandidate("BTCUSDT", now);
    expect(pool.mergeCandidates([btcReady, ethReady])).toBe(1);
    expect(pool.getScanView().candidates).toHaveLength(2);
    expect(pool.getScanView().candidates[0]).toMatchObject({ symbol: "BTCUSDT", status: "READY", mode: "SCALP" });
    expect(pool.getScanView().candidates[1]).toMatchObject({ symbol: "ETHUSDT", mode: "SCALP" });
  });

  it("satu lane: kandidat READY tidak saling menimpa tanpa perubahan status", async () => {
    const pool = new ScannerPool({ now: () => now });
    await pool.scanCycle(["BTCUSDT"], "SCALP", async () => readyCandidate("BTCUSDT", now));
    const refreshed = { ...readyCandidate("BTCUSDT", now), score: 60 };
    expect(pool.mergeCandidates([refreshed])).toBe(0);
    expect(pool.getScanView().candidates).toHaveLength(1);
    expect(pool.getScanView().candidates[0].mode).toBe("SCALP");
  });
});

describe("Budget entry per siklus (isi slot cepat, tetap aman)", () => {
  it("budget = min(slot kosong, batas per siklus)", () => {
    expect(slotFillBudget(0)).toBe(0);
    expect(slotFillBudget(1)).toBe(1);
    expect(slotFillBudget(3)).toBe(3);
    expect(slotFillBudget(20)).toBe(SLOT_FILL_MAX_PER_CYCLE);
    expect(slotFillBudget(999)).toBe(SLOT_FILL_MAX_PER_CYCLE);
  });

  it("budget tidak pernah negatif", () => {
    expect(slotFillBudget(-5)).toBe(0);
  });
});

describe("Gerbang KNN adaptif", () => {
  it("probabilitas null (INSUFFICIENT_DATA) tetap lolos -> diserahkan ke skor", () => {
    expect(knnPasses(null, 0.55)).toBe(true);
    expect(knnPasses(undefined, 0.5)).toBe(true);
  });

  it("membandingkan terhadap ambang adaptif", () => {
    expect(knnPasses(0.53, 0.5)).toBe(true);
    expect(knnPasses(0.53, 0.55)).toBe(false);
    expect(knnPasses(0.66, 0.55)).toBe(true);
  });
});

// Perintah operator 25 Sep 2026 — FINAL:
// "maksimal posisi ada 20 nah kalo mau entry pair yang sama harus terselesaikan dahulu
//  trade nya baru bisa entry lagi. tapi kalo di dalam 20 posisi trading ada yang double entry kan aneh"
//
// Aturan: 20 slot = 20 PAIR BERBEDA.
// Simbol yang trade-nya belum selesai (OPEN) TIDAK BOLEH di-entry lagi.
// Setelah trade-nya selesai (CLOSED), pair itu BEBAS dipilih kembali tanpa jeda waktu buatan.
describe("Aturan satu trade per pair (20 slot = 20 pair unik)", () => {
  it("pair baru belum pernah disentuh -> bebas di-entry", () => {
    const g = new EntryOncePerPairGuard();
    expect(g.isBlocked("BTCUSDT")).toBe(false);
    expect(g.size()).toBe(0);
  });

  it("saat posisi dibuka -> pair terblokir (tidak boleh double entry)", () => {
    const g = new EntryOncePerPairGuard();
    g.mark("SAGAUSDT");
    expect(g.isBlocked("SAGAUSDT")).toBe(true);
    // Case-insensitive
    expect(g.isBlocked("sagausdt")).toBe(true);
    expect(g.size()).toBe(1);
  });

  it("pair lain yang berbeda tidak terpengaruh", () => {
    const g = new EntryOncePerPairGuard();
    g.mark("SAGAUSDT");
    expect(g.isBlocked("ETHUSDT")).toBe(false);
    expect(g.isBlocked("SOLUSDT")).toBe(false);
  });

  it("setelah trade selesai (release) -> langsung boleh di-entry kembali", () => {
    const g = new EntryOncePerPairGuard();
    g.mark("SAGAUSDT");
    expect(g.isBlocked("SAGAUSDT")).toBe(true);
    // Trade selesai (TP2/BE/SL/dll)
    g.release("SAGAUSDT");
    expect(g.isBlocked("SAGAUSDT")).toBe(false);
    expect(g.size()).toBe(0);
  });

  it("checkPairRedundancy: 1 atau lebih posisi OPEN -> DIBLOKIR", () => {
    const r1 = checkPairRedundancy(1);
    expect(r1.blocked).toBe(true);
    expect(r1.reason).toContain("PAIR_TRADE_BELUM_SELESAI");

    const r2 = checkPairRedundancy(2);
    expect(r2.blocked).toBe(true);
  });

  it("checkPairRedundancy: 0 posisi OPEN -> PAIR_BEBAS", () => {
    const r = checkPairRedundancy(0);
    expect(r.blocked).toBe(false);
    expect(r.reason).toBe("PAIR_BEBAS");
  });

  it("active() mengembalikan daftar pair unik terurut", () => {
    const g = new EntryOncePerPairGuard();
    g.mark("SOLUSDT");
    g.mark("BTCUSDT");
    g.mark("ETHUSDT");
    expect(g.active()).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });});

describe("Gate volume operator: ambang futures strict (VOLUME_MIN_USD)", () => {
  it("volume di atas ambang lolos; tepat ambang dan lebih rendah ditolak", () => {
    setAdaptiveVolumeFloor(999_999_999); // no-op: adaptif dicabut, lantai tetap
    expect(getAdaptiveVolumeFloor()).toBe(0);
    expect(getTradeVolumeFloor()).toBe(minTradeVolumeUsd());
    expect(getTradeVolumeFloor()).toBe(Number(env.VOLUME_MIN_USD));
    const floor = minTradeVolumeUsd();
    expect(checkTradeVolume(floor + 1).allowed).toBe(true);
    expect(checkTradeVolume(floor + 100_000).allowed).toBe(true);
    expect(checkTradeVolume(floor).allowed).toBe(false);
    expect(checkTradeVolume(floor - 1).allowed).toBe(false);
    expect(checkTradeVolume(0).allowed).toBe(false);
    expect(checkTradeVolume(undefined).allowed).toBe(false);
  });

  it("pasca TREND_FLIP arah lama dikunci, arah kebalikan tetap bisa dinilai strategi", () => {
    const guard = new TrendFlipSideCooldownGuard();
    const now = 1_700_000_000_000;
    guard.record("SUIUSDT", "LONG", now);
    expect(guard.isBlocked("SUIUSDT", "LONG", now + 1_000)).toBe(true);
    expect(guard.isBlocked("SUIUSDT", "SHORT", now + 1_000)).toBe(false);
    expect(guard.isBlocked("SUIUSDT", "LONG", now + 30 * 60_000)).toBe(false);
  });

  it("allowlist SCALP-only: subset katalog aktif, mengikuti env SCALP_STRATEGY_IDS", () => {
    // 14 Okt 2026 (Tahap A1): S-01 hard-gated (EV negatif di fee maker) —
    // tidak bisa diaktifkan lewat env, tidak masuk katalog aktif.
    // 20 Okt 2026: S-03 Fibonacci + S-04 MRV dihapus -> katalog SCALP yang
    // boleh hidup tinggal S-02.
    const catalog = new Set(["S-02"]);
    const active = allowedStrategiesFor("SCALP");
    expect(active.length).toBeGreaterThan(0);
    expect(active).not.toContain("S-01");
    for (const id of active) expect(catalog.has(id)).toBe(true);
    // Env (bila diisi) menentukan; selalu subset katalog — tidak ada ID pensiun.
    const envList = String(env.SCALP_STRATEGY_IDS ?? "S-02")
      .split(",").map((s) => s.trim().toUpperCase()).filter((id) => catalog.has(id));
    expect(active).toEqual([...new Set(envList)]);
    expect(allowedStrategiesFor()).toEqual(active);
    // Bahkan env yang memaksa S-01 tetap diblok (hard gate, bukan soft default).
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-01");
    // S-03/S-04 tidak boleh muncul di lane mana pun (dihapus global).
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-03");
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-04");
  });

  it("SWING PAPER: hanya RSW-01/02/03; S-03/S-04/S-05 dihapus GLOBAL", () => {
    // 20 Okt 2026: S-03 Fibonacci, S-04 MRV, dan S-05 Polaris (operator:
    // "polaris hapus juga") semuanya DIHAPUS dari katalog aktif. Lane SWING
    // kini hanya tiga strategi riset RSW.
    const active = allowedStrategiesFor("SWING");
    expect(active).toEqual(["RSW-01", "RSW-02", "RSW-03"]);
    expect(active).not.toContain("S-03");
    expect(active).not.toContain("S-04");
    expect(active).not.toContain("S-05");
    // Lane SCALP hanya S-02 (S-01 hard-gated EV negatif).
    expect(allowedStrategiesFor("SCALP")).toEqual(["S-02"]);
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-03");
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-04");
    expect(allowedStrategiesFor("SCALP")).not.toContain("S-05");
  });

  it("29 Sep 2026: sidewaysentry DILARANG di semua mode & level (termasuk L0)", () => {
    const sideways = { mode: "SCALP" as const, structureChop: 40, structureAdx: 25,
      structureAtrPct: 0.5, biasChop: 40, biasAdx: 26,
      biasTrend: "NEUTRAL" as const, biasRegime: "RANGING" };
    // L0 pun menolak sideways — level progresif hanya mengeraskan angka.
    for (const level of [0, 1, 2, 3, 4, 5]) {
      expect(checkModeMarketFit(sideways, undefined, level)).toEqual({ allowed: false, reason: "BIAS_SIDEWAYS" });
      expect(checkAgentReviewMarketFit(sideways, undefined, level)).toEqual({ allowed: false, reason: "BIAS_SIDEWAYS" });
    }
    // Regime RANGING/UNCERTAIN juga tolak walau bias-nya berarah.
    for (const regime of ["RANGING", "UNCERTAIN"]) {
      expect(checkModeMarketFit({ ...sideways, biasTrend: "BULLISH", biasRegime: regime }, undefined, 0))
        .toEqual({ allowed: false, reason: "BIAS_SIDEWAYS" });
    }
    // TRENDING tetap boleh (termasuk di L0 longgar).
    // 14 Okt 2026 (Tahap A4): VOLATILE dikeluarkan dari ALLOWED_ENTRY_REGIMES
    // — ATR spike = chaos, bukan tren; entry HANYA di TRENDING.
    for (const regime of ["TRENDING", "VOLATILE"]) {
      const res = checkModeMarketFit({ ...sideways, biasTrend: "BULLISH", biasRegime: regime }, undefined, 0);
      expect(res.allowed).toBe(regime === "TRENDING");
    }
  });



  it("checkChopVeto PROGRESIF: L5 ketat 58.3/20, L0 longgar 70/12, metrik hilang selalu veto", () => {
    expect(checkChopVeto(70, 25, 5)).toEqual({ vetoed: true, reason: "CHOP_HIGH" });
    expect(checkChopVeto(40, 15, 5)).toEqual({ vetoed: true, reason: "ADX_LOW" });
    expect(checkChopVeto(40, 25, 5)).toEqual({ vetoed: false, reason: null });
    expect(checkChopVeto(65, 15, 0)).toEqual({ vetoed: false, reason: null });
    expect(checkChopVeto(40, 15, 0)).toEqual({ vetoed: false, reason: null });
    expect(checkChopVeto(70, 25, 0)).toEqual({ vetoed: true, reason: "CHOP_HIGH" });
    expect(checkChopVeto(40, 11, 0)).toEqual({ vetoed: true, reason: "ADX_LOW" });
    expect(checkChopVeto(null, null, 0)).toEqual({ vetoed: true, reason: "METRICS_UNAVAILABLE" });
    expect(checkChopVeto(undefined, 25, 5)).toEqual({ vetoed: true, reason: "METRICS_UNAVAILABLE" });
  });
});
describe("Kadens scan & jendela MTF adaptif saat slot kosong (T-5.50)", () => {
  it("scan lebih cepat saat slot kosong bertambah (20 -> 15 -> 8 dtk)", () => {
    expect(scanGateMsFor(0)).toBe(20_000);
    expect(scanGateMsFor(4)).toBe(20_000);
    expect(scanGateMsFor(5)).toBe(15_000);
    expect(scanGateMsFor(9)).toBe(15_000);
    expect(scanGateMsFor(10)).toBe(8_000);
    expect(scanGateMsFor(20)).toBe(8_000);
    expect(scanGateMsFor(-3)).toBe(20_000);
  });

  it("jendela MTF: 24 anchor + 24 rotasi normal, +8 rotasi saat >=10 slot kosong", () => {
    expect(mtfWindowPlan(0, 48)).toEqual({ freshTop: 24, rotating: 24, width: 48 });
    expect(mtfWindowPlan(9, 48)).toEqual({ freshTop: 24, rotating: 24, width: 48 });
    expect(mtfWindowPlan(10, 48)).toEqual({ freshTop: 24, rotating: 32, width: 56 });
    expect(mtfWindowPlan(20, 48)).toEqual({ freshTop: 24, rotating: 32, width: 56 });
    // Baseline kecil tidak boleh menurunkan anchor di bawah 24.
    expect(mtfWindowPlan(0, 10)).toEqual({ freshTop: 24, rotating: 0, width: 24 });
  });

  it("jendela MTF kritis selalu >= budget slot yang bisa dibuka", () => {
    const plan = mtfWindowPlan(15, 48);
    expect(plan.width).toBeGreaterThanOrEqual(slotFillBudget(15));
  });
});

describe("Cooldown re-entry pasca-CLOSE (cegah double-loss, 2 Okt 2026)", () => {
  it("record close -> re-entry (kedua sisi) diblokir <10 menit, bebas setelah 10 menit", () => {
    const g = new PostCloseReentryCooldownGuard();
    const t0 = 1_700_000_000_000;
    g.record("SANDUSDT", t0);
    expect(g.isBlocked("SANDUSDT", t0 + 1)).toBe(true);
    expect(g.isBlocked("SANDUSDT", t0 + REENTRY_COOLDOWN_MS - 1)).toBe(true);
    expect(g.remainingMs("SANDUSDT", t0 + 1)).toBeGreaterThan(0);
    expect(g.isBlocked("SANDUSDT", t0 + REENTRY_COOLDOWN_MS)).toBe(false);
    expect(g.remainingMs("SANDUSDT", t0 + REENTRY_COOLDOWN_MS)).toBe(0);
  });

  it("per-pair (kedua sisi): satu close memblokir entry LONG maupun SHORT pada pair itu", () => {
    const g = new PostCloseReentryCooldownGuard();
    const t0 = 1_700_000_000_000;
    g.record("ENJUSDT", t0);
    expect(g.isBlocked("ENJUSDT", t0 + 30_000)).toBe(true);
    expect(g.remainingMs("ENJUSDT", t0 + 30_000)).toBe(REENTRY_COOLDOWN_MS - 30_000);
  });

  it("skenario double-loss (SAND/ENJ/CAP): re-entry kilat diblokir; setelah 10 menit bebas", () => {
    const g = new PostCloseReentryCooldownGuard();
    const t0 = 1_700_000_000_000;
    const pairs = ["SANDUSDT", "ENJUSDT", "CAPUSDT"];
    for (const s of pairs) g.record(s, t0);
    for (const s of pairs) expect(g.isBlocked(s, t0 + 30_000)).toBe(true);
    for (const s of pairs) expect(g.isBlocked(s, t0 + REENTRY_COOLDOWN_MS)).toBe(false);
  });

  it("record ulang memperpanjang cooldown; clear mengosongkan; REENTRY_COOLDOWN_MS = 60 menit (perintah operator 13 Okt 2026)", () => {
    const g = new PostCloseReentryCooldownGuard();
    const t0 = 1_700_000_000_000;
    g.record("SANDUSDT", t0);
    g.record("SANDUSDT", t0 + 5 * 60_000);
    expect(g.isBlocked("SANDUSDT", t0 + 5 * 60_000 + REENTRY_COOLDOWN_MS - 1)).toBe(true);
    expect(g.isBlocked("SANDUSDT", t0 + 5 * 60_000 + REENTRY_COOLDOWN_MS)).toBe(false);
    expect(g.isBlocked("BTCUSDT", t0 + 1)).toBe(false);
    expect(REENTRY_COOLDOWN_MS).toBe(7_200_000); // 14 Okt 2026: 60 menit -> 120 menit (2 jam, Big Brain A3)
    g.clear();
    expect(g.isBlocked("SANDUSDT", t0 + 5 * 60_000 + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-03 Probation simbol anti-churn (keputusan operator 4 Okt 2026):
// 3 loss BERUNTUN pada simbol yang sama -> blokir entry 45 menit (kedua sisi).
// ---------------------------------------------------------------------------
describe("SymbolProbationGuard (anti-churn)", () => {
  it("2 loss beruntun BELUM memblokir", () => {
    const g = new SymbolProbationGuard();
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", false);
    expect(g.isBlocked("AINUSDT")).toBe(false);
    expect(g.currentStreak("AINUSDT")).toBe(2);
  });

  it("loss ke-3 beruntun MEMBLOKIR selama PROBATION_BLOCK_MS", () => {
    const g = new SymbolProbationGuard();
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", false);
    expect(g.isBlocked("AINUSDT")).toBe(true);
    expect(g.remainingMs("AINUSDT")).toBeGreaterThan(0);
    expect(g.currentStreak("AINUSDT")).toBe(0); // fresh start setelah blokir
  });

  it("win di tengah streak me-reset hitungan loss", () => {
    const g = new SymbolProbationGuard();
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", true); // win -> reset
    g.recordClose("AINUSDT", false);
    g.recordClose("AINUSDT", false);
    expect(g.isBlocked("AINUSDT")).toBe(false); // baru 2 loss lagi
    expect(g.currentStreak("AINUSDT")).toBe(2);
  });

  it("blokir kadaluarsa tepat pada 00:00 UTC berikutnya", () => {
    const g = new SymbolProbationGuard();
    const t0 = 1_000_000_000_000; // 2001-09-09T01:46:40Z
    g.recordClose("AINUSDT", false, t0);
    g.recordClose("AINUSDT", false, t0);
    g.recordClose("AINUSDT", false, t0);
    const until = probationBlockUntil(t0); // 2001-09-10T00:00:00Z
    expect(g.isBlocked("AINUSDT", until - 1)).toBe(true);
    expect(g.isBlocked("AINUSDT", until)).toBe(false);
  });

  it("blokiran = sampai awal hari UTC berikutnya (keputusan operator 14 Okt)", () => {
    const t0 = Date.UTC(2026, 9, 14, 21, 30, 0); // 21:30 UTC
    expect(probationBlockUntil(t0)).toBe(Date.UTC(2026, 9, 15, 0, 0, 0));
    expect(PROBATION_LOSS_STREAK).toBe(3);
  });

  it("seed dari DB: streak >= 3 dengan loss terakhir baru -> blokir sampai 00:00 UTC berikutnya", () => {
    const g = new SymbolProbationGuard();
    const now = Date.now();
    g.seed("BRUSDT", 3, now - 10 * 60_000); // loss ke-3 terjadi 10 menit lalu
    expect(g.isBlocked("BRUSDT")).toBe(true);
    const expectedUntil = probationBlockUntil(now - 10 * 60_000);
    expect(g.remainingMs("BRUSDT")).toBeLessThanOrEqual(expectedUntil - now);
  });

  it("seed dari DB: streak >= 3 tapi 00:00 UTC blokir sudah lewat -> bebas", () => {
    const g = new SymbolProbationGuard();
    const now = Date.now();
    // loss terakhir kemarin (sebelum tengah malam UTC terakhir) -> blokir sudah expired
    const yesterday = now - 24 * 60 * 60_000;
    g.seed("BRUSDT", 5, yesterday);
    expect(g.isBlocked("BRUSDT")).toBe(false);
  });

  it("seed dari DB: streak parsial (1-2) disimpan, tidak langsung blokir", () => {
    const g = new SymbolProbationGuard();
    g.seed("ONEUSDT", 2, Date.now());
    expect(g.isBlocked("ONEUSDT")).toBe(false);
    expect(g.currentStreak("ONEUSDT")).toBe(2);
    g.recordClose("ONEUSDT", false); // loss ke-3 live
    expect(g.isBlocked("ONEUSDT")).toBe(true);
  });

  it("key simbol tidak case-sensitive", () => {
    const g = new SymbolProbationGuard();
    g.recordClose("ainusdt", false);
    g.recordClose("AINUSDT", false);
    g.recordClose("AinUsdt", false);
    expect(g.isBlocked("AINUSDT")).toBe(true);
  });

  it("clear() menghapus semua catatan", () => {
    const g = new SymbolProbationGuard();
    g.recordClose("X", false);
    g.recordClose("X", false);
    g.recordClose("X", false);
    g.clear();
    expect(g.isBlocked("X")).toBe(false);
    expect(g.currentStreak("X")).toBe(0);
  });
});
