import { Bar, calculateAdx } from "../universe/eligibility.js";
import {
  MarketRegime,
  classifyRegimeSmoothed,
  calculateZeroLagTrend,
  evaluateVolatilityShield,
} from "./regimeTrendEngine.js";

export const MACRO_REASON_BTC_BEARISH = "MACRO_BTC_BEARISH_BLOCKS_LONG";
export const MACRO_REASON_BTC_BULLISH = "MACRO_BTC_BULLISH_BLOCKS_SHORT";
export const MACRO_REASON_BTC_VOLATILE = "MACRO_BTC_VOLATILE_BLOCKS_ENTRY";
export const MACRO_REASON_ETH_BEARISH = "MACRO_ETH_BEARISH_BLOCKS_LONG";
export const MACRO_REASON_ETH_BULLISH = "MACRO_ETH_BULLISH_BLOCKS_SHORT";
export const MACRO_REASON_BTCDOM_SPIKE = "BTCDOM_SPIKE_GT_0_5_PCT";
// ZLEMA(21) memakai lag 10: butuh >=31 bar. Sediakan warm-up lebih panjang.
export const MACRO_KLINE_LIMIT = 60;
// SHORT melawan bias BTC bullish dilarang, termasuk grind naik dengan ADX lemah.
// BTC netral bukan veto otomatis ketika pair sendiri bearish dan lolos filter tren.

export interface MacroSymbolState {
  symbol: string;
  price: number;
  regime: MarketRegime;
  trendDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  chg1hPct: number;
  adx: number;
  shieldActive?: boolean;
}

export interface BtcDomState {
  price: number;
  chg1hPct: number;
  spikeDetected: boolean; // chg1hPct > 0.5% (FR-06)
}

export interface MacroMarketSnapshot {
  btcBars1h: Bar[];
  ethBars1h: Bar[];
  btcdomBars1h: Bar[];
}

export interface MacroGateResult {
  pass: boolean;
  blockedReasons: string[];
  btc: MacroSymbolState;
  eth: MacroSymbolState;
  btcDom: BtcDomState;
}

/**
 * Menghitung persentase perubahan harga 1 jam terakhir dari baris lilin 1h.
 */
export function calculate1hChangePct(bars1h: Bar[]): number {
  if (bars1h.length < 2) return 0;
  const current = bars1h[bars1h.length - 1]!;
  const prev = bars1h[bars1h.length - 2]!;
  if (prev.close === 0) return 0;
  const pct = ((current.close - prev.close) / prev.close) * 100;
  return Number(pct.toFixed(4));
}

/**
 * Menganalisis status simbol makro (BTC/ETH).
 */
export function analyzeMacroSymbol(symbol: string, bars: Bar[]): MacroSymbolState {
  const lastBar = bars.length > 0 ? bars[bars.length - 1]! : { close: 0 };
  const regimeRes = classifyRegimeSmoothed(bars);
  const trendRes = calculateZeroLagTrend(bars);
  const shieldRes = evaluateVolatilityShield(bars);
  const adxRes = calculateAdx(bars, 14);
  const chg1hPct = calculate1hChangePct(bars);

  return {
    symbol,
    price: lastBar.close,
    regime: regimeRes.regime,
    trendDirection: trendRes.direction,
    chg1hPct,
    adx: adxRes?.adx ?? 0,
    shieldActive: shieldRes.active,
  };
}

/**
 * Menganalisis status dominasi BTC (BTCDOMUSDT) per FR-06.
 */
export function analyzeBtcDom(bars: Bar[]): BtcDomState {
  const lastBar = bars.length > 0 ? bars[bars.length - 1]! : { close: 0 };
  const chg1hPct = calculate1hChangePct(bars);
  const spikeDetected = chg1hPct > 0.5; // FR-06: naik > 0,5% dalam 1 jam

  return {
    price: lastBar.close,
    chg1hPct,
    spikeDetected,
  };
}

/**
 * FR-05 & FR-06: Gate makro untuk memblokir entry kandidat bila bertentangan dengan
 * regime BTC/ETH atau kenaikan dominasi BTC.D.
 */
export function evaluateMacroGate(
  candidateSymbol: string,
  candidateSide: "LONG" | "SHORT",
  snapshot: MacroMarketSnapshot
): MacroGateResult {
  const btc = analyzeMacroSymbol("BTCUSDT", snapshot.btcBars1h);
  const eth = analyzeMacroSymbol("ETHUSDT", snapshot.ethBars1h);
  const btcDom = analyzeBtcDom(snapshot.btcdomBars1h);

  const blockedReasons: string[] = [];
  const isAltcoin = candidateSymbol.toUpperCase() !== "BTCUSDT";

  // 1. Guard Volatilitas Ekstrem BTC (FR-05)
  if (btc.regime === "VOLATILE" || btc.shieldActive) {
    blockedReasons.push(MACRO_REASON_BTC_VOLATILE);
  }

  // 2. Evaluasi Arah BTC vs Kandidat (FR-05 & AC-05)
  // AC-05: Given regime BTC 1 jam TRENDING menurun kuat (ADX >= 25 arah turun), blokir LONG
  const btcStrongBearish =
    (btc.regime === "TRENDING" && btc.trendDirection === "BEARISH") ||
    (btc.adx >= 25 && btc.chg1hPct < 0);
  if (candidateSide === "LONG" && btcStrongBearish) {
    blockedReasons.push(MACRO_REASON_BTC_BEARISH);
  }

  // Jika BTC tren naik kuat (TRENDING BULLISH atau ADX >= 25 arah naik), blokir SHORT
  const btcStrongBullish =
    (btc.regime === "TRENDING" && btc.trendDirection === "BULLISH") ||
    (btc.adx >= 25 && btc.chg1hPct > 0);
  if (candidateSide === "SHORT" && btcStrongBullish) {
    blockedReasons.push(MACRO_REASON_BTC_BULLISH);
  }

  // Data lama menunjukkan SHORT merugi saat BTC grind naik. Tolak juga bias BTC
  // bullish yang belum memenuhi ambang strong-trend; izinkan BTC netral.
  if (candidateSide === "SHORT" && btc.trendDirection === "BULLISH" &&
      !blockedReasons.includes(MACRO_REASON_BTC_BULLISH)) {
    blockedReasons.push(MACRO_REASON_BTC_BULLISH);
  }

  // 3. Evaluasi Arah ETH vs Kandidat (FR-05)
  const ethStrongBearish =
    (eth.regime === "TRENDING" && eth.trendDirection === "BEARISH") ||
    (eth.chg1hPct < -0.5 && eth.trendDirection === "BEARISH");
  if (candidateSide === "LONG" && ethStrongBearish) {
    blockedReasons.push(MACRO_REASON_ETH_BEARISH);
  }

  const ethStrongBullish =
    (eth.regime === "TRENDING" && eth.trendDirection === "BULLISH") ||
    (eth.chg1hPct > 0.5 && eth.trendDirection === "BULLISH");
  if (candidateSide === "SHORT" && ethStrongBullish) {
    blockedReasons.push(MACRO_REASON_ETH_BULLISH);
  }

  // 4. Dominansi naik tajam merugikan LONG alt; untuk SHORT alt justru dapat
  // konsisten dengan baris DUMP/DECREASE pada matriks operator.
  if (isAltcoin && candidateSide === "LONG" && btcDom.spikeDetected) {
    blockedReasons.push(MACRO_REASON_BTCDOM_SPIKE);
  }

  const pass = blockedReasons.length === 0;

  return {
    pass,
    blockedReasons,
    btc,
    eth,
    btcDom,
  };
}

/**
 * Matriks arah alt dari BTC Dominance x BTC Price + konfirmasi ETH (skema operator):
 * dom↑+btc↑=DECREASE | dom↑+btc↓=DUMP | dom↑+btc~=STABLE |
 * dom↓+btc↑=PUMP | dom↓+btc↓=STABLE | dom↓+btc~=INCREASE.
 * Enam baris ini persis peta operator. ETH dinilai terpisah oleh guard makro,
 * sehingga perbedaan ETH tidak mengubah label hasil diagram.
 */
export const DOM_DEADBAND_PCT = 0.05;
export const BTC_DEADBAND_PCT = 0.15;
export const ETH_DEADBAND_PCT = 0.15;

export type AltBias = "PUMP" | "INCREASE" | "STABLE" | "DECREASE" | "DUMP";

export interface AltMatrixResult {
  row: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  bias: AltBias;
  allowLongAlt: boolean;
  allowShortAlt: boolean;
  ethConfirmed: boolean;
  note: string;
}

export function evaluateAltMatrix(
  domChg1hPct: number,
  btcChg1hPct: number,
  ethChg1hPct: number
): AltMatrixResult {
  const domUp = domChg1hPct > DOM_DEADBAND_PCT;
  const domDown = domChg1hPct < -DOM_DEADBAND_PCT;
  const btcUp = btcChg1hPct > BTC_DEADBAND_PCT;
  const btcDown = btcChg1hPct < -BTC_DEADBAND_PCT;
  const ethUp = ethChg1hPct > ETH_DEADBAND_PCT;
  const ethDown = ethChg1hPct < -ETH_DEADBAND_PCT;

  if (!domUp && !domDown) {
    return { row: 0, bias: "STABLE", allowLongAlt: true, allowShortAlt: true, ethConfirmed: true, note: "DOM_FLAT" };
  }

  const stable = (row: AltMatrixResult["row"], note: string): AltMatrixResult => ({
    row, bias: "STABLE", allowLongAlt: true, allowShortAlt: true, ethConfirmed: true, note,
  });

  if (domUp && btcUp) {
    return { row: 1, bias: "DECREASE", allowLongAlt: false, allowShortAlt: true, ethConfirmed: true, note: "DOM_UP_BTC_UP" };
  }
  if (domUp && btcDown) {
    return { row: 2, bias: "DUMP", allowLongAlt: false, allowShortAlt: true,
      ethConfirmed: ethDown, note: ethDown ? "DOM_UP_BTC_DOWN_ETH_OK" : "DOM_UP_BTC_DOWN_ETH_DIVERGENCE" };
  }
  if (domUp) return stable(3, "DOM_UP_BTC_STABLE");
  if (domDown && btcUp) {
    return { row: 4, bias: "PUMP", allowLongAlt: true, allowShortAlt: false,
      ethConfirmed: ethUp, note: ethUp ? "DOM_DOWN_BTC_UP_ETH_OK" : "DOM_DOWN_BTC_UP_ETH_DIVERGENCE" };
  }
  if (domDown && btcDown) return stable(5, "DOM_DOWN_BTC_DOWN");
  return { row: 6, bias: "INCREASE", allowLongAlt: true, allowShortAlt: false, ethConfirmed: true, note: "DOM_DOWN_BTC_STABLE" };
}

/**
 * GateKeeper makro penyimpan snapshot terkini BTC, ETH, dan BTCDOMUSDT.
 */
export class MacroGateKeeper {
  private snapshot: MacroMarketSnapshot = {
    btcBars1h: [],
    ethBars1h: [],
    btcdomBars1h: [],
  };

  updateSnapshot(snapshot: Partial<MacroMarketSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
    };
  }

  getSnapshot(): MacroMarketSnapshot {
    return this.snapshot;
  }

  evaluate(candidateSymbol: string, candidateSide: "LONG" | "SHORT"): MacroGateResult {
    return evaluateMacroGate(candidateSymbol, candidateSide, this.snapshot);
  }
}
