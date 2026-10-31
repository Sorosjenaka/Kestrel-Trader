// tools/aggregate-bkt.mjs — gabungkan laporan per-strategi (bkt-S-XX.json) menjadi
// satu laporan final + verifikasi target 500 sampel per strategi.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const files = readdirSync(".").filter((f) => /^bkt-S-\d+\.json$/.test(f)).sort();
// Dedupe per strategyId: file lama (bkt-report.json yang di-rename) bisa memuat
// lebih dari satu strategi, sehingga satu strategi muncul dua kali.
const byId = new Map();
for (const f of files) {
  const r = JSON.parse(readFileSync(f, "utf8"));
  for (const x of r.rows) if (!byId.has(x.strategyId)) byId.set(x.strategyId, x);
}
const rows = [...byId.values()];
// Katalog aktif 21 Okt 2026: SCALP = S-02 (S-01 hard-gated EV negatif),
// SWING = RSW-01/02/03 (Orion/Vega/Draco). S-05 Polaris diarsipkan 21 Okt 2026,
// S-03 Fibonacci dan S-04 MRV Stretch dihapus 20 Okt 2026.
// 21 Okt 2026 (Phase 4a): file bkt-S-03/S-04/S-05.json dihapus — semuanya
// berisi era-2 (29 Sep 2026) hasil backtest untuk strategi yang sudah tidak
// ada di katalog, dan semuanya berstatus FAILED (tidak pernah lolos gate).
// Baris S-03 tetap ada di laporan karena ikut tersimpan di bkt-S-01.json;
// S-04 dan S-05 hilang karena hanya ada di file yang dihapus.
// RSW-01/02/03 tidak ada di sini: laporan bkt untuk RSW hidup di pipeline
// swing-history (tools/run-four-swing-history.ts), bukan bkt-S-XX.json.
const order = ["S-02", "S-01", "S-03"];
rows.sort((a, b) => {
  const ai = order.indexOf(a.strategyId);
  const bi = order.indexOf(b.strategyId);
  // ID di luar daftar (mis. bucket arsip S-99) tetap diurutkan, di akhir.
  return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
});

const TARGET = 500;
const report = {
  generatedAt: new Date().toISOString(),
  source: "binance data.binance.vision arsip 1m + fapi fundingRate (data NYATA)",
  days: 60,
  symbols: ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","DOGEUSDT","XRPUSDT"],
  targetSamples: TARGET,
  strategiesReported: rows.length,
  allTargetsMet: rows.length === order.length && rows.every((r) => r.samples >= TARGET),
  allGatesPassed: rows.length === order.length && rows.every((r) => r.gatePassed),
  rows,
};
writeFileSync("bkt-report-final.json", JSON.stringify(report, null, 2));

console.log("STRATEGI            MODE   SAMPEL  WR%     NET$      EV$       GATE");
for (const r of rows) {
  console.log(
    `${r.strategyId.padEnd(6)} ${String(r.name).padEnd(26)} ${r.mode.padEnd(6)} ` +
    `${String(r.samples).padStart(4)}/${TARGET}  ${String(r.winrate).padStart(6)}  ` +
    `${String(r.totalNetPnlUsd).padStart(9)}  ${String(r.evUsd).padStart(10)}  ` +
    `${r.status}`
  );
}
console.log("");
console.log("Strategi dilaporkan :", rows.length, "/", order.length);
console.log("Semua target sampel :", report.allTargetsMet ? "TERCAPAI" : "BELUM");
console.log("Semua gate lulus    :", report.allGatesPassed ? "YA" : "TIDAK");
console.log("Laporan             :", resolve("bkt-report-final.json"));