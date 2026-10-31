// tools/probe-window.ts — probe sementara (read-only): cek validasi dataset nyata
// dan berapa trade yang dihasilkan per simbol/per strategi sebelum harness 500 sampel.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStrategyBacktest, type HistoricalDataset } from "../apps/server/src/backtest/backtestEngine.js";
import { validateHistoricalDataset } from "../apps/server/src/backtest/historicalReplay.js";

const [, , datasetPath, strategyId = "S-01", daysArg = "60"] = process.argv;
if (!datasetPath) {
  console.error("Usage: npx tsx tools/probe-window.ts data/history/BTCUSDT_1m.json S-01 60");
  process.exitCode = 2;
} else {
  const raw = JSON.parse(readFileSync(resolve(datasetPath), "utf8")) as HistoricalDataset;
  const MINUTE = 60_000;
  const lastFunding = raw.funding.at(-1)!.time;
  const oosTo = lastFunding;
  const wantFrom = oosTo - Number(daysArg) * 86_400_000;
  const oosFrom = Math.ceil(wantFrom / MINUTE) * MINUTE;
  const w: HistoricalDataset = {
    ...raw,
    outOfSampleFrom: oosFrom,
    outOfSampleTo: oosTo,
    trainingEndedAt: oosFrom - 3_600_000,
    embargoMs: 0,
    fundingCoverage: { from: raw.funding[0]!.time, to: lastFunding },
  };
  console.log(JSON.stringify({
    file: datasetPath,
    bars: raw.bars.length,
    funding: raw.funding.length,
    firstBar: new Date(raw.bars[0]!.openTime).toISOString(),
    lastBar: new Date(raw.bars.at(-1)!.openTime).toISOString(),
    lastFunding: new Date(lastFunding).toISOString(),
    errorsAsDownloaded: validateHistoricalDataset(raw),
    window: { from: new Date(oosFrom).toISOString(), to: new Date(oosTo).toISOString() },
    errorsWindowed: validateHistoricalDataset(w),
  }, null, 2));

  const t0 = Date.now();
  const res = runStrategyBacktest({ strategyId, dataset: w, maxDrawdownUsd: 1e9 });
  console.log(JSON.stringify({
    strategyId, elapsedMs: Date.now() - t0,
    status: res.status,
    reasons: res.failedGateReasons,
    samples: res.metrics.sampleCount,
    winrate: res.metrics.winrate,
    netUsd: res.metrics.totalNetPnlUsd,
    diagnostics: res.diagnostics,
    provenanceKind: res.provenance?.kind,
  }, null, 2));
}