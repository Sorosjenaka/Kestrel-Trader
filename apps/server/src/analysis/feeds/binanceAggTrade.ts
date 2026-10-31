// apps/server/src/analysis/feeds/binanceAggTrade.ts - Adapter trade feed Binance.
// 23 Okt 2026 (Tahap 4).
//
// PENTING SOAL MAKER/TAKER: stream aggTrade Binance memberi field "m"
// (isBuyerMaker). Kalau m=true, MAKER-nya buyer => agresifnya SELLER.
// Jadi taker side = m ? SELL : BUY. Membalik ini membuat delta/CVD
// terbalik sepenuhnya — jadi di sini satu-satu dan diuji fixture.
//
// Field aggTrade (Binance USDⓈ-M futures & spot, sama):
//   e = "aggTrade", E = event time (ms), s = symbol, a = aggTradeId,
//   p = price, q = qty, m = isBuyerMaker, T = trade time (ms).
//
// CATATAN SPOT: di Binance SPOT, stream "aggTrade" punya event type "aggTrade"
// dengan field yang sama. Stream "trade" (raw trade) tidak dipakai di sini.

import type { AggressorSide, TradeTick } from "../deltaEngine.js";

export interface ParsedAggTrade {
  ok: true;
  tick: TradeTick;
}

/**
 * Parse satu pesan aggTrade Binance.
 * Mengembalikan null kalau pesan tidak valid (bukan error fatal).
 */
export function parseBinanceAggTrade(raw: string, expectSymbol?: string): ParsedAggTrade | null {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  // Combined stream: { stream, data }
  const d = msg?.data ?? msg;
  if (!d || d.e !== "aggTrade") return null;
  const symbol = String(d.s ?? "").toUpperCase();
  if (!symbol) return null;
  if (expectSymbol && symbol !== expectSymbol.toUpperCase()) return null;

  const price = Number(d.p);
  const qty = Number(d.q);
  const eventTime = Number(d.T ?? d.E);
  const aggId = d.a;

  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(eventTime) || eventTime <= 0) return null;
  if (aggId === undefined || aggId === null) return null;

  // m = isBuyerMaker. true => buyer maker (passif) => agresif = SELL.
  const aggressor: AggressorSide = d.m === true ? "SELL" : "BUY";

  return {
    ok: true,
    tick: {
      id: `a${String(aggId)}`,
      eventTime,
      price,
      qty,
      aggressor,
    },
  };
}

/**
 * URL WS aggTrade untuk sebuah simbol.
 *
 * 23 Okt 2026: WAJIB path "/market/ws/" — path lama "/ws/" sekarang
 * membalas HTTP 302 redirect yang TIDAK di-follow library ws, sehingga
 * koneksi "terbuka" tapi tidak pernah menerima pesan (dibuktikan di
 * produksi 23 Okt 2026: /ws/ = 0 pesan, /market/ws/ = data mengalir).
 */
export function binanceAggTradeUrl(host: string, symbol: string, market: "SPOT" | "PERP"): string {
  const s = symbol.toLowerCase();
  const base = host.includes("://") ? host.replace(/\/+$/, "") : `wss://${host}`;
  return `${base}/${s}@aggTrade`;
}

/** Host WS yang dipakai (diverifikasi bekerja 23 Okt 2026). */
export function binanceWsHosts(market: "SPOT" | "PERP" = "PERP"): string[] {
  return market === "SPOT"
    ? ["stream.binance.com/market/ws", "stream1.binance.com/market/ws"]
    : ["fstream.binance.com/market/ws", "fstream1.binance.com/market/ws"];
}
