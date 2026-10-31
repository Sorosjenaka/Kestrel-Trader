import { replayHistoricalDataset, datasetHash, type HistoricalDataset, type BacktestProvenance } from "./historicalReplay.js";
import { rrPolicyForMode } from "../config/setupEngine.js";
import { MAKER_RATE, TAKER_RATE } from "../config/costs.js";
export type { HistoricalDataset, BacktestProvenance } from "./historicalReplay.js";
/**
 * ArtaTrade AI - Fee-Aware Backtest Engine & Strategy Gate (FR-14, NFR-09, US-12, PRD 5.1).
 *
 * Aturan Bisnis & Batasan:
 *  - Strategi aktif (RENUMBER 6 Okt 2026, perintah operator "cukup 3 strategi"):
 *    S-01 Liquidity Sweep Reclaim (eks S-03), S-02 Liquidity Sniper (eks S-04),
 *    S-03 Fibonacci Zone 0.5-0.618 (zona entry 7 Okt 2026; TP dipaksa 1.5R).
 *    Squeeze Breakout / FVG Continuation / HA Smooth Scalper / ORB & freeze
 *    dihapus dari katalog. Trade lama tetap tersimpan apa adanya dan dibaca
 *    lewat strategyDisplayName (era-aware).
 *  - Sizing: R = $1,00 (Rules.md Bagian 4).
 *  - Single target (29 Sep 2026): jalur SCALP menutup 100% posisi di TP1.
 *    SWING memakai RR23 50/2R/3R di historicalReplay; legacy mode tetap ada.
 *    komentar lama "tidak ada runner" hanya berlaku untuk SCALP.
 *  - Timeout: 90 menit (SCALP-only sejak 30 Sep 2026).
 *  - Fee model: Maker 0,02% (0.0002), Taker 0,05% (0.0005). Entry & TP = maker; SL & Timeout = taker.
 *  - Semua EV dihitung BERSIH-FEE (net of maker & taker fees).
 *  - Gate FR-14 / AC-12: winrate >= 60% (TP1 sebelum SL) pada >= 1.000 sampel DAN EV bersih-fee > $0.
 *  - Strategi gagal gate berstatus "FAILED" dan DILARANG diaktifkan untuk live trading.
 */

// 30 Sep 2026 — refactor SCALP-only: katalog strategi aktif hanya mode SCALP.
// 13 Okt 2026: mode SWING kembali — S-05 Swing Breakout backtestable.
// 20 Okt 2026: S-03 dihapus total; S-04 & S-05 jadi ARSIP-REPLAY
// (defaultActive=false) — historis bisa direplay, bukan entry source.
export type StrategyMode = "SCALP" | "SWING";

export interface StrategyCatalogItem {
  id: string; // active catalog: "S-01","S-02","S-03" (renumber 6 Okt 2026)
  name: string;
  mode: StrategyMode;
  description: string;
  engineComposition: string;
  additionalConditions: string;
  defaultActive: boolean;
  requiresOperatorApproval: boolean;
}

export const STRATEGY_CATALOG: Record<string, StrategyCatalogItem> = {
  "S-01": {
    id: "S-01",
    name: "Liquidity Sweep Reclaim",
    mode: "SCALP",
    description: "Sweep likuiditas sesi lalu reclaim level dengan displacement (eks S-03 sebelum renumber 6 Okt 2026)",
    engineComposition: "indikator Liquidity Sweep Session [TradingFinder] ICT Killzone Times + FR-11",
    additionalConditions: "Kedalaman sweep 0,05-1,6 ATR; reclaim <= 6 bar; displacement >= 0,25 ATR; target tunggal 1.5R",
    defaultActive: true,
    requiresOperatorApproval: false,
  },
  "S-02": {
    id: "S-02",
    name: "Liquidity Sniper",
    mode: "SCALP",
    description: "Peta likuiditas (liquidation + stop pools) -> magnet & pull bias: trade ke arah likuiditas yang menarik harga (eks S-04 sebelum renumber 6 Okt 2026)",
    engineComposition: "indikator Liquidity Sniper (Alpha_Wizard) + FR-11",
    additionalConditions: "Pull bias searah trend, magnet target intensity >= 0,25, pull bias tidak netral; target tunggal 1.5R",
    defaultActive: true,
    requiresOperatorApproval: false,
  },
  // CATATAN 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus
  // itu"): entri katalog "S-03" (Fibonacci Zone 0.5-0.618) DIHAPUS TOTAL dari
  // katalog backtest. Konsekuensi yang disengaja:
  //  - POST /api/backtest/run dengan strategyId:"S-03" kini 400 Bad Request
  //    ("Unknown strategy S-03") — konsisten dengan S-03 tidak lagi jadi
  //    entry source.
  //  - Trade S-03 yang sudah ada tetap punya baris ledger sendiri (label
  //    era tetap benar via strategyDisplayName).
  //
  // CATATAN 20 Okt 2026 (perintah operator: "hapus juga S-04 di strategi
  // scalp"): "S-04" (Mean-Reversion Stretch) DIHAPUS DARI LANE SCALP sebagai
  // entry source aktif — tapi entri katalog INI DISISIHKAN dengan sengaja
  // sebagai ARSIP-REPLAY:
  //  - engine mrvStretchEngine.ts masih hidup dan dipakai historicalReplay
  //    (jalur mrv5m / seri 5m) untuk mereplay trade S-04 yang SUDAH ADA.
  //  - defaultActive=false + requiresOperatorApproval=true => tidak ada entry
  //    baru S-04 dari katalog ini; defaultActive=false juga berarti tidak
  //    otomatis masuk allowlist lane mana pun.
  //  - Label di bawah sengaja menyebut "ARSIP / bukan entry source" supaya
  //    katalog tidak mengklaim S-04 dihapus total padahal entri masih ada
  //    (AU1-09: katalog harus konsisten).
  "S-04": {
    id: "S-04",
    name: "Mean-Reversion Stretch + Trend Gate",
    mode: "SCALP",
    description: "ARSIP-REPLAY 20 Okt 2026 — dihapus dari lane SCALP sebagai entry source (perintah operator), TETAP bisa direplay historis lewat mrvStretchEngine. Bukan entry source aktif.",
    engineComposition: "mrvStretchEngine (arsip — replay historis via historicalReplay; tidak lagi jadi entry source)",
    additionalConditions: "defaultActive=false: tidak ada entry baru S-04. Hanya replay dataset historis.",
    defaultActive: false,
    requiresOperatorApproval: true,
  },
  "S-05": {
    id: "S-05",
    name: "Swing Breakout Pattern",
    mode: "SWING",
    description: "ARSIP-REPLAY 20 Okt 2026 — dihapus dari katalog AKTIF (perintah operator: \"polaris hapus juga / yang S-05 itu\"). Bukti master_v2 executed: n=1.391, PF 0.7503, P(EV<=0)=99.9%, 2026 PF 0.452, walk-forward train 0.867 -> test 0.642 = EDGE NEGATIF. TETAP bisa direplay historis lewat swingBreakoutEngine. Bukan entry source aktif.",
    engineComposition: "swingBreakoutEngine (arsip — replay historis via historicalReplay; tidak lagi jadi entry source)",
    additionalConditions: "defaultActive=false: tidak ada entry baru S-05. Hanya replay dataset historis.",
    defaultActive: false,
    requiresOperatorApproval: true,
  },
  // ── T0.5 (18 Okt 2026): RSW — port evaluator riset ke TS. Parity terhadap
  //    oracle Python diverifikasi (rswParity.test.ts). PAPER-ONLY: defaultActive
  //    false + requiresOperatorApproval true; LIVE tetap S-03/S-05 sampai semua
  //    lolos gate net-EV (T0.4 / runFeeAwareGate). Exit RR23 riset 1:3.
  "RSW-01": {
    id: "RSW-01",
    name: "RSW BOS D1 + PHEN Locked",
    mode: "SWING",
    description: "BOS_LIMIT_RETEST LONG (H4) gate BTC_D1_ALIGN + PHEN_FADE_LIMIT SHORT (compressed range break)",
    engineComposition: "researchSwing/rswSignals.ts (port swing_paper_signals.py + generate_h4 + allow + stop; parity rswParity.test.ts)",
    additionalConditions: "Entry LIMIT close/retrace H4; SL max(1.5 ATR, 1% close) struktural cap 6%; RR23: TP1 @ 2R take 50% -> BE -> 50% @ 3R; PAPER-only",
    defaultActive: false,
    requiresOperatorApproval: true,
  },
  "RSW-02": {
    id: "RSW-02",
    name: "RSW PHEN Profile + PHEN Locked",
    mode: "SWING",
    description: "PHEN_FADE_LIMIT LONG (H4) gate PROFILE_CONTEXT + PHEN_FADE_LIMIT SHORT (locked control)",
    engineComposition: "researchSwing/rswSignals.ts (port swing_paper_signals.py + generate_h4 + allow + stop; parity rswParity.test.ts)",
    additionalConditions: "Entry LIMIT close/retrace H4; SL struktural max(1.5 ATR, 1% close) cap 6%; RR23: TP1 @ 2R take 50% -> BE -> 50% @ 3R; PAPER-only",
    defaultActive: false,
    requiresOperatorApproval: true,
  },
  "RSW-03": {
    id: "RSW-03",
    name: "RSW AlgoChief Fade + Ridge",
    mode: "SWING",
    description: "AlgoChief SHORT edge (H1) + H4 ADX<25 + retracement 0.25 ATR + gate Ridge (vector·beta >= 0, seed SHORT-only)",
    engineComposition: "researchSwing/rswSignals.ts (port swing_paper_signals.algo_signals + algo_events + vector/ridge; parity rswParity.test.ts)",
    additionalConditions: "Entry LIMIT close+0.25 ATR; SL struktural max high 5 bar + 0.25 ATR cap 6%; RR23: TP1 @ 2R take 50% -> BE -> 50% @ 3R; PAPER-only",
    defaultActive: false,
    requiresOperatorApproval: true,
  },
};

export interface FeeStructure {
  makerRate: number; // sumber: config/costs.ts (MAKER_RATE, turunan FEE_RATE)
  takerRate: number; // sumber: config/costs.ts (TAKER_RATE, turunan FEE_RATE)
}

// T-18: SATU tempat keputusan biaya = config/costs.ts (instruksi operator:
// tanpa model fee, FEE_RATE = 0). Literal rate tidak lagi dipencar di kode.
export const DEFAULT_FEE_STRUCTURE: FeeStructure = {
  makerRate: MAKER_RATE,
  takerRate: TAKER_RATE,
};

// Perintah operator 30 Sep 2026: TP tunggal (single target) & SL — jalur SCALP.
// Kode TP2/BE/TIMEOUT dihapus dari jalur SCALP; SWING memakai ladder di historicalReplay.
// "TP1_TP2" lama kini = "TP1" (100% ditutup di TP1) untuk SCALP.
// 16 Okt 2026 — lane SWING (S-05/S-03): replay kembali memakai ladder TP
// RR23 50/2R/3R (legacy 40/30/TPMAX dipertahankan untuk replay lama). SCALP tetap
// single-target. TIMEOUT TIDAK diadakan kembali (live tidak punya TIMEOUT;
// perintah operator 30 Sep); sisa qty di akhir dataset di-force-close DATA_END.
/** Label kaki exit ladder (kosakata V10 / oracle Python). */
export type LadderLegKind = "TP1" | "TP2" | "TPMAX" | "SL" | "BE" | "DATA_END";
/** Single target (SCALP): dipakai SimulatedTradeInput & jalur replay SCALP. */
export type SingleTargetExitReason = "TP1" | "SL";
/** Label berantai agregat hasil ladder (satu baris per trade,
 *  konsisten "DETAIL PER-TRADE (aggregated legs)" V10). */
export type LadderExitReason =
  | "SL" | "BE" | "DATA_END"
  | "TP1+SL" | "TP1+BE" | "TP1+DATA_END"
  | "TP1+TP2" | "TP1+TP2+BE" | "TP1+TP2+SL" | "TP1+TP2+DATA_END"
  | "TP1+TP2+TPMAX";
export type TradeExitReason = SingleTargetExitReason | LadderExitReason;

export interface SimulatedTradeInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  entryAt: Date;
  exitAt?: Date;
  mode: StrategyMode;
  outcomeReason: SingleTargetExitReason;
  maxLeverage?: number;
  equityUsd?: number;
}

export interface TradeResult {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  entryAt: Date;
  exitAt: Date;
  exitReason: TradeExitReason;
  slPct: number;
  effectiveNotional: number;
  effectiveRiskUsd: number;
  grossR: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  netR: number;
  isWin: boolean; // netPnlUsd > 0, including all modeled costs
  fundingUsd?: number;
}

export interface RDistributionBucket {
  range: string;
  min: number;
  max: number;
  count: number;
  pct: number;
}

export interface BacktestMetrics {
  sampleCount: number;
  winCount: number;
  lossCount: number;
  winrate: number; // 0 - 100 %
  evUsd: number; // net of fees + funding
  evR: number; // net of fees + funding
  maxDdUsd: number;
  totalGrossPnlUsd: number;
  totalFeesUsd: number;
  /** T1.1 (18 Okt 2026): total funding bertanda (negatif = kita bayar). */
  totalFundingUsd: number;
  totalNetPnlUsd: number;
}

export interface BacktestRunOutput {
  id?: number;
  strategyId: string;
  strategyName: string;
  mode: StrategyMode;
  paramsVersion: string;
  fromDate: Date;
  toDate: Date;
  metrics: BacktestMetrics;
  distributionR: RDistributionBucket[];
  gatePassed: boolean;
  status: "PASSED" | "FAILED";
  failedGateReasons: string[];
  trades?: TradeResult[];
  provenance?: BacktestProvenance;
  diagnostics?: { ambiguousBars: number; rejectedSignals: number; openTradesExcluded: number; fundingUsd: number; funnel?: import("./historicalReplay.js").ReplayFunnel };
}

/**
 * Simulasi satu trade dengan aturan fee, partial-TP, dan breakeven (FR-14, FR-17, FR-18, FR-19).
 */
export function simulateTrade(
  input: SimulatedTradeInput,
  fees: FeeStructure = DEFAULT_FEE_STRUCTURE,
  baseRiskUsd = 1.0
): TradeResult {
  const { symbol, direction, entryPrice, slPrice, tp1Price, entryAt, mode, outcomeReason } = input;
  const equity = input.equityUsd ?? 100;
  const maxLev = input.maxLeverage ?? 25;
  const effectiveLeverage = Math.min(25, maxLev);

  const slDist = Math.abs(entryPrice - slPrice);
  const slPct = slDist / entryPrice;

  // Rules.md Bagian 4: notional = R / slPct; margin = notional / leverage; margin <= 40% equity
  let notional = slPct > 0 ? baseRiskUsd / slPct : 10;
  let effectiveRiskUsd = baseRiskUsd;

  const marginRequired = notional / effectiveLeverage;
  const maxAllowedMargin = 0.4 * equity; // 40% dari equity

  if (marginRequired > maxAllowedMargin) {
    const scale = maxAllowedMargin / marginRequired;
    notional = Number((notional * scale).toFixed(4));
    effectiveRiskUsd = Number((baseRiskUsd * scale).toFixed(4));
  }

  // 30 Sep 2026: exit TIMEOUT dihapus. Hanya TP/SL yang menutup posisi.
  // Fixture sintetis memakai jarak hold tetap 30 menit (tanpa cabang timeout).
  const exitAt =
    input.exitAt ?? new Date(entryAt.getTime() + 30 * 60 * 1000);

  // Maker fee untuk entry (maker-first FR-22)
  const entryFee = notional * fees.makerRate;

  let grossR = 0;
  let exitFee = 0;
  let exitPrice = entryPrice;
  let isWin = false;

  // Synthetic fixture only: still derive arithmetic from supplied levels, never mode labels.
  const directionSign = direction === "LONG" ? 1 : -1;
  const tp1RMultiplier = directionSign * (tp1Price - entryPrice) / slDist;

  switch (outcomeReason) {
    case "TP1": {
      // Single-target (perintah operator 29 Sep 2026): 100% ditutup di TP1.
      // Tidak ada runner TP2 / pemindahan SL ke BE.
      isWin = true;
      grossR = tp1RMultiplier;
      exitPrice = tp1Price;
      const tp1Notional = notional * (tp1Price / entryPrice);
      exitFee = tp1Notional * fees.makerRate;
      break;
    }

    case "SL": {
      // 100% posisi terkena stop loss (taker fee 0.05%)
      isWin = false;
      grossR = -1.0;
      exitPrice = slPrice;
      const slNotional = notional * (slPrice / entryPrice);
      exitFee = slNotional * fees.takerRate;
      break;
    }
  }

  const totalFeesUsd = Number((entryFee + exitFee).toFixed(6));
  const grossPnlUsd = Number((grossR * effectiveRiskUsd).toFixed(6));
  const netPnlUsd = Number((grossPnlUsd - totalFeesUsd).toFixed(6));
  const netR = Number((baseRiskUsd > 0 ? netPnlUsd / baseRiskUsd : 0).toFixed(6));

  return {
    symbol,
    direction,
    entryPrice: Number(entryPrice.toFixed(6)),
    exitPrice: Number(exitPrice.toFixed(6)),
    entryAt,
    exitAt,
    exitReason: outcomeReason,
    slPct: Number(slPct.toFixed(6)),
    effectiveNotional: Number(notional.toFixed(4)),
    effectiveRiskUsd: Number(effectiveRiskUsd.toFixed(4)),
    grossR: Number(grossR.toFixed(4)),
    grossPnlUsd,
    feesUsd: totalFeesUsd,
    netPnlUsd,
    netR,
    isWin: netPnlUsd > 0,
  };
}

/**
 * Hitung histogram distribusi R.
 */
export function calculateRDistribution(trades: TradeResult[]): RDistributionBucket[] {
  const buckets: { range: string; min: number; max: number; count: number }[] = [
    { range: "< -0.5R", min: -Infinity, max: -0.5, count: 0 },
    { range: "-0.5R s/d 0.0R", min: -0.5, max: 0.0, count: 0 },
    { range: "0.0R s/d +0.5R", min: 0.0, max: 0.5, count: 0 },
    { range: "+0.5R s/d +1.0R", min: 0.5, max: 1.0, count: 0 },
    { range: "+1.0R s/d +1.5R", min: 1.0, max: 1.5, count: 0 },
    { range: ">= +1.5R", min: 1.5, max: Infinity, count: 0 },
  ];

  for (const t of trades) {
    const r = t.netR;
    for (const b of buckets) {
      if (r >= b.min && r < b.max) {
        b.count++;
        break;
      }
      if (b.max === Infinity && r >= b.min) {
        b.count++;
        break;
      }
    }
  }

  const total = Math.max(1, trades.length);
  return buckets.map((b) => ({
    range: b.range,
    min: b.min,
    max: b.max,
    count: b.count,
    pct: Number(((b.count / total) * 100).toFixed(2)),
  }));
}

/**
 * Evaluasi metrik dan drawdown dari rangkaian trade.
 */
export function calculateMetrics(trades: TradeResult[]): BacktestMetrics {
  const sampleCount = trades.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      winCount: 0,
      lossCount: 0,
      winrate: 0,
      evUsd: 0,
      evR: 0,
      maxDdUsd: 0,
      totalGrossPnlUsd: 0,
      totalFeesUsd: 0,
      totalFundingUsd: 0,
      totalNetPnlUsd: 0,
    };
  }

  let winCount = 0;
  let lossCount = 0;
  let totalGrossPnlUsd = 0;
  let totalFeesUsd = 0;
  let totalFundingUsd = 0;
  let totalNetPnlUsd = 0;
  let totalNetR = 0;

  let cumulativePnl = 0;
  let peakPnl = 0;
  let maxDdUsd = 0;

  for (const t of trades) {
    if (t.netPnlUsd > 0) winCount++;
    else lossCount++;

    totalGrossPnlUsd += t.grossPnlUsd;
    totalFeesUsd += t.feesUsd;
    totalFundingUsd += t.fundingUsd ?? 0;
    totalNetPnlUsd += t.netPnlUsd;
    totalNetR += t.netR;

    cumulativePnl += t.netPnlUsd;
    if (cumulativePnl > peakPnl) {
      peakPnl = cumulativePnl;
    }
    const currentDd = peakPnl - cumulativePnl;
    if (currentDd > maxDdUsd) {
      maxDdUsd = currentDd;
    }
  }

  const winrate = Number(((winCount / sampleCount) * 100).toFixed(2));
  const evUsd = Number((totalNetPnlUsd / sampleCount).toFixed(6));
  const evR = Number((totalNetR / sampleCount).toFixed(6));

  return {
    sampleCount,
    winCount,
    lossCount,
    winrate,
    evUsd,
    evR,
    maxDdUsd: Number(maxDdUsd.toFixed(4)),
    totalGrossPnlUsd: Number(totalGrossPnlUsd.toFixed(4)),
    totalFeesUsd: Number(totalFeesUsd.toFixed(4)),
    totalFundingUsd: Number(totalFundingUsd.toFixed(4)),
    totalNetPnlUsd: Number(totalNetPnlUsd.toFixed(4)),
  };
}

/**
 * Gate Backtest (AC-12, FR-14):
 *  - sampleCount >= minSamples (default 500)
 *  - winrate >= minWinrate (default 60.0%)
 *  - evUsd > 0.0 (EV bersih-fee positif)
 */
export function evaluateBacktestGate(
  metrics: BacktestMetrics,
  opts?: { minSamples?: number; minWinrate?: number }
): {
  gatePassed: boolean;
  failedGateReasons: string[];
} {
  const failedGateReasons: string[] = [];
  if (!Object.values(metrics).every(Number.isFinite)) failedGateReasons.push("NON_FINITE_METRICS");
  const minSamples = Math.max(500, Number.isFinite(opts?.minSamples) ? opts!.minSamples! : 500);
  const minWinrate = Math.max(60, Number.isFinite(opts?.minWinrate) ? opts!.minWinrate! : 60);

  if (metrics.sampleCount < minSamples) {
    failedGateReasons.push(minSamples === 1000 ? "SAMPLES_LT_1000" : `SAMPLES_LT_${minSamples}`);
  }
  const observedWinrate = metrics.sampleCount > 0 ? 100 * metrics.winCount / metrics.sampleCount : 0;
  if (!Number.isInteger(metrics.sampleCount) || !Number.isInteger(metrics.winCount) ||
      metrics.sampleCount < 0 || metrics.winCount < 0 || metrics.winCount > metrics.sampleCount ||
      metrics.winCount + metrics.lossCount !== metrics.sampleCount) failedGateReasons.push("INVALID_COUNTS");
  if (observedWinrate < minWinrate || metrics.winrate < minWinrate) {
    failedGateReasons.push(minWinrate === 60.0 ? "WINRATE_LT_60_PCT" : `WINRATE_LT_${minWinrate}_PCT`);
  }
  if (metrics.evUsd <= 0.0) {
    failedGateReasons.push("EV_NET_FEE_LE_0");
  }

  return {
    gatePassed: failedGateReasons.length === 0,
    failedGateReasons,
  };
}

export interface RunBacktestOptions {
  strategyId: string;
  mode?: StrategyMode;
  paramsVersion?: string;
  sampleCount?: number;
  fromDate?: Date;
  toDate?: Date;
  targetWinrate?: number;
  minSamples?: number;
  minWinrate?: number;
  fees?: FeeStructure;
  dataset?: HistoricalDataset;
  slippageBps?: number;
  initialEquityUsd?: number;
  marginMode?: "CROSS" | "ISOLATED";
  targetRiskUsd?: number;
  maxDrawdownUsd?: number;
  /** Only TP1 R is currently replay/runtime supported; absent means repository default policy. */
  tp1ROverride?: number;
  pullBiasThresholdOverride?: number;
  /** Candidate-only S-05 entry/SL parameters; absent = frozen baseline. */
  swingVolContrThresh?: number;
  swingSlMult?: number;
}

/**
 * Menghasilkan trade sintetis deterministik untuk pengujian offline dan verifikasi gate.
 */
export function generateSyntheticTrades(
  strategyId: string,
  mode: StrategyMode,
  count: number,
  targetWinrate = 60.0,
  fees: FeeStructure = DEFAULT_FEE_STRUCTURE
): TradeResult[] {
  const trades: TradeResult[] = [];
  const baseTime = new Date("2026-01-01T00:00:00Z").getTime();

  // Universe simbol per strategi agar realistis dan representatif
  const symbolsByStrategy: Record<string, string[]> = {
    "S-01": ["BNBUSDT", "SAGAUSDT", "PEPEUSDT", "XPLUSDT", "OPUSDT", "ARBUSDT"],
    "S-02": ["TAOUSDT", "SOLUSDT", "NEARUSDT", "ADAUSDT", "DOTUSDT", "RENDERUSDT"],
    "S-03": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"],
  };
  const symbols = symbolsByStrategy[strategyId] ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

  // Exact target win count
  const targetWins = Math.round((targetWinrate / 100.0) * count);

  // Distribusi win yang terdistribusi alami (tidak mengelompok di awal/akhir)
  const isWinArray = new Array(count).fill(false);
  const indices = Array.from({ length: count }, (_, i) => i);
  const salt = (strategyId.charCodeAt(0) * 17 + (strategyId.charCodeAt(2) || 1) * 23) % 97;
  indices.sort((a, b) => ((a * 37 + salt) % count) - ((b * 37 + salt) % count));
  for (let i = 0; i < targetWins && i < count; i++) {
    isWinArray[indices[i]!] = true;
  }

  for (let i = 0; i < count; i++) {
    const symbol = symbols[i % symbols.length]!;
    const direction: "LONG" | "SHORT" = (i + salt) % 2 === 0 ? "LONG" : "SHORT";
    const entryPrice = 50 + ((i * 3 + salt) % 150) * 2;
    const slDist = entryPrice * 0.008; // 0.8% SCALP-only (30 Sep 2026)
    const slPrice = direction === "LONG" ? entryPrice - slDist : entryPrice + slDist;
    const tp1R = rrPolicyForMode(mode).tp1R;
    const tp1Price = direction === "LONG" ? entryPrice + tp1R * slDist : entryPrice - tp1R * slDist;
    const entryAt = new Date(baseTime + i * 3600 * 1000);

    const isWin = isWinArray[i];
    const outcomeReason: SingleTargetExitReason = isWin ? "TP1" : "SL";

    const t = simulateTrade(
      {
        symbol,
        direction,
        entryPrice,
        slPrice,
        tp1Price,
        entryAt,
        mode,
        outcomeReason,
      },
      fees
    );

    trades.push(t);
  }

  return trades;
}

/**
 * Eksekusi backtest lengkap untuk strategi aktif S-01/S-02/S-03 (renumber 6 Okt 2026).
 */
export function runStrategyBacktest(options: RunBacktestOptions): BacktestRunOutput {
  const cat = STRATEGY_CATALOG[options.strategyId];
  if (!cat) throw new Error(`Unknown strategy ${options.strategyId}`);
  const mode = options.mode ?? cat.mode;
  const paramsVersion = options.paramsVersion ?? "shared-source-v1";
  const d = options.dataset;
  const fees = options.fees ?? DEFAULT_FEE_STRUCTURE;
  const slippageBps = options.slippageBps ?? 5;
  const initialEquityUsd = options.initialEquityUsd ?? 200;
  const targetRiskUsd = options.targetRiskUsd ?? 1;
  const invalidOptions = ![fees.makerRate, fees.takerRate, slippageBps].every(v => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(initialEquityUsd) || initialEquityUsd <= 0 || !Number.isFinite(targetRiskUsd) || targetRiskUsd <= 0 || targetRiskUsd > 1;
  const replay = d && !invalidOptions ? replayHistoricalDataset(d, {strategyId:cat.id, mode, fees, slippageBps, initialEquityUsd, targetRiskUsd, marginMode: options.marginMode ?? "CROSS", tp1ROverride: options.tp1ROverride, pullBiasThresholdOverride: options.pullBiasThresholdOverride, swingVolContrThresh: options.swingVolContrThresh, swingSlMult: options.swingSlMult}) :
    {trades:[], errors:[invalidOptions ? "INVALID_REPLAY_OPTIONS" : "INSUFFICIENT_DATA"], ambiguousBars:0,rejectedSignals:0,openTradesExcluded:0,fundingUsd:0};
  const metrics = calculateMetrics(replay.trades);
  const gate = evaluateBacktestGate(metrics, {minSamples:options.minSamples,minWinrate:options.minWinrate});
  const reasons = [...replay.errors, ...gate.failedGateReasons];
  if (replay.openTradesExcluded) reasons.push("OPEN_TRADES_UNRESOLVED");
  if (!Number.isFinite(options.maxDrawdownUsd) || options.maxDrawdownUsd! <= 0) reasons.push("DRAWDOWN_LIMIT_REQUIRED");
  else if (metrics.maxDdUsd > options.maxDrawdownUsd!) reasons.push("DRAWDOWN_LIMIT_EXCEEDED");
  const provenance: BacktestProvenance = {
    kind:d ? "HISTORICAL_REPLAY" : "NO_DATA", scope:"DETERMINISTIC_SINGLE_SYMBOL",
    strategyVersion:paramsVersion, parametersApplied:Boolean(d && (options.tp1ROverride !== undefined || options.pullBiasThresholdOverride !== undefined || options.swingVolContrThresh !== undefined || options.swingSlMult !== undefined) && replay.errors.length === 0),
    appliedParameters: { ...(options.tp1ROverride !== undefined ? {tp1R: options.tp1ROverride} : {}), ...(options.pullBiasThresholdOverride !== undefined ? {pullBiasThreshold: options.pullBiasThresholdOverride} : {}), ...(options.swingVolContrThresh !== undefined ? {swingVolContrThresh: options.swingVolContrThresh} : {}), ...(options.swingSlMult !== undefined ? {swingSlMult: options.swingSlMult} : {}) },
    llmReplayed:false, portfolioReplayed:false,
    ...(d ? {datasetHash:datasetHash(d),source:d.source,outOfSampleFrom:d.outOfSampleFrom,outOfSampleTo:d.outOfSampleTo,trainingEndedAt:d.trainingEndedAt,embargoMs:d.embargoMs} : {}),
    limitations:["Single-symbol strategy only; macro/universe/LLM/portfolio policies are not replayed.",
      "Static symbol filters are supplied by the operator; point-in-time filter history is not verified.",
      "OHLC sequencing is conservative, not actual fills; all execution uses taker fees and adverse slippage.",
      "Exits are static SL/TP only; trend-flip exits are not replayed.",
      "No liquidation model: this report is not live or leveraged portfolio certification.",
      "OOS split and source are declared metadata; external data authenticity and prior holdout reuse are not proven.",
      options.tp1ROverride === undefined && options.pullBiasThresholdOverride === undefined && options.swingVolContrThresh === undefined && options.swingSlMult === undefined ? "No tuning override applied; run measures the repository default." : "Only explicit replay overrides recorded in appliedParameters are applied; all other parameters remain fixed."]
  };
  return {strategyId:cat.id,strategyName:cat.name,mode,paramsVersion,
    fromDate:new Date(d?.outOfSampleFrom ?? options.fromDate ?? 0),toDate:new Date(d?.outOfSampleTo ?? options.toDate ?? 0),
    metrics,distributionR:calculateRDistribution(replay.trades),gatePassed:reasons.length===0,status:reasons.length===0?"PASSED":"FAILED",
    failedGateReasons:[...new Set(reasons)],trades:replay.trades,provenance,
    diagnostics:{ambiguousBars:replay.ambiguousBars,rejectedSignals:replay.rejectedSignals,openTradesExcluded:replay.openTradesExcluded,fundingUsd:replay.fundingUsd,funnel:replay.funnel}};
}

/**
 * InMemory & DB store untuk BacktestRun (Schema.md 1.10).
 */
export class BacktestRunRepository {
  private inMemoryRuns: Map<number, BacktestRunOutput> = new Map();
  private nextId = 1;

  async saveRun(output: BacktestRunOutput, dbClient?: any): Promise<number> {
    const runId = this.nextId++;
    const stored = { ...output, id: runId };
    this.inMemoryRuns.set(runId, stored);

    if (dbClient?.backtestRun?.create) {
      try {
        const created = await dbClient.backtestRun.create({
          data: {
            strategyId: output.strategyId,
            strategyName: output.strategyName,
            mode: output.mode,
            fromDate: output.fromDate,
            toDate: output.toDate,
            sampleCount: output.metrics.sampleCount,
            winrate: output.metrics.winrate,
            evUsd: output.metrics.evUsd,
            evR: output.metrics.evR,
            maxDdUsd: output.metrics.maxDdUsd,
            feeModel: JSON.stringify({schemaVersion:2,provenance:output.provenance,metrics:output.metrics,diagnostics:output.diagnostics}),
            paramsVersion: output.paramsVersion,
            status: output.status,
            failedReasons: output.failedGateReasons.length > 0 ? JSON.stringify(output.failedGateReasons) : null,
            distributionR: JSON.stringify(output.distributionR),
          },
        });
        if (created?.id) {
          stored.id = runId;
          if (output.trades && output.trades.length > 0 && dbClient.backtestTrade?.createMany) {
            await dbClient.backtestTrade.createMany({
              data: output.trades.map((t) => ({
                runId: created.id,
                symbol: t.symbol,
                direction: t.direction,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                entryAt: t.entryAt,
                exitAt: t.exitAt,
                rMultiple: t.netR,
                grossPnl: t.grossPnlUsd,
                netPnl: t.netPnlUsd,
                feesUsd: t.feesUsd,
                exitReason: t.exitReason,
              })),
            });
          }
        }
      } catch {
        // Fallback in-memory
      }
    }

    return runId;
  }

  getRun(id: number): BacktestRunOutput | null {
    return this.inMemoryRuns.get(id) ?? null;
  }

  getAllRuns(): BacktestRunOutput[] {
    return Array.from(this.inMemoryRuns.values()).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  }

  async loadFromDb(dbClient?: any): Promise<void> {
    if (dbClient?.backtestRun?.findMany) {
      try {
        const rows = await dbClient.backtestRun.findMany({
          orderBy: { id: "desc" },
          take: 50,
        });
        for (const row of rows) {
          if (!this.inMemoryRuns.has(row.id)) {
            const evidence = row.feeModel ? JSON.parse(row.feeModel) : {};
            const verified = evidence.schemaVersion === 2 && evidence.provenance?.kind === "HISTORICAL_REPLAY";
            const distributionR = typeof row.distributionR === "string" ? JSON.parse(row.distributionR) : [];
            const failedGateReasons = row.failedReasons ? JSON.parse(row.failedReasons) : [];
            this.inMemoryRuns.set(row.id, {
              id: row.id,
              strategyId: row.strategyId,
              strategyName: row.strategyName,
              mode: row.mode as StrategyMode,
              paramsVersion: row.paramsVersion,
              fromDate: row.fromDate,
              toDate: row.toDate,
              metrics: {
                sampleCount: row.sampleCount,
                winCount: Math.round((row.winrate / 100) * row.sampleCount),
                lossCount: row.sampleCount - Math.round((row.winrate / 100) * row.sampleCount),
                winrate: row.winrate,
                evUsd: row.evUsd,
                evR: row.evR,
                maxDdUsd: row.maxDdUsd,
                totalGrossPnlUsd: Number((row.evUsd * row.sampleCount).toFixed(4)),
                totalFeesUsd: Number((0.04 * row.sampleCount).toFixed(4)),
                totalNetPnlUsd: Number((row.evUsd * row.sampleCount).toFixed(4)),
              },
              distributionR,
              gatePassed: verified && row.status === "PASSED",
              status: verified && row.status === "PASSED" ? "PASSED" : "FAILED",
              failedGateReasons: verified ? failedGateReasons : [...failedGateReasons, "LEGACY_UNVERIFIED"],
              provenance: verified ? evidence.provenance : {kind:"LEGACY_UNVERIFIED",scope:"DETERMINISTIC_SINGLE_SYMBOL",strategyVersion:row.paramsVersion,parametersApplied:false,llmReplayed:false,portfolioReplayed:false,limitations:["Legacy results may be synthetic; cannot certify performance."]},
              diagnostics: evidence.diagnostics,
              ...(verified && evidence.metrics ? {metrics:evidence.metrics} : {}),
            });
          }
        }
      } catch {
        // Fallback in-memory
      }
    }
  }

  clear(): void {
    this.inMemoryRuns.clear();
    this.nextId = 1;
  }
}

export const backtestRepo = new BacktestRunRepository();

