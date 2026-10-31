/** Public market data only. No account, auth headers, signing or order methods. */
export type DepthVenue = "BINANCE" | "BYBIT";
export interface PublicDepth { serverTime: number; bids: [string,string][]; asks: [string,string][] }

export async function fetchPublicDepth(symbol: string, venue: DepthVenue, signal: AbortSignal): Promise<PublicDepth> {
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error("Invalid public market symbol");
  const url = venue === "BINANCE"
    ? `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=500`
    : `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=500`;
  const response = await fetch(url, { method: "GET", credentials: "omit", signal });
  if (!response.ok) throw new Error(`Public depth HTTP ${response.status}`);
  const raw = await response.json();
  if (venue === "BYBIT" && raw.retCode !== 0) throw new Error("Bybit public depth unavailable");
  const bids = venue === "BINANCE" ? raw.bids : raw.result?.b;
  const asks = venue === "BINANCE" ? raw.asks : raw.result?.a;
  const serverTime = Number(venue === "BINANCE" ? raw.E ?? raw.T : raw.result?.ts);
  if (!Array.isArray(bids) || !Array.isArray(asks) || !Number.isFinite(serverTime) || serverTime <= 0) throw new Error("Invalid public depth");
  return { bids, asks, serverTime };
}
