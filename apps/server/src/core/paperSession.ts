import { db } from "./db.js";
import { env } from "./env.js";

export const PAPER_RESET_KEY = "paperResetAt";

/** Closed trades before this instant remain in the learning archive. */
export async function getPaperResetAt(): Promise<Date | null> {
  if (env.BINANCE_EXECUTION_MODE !== "PAPER") return null;
  const row = await db.setting.findUnique({ where: { key: PAPER_RESET_KEY } });
  if (!row) return null;
  const date = new Date(row.value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function afterPaperReset(resetAt: Date | null): { createdAt?: { gte: Date } } {
  return resetAt ? { createdAt: { gte: resetAt } } : {};
}
