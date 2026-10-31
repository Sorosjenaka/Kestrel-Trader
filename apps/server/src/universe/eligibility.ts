// apps/server/src/universe/eligibility.ts - Filter Volume & Anti-Sideway (FR-03, FR-04, US-04).
//  - Volume futures 24j > VOLUME_MIN_USD (default $7.000.000; strict-greater)
//    -> nilai tepat/di bawah ambang ditolak dengan alasan "VOLUME_BELOW_MIN"
//  - Anti-sideway: Choppiness Index (14) < 58.3 AND ADX(14) >= 20 (FR-04)
//    - CHOP >= 58.3 -> "CHOP_HIGH" (pasar sideway / konsolidasi)
//    - ADX < 20.0 -> "ADX_LOW" (tidak ada tren terarah)
//  - Blacklist manual / klasifikasi non-crypto SELALU menang (Rules §1.8) -> "BLACKLISTED"
//  - Data klines kurang (< 28 bar) -> "INSUFFICIENT_KLINES"
//  - Formula deterministik murni tanpa floating non-standar (Rules §1.1)
//  - Repo & time disuntik -> 100% unit test offline tanpa DB/jaringan.
import { db } from "../core/db.js";
import { env } from "../core/env.js";

export const DEFAULT_MIN_VOLUME_USD = env.VOLUME_MIN_USD;
export const DEFAULT_MAX_CHOPPINESS = 58.3;
export const DEFAULT_MIN_ADX = 20.0;
export const DEFAULT_CHOP_PERIOD = 14;
export const DEFAULT_ADX_PERIOD = 14;

export const REASON_VOLUME_LOW = "VOLUME_BELOW_MIN";
export const REASON_CHOP_HIGH = "CHOP_HIGH";
export const REASON_ADX_LOW = "ADX_LOW";
export const REASON_BLACKLISTED = "BLACKLISTED";
export const REASON_INSUFFICIENT_KLINES = "INSUFFICIENT_KLINES";

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EligibilityParams {
  minVolume24hUsd?: number;
  maxChoppiness?: number;
  minAdx?: number;
  chopPeriod?: number;
  adxPeriod?: number;
}

export interface EligibilityMetrics {
  volume24hUsd: number;
  choppiness: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
}

export interface EligibilityInput {
  symbol: string;
  volume24hUsd: number;
  klines: Bar[];
  isBlacklisted?: boolean;
}

export interface EligibilityResult {
  symbol: string;
  eligible: boolean;
  reasons: string[];
  primaryReason: string | null;
  metrics: EligibilityMetrics;
}

export function calculateTrueRange(high: number, low: number, prevClose?: number): number {
  if (prevClose === undefined) return high - low;
  const hl = high - low;
  const hc = Math.abs(high - prevClose);
  const lc = Math.abs(low - prevClose);
  return Math.max(hl, hc, lc);
}

// Choppiness Index (Dreiss): 100 * LOG10( SUM(TR, n) / (MaxH - MinL) ) / LOG10(n)
export function calculateChoppiness(bars: Bar[], period = DEFAULT_CHOP_PERIOD): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const startIdx = bars.length - period;
  let sumTr = 0;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = 0; i < slice.length; i++) {
    const bar = slice[i];
    const prevClose = (startIdx + i > 0) ? bars[startIdx + i - 1].close : undefined;
    sumTr += calculateTrueRange(bar.high, bar.low, prevClose);
    if (bar.high > maxHigh) maxHigh = bar.high;
    if (bar.low < minLow) minLow = bar.low;
  }
  const range = maxHigh - minLow;
  if (range <= 0 || sumTr <= 0) return 100;
  const ratio = sumTr / range;
  if (ratio <= 0) return 100;
  const chop = (100 * Math.log10(ratio)) / Math.log10(period);
  const bounded = Math.min(100, Math.max(0, chop));
  return Number(bounded.toFixed(2));
}

export interface AdxResult {
  adx: number;
  plusDi: number;
  minusDi: number;
}

// Wilder's ADX (14) - butuh minimal 2 * period bars (28 bars)
export function calculateAdx(bars: Bar[], period = DEFAULT_ADX_PERIOD): AdxResult | null {
  const minRequired = 2 * period;
  if (bars.length < minRequired) return null;
  const trs: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1];
    trs.push(calculateTrueRange(curr.high, curr.low, prev.close));
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    plusDms.push((upMove > downMove && upMove > 0) ? upMove : 0);
    minusDms.push((downMove > upMove && downMove > 0) ? downMove : 0);
  }
  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 0; i < period; i++) {
    smoothTr += trs[i];
    smoothPlus += plusDms[i];
    smoothMinus += minusDms[i];
  }
  const calcDiDx = (tr: number, pDm: number, mDm: number) => {
    const pDi = tr > 0 ? (100 * pDm) / tr : 0;
    const mDi = tr > 0 ? (100 * mDm) / tr : 0;
    const sum = pDi + mDi;
    const dx = sum > 0 ? (100 * Math.abs(pDi - mDi)) / sum : 0;
    return { pDi, mDi, dx };
  };
  const dxs: number[] = [];
  const first = calcDiDx(smoothTr, smoothPlus, smoothMinus);
  dxs.push(first.dx);
  let latestPdi = first.pDi;
  let latestMdi = first.mDi;
  for (let i = period; i < trs.length; i++) {
    smoothTr = smoothTr - (smoothTr / period) + trs[i];
    smoothPlus = smoothPlus - (smoothPlus / period) + plusDms[i];
    smoothMinus = smoothMinus - (smoothMinus / period) + minusDms[i];
    const { pDi, mDi, dx } = calcDiDx(smoothTr, smoothPlus, smoothMinus);
    latestPdi = pDi;
    latestMdi = mDi;
    dxs.push(dx);
  }
  if (dxs.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxs[i];
  adx = adx / period;
  for (let i = period; i < dxs.length; i++) {
    adx = ((adx * (period - 1)) + dxs[i]) / period;
  }
  return {
    adx: Number(adx.toFixed(2)),
    plusDi: Number(latestPdi.toFixed(2)),
    minusDi: Number(latestMdi.toFixed(2)),
  };
}

export function evaluateEligibility(input: EligibilityInput, params: EligibilityParams = {}): EligibilityResult {
  const minVol = params.minVolume24hUsd ?? DEFAULT_MIN_VOLUME_USD;
  const maxChop = params.maxChoppiness ?? DEFAULT_MAX_CHOPPINESS;
  const minAdxVal = params.minAdx ?? DEFAULT_MIN_ADX;
  const chopP = params.chopPeriod ?? DEFAULT_CHOP_PERIOD;
  const adxP = params.adxPeriod ?? DEFAULT_ADX_PERIOD;

  const reasons: string[] = [];
  if (input.isBlacklisted) reasons.push(REASON_BLACKLISTED);
  if (!Number.isFinite(input.volume24hUsd) || input.volume24hUsd <= minVol) reasons.push(REASON_VOLUME_LOW);

  const chop = calculateChoppiness(input.klines, chopP);
  const adxRes = calculateAdx(input.klines, adxP);

  if (chop === null || adxRes === null) {
    reasons.push(REASON_INSUFFICIENT_KLINES);
  } else {
    if (chop >= maxChop) reasons.push(REASON_CHOP_HIGH);
    if (adxRes.adx < minAdxVal) reasons.push(REASON_ADX_LOW);
  }

  const eligible = reasons.length === 0;
  const primaryReason = reasons[0] ?? null;

  return {
    symbol: input.symbol,
    eligible,
    reasons,
    primaryReason,
    metrics: {
      volume24hUsd: input.volume24hUsd,
      choppiness: chop,
      adx: adxRes?.adx ?? null,
      plusDi: adxRes?.plusDi ?? null,
      minusDi: adxRes?.minusDi ?? null,
    },
  };
}

export interface EligibilityDbAdapter {
  updateSymbolEligibility(symbol: string, volume24hUsd: number, eligible: boolean, eligibleReason: string | null): Promise<void>;
}

export const prismaEligibilityAdapter: EligibilityDbAdapter = {
  async updateSymbolEligibility(symbol: string, volume24hUsd: number, eligible: boolean, eligibleReason: string | null): Promise<void> {
    await db.symbol.update({
      where: { symbol },
      data: {
        volume24hUsd,
        eligible,
        eligibleReason,
      },
    });
  },
};
