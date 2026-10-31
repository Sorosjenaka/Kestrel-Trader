import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE, STRATEGY_CATALOG } from "../src/backtest/backtestEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = join(__dirname, "..", "data", "datasets", "BTCUSDT_1m_90d.json");

async function main() {
  console.log("Loading cached dataset...");
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const fullDataset: HistoricalDataset = JSON.parse(raw);
  
  // Use last 30 days for better statistical significance than 7 days, but fast enough
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoffTime = fullDataset.bars[fullDataset.bars.length - 1].openTime - thirtyDaysMs;
  const recentBars = fullDataset.bars.filter(b => b.openTime >= cutoffTime);
  
  console.log(`Using ${recentBars.length} bars (last 30 days).`);

  const splitIndex = Math.floor(recentBars.length * 0.8);
  const trainingEndBar = recentBars[splitIndex];
  const trainingEndedAt = trainingEndBar.openTime;
  const embargoMs = 3600000; 
  const intervalMs = 60000; 
  
  let rawOosStart = trainingEndedAt + embargoMs + intervalMs;
  const remainder = rawOosStart % intervalMs;
  let outOfSampleFrom = rawOosStart;
  if (remainder !== 0) outOfSampleFrom = rawOosStart + (intervalMs - remainder);
  if (outOfSampleFrom <= trainingEndedAt + embargoMs) outOfSampleFrom += intervalMs;
  
  const outOfSampleTo = recentBars[recentBars.length - 1].openTime;

  const slicedDataset: HistoricalDataset = {
    schemaVersion: 1,
    source: "BINANCE_PUBLIC_KLINES",
    downloadedAt: Date.now(),
    symbol: "BTCUSDT",
    intervalMs: 60000,
    bars: recentBars,
    funding: [],
    fundingCoverage: { from: recentBars[0]?.openTime ?? 0, to: recentBars[recentBars.length-1]?.openTime ?? 0 },
    rules: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5, maxLeverage: 125 },
    outOfSampleFrom,
    outOfSampleTo,
    trainingEndedAt,
    embargoMs,
    universeSelection: "MANUAL_BTC"
  };

  const strategies = ["S-03", "S-04"];
  const tpMultipliers = [1.0, 1.25, 1.4, 1.5, 1.7, 1.9, 2.0];
  const allResults: any[] = [];

  // CRITICAL FIX: Use $200 Equity to match internal engine expectations and satisfy min lot sizes
  const INITIAL_EQUITY = 200.0; 
  const TARGET_RISK = 1.0;

  console.log(`\nRunning Grid Search with Equity=$${INITIAL_EQUITY}, Risk=$${TARGET_RISK}...\n`);

  for (const stratId of strategies) {
    const cat = STRATEGY_CATALOG[stratId];
    if (!cat) continue;
    
    for (const tpMult of tpMultipliers) {
      console.time(`${stratId} TP x${tpMult}`);
      try {
        const output = runStrategyBacktest({
          strategyId: stratId, 
          mode: "SCALP", 
          dataset: slicedDataset, 
          fees: DEFAULT_FEE_STRUCTURE,
          initialEquityUsd: INITIAL_EQUITY, 
          targetRiskUsd: TARGET_RISK, 
          slippageBps: 5, 
          maxDrawdownUsd: 10, 
          tp1ROverride: tpMult 
        });
        console.timeEnd(`${stratId} TP x${tpMult}`);
        
        const trades = output.trades || [];
        const metrics = output.metrics;
        const diagnostics = output.diagnostics || {};
        
        let calcWinRate = 0, calcPF = 0, calcNetPnl = 0, calcMaxDd = 0;
        if (trades.length > 0) {
          const wins = trades.filter(t => t.netPnlUsd > 0);
          const losses = trades.filter(t => t.netPnlUsd <= 0);
          const gp = wins.reduce((s, t) => s + (t.grossPnlUsd ?? 0), 0);
          const gl = Math.abs(losses.reduce((s, t) => s + (t.grossPnlUsd ?? 0), 0));
          
          calcWinRate = (wins.length / trades.length) * 100;
          calcPF = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);
          calcNetPnl = trades.reduce((s, t) => s + (t.netPnlUsd ?? 0), 0);
          calcMaxDd = metrics?.maxDdUsd ?? 0; 
        }
        
        allResults.push({
          strategyId: stratId, 
          strategyName: cat.name, 
          tpMultiplier: tpMult, 
          totalTrades: trades.length,
          winRate: calcWinRate, 
          profitFactor: calcPF, 
          netPnlUsd: calcNetPnl, 
          maxDrawdownUsd: calcMaxDd,
          status: output.status,
          rejectedSignals: diagnostics.rejectedSignals ?? 0
        });
      } catch (e) { 
        console.error(`Error running ${stratId} with TP ${tpMult}:`, e); 
      }
    }
  }

  console.table(allResults.map(r => ({
    Strat: r.strategyId, 
    Name: r.strategyName.substring(0,15), 
    "TP x": r.tpMultiplier,
    Trades: r.totalTrades, 
    RejSig: r.rejectedSignals,
    "Win %": r.winRate.toFixed(2), 
    PF: r.profitFactor.toFixed(2),
    "Net $": r.netPnlUsd.toFixed(2), 
    "DD $": r.maxDrawdownUsd.toFixed(2), 
    Status: r.status
  })));

  const resultsPath = join(__dirname, "..", "results", "btc_final_grid_search.json");
  require("fs").mkdirSync(require("path").dirname(resultsPath), { recursive: true });
  require("fs").writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to ${resultsPath}`);
}

main().catch(console.error);
