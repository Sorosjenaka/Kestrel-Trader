// apps/server/src/agents/quickAnalysts.ts
// ANALISIS CEPAT PARALEL (27 Okt 2026, permintaan operator: "tambahin lagi
// beberapa agar bisa bekerja dengan cepat analisisnya dikarenakan itu tugas
// berat"). Satu callReason besar (lama, rawan terpotong) DIPECAH menjadi TIGA
// callFast kecil yang berjalan PARALEL, masing-masing dengan persona katalog:
//   - Sari (market-context)  -> Ringkasan Pasar
//   - Tala (signal-analyst)  -> Evaluasi Sinyal 24 jam
//   - Giri (funnel-analyst)  -> Evaluasi Kualitas Funnel
// Semua READ-ONLY (Golden Rule #1), fail-open total, output pendek (maks 8
// baris) supaya tidak pernah kena truncation. Bukti tiap agen ditulis sebagai
// AGENT_DIALOG miliknya sendiri (kartu dashboard) + satu EventLog
// LLM_QUICK_ANALYSIS gabungan.
import { defaultLlmAdapter, type XkiroAdapter } from "./llmAdapter.js";
import { ALL_12_AGENTS } from "./agentCatalog.js";
import { buildMicrostructureSummary, type MarketContextSnapshot } from "./marketIntel.js";
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

export const QUICK_ANALYSIS_EVENT_TYPE = "LLM_QUICK_ANALYSIS";

/** Subset data yang dibutuhkan analis cepat — struktur sama dengan AnalystSnapshot. */
export interface QuickAnalysisInput {
  dayKey: string;
  swingSignals: { decision: string; strategyId: string; symbol: string; createdAt: Date }[];
  swingSignalsTotal?: number;
  openPositions: { symbol: string; side: string; strategyId: string | null; entryPrice: number; openedAt: Date }[];
  recentTrades: { symbol: string; pnlUsd: number; rMultiple: number | null; strategyId: string | null; closeReason: string | null; createdAt: Date }[];
  marketIntel?: MarketContextSnapshot;
}

export interface QuickAnalysisSection {
  agentId: "market-context" | "signal-analyst" | "funnel-analyst";
  title: string;
  text: string;
  byLlm: boolean;
}

export interface QuickAnalysisResult {
  sections: QuickAnalysisSection[];
  allByLlm: boolean;
}

const MAX_LINES = 8;
const clampText = (t: string): string => t.trim().split("\n").slice(0, MAX_LINES).join("\n");

function decisionCounts(signals: QuickAnalysisInput["swingSignals"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of signals) counts[s.decision] = (counts[s.decision] ?? 0) + 1;
  return counts;
}

// ── Prompt builder per analis (murni fungsi, kecil, mudah dites) ─────────────

export function buildMarketContextPrompt(s: QuickAnalysisInput): string {
  const intel = s.marketIntel
    ? JSON.stringify({
        regime: s.marketIntel.regime,
        breadth_1h: s.marketIntel.breadth_1h,
        breadth_24h: s.marketIntel.breadth,
        btc_relative_strength: s.marketIntel.btc_relative_strength,
        liquidity: s.marketIntel.liquidity,
        data_quality: s.marketIntel.data_quality,
      })
    : "(market intelligence tidak tersedia)";
  const micro = s.marketIntel ? buildMicrostructureSummary(s.marketIntel.microstructure_and_flow) : "(mikrostruktur tidak tersedia)";
  return [
    `Data ${new Date().toISOString()} (dayKey ${s.dayKey}):`,
    `Market Intelligence: ${intel}`,
    `Mikrostruktur & order flow: ${micro}`,
    `Instruksi: tulis RINGKASAN PASAR (regime, breadth, likuiditas, aliran dana) maksimal 8 baris,`,
    `setiap klaim wajib berbasis angka di atas. Format bebas, tanpa template, tanpa emoji.`,
  ].join("\n");
}

export function buildSignalPrompt(s: QuickAnalysisInput): string {
  const total = s.swingSignalsTotal ?? s.swingSignals.length;
  const rows = s.swingSignals.length > 0
    ? s.swingSignals.map((x) => `- ${x.createdAt.toISOString()} ${x.symbol} ${x.strategyId} ${x.decision}`).join("\n")
    : "(tidak ada sinyal 24 jam)";
  return [
    `Sinyal SWING 24 jam (total ${total}, ${s.swingSignals.length} terbaru):`,
    rows,
    `Distribusi keputusan: ${JSON.stringify(decisionCounts(s.swingSignals))}`,
    `Instruksi: tulis EVALUASI SINYAL (pola keputusan, kualitas kandidat) maksimal 8 baris berbasis angka di atas.`,
  ].join("\n");
}

export function buildFunnelPrompt(s: QuickAnalysisInput): string {
  const pos = s.openPositions.length > 0
    ? s.openPositions.map((p) => `- ${p.symbol} ${p.side} ${p.strategyId ?? "?"} entry ${p.entryPrice}`).join("\n")
    : "(tidak ada posisi open)";
  const pnl = s.recentTrades.reduce((a, t) => a + t.pnlUsd, 0);
  return [
    `Posisi open (${s.openPositions.length}):`,
    pos,
    `Ringkasan funnel: ${JSON.stringify(decisionCounts(s.swingSignals))} dari ${s.swingSignalsTotal ?? s.swingSignals.length} sinyal 24 jam; PnL ${s.recentTrades.length} trade terakhir $${pnl.toFixed(2)}.`,
    `Instruksi: tulis EVALUASI KUALITAS FUNNEL (gate mana yang menyaring, ada penyumbatan atau tidak)`,
    `maksimal 8 baris berbasis angka di atas.`,
  ].join("\n");
}

/** Ringkasan deterministik per analis saat LLM gagal (byLlm=false jujur). */
export function quickFallback(agentId: QuickAnalysisSection["agentId"], s: QuickAnalysisInput): string {
  const counts = decisionCounts(s.swingSignals);
  if (agentId === "market-context") {
    return `Fallback Sari: regime ${s.marketIntel?.regime ?? "UNKNOWN"}, breadth 1j ${s.marketIntel?.breadth_1h ?? "n/a"}. (LLM tidak tersedia.)`;
  }
  if (agentId === "signal-analyst") {
    return `Fallback Tala: ${s.swingSignalsTotal ?? s.swingSignals.length} sinyal 24 jam, distribusi ${JSON.stringify(counts)}. (LLM tidak tersedia.)`;
  }
  return `Fallback Giri: ${s.openPositions.length} posisi open, funnel ${JSON.stringify(counts)}. (LLM tidak tersedia.)`;
}

// ── Orkestrasi paralel ──────────────────────────────────────────────────────

const SPEC: { agentId: QuickAnalysisSection["agentId"]; title: string; build: (s: QuickAnalysisInput) => string }[] = [
  { agentId: "market-context", title: "Ringkasan Pasar", build: buildMarketContextPrompt },
  { agentId: "signal-analyst", title: "Evaluasi Sinyal", build: buildSignalPrompt },
  { agentId: "funnel-analyst", title: "Evaluasi Kualitas Funnel", build: buildFunnelPrompt },
];

/**
 * Tiga analis berjalan PARALEL (kunci kecepatan: wall-clock = 1 call, bukan 3).
 * Fail-open per analis: satu gagal tidak menggugurkan yang lain.
 */
export async function runQuickAnalysisTriplet(
  s: QuickAnalysisInput,
  adapter: XkiroAdapter = defaultLlmAdapter,
): Promise<QuickAnalysisResult> {
  const sections = await Promise.all(SPEC.map(async ({ agentId, title, build }): Promise<QuickAnalysisSection> => {
    const profile = ALL_12_AGENTS[agentId];
    const system = `Anda ${profile?.name ?? agentId} (${agentId}), ${profile?.role ?? "analis cepat"} di tim Private Trade AI. ` +
      `Kepribadian: ${profile?.personality ?? "ringkas"}. Tulis Bahasa Indonesia, tanpa emoji, maksimal ${MAX_LINES} baris, setiap klaim berbasis angka yang diberikan.`;
    let text = "";
    let byLlm = false;
    try {
      const res = await adapter.callFast(build(s), system, {
        maxTokens: 600,
        timeoutMs: 20_000,
        queuePriority: "normal",
        queueDeadlineMs: 60_000,
      });
      text = clampText(res.content);
      byLlm = text.length > 0;
    } catch (err) {
      logger.warn({ agentId, err: (err as Error)?.message }, "QUICK_ANALYSIS_FAIL");
    }
    if (!byLlm) text = quickFallback(agentId, s);
    return { agentId, title, text, byLlm };
  }));

  // Bukti kartu agen: satu AGENT_DIALOG per analis.
  for (const sec of sections) {
    const profile = ALL_12_AGENTS[sec.agentId];
    await db.eventLog.create({
      data: {
        type: "AGENT_DIALOG",
        severity: "info",
        payload: JSON.stringify({
          agentId: sec.agentId,
          name: profile?.name ?? sec.agentId,
          text: sec.text.slice(0, 600),
          timestamp: new Date().toISOString(),
          context: { kind: "quick_analysis", byLlm: sec.byLlm, dayKey: s.dayKey },
        }),
      },
    }).catch(() => undefined);
  }
  await db.eventLog.create({
    data: {
      type: QUICK_ANALYSIS_EVENT_TYPE,
      severity: "info",
      payload: JSON.stringify({
        dayKey: s.dayKey,
        byLlm: sections.filter((x) => x.byLlm).length,
        total: sections.length,
        signals: s.swingSignals.length,
        positions: s.openPositions.length,
      }),
    },
  }).catch(() => undefined);

  return { sections, allByLlm: sections.every((x) => x.byLlm) };
}
