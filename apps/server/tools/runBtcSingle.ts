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
  
  // Use last 30 days for balance of speed and significance
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

  // CRITICAL: Use $200 Equity to satisfy internal engine baselines and lot sizes
  const INITIAL_EQUITY = 200.0; 
  const TARGET_RISK = 1.0;
  const TP_MULT = 1.5; // Default healthy RR

  console.time("S-03 Execution");
  try {
    const output = runStrategyBacktest({
      strategyId: "S-03", 
      mode: "SCALP", 
      dataset: slicedDataset, 
      fees: DEFAULT_FEE_STRUCTURE,
      initialEquityUsd: INITIAL_EQUITY, 
      targetRiskUsd: TARGET_RISK, 
      slippageBps: 5, 
      maxDrawdownUsd: 10, 
      tp1ROverride: TP_MULT 
    });
    console.timeEnd("S-03 Execution");
    
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
    
    console.log("\n--- S-03 RESULT ---");
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Rejected Signals: ${diagnostics.rejectedSignals ?? 0}`);
    console.log(`Win Rate: ${calcWinRate.toFixed(2)}%`);
    console.log(`Profit Factor: ${calcPF.toFixed(2)}`);
    console.log(`Net PnL: $${calcNetPnl.toFixed(2)}`);
    console.log(`Max DD: $${calcMaxDd.toFixed(2)}`);
    console.log(`Status: ${output.status}`);
    
  } catch (e) {
    console.timeEnd("S-03 Execution");
    console.error("Error:", e);
  }
}

main().catch(console.error);
