import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE } from "../src/backtest/backtestEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATASET_PATH = join(__dirname, "..", "data", "datasets", "BTCUSDT_1m_90d.json");

async function main() {
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const fullDataset: HistoricalDataset = JSON.parse(raw);
  
  // Slice last 7 days
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoffTime = fullDataset.bars[fullDataset.bars.length - 1].openTime - sevenDaysMs;
  const recentBars = fullDataset.bars.filter(b => b.openTime >= cutoffTime);
  
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

  // Create a clean object instead of spreading to avoid reference issues
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

  console.log("--- TEST A: STRICT PARAMS ($20 Equity, $1 Risk) ---");
  try {
    const outA = runStrategyBacktest({
      strategyId: "S-03", mode: "SCALP", dataset: slicedDataset, fees: DEFAULT_FEE_STRUCTURE,
      initialEquityUsd: 20, targetRiskUsd: 1.0, slippageBps: 5, maxDrawdownUsd: 10, tp1ROverride: 1.5
    });
    console.log(`Trades: ${outA.trades?.length || 0}, Rejected: ${outA.diagnostics?.rejectedSignals || 0}`);
    if(outA.errors && outA.errors.length > 0) console.log("Errors:", outA.errors);
  } catch(e) { console.error(e); }

  console.log("\n--- TEST B: LOOSE PARAMS ($1000 Equity, $50 Risk) ---");
  try {
    const outB = runStrategyBacktest({
      strategyId: "S-03", mode: "SCALP", dataset: slicedDataset, fees: DEFAULT_FEE_STRUCTURE,
      initialEquityUsd: 1000, targetRiskUsd: 50.0, slippageBps: 5, maxDrawdownUsd: 500, tp1ROverride: 1.5
    });
    console.log(`Trades: ${outB.trades?.length || 0}, Rejected: ${outB.diagnostics?.rejectedSignals || 0}`);
    if(outB.errors && outB.errors.length > 0) console.log("Errors:", outB.errors);
  } catch(e) { console.error(e); }
}

main().catch(console.error);
