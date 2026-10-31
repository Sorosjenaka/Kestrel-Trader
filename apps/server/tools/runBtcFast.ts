import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset, Bar } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE, STRATEGY_CATALOG } from "../src/backtest/backtestEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = join(__dirname, "..", "data", "datasets", "BTCUSDT_1m_90d.json");

async function main() {
  console.log("Loading cached dataset...");
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const fullDataset: HistoricalDataset = JSON.parse(raw);
  
  // Take last 7 days only for speed test (~10k bars)
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoffTime = fullDataset.bars[fullDataset.bars.length - 1].openTime - sevenDaysMs;
  const recentBars = fullDataset.bars.filter(b => b.openTime >= cutoffTime);
  
  console.log(`Using ${recentBars.length} bars (last 7 days).`);
  
  if (recentBars.length < 100) {
    console.error("Insufficient bars.");
    process.exit(1);
  }

  // Rebuild dataset structure
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
    ...fullDataset,
    bars: recentBars,
    trainingEndedAt,
    outOfSampleFrom,
    outOfSampleTo,
    embargoMs
  };

  console.time("Backtest Execution");
  try {
    const output = runStrategyBacktest({
      strategyId: "S-03", 
      mode: "SCALP", 
      dataset: slicedDataset, 
      fees: DEFAULT_FEE_STRUCTURE,
      initialEquityUsd: 20, 
      targetRiskUsd: 1.0, 
      slippageBps: 5, 
      maxDrawdownUsd: 10, 
      tp1ROverride: 1.5 
    });
    console.timeEnd("Backtest Execution");
    
    const trades = output.trades || [];
    const metrics = output.metrics;
    const diagnostics = output.diagnostics || {};
    
    console.log("\n--- RESULT ---");
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Rejected Signals: ${diagnostics.rejectedSignals ?? 0}`);
    console.log(`Win Rate: ${(metrics?.winrate ?? 0).toFixed(2)}%`);
    console.log(`Profit Factor: ${(metrics?.profitFactor ?? 0).toFixed(2)}`);
    console.log(`Net PnL: $${(metrics?.netPnlUsd ?? 0).toFixed(2)}`);
    console.log(`Status: ${output.status}`);
    
  } catch (e) {
    console.timeEnd("Backtest Execution");
    console.error("Error:", e);
  }
}

main().catch(console.error);
