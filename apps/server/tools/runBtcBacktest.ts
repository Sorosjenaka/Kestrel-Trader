import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset, Bar } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE } from "../src/backtest/backtestEngine.js";
import { validateHistoricalDataset } from "../src/backtest/historicalReplay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYMBOL = "BTCUSDT";
const DATASET_PATH = join(__dirname, "..", "data", "datasets", `${SYMBOL}_2026.json`);
const INTERVAL_MS = 60000; // 1 minute

async function fetchKlines(startTime: number, endTime: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let currentStart = startTime;
  
  console.log(`Fetching ${SYMBOL} klines from ${new Date(currentStart)} to ${new Date(endTime)}...`);

  while (currentStart < endTime) {
    const limit = 1500; // Max allowed by Binance usually
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&startTime=${currentStart}&limit=${limit}`;
    
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      
      const data: any[] = await res.json();
      if (data.length === 0) break;

      for (const k of data) {
        const openTime = k[0];
        if (openTime >= endTime) break;
        
        bars.push({
          openTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }

      // Move start time forward
      const lastOpenTime = data[data.length - 1][0];
      currentStart = lastOpenTime + INTERVAL_MS;
      
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
      
    } catch (err) {
      console.error("Fetch error:", err);
      break;
    }
  }
  
  return bars;
}

function buildDataset(bars: Bar[]): HistoricalDataset {
  const funding: { time: number; rate: number; markPrice: number }[] = [];
  
  // Split Logic: 80% Training, 20% OOS with Embargo
  const splitIndex = Math.floor(bars.length * 0.8);
  const trainingEndBar = bars[splitIndex];
  
  if (!trainingEndBar) {
     throw new Error("Insufficient bars for split");
  }

  const trainingEndedAt = trainingEndBar.openTime;
  const embargoMs = 3600000; // 1 hour
  
  // Constraint: trainingEndedAt + embargoMs < outOfSampleFrom
  // AND outOfSampleFrom % 60000 === 0 (Aligned to minute)
  
  let rawOosStart = trainingEndedAt + embargoMs + 60000;
  
  // Round UP to nearest 60000 multiple to satisfy alignment check
  const remainder = rawOosStart % 60000;
  let outOfSampleFrom = rawOosStart;
  if (remainder !== 0) {
      outOfSampleFrom = rawOosStart + (60000 - remainder);
  }
  
  // Safety check: Ensure it's still strictly greater than threshold after rounding
  if (outOfSampleFrom <= trainingEndedAt + embargoMs) {
      outOfSampleFrom += 60000;
  }

  const outOfSampleTo = bars[bars.length-1].openTime;

  return {
    schemaVersion: 1,
    source: "BINANCE_PUBLIC_KLINES",
    downloadedAt: Date.now(),
    symbol: SYMBOL,
    intervalMs: INTERVAL_MS,
    bars,
    funding,
    fundingCoverage: { from: bars[0]?.openTime ?? 0, to: bars[bars.length-1]?.openTime ?? 0 },
    rules: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5, maxLeverage: 125 },
    outOfSampleFrom,
    outOfSampleTo,
    trainingEndedAt,
    embargoMs,
    universeSelection: "MANUAL_BTC"
  };
}

async function main() {
  let dataset: HistoricalDataset;
  let bars: Bar[];

  // Try loading cached dataset first for speed
  if (existsSync(DATASET_PATH)) {
    console.log("Loading cached dataset from disk...");
    try {
      const raw = readFileSync(DATASET_PATH, "utf-8");
      dataset = JSON.parse(raw);
      bars = dataset.bars;
      console.log(`Loaded ${bars.length} bars from cache.`);
    } catch (e) {
      console.warn("Failed to parse cached dataset, re-fetching...", e);
      dataset = null!;
    }
  } else {
    dataset = null!;
  }

  // If no valid cache, fetch fresh (Minimal 1 day for speed guarantee)
  if (!dataset || !dataset.bars || dataset.bars.length === 0) {
    const DAYS_BACK = 7; 
    const END_DATE = Date.now();
    const START_DATE = END_DATE - (DAYS_BACK * 24 * 60 * 60 * 1000);
    
    console.log(`Fetching ${DAYS_BACK} days of data...`);
    bars = await fetchKlines(START_DATE, END_DATE);
    console.log(`Fetched ${bars.length} bars.`);
    
    if (bars.length < 100) {
      console.error("Insufficient data.");
      process.exit(1);
    }

    dataset = buildDataset(bars);
    
    // Save dataset for reuse/debugging
    mkdirSync(dirname(DATASET_PATH), { recursive: true });
    writeFileSync(DATASET_PATH, JSON.stringify(dataset));
    console.log("Dataset saved.");
  }

  // Debug: Validate Dataset Structure
  const validationErrors = validateHistoricalDataset(dataset);
  if (validationErrors.length > 0) {
    console.error("DATASET VALIDATION FAILED:", validationErrors);
    console.log("Dataset Metadata:", JSON.stringify({
      trainingEndedAt: dataset.trainingEndedAt,
      outOfSampleFrom: dataset.outOfSampleFrom,
      outOfSampleTo: dataset.outOfSampleTo,
      embargoMs: dataset.embargoMs,
      barsCount: dataset.bars.length
    }, null, 2));
    process.exit(1);
  } else {
    console.log("Dataset Validation Passed.");
  }

  const strategies = ["S-03", "S-04"];
  const results: Record<string, any> = {};

  for (const stratId of strategies) {
    console.log(`\nRunning Backtest for ${stratId}...`);
    try {
      const output = runStrategyBacktest({
        strategyId: stratId,
        mode: "SCALP",
        dataset,
        fees: DEFAULT_FEE_STRUCTURE,
        initialEquityUsd: 20,
        targetRiskUsd: 1.0, // $1 risk per trade (~5% of equity)
        slippageBps: 5,
        maxDrawdownUsd: 10, // Daily DD limit conceptual
      });

      if (output.failedGateReasons && output.failedGateReasons.length > 0) {
        console.warn(`Gate Reasons for ${stratId}:`, output.failedGateReasons);
      }

      const trades = output.trades || [];
      const metrics = output.metrics;
      
      // Use pre-calculated metrics from engine if available, otherwise calculate manually
      const winRate = metrics.winrate; 
      const profitFactor = metrics.totalGrossPnlUsd !== 0 && metrics.totalFeesUsd >= 0 
          ? ((metrics.totalGrossPnlUsd - metrics.totalFeesUsd) > 0 && metrics.totalGrossPnlUsd < 0 ? 0 : Math.abs(metrics.totalGrossPnlUsd / metrics.totalFeesUsd)) // Approximation or direct use if PF was exposed
          : 0;
      
      // Note: BacktestMetrics doesn't explicitly expose 'profitFactor' as a named field in the interface shown earlier, 
      // but it has totalGrossPnlUsd and totalFeesUsd. Usually PF = Gross Profit / Gross Loss.
      // Let's recalculate strictly from trades to be safe since we have them.
      
      let calcWinRate = 0;
      let calcPF = 0;
      let calcNetPnl = 0;
      let calcMaxDd = 0;

      if (trades.length > 0) {
        const wins = trades.filter(t => t.netPnlUsd > 0);
        const losses = trades.filter(t => t.netPnlUsd <= 0);
        
        const grossProfit = wins.reduce((sum, t) => sum + (t.grossPnlUsd ?? 0), 0);
        const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.grossPnlUsd ?? 0), 0));
        
        calcWinRate = (wins.length / trades.length) * 100;
        calcPF = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        calcNetPnl = trades.reduce((sum, t) => sum + (t.netPnlUsd ?? 0), 0);
        
        // Approximate Max Drawdown from equity curve if needed, but we rely on metrics if available
        calcMaxDd = metrics?.maxDdUsd ?? 0; 
      } else {
        // Fallback to engine metrics if no trades generated
        calcWinRate = metrics?.winrate ?? 0;
        calcPF = 0; 
        calcNetPnl = metrics?.netPnlUsd ?? 0;
        calcMaxDd = metrics?.maxDdUsd ?? 0;
      }

      // Calculate Average True Range (ATR) over the entire fetched dataset for better context
      let atrSum = 0;
      const atrCount = bars.length > 1 ? bars.length - 1 : 1;
      for(let i=1; i<bars.length; i++) {
         const b = bars[i];
         const prevClose = bars[i-1].close;
         const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
         atrSum += tr;
      }
      const avgAtr = atrSum / atrCount;

      const diag = output.diagnostics || {};
      
      results[stratId] = {
        totalTrades: trades.length,
        winRate: `${calcWinRate.toFixed(2)}%`,
        profitFactor: calcPF === 999 ? "Inf" : calcPF.toFixed(2),
        netPnlUsd: `$${calcNetPnl.toFixed(2)}`,
        maxDrawdownUsd: `$${calcMaxDd.toFixed(2)}`,
        avgAtr: `$${avgAtr.toFixed(2)}`,
        gateStatus: output.status,
        failedReasons: output.failedGateReasons,
        diagnostics: {
          ambiguousBars: diag.ambiguousBars ?? 0,
          rejectedSignals: diag.rejectedSignals ?? 0,
          openTradesExcluded: diag.openTradesExcluded ?? 0,
          fundingUsd: diag.fundingUsd ?? 0
        }
      };

      console.table(results[stratId]);

    } catch (e) {
      console.error(`Failed to run ${stratId}:`, e);
    }
  }

  console.log("\n=== FINAL SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);