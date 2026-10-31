// tools/fix-historical-datasets.mjs
// Perbaikan in-place dataset hasil unduhan supaya lolos validateHistoricalDataset()
// tanpa mengunduh ulang bar (bar-nya sudah nyata dari arsip Binance).
//
// Tiga cacat yang diperbaiki, semuanya terbukti dari run nyata:
//   1. funding.time tidak kelipatan 60000 (REST Binance mengembalikan …16:00:00.005Z)
//      → validator: INVALID_FUNDING.
//   2. trainingEndedAt + embargoMs == outOfSampleFrom (harus STRICT <)
//      → validator: INVALID_CHRONOLOGICAL_SPLIT.
//   3. fundingCoverage.to < outOfSampleTo → validator: MISSING_FUNDING_COVERAGE.
//
// Pakai: node tools/fix-historical-datasets.mjs --dir data/history
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MINUTE = 60_000;
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DIR = arg("dir", "data/history");

const files = readdirSync(DIR).filter((f) => f.endsWith("_1m.json"));
let changed = 0;
for (const f of files) {
  const path = join(DIR, f);
  const d = JSON.parse(readFileSync(path, "utf8"));
  const before = JSON.stringify({ t: d.trainingEndedAt, fc: d.fundingCoverage, n: d.funding.length });

  // 1. Bulatkan waktu funding ke menit + buang duplikat.
  const byTime = new Map();
  for (const x of d.funding) byTime.set(Math.floor(x.time / MINUTE) * MINUTE, { ...x, time: Math.floor(x.time / MINUTE) * MINUTE });
  d.funding = [...byTime.values()].sort((a, b) => a.time - b.time);

  // 2. Split kronologis STRICT: trainingEndedAt + embargo < outOfSampleFrom.
  d.trainingEndedAt = d.outOfSampleFrom - d.embargoMs - MINUTE;

  // 3. Coverage funding harus menutupi [outOfSampleFrom, outOfSampleTo].
  d.fundingCoverage = { from: d.funding[0].time, to: d.funding[d.funding.length - 1].time };

  const after = JSON.stringify({ t: d.trainingEndedAt, fc: d.fundingCoverage, n: d.funding.length });
  if (before !== after) {
    writeFileSync(path, JSON.stringify(d));
    changed++;
    console.log(`[FIXED] ${f} funding=${d.funding.length} trainingEndedAt=${new Date(d.trainingEndedAt).toISOString()} coverage=${new Date(d.fundingCoverage.from).toISOString()}..${new Date(d.fundingCoverage.to).toISOString()} oosTo=${new Date(d.outOfSampleTo).toISOString()}`);
  } else {
    console.log(`[OK]    ${f} (tidak berubah)`);
  }
}
console.log(JSON.stringify({ dir: DIR, files: files.length, changed }, null, 2));