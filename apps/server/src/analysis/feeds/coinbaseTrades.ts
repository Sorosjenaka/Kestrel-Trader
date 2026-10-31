// apps/server/src/analysis/feeds/coinbaseTrades.ts - Parser WS Coinbase spot.
// 23 Okt 2026 (Tahap 4). INFLUENSI TRADING: OFF (flag).
//
// RISET SUMBER (23 Okt 2026, subagent + probe live read-only):
//  - WS: wss://advanced-trade-ws.coinbase.com  (publik, tanpa auth)
//  - Subscribe: {"type":"subscribe","channel":"market_trades","product_ids":["BTC-USD"]}
//  - Envelope: {channel:"market_trades", timestamp, sequence_num, events:[
//    {type:"snapshot"|"update", trades:[...]}]}
//  - Tick: {product_id, trade_id, price, size, time(RFC3339 µs), side:"BUY"|"SELL"}
//
// ⚠️ PERINGATAN SEMANTIK (paling penting di file ini):
//  Docs Coinbase AsyncAPI: MarketTrade.side = "The MAKER's side of the trade."
//  Jadi side = sisi MAKER, BUKAN taker. Kalau dipakai apa adanya, delta/CVD
//  terbalik 100%.
//  taker BUY  <=>  maker side = "SELL"
//  taker SELL <=>  maker side = "BUY"
//  (makerisi order agresif yang berlawanan => taker-nya berlawanan)
//
//  Untuk sampai ke mana sumbernya: tidak ada field taker-side di Coinbase
//  market_trades. Hyperliquid menyediakan taker side secara langsung.
//
//  Efek samping: likuiditas pasif (maker) yang mengisi akan menghasilkan
//  tick agresif, sehingga delta berbasis taker di Coinbase spot BERBEDA
//  maknanya dari delta di venue yang memberi taker side eksplisit. Semua
//  angka lintas-venue yang membandingkan dua sumber ini WAJIB diberi label
//  "taker-side proxy", bukan "taker delta".
//
//  Catatan venue lain (dari riset):
//  - Rate limit WS: 8 koneksi/detik/IP + 8 pesan/detik/IP.
//  - Batch tick: update dikumpulkan ~250 ms lalu dikirim bersama.
//  - Public REST response di-cache 1 detik (pakai header cache-control: no-cache).
//  - Channel ditutup 60-90 dtk tanpa update -> subscribe channel "heartbeats".
//  - Coinbase TIDAK punya perp di host ini: perp pindah ke gateway Deribit
//    (drb.coinbase.com) pada 1 Okt 2026; endpoint /intx/* deprecated.

import type { TradeTick } from "../deltaEngine.js";

export const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";
export const COINBASE_REST_BASE = "https://api.coinbase.com/api/v3/brokerage";

/**
 * Simbol ArtaTrade -> product_id Coinbase.
 * ArtaTrade "BTCUSDT" -> Coinbase "BTC-USD" (pasangan USD utama).
 * ArtaTrade "ETHUSDT" -> "ETH-USD".
 */
export function aratradeSymbolToCoinbaseProduct(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = s.replace(/USDT$|USDC$/, "");
  return `${base}-USD`;
}

/** URL WS + payload subscribe. */
export function coinbaseSubscribePayload(productId: string): string {
  return JSON.stringify({
    type: "subscribe",
    channel: "market_trades",
    product_ids: [productId],
  });
}

/** Payload keepalive (channel heartbeats, server ping tiap detik). */
export function coinbaseHeartbeatsPayload(): string {
  return JSON.stringify({ type: "subscribe", channel: "heartbeats" });
}

/**
 * Parse satu pesan WS Coinbase market_trades.
 *
 * Mengembalikan tick dengan `aggressor` = sisi TAKER (sudah dibalik dari
 * maker side). Kalau `side` tidak dikenal -> tick di-skip (jangan karang).
 */
export function parseCoinbaseMarketTrades(raw: string, expectedProduct: string): TradeTick[] | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  const o = msg as Record<string, unknown>;
  if (o.channel !== "market_trades") return null;
  const events = o.events;
  if (!Array.isArray(events)) return null;

  const out: TradeTick[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const trades = (ev as Record<string, unknown>).trades;
    if (!Array.isArray(trades)) continue;
    for (const item of trades) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const product = typeof t.product_id === "string" ? t.product_id : "";
      if (!product) continue;
      if (expectedProduct && product.toUpperCase() !== expectedProduct.toUpperCase()) continue;
      const price = Number(t.price);
      const size = Number(t.size);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!Number.isFinite(size) || size <= 0) continue;
      const eventTime = parseCoinbaseTime(t.time);
      if (eventTime === null) continue;
      // MAKER side -> taker side dibalik.
      const maker = String(t.side ?? "").toUpperCase();
      const aggressor = maker === "SELL" ? "BUY" : maker === "BUY" ? "SELL" : null;
      if (!aggressor) continue;
      const tradeId = t.trade_id !== undefined ? String(t.trade_id) : undefined;
      const id = tradeId ? `cb-${product}-${tradeId}` : `cb-${product}-${eventTime}-${price}-${size}`;
      out.push({ id, eventTime, price, qty: size, aggressor });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse timestamp Coinbase.
 * Format: RFC 3339 dengan presisi MIKRODETIK, contoh "2026-10-23T05:17:49.248363Z".
 * Kita potong ke milidetik (satu presisi event time yang seragam antar venue).
 * Return null kalau tidak bisa diparse.
 */
export function parseCoinbaseTime(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return ms;
}
