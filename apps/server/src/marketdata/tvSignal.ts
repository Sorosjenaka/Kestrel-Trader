// apps/server/src/marketdata/tvSignal.ts
// SINYAL BUY/SELL TradingView (technical rating) + RENCANA LEVEL PREDIKSI
// entry/SL/TP (permintaan operator 8 Okt 2026: "buat pake fitur TradingView yang
// prediksi posisi penjualan dan posisi pembelian secara otomatis untuk
// memposisikan entry SL dan TP").
//
// Semua angka DETERMINISTIK (Golden Rules #1 — tidak ada LLM di jalur angka):
//   rating  : TradingView scanner publik (Recommend.All, skala -1..+1)
//   ATR14   : klines Binance (Wilder, engine yang sama dengan sistem)
//   level   : model ArtaTrade — R = 1.0 * ATR14, SL = 1.0R, TP = 1.5R
//             (entry = harga terakhir; BUY = SL di bawah/TP di atas, SELL cermin)
// INI BUKAN JALUR TRADING: endpoint read-only untuk display chart; tidak
// memengaruhi order, sizing, atau gate entry mana pun.
//
// Fail-closed: data rating/ATR tidak tersedia -> TIDAK ada level yang dikarang;
// hasil dikembalikan tanpa plan + alasan (chart menampilkan kosong, bukan palsu).

import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { calculateAtr } from "../engines/regimeTrendEngine.js";
import { klinesToBars } from "../engines/multiTimeframeAnalyzer.js";

export type TvSignalSide = "BUY" | "SELL" | "NEUTRAL";

export interface TvSignalPlan {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
}

export interface TvSignalResult {
  symbol: string;
  interval: string;
  /** Recommend.All TradingView (-1..+1); null bila fetch gagal. */
  rating: number | null;
  ratingLabel: string;
  signal: TvSignalSide;
  entry: number | null;
  atr14: number | null;
  /** Plan prediksi LONG; null bila data tidak cukup (fail-closed). */
  buy: TvSignalPlan | null;
  /** Plan prediksi SHORT; null bila data tidak cukup (fail-closed). */
  sell: TvSignalPlan | null;
  source: string;
  at: number;
  reason?: string;
}

/** Ambang rating TradingView -> sinyal (0.1 = Buy/Sell terkecil di skala resmi). */
export const TV_SIGNAL_THRESHOLD = 0.1;
/** R = k * ATR14 (k=1, preseden S-04 MRV "trade cepat"); SL 1R / TP 1.5R. */
export const TV_R_ATR = 1.0;
export const TV_SL_R = 1.0;
export const TV_TP_R = 1.5;

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: TvSignalResult }>();
const round8 = (v: number) => Number(v.toFixed(8));

export function ratingToLabel(r: number): string {
  if (r > 0.5) return "STRONG BUY";
  if (r > TV_SIGNAL_THRESHOLD) return "BUY";
  if (r >= -TV_SIGNAL_THRESHOLD) return "NEUTRAL";
  if (r >= -0.5) return "SELL";
  return "STRONG SELL";
}

export function ratingToSignal(r: number): TvSignalSide {
  if (r > TV_SIGNAL_THRESHOLD) return "BUY";
  if (r < -TV_SIGNAL_THRESHOLD) return "SELL";
  return "NEUTRAL";
}

/** Fetch rating teknikal TradingView (endpoint scanner publik, tanpa akun). */
async function fetchTvRating(symbol: string): Promise<{ rating: number | null; close: number | null; reason?: string }> {
  const url = `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(`BINANCE:${symbol}`)}&fields=Recommend.All,close`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (ArtaTrade-Display)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { rating: null, close: null, reason: `TV_HTTP_${res.status}` };
    const data = (await res.json()) as Record<string, number>;
    const rating = Number(data["Recommend.All"]);
    const close = Number(data["close"]);
    if (!Number.isFinite(rating)) return { rating: null, close: null, reason: "TV_RATING_MISSING" };
    return { rating, close: Number.isFinite(close) ? close : null };
  } catch (e) {
    return { rating: null, close: null, reason: `TV_FETCH_FAIL:${(e as Error).message}` };
  }
}

/** Rencana level dari ATR (deterministik). ATR tidak valid -> null (tidak mengarang). */
export function buildPredictedPlans(
  entry: number,
  atr14: number | null
): { buy: TvSignalPlan | null; sell: TvSignalPlan | null } {
  if (!(entry > 0) || !(atr14 && atr14 > 0)) return { buy: null, sell: null };
  const r = TV_R_ATR * atr14;
  return {
    buy: { side: "BUY", entry: round8(entry), sl: round8(entry - TV_SL_R * r), tp: round8(entry + TV_TP_R * r), rr: TV_TP_R / TV_SL_R },
    sell: { side: "SELL", entry: round8(entry), sl: round8(entry + TV_SL_R * r), tp: round8(entry - TV_TP_R * r), rr: TV_TP_R / TV_SL_R },
  };
}

export async function getTvSignal(symbol: string, interval = "15m", now = Date.now()): Promise<TvSignalResult> {
  const key = `${symbol.toUpperCase()}:${interval}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const [tv, kl] = await Promise.all([
    fetchTvRating(symbol.toUpperCase()),
    binanceFuturesClient.fetchKlines(symbol.toUpperCase(), interval, 100).catch(() => [] as any[]),
  ]);

  const bars = klinesToBars(kl);
  const atr14 = bars.length >= 15 ? calculateAtr(bars, 14) : null;
  const entry = tv.close ?? (bars.length ? bars[bars.length - 1]!.close : null);
  const { buy, sell } = buildPredictedPlans(entry ?? NaN, atr14);

  const reasons: string[] = [];
  if (tv.rating === null) reasons.push(tv.reason ?? "TV_RATING_MISSING");
  if (atr14 === null) reasons.push("ATR14_UNAVAILABLE");
  if (entry === null) reasons.push("PRICE_UNAVAILABLE");

  const rating = tv.rating;
  const value: TvSignalResult = {
    symbol: symbol.toUpperCase(),
    interval,
    rating,
    ratingLabel: rating === null ? "UNKNOWN" : ratingToLabel(rating),
    signal: rating === null ? "NEUTRAL" : ratingToSignal(rating),
    entry: entry === null ? null : round8(entry),
    atr14: atr14 === null ? null : round8(atr14),
    buy,
    sell,
    source: "tradingview-scanner (Recommend.All) + binance klines ATR14",
    at: now,
    ...(reasons.length ? { reason: reasons.join("+") } : {}),
  };
  cache.set(key, { at: now, value });
  return value;
}
