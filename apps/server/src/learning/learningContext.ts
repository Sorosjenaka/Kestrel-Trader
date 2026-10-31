import type { SetupMode } from "../config/setupEngine.js";

export interface EntryLearningSnapshot {
  symbol: string;
  mode: SetupMode;
  features: number[];
}

export function learningModeOf(mode: unknown): SetupMode | null {
  return mode === "SCALP" || mode === "SWING" ? mode : null;
}

/** A later entry in the same symbol must never label an earlier trade. */
export function resolvedEntrySnapshot(
  pending: ReadonlyMap<number, EntryLearningSnapshot>,
  trade: { positionId: number | null; symbol: string; mode: unknown },
): EntryLearningSnapshot | null {
  if (trade.positionId === null) return null;
  const entry = pending.get(trade.positionId);
  if (!entry || entry.symbol !== trade.symbol.toUpperCase() || entry.mode !== learningModeOf(trade.mode)
    || entry.features.length !== 5 || !entry.features.every(Number.isFinite)) return null;
  return entry;
}

/** Cooldown deadline belongs to the close event, not the current scan time. */
export function swingCooldownDeadline(closedAt: Date | null, nowMs: number, durationMs = 24 * 3_600_000): number | null {
  const at = closedAt?.getTime();
  if (at === undefined || !Number.isFinite(at) || at > nowMs) return null;
  const deadline = at + durationMs;
  return deadline > nowMs ? deadline : null;
}
