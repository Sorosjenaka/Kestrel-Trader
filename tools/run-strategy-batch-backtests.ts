// tools/run-strategy-batch-backtests.ts
// Backtest NYATA (bukan sintetis) untuk seluruh strategi aktif di katalog
// (S-01, S-02, S-03, S-04, S-05) di atas dataset klines Binance 1m yang sudah
// diunduh ke data/history/*_1m.json.
//
// KENAPA BATCH: engine replay bersifat DETERMINISTIC_SINGLE_SYMBOL — satu run
// hanya menghasilkan trade dari SATU simbol. Target operator 500 sampel per
// strategi tidak mungkin dicapai dari satu simbol pada window wajar (S-01 hanya
// ~18 trade / 60 hari / BTCUSDT). Harness ini karena itu MENGGABUNG trade dari
// 6 simbol, lalu menghitung winrate & PnL pada gabungan tersebut, dan melaporkan
// secara jujur apakah 500 sampel tercapai atau belum.
//
// Pakai:
//   npx tsx tools/run-strategy-batch-backtests.ts --days 60 --out bkt-report.json
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  runStrategyBacktest,
  calculateMetrics,
  STRATEGY_CATALOG,
  type TradeResult,
  type HistoricalDataset,
} from "../apps/server/src/backtest/backtestEngine.js";
import { validateHistoricalDataset } from "../apps/server/src/backtest/historicalReplay.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

function arg(name: string, fallback?: string | number): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  return v === undefined ? undefined : String(v);
}

const SYMBOLS = String(arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,DOGEUSDT,XRPUSDT"))
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DIR = arg("dir", "data/history")!;
const DAYS = Number(arg("days", 60));
const OUT = arg("out", "bkt-report.json")!;
const TARGET = Number(arg("target-samples", 500));
const MIN_WR = Number(arg("min-winrate", 60));
// Jalankan hanya sebagian strategi (dipakai untuk memecah batch paralel per
// strategi: satu proses = satu strategi, supaya wall-time turun ~Nx lipat).
const ONLY = String(arg("strategies", ""))
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const EXPECTED = Object.keys(STRATEGY_CATALOG).length;

/** Potong window ke N hari terakhir yang masih tertutup funding. */
function windowFor(raw: HistoricalDataset, days: number): HistoricalDataset {
  const lastFunding = raw.funding[raw.funding.length - 1]!.time;
  const oosTo = lastFunding;
  const oosFrom = Math.ceil((oosTo - days * DAY) / MINUTE) * MINUTE;
  return {
    ...raw,
    outOfSampleFrom: oosFrom,
    outOfSampleTo: oosTo,
    trainingEndedAt: oosFrom - MINUTE,
    embargoMs: 0,
    fundingCoverage: { from: raw.funding[0]!.time, to: lastFunding },
  };
}

interface Pooled {
  strategyId: string; strategyName: string; mode: string;
  trades: TradeResult[]; perSymbol: { symbol: string; samples: number; winrate: number; netUsd: number; rejected: number }[];
  elapsedMs: number;
}

/** Bentuk laporan dari hasil yang sudah terkumpul (dipakai juga untuk progres parsial). */
function buildReport(pooled: Pooled[], elapsedMsTotal: number) {
  const rows = pooled.map((p) => {
    const m = calculateMetrics(p.trades);
    const gate = m.sampleCount >= TARGET && m.winrate >= MIN_WR && m.evUsd > 0;
    return {
      strategyId: p.strategyId, name: p.strategyName, mode: p.mode,
      samples: m.sampleCount, target: TARGET,
      winCount: m.winCount, lossCount: m.lossCount,
      winrate: m.winrate, evUsd: m.evUsd, evR: m.evR,
      totalNetPnlUsd: m.totalNetPnlUsd, totalFeesUsd: m.totalFeesUsd, maxDdUsd: m.maxDdUsd,
      gatePassed: gate, status: gate ? "PASSED" : "FAILED",
      elapsedMs: p.elapsedMs, perSymbol: p.perSymbol,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    source: "binance data.binance.vision arsip 1m + fapi fundingRate (data NYATA)",
    symbols: SYMBOLS, days: DAYS, targetSamples: TARGET, minWinrate: MIN_WR,
    complete: pooled.length === Object.keys(STRATEGY_CATALOG).length,
    elapsedMsTotal,
    allTargetsMet: rows.length === Object.keys(STRATEGY_CATALOG).length && rows.every((r) => r.samples >= TARGET),
    allGatesPassed: rows.length === Object.keys(STRATEGY_CATALOG).length && rows.every((r) => r.gatePassed),
    rows,
  };
}

async function main() {
  const ids = ONLY.length ? ONLY : Object.keys(STRATEGY_CATALOG);
  const datasets: { symbol: string; data: HistoricalDataset }[] = [];
  for (const s of SYMBOLS) {
    const raw = JSON.parse(readFileSync(resolve(join(DIR, `${s}_1m.json`)), "utf8")) as HistoricalDataset;
    const w = windowFor(raw, DAYS);
    const errs = validateHistoricalDataset(w);
    if (errs.length) throw new Error(`${s}: dataset tidak valid -> ${errs.join(",")}`);
    datasets.push({ symbol: s, data: w });
    console.log(`[DATA] ${s}: ${raw.bars.length} bar, window ${new Date(w.outOfSampleFrom).toISOString()} .. ${new Date(w.outOfSampleTo).toISOString()}`);
  }

  const pooled: Pooled[] = [];
  const t0All = Date.now();
  for (const id of ids) {
    const cat = STRATEGY_CATALOG[id]!;
    const trades: TradeResult[] = [];
    const perSymbol: Pooled["perSymbol"] = [];
    const t0 = Date.now();
    for (const { symbol, data } of datasets) {
      const res = runStrategyBacktest({ strategyId: id, dataset: data, maxDrawdownUsd: 1e9 });
      const ts = res.trades ?? [];
      trades.push(...ts);
      perSymbol.push({
        symbol,
        samples: ts.length,
        winrate: Number(((ts.filter((t) => t.netPnlUsd > 0).length / Math.max(1, ts.length)) * 100).toFixed(2)),
        netUsd: Number(ts.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(4)),
        rejected: res.diagnostics?.rejectedSignals ?? 0,
      });
      process.stdout.write(`[RUN] ${id} ${symbol}: ${ts.length} trade (rej ${res.diagnostics?.rejectedSignals ?? 0})\n`);
    }
    pooled.push({ strategyId: id, strategyName: cat.name, mode: cat.mode, trades, perSymbol, elapsedMs: Date.now() - t0 });
    // Simpan progres per strategi: kalau proses mati di tengah (timeout parent,
    // Ctrl-C), hasil strategi yang sudah selesai tetap ada di disk, tidak hilang.
    writeFileSync(resolve(OUT), JSON.stringify(buildReport(pooled, Date.now() - t0All), null, 2));
  }

  const report = buildReport(pooled, Date.now() - t0All);
  writeFileSync(resolve(OUT), JSON.stringify(report, null, 2));
  const rows = report.rows;
  console.log("\n================ POOLED BACKTEST (data nyata Binance 1m) ================");
  for (const r of rows) {
    console.log(`${r.strategyId} ${r.mode.padEnd(5)} | sampel ${String(r.samples).padStart(4)}/${TARGET} | WR ${r.winrate.toFixed(2)}% | net $${r.totalNetPnlUsd.toFixed(4)} | EV $${r.evUsd.toFixed(6)} | ${r.status}`);
  }
  console.log(`\nSemua target sampel tercapai: ${report.allTargetsMet ? "YA" : "TIDAK"}`);
  console.log(`Laporan: ${resolve(OUT)}`);
  process.exitCode = report.allGatesPassed ? 0 : 1;
}

main().catch((err) => {
  console.error("[FAIL]", err.message);
  process.exitCode = 1;
});