// tools/buildReplayDataset.ts — build a HistoricalDataset from Binance public klines.
// Used to obtain a TRADEABLE symbol for SWING (BTCUSDT minQty makes SWING unsizeable at $1 risk).
// Usage: npx tsx tools/buildReplayDataset.ts --symbol SUIUSDT --days 90
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHistoricalDataset, type HistoricalDataset } from "../src/backtest/historicalReplay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && args[i+1] && !args[i+1]!.startsWith("--") ? args[i+1] : undefined; };
const SYMBOL = argValue("--symbol") ?? "SUIUSDT";
const DAYS = Number(argValue("--days") ?? 90);
const OUT_PATH = argValue("--out") ?? join(__dirname, "..", "data", "datasets", `${SYMBOL}_1m_${DAYS}d.json`);

const BASE = "https://fapi.binance.com";
async function fetchJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function main() {
  process.stdout.write(`Building ${SYMBOL} 1m dataset (${DAYS}d)...\n`);
  // 1. exchangeInfo -> symbol rules
  const exInfo = await fetchJson(`/fapi/v1/exchangeInfo`);
  const sym = exInfo.symbols.find((s: any) => s.symbol === SYMBOL);
  if (!sym) throw new Error(`Symbol ${SYMBOL} not found in exchangeInfo`);
  const filters = Object.fromEntries(sym.filters.map((f: any) => [f.filterType, f]));
  const priceFilter = filters.PRICE_FILTER ?? {};
  const lotFilter = filters.LOT_SIZE ?? {};
  const notionalFilter = filters.MIN_NOTIONAL ?? {};
  const rules = {
    tickSize: Number(priceFilter.tickSize) || 0.1,
    stepSize: Number(lotFilter.stepSize) || 0.001,
    minQty: Number(lotFilter.minQty) || Number(lotFilter.stepSize) || 0.001,
    minNotional: Number(notionalFilter.notional) || 5,
    maxLeverage: Number(sym.leverageBracket?.[0]?.[0]?.initialLeverage) || 125,
  };
  process.stdout.write(`  rules: ${JSON.stringify(rules)}\n`);

  // 2. klines -> 1m bars (paged, 1500 per call)
  const endTime = Math.floor(Date.now() / 60000) * 60000;
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const bars: HistoricalDataset["bars"] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const klines = await fetchJson(`/fapi/v1/klines?symbol=${SYMBOL}&interval=1m&startTime=${cursor}&limit=1500`);
    if (!Array.isArray(klines) || klines.length === 0) break;
    for (const k of klines) {
      const openTime = Number(k[0]);
      if (openTime >= endTime) continue;
      bars.push({ openTime, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) });
    }
    cursor = Number(klines[klines.length - 1][0]) + 60000;
    process.stdout.write(`  fetched ${bars.length} bars...\n`);
    if (klines.length < 1500) break;
  }

  // 3. OOS split: 80/20 with 1h embargo (matches runBtcSingle convention)
  const embargoMs = 3600000;
  const trainEnd = bars[Math.floor(bars.length * 0.8)]!.openTime;
  const oosFrom = trainEnd + embargoMs + 60000;
  const oosTo = endTime;
  const dataset: HistoricalDataset = {
    schemaVersion: 1,
    source: "BINANCE_PUBLIC_KLINES",
    downloadedAt: Date.now(),
    symbol: SYMBOL,
    intervalMs: 60000,
    bars,
    funding: [],
    fundingCoverage: { from: bars[0]!.openTime, to: oosTo },
    rules,
    outOfSampleFrom: oosFrom,
    outOfSampleTo: oosTo,
    trainingEndedAt: trainEnd,
    embargoMs,
    universeSelection: "MANUAL_BTC", // same convention as existing datasets
  };

  const errors = validateHistoricalDataset(dataset);
  if (errors.length) {
    process.stderr.write(`Validation errors: ${errors.join(", ")}\n`);
    process.exit(1);
  }
  writeFileSync(OUT_PATH, JSON.stringify(dataset));
  process.stdout.write(`OK -> ${OUT_PATH}\n`);
  process.stdout.write(`  bars=${bars.length} OOS=${new Date(oosFrom).toISOString()} -> ${new Date(oosTo).toISOString()}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
