import {
  Bar,
  calculateAdx,
  calculateChoppiness,
  calculateTrueRange,
} from "../universe/eligibility.js";

export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE" | "UNCERTAIN";
export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export const SHIELD_REASON_ATR_SPIKE = "ATR_SPIKE_GT_2X";
export const SHIELD_REASON_SPREAD_HIGH = "SPREAD_GT_0_15_PCT";

export interface VolatilityShieldStatus {
  active: boolean;
  blockNewSignals: boolean;
  atrRatio: number;
  currentAtr: number;
  avg72Atr: number;
  spreadPct: number;
  reasons: string[];
}

export interface RegimeClassification {
  rawRegimes: MarketRegime[];
  regime: MarketRegime;
  window: number;
  voteCounts: Record<MarketRegime, number>;
  confidence: number;
}

export interface ZeroLagTrendResult {
  zlema: number;
  upperShield: number;
  lowerShield: number;
  direction: TrendDirection;
  isFlip: boolean;
  trendScore: number;
  distancePct: number;
}

export interface PairRegimeTrendAnalysis {
  symbol: string;
  regime: MarketRegime;
  regimeClassification: RegimeClassification;
  trend: ZeroLagTrendResult;
  volatilityShield: VolatilityShieldStatus;
}

/**
 * Menghitung deret ATR (Average True Range) dengan Wilder's smoothing.
 */
export function calculateAtrSeries(bars: Bar[], period = 14): number[] {
  if (bars.length < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(calculateTrueRange(bars[i]!.high, bars[i]!.low, bars[i - 1]!.close));
  }
  if (trs.length < period) return [];

  const atrs: number[] = [];
  let sumTr = 0;
  for (let i = 0; i < period; i++) {
    sumTr += trs[i]!;
  }
  let currentAtr = sumTr / period;
  atrs.push(Number(currentAtr.toFixed(6)));

  for (let i = period; i < trs.length; i++) {
    currentAtr = (currentAtr * (period - 1) + trs[i]!) / period;
    atrs.push(Number(currentAtr.toFixed(6)));
  }
  return atrs;
}

export function calculateAtr(bars: Bar[], period = 14): number | null {
  const series = calculateAtrSeries(bars, period);
  if (series.length === 0) return null;
  return series[series.length - 1]!;
}

/**
 * Evaluasi Volatility Shield (FR-11):
 * - Rasio ATR(14) saat ini terhadap rata-rata ATR(14) 72 bar > 2.0 -> "ATR_SPIKE_GT_2X"
 * - Spread > 0.15% (0.0015) -> "SPREAD_GT_0_15_PCT"
 * Jika aktif: blockNewSignals = true
 */
export function evaluateVolatilityShield(
  bars: Bar[],
  spreadPct = 0,
  opts: {
    atrThreshold?: number;
    spreadThreshold?: number;
    period?: number;
    baselineBars?: number;
  } = {}
): VolatilityShieldStatus {
  const period = opts.period ?? 14;
  const baselineBars = opts.baselineBars ?? 72;
  const atrThreshold = opts.atrThreshold ?? 2.0;
  const spreadThreshold = opts.spreadThreshold ?? 0.0015;

  const atrSeries = calculateAtrSeries(bars, period);
  const reasons: string[] = [];

  if (atrSeries.length === 0) {
    const active = spreadPct > spreadThreshold;
    if (active) reasons.push(SHIELD_REASON_SPREAD_HIGH);
    return {
      active,
      blockNewSignals: active,
      atrRatio: 1.0,
      currentAtr: 0,
      avg72Atr: 0,
      spreadPct,
      reasons,
    };
  }

  const currentAtr = atrSeries[atrSeries.length - 1]!;
  const baselineWindow = atrSeries.slice(-baselineBars);
  const sumAtr = baselineWindow.reduce((acc, v) => acc + v, 0);
  const avg72Atr = sumAtr / baselineWindow.length;
  const atrRatio = avg72Atr > 0 ? Number((currentAtr / avg72Atr).toFixed(2)) : 1.0;

  if (atrRatio > atrThreshold) {
    reasons.push(SHIELD_REASON_ATR_SPIKE);
  }
  if (spreadPct > spreadThreshold) {
    reasons.push(SHIELD_REASON_SPREAD_HIGH);
  }

  const active = reasons.length > 0;
  return {
    active,
    blockNewSignals: active,
    atrRatio,
    currentAtr,
    avg72Atr: Number(avg72Atr.toFixed(6)),
    spreadPct,
    reasons,
  };
}

/**
 * Mengklasifikasikan regime untuk satu bar snapshot.
 */
export function classifySingleBarRegime(
  barsUpToNow: Bar[],
  volShield: VolatilityShieldStatus
): MarketRegime {
  if (volShield.active && volShield.reasons.includes(SHIELD_REASON_ATR_SPIKE)) {
    return "VOLATILE";
  }

  const chop = calculateChoppiness(barsUpToNow);
  const adxRes = calculateAdx(barsUpToNow);

  if (chop === null || adxRes === null) {
    return "UNCERTAIN";
  }

  // TRENDING: ADX kuat >= 20 dan tidak sideway (Chop < 58.3)
  if (adxRes.adx >= 20 && chop < 58.3) {
    return "TRENDING";
  }

  // RANGING: Chop tinggi (>= 58.3) atau ADX rendah (< 20)
  if (chop >= 58.3 || adxRes.adx < 20) {
    return "RANGING";
  }

  return "UNCERTAIN";
}

/**
 * FR-08: Regime Engine dengan smoothing mayoritas jendela 5 bar.
 * Mengambil 5 bar terakhir, menentukan regime tiap bar, dan memilih mayoritas (modus).
 */
export function classifyRegimeSmoothed(
  bars: Bar[],
  spreadPct = 0,
  windowSize = 5
): RegimeClassification {
  const votes: Record<MarketRegime, number> = {
    TRENDING: 0,
    RANGING: 0,
    VOLATILE: 0,
    UNCERTAIN: 0,
  };

  const rawRegimes: MarketRegime[] = [];

  // Jika bar kurang dari 28 (kebutuhan minimum ADX 14*2), hasil UNCERTAIN
  if (bars.length < 28) {
    return {
      rawRegimes: ["UNCERTAIN"],
      regime: "UNCERTAIN",
      window: windowSize,
      voteCounts: { ...votes, UNCERTAIN: 1 },
      confidence: 1.0,
    };
  }

  const effectiveWindow = Math.min(windowSize, bars.length - 27);
  for (let w = effectiveWindow - 1; w >= 0; w--) {
    const subBars = bars.slice(0, bars.length - w);
    const volShield = evaluateVolatilityShield(subBars, spreadPct);
    const r = classifySingleBarRegime(subBars, volShield);
    rawRegimes.push(r);
    votes[r]++;
  }

  let bestRegime: MarketRegime = rawRegimes[rawRegimes.length - 1]!;
  let maxVotes = -1;

  for (const regime of ["TRENDING", "RANGING", "VOLATILE", "UNCERTAIN"] as MarketRegime[]) {
    const count = votes[regime];
    if (count > maxVotes) {
      maxVotes = count;
      bestRegime = regime;
    } else if (count === maxVotes) {
      const lastIdxCurrent = rawRegimes.lastIndexOf(regime);
      const lastIdxBest = rawRegimes.lastIndexOf(bestRegime);
      if (lastIdxCurrent > lastIdxBest) {
        bestRegime = regime;
      }
    }
  }

  const confidence = Number((maxVotes / rawRegimes.length).toFixed(2));

  return {
    rawRegimes,
    regime: bestRegime,
    window: windowSize,
    voteCounts: votes,
    confidence,
  };
}

/**
 * FR-11: Zero-Lag Trend Engine + Volatility Shield.
 * - Zero-Lag EMA: lag = floor((period - 1) / 2); adjustedClose = 2*close - close[i - lag]
 * - Upper Shield = ZLEMA + multiplier * ATR
 * - Lower Shield = ZLEMA - multiplier * ATR
 * - Flip hanya ditandai bila harga close berada di LUAR shield:
 *   - Bearish -> flip Bullish bila close > upperShield
 *   - Bullish -> flip Bearish bila close < lowerShield
 *   - Di dalam shield -> mempertahankan arah sebelumnya (tidak flip).
 */
export function calculateZeroLagTrend(
  bars: Bar[],
  opts: {
    period?: number;
    shieldMultiplier?: number;
    previousDirection?: TrendDirection;
  } = {}
): ZeroLagTrendResult {
  const period = opts.period ?? 21;
  const shieldMultiplier = opts.shieldMultiplier ?? 1.0;
  const prevDir = opts.previousDirection ?? "NEUTRAL";

  const minRequired = period + Math.floor((period - 1) / 2);
  if (bars.length < minRequired) {
    const lastClose = bars.length > 0 ? bars[bars.length - 1]!.close : 0;
    return {
      zlema: lastClose,
      upperShield: lastClose,
      lowerShield: lastClose,
      direction: "NEUTRAL",
      isFlip: false,
      trendScore: 50,
      distancePct: 0,
    };
  }

  const lag = Math.floor((period - 1) / 2);
  const alpha = 2 / (period + 1);

  const adjCloses: number[] = [];
  for (let i = lag; i < bars.length; i++) {
    const curr = bars[i]!.close;
    const past = bars[i - lag]!.close;
    adjCloses.push(2 * curr - past);
  }

  let prevZlema = adjCloses[0]!;
  let zlema = adjCloses[0]!;
  for (let i = 1; i < adjCloses.length; i++) {
    if (i === adjCloses.length - 1) prevZlema = zlema;
    zlema = alpha * adjCloses[i]! + (1 - alpha) * zlema;
  }
  zlema = Number(zlema.toFixed(6));
  prevZlema = Number(prevZlema.toFixed(6));

  const currentAtr = calculateAtr(bars, 14) ?? (bars[bars.length - 1]!.high - bars[bars.length - 1]!.low);
  const upperShield = Number((zlema + shieldMultiplier * currentAtr).toFixed(6));
  const lowerShield = Number((zlema - shieldMultiplier * currentAtr).toFixed(6));

  const lastBar = bars[bars.length - 1]!;
  const close = lastBar.close;

  let direction: TrendDirection = prevDir;
  let isFlip = false;

  if (prevDir === "BULLISH") {
    if (close < lowerShield) {
      direction = "BEARISH";
      isFlip = true;
    }
  } else if (prevDir === "BEARISH") {
    if (close > upperShield) {
      direction = "BULLISH";
      isFlip = true;
    }
  } else {
    if (close > upperShield) {
      direction = "BULLISH";
      isFlip = true;
    } else if (close < lowerShield) {
      direction = "BEARISH";
      isFlip = true;
    } else {
      direction = zlema >= prevZlema ? "BULLISH" : "BEARISH";
    }
  }

  const adxRes = calculateAdx(bars, 14);
  const adxVal = adxRes ? adxRes.adx : 20;
  const adxPoints = Math.min(25, (adxVal / 50) * 25);

  const diffFromZlema = currentAtr > 0 ? Math.abs(close - zlema) / currentAtr : 0;
  const distancePoints = Math.min(25, (diffFromZlema / 2.0) * 25);

  let trendScore = 50;
  if (direction === "BULLISH" || direction === "BEARISH") {
    trendScore = Math.min(100, Math.max(0, Math.round(50 + distancePoints + adxPoints)));
  }

  const distancePct = zlema > 0 ? Number((((close - zlema) / zlema) * 100).toFixed(2)) : 0;

  return {
    zlema,
    upperShield,
    lowerShield,
    direction,
    isFlip,
    trendScore,
    distancePct,
  };
}

/**
 * Analisis gabungan: Regime (FR-08) + Volatility Shield & Trend Zero-Lag (FR-11).
 */
export function analyzePairRegimeTrend(
  symbol: string,
  bars: Bar[],
  spreadPct = 0,
  opts: {
    previousDirection?: TrendDirection;
    shieldMultiplier?: number;
  } = {}
): PairRegimeTrendAnalysis {
  const volatilityShield = evaluateVolatilityShield(bars, spreadPct);
  const regimeClassification = classifyRegimeSmoothed(bars, spreadPct);
  const trend = calculateZeroLagTrend(bars, {
    previousDirection: opts.previousDirection,
    shieldMultiplier: opts.shieldMultiplier,
  });

  return {
    symbol,
    regime: regimeClassification.regime,
    regimeClassification,
    trend,
    volatilityShield,
  };
}

