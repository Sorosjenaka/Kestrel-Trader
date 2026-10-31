// tools/state-check.ts - Ringkasan status DB (untuk laporan operator).
import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });
async function main() {
  const [trades, positions, learnings, params, backtestRuns, backtestTrades, events, orders, digest] = await Promise.all([
    db.trade.count(),
    db.position.count(),
    db.learningEntry.count(),
    db.parameterVersion.count(),
    db.backtestRun.count(),
    db.backtestTrade.count(),
    db.eventLog.count(),
    db.orderExec.count(),
    db.setting.findUnique({ where: { key: "evalDigest" } }),
  ]);
  const d = digest ? JSON.parse(digest.value) : null;
  console.log("=== STATUS DB ===");
  console.log({ trades, positions, orders, learnings, parameterVersions: params, backtestRuns, backtestTrades, events });
  console.log("Digest evaluasi tersimpan:", d ? { totalTrades: d.totalTrades, winRatePct: d.winRatePct, netPnlUsd: d.netPnlUsd, profitFactor: d.profitFactor, avgR: d.avgR, byExitReason: d.byExitReason, byCauseCode: d.byCauseCode } : "TIDAK ADA");
}
main().finally(async () => { await db.$disconnect(); });
