// apps/server/src/backtest/validation/lookAheadAudit.ts
// Big Brain — ambil prinsip "anti look-ahead" dari infrastruktur riset hedge
// fund (konteks: artikel QuantGPT 12 Okt 2026) dan JADIKAN BUKTI, bukan klaim.
//
// KONTRAK (Golden Rule §10 — bukti angka):
//  - Audit ini TIDAK mempercayai penanda "anti-look-ahead" di kode. Ia
//    MEMBUKTIKAN dengan dua eksperimen pada dataset yang sama:
//      1. TRUNCATED: replay dihentikan di titik potong T di tengah jendela
//         OOS — semua trade yang ENTRY sebelum T harus identik dengan
//         baseline (entry, exit, R).
//      2. CORRUPTED: SEMUA bar & funding SETELAH T dirusak nilainya
//         (harga 1e9, rate 1) — keputusan & trade sebelum T tetap harus
//         identik. Kalau masa depan bisa mengubah masa lalu, audit GAGAL.
//  - Ia menerima replayFn sehingga bisa diaudit pada replay manapun
//    (termasuk yang sengaja dibuat bocor untuk test auditor sendiri).
//  - Tidak ada fabrikasi: dataset tidak valid → audit FAILED dengan alasan.
import type { HistoricalDataset, ReplayOptions, ReplayOutput } from "../historicalReplay.js";
import { replayHistoricalDataset, validateHistoricalDataset } from "../historicalReplay.js";

export type LookAheadReplayFn = (d: HistoricalDataset, options: ReplayOptions) => ReplayOutput;

export interface LookAheadAuditResult {
  passed: boolean;
  cutTime: number;
  reasons: string[];
  baseline: { tradeCount: number; checkedTrades: number };
  truncated: { tradeCount: number; checkedTrades: number };
  corrupted: { tradeCount: number; checkedTrades: number };
  differences: { experiment: "TRUNCATED" | "CORRUPTED"; entryAt: number; field: string; baseline: string; variant: string }[];
  limitations: string[];
}

function cloneDataset(d: HistoricalDataset): HistoricalDataset {
  return {
    ...d,
    bars: d.bars.map((b) => ({ ...b })),
    funding: d.funding.map((f) => ({ ...f })),
    fundingCoverage: { ...d.fundingCoverage },
    rules: { ...d.rules },
  };
}

/** Trade yang entry SEBELUM titik potong — inilah yang diwajibkan identik. */
function tradesBefore(out: ReplayOutput, cutTime: number) {
  return out.trades.filter((t) => t.entryAt.getTime() < cutTime && t.exitAt.getTime() <= cutTime
    && !t.exitReason.includes("DATA_END"));
}

function fingerprint(t: ReturnType<typeof tradesBefore>[number]): string {
  return JSON.stringify([t.entryAt.getTime(), t.exitAt.getTime(), t.direction, t.entryPrice, t.exitPrice,
    t.exitReason, t.slPct, t.effectiveRiskUsd, t.feesUsd, t.fundingUsd, t.netPnlUsd, t.netR]);
}

function diffTrades(
  experiment: "TRUNCATED" | "CORRUPTED",
  baseline: ReturnType<typeof tradesBefore>,
  variant: ReturnType<typeof tradesBefore>,
  cutTime: number
): LookAheadAuditResult["differences"] {
  const diffs: LookAheadAuditResult["differences"] = [];
  const baseMap = new Map(baseline.map((t) => [t.entryAt.getTime(), t]));
  const varMap = new Map(variant.map((t) => [t.entryAt.getTime(), t]));
  for (const [time, b] of baseMap) {
    const v = varMap.get(time);
    if (!v) {
      diffs.push({ experiment, entryAt: time, field: "trade", baseline: fingerprint(b), variant: "MISSING" });
      continue;
    }
    if (fingerprint(b) !== fingerprint(v)) {
      diffs.push({ experiment, entryAt: time, field: "fingerprint", baseline: fingerprint(b), variant: fingerprint(v) });
    }
  }
  for (const [time, v] of varMap) {
    if (!baseMap.has(time)) {
      diffs.push({ experiment, entryAt: time, field: "trade", baseline: "MISSING", variant: fingerprint(v) });
    }
  }
  void cutTime;
  return diffs;
}

export function runLookAheadAudit(
  dataset: HistoricalDataset,
  options: ReplayOptions,
  replayFn: LookAheadReplayFn = replayHistoricalDataset
): LookAheadAuditResult {
  const result: LookAheadAuditResult = {
    passed: false,
    cutTime: 0,
    reasons: [],
    baseline: { tradeCount: 0, checkedTrades: 0 },
    truncated: { tradeCount: 0, checkedTrades: 0 },
    corrupted: { tradeCount: 0, checkedTrades: 0 },
    differences: [],
    limitations: ["ONLY_CLOSED_PRE_CUT_TRADES_AUDITED", "OPEN_POSITION_ENTRY_INVARIANCE_REQUIRES_SIGNAL_LEVEL_AUDIT"],
  };

  const pre = validateHistoricalDataset(dataset);
  if (pre.length > 0) {
    result.reasons = pre;
    return result;
  }

  // Titik potong: tengah jendela OOS, selaras interval bar. Harus ada ruang
  // di kedua sisi supaya audit bermakna (minimal 1 trigger keputusan).
  const intervalMs = dataset.intervalMs;
  const mid = Math.floor((dataset.outOfSampleFrom + dataset.outOfSampleTo) / 2 / intervalMs) * intervalMs;
  if (mid <= dataset.outOfSampleFrom || mid >= dataset.outOfSampleTo) {
    result.reasons.push("OOS_WINDOW_TOO_SHORT_FOR_AUDIT");
    return result;
  }
  result.cutTime = mid;

  // ── Baseline: replay penuh ──────────────────────────────────────────────
  const baselineOut = replayFn(dataset, options);
  const baselineTrades = tradesBefore(baselineOut, mid);
  result.baseline = { tradeCount: baselineOut.trades.length, checkedTrades: baselineTrades.length };
  if (baselineOut.errors.length > 0) {
    result.reasons.push(...baselineOut.errors);
    return result;
  }
  if (baselineTrades.length === 0) {
    result.reasons.push("NO_TRADES_BEFORE_CUT_NOTHING_TO_AUDIT");
    return result;
  }

  // ── Eksperimen 1: TRUNCATED — dataset berakhir di titik potong ─────────
  const truncated = cloneDataset(dataset);
  truncated.bars = truncated.bars.filter((b) => b.openTime + intervalMs <= mid);
  truncated.funding = truncated.funding.filter((f) => f.time < mid);
  truncated.outOfSampleTo = mid;
  truncated.fundingCoverage = { ...truncated.fundingCoverage, to: Math.max(dataset.fundingCoverage.to, mid) };
  // fundingCoverage.from tetap dari dataset (harus <= outOfSampleFrom, tidak berubah).
  const truncOut = replayFn(truncated, options);
  const truncTrades = tradesBefore(truncOut, mid);
  result.truncated = { tradeCount: truncOut.trades.length, checkedTrades: truncTrades.length };
  if (truncOut.errors.length > 0) result.reasons.push("TRUNCATED_REPLAY_ERRORS:" + truncOut.errors.join(","));
  result.differences.push(...diffTrades("TRUNCATED", baselineTrades, truncTrades, mid));

  // ── Eksperimen 2: CORRUPTED — masa depan dirusak, masa lalu wajib beku ──
  const corrupted = cloneDataset(dataset);
  for (let i = 0; i < corrupted.bars.length; i++) {
    const b = corrupted.bars[i]!;
    if (b.openTime + intervalMs > mid) {
      // Tetap OHLC-valid (high >= open/close/low) supaya validator tidak
      // menolak dataset — kerusakan inilah justru yang dites tembus atau tidak.
      corrupted.bars[i] = { ...b, open: 1e9, high: 1e9, low: 1e9, close: 1e9, volume: 0 };
    }
  }
  for (let i = 0; i < corrupted.funding.length; i++) {
    const f = corrupted.funding[i]!;
    if (f.time >= mid) corrupted.funding[i] = { ...f, rate: 1, markPrice: 1e9 };
  }
  const corrOut = replayFn(corrupted, options);
  const corrTrades = tradesBefore(corrOut, mid);
  result.corrupted = { tradeCount: corrOut.trades.length, checkedTrades: corrTrades.length };
  if (corrOut.errors.length > 0) result.reasons.push("CORRUPTED_REPLAY_ERRORS:" + corrOut.errors.join(","));
  result.differences.push(...diffTrades("CORRUPTED", baselineTrades, corrTrades, mid));

  result.passed =
    result.reasons.length === 0 &&
    result.differences.length === 0 &&
    corrTrades.length === baselineTrades.length;
  return result;
}
