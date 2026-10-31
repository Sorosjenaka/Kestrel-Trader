/** Operator policy 17 Oct 2026. Versioned on new PAPER and LIVE entries. */
export const SWING_RR23_POLICY = "SWING_50_2R_BE_50_3R_V1";
export const SWING_RR23 = Object.freeze({ tp1R: 2, tp2R: 3, tp1Frac: 0.5, tp2Frac: 0.5 });

export interface ExitPolicyPosition { mode?: string; source?: string | null; entryAttrs?: string | null }

/**
 * RR23 applies to a versioned NEW SWING entry (PAPER or LIVE). Legacy positions
 * without the marker stay on their original ladder; do not infer the policy
 * from a source label alone.
 */
export function usesSwingRr23(pos: ExitPolicyPosition): boolean {
  if (pos.mode !== "SWING") return false;
  if (!/^(PAPER|LIVE_)/.test(String(pos.source ?? ""))) return false;
  try { return JSON.parse(pos.entryAttrs ?? "{}").swingExitPolicy === SWING_RR23_POLICY; }
  catch { return false; }
}

export function withSwingRr23Attrs(attrs?: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (attrs) {
    const value = JSON.parse(attrs);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ENTRY_ATTRS");
    parsed = value;
  }
  return JSON.stringify({ ...parsed, swingExitPolicy: SWING_RR23_POLICY });
}
