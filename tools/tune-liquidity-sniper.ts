// tools/tune-liquidity-sniper.ts
// Tuning parameter engine Liquidity Sniper (S-02) pada data klines Binance nyata.
// Strategi: mutasi DEFAULT_LIQUIDITY_SNIPER_OPTIONS sebelum tiap run; jalur
// produksi tanpa opsi eksplisit memakai DEFAULT yang bisa kita ubah untuk eksperimen.
//
// CATATAN ID (20 Okt 2026): tool ini dulu memanggil strategyId "S-04" — itu
// Liquidity Sniper pada era SEBELUM renumber 6 Okt 2026. Setelah renumber,
// Liquidity Sniper = S-02, sedangkan "S-04" menjadi Mean-Reversion Stretch,
// yang TIDAK lagi punya evaluator di jalur entry aktif (S-04 dihapus dari
// STRATEGY_SPECS) sehingga replay strategyId "S-04" selalu menghasilkan 0 plan.
// Jadi tool ini dipindah ke S-02 — ID yang benar-benar memakai
// DEFAULT_LIQUIDITY_SNIPER_OPTIONS — dan tetap hidup apa adanya S-04 sebagai
// arsip histori/replay (tidak ada entry baru dari ID itu).
//
// Pakai (screening cepat):
//   npx tsx tools/tune-liquidity-sniper.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 60
// Validasi penuh: --symbols (6 simbol) --days 90
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  runStrategyBacktest,
  calculateMetrics,
  type HistoricalDataset,
} from "../apps/server/src/backtest/backtestEngine.js";
import { DEFAULT_LIQUIDITY_SNIPER_OPTIONS } from "../apps/server/src/engines/indicatorLibrary.js";
import { validateHistoricalDataset } from "../apps/server/src/backtest/historicalReplay.js";
import { rrPolicyForMode } from "../apps/server/src/config/setupEngine.js";

const MINUTE = 60_000;
const DAY = 86_400_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

const SYMBOLS = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DIR = arg("dir", "data/history");
const DAYS = Number(arg("days", "60"));
const OUT = arg("out", "bkt-tuning.json");

interface Variation {
  name: string;
  pullBiasThreshold?: number;
  leverageProfile?: "CRYPTO_DEGEN" | "BALANCED" | "CONSERVATIVE";
  stopLiquidityWeight?: number;
  clusterMergeDistanceAtr?: number;
  intensityHalfLife?: number;
  maxMagnetDistancePct?: number;
}

// Grid screening: fokus pada selektivitas pull bias + profil leverage + bobot stop.
const VARIATIONS: Variation[] = [
  { name: "thr1.5", pullBiasThreshold: 1.5 },
  { name: "thr1.6", pullBiasThreshold: 1.6 },
  { name: "thr1.6+conservative", pullBiasThreshold: 1.6, leverageProfile: "CONSERVATIVE" },
  { name: "thr1.6+cons+stopW1.5", pullBiasThreshold: 1.6, leverageProfile: "CONSERVATIVE", stopLiquidityWeight: 1.5 },
];

function windowFor(raw: HistoricalDataset, days: number): HistoricalDataset {
  const lastFunding = raw.funding[raw.funding.length - 1]!.time;
  const oosTo = lastFunding;
  const oosFrom = Math.ceil((oosTo - days * DAY) / MINUTE) * MINUTE;
  return { ...raw, outOfSampleFrom: oosFrom, outOfSampleTo: oosTo, trainingEndedAt: oosFrom - MINUTE, embargoMs: 0, fundingCoverage: { from: raw.funding[0]!.time, to: lastFunding } };
}

function applyVariation(v: Variation) {
  // Kembalikan ke default dulu, lalu terapkan variasi.
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold = 1.1;
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.leverageProfile = "BALANCED";
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.stopLiquidityWeight = 1.0;
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.clusterMergeDistanceAtr = 0.5;
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.intensityHalfLife = 50;
  DEFAULT_LIQUIDITY_SNIPER_OPTIONS.maxMagnetDistancePct = 5.0;
  if (v.pullBiasThreshold !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold = v.pullBiasThreshold;
  if (v.leverageProfile !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.leverageProfile = v.leverageProfile;
  if (v.stopLiquidityWeight !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.stopLiquidityWeight = v.stopLiquidityWeight;
  if (v.clusterMergeDistanceAtr !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.clusterMergeDistanceAtr = v.clusterMergeDistanceAtr;
  if (v.intensityHalfLife !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.intensityHalfLife = v.intensityHalfLife;
  if (v.maxMagnetDistancePct !== undefined) DEFAULT_LIQUIDITY_SNIPER_OPTIONS.maxMagnetDistancePct = v.maxMagnetDistancePct;
}

async function main() {
  const datasets: { symbol: string; data: HistoricalDataset }[] = [];
  for (const s of SYMBOLS) {
    const raw = JSON.parse(readFileSync(resolve(join(DIR, `${s}_1m.json`)), "utf8")) as HistoricalDataset;
    const w = windowFor(raw, DAYS);
    const errs = validateHistoricalDataset(w);
    if (errs.length) throw new Error(`${s}: ${errs.join(",")}`);
    datasets.push({ symbol: s, data: w });
  }
  console.log(`[DATA] ${datasets.length} simbol, window ${DAYS} hari`);

  const results: any[] = [];
  for (const v of VARIATIONS) {
    applyVariation(v);
    const trades: any[] = [];
    const t0 = Date.now();
    for (const { symbol, data } of datasets) {
      const res = runStrategyBacktest({ strategyId: "S-02", dataset: data, maxDrawdownUsd: 1e9 });
      trades.push(...(res.trades ?? []));
    }
    const m = calculateMetrics(trades);
    // Breakeven = 100 / (1 + R). Angka 2.1 lama berasal dari era S-04 (RR
    // SWING lawas). Sekarang S-02 = Liquidity Sniper di lane SCALP, jadi R
    // diambil dari policy engine yang sama dengan yang dipakai replay.
    const be = 100 / (1 + rrPolicyForMode("SCALP", "S-02").tp1R);
    const row = {
      name: v.name,
      samples: m.sampleCount,
      winrate: m.winrate,
      evUsd: m.evUsd,
      netUsd: m.totalNetPnlUsd,
      edgeOverBreakeven: Number((m.winrate - be).toFixed(2)),
      elapsedMs: Date.now() - t0,
    };
    results.push(row);
    console.log(`[TUNE] ${v.name.padEnd(24)} n=${String(m.sampleCount).padStart(4)} WR=${m.winrate.toFixed(2)}% EV=$${m.evUsd.toFixed(4)} net=$${m.totalNetPnlUsd.toFixed(2)} edge=${row.edgeOverBreakeven}%`);
  }

  // Urutkan berdasarkan EV (terbaik = EV terbesar), lalu WR.
  results.sort((a, b) => b.evUsd - a.evUsd || b.winrate - a.winrate);
  writeFileSync(resolve(OUT), JSON.stringify({ generatedAt: new Date().toISOString(), symbols: SYMBOLS, days: DAYS, breakevenPct: 100 / (1 + rrPolicyForMode("SCALP", "S-02").tp1R), results }, null, 2));
  console.log("\n=== TOP berdasarkan EV ===");
  for (const r of results) console.log(`${r.name.padEnd(24)} n=${String(r.samples).padStart(4)} WR=${r.winrate.toFixed(2)}% EV=$${r.evUsd.toFixed(4)} edge=${r.edgeOverBreakeven}%`);
  console.log(`\nLaporan: ${resolve(OUT)}`);
}

main().catch((e) => { console.error("[FAIL]", e.message); process.exitCode = 1; });
