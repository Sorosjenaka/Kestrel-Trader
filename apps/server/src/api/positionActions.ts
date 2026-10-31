import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { defaultPositionSupervisor } from "../exec/positionSupervisor.js";

export function liveAccountMutationBlocked(): boolean {
  return env.BINANCE_EXECUTION_MODE === "LIVE" || process.env.BINANCE_EXECUTION_MODE === "LIVE";
}

/** The browser cannot assert fills or prices. Only confirmed PAPER exits count. */
export async function closePaperPositions(positionIds?: number[]) {
  if (liveAccountMutationBlocked()) throw new Error("LIVE_ACCOUNT_MUTATIONS_BLOCKED");
  const positions = await db.position.findMany({
    where: { status: "OPEN", ...(positionIds ? { id: { in: positionIds } } : {}) },
  });
  const { map } = binanceFuturesClient.getHubPrices(positions.map(p => p.symbol));
  const failures: Array<{ positionId: number; reason: string }> = [];
  for (const pos of positions) {
    if (String(pos.source).startsWith("LIVE")) {
      failures.push({ positionId: pos.id, reason: "LIVE_ACCOUNT_MUTATIONS_BLOCKED" });
      continue;
    }
    const quote = map[pos.symbol];
    if (!quote || !Number.isFinite(quote.m) || quote.m <= 0 || Date.now() - quote.t > 30_000 || quote.t > Date.now() + 1000) {
      failures.push({ positionId: pos.id, reason: "FRESH_FUTURES_MARK_REQUIRED" });
      continue;
    }
    try { await defaultPositionSupervisor.emergencyKill(pos.id, quote.m); }
    catch { failures.push({ positionId: pos.id, reason: "EXIT_EXECUTION_FAILED" }); }
  }
  const remainingPositions = await db.position.findMany({
    where: { status: "OPEN", ...(positionIds ? { id: { in: positionIds } } : {}) },
    select: { id: true, symbol: true, qty: true },
  });
  return { ok: remainingPositions.length === 0, closedPositionsCount: positions.length - remainingPositions.length,
    remainingPositions, failures };
}
