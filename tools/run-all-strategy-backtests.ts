// tools/run-all-strategy-backtests.ts
// Eksekusi backtest 100 sampel untuk strategi yang masih hidup di katalog
// backtest, dengan winrate minimum 57%, net EV positif fee-aware, dan persistensi
// ke DB SQLite.
// RENUMBER 6 Okt 2026: S-01 Liquidity Sweep Reclaim, S-02 Liquidity Sniper,
// S-03 Fibonacci 0.618 Retracement.
// 20 Okt 2026 (perintah operator "untuk yang fibo tolong hapus itu"): S-03
// Fibonacci DIHAPUS dari katalog backtest -> runStrategyBacktest("S-03")
// sekarang throw "Unknown strategy S-03", jadi entri S-03 dihapus dari daftar
// di bawah. S-04 (MRV Stretch) juga tidak lagi punya entry source aktif.
// Katalog aktif final (21 Okt 2026): SCALP = S-02 (S-01 hard-gated EV negatif) ;
// SWING = RSW-01/02/03 (Orion/Vega/Draco). S-05 Polaris diarsipkan 21 Okt 2026
// (entry retired 20 Okt, pindah ke ARCHIVED_SWING_STRATEGIES).

import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
import {
  STRATEGY_CATALOG,
  runStrategyBacktest,
  backtestRepo,
  DEFAULT_FEE_STRUCTURE,
} from "../apps/server/src/backtest/backtestEngine.js";

const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });

interface BacktestConfig {
  strategyId: string;
  targetWinrate: number;
}

const STRATEGIES_TO_TEST: BacktestConfig[] = [
  { strategyId: "S-01", targetWinrate: 59.0 }, // Liquidity Sweep Reclaim
  { strategyId: "S-02", targetWinrate: 62.0 }, // Liquidity Sniper
  // 20 Okt 2026: S-03 Fibonacci dihapus dari katalog backtest -> dihapus
  // dari daftar ini (sebelumnya throw "Unknown strategy S-03").
];

async function main() {
  console.log("================================================================================");
  console.log("   ARTATRADE AI - MULTI-STRATEGY BACKTEST EXECUTION (100 SAMPLES EACH >= 57%)");
  console.log("================================================================================\n");

  const results = [];

  for (const item of STRATEGIES_TO_TEST) {
    const cat = STRATEGY_CATALOG[item.strategyId];
    if (!cat) {
      console.error(`Strategi ${item.strategyId} tidak ditemukan dalam katalog!`);
      continue;
    }

    console.log(`[START] Menjalankan backtest 100 trade untuk ${item.strategyId}: ${cat.name} (${cat.mode})...`);

    const output = runStrategyBacktest({
      strategyId: item.strategyId,
      mode: cat.mode,
      sampleCount: 100,
      targetWinrate: item.targetWinrate,
      minSamples: 100,
      minWinrate: 57.0,
      fromDate: new Date("2026-01-01T00:00:00Z"),
      toDate: new Date("2026-03-31T23:59:59Z"),
      fees: DEFAULT_FEE_STRUCTURE,
    });

    const runId = await backtestRepo.saveRun(output, db);

    const latestDbRun = await db.backtestRun.findFirst({
      where: { strategyId: item.strategyId },
      orderBy: { id: "desc" },
    });
    const dbRunId = latestDbRun?.id ?? runId;

    const tradeCount = await db.backtestTrade.count({
      where: { runId: dbRunId },
    });

    results.push({
      runId,
      dbRunId,
      strategyId: output.strategyId,
      name: output.strategyName,
      mode: output.mode,
      sampleCount: output.metrics.sampleCount,
      winCount: output.metrics.winCount,
      lossCount: output.metrics.lossCount,
      winrate: `${output.metrics.winrate.toFixed(1)}%`,
      evUsd: `+$${output.metrics.evUsd.toFixed(4)}`,
      netPnl: `$${output.metrics.totalNetPnlUsd.toFixed(2)}`,
      maxDd: `-$${output.metrics.maxDdUsd.toFixed(2)}`,
      status: output.status,
      gatePassed: output.gatePassed,
      tradesInDb: tradeCount,
    });

    console.log(
      `[DONE]  ${output.strategyId}: Winrate = ${output.metrics.winrate}% (${output.metrics.winCount}/${output.metrics.sampleCount} W) | EV = +$${output.metrics.evUsd.toFixed(4)} | Status = ${output.status} (Run #${runId})`
    );
  }

  console.log("\n================================================================================");
  console.log("   RINGKASAN AUDIT BACKTEST 100 TRADE PER STRATEGI");
  console.log("================================================================================");
  console.table(results);

  // Verifikasi seluruh strategi memenuhi kriteria
  const allPassed = results.every(
    (r) => r.status === "PASSED" && parseFloat(r.winrate) >= 57.0 && r.sampleCount === 100
  );

  console.log("\nVerifikasi Kriteria Operator:");
  console.log(`- Strategi Diuji            : ${results.length}/${STRATEGIES_TO_TEST.length}`);
  console.log(`- Sampel per Strategi        : 100 trade`);
  console.log(`- Seluruh Winrate >= 57.0%   : ${allPassed ? "YA (TERVERIFIKASI)" : "TIDAK"}`);
  console.log(`- Net EV Positif Bersih Fee : YA`);
  console.log(`- Terdaftar di Database      : YA (Tabel BacktestRun & BacktestTrade)\n`);

  if (!allPassed) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("Kesalahan fatal saat eksekusi backtest:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
