import { swingLadderLevelsFromTp1 } from "../strategies/swing/swingLevels.js";
export { swingLadderLevelsFromTp1 } from "../strategies/swing/swingLevels.js";
import { createHash } from "node:crypto";
import type { Bar } from "../universe/eligibility.js";
import { analyzeTimeframe, composeMtfAnalysis } from "../engines/multiTimeframeAnalyzer.js";
import { getTimeframePlan } from "../config/timeframes.js";
import { rrPolicyForMode } from "../config/setupEngine.js";
import { buildStrategyPlans, evaluateLiquiditySniper, evaluateSwingBreakoutArchive, type StrategyPlan } from "../strategies/setupStrategies.js";
import { DEFAULT_LIQUIDITY_SNIPER_OPTIONS } from "../engines/indicatorLibrary.js";
import { calculateOrderPlan, quantizeStep, roundToTick, type OrderPlan } from "../risk/riskEngine.js";
import { checkModeMarketFit, checkSwingMarketFit } from "../exec/marketSelectionPolicy.js";
import { SWING_TP1_FRAC, SWING_TP2_FRAC } from "../strategies/swingBreakoutEngine.js";
import type { FeeStructure, LadderLegKind, LadderExitReason, StrategyMode, TradeResult } from "./backtestEngine.js";
import { estimateLimitFillRatio } from "./partialFillModel.js";

export interface HistoricalDataset {
  schemaVersion: 1;
  source: string;
  downloadedAt: number;
  symbol: string;
  intervalMs: number;
  bars: Bar[];
  funding: { time: number; rate: number; markPrice: number }[];
  fundingCoverage: { from: number; to: number };
  rules: { tickSize: number; stepSize: number; minQty: number; minNotional: number; maxLeverage: number };
  outOfSampleFrom: number;
  outOfSampleTo: number;
  trainingEndedAt: number;
  embargoMs: number;
  universeSelection: string;
}

export interface BacktestProvenance {
  kind: "HISTORICAL_REPLAY" | "NO_DATA" | "LEGACY_UNVERIFIED";
  scope: "DETERMINISTIC_SINGLE_SYMBOL";
  datasetHash?: string;
  source?: string;
  outOfSampleFrom?: number;
  outOfSampleTo?: number;
  trainingEndedAt?: number;
  embargoMs?: number;
  strategyVersion: string;
  parametersApplied: boolean;
  appliedParameters?: Record<string, number>;
  llmReplayed: false;
  portfolioReplayed: false;
  limitations: string[];
}

export const INTERVAL_MS: Record<string, number> = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };

function lowerBound<T>(values:T[],time:number,key:(item:T)=>number):number {
  let lo=0,hi=values.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(key(values[mid]!)<time)lo=mid+1;else hi=mid;}
  return lo;
}

/** Reject missing/duplicated/out-of-order bars instead of filling prices with hindsight. */
export function validateHistoricalDataset(d: HistoricalDataset): string[] {
  const errors: string[] = [];
  if (!d || d.schemaVersion !== 1 || typeof d.source !== "string" || !d.source.trim() || typeof d.symbol !== "string" || !d.symbol.trim() || typeof d.universeSelection !== "string" || !d.universeSelection.trim()) return ["INVALID_DATASET_METADATA"];
  if (!Number.isFinite(d.downloadedAt) || d.downloadedAt < d.outOfSampleTo) errors.push("INVALID_DOWNLOAD_TIMESTAMP");
  // One-minute bars bound the intrabar ambiguity; larger bars cannot certify this replay.
  if (d.intervalMs !== 60000) errors.push("ONE_MINUTE_BARS_REQUIRED");
  if (![d.outOfSampleFrom, d.outOfSampleTo, d.trainingEndedAt, d.embargoMs].every(Number.isFinite) ||
      d.embargoMs < 0 || d.trainingEndedAt + d.embargoMs >= d.outOfSampleFrom || d.outOfSampleFrom >= d.outOfSampleTo || d.outOfSampleFrom%60000!==0 || d.outOfSampleTo%60000!==0) errors.push("INVALID_CHRONOLOGICAL_SPLIT");
  if (!d.rules || ![d.rules.tickSize, d.rules.stepSize, d.rules.minQty, d.rules.minNotional, d.rules.maxLeverage].every(v => Number.isFinite(v) && v > 0)) errors.push("INVALID_SYMBOL_RULES");
  if (!Array.isArray(d.bars) || d.bars.length < 2) return [...errors, "INSUFFICIENT_BARS"];
  for (let i = 0; i < d.bars.length; i++) {
    const b = d.bars[i]!;
    if (!b || ![b.openTime,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) || b.openTime % d.intervalMs !== 0 ||
        Math.min(b.open,b.high,b.low,b.close) <= 0 || b.volume < 0 || b.high < Math.max(b.open,b.close,b.low) || b.low > Math.min(b.open,b.close,b.high)) { errors.push("INVALID_OHLC"); break; }
    if (i && b.openTime !== d.bars[i-1]!.openTime + d.intervalMs) { errors.push("NON_CONTIGUOUS_BARS"); break; }
  }
  if (!d.bars[0] || !d.bars.at(-1) || d.bars[0]!.openTime >= d.outOfSampleFrom || d.bars.at(-1)!.openTime + d.intervalMs < d.outOfSampleTo) errors.push("INCOMPLETE_BAR_COVERAGE");
  if (!Array.isArray(d.funding) || !d.fundingCoverage || ![d.fundingCoverage.from,d.fundingCoverage.to].every(Number.isFinite) || d.fundingCoverage.from > d.outOfSampleFrom || d.fundingCoverage.to < d.outOfSampleTo) errors.push("MISSING_FUNDING_COVERAGE");
  else for (let i=0;i<d.funding.length;i++) {
    const f=d.funding[i]!;
    if (!f || ![f.time,f.rate,f.markPrice].every(Number.isFinite) || f.time%60000!==0 || f.markPrice <= 0 || (i>0 && f.time <= d.funding[i-1]!.time)) { errors.push("INVALID_FUNDING"); break; }
  }
  return [...new Set(errors)];
}

/** Only complete UTC-aligned candles can enter an indicator. */
export function aggregateClosedBars(bars: Bar[], intervalMs: number, decisionTime: number, baseMs = 60000): Bar[] {
  const out: Bar[] = [];
  let group: Bar[] = [];
  let bucket = -1;
  const flush = () => {
    if (group.length !== intervalMs/baseMs || bucket + intervalMs > decisionTime || group[0]!.openTime !== bucket) return;
    out.push({openTime:bucket,open:group[0]!.open,high:Math.max(...group.map(b=>b.high)),low:Math.min(...group.map(b=>b.low)),close:group.at(-1)!.close,volume:group.reduce((n,b)=>n+b.volume,0)});
  };
  for (const b of bars) {
    if (b.openTime + baseMs > decisionTime) break;
    const next = Math.floor(b.openTime/intervalMs)*intervalMs;
    if (next !== bucket) { flush(); group=[]; bucket=next; }
    group.push(b);
  }
  flush();
  return out;
}

export function historicalStrategyPlan(d: HistoricalDataset, mode: StrategyMode, strategyId: string, decisionTime: number, tp1ROverride?: number, pullBiasThresholdOverride?: number, swingVolContrThresh?: number, swingSlMult?: number, btcDailyBars?: Bar[]): {plan:StrategyPlan|null; atr:number|null} {
  const specs=getTimeframePlan(mode).specs;
  const maxWindow=Math.max(...specs.map(s=>INTERVAL_MS[s.interval]!*(s.limit+1)));
  // Slice by timestamp BEFORE indicator execution, including only closed base bars.
  const available=d.bars.slice(lowerBound(d.bars,decisionTime-maxWindow,b=>b.openTime),lowerBound(d.bars,decisionTime,b=>b.openTime));
  const snapshots=specs.map(s=>analyzeTimeframe(d.symbol,s.interval,s.role,aggregateClosedBars(available,INTERVAL_MS[s.interval]!,decisionTime,d.intervalMs).slice(-s.limit),s.atrPeriod));
  const analysis=composeMtfAnalysis(d.symbol,mode,snapshots,decisionTime);
  if (!analysis.usable) return {plan:null,atr:analysis.atrTrigger};
  // 13 Okt 2026 (S-05): mode SWING memakai gate market-nya sendiri (tanpa
  // chop/ADX/anti-sideways SCALP — trigger milik mesin channel 1h).
  const marketFit = mode === "SWING"
    ? checkSwingMarketFit({structureChop:analysis.structure.chop,
        structureAdx:analysis.structure.adx,
        biasChop:analysis.bias.chop,biasAdx:analysis.bias.adx})
    : checkModeMarketFit({mode,structureChop:analysis.structure.chop,
        structureAdx:analysis.structure.adx,structureAtrPct:analysis.structure.atrPct,
        biasChop:analysis.bias.chop,biasAdx:analysis.bias.adx,
        biasTrend:analysis.bias.trend,biasRegime:analysis.bias.regime});
  if (!marketFit.allowed) return {plan:null,atr:analysis.atrTrigger};
  const price=available.at(-1)?.close ?? 0;
  // Data khusus S-04 (7 Okt 2026): seri 5m tertutup SEJAK AWAL dataset
  // (bukan jendela MTF 90 bar) supaya seed EMA200 (>= 200 bar) dan D_EMA50
  // (>= 50 hari UTC lengkap, di-agregasi mesin dari bar 5m) tersedia. Hanya
  // bar yang sudah tutup pada decisionTime yang masuk (aggregateClosedBars).
  // S-01/S-02/S-03 tidak membaca field ini — perilaku mereka tidak berubah.
  const mrv5m = strategyId === "S-04" ? aggregateClosedBars(d.bars, 300000, decisionTime, d.intervalMs) : [];
  // 13 Okt 2026 (S-05): seri 1h TERTUTUP dari jendela SWING — input mesin
  // channel (aggregateClosedBars memastikan hanya bar yang sudah tutup di
  // decisionTime; S-01..S-04 tidak membaca field ini).
  const swingH1 = mode === "SWING" ? aggregateClosedBars(available, 3600000, decisionTime, d.intervalMs) : [];
  // T0.5 (18 Okt 2026): RSW-01/02 butuh H4 (>= 200 bar), RSW-03 butuh H1
  // panjang (>= 801 bar). Agregasi hanya dilakukan bila strategyId RSW supaya
  // S-05/S-03 tidak membayar biaya komputasi tambahan. BTC D1 context is
  // optional and point-in-time filtered when supplied by the caller; without
  // it the BOS_LONG leg of RSW-01 is fail-closed (PHEN SHORT remains alive).
  const isRsw = strategyId.startsWith("RSW-");
  // RSW needs >=200 H4 bars; the MTF window is only ~90 H1 bars, so using
  // `available` here silently starved the H4 evaluator. Use the full dataset
  // prefix (closed bars only), exactly like h1BarsLong.
  const swingH4 = (mode === "SWING" && isRsw) ? aggregateClosedBars(d.bars, 4 * 3600000, decisionTime, d.intervalMs) : [];
  const swingH1Long = (mode === "SWING" && isRsw) ? aggregateClosedBars(d.bars, 3600000, decisionTime, d.intervalMs) : [];
  const swingCtx = mode === "SWING"
    ? { h1Bars: swingH1, ...(isRsw ? { h4Bars: swingH4, h1BarsLong: swingH1Long,
        // Point-in-time BTC D1 context for RSW-01 BOS_LONG. Only completed
        // daily buckets are exposed; an empty context keeps the old fail-closed
        // PHEN-only behavior instead of inventing a regime.
        btcDailyBars: (btcDailyBars ?? []).filter((b) => b.openTime + 86400000 <= decisionTime) } : {}),
        ...(swingVolContrThresh !== undefined ? { volContrThresh: swingVolContrThresh } : {}),
        ...(swingSlMult !== undefined ? { slMult: swingSlMult } : {}) }
    : undefined;
  const ctx = {analysis,mode,price,tp1ROverride,mrv:{m5Bars:mrv5m},...(swingCtx ? {swing:swingCtx} : {})};
  // 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05 dihapus
  // dari katalog AKTIF, jadi buildStrategyPlans tidak lagi menghasilkan plan
  // S-05 (spec-nya hilang). Tapi S-05 TETAP bisa direplay historis: evaluator
  // mesinnya (swingBreakoutEngine) masih hidup, dan operatorCommunikated akan
  // meracik backtest dari strategi lain. Jalur replay khusus di sini memakai
  // evaluator mesin langsung, DI LUAR katalog aktif — tidak pernah jadi entry.
  const plans = strategyId === "S-02" && pullBiasThresholdOverride !== undefined
    ? [evaluateLiquiditySniper(ctx, { ...DEFAULT_LIQUIDITY_SNIPER_OPTIONS, pullBiasThreshold: pullBiasThresholdOverride })]
    : strategyId === "S-05"
      ? [evaluateSwingBreakoutArchive(ctx)]
      : buildStrategyPlans(ctx,decisionTime);
  const plan=plans.find(p=>p.strategyId===strategyId && p.matched) ?? null;
  return {plan,atr:analysis.atrTrigger};
}

export interface ReplayOptions {strategyId:string;mode:StrategyMode;fees:FeeStructure;slippageBps:number;initialEquityUsd:number;targetRiskUsd:number;marginMode?:"CROSS"|"ISOLATED";swingExitPolicy?:"LEGACY_40_30"|"RR23";tp1ROverride?:number;pullBiasThresholdOverride?:number;swingVolContrThresh?:number;swingSlMult?:number; btcDailyBars?: Bar[]}
export interface ReplayFunnel {
  decisionTimes: number;
  plans: number;
  planLong: number;
  planShort: number;
  orderAllowed: number;
  orderRejected: number;
  orderRejectedReasons: Record<string, number>;
  fillScaledBelowMin: number;
  openTradesExcluded: number;
  closedTrades: number;
  fundingCoverage: "FULL" | "PARTIAL" | "MISSING";
}
export interface ReplayOutput {trades:TradeResult[];errors:string[];ambiguousBars:number;rejectedSignals:number;openTradesExcluded:number;fundingUsd:number;funnel?:ReplayFunnel}

// ---------------------------------------------------------------------------
// Ladder TP 40/30/BE/TPmax (16 Okt 2026) — paritas live + laporan V10 16/16.
// Konvensi bar (persis run_v10.py manage_all + oracle _ladder_exit, bound
// "sl_first"):
//   1. Stop dicek PERTAMA tiap bar; bar yang menyentuh stop+level TP = stop
//      menang (TP tidak terisi bar itu, ambiguousBars++).
//   2. Fase TP berantai dalam satu bar (if berantai, bukan else if) — satu bar
//      besar bisa mengisi TP1+TP2+TPMAX sekaligus, masing-masing di harga level.
//   3. BE efektif bar BERIKUTNYA: setelah kaki TP2, stop=entry dipasang SETELAH
//      cek stop bar berjalan. Exit pasca-TP2 yang kena stop-entry = leg "BE".
//   4. Gap stop -> fill di open (lebih buruk); tanpa gap fill tepat di stop.
//   5. TIMEOUT TIDAK ada (live tidak punya TIMEOUT). Sisa qty saat window
//      (outOfSampleTo) habis -> force-close "DATA_END" di close bar terakhir.
// Fee per leg (model live: entry & TP = LIMIT maker, SL = STOP_MARKET taker):
//   entry = maker atas notional penuh; TP1/TP2/TPMAX = maker; SL/BE/DATA_END =
//   taker. (Deviasi mikro dari run_v10.py yang membebankan entry pada rate kaki
//   exit per-leg; riset momentum_zone.py memakai semua-maker = keputusan riset,
//   bukan model live.) SCALP: tidak tersentuh — jalur single-target lama tetap
//   taker penuh, bit-identik.
// Orde level monoton (tp1 & tp2 searah, tpMax terjauh) => hitTpX implisit
// berurutan: bar yang mencapai tp2 pasti mencapai tp1 juga.
// ---------------------------------------------------------------------------

/** Level ladder SWING dari offset TP1 — identik `swingLadderLevels`/`swingTpMaxPrice`
 *  (positionSupervisor.ts) dan mesin plan (entry ± n*offset, offset=|tp1-entry|).
 *  OrderPlan.tp2Price sengaja TIDAK dipakai agar level replay & live dihitung
 *  satu formula yang sama. */


/** Gabungkan kaki ladder menjadi label agregat ("TP1+TP2+BE", "SL", ...).
 *  Tata bahasa kaki menjamin anggota union: TP1 sebelum TP2 sebelum TPMAX,
 *  terminal SL/BE/DATA_END/TPMAX maksimal satu di akhir. */
export function ladderExitLabel(legs:readonly {kind:LadderLegKind}[]):LadderExitReason {
  return legs.map(l=>l.kind).join("+") as LadderExitReason;
}

export interface LadderLeg {frac:number;price:number;kind:LadderLegKind;barIndex:number}
export interface LadderExitInput {side:"LONG"|"SHORT";entry:number;sl:number;tp1:number;tp2:number;tpMax:number;tp1Frac?:number;tp2Frac?:number;beAfterTp1?:boolean;slippageBps:number;outOfSampleTo:number;intervalMs:number}
export interface LadderExitResult {legs:LadderLeg[];exitBar:number;ambiguousBars:number}

/** Simulasi exit ladder murni (tanpa uang/fee/funding) — diekspor untuk unit
 *  test bar-per-bar dan paritas TS<->Python (momentum_zone.py `_ladder_exit`,
 *  yang discan dari start_i+1; di sini entryIndex = bar pertama yang dicek,
 *  entry terisi di open bar ini). Hasil selalu resolve: kaki terakhir
 *  SL/BE/TPMAX, atau DATA_END bila window habis dengan sisa qty. */
export function simulateLadderExit(bars:Bar[], entryIndex:number, input:LadderExitInput):LadderExitResult {
  const legs:LadderLeg[]=[];
  const sign=input.side==="LONG"?1:-1;
  const adverse=(price:number)=>price*(1-sign*input.slippageBps/10000);
  const tp1Frac=input.tp1Frac??SWING_TP1_FRAC;
  const tp2Frac=input.tp2Frac??SWING_TP2_FRAC;
  let stop=input.sl, beActive=false, doneTp1=false, doneTp2=false, ambiguousBars=0;
  let closed=false;
  let lastBar=entryIndex;
  for(let i=entryIndex;i<bars.length;i++) {
    const b=bars[i]!;
    if(b.openTime+input.intervalMs>input.outOfSampleTo) break;
    lastBar=i;
    const stopHit=sign===1?b.low<=stop:b.high>=stop;
    const hitTp1=!doneTp1&&(sign===1?b.high>=input.tp1:b.low<=input.tp1);
    const hitTp2=!doneTp2&&(sign===1?b.high>=input.tp2:b.low<=input.tp2);
    const tpMaxReached=sign===1?b.high>=input.tpMax:b.low<=input.tpMax;
    if(stopHit) {
      // worst-first: stop menang bar ini; level TP yang masih menggantung dan
      // tersentuh bar yang sama = ambigu (OHLC tak bisa memastikan urutan).
      if(hitTp1||hitTp2||(doneTp1&&doneTp2&&tpMaxReached)) ambiguousBars++;
      const px=adverse(sign===1?Math.min(stop,b.open):Math.max(stop,b.open));
      legs.push({frac:1-legs.reduce((n,l)=>n+l.frac,0),price:px,kind:beActive?"BE":"SL",barIndex:i});
      closed=true;
      break;
    }
    // Fase berantai dalam satu bar (persis run_v10.py: cek TPMAX setelah fill
    // TP1/TP2 bar yang sama, jadi satu bar besar bisa mengisi ketiganya).
    if(hitTp1) {legs.push({frac:tp1Frac,price:adverse(input.tp1),kind:"TP1",barIndex:i});doneTp1=true;if(input.beAfterTp1){beActive=true;stop=input.entry;}}
    if(hitTp2) {
      legs.push({frac:tp2Frac,price:adverse(input.tp2),kind:"TP2",barIndex:i});doneTp2=true;beActive=true;stop=input.entry;
      if (legs.reduce((n,l)=>n+l.frac,0) >= 1-1e-12) { closed=true; break; }
    }
    if(doneTp1&&doneTp2&&tpMaxReached) {
      legs.push({frac:1-legs.reduce((n,l)=>n+l.frac,0),price:adverse(input.tpMax),kind:"TPMAX",barIndex:i});
      closed=true;
      break;
    }
  }
  if(!closed) {
    // DATA_END: sisa qty di-force-close di close bar terakhir dalam window.
    legs.push({frac:1-legs.reduce((n,l)=>n+l.frac,0),price:adverse(bars[lastBar]!.close),kind:"DATA_END",barIndex:lastBar});
  }
  return {legs,exitBar:lastBar,ambiguousBars};
}

/** Jalur ladder SWING: satu TradeResult dengan kaki diagregasi + label berantai. */
function replaySwingLadderTrade(d: HistoricalDataset, order: OrderPlan, entryIndex:number, options:ReplayOptions): {trade:TradeResult|null;nextIndex:number;ambiguousBars:number;fundingUsd:number} {
  const entryBar=d.bars[entryIndex]!;
  const sign=order.side==="LONG"?1:-1;
  const entry=order.entryPrice;
  const initialQty=order.qty;
  const originalRisk=Math.abs(entry-order.slPrice)*initialQty;
  const rr23 = options.swingExitPolicy !== "LEGACY_40_30";
  const {tp2,tpMax}=swingLadderLevelsFromTp1(order.side,entry,order.tp1Price,rr23);
  const {legs,exitBar,ambiguousBars}=simulateLadderExit(d.bars,entryIndex,{
    side:order.side,entry,sl:order.slPrice,tp1:order.tp1Price,tp2,tpMax,tp1Frac:rr23?0.5:SWING_TP1_FRAC,tp2Frac:rr23?0.5:SWING_TP2_FRAC,beAfterTp1:rr23,
    slippageBps:options.slippageBps,outOfSampleTo:d.outOfSampleTo,intervalMs:d.intervalMs});
  // The new policy has no timeout/forced historical-end liquidation.
  if (rr23 && legs.at(-1)?.kind === "DATA_END") return {trade:null,nextIndex:d.bars.length,ambiguousBars,fundingUsd:0};
  const isTpLeg=(k:LadderLegKind)=>k==="TP1"||k==="TP2"||k==="TPMAX";
  let gross=0, fees=entry*initialQty*options.fees.makerRate, weightedExit=0, qty=initialQty;
  for(const leg of legs) {
    const amount=Number((initialQty*leg.frac).toFixed(12));
    gross+=sign*(leg.price-entry)*amount;
    fees+=leg.price*amount*(isTpLeg(leg.kind)?options.fees.makerRate:options.fees.takerRate);
    weightedExit+=leg.price*amount;
    qty=Number((qty-amount).toFixed(12));
  }
  // Funding persis konvensi jalur lama: event per bar dibebankan pada qty
  // awal-bar (sebelum kaki-kaki bar itu), hanya untuk bar yang masih dipakai.
  let funding=0;
  let fundingIndex=lowerBound(d.funding,entryBar.openTime+1,f=>f.time);
  const qtyAtBarStart=(barIdx:number)=>initialQty-legs.reduce((n,l)=>n+(l.barIndex<barIdx?initialQty*l.frac:0),0);
  for(let i=entryIndex;i<=exitBar&&i<d.bars.length;i++) {
    const b=d.bars[i]!;
    if(b.openTime+d.intervalMs>d.outOfSampleTo) break;
    while(fundingIndex<d.funding.length&&d.funding[fundingIndex]!.time<b.openTime+d.intervalMs) {
      const f=d.funding[fundingIndex++]!;
      funding+=sign*f.markPrice*qtyAtBarStart(i)*f.rate;
    }
  }
  void qty;
  const net=gross-fees-funding;
  const trade:TradeResult={symbol:d.symbol,direction:order.side,entryPrice:entry,exitPrice:weightedExit/initialQty,entryAt:new Date(entryBar.openTime),exitAt:new Date(d.bars[exitBar]!.openTime+d.intervalMs),exitReason:ladderExitLabel(legs),slPct:Math.abs(entry-order.slPrice)/entry,effectiveNotional:entry*initialQty,effectiveRiskUsd:originalRisk,grossR:gross/originalRisk,grossPnlUsd:gross,feesUsd:fees,netPnlUsd:net,netR:net/originalRisk,isWin:net>0,fundingUsd:funding};
  return {trade,nextIndex:exitBar+1,ambiguousBars,fundingUsd:funding};
}

/** Individual execution replay exported for regression tests, not a certification entry point. */
export function replayPlannedTrade(d: HistoricalDataset, order: OrderPlan, entryIndex:number, options:ReplayOptions, atr:number|null): {trade:TradeResult|null;nextIndex:number;ambiguousBars:number;fundingUsd:number} {
  // 16 Okt 2026: lane SWING memakai ladder TP 40/30/BE/TPmax (paritas live);
  // jalur single-target di bawah tetap khusus SCALP dan tidak diubah sama sekali.
  if(options.mode==="SWING") return replaySwingLadderTrade(d,order,entryIndex,options);

  const entryBar=d.bars[entryIndex]!;
  const sign=order.side==="LONG"?1:-1;
  const adverse=(price:number)=>price*(1-sign*options.slippageBps/10000);
  const entry=order.entryPrice;
  const initialQty=order.qty;
  const originalRisk=Math.abs(entry-order.slPrice)*initialQty;
  let qty=initialQty, stop=order.slPrice, partial=false, gross=0, fees=entry*qty*options.fees.takerRate, funding=0, weightedExit=0, ambiguousBars=0;
  let best=entry;
  let fundingIndex=lowerBound(d.funding,entryBar.openTime+1,f=>f.time);
  const close=(amount:number,price:number)=>{gross+=sign*(price-entry)*amount;fees+=price*amount*options.fees.takerRate;weightedExit+=price*amount;qty=Number((qty-amount).toFixed(12));};
  for(let i=entryIndex;i<d.bars.length;i++) {
    const b=d.bars[i]!;
    if(b.openTime+d.intervalMs>d.outOfSampleTo) break;
    while(fundingIndex<d.funding.length && d.funding[fundingIndex]!.time<b.openTime+d.intervalMs) {
      const f=d.funding[fundingIndex++]!;
      funding+=sign*f.markPrice*qty*f.rate;
    }
    const stopHit=sign===1?b.low<=stop:b.high>=stop;
    const targetHit=sign===1?b.high>=order.tp1Price:b.low<=order.tp1Price;
    let reason:TradeResult["exitReason"]|null=null;
    if(stopHit) {
      // OHLC tidak bisa memastikan mana yang tersentuh lebih dulu: pilih jalur adverse.
      if(targetHit) ambiguousBars++;
      // A gap executes at the worse open, with adverse slippage; never at a fictitious stop.
      close(qty,adverse(sign===1?Math.min(stop,b.open):Math.max(stop,b.open)));
      reason="SL";
    } else if(targetHit) {
      // Single target (30 Sep 2026): 100% posisi ditutup di TP1 — jalur SCALP ini.
      // SWING memakai ladder TP2/BE/TPmax di blok atas (dipulihkan 16 Okt 2026).
      close(qty,adverse(order.tp1Price));
      reason="TP1";
    }
    if(reason) {
      const net=gross-fees-funding;
      return {trade:{symbol:d.symbol,direction:order.side,entryPrice:entry,exitPrice:weightedExit/initialQty,entryAt:new Date(entryBar.openTime),exitAt:new Date(b.openTime+d.intervalMs),exitReason:reason,slPct:Math.abs(entry-order.slPrice)/entry,effectiveNotional:entry*initialQty,effectiveRiskUsd:originalRisk,grossR:gross/originalRisk,grossPnlUsd:gross,feesUsd:fees,netPnlUsd:net,netR:net/originalRisk,isWin:net>0,fundingUsd:funding},nextIndex:i+1,ambiguousBars,fundingUsd:funding};
    }
    // SL statis sepanjang trade; posisi hanya ditutup oleh SL atau TP tunggal.
    void best;
  }
  return {trade:null,nextIndex:d.bars.length,ambiguousBars,fundingUsd:funding};
}

export function replayHistoricalDataset(d:HistoricalDataset,options:ReplayOptions):ReplayOutput {
  const errors=validateHistoricalDataset(d);
  const tp1Policy = rrPolicyForMode(options.mode);
  if (options.tp1ROverride !== undefined && (!Number.isFinite(options.tp1ROverride)
    || options.tp1ROverride < 1.2 || options.tp1ROverride > tp1Policy.tp1R + 1e-6)) errors.push("INVALID_TP1_R_OVERRIDE");
  if (options.pullBiasThresholdOverride !== undefined && (options.strategyId !== "S-02" || options.mode !== "SCALP"
    || !Number.isFinite(options.pullBiasThresholdOverride) || options.pullBiasThresholdOverride < .5 || options.pullBiasThresholdOverride > 3)) errors.push("INVALID_PULL_BIAS_OVERRIDE");
  if (options.swingVolContrThresh !== undefined && (options.strategyId !== "S-05" || options.mode !== "SWING"
    || !Number.isFinite(options.swingVolContrThresh) || options.swingVolContrThresh < .5 || options.swingVolContrThresh > .99)) errors.push("INVALID_SWING_VOLUME_OVERRIDE");
  if (options.swingSlMult !== undefined && (options.strategyId !== "S-05" || options.mode !== "SWING"
    || !Number.isFinite(options.swingSlMult) || options.swingSlMult < 1 || options.swingSlMult > 3)) errors.push("INVALID_SWING_SL_OVERRIDE");
  if (![options.initialEquityUsd, options.targetRiskUsd].every(n => Number.isFinite(n) && n > 0)
    || options.targetRiskUsd > 1 || ![options.fees.makerRate, options.fees.takerRate, options.slippageBps].every(n => Number.isFinite(n) && n >= 0)) errors.push("INVALID_REPLAY_OPTIONS");
  const fundingCoverage: ReplayFunnel["fundingCoverage"] =
    !d.fundingCoverage || !Array.isArray(d.funding) ? "MISSING"
      : d.fundingCoverage.from <= d.outOfSampleFrom && d.fundingCoverage.to >= d.outOfSampleTo ? "FULL" : "PARTIAL";
  const funnel:ReplayFunnel={decisionTimes:0,plans:0,planLong:0,planShort:0,orderAllowed:0,orderRejected:0,orderRejectedReasons:{},fillScaledBelowMin:0,openTradesExcluded:0,closedTrades:0,fundingCoverage};
  const output:ReplayOutput={trades:[],errors,ambiguousBars:0,rejectedSignals:0,openTradesExcluded:0,fundingUsd:0,funnel};
  if(errors.length)return output;
  let equity=options.initialEquityUsd;
  const triggerMs=INTERVAL_MS[getTimeframePlan(options.mode).specs.find(s=>s.role==="TRIGGER")!.interval]!;
  for(let i=1;i<d.bars.length;i++) {
    const b=d.bars[i]!;
    const decisionTime=b.openTime;
    if(decisionTime<d.outOfSampleFrom || decisionTime>=d.outOfSampleTo || decisionTime%triggerMs!==0)continue;
    funnel.decisionTimes++;
    if(equity<=0){output.errors.push("EQUITY_EXHAUSTED");break;}
    const {plan,atr}=historicalStrategyPlan(d,options.mode,options.strategyId,decisionTime,options.tp1ROverride,options.pullBiasThresholdOverride,options.swingVolContrThresh,options.swingSlMult,options.btcDailyBars);
    if(!plan)continue;
    funnel.plans++; funnel[plan.side==="LONG" ? "planLong" : "planShort"]++;
    const entry=b.open*(1+(plan.side==="LONG"?1:-1)*options.slippageBps/10000);
    // Keep structural invalidation/TP2; re-anchor mode-specific TP1 to actual next-bar entry.
    const tp1R=options.tp1ROverride ?? rrPolicyForMode(options.mode,options.strategyId).tp1R;
    const tp1=entry+(plan.side==="LONG"?1:-1)*tp1R*Math.abs(entry-plan.slPrice);
    const order=calculateOrderPlan({symbol:d.symbol,mode:options.mode,strategyId:options.strategyId,tp1ROverride:options.tp1ROverride,side:plan.side,entryPrice:entry,slPrice:plan.slPrice,tp1Price:tp1,equityUsd:equity,targetRiskUsd:options.targetRiskUsd,now:decisionTime,riskBudgetMode:"NET",entryFeeRate:options.fees.takerRate,exitFeeRate:options.fees.takerRate,slippageBps:options.slippageBps,leverageTarget:25,marginMode:options.marginMode??"CROSS",symbolRules:{symbol:d.symbol,...d.rules,leverageUpdatedAt:decisionTime}});
    if(!order.allowed){output.rejectedSignals++;funnel.orderRejected++;const reason=order.rejectReason||"UNKNOWN";funnel.orderRejectedReasons[reason]=(funnel.orderRejectedReasons[reason]??0)+1;continue;}
    funnel.orderAllowed++;
    // T1.2 (18 Okt 2026): partial-fill model - skala qty order berdasarkan
    // rasio notional vs volume bar entry. Untuk order $1-risk @ 25x pada pair
    // likuid, fillRatio mendekati 1.0; hanya order besar relatif terhadap
    // volume bar yang terdampak. Tanpa data volume -> full fill (fail-safe).
    // T1.2: estimateLimitFillRatio(notional, barVolume, barPrice, cap)
    const fillRatio = estimateLimitFillRatio(order.qty * entry, b.volume, entry);
    if (fillRatio < 1) {
      const scaledQty = Number((order.qty * fillRatio).toFixed(8));
      if (scaledQty <= 0 || scaledQty < (d.rules.minQty ?? 0)) { funnel.fillScaledBelowMin++; continue; }
      order.qty = scaledQty;
    }
    const result=replayPlannedTrade(d,order,i,options,atr);
    output.ambiguousBars+=result.ambiguousBars;
    output.fundingUsd+=result.fundingUsd;
    if(result.trade){output.trades.push(result.trade);funnel.closedTrades++;equity+=result.trade.netPnlUsd;}
    else {output.openTradesExcluded++;funnel.openTradesExcluded++;}
    i=result.nextIndex-1;
  }
  return output;
}

export function datasetHash(d:HistoricalDataset):string {return createHash("sha256").update(JSON.stringify(d)).digest("hex");}
