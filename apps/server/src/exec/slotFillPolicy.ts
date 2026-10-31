// apps/server/src/exec/slotFillPolicy.ts - Kebijakan "ISI SLOT" (perintah operator 25 Sep 2026).
// Tujuan: slot posisi (maks 20) terus ditawarkan kepada kandidat valid. Bila
// kosong, agen diberi kandidat dengan ambang sistem + bot boleh membuka BEBERAPA
// posisi dalam satu siklus. Semua keputusan tetap milik agen (Arka/Wardha/Vega),
// dan semua pengaman risiko tetap berlaku: risiko $1, band SL, 1 posisi/simbol,
// kelas aset crypto-only, margin cap 40% & margin level 70% equity.
//
import { env } from "../core/env.js";
import { SETUP_ENGINE } from "../config/setupEngine.js";
import { DEFAULT_MAX_CHOPPINESS, DEFAULT_MIN_ADX } from "../universe/eligibility.js";
import { allowedScalpStrategies } from "../strategies/scalp/scalpCatalog.js";
import { allowedSwingStrategies } from "../strategies/swing/swingCatalog.js";
import type { CandidateItem } from "../scanner/scannerPool.js";
import { checkAgentReviewMarketFit, checkModeMarketFit } from "./marketSelectionPolicy.js";
import { progressiveEnabled, progressiveOverride, progressiveThresholdsFor, resolveProgressiveLevel, reviewFloorFor, type ProgressiveLevel } from "./progressivePolicy.js";

/**
 * Allowlist strategi (SCALP sejak 30 Sep 2026; +lane SWING 13 Okt 2026):
 *   SCALP = S-02 Liquidity Sniper. S-01 Liquidity Sweep Reclaim hard-gated
 *           (EV negatif, bukan entry source); S-03 Fibonacci + S-04 MRV
 *           Stretch DIHAPUS 20 Okt 2026.
 *   SWING = RSW-01 Orion, RSW-02 Vega, RSW-03 Draco. S-05 Polaris entry
 *           retired 20 Okt 2026 (edge negatif) dan dipindahkan ke arsip riset
 *           21 Okt 2026 — TIDAK lagi ada di allowlist, untuk LIVE maupun PAPER.
 * Tiap strategi tetap wajib cocok dengan pemicunya sendiri; daftar top mover
 * hanya menentukan prioritas observasi, bukan memberi sinyal entry.
 * Fail-closed: env kosong/tak valid pada mode apapun -> default deterministik.
 *
 * 20 Okt 2026: sumber kebenaran allowlist dipindah ke katalog strategi
 * (swingCatalog.allowedSwingStrategies / scalpCatalog.allowedScalpStrategies).
 * Sebelumnya file ini punya SALINAN daftar sendiri yang bisa melenceng dari
 * katalog — allowlist ganda = sumber kebenaran ganda. Sekarang satu fungsi.
 */
export function allowedStrategiesFor(mode: "SCALP" | "SWING" = "SCALP"): string[] {
  return mode === "SWING" ? allowedSwingStrategies() : allowedScalpStrategies();
}

export type TradingStyle = "SCALP" | "SWING" | "BOTH";

let _runtimeStyleOverride: TradingStyle | null = null;

export function setTradingStyleOverride(style: TradingStyle | null): void {
  _runtimeStyleOverride = style;
}

/**
 * Deteksi gaya trade aktif dari CLI argv (--mode=SCALP|SWING|BOTH) atau
 * environment variable TRADING_STYLE / TRADING_MODE.
 * Default fail-safe tetap SWING jika tidak dispesifikasikan.
 */
export function getTradingStyle(): TradingStyle {
  if (_runtimeStyleOverride) return _runtimeStyleOverride;
  const argvMode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1]?.toUpperCase();
  if (argvMode === "SCALP" || argvMode === "SWING" || argvMode === "BOTH") {
    return argvMode as TradingStyle;
  }
  const envStyle = (process.env.TRADING_STYLE || process.env.TRADING_MODE || "").toUpperCase();
  if (envStyle === "SCALP" || envStyle === "SWING" || envStyle === "BOTH") {
    return envStyle as TradingStyle;
  }
  return "SWING";
}

export const SCALP_LANE_ENABLED = false;

export function scalpLaneEnabled(): boolean {
  const style = getTradingStyle();
  return style === "SCALP" || style === "BOTH";
}

export function swingLaneEnabled(): boolean {
  const style = getTradingStyle();
  return style === "SWING" || style === "BOTH";
}

/** Resolve level progresif aktif (override env menang; AUTO tanpa bukti = L0 eksplorasi). */
export function activeProgressiveLevel(hint?: ProgressiveLevel): ProgressiveLevel {
  if (hint !== undefined) return hint;
  if (!progressiveEnabled(env.PROGRESSIVE_ENABLED)) return 5;
  return resolveProgressiveLevel(
    { verifiedTrades: 0, winrate: null, expectancyUsd: null },
    progressiveOverride(env.PROGRESSIVE_LEVEL_OVERRIDE)
  );
}
// Ambang deterministik (bukan LLM yang menghitung, LLM hanya menilai):

export const SLOT_FILL_MAX_PER_CYCLE = 20; // batas buka per siklus (isi sampai 20 slot)
// 30 Sep 2026 — refactor SCALP-only: hanya ada satu lane (SCALP). Tipe dipertahankan
// sebagai alias agar pemanggil lama tetap kompilasi tanpa perubahan serentak.
// 13 Okt 2026: lane SWING kembali untuk S-05 Swing Breakout.
export type TradingLane = "SCALP" | "SWING";
export type ModeCounts = Record<TradingLane, number>;

/**
 * Komposisi slot 20/20 (SCALP-only sejak 30 Sep 2026).
 * 29 Sep 2026 (perintah operator: "pastikan bisa sampai membuka posisi sampai 20/20 slot untuk mode scalp ini, aku tidak mau di batasi"):
 * SCALP diizinkan mengisi hingga kapasitas penuh 20/20 slot tanpa dibatasi kuota mix.
 */
export const MODE_MIX_SCALP_SHARE = 1.0; // SCALP boleh mengisi seluruh kapasitas
export const MODE_MIX_MIN_EACH_SHARE = 1.0; // tidak ada lane lain

/** Batas kapasitas lane. SCALP-only: plafon = seluruh kapasitas. */
export function modeMixLimits(
  maxPositions: number,
  _relax = false
): { minEach: number; maxPerMode: number; relaxedMaxPerMode: number } {
  const capacity = Math.max(2, Math.floor(maxPositions));
  return {
    minEach: capacity,
    maxPerMode: capacity,
    relaxedMaxPerMode: capacity,
  };
}

/**
 * Lane boleh dibuka selama kapasitas total belum penuh (SCALP).
 * SWING (13 Okt 2026, perintah operator): maks 2 posisi GLOBAL — kapasitas
 * total posisi open S-05 (SCALP + SWING) tidak boleh melewati swingCap;
 * di luar itu SWING juga tunduk pada batas slot total.
 */
export function canOpenTradingLane(
  mode: TradingLane,
  counts: ModeCounts,
  maxPositions: number,
  _otherLaneHasCandidate = true,
  swingCap = Number(env.SWING_MAX_POSITIONS ?? 2)
): boolean {
  if (mode === "SWING") {
    const total = (counts.SCALP ?? 0) + (counts.SWING ?? 0);
    return (counts.SWING ?? 0) < swingCap && total < maxPositions;
  }
  return counts.SCALP < maxPositions;
}

/** Kandidat sudah terurut kualitas. SCALP-only: kembalikan apa adanya (backups
 * tetap dievaluasi bila proposal berperingkat lebih tinggi ditolak gate keras). */
export function prioritizeTradingLanes<T extends { mode: TradingLane }>(
  candidates: T[], _counts: ModeCounts, _maxPositions: number, _relaxMix = false
): T[] {
  return [...candidates];
}

/** Jelajahi universe lewat rotasi antar siklus tanpa melebihi budget market-data.
 * Empat pertama adalah anchor stabil berperingkat tinggi; sisanya berotasi agar
 * setup valid berperingkat lebih rendah tetap bisa ditemukan. */
export function selectRotatingTargets<T>(eligible: T[], cursor: number, anchors = 4, rotating = 4): { targets: T[]; nextCursor: number } {
  const fixed = eligible.slice(0, anchors);
  const pool = eligible.slice(anchors);
  if (pool.length === 0) return { targets: fixed, nextCursor: 0 };
  const count = Math.min(rotating, pool.length);
  const start = cursor % pool.length;
  const selected = Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length]);
  return { targets: [...fixed, ...selected], nextCursor: (start + count) % pool.length };
}

export type SlotFillTier = "FULL" | "NORMAL" | "HIGH" | "CRITICAL";

export interface SlotFillThresholds {
  minScore: number; // ambang skor gabungan kandidat
  minKnn: number;   // ambang probabilitas KNN
  tier: SlotFillTier;
  emptySlots: number;
  maxPositions: number;
  directive: string; // kalimat arahan untuk agen LLM
}

/**
 * Ambang isi-slot PROGRESIF (perintah operator 28 Sep 2026).
 * Tier masih dari slot kosong (atur kadens scan), tapi angka minScore/minKnn
 * mengikuti level progresif: L0=45/0% -> L5=68/55%. Naik bertahap saat bukti
 * PAPER membaik; performa buruk menahan level tetap rendah (tetap eksplorasi).
 */
export function slotFillThresholds(emptySlots: number, maxPositions: number, levelHint?: ProgressiveLevel): SlotFillThresholds {
  const e = Math.max(0, Math.floor(emptySlots));
  const m = Math.max(1, Math.floor(maxPositions));
  const lv = activeProgressiveLevel(levelHint);
  const prog = progressiveThresholdsFor(lv);
  const minScore = progressiveEnabled(env.PROGRESSIVE_ENABLED) ? prog.minScore : 68;
  const minKnn = progressiveEnabled(env.PROGRESSIVE_ENABLED) ? prog.minKnn : 0.55;
  const tag = progressiveEnabled(env.PROGRESSIVE_ENABLED) ? ` [PROGRESIF L${lv}: ${prog.directive}]` : "";

  if (e >= 10) {
    return {
      minScore, minKnn, tier: "CRITICAL", emptySlots: e, maxPositions: m,
      directive: `MODE ISI SLOT KRITIS: ${e}/${m} slot KOSONG. Ambang skor>=${minScore} & KNN>=${Math.round(minKnn * 100)}%.${tag}`,
    };
  }
  if (e >= 5) {
    return {
      minScore, minKnn, tier: "HIGH", emptySlots: e, maxPositions: m,
      directive: `MODE ISI SLOT TINGGI: ${e}/${m} slot kosong. Ambang skor>=${minScore} & KNN>=${Math.round(minKnn * 100)}%.${tag}`,
    };
  }
  if (e >= 1) {
    return {
      minScore, minKnn, tier: "NORMAL", emptySlots: e, maxPositions: m,
      directive: `MODE ISI SLOT NORMAL: ${e}/${m} slot kosong. Ambang skor>=${minScore} & KNN>=${Math.round(minKnn * 100)}%.${tag}`,
    };
  }
  return {
    minScore, minKnn, tier: "FULL", emptySlots: 0, maxPositions: m,
    directive: `SLOT PENUH (${m}/${m}). Tidak ada entry baru; fokus supervisi TP/SL & TREND_FLIP.`,
  };
}

/**
 * Lantai review LLM (Arka menilai SEMUA di L0).
 * L0: 40/42/44/45 — hampir semua kandidat MTF segar + volume OK sampai ke LLM.
 * L5: 55/60/64/68 — kembali selektif seperti sebelum perintah pelonggaran.
 */
export function agentReviewScoreFloor(emptySlots: number, levelHint?: ProgressiveLevel): number {
  if (progressiveEnabled(env.PROGRESSIVE_ENABLED)) {
    return reviewFloorFor(emptySlots, activeProgressiveLevel(levelHint));
  }
  const e = Math.max(0, Math.floor(emptySlots));
  if (e >= 10) return 55;
  if (e >= 5) return 60;
  if (e >= 1) return 64;
  return 68;
}

/** Berapa posisi maksimum yang boleh dibuka pada siklus ini. */
export function slotFillBudget(emptySlots: number): number {
  return Math.max(0, Math.min(SLOT_FILL_MAX_PER_CYCLE, Math.floor(emptySlots)));
}

// ─────────────────────────────────────────────────────────────────────────────
// KADENS SCAN & JENDELA ANALISIS ADAPTIF (perintah operator 27 Sep 2026 —
// "eksekusi cepat dan cermat sampai 20/20"). Saat slot kosong, pasokan kandidat
// segar dipercepat TANPA menurunkan satu pun gate kualitas: full scan boleh
// lebih sering dan jendela rotasi MTF diperluas. Saat slot penuh, kadens
// kembali normal supaya permintaan market data tetap hemat (anti-429).
// ─────────────────────────────────────────────────────────────────────────────

// 30 Sep 2026 (operator: "jaga kualitas, percepat kadens scan"): jeda antar
// full scan dirapatkan supaya setup SAH lebih cepat ketemu saat slot kosong.
// Tidak ada gate kualitas yang dilonggarkan — hanya pasokan kandidat segar yang
// dipercepat. Aman dari 429 karena klines MTF di-cache 90 dtk, worker nol REST,
// MTF_CONCURRENCY=3 berpace, dan REST pool fapi1-4 punya failover host.
export const SCAN_GATE_NORMAL_MS = 20_000;
export const SCAN_GATE_HIGH_MS = 15_000;
export const SCAN_GATE_CRITICAL_MS = 8_000;
/** Anchor fresh per scan (top mover) — selalu dianalisis ulang. */
export const MTF_ANCHOR_COUNT = 24;
/** Bonus jendela rotasi saat >=10 slot kosong (setup baru lebih cepat ketemu). */
export const MTF_ROTATING_CRITICAL_BONUS = 8;

/** Jeda minimum antar full scan; makin banyak slot kosong makin cepat. */
export function scanGateMsFor(emptySlots: number): number {
  const e = Math.max(0, Math.floor(emptySlots));
  if (e >= 10) return SCAN_GATE_CRITICAL_MS;
  if (e >= 5) return SCAN_GATE_HIGH_MS;
  return SCAN_GATE_NORMAL_MS;
}

/** Pembagian jendela MTF per scan: anchor tetap + rotasi (bonus saat kritis). */
export function mtfWindowPlan(emptySlots: number, baselineTopN: number): { freshTop: number; rotating: number; width: number } {
  const baseline = Math.max(MTF_ANCHOR_COUNT, Math.floor(Number(baselineTopN) || MTF_ANCHOR_COUNT));
  const bonus = Math.max(0, Math.floor(emptySlots)) >= 10 ? MTF_ROTATING_CRITICAL_BONUS : 0;
  const freshTop = MTF_ANCHOR_COUNT;
  const rotating = Math.max(0, baseline - freshTop) + bonus;
  return { freshTop, rotating, width: freshTop + rotating };
}

/** Ambang KNN minimal yang boleh dipakai (null-prob tetap dianggap lolos bila skor cukup). */
export function knnPasses(knnProb: number | null | undefined, minKnn: number): boolean {
  if (knnProb === null || knnProb === undefined) return true; // INSUFFICIENT_DATA -> serahkan ke skor
  return knnProb >= minKnn;
}

/**
 * Ambang kelayakan kandidat per-strategi (6 Okt 2026, perintah operator
 * "rules Fib terpisah"). Strategi dengan override (S-03 Fib) memakai angkanya
 * sendiri yang TETAP (tidak ikut level progresif); selain itu memakai default.
 * Catatan jujur: skor Fib rendah di komponen trigger momentum (setup pullback
 * memang tanpa momentum segar) dan KNN belum mengenal pola Fib (out-of-domain)
 * — keduanya bukan ukuran kualitas yang sah untuk strategi ini.
 */
export function candidateGatesFor(
  strategyId: string | null | undefined,
  defaults: { minScore: number; minKnn: number },
): { minScore: number; minKnn: number } {
  const o = strategyId ? SETUP_ENGINE.strategyGateOverrides[String(strategyId).toUpperCase()] : undefined;
  if (!o || o.minCandidateScore === undefined || o.minKnn === undefined) return defaults;
  return { minScore: o.minCandidateScore, minKnn: o.minKnn };
}

export const MAX_ENTRY_SCAN_AGE_MS = 300_000;
export function isFreshEntryScan(refreshedAt: string | null, now = Date.now()): boolean {
  if (!refreshedAt) return false;
  const age = now - Date.parse(refreshedAt);
  return Number.isFinite(age) && age >= -5_000 && age <= MAX_ENTRY_SCAN_AGE_MS;
}

const REQUIRED_CANDIDATE_GATES = ["volumeGate", "regimeGate", "trendGate", "scoreGate", "planGate", "chopGate", "volatilityGate"] as const;
export function isEntryCandidateReady(candidate: CandidateItem, thresholds: SlotFillThresholds, now = Date.now(), levelHint?: ProgressiveLevel): boolean {
  const lv = activeProgressiveLevel(levelHint);
  // Ambang per-strategi (S-03 Fib: 65 / 0.35 tetap) menggantikan default progresif.
  const gates = candidateGatesFor(candidate.strategyId, { minScore: thresholds.minScore, minKnn: thresholds.minKnn });
  return candidate.status === "READY" && candidate.mtfAnalyzed === true &&
    Number.isFinite(candidate.mtfAnalyzedAt) && now - Number(candidate.mtfAnalyzedAt) >= -5_000 &&
    now - Number(candidate.mtfAnalyzedAt) <= MAX_ENTRY_SCAN_AGE_MS &&
    candidate.plan?.matched === true && candidate.plan.strategyId === candidate.strategyId &&
    candidate.plan.mode === candidate.mode &&
    checkModeMarketFit({ mode: candidate.mode, structureChop: candidate.chop,
      structureAdx: candidate.chopAdx, structureAtrPct: candidate.structureAtrPct,
      biasChop: candidate.biasChop, biasAdx: candidate.biasAdx,
      biasTrend: candidate.biasTrend, biasRegime: candidate.regime }, undefined, lv).allowed &&
    REQUIRED_CANDIDATE_GATES.every((gate) => candidate.gatesPass?.[gate] === true) &&
    Number.isFinite(candidate.score) && candidate.score >= gates.minScore &&
    knnPasses(candidate.knnProb, gates.minKnn);
}

/**
 * Kandidat untuk review LLM (Arka menilai SEMUA di L0).
 * Syarat keras tinggal: MTF segar + volume OK + observasi volatilitas + skor
 * finite + skor >= lantai progresif + market-fit progresif. Plan/regime/trend/
 * skor bukan veto di sini — Arka yang menimbang sebagai BORDERLINE, dan order
 * final tetap butuh GO + semua safety akun/order.
 */
export function isAgentReviewCandidate(candidate: CandidateItem, emptySlots: number, now = Date.now(), levelHint?: ProgressiveLevel): boolean {
  const lv = activeProgressiveLevel(levelHint);
  if (candidate.mtfAnalyzed !== true || !Number.isFinite(candidate.mtfAnalyzedAt)) return false;
  const age = now - Number(candidate.mtfAnalyzedAt);
  if (age < -5_000 || age > MAX_ENTRY_SCAN_AGE_MS) return false;
  if (candidate.gatesPass?.volumeGate !== true || candidate.gatesPass?.volatilityGate !== true) return false;
  if (![candidate.score, candidate.zoneScore, candidate.triggerScore, candidate.trendScore].every((v) => Number.isFinite(v))) return false;
  // Lantai skor per-strategi (S-03 Fib: 65 tetap) menggantikan lantai progresif.
  const reviewFloor = candidateGatesFor(candidate.strategyId,
    { minScore: agentReviewScoreFloor(emptySlots, lv), minKnn: 0 }).minScore;
  if (candidate.score < reviewFloor) return false;
  return checkAgentReviewMarketFit({
    mode: candidate.mode,
    structureChop: candidate.chop,
    structureAdx: candidate.chopAdx,
    structureAtrPct: candidate.structureAtrPct,
    biasChop: candidate.biasChop,
    biasAdx: candidate.biasAdx,
    biasTrend: candidate.biasTrend,
    biasRegime: candidate.regime,
  }, undefined, lv).allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// VETO ANTI-SIDEWAYS PROGRESIF (27 Sep 2026 diketatkan, 28 Sep 2026 dilonggarkan
// bertahap). L0: chop>=70 / ADX<12 baru diveto; L5: kembali 58.3/20.
// Metrik hilang tetap diveto di semua level (tanpa bukti tren = jangan entry).
// ─────────────────────────────────────────────────────────────────────────────
export interface ChopVetoState {
  vetoed: boolean;
  reason: "CHOP_HIGH" | "ADX_LOW" | "METRICS_UNAVAILABLE" | null;
}

export function checkChopVeto(
  chop: number | null | undefined,
  adx: number | null | undefined,
  levelHint?: ProgressiveLevel
): ChopVetoState {
  const c = chop === null || chop === undefined ? NaN : Number(chop);
  const a = adx === null || adx === undefined ? NaN : Number(adx);
  if (!Number.isFinite(c) || !Number.isFinite(a)) return { vetoed: true, reason: "METRICS_UNAVAILABLE" };
  let maxChop = DEFAULT_MAX_CHOPPINESS;
  let minAdx = DEFAULT_MIN_ADX;
  if (progressiveEnabled(env.PROGRESSIVE_ENABLED)) {
    const t = progressiveThresholdsFor(activeProgressiveLevel(levelHint));
    maxChop = t.maxStrictChop;
    minAdx = t.minStrictAdx;
  }
  const chopHigh = Number.isFinite(c) && c >= maxChop;
  const adxLow = Number.isFinite(a) && a < minAdx;
  if (!chopHigh && !adxLow) return { vetoed: false, reason: null };
  return { vetoed: true, reason: chopHigh ? "CHOP_HIGH" : "ADX_LOW" };
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE VOLUME OPERATOR (perintah operator 25 Sep 2026 — FINAL).
//
// KEBIJAKAN: bot hanya trading pair crypto dengan volume futures 24 jam DI ATAS
// env VOLUME_MIN_USD (default $7jt), secara ketat (strictly greater).
// Dicek di scanner dan diulang dari data terbaru sebelum order:
//   1. Scanner — pair di bawah ambang tidak pernah jadi kandidat.
//   2. Entry (tryFillSlots) — dicek ulang dari data pair live sesaat sebelum order,
//      supaya pair yang volumenya anjlok setelah scan tetap ditolak.
// ─────────────────────────────────────────────────────────────────────────────

/** Batas volume 24h (USD) — pair harus DI ATAS angka ini untuk ditradingkan bot. */
export function minTradeVolumeUsd(): number {
  const v = Number(env.VOLUME_MIN_USD);
  return Number.isFinite(v) && v > 0 ? v : 7_000_000;
}

// Lantai tetap: nilai VOLUME_MIN_USD, tanpa floor adaptif. Pair tepat di ambang
// tetap ditolak; hanya volume yang lebih besar yang lolos.
export function setAdaptiveVolumeFloor(_v: unknown): number {
  return getTradeVolumeFloor();
}

/** Lantai efektif = floor tetap (adaptif dicabut). */
export function getTradeVolumeFloor(): number {
  return minTradeVolumeUsd();
}

/** Baca lantai adaptif saat ini (selalu 0 — adaptif dicabut). */
export function getAdaptiveVolumeFloor(): number {
  return 0;
}

export interface VolumeGateState {
  /** true = volume DI ATAS ambang -> boleh ditradingkan bot. */
  allowed: boolean;
  reason: string;
  volumeUsd: number;
  minVolumeUsd: number;
}

/**
 * Cek gate volume untuk satu pair. Volume tidak diketahui / nol / NaN = DITOLAK
 * (bot tidak menebak likuiditas — data harus nyata dari feed futures).
 */
export function checkTradeVolume(volumeUsd: unknown): VolumeGateState {
  const minVol = getTradeVolumeFloor();
  const v = Number(volumeUsd);
  if (!Number.isFinite(v) || v <= 0) {
    return {
      allowed: false,
      reason: `VOLUME_UNKNOWN: volume 24h tidak diketahui — pair illiquid/tak terdata ditolak (batas di atas $${minVol})`,
      volumeUsd: 0,
      minVolumeUsd: minVol,
    };
  }
  if (!(v > minVol)) {
    return {
      allowed: false,
      reason: `VOLUME_BELOW_MIN: volume 24h $${v.toFixed(0)} tidak di atas $${minVol} — pair illiquid ditolak`,
      volumeUsd: v,
      minVolumeUsd: minVol,
    };
  }
  return { allowed: true, reason: "VOLUME_OK", volumeUsd: v, minVolumeUsd: minVol };
}

// ─────────────────────────────────────────────────────────────────────────────
// SATU-SATUNYA ENTRY PER PAIR (perintah operator 25 Sep 2026 — FINAL).
//
// KEBIJAKAN OPERATOR: "maksimal posisi 20, kalau mau entry pair yang sama harus
// terselesaikan dulu trade-nya, baru bisa entry lagi. Kalau di dalam 20 posisi ada
// double entry kan aneh."
//
// Jadi TIDAK ADA toleransi waktu sama sekali (cooldown 30/45 menit DIBATALKAN):
//   * Sebuah pair hanya boleh di-entry ulang SETELAH trade sebelumnya SELESAI
//     (posisi CLOSED: TP2 / BE / SL / TREND_FLIP / FUNDING / KILL).
//   * Selama belum pernah disentuh, pair bebas dipilih bot.
//   * Konsekuensi: 20 slot = 20 PAIR BERBEDA. Tidak akan pernah ada dua posisi
//     dengan simbol sama di daftar OPEN.
//
// Ini aturan khusus crypto: satu pair bergerak cepat & saling berkorelasi dengan
// dirinya sendiri, sehingga entry ulang pada pair yang baru di-stop hanya
// menggandakan kerugian whipsaw (kasus nyata SAGAUSDT #482/#483/#484 = -$3.25
// dalam 6 menit). Daripada mengukur waktu, kita pakai aturan struktural yang
// tidak bisa ditawar: SATU TRADE PER PAIR SAMPAI SELESAI.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cooldown sisi-searah pasca TREND_FLIP (perintah operator 28 Sep 2026).
 *
 * Masalah nyata: pair ditutup TREND_FLIP lalu, menit kemudian, di-entry lagi
 * dengan ARAH YANG SAMA — lalu ditutup TREND_FLIP lagi. Itu pengulangan
 * kesalahan yang sama: trend yang baru dinyatakan berbalik tidak mungkin
 * seketika kembali mendukung arah lama.
 *
 * Kebijakan: setelah close TREND_FLIP, arah yang SAMA pada pair itu diblokir
 * selama TREND_FLIP_SIDE_COOLDOWN_MS (default 30 menit). Arah LAWAN tetap
 * boleh (tetap wajib lolos semua gate: strategi match, makro, Arka, Wardha) —
 * karena "pindah haluan ke short" justru respons yang benar terhadap flip.
 * Close SL/TP1/TP2/BE tidak memicu cooldown ini (itu exit plan normal).
 *
 * Deterministik & murni (tanpa I/O) supaya bisa diuji offline; bot
 * mengisinya (seed) dari db.trade TREND_FLIP terbaru saat boot.
 */
export const TREND_FLIP_SIDE_COOLDOWN_MS = 30 * 60_000;

export class TrendFlipSideCooldownGuard {
  private readonly locked = new Map<string, number>();

  private key(symbol: string, side: string): string {
    return `${String(symbol ?? "").toUpperCase()}|${String(side ?? "").toUpperCase()}`;
  }

  /** Catat close TREND_FLIP untuk arah ini (waktu tutup = sekarang). */
  record(symbol: string, side: string, atMs = Date.now()): void {
    const k = this.key(symbol, side);
    if (k.length > 1 && Number.isFinite(atMs)) this.locked.set(k, atMs);
  }

  /** true = arah ini di pair ini MASIH dalam cooldown -> entry searah DILARANG. */
  isBlocked(symbol: string, side: string, nowMs = Date.now(), cooldownMs = TREND_FLIP_SIDE_COOLDOWN_MS): boolean {
    const at = this.locked.get(this.key(symbol, side));
    if (at === undefined || !Number.isFinite(nowMs) || !Number.isFinite(at)) return false;
    if (nowMs - at >= cooldownMs) {
      this.locked.delete(this.key(symbol, side));
      return false;
    }
    return true;
  }

  /** Sisa cooldown (ms) untuk observability; 0 = tidak diblokir. */
  remainingMs(symbol: string, side: string, nowMs = Date.now(), cooldownMs = TREND_FLIP_SIDE_COOLDOWN_MS): number {
    const at = this.locked.get(this.key(symbol, side));
    if (at === undefined) return 0;
    return Math.max(0, cooldownMs - (nowMs - at));
  }

  /** Hapus semua catatan (dipakai test). */
  clear(): void {
    this.locked.clear();
  }
}

/** Singleton guard yang dipakai bot AI (pair+sisi yang baru ditutup TREND_FLIP). */
export const trendFlipSideCooldown = new TrendFlipSideCooldownGuard();

/**
 * Cooldown re-entry pasca-CLOSE untuk cegah double-loss (perintah operator 2 Okt 2026).
 *
 * Masalah nyata: pair baru saja ditutup (SL/TP/BE/TREND_FLIP - apa pun alasannya)
 * lalu, dalam hitungan menit, di-entry LAGI di pair yang sama dan langsung rugi
 * lagi. Setelah posisi ditutup, pasar pada pair itu butuh waktu; re-entry kilat
 * hanya mengulang kerugian (double-loss beruntun).
 *
 * Kebijakan: setelah SESEBUAH posisi pada pair ditutup, SEMUA entry baru pada pair
 * itu - LONG maupun SHORT (kedua sisi) - diblokir selama REENTRY_COOLDOWN_MS
 * (60 menit sejak 13 Okt 2026). Berbeda dari TrendFlipSideCooldownGuard (hanya memblokir sisi
 * yang sama pasca TREND_FLIP), guard ini berlaku untuk SEGALA jenis close dan SEGALA
 * arah: inilah jaring pengaman double-loss.
 *
 * Deterministik & murni (tanpa I/O) supaya bisa diuji offline; bot mengisinya (seed)
 * dari close terbaru di DB saat boot, dan me-record setiap close saat supervise.
 */
// Perintah operator 13 Okt 2026: 10 -> 60 menit (pasca insiden GTCUSDT: re-entry
// same-pair 38 menit setelah SL lalu loss lagi; pola double-loss harus dibekukan).
// Perintah operator 14 Okt 2026 (plan Big Brain Tahap A3): 60 -> 120 menit.
// Base cooldown per-simbol 2 jam; eskalasi lanjutan via SymbolProbationGuard
// (3 loss beruntun -> blokir sampai besok UTC, lihat PROBATION_BLOCK_MS).
export const REENTRY_COOLDOWN_MS = 120 * 60_000;

/**
 * 13 Okt 2026 (S-05, perintah operator): jeda WAJIB antar entry swing (simbol
 * apapun) — anti konvoi breakout serentak (5 simbol sinyal di bar 1h yang
 * sama). Murni deterministik; bot me-record setiap entry swing (dan seed dari
 * posisi swing yang sudah open saat boot).
 * 15 Okt 2026 (perintah operator): spacing DINONAKTIFKAN di PAPER (riset
 * butuh sampel entry sebanyak-banyaknya utk data paper/backtest); LIVE tetap
 * anti-konvoi. Kapasitas posisi (SWING_MAX_POSITIONS,
 * LIVE_MAX_OPEN_POSITIONS) TIDAK diubah.
 * 28 Okt 2026 (perintah operator "pilih C"): LIVE 60 -> 15 menit supaya slot
 * cepat terisi saat kandidat muncul beruntun. Catatan audit: gate ini 0x
 * memblokir 22-28 Okt (SWING_GATE_BLOCKED: spacing = 0 di journal), jadi
 * penurunan ini preventif — bottleneck nyata tetap kelangkaan kandidat +
 * gate kualitas, bukan jeda antar-entry.
 */
export const SWING_ENTRY_SPACING_MS_LIVE = 15 * 60_000;

/** Spacing efektif sesuai mode eksekusi: PAPER = 0 (off), LIVE = 15 menit. */
export function swingEntrySpacingMs(): number {
  return env.BINANCE_EXECUTION_MODE === "LIVE" ? SWING_ENTRY_SPACING_MS_LIVE : 0;
}

export class SwingEntrySpacingGuard {
  private lastEntryAt: number | null = null;

  record(atMs = Date.now()): void {
    if (Number.isFinite(atMs)) this.lastEntryAt = atMs;
  }

  /** Seed dari data eksternal (posisi S-05 open saat boot). */
  seed(lastAtMs: number | null): void {
    if (lastAtMs !== null && Number.isFinite(lastAtMs)) this.lastEntryAt = lastAtMs;
  }

  isBlocked(atMs = Date.now()): boolean {
    const spacing = swingEntrySpacingMs();
    if (spacing <= 0) return false; // PAPER (15 Okt 2026): spacing off
    return this.lastEntryAt !== null && atMs - this.lastEntryAt < spacing;
  }

  msRemaining(atMs = Date.now()): number {
    const spacing = swingEntrySpacingMs();
    if (spacing <= 0 || this.lastEntryAt === null) return 0;
    return Math.max(0, spacing - (atMs - this.lastEntryAt));
  }
}
export const swingEntrySpacing = new SwingEntrySpacingGuard();

export class PostCloseReentryCooldownGuard {
  private readonly closedAt = new Map<string, number>();

  private key(symbol: string): string {
    return String(symbol ?? "").toUpperCase();
  }

  /** Catat close posisi pada pair ini (waktu tutup = sekarang) - blokir re-entry 60 menit (13 Okt 2026). */
  record(symbol: string, atMs = Date.now()): void {
    const k = this.key(symbol);
    if (k && Number.isFinite(atMs)) this.closedAt.set(k, atMs);
  }

  /** true = pair ini BARU saja ditutup -> re-entry (sisi apa pun) DILARANG. */
  isBlocked(symbol: string, nowMs = Date.now(), cooldownMs = REENTRY_COOLDOWN_MS): boolean {
    const k = this.key(symbol);
    const at = this.closedAt.get(k);
    if (at === undefined || !Number.isFinite(nowMs) || !Number.isFinite(at)) return false;
    if (nowMs - at >= cooldownMs) {
      this.closedAt.delete(k);
      return false;
    }
    return true;
  }

  /** Sisa cooldown (ms) untuk observability; 0 = tidak diblokir. */
  remainingMs(symbol: string, nowMs = Date.now(), cooldownMs = REENTRY_COOLDOWN_MS): number {
    const at = this.closedAt.get(this.key(symbol));
    if (at === undefined) return 0;
    return Math.max(0, cooldownMs - (nowMs - at));
  }

  /** Hapus semua catatan (dipakai test). */
  clear(): void {
    this.closedAt.clear();
  }
}

/** Singleton: pair yang baru saja ditutup (sisi apa pun) - cegah re-entry double-loss. */
export const postCloseReentryCooldown = new PostCloseReentryCooldownGuard();

/**
 * Penjaga "probation simbol" — anti-churn (keputusan operator 4 Okt 2026).
 *
 * Kebijakan: setelah PROBATION_LOSS_STREAK loss BERUNTUN pada simbol yang sama,
 * simbol itu DIBLOKIR dari entry baru (kedua sisi) selama PROBATION_BLOCK_MS.
 * Win memutuskan streak (reset ke 0). Setelah masa blokir habis, streak mulai
 * dari 0 lagi (fresh start).
 *
 * Deterministik & murni (tanpa I/O) supaya bisa diuji offline; bot mengisi
 * (seed) dari DB saat boot dan memanggil recordClose setiap posisi ditutup.
 */
export const PROBATION_LOSS_STREAK = 3;
// 14 Okt 2026 (plan Big Brain Tahap A3, perintah operator): 45 menit ->
// blokir sampai awal hari UTC berikutnya (dihitung di titik kejadian, bukan
// konstanta). Eskalasi level 3: dua guard di atasnya (2 jam per-simbol +
// 60 menit global SL) tidak cukup menahan simbol yang sudah membuktikan
// dirinya toxicity 3 kali beruntun.
export function probationBlockUntil(atMs = Date.now()): number {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export class SymbolProbationGuard {
  private readonly lossStreak = new Map<string, number>();
  private readonly blockedUntil = new Map<string, number>();

  private key(symbol: string): string {
    return String(symbol ?? "").toUpperCase();
  }

  /** Catat hasil close posisi pada simbol ini. */
  recordClose(symbol: string, win: boolean, atMs = Date.now()): void {
    const k = this.key(symbol);
    if (!k) return;
    if (win) {
      this.lossStreak.delete(k);
      return;
    }
    const streak = (this.lossStreak.get(k) ?? 0) + 1;
    if (streak >= PROBATION_LOSS_STREAK) {
      this.blockedUntil.set(k, probationBlockUntil(atMs));
      this.lossStreak.delete(k);
    } else {
      this.lossStreak.set(k, streak);
    }
  }

  /** true = simbol masih dalam masa probation -> entry DILARANG. */
  isBlocked(symbol: string, nowMs = Date.now()): boolean {
    const k = this.key(symbol);
    const until = this.blockedUntil.get(k);
    if (until === undefined || !Number.isFinite(nowMs)) return false;
    if (nowMs >= until) {
      this.blockedUntil.delete(k);
      return false;
    }
    return true;
  }

  /** Sisa blokir (ms) untuk observability; 0 = tidak diblokir. */
  remainingMs(symbol: string, nowMs = Date.now()): number {
    const until = this.blockedUntil.get(this.key(symbol));
    if (until === undefined) return 0;
    return Math.max(0, until - nowMs);
  }

  /** Seed streak & blokir dari data DB saat boot. */
  seed(symbol: string, consecutiveLosses: number, lastLossAtMs: number): void {
    const k = this.key(symbol);
    if (!k || !Number.isFinite(consecutiveLosses) || !Number.isFinite(lastLossAtMs)) return;
    if (consecutiveLosses >= PROBATION_LOSS_STREAK) {
      const until = probationBlockUntil(lastLossAtMs);
      if (until > Date.now()) {
        this.blockedUntil.set(k, until);
      }
    } else if (consecutiveLosses > 0) {
      this.lossStreak.set(k, consecutiveLosses);
    }
  }

  /** Streak loss saat ini (observability). */
  currentStreak(symbol: string): number {
    return this.lossStreak.get(this.key(symbol)) ?? 0;
  }

  /** Hapus semua catatan (dipakai test). */
  clear(): void {
    this.lossStreak.clear();
    this.blockedUntil.clear();
  }
}

/** Singleton: probation simbol anti-churn (3 loss beruntun -> blokir 45 menit). */
export const symbolProbation = new SymbolProbationGuard();

/**
 * Kunci sisi strategi (T-13, FAS A — keputusan operator 4 Okt 2026).
 * Dasar data 72 trade Liquidity Sweep Reclaim SHORT: WR 38,9% EV -0,170R
 * (sumber rugi terbesar). Guard kebijakan murni seperti SymbolProbationGuard —
 * bukan parameter tuning.
 * CATATAN RENUMBER 6 Okt 2026: target lock mengikuti STRATEGINYA (Liquidity
 * Sweep Reclaim, kini ID S-01), bukan nomor lamanya (S-03).
 *
 * 21 Okt 2026 (Phase 4c, keputusan operator "Hapus total, S-01 SHORT terkunci
 * permanen"): saklar env S03_SHORT_ENABLED dihapus total, jadi kunci ini
 * PERMANEN — tidak ada env yang bisa membukanya lagi. Argumen boolean
 * dihapus dari signature supaya tidak ada caller yang mengira masih bisa
 * override.
 *
 * Catatan runtime: S-01 sendiri sudah hard-gated keluar dari semua allowlist
 * (lihat scalpCatalog.allowedScalpStrategies()), sehingga strategyId "S-01"
 * tidak pernah sampai ke guard ini. Kunci tetap dipertahankan sebagai
 * fail-closed bila S-01 suatu saat diaktifkan kembali.
 */
export function isStrategySideLocked(
  strategyId: string | null | undefined,
  side: string | null | undefined,
): boolean {
  const sid = String(strategyId ?? "").toUpperCase();
  const sd = String(side ?? "").toUpperCase();
  return sid === "S-01" && sd === "SHORT";
}


/**
 * Penjaga "pair sudah pernah ditrade di sesi ini".
 *
 * Dipakai bot: setiap kali posisi dibuka, simbol dicatat di sini; kandidat dengan
 * simbol yang sudah tercatat DILEWATI sampai ada posisi untuk simbol itu yang
 * ditutup (dipanggil `release()` saat supervise menemukan posisi CLOSED).
 *
 * Klasifikasi deterministik & murni (tanpa I/O) supaya bisa diuji offline.
 */
export class EntryOncePerPairGuard {
  private readonly touched = new Set<string>();

  private key(symbol: string): string {
    return String(symbol ?? "").toUpperCase();
  }

  /** Sudah pernah di-entry (dan belum dirilis)? -> entry baru DILARANG. */
  isBlocked(symbol: string): boolean {
    return this.touched.has(this.key(symbol));
  }

  /** Catat pair yang baru saja dibuka posisinya. */
  mark(symbol: string): void {
    const k = this.key(symbol);
    if (k) this.touched.add(k);
  }

  /** Lepas pair karena trade-nya SUDAH SELESAI (posisi CLOSED) -> boleh entry lagi. */
  release(symbol: string): void {
    this.touched.delete(this.key(symbol));
  }

  /** Daftar pair yang masih terpakai (audit/observability). */
  active(): string[] {
    return [...this.touched].sort();
  }

  size(): number {
    return this.touched.size;
  }
}

/** Singleton guard yang dipakai bot AI (pair yang sudah ditrade di sesi ini). */
export const entryOncePerPair = new EntryOncePerPairGuard();

export interface PairRedundancyState {
  /** true = pair masih terpakai (posisi OPEN / trade belum selesai) -> DILARANG entry ulang. */
  blocked: boolean;
  reason: string;
}

/**
 * Cek redundansi pair dari DATA DB (bukan cache): berapa posisi OPEN untuk simbol ini.
 * Dipakai sebagai lapis terakhir sebelum order & di jalur manual.
 */
export function checkPairRedundancy(openCountForSymbol: number): PairRedundancyState {
  const n = Math.max(0, Math.floor(Number(openCountForSymbol) || 0));
  if (n > 0) {
    return {
      blocked: true,
      reason: `PAIR_TRADE_BELUM_SELESAI: ${n} posisi OPEN untuk simbol ini — entry ulang hanya boleh setelah trade-nya CLOSED`,
    };
  }
  return { blocked: false, reason: "PAIR_BEBAS" };
}
