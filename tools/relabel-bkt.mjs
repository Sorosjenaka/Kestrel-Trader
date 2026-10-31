// tools/relabel-bkt.mjs — relabel laporan backtest bkt-*.json dari nomor LAMA
// (S-03 FVG, S-06 Sweep, S-07 Supertrend, S-08 HA) ke nomor BARU urut S-01..S-05
// sesudah RENUMBER 29 Sep 2026:
//   S-03 FVG Continuation  -> S-02
//   S-06 Liquidity Sweep   -> S-03
//   S-07 Age Adaptive ST   -> S-04
//   S-08 HA Smooth Scalper -> S-05
// File sumber di-relabel ISI (strategyId) lalu nama file disesuaikan lewat nama
// sementara agar tidak saling menimpa saat swap.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const MAP = { "S-03": "S-02", "S-06": "S-03", "S-07": "S-04", "S-08": "S-05" };
const FILE_MAP = {
  "bkt-S-03.json": "bkt-S-02.json",
  "bkt-S-06.json": "bkt-S-03.json",
  "bkt-S-07.json": "bkt-S-04.json",
  "bkt-S-08.json": "bkt-S-05.json",
};

function relabel(node) {
  if (Array.isArray(node)) return node.map(relabel);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "strategyId" && typeof v === "string" && MAP[v]) out[k] = MAP[v];
      else out[k] = relabel(v);
    }
    return out;
  }
  return node;
}

const CONTENT_TARGETS = [
  "bkt-S-01.json", "bkt-S-03.json", "bkt-S-06.json", "bkt-S-07.json", "bkt-S-08.json",
  "bkt-report.json", "bkt-report-final.json",
];
for (const f of CONTENT_TARGETS) {
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify(relabel(j), null, 2));
  console.log("RELABEL", f);
}

const steps = Object.entries(FILE_MAP);
for (const [from] of steps) if (existsSync(from)) renameSync(from, from + ".tmp");
for (const [from, to] of steps) if (existsSync(from + ".tmp")) renameSync(from + ".tmp", to);
console.log("FILES_RENAMED");