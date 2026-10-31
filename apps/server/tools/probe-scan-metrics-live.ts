// apps/server/tools/probe-scan-metrics-live.ts
//
// 24 Okt 2026 — Probe live untuk 4 metrik kolom Live Market Scanner
// (KNN / ER / OI% / BETA). Menjalankan jalur fetch ASLI yang dipakai scan
// (binanceFuturesClient.fetchPublic + fetchKlines) supaya kita tahu
// apakah OI/beta benar-benar bisa dihitung di produksi — bukan asumsi.
//
// Menjalankan: npx tsx apps/server/tools/probe-scan-metrics-live.ts
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";
import {
  fetchOpenInterestChangePct,
  calculateBetaBtc,
  getBtcReferenceBars,
  resetPerceptionCaches,
} from "../src/engines/perceptionB4.js";
import { klinesToBars } from "../src/engines/multiTimeframeAnalyzer.js";

const SYMBOLS = (process.env.PROBE_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ENAUSDT,MASKUSDT").split(",");

async function main(): Promise<void> {
  resetPerceptionCaches();
  console.log(`[probe] simbol: ${SYMBOLS.join(", ")}`);

  // 1) OI — jalur persis seperti scan worker.
  console.log("\n[probe] === OI (fetchOpenInterestChangePct via fetchPublic) ===");
  for (const sym of SYMBOLS) {
    const res = await fetchOpenInterestChangePct(sym, (p) => binanceFuturesClient.fetchPublic(p));
    const shown = res.value === null ? "null" : `${res.value.toFixed(4)}%`;
    console.log(`  ${sym.padEnd(12)} status=${res.status.padEnd(20)} value=${shown.padEnd(12)} reason=${res.reason}`);
  }

  // 2) Beta — perlu bar 5m simbol (>=51) + bar referensi BTC.
  console.log("\n[probe] === BETA (calculateBetaBtc) ===");
  const btcRef = await getBtcReferenceBars((s, i, l) => binanceFuturesClient.fetchKlines(s, i as "5m", l));
  console.log(`  ref BTCUSDT 5m: bars=${btcRef.bars?.length ?? 0} status=${btcRef.status} reason=${btcRef.reason}`);
  for (const sym of SYMBOLS) {
    const raw = await binanceFuturesClient.fetchKlines(sym, "5m", 90);
    const bars = klinesToBars(raw);
    const res = calculateBetaBtc(bars, btcRef.bars);
    const shown = res.value === null ? "null" : res.value.toFixed(4);
    console.log(`  ${sym.padEnd(12)} bars=${String(bars.length).padStart(3)} status=${res.status.padEnd(20)} value=${shown.padEnd(10)} reason=${res.reason}`);
  }
}

main().catch((e) => {
  console.error("[probe] GAGAL:", e);
  process.exitCode = 1;
});
