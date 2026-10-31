// AI ANALYSIS (checklist 2026-10-03 T-16): laporan harian artefak.
// Semua angka datang dari perhitungan TS (bukan LLM); markdown hanya menyusun ulang.
import type { StrategyStat } from "../learning/researchBrief.js";
import { totalStat } from "../learning/researchBrief.js";
import type { MetricAlert } from "../analytics/metricsRegistry.js";
import { EXECUTION_MISTAKES, MISTAKE_THRESHOLDS, STANDARD_EXIT_REASONS, TARGET_RISK_BASELINE_USD } from "../learning/executionMistakes.js";

export interface AppliedParamLine {
  param: string;
  strategyId: string;
  value: number;
  version: string;
}

// ── SMB T-02 (9 Okt 2026): Process & Execution Report Card ──
// Skor disiplin PROSES 100% deterministik dari baris jurnal (kolom
// executionMistake LearningEntry). LLM tidak menghitung apa pun di sini.
export interface ProcessCardTrade {
  tradeId: number | null;
  symbol: string;
  executionMistake: string;
  isExecutionMistake: boolean;
  closeReason: string | null;
  riskUsd: number;
  plannedSlPrice: number | null;
  executedSlPrice: number | null;
}

export interface ProcessCardInput {
  trades: ProcessCardTrade[];
  targetRiskUsd?: number;
  /** Jumlah event RULE_FRICTION hari itu (pelanggaran aturan playbook APPROVED). */
  frictionEventsToday?: number;
  /** Ringkasan friction per aturan (format bebas dari formatRuleSummary). */
  frictionLines?: string[];
}

export interface ProcessCardResult {
  total: number;
  mistakes: number;
  mistakeRatePct: number;
  byType: Array<{ code: string; count: number }>;
  slCompliant: number;
  slChecked: number;
  sizingOverTolerance: number;
  nonStandardExits: number;
  frictionEventsToday: number;
  /** % trade tanpa kesalahan eksekusi = ukuran disiplin proses. */
  disciplineScorePct: number;
  verdict: "BERSIH" | "PERHATIAN" | "EVALUASI";
}

export function computeProcessReportCard(input: ProcessCardInput): ProcessCardResult {
  const target = input.targetRiskUsd ?? TARGET_RISK_BASELINE_USD;
  const total = input.trades.length;
  const mistakes = input.trades.filter((t) => t.isExecutionMistake).length;
  const byType = EXECUTION_MISTAKES
    .filter((code) => code !== "MISTAKE_NONE")
    .map((code) => ({ code, count: input.trades.filter((t) => t.executionMistake === code).length }))
    .filter((row) => row.count > 0);
  const slPairs = input.trades.filter((t) => typeof t.plannedSlPrice === "number" && t.plannedSlPrice !== null
    && typeof t.executedSlPrice === "number" && t.executedSlPrice !== null && t.plannedSlPrice > 0);
  const slCompliant = slPairs.filter((t) => Math.abs(t.executedSlPrice! - t.plannedSlPrice!) / t.plannedSlPrice! <= MISTAKE_THRESHOLDS.SL_MOVE_TOL).length;
  const sizingOverTolerance = input.trades.filter((t) => Number.isFinite(t.riskUsd) && target > 0
    && Math.abs(t.riskUsd - target) / target > MISTAKE_THRESHOLDS.SIZING_DEVIATION_TOL).length;
  const nonStandardExits = input.trades.filter((t) => t.closeReason !== null && !STANDARD_EXIT_REASONS.has(String(t.closeReason).toUpperCase())).length;
  const frictionEventsToday = input.frictionEventsToday ?? 0;
  const disciplineScorePct = total > 0 ? ((total - mistakes) / total) * 100 : 100;
  const verdict: ProcessCardResult["verdict"] = mistakes === 0 ? "BERSIH" : disciplineScorePct >= 80 ? "PERHATIAN" : "EVALUASI";
  return { total, mistakes, mistakeRatePct: total > 0 ? (mistakes / total) * 100 : 0, byType, slCompliant, slChecked: slPairs.length, sizingOverTolerance, nonStandardExits, frictionEventsToday, disciplineScorePct, verdict };
}

export function renderProcessReportCard(card: ProcessCardResult, frictionLines: string[] = []): string {
  const lines: string[] = ["## PROCESS & EXECUTION REPORT CARD (SMB)", ""];
  lines.push(`| Metrik | Nilai |`, `|---|---|`);
  lines.push(`| Trade dinilai | ${card.total} |`);
  lines.push(`| Kesalahan eksekusi | ${card.mistakes} (${card.mistakeRatePct.toFixed(1)}%) |`);
  lines.push(`| Kepatuhan SL (plan vs eksekusi) | ${card.slChecked > 0 ? `${card.slCompliant}/${card.slChecked}` : "n/a"} |`);
  lines.push(`| Deviasi sizing > ${MISTAKE_THRESHOLDS.SIZING_DEVIATION_TOL * 100}% dari baseline | ${card.sizingOverTolerance} |`);
  lines.push(`| Exit di luar aturan baku (SL/TP/TREND_FLIP) | ${card.nonStandardExits} |`);
  lines.push(`| Pelanggaran aturan playbook (RULE_FRICTION) | ${card.frictionEventsToday} |`);
  lines.push(`| Skor disiplin proses | ${card.disciplineScorePct.toFixed(1)}% — ${card.verdict} |`);
  if (card.byType.length) {
    lines.push("", "Rincian kesalahan:", "");
    for (const row of card.byType) lines.push(`- ${row.code}: ${row.count}`);
  }
  if (frictionLines.length) {
    lines.push("", "Friction aturan APPROVED:", "", ...frictionLines);
  }
  lines.push("", "> Angka deterministik (TS) dari kolom executionMistake jurnal; kesalahan pasar (causeCode) dilaporkan terpisah.");
  return lines.join("\n");
}

export interface ReportInput {
  stats: StrategyStat[];
  alerts: MetricAlert[];
  appliedParams: AppliedParamLine[];
  now: string;
  /** SMB T-02: section report card opsional (dirender bila diberikan). */
  processReportCard?: string | null;
}

export function buildDailyReport(input: ReportInput): string {
  const day = input.now.slice(0, 10);
  const lines: string[] = [`# Laporan Harian ArtaTrade ${day}`, ""];
  lines.push("## Statistik per strategi", "", "| Strategi | Trade | WR% | EV/trade | PF |", "|---|---:|---:|---:|---:|");
  // 8 Okt 2026: baris TOTAL gabungan + grouping era-aware di sumber stats.
  for (const s of input.stats.length ? [...input.stats, totalStat(input.stats)] : []) {
    lines.push(`| ${s.strategyId} | ${s.trades} | ${s.winRatePct.toFixed(1)}% | ${s.evUsd.toFixed(4)} | ${s.profitFactor.toFixed(2)} |`);
  }
  lines.push("", "## Alert", "");
  lines.push(input.alerts.length ? input.alerts.map((a) => `- [${a.code}] ${a.message}`).join("\n") : "- (tidak ada alert)");
  lines.push("", "## Parameter aktif", "");
  lines.push(input.appliedParams.length
    ? input.appliedParams.map((p) => `- ${p.param} = ${p.value} (${p.strategyId}, versi ${p.version})`).join("\n")
    : "- (tidak ada)");
  if (input.processReportCard) {
    lines.push("", input.processReportCard);
  }
  lines.push("", "> Angka deterministik (TS). LLM tidak menghitung nominal uang (Golden Rules #1).", "");
  return lines.join("\n");
}

export function reportFileName(now: string): string {
  return `report-${now.slice(0, 10)}.md`;
}

// ── 11 Okt 2026 — Laporan tripwire loss LIVE (perintah operator: "kalau ... loss 1x
// langsung berhenti trading dan kirimkan laporan nya"). Semua angka dihitung TS dari
// baris trade yang diterima; markdown hanya menyusun ulang (Golden Rules #1). ──
export interface LossStopTradeRow {
  symbol?: string;
  side?: string;
  pnlUsd: number;
  rMultiple?: number | null;
  source?: string | null;
}

export interface LossStopReportInput {
  nowIso: string;
  trigger: "LIVE_LOSS_TRIPWIRE" | "DAILY_DD_CAP";
  dailyPnlUsd: number;
  losses: LossStopTradeRow[];
  todayCount: number;
}

export function buildLossStopReport(input: LossStopReportInput): string {
  const lossSum = input.losses.reduce((acc, t) => acc + t.pnlUsd, 0);
  const lines: string[] = [
    `# Laporan STOP — Trading LIVE Dihentikan (${input.trigger})`,
    "",
    `- Waktu: ${input.nowIso}`,
    `- Pemicu: ${input.trigger === "LIVE_LOSS_TRIPWIRE"
      ? "1x loss pada trade LIVE (perintah operator 11 Okt 2026: loss 1x = berhenti + laporan)"
      : "cap drawdown harian tercapai"}`,
    `- Trade tertutup hari ini: ${input.todayCount}`,
    `- PnL hari ini: $${input.dailyPnlUsd.toFixed(4)}`,
    `- Jumlah loss pemicu: ${input.losses.length} (total $${lossSum.toFixed(4)})`,
    "- Status ARM: OFF (auto-disarm) — balas ARM kembali setelah lo review laporan ini.",
    "",
    "## Loss pemicu",
    "",
    "| Symbol | Side | PnL $ | R | Sumber |",
    "|---|---|---:|---:|---|",
  ];
  for (const t of input.losses) {
    lines.push(`| ${t.symbol ?? "?"} | ${t.side ?? "?"} | ${t.pnlUsd.toFixed(4)} | ${t.rMultiple == null ? "?" : t.rMultiple.toFixed(3)} | ${t.source ?? "?"} |`);
  }
  lines.push(
    "",
    "> Angka deterministik (TS). LLM tidak menghitung nominal uang (Golden Rules #1).",
    "",
  );
  return lines.join("\n");
}
