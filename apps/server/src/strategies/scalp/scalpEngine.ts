// apps/server/src/strategies/scalp/scalpEngine.ts
// Engine evaluasi strategi khusus mode SCALPING (5m).
// Meliputi S-01 (Sweep Reclaim) dan S-02 (Sniper).
//
// 20 Okt 2026 (perintah operator) — S-03 Fibonacci dan S-04 Mean-Reversion
// Stretch DIHAPUS dari lane SCALP: evaluateFibRetracement dan
// evaluateMrvStretch tidak lagi dipanggil. Engine fibRetracementEngine.ts
// + mrvStretchEngine.ts tetap ada sebagai arsip (replay historis/laporan),
// bukan entry source.
import {
  evaluateLiquiditySweepReclaim,
  evaluateLiquiditySniper,
  type StrategyContext,
  type StrategyPlan,
} from "../setupStrategies.js";
import { allowedScalpStrategies, SCALP_STRATEGY_SPECS } from "./scalpCatalog.js";

export {
  evaluateLiquiditySweepReclaim,
  evaluateLiquiditySniper,
};

/**
 * Bangun daftar rencana strategi khusus untuk mode SCALPING (5m).
 * Menggunakan allowlist SCALP aktif (S-02).
 */
export function buildScalpStrategyPlans(
  ctx: StrategyContext,
  _now = Date.now(),
  allowedIds?: string[]
): StrategyPlan[] {
  const allowed = allowedIds ?? allowedScalpStrategies();
  const scalpCtx: StrategyContext = { ...ctx, mode: "SCALP" };
  const allow = allowed.map((s) => s.toUpperCase());

  const plans: StrategyPlan[] = [];
  if (allow.includes("S-01")) plans.push(evaluateLiquiditySweepReclaim(scalpCtx));
  if (allow.includes("S-02")) plans.push(evaluateLiquiditySniper(scalpCtx));
  // 20 Okt 2026: S-03 Fibonacci dan S-04 MRV Stretch dihapus — tidak
  // dievaluasi lagi.

  return plans.sort((a, b) => Number(b.matched) - Number(a.matched) || b.quality - a.quality);
}
