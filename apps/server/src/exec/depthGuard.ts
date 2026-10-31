// apps/server/src/exec/depthGuard.ts — T-13 / CP-4 (19 Okt 2026).
// Depth/impact guard SEBELUM entry LIVE: hitung VWAP dari level order book untuk
// notional order dan tolak bila slippage melebihi batas. Murni; pemanggil
// (plannedEntry LIVE) yang mengambil depth dari exchange. Fail-closed: data
// kosong/tidak valid = reject, bukan "anggap aman".

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthGuardInput {
  side: "LONG" | "SHORT" | "BUY" | "SELL";
  notionalUsd: number;
  levels: DepthLevel[];
  maxSlippageBps: number;
}

export interface DepthGuardResult {
  allowed: boolean;
  reason?: "INVALID_INPUT" | "NO_DEPTH" | "INSUFFICIENT_DEPTH" | "SLIPPAGE_EXCEEDED";
  vwap: number | null;
  slippageBps: number | null;
  fillableNotionalUsd: number;
  consumedQty: number;
}

function isBuy(side: DepthGuardInput["side"]): boolean {
  return side === "LONG" || side === "BUY";
}

/** Level book: BUY memakan ask (harga naik), SELL memakan bid (harga turun). */
export function checkDepth(input: DepthGuardInput): DepthGuardResult {
  const empty: DepthGuardResult = {
    allowed: false, reason: "INVALID_INPUT", vwap: null, slippageBps: null,
    fillableNotionalUsd: 0, consumedQty: 0,
  };
  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0
    || !Number.isFinite(input.maxSlippageBps) || input.maxSlippageBps < 0) {
    return empty;
  }
  const levels = input.levels
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
    .slice()
    .sort((a, b) => (isBuy(input.side) ? a.price - b.price : b.price - a.price));
  if (levels.length === 0) return { ...empty, reason: "NO_DEPTH" };

  const best = levels[0].price;
  let remaining = input.notionalUsd;
  let cost = 0;
  let qty = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const levelNotional = level.price * level.qty;
    const take = Math.min(remaining, levelNotional);
    cost += take;
    qty += take / level.price;
    remaining -= take;
  }
  const fillableNotionalUsd = input.notionalUsd - remaining;
  if (remaining > 1e-9) {
    return {
      allowed: false, reason: "INSUFFICIENT_DEPTH", vwap: qty > 0 ? cost / qty : null,
      slippageBps: null, fillableNotionalUsd, consumedQty: qty,
    };
  }
  const vwap = cost / qty;
  const direction = isBuy(input.side) ? 1 : -1;
  const slippageBps = ((vwap - best) / best) * 10_000 * direction;
  return {
    allowed: slippageBps <= input.maxSlippageBps,
    ...(slippageBps <= input.maxSlippageBps ? {} : { reason: "SLIPPAGE_EXCEEDED" as const }),
    vwap, slippageBps, fillableNotionalUsd, consumedQty: qty,
  };
}
