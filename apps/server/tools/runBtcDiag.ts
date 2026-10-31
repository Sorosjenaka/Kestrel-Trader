import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset, Bar } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE, STRATEGY_CATALOG } from "../src/backtest/backtestEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = join(__dirname, "..", "data", "datasets", "BTCUSDT_1m_90d.json");

async function main() {
  console.log("Loading cached 90-day dataset...");
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const fullDataset: HistoricalDataset = JSON.parse(raw);
  
  // Take last 30 days to reduce compute load while keeping statistical significance
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoffTime = fullDataset.bars[fullDataset.bars.length - 1].openTime - thirtyDaysMs;
  const recentBars = fullDataset.bars.filter(b => b.openTime >= cutoffTime);
  
  console.log(`Original bars: ${fullDataset.bars.length}, Recent 30d bars: ${recentBars.length}`);
  
  if (recentBars.length < 1000) {
    console.error("Insufficient bars in slice.");
    process.exit(1);
  }

  // Rebuild dataset structure for validation compliance
  const splitIndex = Math.floor(recentBars.length * 0.8);
  const trainingEndBar = recentBars[splitIndex];
  const trainingEndedAt = trainingEndBar.openTime;
  const embargoMs = 3600000; // 1 hour
  const intervalMs = 60000; // 1 minute
  
  let rawOosStart = trainingEndedAt + embargoMs + intervalMs;
  const remainder = rawOosStart % intervalMs;
  let outOfSampleFrom = rawOosStart;
  if (remainder !== 0) outOfSampleFrom = rawOosStart + (intervalMs - remainder);
  if (outOfSampleFrom <= trainingEndedAt + embargoMs) outOfSampleFrom += intervalMs;
  
  const outOfSampleTo = recentBars[recentBars.length - 1].openTime;

  const slicedDataset: HistoricalDataset = {
    ...fullDataset,
    bars: recentBars,
    trainingEndedAt,
    outOfSampleFrom,
    outOfSampleTo,
    embargoMs
  };

  console.log("Running Diagnostic Backtest (S-03 & S-04, TP x1.5) on 30-day slice...\n");
  
  const strategies = ["S-03", "S-04"];
  const tpMult = 1.5;

  for (const stratId of strategies) {
    const cat = STRATEGY_CATALOG[stratId];
    if (!cat) continue;
    
    console.time(`${stratId} execution`);
    try {
      const output = runStrategyBacktest({
        strategyId: stratId, 
        mode: "SCALP", 
        dataset: slicedDataset, 
        fees: DEFAULT_FEE_STRUCTURE,
        initialEquityUsd: 20, 
        targetRiskUsd: 1.0, 
        slippageBps: 5, 
        maxDrawdownUsd: 10, 
        tp1ROverride: tpMult 
      });
      console.timeEnd(`${stratId} execution`);
      
      const trades = output.trades || [];
      const metrics = output.metrics;
      const diagnostics = output.diagnostics || {};
      
      console.log(`\n--- ${stratId}: ${cat.name} ---`);
      console.log(`Total Trades: ${trades.length}`);
      console.log(`Rejected Signals: ${diagnostics.rejectedSignals ?? 0}`);
      console.log(`Win Rate: ${(metrics?.winrate ?? 0).toFixed(2)}%`);
      console.log(`Profit Factor: ${(metrics?.profitFactor ?? 0).toFixed(2)}`);
      console.log(`Net PnL: $${(metrics?.netPnlUsd ?? 0).toFixed(2)}`);
      console.log(`Max DD: $${(metrics?.maxDdUsd ?? 0).toFixed(2)}`);
      console.log(`Status: ${output.status}`);
      console.log(`Failed Reasons: ${JSON.stringify(output.failedGateReasons || [])}`);
      
    } catch (e) {
      console.timeEnd(`${stratId} execution`);
      console.error(`Error running ${stratId}:`, e);
    }
  }
}

main().catch(console.error);
