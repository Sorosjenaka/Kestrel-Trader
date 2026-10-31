import { Bar, calculateTrueRange } from "../universe/eligibility.js";
import { calculateAtr } from "./regimeTrendEngine.js";

export type ZoneType = "OB" | "FVG" | "DEMAND" | "SUPPLY";
export type ZoneSide = "BULLISH" | "BEARISH";

export interface ZoneFactorScores {
  impulse: number;
  freshness: number;
  structureBreak: number;
  fvgConfluence: number;
  trendAlign: number;
}

export interface DetectedZone {
  id: string;
  type: ZoneType;
  side: ZoneSide;
  top: number;
  bottom: number;
  mid: number;
  barIndex: number;
  score: number;
  usable: boolean;
  factors: ZoneFactorScores;
}

export interface SqueezeResult {
  squeezeOn: boolean;
  squeezeRelease: boolean;
  momentum: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  expectedDistanceAtr: number;
  expectedTargetPrice: number;
  triggerScore: number;
  bbUpper: number;
  bbLower: number;
  kcUpper: number;
  kcLower: number;
  atr: number;
}

export function calculateSma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return Number((sum / period).toFixed(6));
}

export function calculateStdDev(values: number[], period: number, mean: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
  return Number(Math.sqrt(variance).toFixed(6));
}

/**
 * FR-10: Trigger engine (Squeeze Momentum: Bollinger Bands di dalam Keltner Channels).
 * - Squeeze ON: BB upper < KC upper DAN BB lower > KC lower (kompresi)
 * - Squeeze Release: Bar sebelumnya squeeze ON, bar saat ini keluar dari squeeze.
 * - Jarak harapan: 1.5 * ATR(14)
 */
export function evaluateSqueezeTrigger(
  bars: Bar[],
  opts: {
    bbPeriod?: number;
    bbMultiplier?: number;
    kcPeriod?: number;
    kcMultiplier?: number;
  } = {}
): SqueezeResult {
  const bbPeriod = opts.bbPeriod ?? 20;
  const bbMultiplier = opts.bbMultiplier ?? 2.0;
  const kcMultiplier = opts.kcMultiplier ?? 1.5;

  const closes = bars.map((b) => b.close);
  const minRequired = Math.max(bbPeriod, 20) + 2;

  if (bars.length < minRequired) {
    const lastClose = bars.length > 0 ? bars[bars.length - 1]!.close : 0;
    return {
      squeezeOn: false,
      squeezeRelease: false,
      momentum: 0,
      direction: "NEUTRAL",
      expectedDistanceAtr: 0,
      expectedTargetPrice: lastClose,
      triggerScore: 0,
      bbUpper: lastClose,
      bbLower: lastClose,
      kcUpper: lastClose,
      kcLower: lastClose,
      atr: 0,
    };
  }

  const currentAtr = calculateAtr(bars, 14) ?? (bars[bars.length - 1]!.high - bars[bars.length - 1]!.low);

  // Evaluasi bar saat ini vs bar sebelumnya untuk mendeteksi release
  const calcBAndK = (subBars: Bar[]) => {
    const subCloses = subBars.map((b) => b.close);
    const sma = calculateSma(subCloses, bbPeriod) ?? subCloses[subCloses.length - 1]!;
    const stdDev = calculateStdDev(subCloses, bbPeriod, sma) ?? 0;
    const atr = calculateAtr(subBars, 14) ?? 0;

    const bbUpper = sma + bbMultiplier * stdDev;
    const bbLower = sma - bbMultiplier * stdDev;
    const kcUpper = sma + kcMultiplier * atr;
    const kcLower = sma - kcMultiplier * atr;

    const isSqueeze = bbUpper < kcUpper && bbLower > kcLower;
    return { sma, bbUpper, bbLower, kcUpper, kcLower, isSqueeze, atr };
  };

  const currCalc = calcBAndK(bars);
  const prevBars = bars.slice(0, -1);
  const prevCalc = calcBAndK(prevBars);

  const squeezeOn = currCalc.isSqueeze;
  // Squeeze Release: bar sebelumnya ON, bar sekarang keluar (OFF)
  let squeezeRelease = prevCalc.isSqueeze && !currCalc.isSqueeze;
  if (!squeezeRelease && !squeezeOn && bars.length >= minRequired + 3) {
    // Squeeze baru saja rilis dalam 3 bar terakhir dengan momentum aktif
    const prev2 = calcBAndK(bars.slice(0, -2));
    const prev3 = calcBAndK(bars.slice(0, -3));
    if ((prev2.isSqueeze || prev3.isSqueeze) && !currCalc.isSqueeze) {
      squeezeRelease = true;
    }
  }

  // Momentum kalkulasi: delta harga close terhadap midline SMA + rata-rata (H+L)/2
  const lastBar = bars[bars.length - 1]!;
  const hlMid = (lastBar.high + lastBar.low) / 2;
  const momentum = Number((lastBar.close - (currCalc.sma + hlMid) / 2).toFixed(6));

  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  if (momentum > 0) direction = "LONG";
  else if (momentum < 0) direction = "SHORT";

  // Jarak harapan: 1.5 * ATR
  const expectedDistanceAtr = Number((1.5 * currentAtr).toFixed(6));
  const expectedTargetPrice =
    direction === "LONG"
      ? Number((lastBar.close + expectedDistanceAtr).toFixed(6))
      : direction === "SHORT"
      ? Number((lastBar.close - expectedDistanceAtr).toFixed(6))
      : lastBar.close;

  // Skor trigger (0 - 100):
  // Jika squeeze release terjadi, skor dasar 75 + bonus momentum (hingga 100)
  // Jika squeeze masih ON, skor 40 (tahap akumulasi/kompresi)
  // Jika tidak ada squeeze, skor 20
  let triggerScore = 20;
  if (squeezeRelease) {
    const momIntensity = currentAtr > 0 ? Math.min(25, (Math.abs(momentum) / currentAtr) * 25) : 10;
    triggerScore = Math.min(100, Math.round(75 + momIntensity));
  } else if (squeezeOn) {
    triggerScore = 40;
  }

  return {
    squeezeOn,
    squeezeRelease,
    momentum,
    direction,
    expectedDistanceAtr,
    expectedTargetPrice,
    triggerScore,
    bbUpper: Number(currCalc.bbUpper.toFixed(6)),
    bbLower: Number(currCalc.bbLower.toFixed(6)),
    kcUpper: Number(currCalc.kcUpper.toFixed(6)),
    kcLower: Number(currCalc.kcLower.toFixed(6)),
    atr: currentAtr,
  };
}


/**
 * Mendeteksi Fair Value Gaps (FVG) pada baris lilin 3-bar.
 * Bullish FVG: Bar i low > Bar i-2 high
 * Bearish FVG: Bar i high < Bar i-2 low
 */
export function detectFairValueGaps(bars: Bar[]): DetectedZone[] {
  const fvgs: DetectedZone[] = [];
  if (bars.length < 3) return fvgs;

  for (let i = 2; i < bars.length; i++) {
    const barPrev2 = bars[i - 2]!;
    const barMid = bars[i - 1]!;
    const barCurr = bars[i]!;

    // Bullish FVG (gap ke atas)
    if (barCurr.low > barPrev2.high) {
      const top = barCurr.low;
      const bottom = barPrev2.high;
      fvgs.push({
        id: `fvg_bull_${i}_${barMid.openTime}`,
        type: "FVG",
        side: "BULLISH",
        top,
        bottom,
        mid: Number(((top + bottom) / 2).toFixed(6)),
        barIndex: i - 1,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }

    // Bearish FVG (gap ke bawah)
    if (barCurr.high < barPrev2.low) {
      const top = barPrev2.low;
      const bottom = barPrev2.high;
      fvgs.push({
        id: `fvg_bear_${i}_${barMid.openTime}`,
        type: "FVG",
        side: "BEARISH",
        top: barPrev2.low,
        bottom: barCurr.high,
        mid: Number(((barPrev2.low + barCurr.high) / 2).toFixed(6)),
        barIndex: i - 1,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }
  }

  return fvgs;
}

/**
 * Mendeteksi Order Blocks (OB).
 * Bullish OB: Bar bearish terakhir sebelum ekspansi naik impulsif yang memecah struktur.
 * Bearish OB: Bar bullish terakhir sebelum ekspansi turun impulsif yang memecah struktur.
 */
export function detectOrderBlocks(bars: Bar[], atr: number): DetectedZone[] {
  const obs: DetectedZone[] = [];
  if (bars.length < 5) return obs;

  const threshold = Math.max(0.0001, atr * 1.2);

  for (let i = 1; i < bars.length - 1; i++) {
    const curr = bars[i]!;
    const next = bars[i + 1]!;

    // Bullish OB: Candle bearish diikuti candle impulsif bullish kuat
    if (curr.close < curr.open && next.close > next.open && (next.close - next.open) >= threshold) {
      obs.push({
        id: `ob_bull_${i}_${curr.openTime}`,
        type: "OB",
        side: "BULLISH",
        top: Math.max(curr.open, curr.close),
        bottom: curr.low,
        mid: Number(((curr.high + curr.low) / 2).toFixed(6)),
        barIndex: i,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }

    // Bearish OB: Candle bullish diikuti candle impulsif bearish kuat
    if (curr.close > curr.open && next.close < next.open && (next.open - next.close) >= threshold) {
      obs.push({
        id: `ob_bear_${i}_${curr.openTime}`,
        type: "OB",
        side: "BEARISH",
        top: curr.high,
        bottom: Math.min(curr.open, curr.close),
        mid: Number(((curr.high + curr.low) / 2).toFixed(6)),
        barIndex: i,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }
  }

  return obs;
}

/**
 * Mendeteksi zona SnD (Rally-Base-Rally / Drop-Base-Drop).
 */
export function detectSupplyDemandZones(bars: Bar[], atr: number): DetectedZone[] {
  const zones: DetectedZone[] = [];
  if (bars.length < 5) return zones;

  const baseThreshold = Math.max(0.0001, atr * 0.6);
  const impulseThreshold = Math.max(0.0001, atr * 1.3);

  for (let i = 1; i < bars.length - 1; i++) {
    const curr = bars[i]!;
    const next = bars[i + 1]!;
    const currBody = Math.abs(curr.close - curr.open);
    const nextBody = Math.abs(next.close - next.open);

    // Demand: base candle kecil diikuti lonjakan bullish
    if (currBody <= baseThreshold && next.close > next.open && nextBody >= impulseThreshold) {
      zones.push({
        id: `snd_dem_${i}_${curr.openTime}`,
        type: "DEMAND",
        side: "BULLISH",
        top: curr.high,
        bottom: curr.low,
        mid: Number(((curr.high + curr.low) / 2).toFixed(6)),
        barIndex: i,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }

    // Supply: base candle kecil diikuti drop bearish
    if (currBody <= baseThreshold && next.close < next.open && nextBody >= impulseThreshold) {
      zones.push({
        id: `snd_sup_${i}_${curr.openTime}`,
        type: "SUPPLY",
        side: "BEARISH",
        top: curr.high,
        bottom: curr.low,
        mid: Number(((curr.high + curr.low) / 2).toFixed(6)),
        barIndex: i,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      });
    }
  }

  return zones;
}

/**
 * Menghitung skor 0-100 dari >= 5 faktor untuk setiap zona (FR-09):
 * 1. Impulse Strength (volume & candle size): 0 - 20 pts
 * 2. Freshness / Retest count: 0 - 20 pts (belum teruji = 20, teruji 1x = 10, >1x = 0)
 * 3. Structure Break (BOS / pivot break): 0 - 20 pts
 * 4. FVG Confluence (ada FVG di area yang sama): 0 - 20 pts
 * 5. Trend Alignment (searah trend utama): 0 - 20 pts
 *
 * Sesuai FR-09: zona dengan skor < 50 TIDAK dipakai sebagai dasar entry (usable = false).
 */
export function scoreZone(
  zone: DetectedZone,
  bars: Bar[],
  atr: number,
  trendDirection: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL",
  allFvgs: DetectedZone[] = []
): DetectedZone {
  const zoneBar = bars[zone.barIndex];
  const subsequentBars = bars.slice(zone.barIndex + 1);

  // 1. Impulse Strength (0 - 20 pts)
  let impulse = 10;
  if (zone.barIndex + 1 < bars.length) {
    const departureBar = bars[zone.barIndex + 1]!;
    const departureBody = Math.abs(departureBar.close - departureBar.open);
    if (departureBody >= 1.5 * atr) impulse += 5;
    if (departureBar.volume > (zoneBar?.volume ?? 0)) impulse += 5;
  }
  impulse = Math.min(20, impulse);

  // 2. Freshness (0 - 20 pts)
  let touches = 0;
  for (const b of subsequentBars) {
    if (b.low <= zone.top && b.high >= zone.bottom) {
      touches++;
    }
  }
  let freshness = 20;
  if (touches === 1) freshness = 10;
  else if (touches > 1) freshness = 0;

  // 3. Structure Break (0 - 20 pts)
  let structureBreak = 5;
  const lookbackBars = bars.slice(Math.max(0, zone.barIndex - 10), zone.barIndex);
  if (lookbackBars.length > 0) {
    if (zone.side === "BULLISH") {
      const highestPrior = Math.max(...lookbackBars.map((b) => b.high));
      const departureHigh = subsequentBars.slice(0, 3).map((b) => b.high);
      if (departureHigh.some((h) => h > highestPrior)) {
        structureBreak = 20;
      }
    } else {
      const lowestPrior = Math.min(...lookbackBars.map((b) => b.low));
      const departureLow = subsequentBars.slice(0, 3).map((b) => b.low);
      if (departureLow.some((l) => l < lowestPrior)) {
        structureBreak = 20;
      }
    }
  }

  // 4. FVG Confluence (0 - 20 pts)
  let fvgConfluence = 0;
  const overlappingFvg = allFvgs.find(
    (f) =>
      f.side === zone.side &&
      f.id !== zone.id &&
      Math.abs(f.barIndex - zone.barIndex) <= 3 &&
      f.top >= zone.bottom &&
      f.bottom <= zone.top
  );
  if (overlappingFvg) {
    fvgConfluence = 20;
  } else if (zone.type === "FVG") {
    fvgConfluence = 15;
  }

  // 5. Trend Alignment (0 - 20 pts)
  let trendAlign = 5;
  if (trendDirection === zone.side) {
    trendAlign = 20;
  } else if (trendDirection === "NEUTRAL") {
    trendAlign = 10;
  } else {
    trendAlign = 0;
  }

  const totalScore = impulse + freshness + structureBreak + fvgConfluence + trendAlign;
  const usable = totalScore >= 50;

  return {
    ...zone,
    score: totalScore,
    usable,
    factors: {
      impulse,
      freshness,
      structureBreak,
      fvgConfluence,
      trendAlign,
    },
  };
}

export interface PairZonesAndTriggerResult {
  symbol: string;
  bestZone: DetectedZone | null;
  allZones: DetectedZone[];
  usableZones: DetectedZone[];
  zoneScore: number;
  trigger: SqueezeResult;
  triggerScore: number;
}

/**
 * Menganalisis zona SMC/SnD dan Trigger Squeeze secara holistik untuk sebuah pair.
 */
export function analyzePairZonesAndTrigger(
  symbol: string,
  bars: Bar[],
  opts: {
    trendDirection?: "BULLISH" | "BEARISH" | "NEUTRAL";
  } = {}
): PairZonesAndTriggerResult {
  const atr = calculateAtr(bars, 14) ?? (bars.length > 0 ? bars[bars.length - 1]!.high - bars[bars.length - 1]!.low : 1);
  const trendDir = opts.trendDirection ?? "NEUTRAL";

  // 1. Deteksi semua zona
  const fvgs = detectFairValueGaps(bars);
  const obs = detectOrderBlocks(bars, atr);
  const snds = detectSupplyDemandZones(bars, atr);
  const rawZones = [...fvgs, ...obs, ...snds];

  // 2. Skoring 5 faktor untuk setiap zona
  const scoredZones = rawZones.map((z) => scoreZone(z, bars, atr, trendDir, fvgs));

  // Urutkan dari skor tertinggi
  scoredZones.sort((a, b) => b.score - a.score);

  const usableZones = scoredZones.filter((z) => z.usable);
  const bestZone = usableZones.length > 0 ? usableZones[0]! : scoredZones[0] ?? null;
  const zoneScore = bestZone?.usable ? bestZone.score : 0;

  // 3. Evaluasi Trigger Squeeze Momentum (FR-10)
  const trigger = evaluateSqueezeTrigger(bars);

  return {
    symbol,
    bestZone,
    allZones: scoredZones,
    usableZones,
    zoneScore,
    trigger,
    triggerScore: trigger.triggerScore,
  };
}

