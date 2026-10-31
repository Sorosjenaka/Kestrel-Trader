// apps/server/src/strategies/scalp/scalpCatalog.ts
// Katalog Strategi khusus mode SCALPING (M5).
import { STRATEGY_SPECS, type StrategySpec } from "../strategyCatalog.js";
import { env } from "../../core/env.js";

export const SCALP_STRATEGY_SPECS: StrategySpec[] = STRATEGY_SPECS.filter((spec) => spec.mode === "SCALP");

export const SCALP_STRATEGY_IDS = SCALP_STRATEGY_SPECS.map((s) => s.id);

/**
 * Allowlist strategi aktif untuk mode SCALP.
 *
 * 20 Okt 2026 (perintah operator) — S-03 Fibonacci dan S-04 Mean-Reversion
 * Stretch DIHAPUS dari lane SCALP (dan SWING). S-01 tetap hard-gated
 * (negative EV). Fallback = S-02 (satu-satunya SCALP yang tersisa hidup).
 *
 * 20 Okt 2026 (AU1-07): daftar aktif ditulis LANGSUNG sebagai konstanta
 * {S-02}. Versi sebelumnya membangun Set 4-elemen lalu menghapus 3-nya —
 * rapuh (tambah strategi baru = edit 2 tempat) dan bisa salah diam-diam.
 * Konstanta eksplisit = allowlist dibaca apa adanya.
 */
const ACTIVE_SCALP_IDS = new Set(["S-02"]);

export function allowedScalpStrategies(): string[] {
  const list = String(env.SCALP_STRATEGY_IDS ?? "S-02")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const enabled = [...new Set(list.filter((id) => ACTIVE_SCALP_IDS.has(id)))];
  return enabled.length > 0 ? enabled : ["S-02"];
}
