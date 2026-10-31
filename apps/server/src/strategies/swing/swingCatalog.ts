// apps/server/src/strategies/swing/swingCatalog.ts
// Katalog Strategi khusus mode SWING (H1).
import { STRATEGY_SPECS, type StrategySpec } from "../strategyCatalog.js";
import { env } from "../../core/env.js";

export const SWING_STRATEGY_SPECS: StrategySpec[] = STRATEGY_SPECS.filter((spec) => spec.mode === "SWING");

export const SWING_STRATEGY_IDS = SWING_STRATEGY_SPECS.map((s) => s.id);

/**
 * Allowlist strategi aktif untuk mode SWING, dipisahkan per execution mode.
 *
 * 20 Okt 2026 — S-03 Fibonacci/Atlas DIHAPUS dari lane SWING (PAPER & LIVE).
 * 20 Okt 2026 (perintah operator: "polaris hapus juga / yang S-05 itu") —
 * S-05 Polaris (Swing Breakout Pattern) juga DIHAPUS: bukti master_v2
 * executed n=1.391, PF 0.7503, P(EV<=0)=99.9%, 2026 PF 0.452 = EDGE NEGATIF.
 * Tiga strategi SWING yang tersisa: RSW-01 (Orion), RSW-02 (Vega),
 * RSW-03 (Draco).
 *
 * 20 Okt 2026 (keputusan operator D-1): RSW-01, RSW-02, RSW-03 ADOPT untuk
 * LIVE maupun PAPER. Sebelumnya RSW hanya PAPER-ONLY (backtestEngine.ts:106-108,
 * rswPlans.ts:11, AGENT.md T0.5). Operator memutuskan ketiganya masuk LIVE.
 *
 * Fail-closed: ID di luar allowlist per-mode dibuang. env.SWING_STRATEGY_IDS
 * hanya bisa menyaring ID yang ADA di set mode tersebut, tidak bisa menyelundupkan
 * ID yang tidak terdaftar.
 */
export function allowedSwingStrategies(): string[] {
  const isLive = env.BINANCE_EXECUTION_MODE === "LIVE";

  // 20 Okt 2026 (keputusan operator D-1): RSW-01/02/03 ADOPT LIVE + PAPER.
  // S-05 Polaris DIHAPUS dari lane SWING (entry retired 20 Okt 2026).
  // S-03/S-04 sudah DIHAPUS sebelumnya.
  const paperAllowed = new Set(["RSW-01", "RSW-02", "RSW-03"]);
  const liveAllowed = new Set(["RSW-01", "RSW-02", "RSW-03"]);

  const allowed = isLive ? liveAllowed : paperAllowed;
  const fallback = Array.from(allowed);

  const list = String(env.SWING_STRATEGY_IDS ?? "RSW-01,RSW-02,RSW-03")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((id) => allowed.has(id));
  return list.length > 0 ? list : fallback;
}
