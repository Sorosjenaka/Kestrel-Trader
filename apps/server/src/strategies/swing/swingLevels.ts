/** Shared ladder geometry, based on the actual tick-rounded first target. */
export function swingLadderLevelsFromTp1(side: "LONG" | "SHORT", entry: number, tp1: number, rr23 = false): { tp2: number; tpMax: number } {
  const offset = Math.abs(tp1 - entry);
  const sign = side === "LONG" ? 1 : -1;
  return rr23 ? { tp2: entry + sign * 1.5 * offset, tpMax: entry + sign * 1.5 * offset }
    : { tp2: entry + sign * 2 * offset, tpMax: entry + sign * 3 * offset };
}
