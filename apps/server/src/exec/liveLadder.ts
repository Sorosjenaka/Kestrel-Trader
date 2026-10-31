// apps/server/src/exec/liveLadder.ts — ladder SWING untuk LIVE.
// RR23: TP1 50% @2R + TP2/final 50% @3R, tanpa runner. Legacy: 40/30/30
// dengan TPMAX = entry + 3×offset TP1. Policy eksplisit; jangan menebak dari qty.

export interface LiveLadderPlan {
  tp1Qty: number;
  tp2Qty: number;
  runnerQty: number;
  tpMaxPrice: number | null;
}

function floorToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  return Math.floor(value / step + 1e-9) * step;
}

/**
 * null = bukan ladder valid (fallback single-target 100% di TP1).
 * Level TPmax hanya informatif bila runnerQty > 0.
 */
export function planLiveLadder(input: {
  qty: number;
  stepSize: number;
  entryPrice: number;
  tp1Price: number | null;
  side: "LONG" | "SHORT";
  swingExitPolicy?: "RR23" | "LEGACY_40_30";
}): LiveLadderPlan | null {
  const { qty, entryPrice, tp1Price, side } = input;
  if (!(qty > 0) || !(entryPrice > 0) || tp1Price == null || !(tp1Price > 0)) return null;
  const beyond = side === "LONG" ? tp1Price > entryPrice : tp1Price < entryPrice;
  if (!beyond) return null;
  const rr23 = input.swingExitPolicy === "RR23";
  const tp1Qty = floorToStep(qty * (rr23 ? 0.5 : 0.4), input.stepSize);
  // RR23: all remaining lots belong to TP2/final 3R. Legacy: keep 30% runner.
  const tp2Qty = rr23
    ? Number((qty - tp1Qty).toFixed(12))
    : floorToStep(qty * 0.3, input.stepSize);
  const runnerQty = rr23 ? 0 : Number((qty - tp1Qty - tp2Qty).toFixed(12));
  if (!(tp1Qty > 0) || !(tp2Qty > 0) || (!rr23 && !(runnerQty > 0))) return null;
  return {
    tp1Qty,
    tp2Qty,
    runnerQty,
    tpMaxPrice: rr23 ? null : entryPrice + (tp1Price - entryPrice) * 3,
  };
}

/** Evidence of an algo order's fill state, derived from exchange response fields.
 *  TRIGGERED alone does NOT prove the child order filled — it only means the
 *  trigger price was hit and the child order was submitted to the book. */
export interface AlgoFillEvidence {
  /** Trigger price was hit (TRIGGERED, FINISHED, EXECUTED, COMPLETED). */
  triggered: boolean;
  /** Algo lifecycle finished (FINISHED). */
  finished: boolean;
  /** Exchange orderId of the child order, null if not yet triggered. */
  childOrderId: string | null;
  /** Average fill price of the child order, null if no fill evidence. */
  fillPrice: number | null;
  /** Filled quantity of the child order, null if not available. */
  fillQty: number | null;
  /** True only when the exchange provides sufficient evidence of a fill.
   *  FINISHED + actualPrice > 0, or TRIGGERED + actualPrice > 0 + actualQty > 0. */
  confirmedFilled: boolean;
}

export function parseAlgoFillEvidence(algo: {
  algoStatus?: string | null;
  actualOrderId?: string | number | null;
  actualPrice?: string | number | null;
  actualQty?: string | number | null;
} | null | undefined): AlgoFillEvidence {
  const empty: AlgoFillEvidence = { triggered: false, finished: false, childOrderId: null, fillPrice: null, fillQty: null, confirmedFilled: false };
  if (!algo) return empty;
  const status = String(algo.algoStatus ?? "").toUpperCase().trim();
  const triggered = ["TRIGGERED", "FINISHED", "EXECUTED", "COMPLETED"].includes(status);
  if (!triggered) return empty;
  const finished = status === "FINISHED";
  const childOrderId = String(algo.actualOrderId ?? "").trim() || null;
  const rawPrice = Number(algo.actualPrice);
  const rawQty = Number(algo.actualQty);
  const fillPrice = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;
  const fillQty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : null;
  // FINISHED + actualPrice > 0 = exchange confirms fill completed.
  // TRIGGERED + actualPrice > 0 + actualQty > 0 = strong fill evidence.
  // TRIGGERED alone or with actualPrice = 0 = child order resting, NOT filled.
  const confirmedFilled = fillPrice != null && (finished || fillQty != null);
  return { triggered, finished, childOrderId, fillPrice, fillQty, confirmedFilled };
}

/** Status algo exchange yang berarti TP sudah tereksekusi (bukan lagi resting).
 *  PENTING: TRIGGERED TIDAK termasuk — trigger hanya membuktikan harga menyentuh
 *  level dan child order dikirim ke book, BUKAN bahwa quantity sudah terisi.
 *  Gunakan parseAlgoFillEvidence() untuk bukti fill yang sebenarnya. */
export function isAlgoFilled(status: string | undefined | null): boolean {
  return /^(FILLED|EXECUTED|COMPLETED|FINISHED)$/i.test(String(status ?? "").trim());
}
