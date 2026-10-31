// apps/server/src/analysis/feeds/hyperliquidTrades.ts - Adapter WS Hyperliquid.
// 23 Okt 2026 (Tahap 4). INFLUENSI TRADING: OFF (flag).
//
// RISET SUMBER (23 Okt 2026, subagent + probe live read-only):
//  - WS: wss://api.hyperliquid.xyz/ws  (testnet: wss://api.hyperliquid-testnet.xyz/ws)
//  - Subscribe: {"method":"subscribe","subscription":{"type":"trades","coin":"BTC"}}
//  - Tick: {coin, side:"B"|"A", px, sz, time(ms), hash, tid, users:[buyer,seller]}
//  - PENTING: side = AGGRESSING side (taker). "B"=buy, "A"=ask/short.
//    Untuk channel l2Book, side = sisi book. Konteks channel menentukan.
//    Sumber: hyperliquid-docs/notation.md
//  - Envelope: {"channel":"trades","data":[...]} — array tick per pesan.
//  - TIDAK ada timestamp envelope & TIDAK ada sequence number -> gap hanya
//    terdeteksi lewat reconnect + snapshot.
//  - Idle timeout 60 dtk -> harus ping {"method":"ping"} -> server balas
//    {"channel":"pong"}.
//  - Rate limit: maks 10 koneksi WS, 30 koneksi baru/menit, 1000 subscription,
//    2000 pesan/menit ke HL.
//  - Data = MARKET-WIDE (bukan own-account): subscription trades tidak punya
//    field user, dan tiap tick membawa users:[buyer,seller].
//
// CATATAN PENTING SOAL BACKFILL: REST recentTrades hanya 10 trade per
// panggilan (span ~2,8 dtk) -> backfill tick-level via REST TIDAK mungkin.
// Backfill historis harus via candleSnapshot (capped 5000 candle) atau S3
// node_fills_by_block (biaya transfer ditanggung requester). Karena itu
// adaptor ini TIDAK mengarang backfill.

import type { TradeTick } from "../deltaEngine.js";

export const HYPERLIQUID_WS_MAINNET = "wss://api.hyperliquid.xyz/ws";
export const HYPERLIQUID_WS_TESTNET = "wss://api.hyperliquid-testnet.xyz/ws";

/** Channel WS Hyperliquid. */
export type HlChannel = "trades" | "activeAssetCtx" | "l2Book" | "allMids";

/**
 * URL WS + payload subscribe. Venue ini tidak punya "/market/ws/" seperti
 * Binance — endpoint-nya root + channel via JSON-RPC-like message.
 */
export function hyperliquidWsUrl(testnet = false): string {
  return testnet ? HYPERLIQUID_WS_TESTNET : HYPERLIQUID_WS_MAINNET;
}

export function hyperliquidSubscribePayload(channel: HlChannel, coin?: string): string {
  const sub: Record<string, unknown> = { type: channel };
  if (coin) sub.coin = coin;
  return JSON.stringify({ method: "subscribe", subscription: sub });
}

/** Payload keepalive (server balas {"channel":"pong"}). */
export function hyperliquidPingPayload(): string {
  return JSON.stringify({ method: "ping" });
}

/**
 * Normalisasi ticker Hyperliquid -> simbol ArtaTrade.
 * HL pakai base asset sebagai coin: "BTC" -> "BTCUSDT" (periode ArtaTrade).
 * Quote HL untuk perp = USDC; ArtaTrade memakai simbol "BTCUSDT" sebagai
 * kunci internal, jadi petakan ke "BTCUSDT" supaya perbandingan antar venue
 * memakai kunci yang sama. Kuotasi aslinya dicatat terpisah.
 */
export function hyperliquidCoinToSymbol(coin: string): string {
  const c = coin.toUpperCase();
  // HIP-3: "xyz:XYZ100" -> base "XYZ100".
  const base = c.includes(":") ? c.split(":").pop()! : c;
  return `${base}USDT`;
}

/** Konversi ticker HL ke simbol venue (untuk identitas instrumen). */
export function hyperliquidCoinToVenueSymbol(coin: string): string {
  return coin.toUpperCase();
}

/**
 * Parse satu pesan WS Hyperliquid.
 * Return: array tick (bisa >1 karena channel trades mengirim array),
 * atau null kalau pesan ini bukan trades.
 */
export function parseHyperliquidTrades(raw: string, expectedCoin: string): TradeTick[] | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const o = msg as Record<string, unknown>;
  if (o.channel !== "trades") return null;
  const data = o.data;
  if (!Array.isArray(data)) return null;
  const out: TradeTick[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const coin = typeof t.coin === "string" ? t.coin : "";
    if (!coin) continue;
    if (expectedCoin && coin.toUpperCase() !== expectedCoin.toUpperCase()) continue;
    const px = Number(t.px);
    const sz = Number(t.sz);
    const time = Number(t.time);
    if (!Number.isFinite(px) || px <= 0) continue;
    if (!Number.isFinite(sz) || sz <= 0) continue;
    if (!Number.isFinite(time) || time <= 0) continue;
    // side: "B" = aggressing BUY, "A" = aggressing SELL.
    // Docs: "B = Bid = Buy, A = Ask = Short. Side is aggressing side for trades."
    const side = String(t.side ?? "").toUpperCase();
    const aggressor = side === "B" ? "BUY" : side === "A" ? "SELL" : null;
    if (!aggressor) continue;
    const tid = t.tid !== undefined ? String(t.tid) : undefined;
    const hash = typeof t.hash === "string" ? t.hash : undefined;
    // ID global: (block_time, coin, tid). Hash L1 dipakai sebagai fallback.
    const id = tid ? `hl-${coin}-${tid}` : hash ? `hl-${coin}-${hash}` : `hl-${coin}-${time}-${px}-${sz}`;
    out.push({ id, eventTime: time, price: px, qty: sz, aggressor });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse context aset Hyperliquid (funding / OI / mark price).
 * Sumber: {"type":"metaAndAssetCtxs"} -> [universe, ctxs[]]; ctx per coin
 * punya funding, openInterest, markPx, midPx, oraclePx, premium.
 * Channel streaming "activeAssetCtx" punya bentuk ctx langsung.
 */
export interface HlAssetCtx {
  coin: string;
  funding: number | null;
  openInterest: number | null;
  markPx: number | null;
  midPx: number | null;
  oraclePx: number | null;
  premium: number | null;
  dayNtlVlm: number | null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse satu ctx dari streaming activeAssetCtx atau dari ctxs[] metaAndAssetCtxs. */
export function parseHyperliquidAssetCtx(raw: string, expectedCoin: string): HlAssetCtx | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  const o = msg as Record<string, unknown>;
  let coin = "";
  let ctx: Record<string, unknown> | null = null;

  if (o.channel === "activeAssetCtx") {
    // Bentuk nyata (terverifikasi live 23 Okt 2026):
    //   {"channel":"activeAssetCtx","data":{"coin":"BTC","ctx":{...}}}
    // CATATAN: `ctx` berada DI DALAM `data`, bukan di root envelope.
    const d = o.data as Record<string, unknown> | undefined;
    if (d && typeof d === "object") {
      const inner = d.ctx as Record<string, unknown> | undefined;
      if (inner && typeof inner === "object") {
        coin = typeof d.coin === "string" ? d.coin : (typeof inner.coin === "string" ? inner.coin : "");
        ctx = inner;
      }
    }
  } else if (o.channel === "allDexsAssetCtxs") {
    // Bentuk: {channel, data:{dexs:[{ctxs:[]}]}} — skip, per-dex.
    return null;
  } else {
    return null;
  }
  if (!ctx || !coin) return null;
  if (expectedCoin && coin.toUpperCase() !== expectedCoin.toUpperCase()) return null;
  return {
    coin,
    funding: numOrNull(ctx.funding),
    openInterest: numOrNull(ctx.openInterest),
    markPx: numOrNull(ctx.markPx),
    midPx: numOrNull(ctx.midPx),
    oraclePx: numOrNull(ctx.oraclePx),
    premium: numOrNull(ctx.premium),
    dayNtlVlm: numOrNull(ctx.dayNtlVlm),
  };
}
