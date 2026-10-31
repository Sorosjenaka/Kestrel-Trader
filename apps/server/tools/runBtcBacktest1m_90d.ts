import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalDataset, Bar } from "../src/backtest/historicalReplay.js";
import { runStrategyBacktest, DEFAULT_FEE_STRUCTURE, STRATEGY_CATALOG } from "../src/backtest/backtestEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYMBOL = "BTCUSDT";
const INTERVAL_MIN = 1;
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000; // 60,000 ms
const DATASET_PATH = join(__dirname, "..", "data", "datasets", `${SYMBOL}_${INTERVAL_MIN}m_90d.json`);

// Date Range: Last 90 days
const END_DATE = Date.now();
const START_DATE = END_DATE - (90 * 24 * 60 * 60 * 1000);

const TP_MULTIPLIERS = [1.0, 1.25, 1.4, 1.5, 1.7, 1.9, 2.0];

async function fetchKlines(startTime: number, endTime: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let currentStart = startTime;
  console.log(`Fetching ${SYMBOL} ${INTERVAL_MIN}m klines from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}...`);
  
  while (currentStart < endTime) {
    const limit = 1000; 
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${INTERVAL_MIN}m&startTime=${currentStart}&limit=${limit}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any[] = await res.json();
      if (data.length === 0) break;
      
      for (const k of data) {
        const openTime = k[0];
        if (openTime >= endTime) break;
        const alignedOpenTime = Math.floor(openTime / INTERVAL_MS) * INTERVAL_MS;
        bars.push({
          openTime: alignedOpenTime,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }
      
      const lastOpenTime = data[data.length - 1][0];
      currentStart = lastOpenTime + INTERVAL_MS;
      await new Promise(r => setTimeout(r, 50)); // Rate limit protection
      
    } catch (err) {
      console.error("Fetch error:", err);
      break;
    }
  }
  bars.sort((a,b) => a.openTime - b.openTime);
  return bars;
}

function buildDataset(bars: Bar[]): HistoricalDataset {
  const funding: { time: number; rate: number; markPrice: number }[] = [];
  const splitIndex = Math.floor(bars.length * 0.8);
  const trainingEndBar = bars[splitIndex];
  if (!trainingEndBar) throw new Error("Insufficient bars");
  
  const trainingEndedAt = trainingEndBar.openTime;
  const embargoMs = 3600000; // 1 hour
  
  let rawOosStart = trainingEndedAt + embargoMs + INTERVAL_MS;
  const remainder = rawOosStart % INTERVAL_MS;
  let outOfSampleFrom = rawOosStart;
  if (remainder !== 0) outOfSampleFrom = rawOosStart + (INTERVAL_MS - remainder);
  if (outOfSampleFrom <= trainingEndedAt + embargoMs) outOfSampleFrom += INTERVAL_MS;
  
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

interface BacktestResultRow {
  strategyId: string;
  strategyName: string;
  tpMultiplier: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  avgAtr: number;
  status: string;
  rejectedSignals: number;
}

async function main() {
  let dataset: HistoricalDataset | null = null;
  let bars: Bar[] = [];

  if (existsSync(DATASET_PATH)) {
    console.log("Loading cached dataset...");
    try {
      const raw = readFileSync(DATASET_PATH, "utf-8");
      dataset = JSON.parse(raw);
      bars = dataset.bars;
      console.log(`Loaded ${bars.length} bars.`);
    } catch (e) {
      console.warn("Parse failed, refetching...", e);
      dataset = null;
    }
  }

  if (!dataset || !dataset.bars || dataset.bars.length === 0) {
    console.log(`Fetching 90 days of 1m data...`);
    bars = await fetchKlines(START_DATE, END_DATE);
    console.log(`Fetched ${bars.length} bars.`);
    if (bars.length < 1000) { 
      console.error("Insufficient data."); 
      process.exit(1); 
    }
    dataset = buildDataset(bars);
    mkdirSync(dirname(DATASET_PATH), { recursive: true });
    writeFileSync(DATASET_PATH, JSON.stringify(dataset));
    console.log("Dataset saved.");
  }

  const strategies = ["S-03", "S-04"];
  const allResults: BacktestResultRow[] = [];
  console.log("\nStarting Grid Search (1m TF, 90 Days)...\n");

  for (const stratId of strategies) {
    const cat = STRATEGY_CATALOG[stratId];
    if (!cat) continue;
    
    for (const tpMult of TP_MULTIPLIERS) {
      console.log(`Running ${stratId} (${cat.name}) TP x${tpMult}...`);
      try {
        const output = runStrategyBacktest({
          strategyId: stratId, 
          mode: "SCALP", 
          dataset: dataset!, 
          fees: DEFAULT_FEE_STRUCTURE,
          initialEquityUsd: 20, 
          targetRiskUsd: 1.0, 
          slippageBps: 5, 
          maxDrawdownUsd: 10, 
          tp1ROverride: tpMult 
        });
        
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
        } else {
          calcWinRate = metrics?.winrate ?? 0;
          calcPF = 0; 
          calcNetPnl = metrics?.netPnlUsd ?? 0; 
          calcMaxDd = metrics?.maxDdUsd ?? 0;
        }
        
        let atrSum = 0;
        const atrCount = bars.length > 1 ? bars.length - 1 : 1;
        for(let i=1; i<bars.length; i++) {
           const b = bars[i]; 
           const pc = bars[i-1].close;
           atrSum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
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
          avgAtr: atrSum / atrCount, 
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

  const resultsPath = join(__dirname, "..", "results", "btc_1m_90d_grid_search.json");
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to ${resultsPath}`);
}

main().catch(console.error);
