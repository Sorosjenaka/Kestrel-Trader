// apps/server/src/exec/progressivePolicy.ts - KEBIJAKAN EKSPLORASI PROGRESIF
// (perintah operator 28 Sep 2026: "buat jadi ga ketat, LLM agent menilai semua,
//  secara bertahap menaikkan nilainya jadi trading yang bagus").
//
// Ide: kurikulum, bukan saklar longgar permanen.
//  - L0 EKSPLORASI: ambang rendah (skor 45, KNN 0, chop 75, ADX 10), sideways boleh
//    direview sebagai BORDERLINE, LLM boleh GO via EXPLORATION_GO walau skor di
//    bawah ambang ketat. Tujuannya: LLM menilai SEMUA kandidat MTF segar + volume OK.
//  - L1..L4: naik bertahap (50 -> 55 -> 60 -> 64) HANYA bila bukti PAPER membaik.
//  - L5 DISIPLIN: 68 / 55% / 58.3 / 20 seperti sebelum perintah ini.
//
// Safety yang TIDAK PERNAH dilonggarkan level berapa pun:
//  risiko $1, margin cap 40% & margin level 70% equity, band SL <=2.5%,
//  1 posisi per simbol, futures PERPETUAL crypto-only, harga live, volume > VOLUME_MIN_USD,
//  equity/arm/guard harian. Yang dilonggarkan hanya gate KUALITAS (skor, KNN,
//  chop/ADX, regime/bias, plan wajib, macro override) — dan itu pun naik lagi
//  otomatis saat bukti membaik.
//
// Resolusi level AUTO (murni, tanpa I/O — bisa diuji offline):
//  level = min(levelDariJumlah, levelDariKualitas). Artinya performa buruk TIDAK
//  menaikkan level (tetap eksplorasi), performa bagus menaikkan ambang bertahap.

export type ProgressiveLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ProgressiveThresholds {
  level: ProgressiveLevel;
  /** Ambang skor gabungan untuk deterministicPass Arka (soft bila allowExplorationGo). */
  minScore: number;
  /** Ambang KNN (0 = KNN apa pun lolos, null tetap lolos). */
  minKnn: number;
  /** Lantai review per slot: [e>=10, e>=5, e>=1, penuh]. */
  reviewFloors: [number, number, number, number];
  /** Batas chop untuk REVIEW (di atas ini tidak sampai ke LLM sama sekali). */
  maxReviewChop: number;
  /** Batas ADX untuk REVIEW (di bawah ini tidak sampai ke LLM). */
  minReviewAdx: number;
  /** Batas chop untuk gate STRICT/READY (final order). */
  maxStrictChop: number;
  /** Batas ADX untuk gate STRICT/READY. */
  minStrictAdx: number;
  /** true = bias NEUTRAL / regime RANGING/UNCERTAIN boleh masuk review LLM (label BORDERLINE). */
  allowSidewaysReview: boolean;
  /** Final order always requires a real match from an active S-01/S-02/S-03/S-04/S-05 setup. */
  requireStrictPlan: boolean;
  /** true = kandidat gagal macro boleh tetap direview & dieksekusi via override eksplorasi. */
  allowMacroOverride: boolean;
  /** true = LLM GO boleh override skor/KNN rendah (EXPLORATION_GO). */
  allowExplorationGo: boolean;
  /** Keyakinan LLM minimum agar EXPLORATION_GO sah (0-99). */
  explorationMinConfidence: number;
  directive: string;
}

const DIRECTIVES: Record<ProgressiveLevel, string> = {
  0: "MODE EKSPLORASI L0: nilai SEMUA kandidat MTF segar + volume OK. Ambang lunak 45; GO boleh untuk setup borderline yang menjanjikan.",
  1: "MODE EKSPLORASI L1: ambang lunak 50. LLM menilai luas; pilih yang konfluensinya paling meyakinkan.",
  2: "MODE TRANSISI L2: ambang 55. Mulai selektif; sideways hanya bila bukti tren kuat.",
  3: "MODE PENGETATAN L3: ambang 60. Kualitas di atas kuantitas; borderline wajib alasan kuat.",
  4: "MODE HAMPIR DISIPLIN L4: ambang 64. Hampir ketat; hanya setup rapi yang GO.",
  5: "MODE DISIPLIN L5: ambang 68 & KNN 55%. Slot kosong bukan alasan override.",
};

export function progressiveThresholdsFor(level: ProgressiveLevel): ProgressiveThresholds {
  switch (level) {
    case 0:
      return {
        level, minScore: 45, minKnn: 0, reviewFloors: [40, 42, 44, 45],
        maxReviewChop: 75, minReviewAdx: 10, maxStrictChop: 70, minStrictAdx: 12,
        allowSidewaysReview: true, requireStrictPlan: true,
        allowMacroOverride: true, allowExplorationGo: true,
        explorationMinConfidence: 55, directive: DIRECTIVES[0],
      };
    case 1:
      return {
        level, minScore: 50, minKnn: 0, reviewFloors: [45, 47, 49, 50],
        maxReviewChop: 70, minReviewAdx: 12, maxStrictChop: 65, minStrictAdx: 14,
        allowSidewaysReview: true, requireStrictPlan: true,
        allowMacroOverride: true, allowExplorationGo: true,
        explorationMinConfidence: 60, directive: DIRECTIVES[1],
      };
    case 2:
      return {
        level, minScore: 55, minKnn: 0.4, reviewFloors: [50, 52, 54, 55],
        maxReviewChop: 65, minReviewAdx: 15, maxStrictChop: 62, minStrictAdx: 16,
        allowSidewaysReview: true, requireStrictPlan: true,
        allowMacroOverride: false, allowExplorationGo: true,
        explorationMinConfidence: 65, directive: DIRECTIVES[2],
      };
    case 3:
      return {
        level, minScore: 60, minKnn: 0.5, reviewFloors: [55, 57, 59, 60],
        maxReviewChop: 62, minReviewAdx: 18, maxStrictChop: 60, minStrictAdx: 18,
        allowSidewaysReview: false, requireStrictPlan: true,
        allowMacroOverride: false, allowExplorationGo: false,
        explorationMinConfidence: 70, directive: DIRECTIVES[3],
      };
    case 4:
      return {
        level, minScore: 64, minKnn: 0.55, reviewFloors: [58, 60, 62, 64],
        maxReviewChop: 60, minReviewAdx: 20, maxStrictChop: 58.3, minStrictAdx: 20,
        allowSidewaysReview: false, requireStrictPlan: true,
        allowMacroOverride: false, allowExplorationGo: false,
        explorationMinConfidence: 75, directive: DIRECTIVES[4],
      };
    case 5:
    default:
      return {
        level: 5, minScore: 68, minKnn: 0.55, reviewFloors: [55, 60, 64, 68],
        maxReviewChop: 65, minReviewAdx: 15, maxStrictChop: 58.3, minStrictAdx: 20,
        allowSidewaysReview: false, requireStrictPlan: true,
        allowMacroOverride: false, allowExplorationGo: false,
        explorationMinConfidence: 80, directive: DIRECTIVES[5],
      };
  }
}

export interface ProgressiveEvidence {
  /** Jumlah trade PAPER terverifikasi (VERIFIED/SIMULATED, bukan LEGACY/DEMO). */
  verifiedTrades: number;
  /** Winrate 0..1 pada jendela bukti (null = belum ada bukti). */
  winrate: number | null;
  /** Expectancy USD/trade pada jendela bukti (null = belum ada bukti). */
  expectancyUsd: number | null;
}

/** Level dari JUMLAH bukti saja (tanpa kualitas). */
export function levelFromCount(verifiedTrades: number): ProgressiveLevel {
  const n = Math.max(0, Math.floor(Number(verifiedTrades) || 0));
  if (n >= 1000) return 5;
  if (n >= 500) return 4;
  if (n >= 200) return 3;
  if (n >= 100) return 2;
  if (n >= 30) return 1;
  return 0;
}

/** Level dari KUALITAS bukti saja (tanpa jumlah). */
export function levelFromQuality(ev: ProgressiveEvidence): ProgressiveLevel {
  const wr = ev.winrate;
  const ex = ev.expectancyUsd;
  if (wr === null || wr === undefined || !Number.isFinite(wr)) return 0;
  if (ex === null || ex === undefined || !Number.isFinite(ex)) {
    // Ada winrate tapi belum ada expectancy: batasi sampai L2.
    if (wr >= 0.57) return 2;
    if (wr >= 0.52) return 1;
    return 0;
  }
  if (wr >= 0.57 && ex > 0.1) return 5;
  if (wr >= 0.55 && ex > 0.05) return 4;
  if (wr >= 0.5 && ex > 0) return 3;
  if (wr >= 0.47 && ex > -0.05) return 2;
  if (wr >= 0.42) return 1;
  return 0;
}

/**
 * Resolusi AUTO: level = min(jumlah, kualitas). Performa buruk menahan level
 * tetap rendah (tetap eksplorasi, tidak mengencang prematur); performa bagus
 * menaikkan ambang bertahap menuju disiplin.
 */
export function resolveAutoLevel(ev: ProgressiveEvidence): ProgressiveLevel {
  const byCount = levelFromCount(ev.verifiedTrades);
  const byQuality = levelFromQuality(ev);
  return Math.min(byCount, byQuality) as ProgressiveLevel;
}

/** Parse override env: "0".."5" atau "AUTO" (default AUTO). */
export function parseLevelOverride(raw: unknown): ProgressiveLevel | "AUTO" {
  const s = String(raw ?? "AUTO").trim().toUpperCase();
  if (s === "" || s === "AUTO") return "AUTO";
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n as ProgressiveLevel;
  return "AUTO";
}

/** Resolusi final: override angka menang, AUTO memakai bukti. */
export function resolveProgressiveLevel(ev: ProgressiveEvidence, overrideRaw: unknown = "AUTO"): ProgressiveLevel {
  const o = parseLevelOverride(overrideRaw);
  if (o !== "AUTO") return o;
  return resolveAutoLevel(ev);
}

/** Lantai review untuk jumlah slot kosong tertentu pada level tertentu. */
export function reviewFloorFor(emptySlots: number, level: ProgressiveLevel): number {
  const t = progressiveThresholdsFor(level);
  const e = Math.max(0, Math.floor(emptySlots));
  if (e >= 10) return t.reviewFloors[0];
  if (e >= 5) return t.reviewFloors[1];
  if (e >= 1) return t.reviewFloors[2];
  return t.reviewFloors[3];
}

/** Apakah switch progresif aktif (env PROGRESSIVE_ENABLED, default true). */
export function progressiveEnabled(envVal: unknown = process.env.PROGRESSIVE_ENABLED): boolean {
  if (envVal === undefined || envVal === null || String(envVal).trim() === "") return true;
  return /^(1|true|yes|on)$/i.test(String(envVal).trim());
}

/** Override level dari env (PROGRESSIVE_LEVEL_OVERRIDE, default AUTO). */
export function progressiveOverride(envVal: unknown = process.env.PROGRESSIVE_LEVEL_OVERRIDE): ProgressiveLevel | "AUTO" {
  return parseLevelOverride(envVal ?? "AUTO");
}
