// apps/server/src/strategies/swing/swingEngine.ts
// Engine evaluasi strategi khusus mode SWING (1h).
// Entry aktif: T0.5 (18 Okt 2026) RSW-01/02/03 (port evaluator riset
// swing_paper_*).
//
// 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu") —
// S-03 Fibonacci DIHAPUS dari lane SWING. evaluateFibRetracement tidak lagi
// dipanggil; engine fibRetracementEngine.ts tetap ada di repo sebagai arsip
// (dipakai replay historis/laporan), bukan sebagai entry source.
//
// 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05 Polaris
// entry di-retire; 21 Okt 2026 dipindahkan ke arsip riset. S-05 tidak lagi
// punya plan di lane SWING. Mesinnya (swingBreakoutEngine) tetap hidup untuk
// historical replay + worker forward paper Polaris, dan di-re-export di bawah
// supaya jalur arsip/replay tidak putus.
import {
  type StrategyContext,
  type StrategyPlan,
} from "../setupStrategies.js";
import { buildRswPlans } from "../researchSwing/rswPlans.js";
import { allowedSwingStrategies, SWING_STRATEGY_SPECS } from "./swingCatalog.js";
export * from "../swingBreakoutEngine.js";

/**
 * Bangun daftar rencana strategi khusus untuk mode SWING (1h).
 * Menggunakan allowlist SWING aktif (RSW-01/02/03).
 *
 * buildRswPlans mengembalikan array kosong bila tidak ada sinyal atau tanpa
 * h4Bars.
 */
export function buildSwingStrategyPlans(
  ctx: StrategyContext,
  _now = Date.now(),
  allowedIds?: string[]
): StrategyPlan[] {
  const allowed = allowedIds ?? allowedSwingStrategies();
  const swingCtx: StrategyContext = { ...ctx, mode: "SWING" };
  const allow = allowed.map((s) => s.toUpperCase());

  const plans: StrategyPlan[] = [];
  // 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05 DIHAPUS
  // dari katalog aktif: tidak lagi ada plan S-05 di lane SWING (bahkan saat
  // allowlist menyebutnya — allowlist tak bisa resurrect strategi mati).
  // Mesinnya tetap hidup untuk replay historis (historicalReplay).
  // 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu") —
  // S-03 Fibonacci dihapus: evaluateFibRetracement tidak lagi dipanggil.
  plans.push(...buildRswPlans(swingCtx, allow));

  return plans.sort((a, b) => Number(b.matched) - Number(a.matched) || b.quality - a.quality);
}
