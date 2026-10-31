export interface PublicLiquidation { symbol: string; side: "SELL" | "BUY"; price: number; qty: number; notionalUsd: number; time: number }
/** Binance public forceOrder snapshot: executed quantity, never original unfilled size. */
export function parsePublicLiquidation(raw: string, symbol: string): PublicLiquidation | null {
  try {
    const data = JSON.parse(raw); const o = data.o;
    if (data.e !== "forceOrder" || o?.s !== symbol || !["SELL","BUY"].includes(o.S)) return null;
    const price = Number(o.ap), qty = Number(o.z), time = Number(o.T ?? data.E);
    if (![price,qty,time,price*qty].every(Number.isFinite) || price <= 0 || qty <= 0 || time <= 0) return null;
    return { symbol, side: o.S, price, qty, time, notionalUsd: price * qty };
  } catch { return null; }
}
