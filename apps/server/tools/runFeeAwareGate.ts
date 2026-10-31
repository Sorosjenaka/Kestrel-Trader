// tools/runFeeAwareGate.ts — T0.4 (18 Okt 2026): gate fee-aware net EV untuk 5 kandidat.
//
// Rencana komparasi 18 Okt 2026, baris 0.4: "S-03, S-05, RSW-01, RSW-02, RSW-03
// diuji dengan backtestEngine gate (net EV > 0). Dokumentasikan hasil di
// ResearchFinding."
//
// YANG DILAKUKAN:
//  - S-03 & S-05 (ada di STRATEGY_CATALOG) dijalankan lewat runStrategyBacktest
//    pada mode SWING + RR23 (riset 1:3 — TP1 @ 2R ambil 50%, SL ke BE, runner @ 3R)
//    dengan fee penuh (maker 0,02% / taker 0,05%) + slippage. EV dihitung ENGINE
//    (calculateMetrics), lalu dinilai evaluateNetEvGate (net EV > 0).
//  - RSW-01/02/03 BELUM ada di STRATEGY_CATALOG (menunggu port T0.5 ke engines/)
//    -> TIDAK bisa digate di engine TS. Dicatat jujur sebagai PENDING T0.5,
//    TANPA mengarang angka gate TS. Bukti riset Python dirujuk sebagai runRefs.
//
// GOLDEN RULE §1.1: LLM dilarang menghitung nominal uang. Tool ini HANYA membaca
// keluaran engine (output.metrics) dan meneruskannya ke logResearchFinding. Tidak
// ada angka uang yang ditulis tangan di sini.
//
// VERDICT jujur (lihat feeAwareGate.ts):
//  - SUPPORTIVE   : sampel cukup + net EV > 0.
//  - REFUTED      : sampel cukup + net EV <= 0.
//  - INCONCLUSIVE : metrik invalid / sampel kurang (jangan mengarang klaim).
// operatorDecision selalu PENDING — hanya operator yang ADOPT/REJECT.
//
// Default DRY-RUN (cetak rencana, tanpa tulis DB). Tambah --apply untuk menulis.
// Idempoten: judul yang sudah ada di ResearchFinding dilewati.
//
//   npx tsx tools/runFeeAwareGate.ts                      # dry-run (pool SUI+AVAX+SOL)
//   npx tsx tools/runFeeAwareGate.ts --apply              # tulis ResearchFinding
//   npx tsx tools/runFeeAwareGate.ts --min-samples 30     # ambang sampel eksplorasi
//   npx tsx tools/runFeeAwareGate.ts --dataset a.json --dataset b.json
//   npx tsx tools/runFeeAwareGate.ts --datasets a.json,b.json
//
// POOL multi-simbol (18 Okt 2026): SWING sangat low-frequency per simbol; pool
// trades lintas simbol lalu hitung metrik oleh ENGINE (calculateMetrics). Default
// SUI/AVAX/SOL — simbol yang BISA di-sizing utk SWING pada risiko $1. BTCUSDT
// tidak ikut (minQty 0.001 BTC > notional sah utk risiko $1 pada SL struktural
// lebar -> QTY_LT_MIN, 0 trade).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStrategyBacktest,
  calculateMetrics,
  DEFAULT_FEE_STRUCTURE,
  STRATEGY_CATALOG,
  type BacktestMetrics,
  type TradeResult,
} from "../src/backtest/backtestEngine.js";
import { evaluateNetEvGate, NET_EV_GATE_ID, DEFAULT_MIN_SAMPLES } from "../src/backtest/feeAwareGate.js";
import { logResearchFinding, listResearchFindings, type FindingVerdict, type ResearchFindingInput } from "../src/learning/researchFinding.js";
import type { HistoricalDataset } from "../src/backtest/historicalReplay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- argumen -------------------------------------------------------------
const args = process.argv.slice(2);
const apply = args.includes("--apply");
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : undefined;
}
const minSamplesArg = argValue("--min-samples");
const minSamples = minSamplesArg && Number.isFinite(Number(minSamplesArg)) && Number(minSamplesArg) > 0
  ? Math.floor(Number(minSamplesArg))
  : DEFAULT_MIN_SAMPLES;
// Dataset: bisa berulang (--dataset a.json --dataset b.json) atau daftar
// terpisah koma (--datasets a.json,b.json). Default = simbol-simbol yang BISA
// di-sizing utk SWING pada risiko $1 (SUI/AVAX/SOL). BTCUSDT TIDAK dipakai
// secara default: minQty 0.001 BTC (~$76 notional) > notional yang sah utk
// risiko $1 pada SL struktural lebar -> qty ke-floor jadi 0 (QTY_LT_MIN),
// sehingga SWING di BTC tidak pernah menghasilkan trade. Lihat backfill di
// ResearchFinding / catatan T0.4.
const datasetArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dataset" && args[i + 1] && !args[i + 1]!.startsWith("--")) datasetArgs.push(args[i + 1]!);
}
const csvArg = argValue("--datasets");
if (csvArg) datasetArgs.push(...csvArg.split(",").map((s) => s.trim()).filter(Boolean));
function resolveDatasetPath(p: string): string {
  return p.startsWith("/") ? p : join(__dirname, "..", p);
}
const DEFAULT_DATASETS = [
  "data/datasets/SUIUSDT_1m_90d.json",
  "data/datasets/AVAXUSDT_1m_90d.json",
  "data/datasets/SOLUSDT_1m_90d.json",
];
const DATASET_PATHS = (datasetArgs.length ? datasetArgs : DEFAULT_DATASETS).map(resolveDatasetPath);

// ---- kandidat ------------------------------------------------------------
// 5 kandidat lane SWING (perintah operator 18 Okt 2026): S-03, S-05, RSW-01/02/03.
// T0.5 (18 Okt 2026): RSW-01/02/03 sudah di-port ke engines/ TS dan ada di
// STRATEGY_CATALOG + STRATEGY_SPECS. Sekarang bisa digate langsung.
interface Candidate { strategyId: string; inCatalog: boolean }
const CANDIDATES: Candidate[] = [
  { strategyId: "S-03", inCatalog: true },
  { strategyId: "S-05", inCatalog: true },
  { strategyId: "RSW-01", inCatalog: true },
  { strategyId: "RSW-02", inCatalog: true },
  { strategyId: "RSW-03", inCatalog: true },
];

// ---- helper tampilan ----------------------------------------------------
function iso(ts: number | Date | undefined): string {
  if (ts == null) return "-";
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? d.toISOString() : "-";
}
function summarizeMetrics(m: BacktestMetrics): string {
  // Angka diambil apa adanya dari engine (bukan hitungan LLM).
  return `n=${m.sampleCount} WR=${m.winrate}% evUsd=${m.evUsd} evR=${m.evR} net=${m.totalNetPnlUsd} fee=${m.totalFeesUsd} fund=${m.totalFundingUsd} maxDD=${m.maxDdUsd}`;
}

async function main() {
  process.stdout.write(`Gate        : ${NET_EV_GATE_ID}\n`);
  process.stdout.write(`Mode        : ${apply ? "APPLY (menulis)" : "DRY-RUN (tidak menulis)"}\n`);
  process.stdout.write(`minSamples  : ${minSamples}\n`);
  process.stdout.write(`Datasets    : ${DATASET_PATHS.length}\n`);

  const datasets: HistoricalDataset[] = DATASET_PATHS.map((p) => {
    const ds: HistoricalDataset = JSON.parse(readFileSync(p, "utf-8"));
    process.stdout.write(`  ${ds.symbol} bars=${ds.bars.length} intervalMs=${ds.intervalMs} OOS ${iso(ds.outOfSampleFrom)} -> ${iso(ds.outOfSampleTo)}\n`);
    return ds;
  });
  const datasetLabel = datasets.map((d) => d.symbol).join("+");
  process.stdout.write(`\n`);

  const existing = new Set((await listResearchFindings(200)).map((r) => String(r.title)));
  const findings: ResearchFindingInput[] = [];

  for (const cand of CANDIDATES) {
    const title = `T0.4 net-EV gate: ${cand.strategyId} SWING (fee penuh, RR23, pool ${datasetLabel})`;
    if (existing.has(title)) {
      process.stdout.write(`== ${cand.strategyId} == SUDAH ADA di ResearchFinding (idempoten: dilewati)\n\n`);
      continue;
    }

    process.stdout.write(`== ${cand.strategyId} ==\n`);

    // ---- kandidat yang belum diport (RSW-*) : tidak bisa digate di TS ----
    if (!cand.inCatalog || !STRATEGY_CATALOG[cand.strategyId]) {
      process.stdout.write(`  status    : TIDAK BISA digate — belum ada di STRATEGY_CATALOG (menunggu port T0.5)\n`);
      findings.push({
        title,
        hypothesis: `Kandidat ${cand.strategyId} pada lane SWING (RR23: 50% @ 2R -> BE -> 50% @ 3R) memiliki net EV > 0 setelah fee penuh.`,
        experimentType: "BACKTEST",
        verdict: "INCONCLUSIVE",
        conclusion:
          `Gate fee-aware ${NET_EV_GATE_ID} TIDAK DAPAT dijalankan: ${cand.strategyId} belum ada di STRATEGY_CATALOG, ` +
          `sehingga runStrategyBacktest melempar "Unknown strategy". Evaluator RSW masih di riset Python ` +
          `(research/swing_paper_signals.py) dan belum di-port ke engines/ TS (T0.5). ` +
          `Verdict net EV TS = belum dihitung. Bukti riset Python yang ada bersifat agregat multi-simbol ` +
          `dan BUKAN hasil gate fee-aware TS; rujuk runRefs. Jangan meng-ADOPT sebelum T0.5 selesai dan gate dijalankan.`,
        runRefs: [
          { kind: "BACKTEST", label: `researchSwingCatalog.json (${cand.strategyId})` },
          { kind: "BACKTEST", label: "research/swing_paper_signals.py (port T0.5 tertunda)" },
        ],
        metrics: {
          tsGateRun: false,
          blockedOn: "T0.5_PORT_RSW_TO_ENGINES",
          inStrategyCatalog: false,
          gateId: NET_EV_GATE_ID,
        },
      });
      process.stdout.write(`  verdict   : INCONCLUSIVE (PENDING T0.5 — dicatat jujur, tanpa angka TS)\n\n`);
      continue;
    }

    // ---- kandidat yang bisa digate di TS (S-03, S-05) ----
    // Pool trades di semua dataset (multi-simbol), lalu hitung metrik oleh ENGINE
    // (calculateMetrics) — Golden Rule §1.1: LLM tidak menghitung uang.
    let pooledTrades: TradeResult[] = [];
    let metrics: BacktestMetrics | null = null;
    let runReasons: string[] = [];
    let runStatus = "N/A";
    let runError: string | null = null;
    const perSymbol: Array<{ symbol: string; n: number; rejectedSignals: number; openTradesExcluded: number }> = [];
    try {
      for (const ds of datasets) {
        const out = runStrategyBacktest({
          strategyId: cand.strategyId,
          mode: "SWING",
          dataset: ds,
          fees: DEFAULT_FEE_STRUCTURE, // maker 0.02% / taker 0.05% (fee penuh)
          slippageBps: 5,
          initialEquityUsd: 200,
          targetRiskUsd: 1,
          maxDrawdownUsd: 200, // bukan kriteria T0.4; dilepas agar status run tidak tercemar
        });
        pooledTrades.push(...out.trades);
        perSymbol.push({
          symbol: ds.symbol,
          n: out.metrics.sampleCount,
          rejectedSignals: out.diagnostics.rejectedSignals,
          openTradesExcluded: out.diagnostics.openTradesExcluded,
        });
        if (runStatus === "N/A" && out.status !== "N/A") runStatus = out.status;
        for (const r of out.failedGateReasons ?? []) if (!runReasons.includes(r)) runReasons.push(r);
      }
      metrics = calculateMetrics(pooledTrades);
    } catch (e) {
      runError = (e as Error).message;
    }

    if (runError || !metrics) {
      process.stdout.write(`  ERROR     : ${runError ?? "tidak ada metrics"}\n`);
      findings.push({
        title,
        hypothesis: `Kandidat ${cand.strategyId} pada lane SWING (RR23) memiliki net EV > 0 setelah fee penuh.`,
        experimentType: "BACKTEST",
        verdict: "INCONCLUSIVE",
        conclusion: `runStrategyBacktest gagal untuk ${cand.strategyId}: ${runError}. Verdict net EV tidak dapat disimpulkan.`,
        runRefs: [{ kind: "BACKTEST", label: `runStrategyBacktest ${cand.strategyId} gagal` }],
        metrics: { tsGateRun: false, gateId: NET_EV_GATE_ID, runError: String(runError ?? "") },
      });
      process.stdout.write(`  verdict   : INCONCLUSIVE (run gagal)\n\n`);
      continue;
    }

    const gate = evaluateNetEvGate(metrics, { minSamples });
    const verdict: FindingVerdict = gate.verdict;
    for (const ps of perSymbol) {
      process.stdout.write(`  [${ps.symbol}] trades=${ps.n} rejectedSignals=${ps.rejectedSignals} openExcluded=${ps.openTradesExcluded}\n`);
    }
    process.stdout.write(`  pooled    : ${summarizeMetrics(metrics)}\n`);
    process.stdout.write(`  runStatus : ${runStatus}${runReasons.length ? ` (${runReasons.join(", ")})` : ""}\n`);
    process.stdout.write(`  netEVgate : ${gate.gatePassed ? "PASS" : "FAIL"} verdict=${verdict} reasons=[${gate.failedGateReasons.join(", ")}]\n`);

    const sufficient = metrics.sampleCount >= gate.minSamples;
    const conclusion =
      `Gate ${NET_EV_GATE_ID} pada ${cand.strategyId} mode SWING (RR23: 50% @ 2R -> BE -> 50% @ 3R), ` +
      `fee penuh (maker ${DEFAULT_FEE_STRUCTURE.makerRate} / taker ${DEFAULT_FEE_STRUCTURE.takerRate}) + slippage 5bps, ` +
      `pool ${datasets.length} simbol (${datasetLabel}) OOS per dataset lihat runRefs. ` +
      `EV dihitung ENGINE (calculateMetrics) atas trades terpool; lihat metrics. ` +
      (sufficient
        ? `Sampel ${metrics.sampleCount} >= lantai ${gate.minSamples}. Hasil net EV: ${verdict}.`
        : `Sampel ${metrics.sampleCount} < lantai ${gate.minSamples} -> INCONCLUSIVE (arah EV teramati tercatat di metrics.evUsd, ` +
          `tetapi TIDAK cukup untuk sertifikasi). SWING sangat low-frequency per simbol; sertifikasi net EV butuh ` +
          `univers lebih luas (T2 portfolio) atau riwayat lebih panjang. JANGAN membaca ini sebagai REFUTED/SUPPORTIVE.`) +
      ` Catatan: BTCUSDT tidak ikut pool karena SWING tidak bisa di-sizing di sana (minQty 0.001 BTC > ` +
      `notional sah utk risiko $1 pada SL struktural lebar -> QTY_LT_MIN, 0 trade). ` +
      `Gate FR-14 (winrate 60%) sengaja TIDAK dipakai di sini karena RR23 SWING beroperasi ~37-39% WR ` +
      `(lihat feeAwareGate.ts). Status run engine: ${runStatus}.`;

    findings.push({
      title,
      hypothesis: `Kandidat ${cand.strategyId} pada lane SWING (RR23: 50% @ 2R -> BE -> 50% @ 3R) memiliki net EV > 0 setelah fee penuh.`,
      experimentType: "BACKTEST",
      verdict,
      conclusion,
      runRefs: [
        { kind: "BACKTEST", label: `runStrategyBacktest ${cand.strategyId} SWING RR23 pool ${datasetLabel}` },
        { kind: "BACKTEST", label: `datasets: ${datasetLabel}` },
      ],
      metrics: {
        gateId: NET_EV_GATE_ID,
        tsGateRun: true,
        minSamples: gate.minSamples,
        sufficientSamples: sufficient,
        sampleCount: metrics.sampleCount,
        winCount: metrics.winCount,
        lossCount: metrics.lossCount,
        winrate: metrics.winrate,
        evUsd: metrics.evUsd,
        evR: metrics.evR,
        maxDdUsd: metrics.maxDdUsd,
        totalGrossPnlUsd: metrics.totalGrossPnlUsd,
        totalFeesUsd: metrics.totalFeesUsd,
        totalNetPnlUsd: metrics.totalNetPnlUsd,
        gatePassed: gate.gatePassed,
        failedGateReasons: gate.failedGateReasons.join(","),
        runStatus,
        runFailedReasons: runReasons.join(","),
        mode: "SWING",
        exitPolicy: "SWING_50_2R_BE_50_3R_V1",
        feesMakerRate: DEFAULT_FEE_STRUCTURE.makerRate,
        feesTakerRate: DEFAULT_FEE_STRUCTURE.takerRate,
        slippageBps: 5,
        datasetSymbols: datasetLabel,
        datasetCount: datasets.length,
      },
    });
    process.stdout.write(`  verdict   : ${verdict}\n\n`);
  }

  // ---- tulis / cetak ----
  if (findings.length === 0) {
    process.stdout.write(`Tidak ada temuan baru untuk dicatat (semua sudah ada / dilewati).\n`);
    return;
  }

  process.stdout.write(`\n=== ${findings.length} temuan untuk dicatat ===\n`);
  for (const f of findings) {
    process.stdout.write(`  [${f.verdict}] ${f.title}\n`);
    process.stdout.write(`      hyp : ${f.hypothesis}\n`);
    process.stdout.write(`      con : ${f.conclusion.slice(0, 160)}${f.conclusion.length > 160 ? "..." : ""}\n`);
    process.stdout.write(`      mtr : ${JSON.stringify(f.metrics)}\n`);
  }

  if (!apply) {
    process.stdout.write(`\nDry-run selesai. Tidak ada yang ditulis. Jalankan lagi dengan --apply.\n`);
    return;
  }

  process.stdout.write(`\nMenulis ke ResearchFinding...\n`);
  let written = 0;
  for (const f of findings) {
    const id = await logResearchFinding(f);
    if (id != null) written++;
    process.stdout.write(`  id=${id ?? "GAGAL"} ${f.title}\n`);
  }
  process.stdout.write(`\nSelesai. ${written}/${findings.length} temuan ditulis (semua PENDING — menunggu keputusan operator).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
