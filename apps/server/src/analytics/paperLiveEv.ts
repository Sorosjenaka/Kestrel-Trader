// apps/server/src/analytics/paperLiveEv.ts — T-04 / CP-2 (19 Okt 2026).
//
// Tujuan (PLAN_KOMPARASI item 1.3): validasi fidelity paper — EV NET paper
// dibandingkan EV NET live, target selisih <= 0.1R. Modul ini MURNI: menerima
// baris Trade + OrderExec yang sudah dibaca loader, tidak menyentuh DB,
// jaringan, LLM, maupun jalur trading.
//
// Definisi angka (jangan diubah tanpa audit):
//   venue PAPER/LIVE ditentukan dari OrderExec: ada order non-simulated
//     (binanceOrderId nyata) => LIVE; semua order simulated => PAPER.
//     Fallback (posisi legacy tanpa order): accountingQuality SIMULATED /
//     source PAPER_AI => PAPER; source LIVE_AI => LIVE; selain itu UNKNOWN.
//   EV = rata-rata NET R per trade, NET R = Trade.pnlUsd / (riskBudgetUsd ??
//     riskUsd). Trade.pnlUsd SUDAH net fee (lihat positionSupervisor baris ~792),
//     funding terpisah di fundingUsd (paper belum memodelkan funding — TIER 1.1).
//   Fee coverage: trade dengan feeUsd <= 0 TIDAK dipakai untuk verdict karena
//     NET-nya overstated (paper pra-18 Okt mencatat fee 0). Trade seperti itu
//     tetap dilaporkan sebagai diagnostik, bukan bukti.
//   Sampel: verdict definitif butuh >= 500 trade fee-covered per venue
//     (lantai roadmap CP-2). Di bawah itu verdict WAJIB INCONCLUSIVE —
//     gate tidak boleh dilonggarkan demi angka.
import type { FindingVerdict } from "../learning/researchFinding.js";

export type Venue = "PAPER" | "LIVE" | "UNKNOWN";

export interface OrderLite {
  simulated: boolean;
  binanceOrderId: string | null;
}

export interface ClosedTradeLite {
  id: number;
  symbol: string;
  mode: string;
  side: string;
  strategyId: string | null;
  source: string | null;
  accountingQuality: string;
  pnlUsd: number;
  feeUsd: number;
  fundingUsd: number;
  riskUsd: number;
  riskBudgetUsd: number | null;
  rMultiple: number;
  win: boolean;
  createdAt: number;
  orders: OrderLite[];
}

export interface ClassifiedTrade extends ClosedTradeLite {
  venue: Venue;
  exclusion: "DEMO" | "MANUAL" | null;
  /** NET R = pnlUsd / budget; null bila denominator tidak valid. */
  netR: number | null;
  feeCovered: boolean;
}

export interface VenueStats {
  n: number;
  nMissingNetR: number;
  nFeeCovered: number;
  meanNetR: number | null;
  sdNetR: number | null;
  seNetR: number | null;
  medianNetR: number | null;
  wrPct: number | null;
  sumFeeUsd: number;
  sumFundingUsd: number;
}

export interface ComparisonOptions {
  /** Toleransi selisih EV paper vs live dalam R (default 0.1 sesuai item 1.3). */
  toleranceR?: number;
  /** Lantai sampel per venue untuk verdict definitif (default 500). */
  minSamples?: number;
  /** Z untuk interval kepercayaan 95%. */
  z?: number;
}

export type FidelityVerdict = "WITHIN_TOLERANCE" | "DEVIATION" | "INCONCLUSIVE";

export interface ComparisonResult {
  toleranceR: number;
  minSamples: number;
  paper: VenueStats;
  live: VenueStats;
  /** Statistik semua baris (termasuk yang fee-nya tidak tercatat) — diagnostik. */
  paperAsRecorded: VenueStats;
  liveAsRecorded: VenueStats;
  deltaR: number | null;
  ci95: [number, number] | null;
  verdict: FidelityVerdict;
  reasons: string[];
}

const DEFAULT_TOLERANCE_R = 0.1;
const DEFAULT_MIN_SAMPLES = 500;
const Z95 = 1.96;

/** Klasifikasi venue berbasis bukti OrderExec, bukan label source semata. */
export function classifyVenue(row: ClosedTradeLite): Venue {
  const realOrders = row.orders.filter(
    (o) => o.simulated === false || (o.binanceOrderId != null && !o.binanceOrderId.startsWith("SIM_")),
  );
  if (row.orders.length > 0) return realOrders.length > 0 ? "LIVE" : "PAPER";
  if (row.accountingQuality === "SIMULATED") return "PAPER";
  if (row.source === "PAPER_AI") return "PAPER";
  if (row.source === "LIVE_AI") return "LIVE";
  return "UNKNOWN";
}

export function classifyTrade(row: ClosedTradeLite): ClassifiedTrade {
  const exclusion = row.source === "DEMO" ? "DEMO" : row.source === "MANUAL" ? "MANUAL" : null;
  const budget = row.riskBudgetUsd != null && Number.isFinite(row.riskBudgetUsd) && row.riskBudgetUsd > 0
    ? row.riskBudgetUsd
    : row.riskUsd;
  const netR = Number.isFinite(row.pnlUsd) && Number.isFinite(budget) && budget > 0
    ? row.pnlUsd / budget
    : null;
  return {
    ...row,
    venue: classifyVenue(row),
    exclusion,
    netR,
    feeCovered: Number.isFinite(row.feeUsd) && row.feeUsd > 0,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summarize(rows: ClassifiedTrade[]): VenueStats {
  const withR = rows.filter((r) => r.netR != null);
  const values = withR.map((r) => r.netR as number);
  const wins = withR.filter((r) => r.win || rowWon(r)).length;
  const m = mean(values);
  const sd = sampleSd(values);
  return {
    n: rows.length,
    nMissingNetR: rows.length - withR.length,
    nFeeCovered: rows.filter((r) => r.feeCovered).length,
    meanNetR: m,
    sdNetR: sd,
    seNetR: sd != null && values.length > 0 ? sd / Math.sqrt(values.length) : null,
    medianNetR: median(values),
    wrPct: values.length > 0 ? (wins / values.length) * 100 : null,
    sumFeeUsd: rows.reduce((s, r) => s + (Number.isFinite(r.feeUsd) ? r.feeUsd : 0), 0),
    sumFundingUsd: rows.reduce((s, r) => s + (Number.isFinite(r.fundingUsd) ? r.fundingUsd : 0), 0),
  };
}

function rowWon(r: ClosedTradeLite): boolean {
  return r.pnlUsd > 0;
}

/** Filter yang dipakai untuk verdict: venue cocok, bukan DEMO/MANUAL, fee tercatat, NET R valid. */
export function evidenceRows(rows: ClassifiedTrade[], venue: "PAPER" | "LIVE"): ClassifiedTrade[] {
  return rows.filter(
    (r) => r.venue === venue && r.exclusion == null && r.feeCovered && r.netR != null,
  );
}

export function comparePaperLive(
  rows: ClassifiedTrade[],
  options: ComparisonOptions = {},
): ComparisonResult {
  const toleranceR = options.toleranceR ?? DEFAULT_TOLERANCE_R;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const z = options.z ?? Z95;

  const paperRows = rows.filter((r) => r.venue === "PAPER" && r.exclusion == null);
  const liveRows = rows.filter((r) => r.venue === "LIVE" && r.exclusion == null);
  const paperEvidence = evidenceRows(rows, "PAPER");
  const liveEvidence = evidenceRows(rows, "LIVE");

  const paper = summarize(paperEvidence);
  const live = summarize(liveEvidence);
  const reasons: string[] = [];

  let deltaR: number | null = null;
  let ci95: [number, number] | null = null;
  if (paper.meanNetR != null && live.meanNetR != null) {
    deltaR = paper.meanNetR - live.meanNetR;
    const seDelta = Math.sqrt((paper.seNetR ?? 0) ** 2 + (live.seNetR ?? 0) ** 2);
    ci95 = [deltaR - z * seDelta, deltaR + z * seDelta];
  }

  if (paper.n < minSamples) reasons.push(`SAMPLE_FLOOR_PAPER (${paper.n}/${minSamples} fee-covered)`);
  if (live.n < minSamples) reasons.push(`SAMPLE_FLOOR_LIVE (${live.n}/${minSamples} fee-covered)`);

  let verdict: FidelityVerdict;
  if (deltaR == null) {
    verdict = "INCONCLUSIVE";
    reasons.push("DELTA_TIDAK_TERHITUNG (EV salah satu venue kosong)");
  } else if (paper.n < minSamples || live.n < minSamples) {
    verdict = "INCONCLUSIVE";
  } else {
    const absDelta = Math.abs(deltaR);
    const seDelta = Math.sqrt((paper.seNetR ?? 0) ** 2 + (live.seNetR ?? 0) ** 2);
    if (absDelta + z * seDelta <= toleranceR) {
      verdict = "WITHIN_TOLERANCE";
    } else if (absDelta - z * seDelta > toleranceR) {
      verdict = "DEVIATION";
    } else {
      verdict = "INCONCLUSIVE";
      reasons.push("CI95_MELINTASI_TOLERANSI");
    }
  }

  return {
    toleranceR,
    minSamples,
    paper,
    live,
    paperAsRecorded: summarize(paperRows),
    liveAsRecorded: summarize(liveRows),
    deltaR,
    ci95,
    verdict,
    reasons,
  };
}

/** Pemetaan verdict fidelity -> verdict jurnal ResearchFinding. */
export function toFindingVerdict(v: FidelityVerdict): FindingVerdict {
  if (v === "WITHIN_TOLERANCE") return "SUPPORTIVE";
  if (v === "DEVIATION") return "REFUTED";
  return "INCONCLUSIVE";
}

export interface StrategyComparison {
  strategyId: string;
  paper: VenueStats;
  live: VenueStats;
  deltaR: number | null;
}

/** Breakdown per strategi (fee-covered, bukan DEMO/MANUAL) supaya mix tidak menipu. */
export function compareByStrategy(rows: ClassifiedTrade[]): StrategyComparison[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.exclusion == null && (r.venue === "PAPER" || r.venue === "LIVE")) {
      ids.add(r.strategyId ?? "TANPA_STRATEGI");
    }
  }
  return [...ids].sort().map((strategyId) => {
    const subset = rows.filter((r) => r.exclusion == null && (r.strategyId ?? "TANPA_STRATEGI") === strategyId);
    const paper = summarize(evidenceRows(subset, "PAPER"));
    const live = summarize(evidenceRows(subset, "LIVE"));
    return {
      strategyId,
      paper,
      live,
      deltaR: paper.meanNetR != null && live.meanNetR != null ? paper.meanNetR - live.meanNetR : null,
    };
  });
}
