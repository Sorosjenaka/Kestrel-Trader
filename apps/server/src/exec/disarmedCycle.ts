// apps/server/src/exec/disarmedCycle.ts - Siklus end-to-end DISARMED (US-01, US-02, NFR-09, Fase 2 DoD).
import { calculateOrderPlan, SymbolRiskRules } from "../risk/riskEngine.js";
import { defaultDailyRiskGuard } from "../risk/dailyGuard.js";
import { defaultOrderExecutor } from "./orderExecutor.js";
import { defaultPositionSupervisor } from "./positionSupervisor.js";
import { defaultPositionReconciler } from "./reconciler.js";
import { db } from "../core/db.js";
import { rrPolicyForMode } from "../config/setupEngine.js";

export interface DisarmedCycleParams {
  symbol?: string;
  side?: "LONG" | "SHORT";
  // 30 Sep 2026 — refactor SCALP-only: mode tunggal.
  mode?: "SCALP";
  entryPrice?: number;
  slPrice?: number;
  tp1Price?: number;
  equityUsd?: number;
  targetRiskUsd?: number;
}

export interface DisarmedCycleStepTrace {
  name: string;
  timestamp: string;
  success: boolean;
  data: Record<string, unknown>;
}

export interface DisarmedCycleResult {
  success: boolean;
  cycleId: string;
  mode: string;
  symbol: string;
  steps: DisarmedCycleStepTrace[];
  finalTrade?: Record<string, unknown>;
  reconcileSummary?: Record<string, unknown>;
}

export async function runDisarmedCycle(params?: DisarmedCycleParams): Promise<DisarmedCycleResult> {
  const symbol = (params?.symbol ?? "BTCUSDT").toUpperCase();
  const side = params?.side ?? "LONG";
  const mode = params?.mode ?? "SCALP";
  const entryPrice = params?.entryPrice ?? (symbol.includes("BTC") ? 60000 : 3000);
  const slPrice = params?.slPrice ?? (side === "LONG" ? entryPrice * 0.992 : entryPrice * 1.008);
  // Default TP1 follows the mode policy and the actual initial-SL distance.
  const rDistance = Math.abs(entryPrice - slPrice);
  const tp1R = rrPolicyForMode(mode).tp1R;
  const tp1Price = params?.tp1Price ?? (side === "LONG" ? entryPrice + tp1R * rDistance : entryPrice - tp1R * rDistance);
  const equityUsd = params?.equityUsd ?? 100.0;
  const targetRiskUsd = params?.targetRiskUsd ?? 1.0;

  const cycleId = `CYCLE_${Date.now()}`;
  const steps: DisarmedCycleStepTrace[] = [];

  // Step 1: Sinyal
  steps.push({
    name: "SIGNAL_GENERATION",
    timestamp: new Date().toISOString(),
    success: true,
    data: { symbol, side, mode, entryPrice, slPrice, tp1Price, source: "SCANNER_MOCK" },
  });

  // Step 2: Risk Engine Sizing (FR-15, NFR-13)
  const symbolRules: SymbolRiskRules = {
    symbol,
    minNotional: 5.0,
    tickSize: 0.01,
    stepSize: 0.001,
    maxLeverage: 20,
    leverageUpdatedAt: Date.now(),
    isBlacklisted: false,
    blacklistReason: null,
  };

  const plan = calculateOrderPlan({
    symbol,
    mode,
    side,
    entryPrice,
    slPrice,
    tp1Price,
    equityUsd,
    targetRiskUsd,
    symbolRules,
  });

  if (!plan.allowed) {
    steps.push({
      name: "RISK_SIZING",
      timestamp: new Date().toISOString(),
      success: false,
      data: { error: plan.rejectReason },
    });
    return { success: false, cycleId, mode, symbol, steps };
  }

  steps.push({
    name: "RISK_SIZING",
    timestamp: new Date().toISOString(),
    success: true,
    data: {
      notional: plan.notionalUsd,
      qty: plan.qty,
      marginUsd: plan.marginUsd,
      effectiveRiskUsd: plan.effectiveRiskUsd,
      leverage: plan.leverage,
    },
  });

  // Step 3: Daily Guard Check (FR-20, FR-21)
  const guardStatus = await defaultDailyRiskGuard.evaluateStatus(symbol);
  steps.push({
    name: "DAILY_GUARD",
    timestamp: new Date().toISOString(),
    success: guardStatus.canTrade,
    data: {
      armed: guardStatus.armed,
      openPositionsCount: guardStatus.openPositionsCount,
      dailyPnlUsd: guardStatus.dailyPnlUsd,
      canTrade: guardStatus.canTrade,
      reasons: guardStatus.reasons,
    },
  });

  // Step 4: Eksekusi Order Terbuka (Mode DISARMED, FR-22)
  const orderRes = await defaultOrderExecutor.executeOrder({
    symbol,
    side: side === "LONG" ? "BUY" : "SELL",
    type: "LIMIT",
    price: entryPrice,
    qty: plan.qty,
    reduceOnly: false,
  });

  steps.push({
    name: "ORDER_EXECUTION_DISARMED",
    timestamp: new Date().toISOString(),
    success: orderRes.status === "FILLED",
    data: {
      clientOrderId: orderRes.clientOrderId,
      status: orderRes.status,
      simulated: orderRes.simulated,
      fillPrice: orderRes.fillPrice,
      makerFeeUsd: orderRes.feeUsd,
    },
  });
  // Step 5: Buka Posisi di Database
  const posRow = await db.position.create({
    data: {
      symbol,
      mode,
      side,
      entryPrice,
      qty: plan.qty,
      notional: plan.notionalUsd,
      leverage: plan.leverage,
      marginUsd: plan.marginUsd,
      slPrice,
      tp1Price,
      // Kolom legacy tetap diisi = tp1Price agar skema (Float non-null) valid;
      // tidak ada logika TP2 yang membacanya lagi (single-target TP).
      tp2Price: tp1Price,
      status: "OPEN",
      openedAt: new Date(),
      // T-5.16: pipeline uji ditandai DEMO supaya TIDAK masuk history/equity operator.
      source: "DEMO",
      outlookText: `[DEMO pipeline uji — bukan trade nyata] Setup ${mode} ${side} tervalidasi. RR klasik single target 1.6R, 100% posisi ditutup di TP.`,
    },
  });

  steps.push({
    name: "POSITION_OPENED",
    timestamp: new Date().toISOString(),
    success: true,
    data: { positionId: posRow.id, levels: { entry: entryPrice, sl: slPrice, tp1: tp1Price } },
  });

  // Step 6: Simulasi Mark Price TP1 hit at the mode-specific RR (FR-17)
  const tp1Evals = await defaultPositionSupervisor.evaluatePriceTick({
    symbol,
    markPrice: side === "LONG" ? tp1Price + 0.5 : tp1Price - 0.5,
  });

  steps.push({
    name: "SUPERVISOR_TP1",
    timestamp: new Date().toISOString(),
    success: tp1Evals.some((e) => e.action === "TP1"),
    data: { evaluations: tp1Evals, note: "100% posisi ditutup di TP tunggal (single target)" },
  });

  // Step 8: Verifikasi Entri Trade Tercatat di DB (FR-25)
  const trade = await db.trade.findFirst({
    where: { positionId: posRow.id },
  });

  steps.push({
    name: "TRADE_JOURNALED",
    timestamp: new Date().toISOString(),
    success: trade !== null,
    data: trade ? { tradeId: trade.id, rMultiple: trade.rMultiple, pnlUsd: trade.pnlUsd, win: trade.win } : {},
  });

  // Step 9: Reconcile Uji Restart Server (NFR-04, NFR-14)
  const reconcileReport = await defaultPositionReconciler.reconcile();
  steps.push({
    name: "RECONCILE_RESTART_AUDIT",
    timestamp: new Date().toISOString(),
    success: reconcileReport.orphanCount === 0,
    data: {
      dbOpenCount: reconcileReport.dbOpenCount,
      orphanCount: reconcileReport.orphanCount,
      matchedCount: reconcileReport.matchedCount,
    },
  });

  return {
    success: true,
    cycleId,
    mode,
    symbol,
    steps,
    finalTrade: trade ? (trade as unknown as Record<string, unknown>) : undefined,
    reconcileSummary: reconcileReport as unknown as Record<string, unknown>,
  };
}

