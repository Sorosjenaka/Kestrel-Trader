// apps/server/src/agents/tradeEvaluator.ts
// AGENT BARU (27 Okt 2026): "Mira" (trade-evaluator) — hasil PEMECAHAN beban
// Market Analyst setelah audit terukur (/tmp/analyst-load-audit.log): satu
// prompt analyst memuat 5 tugas output dalam budget 1600 token => 88% panggilan
// (37/42, 7 hari) jatuh ke fallback (byLlm=0, LLM_EMPTY/TRUNCATED_RESPONSE).
// Tugas yang DIPINDAH ke sini: evaluasi hasil trade + loop feedback (5-why) +
// rekomendasi pengamatan. Bagian yang TETAP di marketAnalyst: ringkasan pasar,
// evaluasi sinyal, kualitas funnel, heatmap (Vega).
//
// Peran LLM TIDAK menyentuh keputusan entry/exit (Golden Rule #1). Fail-open
// total: kegagalan LLM/DB tidak pernah melempar error ke bot. Interval + cap
// harian milik sendiri (env LLM_TRADE_EVAL_*), kelas antrean "normal" dengan
// queueDeadline supaya bukti basi tidak dikirim ke provider.
import { promises as fsp } from "node:fs";
import path from "node:path";
import { defaultLlmAdapter, type XkiroAdapter } from "./llmAdapter.js";
import { ALL_12_AGENTS } from "./agentCatalog.js";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

export const TRADE_EVAL_EVENT_TYPE = "LLM_TRADE_EVAL";

/** Input minimal — struktur dipetakan dari AnalystSnapshot tanpa import balik. */
export interface TradeEvalSnapshot {
  dayKey: string;
  recentTrades: {
    symbol: string;
    pnlUsd: number;
    rMultiple: number | null;
    strategyId: string | null;
    closeReason: string | null;
    createdAt: Date;
  }[];
  openPositions?: { symbol: string; side: string; strategyId: string | null; entryPrice: number; openedAt: Date }[];
  briefExcerpt?: string;
}

const TRADE_EVAL_SYSTEM_PROMPT = [
  "Anda adalah Mira (trade-evaluator), Evaluator Hasil Trade & Feedback Loop sistem trading futures kripto ini.",
  "Tugas Anda: mengevaluasi hasil trade (feedback loop), merumuskan hipotesis 5-why mengapa hasil itu terjadi,",
  "dan memberikan rekomendasi pengamatan untuk operator.",
  "Aturan keras:",
  "- Anda ANALIS READ-ONLY: tidak pernah memerintahkan entry/exit, tidak mengubah angka.",
  "- Semua klaim wajib merujuk angka dari data yang diberikan; jika data kurang, katakan kurang.",
  "- Format jawaban Markdown ringkas (maks ~40 baris) dengan bagian:",
  "  Evaluasi Hasil Trade, Riset & Hipotesis (mengapa X terjadi — gagasan 5-why), Rekomendasi Pengamatan.",
].join("\n");

/** Susun prompt evaluasi trade (murni fungsi — mudah dites). */
export function buildTradeEvalPrompt(s: TradeEvalSnapshot): string {
  const trades = s.recentTrades.length > 0
    ? s.recentTrades.map((t) => `- ${t.createdAt.toISOString()} ${t.symbol} ${t.strategyId ?? "?"} PnL $${t.pnlUsd.toFixed(2)} (${t.rMultiple != null ? `${t.rMultiple.toFixed(2)}R` : "R n/a"}${t.closeReason ? `, exit: ${t.closeReason}` : ""})`).join("\n")
    : "(belum ada trade selesai)";
  const pos = s.openPositions && s.openPositions.length > 0
    ? s.openPositions.map((p) => `- ${p.symbol} ${p.side} ${p.strategyId ?? "?"} entry ${p.entryPrice} @ ${p.openedAt.toISOString()}`).join("\n")
    : "(tidak ada posisi open)";
  return [
    `Data per ${new Date().toISOString()} (dayKey ${s.dayKey}):`,
    "",
    "## 15 trade terakhir",
    trades,
    "",
    "## Posisi open (konteks)",
    pos,
    "",
    "## Ringkasan brief harian (TS-deterministik, potongan)",
    s.briefExcerpt || "(brief hari ini belum tersedia)",
  ].join("\n");
}

/** Ringkasan deterministik untuk fallback (byLlm=false jujur). */
export function tradeEvalFallbackSummary(s: TradeEvalSnapshot): string {
  const wins = s.recentTrades.filter((t) => t.pnlUsd > 0).length;
  const losses = s.recentTrades.filter((t) => t.pnlUsd < 0).length;
  const pnl = s.recentTrades.reduce((a, t) => a + t.pnlUsd, 0);
  return `Fallback deterministik Mira: ${s.recentTrades.length} trade terakhir — ${wins} profit, ${losses} loss, PnL $${pnl.toFixed(2)}. Evaluasi 5-why menunggu LLM tersedia.`;
}

export interface TradeEvalCycleResult {
  ran: boolean;
  byLlm: boolean;
  path: string | null;
  reason?: string;
}

/**
 * Satu siklus evaluasi trade oleh Mira. Dipanggil menumpuk siklus analyst,
 * tapi berjalan sendiri (interval + cap harian milik sendiri). Fail-open.
 */
export async function runTradeEvaluatorCycle(
  dayKey: string,
  snapshot: TradeEvalSnapshot,
  adapter: XkiroAdapter = defaultLlmAdapter,
): Promise<TradeEvalCycleResult> {
  if (!env.LLM_TRADE_EVAL_ENABLED) return { ran: false, byLlm: false, path: null, reason: "DISABLED" };
  try {
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
    const [usedToday, lastRow] = await Promise.all([
      db.eventLog.count({
        where: { type: TRADE_EVAL_EVENT_TYPE, createdAt: { gte: dayStart } },
      }).catch(() => 0),
      db.eventLog.findFirst({
        where: { type: TRADE_EVAL_EVENT_TYPE },
        orderBy: { id: "desc" },
        select: { createdAt: true },
      }).catch(() => null),
    ]);
    if (usedToday >= env.LLM_TRADE_EVAL_MAX_DAILY_CALLS) {
      return { ran: false, byLlm: false, path: null, reason: "DAILY_CAP" };
    }
    const intervalMs = env.LLM_TRADE_EVAL_INTERVAL_HOURS * 3_600_000;
    if (lastRow?.createdAt && Date.now() - lastRow.createdAt.getTime() < intervalMs) {
      return { ran: false, byLlm: false, path: null, reason: "INTERVAL" };
    }

    const prompt = buildTradeEvalPrompt(snapshot);
    let text = "";
    let byLlm = false;
    let failureReason: string | null = null;
    try {
      const res = await adapter.callReason(prompt, TRADE_EVAL_SYSTEM_PROMPT, {
        maxTokens: 1600,
        timeoutMs: 45_000,
        queuePriority: "normal",
        queueDeadlineMs: 120_000,
      });
      text = res.content.trim();
      byLlm = text.length > 0;
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }
    if (!byLlm) text = tradeEvalFallbackSummary(snapshot);

    const outPath = path.join(process.cwd(), "data", "research", `trade-eval-${dayKey}.md`);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.appendFile(outPath, [`\n---\n## Evaluasi Trade ${new Date().toISOString()} (byLlm: ${byLlm ? "ya" : "tidak — fallback"})\n\n${text}\n`].join("\n"), "utf8");

    await db.eventLog.create({
      data: {
        type: TRADE_EVAL_EVENT_TYPE,
        severity: "info",
        payload: JSON.stringify({ byLlm, path: outPath, trades: snapshot.recentTrades.length, failureReason }),
      },
    }).catch(() => undefined);

    // Bukti kartu agen di dashboard: Mira menulis AGENT_DIALOG miliknya sendiri.
    const profile = ALL_12_AGENTS["trade-evaluator"];
    await db.eventLog.create({
      data: {
        type: "AGENT_DIALOG",
        severity: "info",
        payload: JSON.stringify({
          agentId: "trade-evaluator",
          name: profile?.name ?? "Mira",
          text: text.slice(0, 600),
          timestamp: new Date().toISOString(),
          context: { kind: "trade_eval", byLlm, path: outPath, trades: snapshot.recentTrades.length },
        }),
      },
    }).catch(() => undefined);

    logger.info({ byLlm, outPath, trades: snapshot.recentTrades.length }, "LLM_TRADE_EVAL_DONE");
    return { ran: true, byLlm, path: outPath };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.info({ reason }, "LLM_TRADE_EVAL_SKIPPED");
    return { ran: false, byLlm: false, path: null, reason };
  }
}
