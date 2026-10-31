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
  
  // Take last 7 days
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoffTime = fullDataset.bars[fullDataset.bars.length - 1].openTime - sevenDaysMs;
  const recentBars = fullDataset.bars.filter(b => b.openTime >= cutoffTime);
  
  console.log(`Using ${recentBars.length} bars.`);

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

  // TEST 1: Relaxed Risk (Higher Equity/Risk to pass minNotional)
  console.time("Relaxed Test");
  try {
    const output = runStrategyBacktest({
      strategyId: "S-03", 
      mode: "SCALP", 
      dataset: slicedDataset, 
      fees: DEFAULT_FEE_STRUCTURE,
      initialEquityUsd: 1000, // Increased from $20
      targetRiskUsd: 50.0,    // Increased from $1
      slippageBps: 5, 
      maxDrawdownUsd: 500, 
      tp1ROverride: 1.5 
    });
    console.timeEnd("Relaxed Test");
    
    const trades = output.trades || [];
    const metrics = output.metrics;
    const diagnostics = output.diagnostics || {};
    
    console.log("\n--- RELAXED RISK RESULT ---");
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Rejected Signals: ${diagnostics.rejectedSignals ?? 0}`);
    if (trades.length > 0) {
       console.log(`Win Rate: ${(metrics?.winrate ?? 0).toFixed(2)}%`);
       console.log(`Profit Factor: ${(metrics?.profitFactor ?? 0).toFixed(2)}`);
       console.log(`Net PnL: $${(metrics?.netPnlUsd ?? 0).toFixed(2)}`);
    }
    console.log(`Status: ${output.status}`);
    
  } catch (e) {
    console.timeEnd("Relaxed Test");
    console.error("Error:", e);
  }
}

main().catch(console.error);
