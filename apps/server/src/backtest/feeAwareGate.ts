// apps/server/src/backtest/feeAwareGate.ts — T0.4 (18 Okt 2026): gate fee-aware net EV.
//
// Rencana komparasi 18 Okt 2026, baris 0.4: "S-03, S-05, RSW-01, RSW-02, RSW-03
// diuji dengan backtestEngine gate (net EV > 0). Dokumentasikan hasil di
// ResearchFinding."
//
// PERBEDAAN dengan evaluateBacktestGate (FR-14 / AC-12 di backtestEngine.ts):
//  - FR-14 mematok winrate >= 60% (lantai KERAS) karena itu kriteria SCALP
//    single-target 1.5R (TP1 sebelum SL). Kriteria itu TIDAK sah untuk kandidat
//    SWING RR23 (riset: TP1 @ 2R ambil 50%, SL ke BE, runner ke TPmax @ 3R) yang
//    beroperasi pada winrate ~37-39% dengan payoff miring. Memaksa 60% akan
//    menolak SEMUA kandidat terlepas dari EV — itu salah ukur.
//  - Gate T0.4 hanya menuntut net EV > 0 (EV bersih-fee) pada sampel memadai:
//    "apakah strategi ini menghasilkan uang SETELAH fee penuh (maker 0,02% /
//    taker 0,05%) + slippage". Lantai sampel DIPERTAHANKAN (integritas
//    statistik); syarat winrate DIBUANG.
//
// VERDICT (dipetakan ke FindingVerdict ResearchFinding):
//  - SUPPORTIVE    : sampel cukup, metrik valid, dan net EV > 0.
//  - REFUTED       : sampel cukup, metrik valid, tapi net EV <= 0
//                    (hipotesis "net EV > 0 setelah fee" GUGUR).
//  - INCONCLUSIVE  : metrik tak terhingga / hitungan tak valid / sampel kurang —
//                    belum bisa disimpulkan (jangan mengarang angka).
//
// GOLDEN RULE §1.1: modul ini TIDAK menghitung ulang nominal uang. Semua angka
// (evUsd, sampleCount, …) datang apa adanya dari calculateMetrics /
// runStrategyBacktest. Gate hanya MEMBANDINGKAN angka engine, tidak menghitungnya.

import type { BacktestMetrics } from "./backtestEngine.js";

/** Kriteria gate fee-aware T0.4. */
export const NET_EV_GATE_ID = "T0.4_NET_EV_FEE_AWARE";

/** Lantai sampel default — disamakan dengan FR-14 (500) untuk validitas statistik. */
export const DEFAULT_MIN_SAMPLES = 500;

export interface NetEvGateOptions {
  /** Sampel minimum sebelum EV dianggap bermakna. Default {@link DEFAULT_MIN_SAMPLES}. */
  minSamples?: number;
}

export interface NetEvGateResult {
  gatePassed: boolean;
  /** Alasan gagal (kosong bila lolos). Nilai stabil untuk diuji & diaudit. */
  failedGateReasons: string[];
  /** Pemetaan ke FindingVerdict — verdict RISET yang jujur, bukan klaim. */
  verdict: "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE";
  /** Ambang sampel yang benar-benar dipakai (hasil clamp/absen -> default). */
  minSamples: number;
}

/**
 * Gate fee-aware T0.4: net EV > 0 pada sampel memadai.
 *
 * Murni & deterministik — tidak menyentuh DB, tidak menghitung uang.
 * `metrics` harus keluaran `calculateMetrics` (atau `runStrategyBacktest.metrics`).
 */
export function evaluateNetEvGate(
  metrics: BacktestMetrics,
  opts: NetEvGateOptions = {}
): NetEvGateResult {
  const minSamples = Number.isFinite(opts.minSamples) && opts.minSamples! > 0
    ? Math.floor(opts.minSamples!)
    : DEFAULT_MIN_SAMPLES;

  const failedGateReasons: string[] = [];

  // 1. Semua medan numerik harus terhingga (NaN/Infinity -> tak bisa disimpulkan).
  const finite = Object.values(metrics).every((v) => typeof v === "number" && Number.isFinite(v));
  if (!finite) failedGateReasons.push("NON_FINITE_METRICS");

  // 2. Hitungan harus konsisten (win+loss == sample, non-negatif, integer).
  const countsValid =
    Number.isInteger(metrics.sampleCount) &&
    Number.isInteger(metrics.winCount) &&
    Number.isInteger(metrics.lossCount) &&
    metrics.sampleCount >= 0 &&
    metrics.winCount >= 0 &&
    metrics.lossCount >= 0 &&
    metrics.winCount + metrics.lossCount === metrics.sampleCount;
  if (!countsValid) failedGateReasons.push("INVALID_COUNTS");

  // 3. Lantai sampel (dipertahankan dari FR-14 — integritas statistik).
  const samplesOk = countsValid && metrics.sampleCount >= minSamples;
  if (!samplesOk) failedGateReasons.push(`SAMPLES_LT_${minSamples}`);

  // 4. Kriteria inti T0.4: net EV > 0 (evUsd sudah bersih-fee dari engine).
  //    Hanya dinilai bila metrik valid & sampel cukup; kalau tidak, EV tidak
  //    bermakna dan verdict turun ke INCONCLUSIVE (lihat di bawah).
  const evPositive = Number.isFinite(metrics.evUsd) && metrics.evUsd > 0;
  if (samplesOk && finite && countsValid && !evPositive) failedGateReasons.push("EV_NET_FEE_LE_0");

  const gatePassed = failedGateReasons.length === 0;

  // Pemetaan verdict: sampel kurang / metrik invalid -> INCONCLUSIVE (mendahului
  // penilaian EV, karena EV pada sampel kecil itu derau, bukan bukti).
  let verdict: NetEvGateResult["verdict"];
  if (!finite || !countsValid || !samplesOk) verdict = "INCONCLUSIVE";
  else if (!evPositive) verdict = "REFUTED";
  else verdict = "SUPPORTIVE";

  return { gatePassed, failedGateReasons, verdict, minSamples };
}
