import { DEFAULT_MAX_CHOPPINESS, DEFAULT_MIN_ADX } from "../universe/eligibility.js";
import { env } from "../core/env.js";
import { progressiveEnabled, progressiveOverride, progressiveThresholdsFor, resolveProgressiveLevel, type ProgressiveLevel } from "./progressivePolicy.js";

// 30 Sep 2026 — refactor SCALP-only: hanya ada satu mode di kode ini.
export type MarketSelectionMode = "SCALP";

// ATR(14) 5m / close * 100. Kebijakan awal operator; validasi historis tetap diperlukan.
export const MIN_SCALP_STRUCTURE_ATR_PCT = 0.15;

export interface MarketSelectionInput {
  mode: MarketSelectionMode;
  structureChop: number | null | undefined;
  structureAdx: number | null | undefined;
  structureAtrPct: number | null | undefined;
  biasChop: number | null | undefined;
  biasAdx: number | null | undefined;
  biasTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null | undefined;
  biasRegime: string | null | undefined;
}

export type MarketSelectionReason = "METRICS_UNAVAILABLE" | "CHOP_HIGH" | "ADX_LOW" |
  "BIAS_SIDEWAYS" | "SCALP_VOLATILITY_LOW" | "REGIME_NOT_TRENDING_VOLATILE";

/**
 * Perintah operator 29 Sep 2026: "gw ga mau trading di chart sideaways" +
 * "scalping ini harus berburu koin yang top perform dan loser yang market nya
 * voletail dan trending".
 *
 * Kebijakan: entry HANYA pada regime TRENDING, dan arah bias
 * (15m/4h) tidak boleh NEUTRAL. Level progresif hanya mengatur angka skor/KNN/
 * chop/ADX — TIDAK PERNAH membuka jalan entry sideways, bahkan di L0.
 */
// 14 Okt 2026 (plan Big Brain Tahap A4, perintah operator): VOLATILE
// (ATR spike > 2x baseline = chaos/likuiditas kering) DIKELUARKAN dari regime
// yang boleh entry. Entry HANYA di TRENDING. Shield ATR tetap memblokir
// lewat jalur volatilityGate.
export const ALLOWED_ENTRY_REGIMES = ["TRENDING"] as const;

/** true = pasar sideways/tak berarah -> tidak boleh masuk kandidat entry. */
export function isSidewaysBias(input: MarketSelectionInput): boolean {
  const regime = String(input.biasRegime ?? "").trim().toUpperCase();
  return input.biasTrend === "NEUTRAL" || !ALLOWED_ENTRY_REGIMES.includes(regime as (typeof ALLOWED_ENTRY_REGIMES)[number]);
}

/** Saklar operator: sideways TIDAK PERNAH boleh entry (default WAJIB). */
export function sidewaysEntryAllowed(envVal: unknown = env.SIDEWAYS_ENTRY_ALLOWED): boolean {
  if (envVal === undefined || envVal === null || String(envVal).trim() === "") return false;
  return /^(1|true|yes|on)$/i.test(String(envVal).trim());
}

// ── 13 Okt 2026 — GATE TOP-LOSER (perintah operator: "boleh trade di top loser
// AKAN TETAPI MAKSIMAL -15%"). Koin yang jatuh > 15% dalam 24 jam DILARANG:
// volume sell sudah habis, short di dasar = R:R buruk (JCTUSDT -39.9% dan
// USUSDT -37.6% lolos tanpa filter ini -> keduanya loss).
export const MAX_LOSER_DROP_PCT = 15;

export function loserDropAllowed(
  chg24h: number | null | undefined,
  limitPct: number = MAX_LOSER_DROP_PCT,
): { allowed: boolean; reason: string | null } {
  if (chg24h == null || !Number.isFinite(chg24h)) return { allowed: false, reason: "LOSER_CHG_UNAVAILABLE" };
  if (chg24h < -Math.abs(limitPct)) {
    return { allowed: false, reason: `LOSER_DROP_TOO_DEEP_${chg24h.toFixed(2)}PCT_MAX_-${Math.abs(limitPct)}` };
  }
  return { allowed: true, reason: null };
}

/** Override eksplisit level progresif (dipakai bot saat level AUTO sudah di-resolve). */
export interface MarketFitOverride {
  maxChop?: number;
  minAdx?: number;
  allowSideways?: boolean;
}

/**
 * Review envelope for Arka. Progresif (perintah operator 28 Sep 2026):
 * L0 menilai hampir semua (chop<75, ADX>=10, sideways boleh sebagai BORDERLINE),
 * naik bertahap ke 65/15 di L5. Tanpa data = tetap diblokir di semua level.
 * Ini hanya memutuskan apakah kandidat boleh DIREVIEW LLM, bukan otorisasi order.
 */
export function checkAgentReviewMarketFit(
  input: MarketSelectionInput,
  override?: MarketFitOverride,
  levelHint?: ProgressiveLevel
): { allowed: boolean; reason: MarketSelectionReason | null } {
  const metrics = [input.structureChop, input.structureAdx, input.biasChop, input.biasAdx];
  if (metrics.some((value) => value == null || !Number.isFinite(value))) {
    return { allowed: false, reason: "METRICS_UNAVAILABLE" };
  }
  let maxChop = 65;
  let minAdx = 15;
  let allowSideways = false;
  if (override?.maxChop !== undefined || override?.minAdx !== undefined || override?.allowSideways !== undefined) {
    maxChop = override.maxChop ?? maxChop;
    minAdx = override.minAdx ?? minAdx;
    allowSideways = override.allowSideways ?? allowSideways;
  } else if (progressiveEnabled(env.PROGRESSIVE_ENABLED)) {
    const lv: ProgressiveLevel = levelHint ?? resolveProgressiveLevel(
      { verifiedTrades: 0, winrate: null, expectancyUsd: null },
      progressiveOverride(env.PROGRESSIVE_LEVEL_OVERRIDE)
    );
    const t = progressiveThresholdsFor(lv);
    maxChop = t.maxReviewChop;
    minAdx = t.minReviewAdx;
    allowSideways = t.allowSidewaysReview;
  }
  // 29 Sep 2026 (perintah operator): sideways DILARANG di SEMUA level.
  if (!sidewaysEntryAllowed() && isSidewaysBias(input)) {
    return { allowed: false, reason: "BIAS_SIDEWAYS" };
  }
  if (Number(input.structureChop) >= maxChop || Number(input.biasChop) >= maxChop) {
    return { allowed: false, reason: "CHOP_HIGH" };
  }
  if (Number(input.structureAdx) < minAdx || Number(input.biasAdx) < minAdx) {
    return { allowed: false, reason: "ADX_LOW" };
  }
  if (!allowSideways &&
    (input.biasTrend === "NEUTRAL" || input.biasRegime === "RANGING" || input.biasRegime === "UNCERTAIN")) {
    return { allowed: false, reason: "BIAS_SIDEWAYS" };
  }
  return { allowed: true, reason: null };
}

/**
 * Gate tren final (STRICT/READY). Progresif: L0 longgar (70/12), naik bertahap
 * ke 58.3/20 di L4-L5. Sideways tetap ditolak di L3+; di L0-L2 sideways boleh
 * lolos ke LLM sebagai BORDERLINE tapi order final tetap butuh GO eksplorasi.
 */
export function checkModeMarketFit(
  input: MarketSelectionInput,
  override?: MarketFitOverride,
  levelHint?: ProgressiveLevel
): { allowed: boolean; reason: MarketSelectionReason | null } {
  const metrics = [input.structureChop, input.structureAdx, input.biasChop, input.biasAdx];
  if (metrics.some((value) => value == null || !Number.isFinite(value))) {
    return { allowed: false, reason: "METRICS_UNAVAILABLE" };
  }
  let maxChop = DEFAULT_MAX_CHOPPINESS;
  let minAdx = DEFAULT_MIN_ADX;
  let allowSideways = false;
  if (override?.maxChop !== undefined || override?.minAdx !== undefined || override?.allowSideways !== undefined) {
    maxChop = override.maxChop ?? maxChop;
    minAdx = override.minAdx ?? minAdx;
    allowSideways = override.allowSideways ?? allowSideways;
  } else if (progressiveEnabled(env.PROGRESSIVE_ENABLED)) {
    const lv: ProgressiveLevel = levelHint ?? resolveProgressiveLevel(
      { verifiedTrades: 0, winrate: null, expectancyUsd: null },
      progressiveOverride(env.PROGRESSIVE_LEVEL_OVERRIDE)
    );
    const t = progressiveThresholdsFor(lv);
    maxChop = t.maxStrictChop;
    minAdx = t.minStrictAdx;
    allowSideways = t.allowSidewaysReview;
  }
  // 29 Sep 2026 (perintah operator): sideways DILARANG di SEMUA level,
  // termasuk L0 eksplorasi. Level progresif hanya mengeraskan angka.
  if (!sidewaysEntryAllowed() && isSidewaysBias(input)) {
    return { allowed: false, reason: "BIAS_SIDEWAYS" };
  }
  if (Number(input.structureChop) >= maxChop || Number(input.biasChop) >= maxChop) {
    return { allowed: false, reason: "CHOP_HIGH" };
  }
  if (Number(input.structureAdx) < minAdx || Number(input.biasAdx) < minAdx) {
    return { allowed: false, reason: "ADX_LOW" };
  }
  if (!allowSideways &&
    (input.biasTrend === "NEUTRAL" || input.biasRegime === "RANGING" || input.biasRegime === "UNCERTAIN")) {
    return { allowed: false, reason: "BIAS_SIDEWAYS" };
  }
  return { allowed: true, reason: null };
}

/**
 * 13 Okt 2026 (S-05 Swing Breakout): mode SWING TIDAK memakai gate chop/ADX/
 * anti-sideways SCALP — trigger S-05 adalah breakout channel pivot konvergen
 * pada bar 1h tertutup (mesin port 1:1 riset, paritas 877 sinyal); memaksa
 * ambang chop/ADX 5m/15m SCALP ke atasnya = sinyal riset 16/16 rusak. Gate arah
 * milik sinyal mesin (breakout menentukan LONG/SHORT); hanya METRICS_UNAVAILABLE
 * (tidak ada data sama sekali) yang tetap menolak.
 */
export function checkSwingMarketFit(
  input: Pick<MarketSelectionInput, "structureChop" | "structureAdx" | "biasChop" | "biasAdx">
): { allowed: boolean; reason: "METRICS_UNAVAILABLE" | null } {
  const metrics = [input.structureChop, input.structureAdx, input.biasChop, input.biasAdx];
  if (metrics.some((value) => value == null || !Number.isFinite(value))) {
    return { allowed: false, reason: "METRICS_UNAVAILABLE" };
  }
  return { allowed: true, reason: null };
}
