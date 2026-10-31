import { describe, it, expect } from "vitest";
import { aggregateClosedBars, validateHistoricalDataset, replayPlannedTrade, historicalStrategyPlan, type HistoricalDataset } from "../src/backtest/historicalReplay.js";
import { calculateMetrics, evaluateBacktestGate, runStrategyBacktest, type TradeResult } from "../src/backtest/backtestEngine.js";
import type { OrderPlan } from "../src/risk/riskEngine.js";

const start=Date.UTC(2025,0,1);
function dataset():HistoricalDataset {
  return {schemaVersion:1,source:"unit-test fixture (not market evidence)",downloadedAt:start+86400000,symbol:"BTCUSDT",intervalMs:60000,
    bars:Array.from({length:10},(_,i)=>({openTime:start+i*60000,open:100,high:100.1,low:99.9,close:100,volume:100})),
    funding:[],fundingCoverage:{from:start,to:start+600000},rules:{tickSize:.01,stepSize:.01,minQty:.01,minNotional:5,maxLeverage:25},
    outOfSampleFrom:start+60000,outOfSampleTo:start+600000,trainingEndedAt:start-60000,embargoMs:60000,universeSelection:"test fixture"};
}
const options={strategyId:"S-01",mode:"SCALP" as const,fees:{makerRate:.0002,takerRate:.0005},slippageBps:0,initialEquityUsd:200,targetRiskUsd:1};
const order={symbol:"BTCUSDT",side:"LONG",entryPrice:100,slPrice:98,tp1Price:102,tp2Price:105,qty:1,notionalUsd:100,marginUsd:4,leverage:25,effectiveRiskUsd:2,allowed:true} as OrderPlan;

describe("Historical replay evidence and execution",()=>{
  it("cannot fabricate performance from requested winrate/sampleCount",()=>{
    const run=runStrategyBacktest({strategyId:"S-01",targetWinrate:100,sampleCount:99999,minSamples:1,minWinrate:1});
    expect(run.metrics.sampleCount).toBe(0);expect(run.status).toBe("FAILED");expect(run.failedGateReasons).toContain("INSUFFICIENT_DATA");expect(run.failedGateReasons).toContain("SAMPLES_LT_500");
  });
  it("uses net profit instead of caller-provided win flags",()=>{
    const metrics=calculateMetrics([{netPnlUsd:-.01,isWin:true,netR:-.01,grossPnlUsd:1,feesUsd:1.01} as TradeResult]);
    expect(metrics.winCount).toBe(0);
  });
  it("does not lower hard500/60 gate or accept NaN",()=>{
    const metrics={sampleCount:499,winCount:499,lossCount:0,winrate:100,evUsd:1,evR:1,maxDdUsd:0,totalGrossPnlUsd:499,totalFeesUsd:0,totalNetPnlUsd:499};
    expect(evaluateBacktestGate(metrics,{minSamples:1,minWinrate:.6}).failedGateReasons).toContain("SAMPLES_LT_500");
    expect(evaluateBacktestGate({...metrics,sampleCount:500,winrate:59},{minSamples:1,minWinrate:.6}).gatePassed).toBe(false);
    expect(evaluateBacktestGate({...metrics,sampleCount:500,evUsd:NaN}).gatePassed).toBe(false);
  });
  it("excludes incomplete/future high-timeframe bars",()=>{
    const d=dataset();d.bars[4]!.high=10000;
    expect(aggregateClosedBars(d.bars,300000,start+240000)).toEqual([]);
    expect(aggregateClosedBars(d.bars,300000,start+300000)).toHaveLength(1);
    expect(aggregateClosedBars(d.bars,300000,start+300000)[0]!.high).toBe(10000);
  });
  it("rejects gaps, invalid OHLC and overlapping partitions",()=>{
    const d=dataset();expect(validateHistoricalDataset(d)).toEqual([]);
    d.bars[3]!.openTime+=60000;expect(validateHistoricalDataset(d)).toContain("NON_CONTIGUOUS_BARS");
    d.trainingEndedAt=d.outOfSampleFrom;expect(validateHistoricalDataset(d)).toContain("INVALID_CHRONOLOGICAL_SPLIT");
  });
  it("rejects missing funding coverage",()=>{
    const d=dataset();d.fundingCoverage.to=d.outOfSampleFrom;expect(validateHistoricalDataset(d)).toContain("MISSING_FUNDING_COVERAGE");
  });
  it("takes adverse stop first when bar touches both targets and stop",()=>{
    const d=dataset();d.bars[1]={...d.bars[1]!,high:106,low:97};
    const result=replayPlannedTrade(d,order,1,options,null);
    expect(result.trade!.grossPnlUsd).toBe(-2);expect(result.trade!.exitReason).toBe("SL");expect(result.ambiguousBars).toBe(1);
  });
  it("accounts for stop gaps using worse open and slippage",()=>{
    const d=dataset();d.bars[2]={...d.bars[2]!,open:95,high:96,low:94,close:95};
    const result=replayPlannedTrade(d,order,1,{...options,slippageBps:10},null);
    expect(result.trade!.exitPrice).toBeCloseTo(94.905);expect(result.trade!.netPnlUsd).toBeLessThan(-5);
  });
  it("single target: 100% keluar di TP1 dan funding dibebankan pada qty penuh",()=>{
    const d=dataset();
    d.bars[1]={...d.bars[1]!,open:101,high:101.5,low:100.8,close:101};
    d.bars[2]={...d.bars[2]!,open:102.1,high:102.5,low:101.9,close:102.4};
    d.funding=[{time:d.bars[2]!.openTime,rate:.001,markPrice:104}];
    const result=replayPlannedTrade(d,order,1,options,null);
    // 29 Sep 2026: RR klasik single target — tidak ada partial 65% / runner 35%.
    expect(result.trade!.exitReason).toBe("TP1");
    expect(result.trade!.grossPnlUsd).toBeCloseTo(2);
    expect(result.trade!.exitPrice).toBeCloseTo(102);
    // Funding dibebankan sebelum exit pada bar yang sama, atas qty penuh (1).
    expect(result.fundingUsd).toBeCloseTo(104*.001);
    expect(result.trade!.feesUsd).toBeCloseTo((100+102)*.0005);
  });
  it("excludes unfinished trades instead of assigning an invented result",()=>{
    const result=replayPlannedTrade(dataset(),order,1,options,null);expect(result.trade).toBeNull();
  });
  it("future candles cannot alter strategy decision at a historical timestamp",()=>{
    const d=dataset();d.bars=Array.from({length:600},(_,i)=>({openTime:start+i*60000,open:100+i*.001,high:100.1+i*.001,low:99.9+i*.001,close:100+i*.001,volume:100}));
    const t=start+500*60000;const before=historicalStrategyPlan(d,"SCALP","S-01",t);
    for(let i=500;i<600;i++){d.bars[i]!.high=1e8;d.bars[i]!.close=1e7;}
    expect(historicalStrategyPlan(d,"SCALP","S-01",t)).toEqual(before);
  });
});
