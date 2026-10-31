// apps/server/src/marketdata/venueUniverse.ts
// 24 Okt 2026 — Daftar simbol yang VALID per venue.
//
// Penting: tidak semua venue Lists semua simbol. Contoh nyata (diperiksa
// 24 Okt 2026): XMR tidak ada di Bybit Spot / OKX / Gate / Bitget / Coinbase;
// ZEC tidak ada di Bybit Spot; PUMP tidak ada di Bybit Linear.
//
// Konsekuensi: kalau satu subscribe berisi simbol invalid, bursa bisa
// MENOLAK SELURUH subscribe (mis. Bybit v5 `success:false`). Karena itu
// setiap venue hanya direquest untuk simbol yang benar-benar ada.
//
// Sumber: REST publik instrument-list tiap venue (tanpa API key), di-cache
// di memori + di-refresh berkala. Bila REST gagal, pakai daftar statis
// (hasil verifikasi manual 24 Okt 2026) sebagai fallback.

import { logger } from "../core/logger.js";
import { TRACKED_SYMBOLS, type VenueId } from "./microstructureTypes.js";

/** Fallback statis — diverifikasi manual 24 Okt 2026. */
const STATIC_VALID: Record<VenueId, string[]> = {
  BINANCE_PERP: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP", "XMR"],
  BINANCE_SPOT: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP", "XMR"],
  HYPERLIQUID: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP", "XMR"],
  COINBASE: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP"],
  BYBIT_PERP: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "XMR"],
  BYBIT_SPOT: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP"],
  OKX: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP"],
  GATE: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP"],
  BITGET: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP"],
  KUCOIN: ["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "ZRO", "ENA", "ADA", "XRP", "LINK", "BNB", "NEAR", "WLD", "PUMP", "XMR"],
};

const REFRESH_MS = 6 * 3600_000;

const valid = new Map<VenueId, Set<string>>(
  (Object.keys(STATIC_VALID) as VenueId[]).map((v) => [v, new Set(STATIC_VALID[v])]),
);
let lastRefresh = 0;
let refreshTimer: NodeJS.Timeout | null = null;

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<any | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Refresh daftar simbol valid dari REST publik tiap venue. */
export async function refreshVenueUniverse(): Promise<void> {
  const results = await Promise.all([
    // Binance spot
    fetchJson("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT").then((j) => {
      const set = new Set((j?.symbols ?? []).map((s: any) => String(s.symbol).replace(/USDT$/, "")));
      return ["BINANCE_SPOT", set] as const;
    }),
    // Binance futures
    fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo").then((j) => {
      const set = new Set((j?.symbols ?? []).map((s: any) => String(s.symbol).replace(/USDT$/, "")));
      return ["BINANCE_PERP", set] as const;
    }),
    // Hyperliquid
    fetchJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    }).then((j) => {
      const set = new Set((j?.universe ?? []).map((s: any) => String(s.name).toUpperCase()));
      return ["HYPERLIQUID", set] as const;
    }),
    // Coinbase
    fetchJson("https://api.exchange.coinbase.com/products").then((j) => {
      const set = new Set((j ?? []).map((p: any) => String(p.id).split("-")[0]!.toUpperCase()));
      return ["COINBASE", set] as const;
    }),
    // Bybit spot + linear
    fetchJson("https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000").then((j) => {
      const set = new Set((j?.result?.list ?? []).map((s: any) => String(s.symbol).replace(/USDT$|USDC$/, "")));
      return ["BYBIT_SPOT", set] as const;
    }),
    fetchJson("https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000").then((j) => {
      const set = new Set((j?.result?.list ?? []).map((s: any) => String(s.symbol).replace(/USDT$|USDC$/, "")));
      return ["BYBIT_PERP", set] as const;
    }),
    // OKX
    fetchJson("https://www.okx.com/api/v5/public/instruments?instType=SPOT").then((j) => {
      const set = new Set((j?.data ?? []).map((s: any) => String(s.instId).split("-")[0]!.toUpperCase()));
      return ["OKX", set] as const;
    }),
    // Gate
    fetchJson("https://api.gateio.ws/api/v4/spot/currency_pairs").then((j) => {
      const set = new Set((j ?? []).map((s: any) => String(s.id).split("_")[0]!.toUpperCase()));
      return ["GATE", set] as const;
    }),
    // Bitget
    fetchJson("https://api.bitget.com/api/v2/spot/public/symbols").then((j) => {
      const set = new Set((j?.data ?? []).map((s: any) => String(s.symbol).replace(/USDT$|USDC$/, "")));
      return ["BITGET", set] as const;
    }),
    // KuCoin
    fetchJson("https://api.kucoin.com/api/v1/symbols").then((j) => {
      const set = new Set((j?.data ?? []).map((s: any) => String(s.symbol).split("-")[0]!.toUpperCase()));
      return ["KUCOIN", set] as const;
    }),
  ]);

  for (const [venue, set] of results) {
    if (!set || set.size === 0) continue;
    // Interseksi dengan daftar statis supaya simbol nyelamung tidak masuk.
    const next = new Set<string>();
    for (const s of TRACKED_SYMBOLS) if (set.has(s.toUpperCase())) next.add(s.toUpperCase());
    if (next.size === 0) continue;
    valid.set(venue as VenueId, next);
  }
  lastRefresh = Date.now();
  const summary = (Object.keys(valid) as VenueId[])
    .map((v) => `${v}:${valid.get(v)!.size}`).join(" ");
  logger.info({ venues: summary }, "VENUE_UNIVERSE_REFRESHED");
}

export function startVenueUniverse(): void {
  void refreshVenueUniverse();
  if (!refreshTimer) refreshTimer = setInterval(() => void refreshVenueUniverse(), REFRESH_MS);
}

export function stopVenueUniverse(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

/** Simbol yang valid untuk venue (dalam bentuk kanonik: BTC, ETH, ...). */
export function symbolsFor(venue: VenueId): string[] {
  const set = valid.get(venue);
  if (!set || set.size === 0) return STATIC_VALID[venue] ?? [];
  return [...set].filter((s) => TRACKED_SYMBOLS.includes(s));
}

export function universeRefreshedAt(): number {
  return lastRefresh;
}
