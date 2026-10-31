// AI ANALYSIS (checklist 2026-10-03 T-15): allowlist tool BACA-SAJA untuk agen.
// Tidak ada tool yang menulis state, mengirim order, atau menyentuh parameter
// (Golden Rules #3, #9) — agen hanya membaca, keputusan tetap di kode deterministik.
import { db } from "../core/db.js";

export interface AgentTool {
  description: string;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

const FORBIDDEN_SUBSTRINGS = ["order", "arm", "kill", "parameter"];

export function isForbiddenToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((bad) => lower.includes(bad));
}

export const AGENT_TOOLS: Record<string, AgentTool> = {
  queryStats: {
    description: "Statistik agregat trade tertutup per strategi (jumlah, win, PnL). Baca-saja.",
    invoke: async (args) => {
      const strategyId = typeof args.strategyId === "string" ? args.strategyId : undefined;
      const where = strategyId ? { strategyId, source: { not: "DEMO" } } : { source: { not: "DEMO" } };
      const rows = await db.trade.findMany({ where, select: { pnlUsd: true, win: true, strategyId: true }, take: 500 });
      return { count: rows.length, wins: rows.filter((r) => r.win).length, pnlUsdSum: rows.reduce((a, r) => a + r.pnlUsd, 0) };
    },
  },
  getLearningEntries: {
    description: "Membaca LearningEntry terbaru (post-mortem). Baca-saja.",
    invoke: async (args) => {
      const take = Math.min(Number(args.limit) || 20, 100);
      return db.learningEntry.findMany({ orderBy: { createdAt: "desc" }, take });
    },
  },
  getKlines: {
    description: "Membaca candle terakhir dari cache market data. Baca-saja.",
    invoke: async (args) => {
      const symbol = typeof args.symbol === "string" ? args.symbol.toUpperCase() : "";
      return { symbol, note: "READ_ONLY_PLACEHOLDER: klines diambil lewat marketDataCache, bukan lewat tool agen." };
    },
  },
};

export function listAgentTools(): { name: string; description: string }[] {
  return Object.entries(AGENT_TOOLS).map(([name, t]) => ({ name, description: t.description }));
}
