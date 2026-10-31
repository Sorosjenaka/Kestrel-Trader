// apps/server/src/marketdata/multiVenueOrderFlowHub.ts
// HUB ORDER FLOW MULTI-VENUE (24 Okt 2026) — fondasi 5 modul mikrostruktur.
//
//  - 10 koneksi WebSocket publik (tanpa API key exchange) dijalankan 24/7 di
//    backend VPS: Binance Perp, Binance Spot, Hyperliquid, Coinbase, Bybit
//    Linear, Bybit Spot, OKX, Gate, Bitget, KuCoin.
//  - Semua trade dinormalisasi ke "taker side": +usd = taker BUY, -usd = taker
//    SELL. Coinbase hanya melaporkan MAKER side, jadi delta-nya proksi taker
//    dan ditandai `takerSideIsMaker: true`.
//  - Agregat: per (venue, simbol) per-detik (buy/sell/trade count) untuk
//    window 1m/5m/15m/1h, dan per-menit untuk window 1d/7d.
//  - Book L2 Binance Futures (REST snapshot + diff stream) & Hyperliquid
//    l2Book untuk pelacakan wall lifecycle.
//  - Statistik market Hyperliquid (mid/mark/oracle/premium/funding/OI/24h vol)
//    di-push ke frontend lewat SSE setiap ~1.5 dtk (override engine).
//
// TIDAK ADA data mock/random. Semua angka berasal dari bursa/Vike.

import WebSocket from "ws";
import { logger } from "../core/logger.js";
import { env } from "../core/env.js";
import { ResilientWs } from "./wsLink.js";
import { TimeRing, CumulativeSeries } from "./timeSeries.js";
import { StructureTracker, classifyFlowVsPrice, type StructureState } from "./structureTracker.js";
import { PriceHistory } from "./priceHistory.js";
import {
  VENUES, VENUE_BY_ID, TRACKED_SYMBOLS, HISTORY_SYMBOLS, isHistorySymbol,
  venueSymbol, baseFromVenueSymbol, flowTier,
  type VenueId, type MarketKind, type TapeTrade, type BookLevel, type BookSnapshot,
  type FlowTier,
} from "./microstructureTypes.js";
import { symbolsFor } from "./venueUniverse.js";
import { normalizeEventTime } from "./eventTime.js";

// ── Konfigurasi ──────────────────────────────────────────────────────────────

/** Kapasitas ring per-detik (1 jam). */
const SEC_CAPACITY = 3600;
/** Kapasitas ring per-menit (2 hari). */
const MIN_CAPACITY = 2880;
/** Jumlah trade besar (>= $10K) yang disimpan per simbol untuk tape & profil. */
const LARGE_TAPE_PER_SYMBOL = 3000;
/** Buffer global trade besar (>= $10K) lintas simbol untuk feed Panel 4. */
const LARGE_TAPE_GLOBAL = 20000;
/** Target titik seri CVD per window (resolusi dipilih agar payload SSE ringan). */
const SERIES_TARGET_POINTS = 420;
/**
 * 24 Okt 2026 — jendela retensi priceHistory (ms). priceHistory kini
 * menyimpan 1 sampel per detik, jadi 3 jam = maksimal ~10.800 sampel per
 * simbol (sebelumnya: satusampel PER TRANSAKSI -> ~2 juta objek per simbol
 * dan box 1.9 GB mulai swap). Lihat priceHistory.ts.
 */
const PRICE_HISTORY_WINDOW_MS = 3 * 3600_000;

const HIST = new Set(HISTORY_SYMBOLS);

export interface VenueHealth {
  venue: VenueId;
  label: string;
  connected: boolean;
  connects: number;
  reconnects: number;
  messages: number;
  lastMessageAtMs: number;
  lastError: string | null;
  tradesIngested: number;
}

export interface MarketStats {
  symbol: string;
  mid: number | null;
  lastTrade: number | null;
  mark: number | null;
  oracle: number | null;
  premium: number | null;
  /** Funding per jam dalam desimal (0.0000125 = 0.00125%). */
  fundingHourly: number | null;
  fundingAprPct: number | null;
  openInterestCoins: number | null;
  openInterestUsd: number | null;
  oiChange15mCoins: number | null;
  oiChange1hCoins: number | null;
  dayVolumeUsd: number | null;
  dayVolumeChangePct: number | null;
  spreadAbs: number | null;
  spreadPct: number | null;
  bookAgeMs: number | null;
  /** Order book imbalance Binance dalam radius 2% dari mid. */
  bookObi2Pct: number | null;
  updatedAt: number;
  source: "hyperliquid_stream" | "hyperliquid_rest" | null;
}

export interface AggressionRow {
  window: "1M" | "5M" | "15M" | "1H";
  windowSec: number;
  takerBuyUsd: number;
  takerSellUsd: number;
  buySharePct: number;
  trades: number;
  buySellRatio: number | null;
}

export interface CvdSeries {
  venue: string;
  /** label warna/legenda */
  color: string;
  points: { t: number; v: number }[];
}

export interface OrderFlowSnapshot {
  symbol: string;
  window: string;
  generatedAt: number;
  /** total venue yang SEDANG streaming trades untuk simbol ini. */
  venuesTrading: number;
  venuesExpected: number;
  cvd: {
    allVenues: number;
    spotSum: number;
    perpSum: number;
    perVenue: { venue: string; label: string; color: string; delta: number; buyUsd: number; sellUsd: number }[];
  };
  series: CvdSeries[];
  priceSeries: { t: number; v: number }[];
  aggression: AggressionRow[];
  teamRead: {
    timeframe: "15M" | "1H";
    priceChangePct: number | null;
    allVenueCvdDelta: number;
    spotCvd: number;
    perpCvd: number;
    buySharePct: number | null;
    engineStructure: StructureState;
    flowVsPrice: string;
  }[];
  marketStats: MarketStats | null;
  historyMinutes: number;
}

// ── State internal ───────────────────────────────────────────────────────────

interface VenueSymbolState {
  venue: VenueId;
  symbol: string;
  secBuy: TimeRing;
  secSell: TimeRing;
  secTrades: TimeRing;
  minBuy: TimeRing;
  minSell: TimeRing;
  minTrades: TimeRing;
  /** akumulator detik berjalan (dflush tiap tick 1 dtk). */
  pendBuy: number;
  pendSell: number;
  pendTrades: number;
  pendSec: number;
  /** akumulator menit berjalan. */
  mBuy: number;
  mSell: number;
  mTrades: number;
  mMinute: number;
  lastPrice: number | null;
  lastTradeAt: number;
  /** TAHAP 6B: waktu trade terakhir DITERIMA proses (bukan waktu event bursa). */
  lastTradeReceivedAt: number | null;
  tradeCount: number;
}

interface TierSymbolState {
  /** buy per tier per menit. */
  tierBuy: TimeRing[];
  tierSell: TimeRing[];
  tierTrades: TimeRing[];
  /** total kumulatif sejak start (untuk window 7d ketika retensi menit habis). */
  cumBuy: number[];
  cumSell: number[];
  cumTrades: number[];
  pendBuy: number[];
  pendSell: number[];
  pendTrades: number[];
  pendMinute: number;
}

interface SymbolState {
  symbol: string;
  structure: StructureTracker;
  lastPrice: number | null;
  /**
   * 24 Okt 2026 — seri harga 1 sampel/detik (bukan per transaksi).
   * Lihat priceHistory.ts untuk alasannya.
   */
  priceHistory: PriceHistory;
  tradesIngested: number;
}

interface HlCtx {
  coin: string;
  dayNtlVlm: number | null;
  funding: number | null;
  openInterest: number | null;
  markPx: number | null;
  midPx: number | null;
  prevDayPx: number | null;
  oraclePx: number | null;
  premium: number | null;
  updatedAt: number;
}

interface BinanceBook {
  symbol: string;
  lastUpdateId: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  /** Snapshot mutlak top-20 dari stream `@depth20@100ms` (fallback/freshness). */
  topBids: Map<number, number>;
  topAsks: Map<number, number>;
  synced: boolean;
  pendingDiffs: any[];
  lastEventTime: number;
  lastUpdateAt: number;
}

const key = (venue: VenueId, symbol: string) => `${venue}|${symbol}`;

// ── Parser per venue (diekspor untuk unit test) ──────────────────────────────

/**
 * 25 Okt 2026 — normalisasi waktu event dipakai SEMUA parser venue.
 *
 * Setiap bursa memakai satuan berbeda (ms / ns / ISO-8601) dan tidak ada
 * satu pun yang menyebut satuan itu di payload. Lihat eventTime.ts untuk
 * bukti live & dampak bila satuan salah (KuCoin ns mengunci priceHistory).
 *
 * `now` di-inject supaya test deterministik (tidak bergantung jam sistem).
 */
export interface ParsedTrade {
  symbol: string;
  takerSide: "BUY" | "SELL";
  price: number;
  qty: number;
  time: number;
}

/** Penanda waktu tidak valid (epoch-detik negatif). */
const INVALID_TRADE_TIME = -1;

/**
 * Ambil epoch-ms dari field timestamp mentah bursa.
 *
 * Return -1 sebagai PENANDA "waktu di luar rentang -> buang transaksi ini".
 * Penting: transaksi basi TIDAK boleh dipindahkan ke window sekarang
 * (memindahkan = memalsukan data). Missing/unparseable saja yang memakai
 * fallback `now`, karena saat itu waktu sebenarnya memang tidak diketahui.
 */
function eventTimeMs(raw: unknown, now: number): number {
  const r = normalizeEventTime(raw, now);
  if (r.t != null) return r.t;
  return r.outOfRange ? INVALID_TRADE_TIME : now;
}

/** Binance aggTrade (spot & futures). `m` = buyer is market maker. */
export function parseBinanceAggTrade(msg: any, venue: VenueId, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.e !== "aggTrade" && msg.e !== "trade") return [];
  const price = Number(msg.p);
  const qty = Number(msg.q);
  if (!(price > 0) || !(qty > 0)) return [];
  const takerSide: "BUY" | "SELL" = msg.m === true ? "SELL" : "BUY";
  return [{ symbol: baseFromVenueSymbol(venue, String(msg.s ?? "")), takerSide, price, qty, time: eventTimeMs(msg.T ?? msg.E, now) }];
}

/** Hyperliquid trades. Payload: {channel:"trades", data:[{coin,side,px,sz,time}]}. */
export function parseHyperliquidTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.channel !== "trades" || !Array.isArray(msg.data)) return [];
  const out: ParsedTrade[] = [];
  for (const t of msg.data) {
    const price = Number(t.px);
    const qty = Number(t.sz);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(t.coin ?? "").toUpperCase(),
      takerSide: t.side === "B" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(t.time, now),
    });
  }
  return out;
}

/** Coinbase matches. `side` adalah MAKER side -> dibalik. */
export function parseCoinbaseMatches(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.type !== "match" && msg.type !== "last_match") return [];
  const price = Number(msg.price);
  const qty = Number(msg.size);
  if (!(price > 0) || !(qty > 0)) return [];
  const takerSide: "BUY" | "SELL" = msg.side === "sell" ? "BUY" : "SELL";
  return [{ symbol: String(msg.product_id ?? "").split("-")[0]!.toUpperCase(), takerSide, price, qty, time: eventTimeMs(msg.time, now) }];
}

/** Bybit v5 publicTrade. */
export function parseBybitTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.type !== "snapshot" && msg.type !== "delta") return [];
  const rows = Array.isArray(msg.data) ? msg.data : [];
  const out: ParsedTrade[] = [];
  for (const r of rows) {
    const price = Number(r.p);
    const qty = Number(r.v);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(r.s ?? "").replace(/USDT$|USDC$/, "").toUpperCase(),
      takerSide: r.S === "Buy" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(r.T, now),
    });
  }
  return out;
}

/** OKX v5 trades. */
export function parseOkxTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || !Array.isArray(msg.data)) return [];
  const out: ParsedTrade[] = [];
  for (const r of msg.data) {
    const price = Number(r.px);
    const qty = Number(r.sz);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(r.instId ?? "").split("-")[0]!.toUpperCase(),
      takerSide: r.side === "buy" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(r.ts, now),
    });
  }
  return out;
}

/** Gate.io v4 spot.trades. */
export function parseGateTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.channel !== "spot.trades" || !msg.result) return [];
  const rows = Array.isArray(msg.result) ? msg.result : [msg.result];
  const out: ParsedTrade[] = [];
  for (const r of rows) {
    const price = Number(r.price);
    const qty = Number(r.amount);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(r.currency_pair ?? "").split("_")[0]!.toUpperCase(),
      takerSide: r.side === "buy" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(r.create_time_ms ?? r.create_time, now),
    });
  }
  return out;
}

/** Bitget v2 public trade. */
export function parseBitgetTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || !Array.isArray(msg.data)) return [];
  const out: ParsedTrade[] = [];
  for (const r of msg.data) {
    const price = Number(r.price);
    const qty = Number(r.size);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(r.instId ?? msg.arg?.instId ?? "").replace(/USDT$|USDC$/, "").toUpperCase(),
      takerSide: r.side === "buy" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(r.ts, now),
    });
  }
  return out;
}

/**
 * KuCoin /market/match.
 *
 * 25 Okt 2026 — SATU-SATUNYA venue yang mengirim NANOsecond (probe live:
 * "1792902798229000000" untuk peristiwa pada 1792902798229 ms). Parser
 * lama `Number(r.time)` memperlakukannya sebagai ms dan mengunci
 * priceHistory di masa depan. Sekarang lewat normalizeEventTime() yang
 * mendeteksi satuan.
 */
export function parseKucoinTrades(msg: any, now: number = Date.now()): ParsedTrade[] {
  if (!msg || msg.type !== "message" || !msg.data) return [];
  const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
  const out: ParsedTrade[] = [];
  for (const r of rows) {
    const price = Number(r.price);
    const qty = Number(r.size);
    if (!(price > 0) || !(qty > 0)) continue;
    out.push({
      symbol: String(r.symbol ?? "").split("-")[0]!.toUpperCase(),
      takerSide: r.side === "buy" ? "BUY" : "SELL",
      price,
      qty,
      time: eventTimeMs(r.time, now),
    });
  }
  return out;
}

// ── Parser book ──────────────────────────────────────────────────────────────

export interface ParsedBook {
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

export function parseHyperliquidBook(msg: any): ParsedBook | null {
  if (!msg || msg.channel !== "l2Book" || !msg.data) return null;
  const d = msg.data;
  if (!Array.isArray(d.levels)) return null;
  const conv = (arr: any[]) => (arr ?? []).map((l) => ({ price: Number(l.px), qty: Number(l.sz) })).filter((l) => l.price > 0 && l.qty > 0);
  return { bids: conv(d.levels[0] ?? []), asks: conv(d.levels[1] ?? []) };
}

/** Hyperliquid activeAssetCtx. Payload: {channel:"activeAssetCtx", data:{coin, ctx}}. */
export function parseHyperliquidCtx(msg: any): { coin: string; ctx: any } | null {
  if (!msg || msg.channel !== "activeAssetCtx" || !msg.data) return null;
  const coin = String(msg.data.coin ?? "").toUpperCase();
  if (!coin || !msg.data.ctx) return null;
  return { coin, ctx: msg.data.ctx };
}

// ── Hub ──────────────────────────────────────────────────────────────────────

class MultiVenueOrderFlowHub {
  private started = false;
  private links = new Map<VenueId, ResilientWs>();
  private states = new Map<string, VenueSymbolState>();
  private tierStates = new Map<string, TierSymbolState>();
  private symbolStates = new Map<string, SymbolState>();
  private hlCtx = new Map<string, HlCtx>();
  private books = new Map<string, BinanceBook>();
  private oiHistory = new Map<string, { t: number; oi: number }[]>();
  private ticker: NodeJS.Timeout | null = null;
  private hlInfoTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private tradeSeq = 0;
  /**
   * 25 Okt 2026 — jumlah transaksi yang dibuang karena waktunya di luar
   * rentang (satuan waktu salah / jam bursa menyimpang). Diekspos supaya
   * operator bisa membedakan "tidak ada trade" dari "trade dibuang".
   */
  private droppedInvalidTime = 0;
  private tape = new Map<string, TapeTrade[]>();
  /** Buffer trade besar global (>= $10K) untuk feed Panel 4. */
  private largeTape: TapeTrade[] = [];
  /** minute key untuk flush tier. */
  private lastTierMinute = 0;
  /** Listener SSE. */
  private listeners = new Set<(snapshot: OrderFlowSnapshot) => void>();
  /** Listener trade (semua trade, termasuk < $10K). */
  private tradeListeners = new Set<(trade: TapeTrade) => void>();
  /** Antrean seed book Binance Futures (REST) — dijadwalkan, bukan dadakan. */
  private bookSeedQueue: string[] = [];
  private bookSeedBusy = false;
  private bookSeedTimer: NodeJS.Timeout | null = null;
  /** Sisa waktu blokir REST (ms) setelah kena 418/429. */
  private bookSeedBlockedUntil = 0;
  /** Backoff blokir REST (ms) — naik setiap kena, reset saat sukses. */
  private bookSeedBackoffMs = 60_000;
  private okxPingTimer: NodeJS.Timeout | null = null;
  private kucoinTokenTimer: NodeJS.Timeout | null = null;
  private kucoinRetryTimer: NodeJS.Timeout | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    for (const s of TRACKED_SYMBOLS) this.ensureSymbol(s);

    this.connectBinanceFutures();
    this.connectBinanceSpot();
    this.connectHyperliquid();
    this.connectCoinbase();
    this.connectBybit("BYBIT_PERP", "wss://stream.bybit.com/v5/public/linear");
    this.connectBybit("BYBIT_SPOT", "wss://stream.bybit.com/v5/public/spot");
    this.connectOkx();
    this.connectGate();
    this.connectBitget();
    this.connectKucoin();

    // Flush agregat per-detik + cek staleness.
    this.ticker = setInterval(() => this.flushSecond(), 1000);
    // Refresh konteks aset Hyperliquid (OI & volume) tiap 5 dtk.
    this.hlInfoTimer = setInterval(() => void this.refreshHyperliquidInfo(), 5000);
    void this.refreshHyperliquidInfo();
    logger.info({ venues: this.links.size, symbols: TRACKED_SYMBOLS.length }, "MULTI_VENUE_HUB_STARTED");
  }

  stop(): void {
    this.started = false;
    for (const l of this.links.values()) l.stop();
    this.links.clear();
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.hlInfoTimer) { clearTimeout(this.hlInfoTimer); this.hlInfoTimer = null; }
    if (this.bookSeedTimer) { clearInterval(this.bookSeedTimer); this.bookSeedTimer = null; }
    if (this.okxPingTimer) { clearInterval(this.okxPingTimer); this.okxPingTimer = null; }
    if (this.kucoinTokenTimer) { clearInterval(this.kucoinTokenTimer); this.kucoinTokenTimer = null; }
    if (this.kucoinRetryTimer) { clearTimeout(this.kucoinRetryTimer); this.kucoinRetryTimer = null; }
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  private ensureSymbol(symbol: string): SymbolState {
    const s = symbol.toUpperCase();
    let st = this.symbolStates.get(s);
    if (!st) {
      st = { symbol: s, structure: new StructureTracker(), lastPrice: null, priceHistory: new PriceHistory(PRICE_HISTORY_WINDOW_MS), tradesIngested: 0 };
      this.symbolStates.set(s, st);
    }
    return st;
  }

  private ensureVenueSymbol(venue: VenueId, symbol: string): VenueSymbolState {
    const k = key(venue, symbol);
    let st = this.states.get(k);
    if (!st) {
      st = {
        venue, symbol,
        secBuy: new TimeRing(SEC_CAPACITY),
        secSell: new TimeRing(SEC_CAPACITY),
        secTrades: new TimeRing(SEC_CAPACITY),
        minBuy: new TimeRing(MIN_CAPACITY),
        minSell: new TimeRing(MIN_CAPACITY),
        minTrades: new TimeRing(MIN_CAPACITY),
        pendBuy: 0, pendSell: 0, pendTrades: 0, pendSec: 0,
        mBuy: 0, mSell: 0, mTrades: 0, mMinute: 0,
        lastPrice: null, lastTradeAt: 0, lastTradeReceivedAt: null, tradeCount: 0,
      };
      this.states.set(k, st);
    }
    return st;
  }

  private ensureTierState(symbol: string): TierSymbolState {
    const s = symbol.toUpperCase();
    let st = this.tierStates.get(s);
    if (!st) {
      const mk = () => ({ tierBuy: [], tierSell: [], tierTrades: [], cumBuy: [], cumSell: [], cumTrades: [], pendBuy: [], pendSell: [], pendTrades: [], pendMinute: 0 });
      st = { ...mk() } as TierSymbolState;
      for (let i = 0; i < 5; i++) {
        st.tierBuy.push(new TimeRing(MIN_CAPACITY));
        st.tierSell.push(new TimeRing(MIN_CAPACITY));
        st.tierTrades.push(new TimeRing(MIN_CAPACITY));
        st.cumBuy.push(0); st.cumSell.push(0); st.cumTrades.push(0);
        st.pendBuy.push(0); st.pendSell.push(0); st.pendTrades.push(0);
      }
      this.tierStates.set(s, st);
    }
    return st;
  }

  // ── Ingest trade ──────────────────────────────────────────────────────────

  private ingest(venue: VenueId, t: ParsedTrade): void {
    const meta = VENUE_BY_ID[venue];
    const symbol = t.symbol.toUpperCase();
    if (!symbol || !TRACKED_SYMBOLS.includes(symbol)) return;
    const usd = t.price * t.qty;
    if (!(usd > 0) || !Number.isFinite(usd)) return;

    const time = t.time || Date.now();
    // 25 Okt 2026 — buang transaksi yang waktunya di luar rentang (satuan
    // salah / jam bursa menyimpang). Memindahkan transaksi basi ke "sekarang"
    // berarti memalsukan posisi dalam window — data palsu lebih buruk
    // daripada data yang hilang, dan operator harus bisa membedakan
    // "tidak ada trade" dari "trade dibuang".
    if (time < 0) {
      this.droppedInvalidTime += 1;
      return;
    }
    const sec = Math.floor(time / 1000);
    const min = Math.floor(time / 60000);

    const vs = this.ensureVenueSymbol(venue, symbol);
    // Bucket per-detik: flush bucket lama HANYA saat bucket baru dimulai
    // (detik lebih besar) atau lewat tick 1 dtk — bukan setiap tick, supaya
    // nilai yang sudah tertulis tidak tertimpa nol.
    if (vs.pendSec === 0) {
      vs.pendSec = sec;
    } else if (sec > vs.pendSec) {
      this.flushVenueSecond(vs);
      vs.pendSec = sec;
    } else if (sec < vs.pendSec) {
      // Trade terlambat (clock drift bursa): tulis langsung ke slot aslinya.
      // JANGAN ikut akumulator pending di bawah — akumulator itu akan di-flush
      // ke bucket pendSec, sehingga trade yang sama terhitung DUA KALI di dua
      // detik berbeda (bug 25 Okt 2026, scan sistem: 3 trade -> totalUsd 29
      // seharusnya 22; trades 4 seharusnya 3).
      if (t.takerSide === "BUY") vs.secBuy.add(sec, usd); else vs.secSell.add(sec, usd);
      vs.secTrades.add(sec, 1);
    }
    if (sec >= vs.pendSec) {
      if (t.takerSide === "BUY") vs.pendBuy += usd; else vs.pendSell += usd;
      vs.pendTrades += 1;
    }
    vs.lastPrice = t.price;
    vs.lastTradeAt = time;
    // TAHAP 6B: waktu terima (waktu lokal) dicatat terpisah dari waktu event
    // bursa, supaya delay feed terlihat dan tidak disamarkan.
    vs.lastTradeReceivedAt = Date.now();
    vs.tradeCount += 1;

    // Bucket per-menit (agregat window panjang).
    if (vs.mMinute === 0) {
      vs.mMinute = min;
    } else if (min > vs.mMinute) {
      this.flushVenueMinute(vs);
      vs.mMinute = min;
    }
    if (t.takerSide === "BUY") vs.mBuy += usd; else vs.mSell += usd;
    vs.mTrades += 1;

    // Tier agregat lintas venue (ritel ikut dihitung).
    const tierIdx = ["MEGA", "WHALE", "LARGE", "MEDIUM", "SMALL"].indexOf(flowTier(usd));
    const ts = this.ensureTierState(symbol);
    if (ts.pendMinute === 0) {
      ts.pendMinute = min;
    } else if (min > ts.pendMinute) {
      this.flushTierMinute(ts);
      ts.pendMinute = min;
    }
    if (t.takerSide === "BUY") { ts.pendBuy[tierIdx]! += usd; ts.cumBuy[tierIdx]! += usd; }
    else { ts.pendSell[tierIdx]! += usd; ts.cumSell[tierIdx]! += usd; }
    ts.pendTrades[tierIdx]! += 1;
    ts.cumTrades[tierIdx]! += 1;

    // Struktur harga & price history.
    const sym = this.ensureSymbol(symbol);
    sym.lastPrice = t.price;
    sym.tradesIngested += 1;
    sym.structure.push(t.price, time);

    // 24 Okt 2026 (PERFORMA — akar masalah "lambat banget"):
    // priceHistory SEBELUMNYA menyimpan SATU objek {t,v} PER TRANSAKSI. Dengan
    // ~280 transaksi/detik dari 10 venue, sesi 2 jam sudah menampung ~2 JUTA
    // objek per simbol — semuanya hidup di old-space V8. Akibatnya:
    //   - major GC (mark-compact) harus menelusuri 2 juta objek tiap siklus,
    //     dan karena heap ~= 1 GB (box ini cuma 1.9 GB RAM) setiap pencetakan
    //     major GC memicu page fault ke swap -> disk I/O -> 105 GB read_bytes;
    //   - priceSeriesFor()/priceChangePct() memindai SELURUH array tiap
    //     snapshot (O(n) = 2 juta iterasi) — dijalankan per klien SSE tiap
    //     1.5 detik, hasilnya /api/orderflow/BTC butuh 51 detik;
    //   - seri harga terkirim ke browser jadi 3.941 titik dengan 1.852
    //     DUPLIKAT timestamp (semua transaksi dlm 1 detik ikut ter-push).
    // Perbaikan: PriceHistory menyimpan 1 sampel per DETIK (lihat
    // priceHistory.ts). Harga chart tidak butuh resolusi per-transaksi;
    // 1 Hz sudah melebihi resolusi seri CVD (yang juga 1 Hz).
    sym.priceHistory.push(time, t.price);

    // Tape.
    const trade: TapeTrade = {
      id: ++this.tradeSeq,
      t: time, venue, symbol, market: meta.market,
      takerSide: t.takerSide, price: t.price, qty: t.qty, usd,
      tier: flowTier(usd),
      largeTier: usd >= 10_000
        ? (usd >= 1_000_000 ? "MEGA" : usd >= 500_000 ? "WHALE" : usd >= 100_000 ? "LARGE" : usd >= 50_000 ? "MEDIUM" : "SMALL")
        : null,
    };
    // Notifikasi konsumen (volume profile, tier flow) untuk SETIAP trade —
    // bukan hanya yang besar.
    for (const l of this.tradeListeners) { try { l(trade); } catch { /* noop */ } }
    if (trade.largeTier) {
      const arr = this.tape.get(symbol) ?? [];
      arr.push(trade);
      if (arr.length > LARGE_TAPE_PER_SYMBOL) arr.splice(0, arr.length - LARGE_TAPE_PER_SYMBOL);
      this.tape.set(symbol, arr);
      this.largeTape.push(trade);
      if (this.largeTape.length > LARGE_TAPE_GLOBAL) this.largeTape.splice(0, this.largeTape.length - LARGE_TAPE_GLOBAL);
    }
  }

  private flushVenueSecond(vs: VenueSymbolState): void {
    if (vs.pendSec === 0) return;
    vs.secBuy.set(vs.pendSec, vs.pendBuy);
    vs.secSell.set(vs.pendSec, vs.pendSell);
    vs.secTrades.set(vs.pendSec, vs.pendTrades);
    vs.pendBuy = 0; vs.pendSell = 0; vs.pendTrades = 0;
    vs.pendSec = 0; // bucket ditutup — jangan ditulis ulang dengan 0
  }

  private flushVenueMinute(vs: VenueSymbolState): void {
    if (vs.mMinute === 0) return;
    vs.minBuy.set(vs.mMinute, vs.mBuy);
    vs.minSell.set(vs.mMinute, vs.mSell);
    vs.minTrades.set(vs.mMinute, vs.mTrades);
    vs.mBuy = 0; vs.mSell = 0; vs.mTrades = 0;
    vs.mMinute = 0;
  }

  private flushTierMinute(ts: TierSymbolState): void {
    if (ts.pendMinute === 0) return;
    for (let i = 0; i < 5; i++) {
      ts.tierBuy[i]!.set(ts.pendMinute, ts.pendBuy[i]!);
      ts.tierSell[i]!.set(ts.pendMinute, ts.pendSell[i]!);
      ts.tierTrades[i]!.set(ts.pendMinute, ts.pendTrades[i]!);
      ts.pendBuy[i] = 0; ts.pendSell[i] = 0; ts.pendTrades[i] = 0;
    }
    ts.pendMinute = 0;
  }

  /** Tick 1 detik: tutup bucket yang sudah lewat. */
  private flushSecond(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const vs of this.states.values()) {
      if (vs.pendSec !== 0 && nowSec > vs.pendSec) this.flushVenueSecond(vs);
      if (vs.mMinute !== 0 && Math.floor(nowSec / 60) > vs.mMinute) this.flushVenueMinute(vs);
    }
    const nowMin = Math.floor(Date.now() / 60000);
    for (const ts of this.tierStates.values()) {
      if (ts.pendMinute !== 0 && nowMin > ts.pendMinute) this.flushTierMinute(ts);
    }
    this.lastTierMinute = nowMin;
  }

  // ── Koneksi venue ─────────────────────────────────────────────────────────

  private register(venue: VenueId, link: ResilientWs): void {
    this.links.set(venue, link);
    link.start();
  }

  private connectBinanceFutures(): void {
    const syms = symbolsFor("BINANCE_PERP");
    // PENTING (diverifikasi live 24 Okt 2026): di USD-M Futures stream
    // `<sym>@aggTrade` TIDAK mengirim apa-apa (nol pesan). Stream yang
    // benar adalah `<sym>@trade` — payload-nya tetap punya flag maker `m`
    // (m===true -> taker SELL, m===false -> taker BUY) seperti spesifikasi.
    // Stream Binance SPOT memakai `@aggTrade` dan itu berfungsi normal.
    const tradeStreams = syms.map((s) => `${s.toLowerCase()}usdt@trade`).join("/");
    // Book: diff L2 penuh + top-20 (fallback saat REST kena rate-limit).
    // Hanya untuk simbol "history" supaya beban CPU/RAM wajar.
    const bookSyms = syms.filter((s) => HIST.has(s));
    const diffStreams = bookSyms.map((s) => `${s.toLowerCase()}usdt@depth@100ms`).join("/");
    const topStreams = bookSyms.map((s) => `${s.toLowerCase()}usdt@depth20@100ms`).join("/");
    const url = `wss://fstream.binance.com/stream?streams=${[tradeStreams, diffStreams, topStreams].filter(Boolean).join("/")}`;
    const link = new ResilientWs({
      name: "BINANCE_PERP",
      url,
      idleTimeoutMs: 45_000,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ArtaTrade/1.0" },
      onOpen: () => {
        // Seed book via REST — DIJADWALKAN (1 simbol per tick), bukan dadakan.
        this.requestBookSeed(bookSyms);
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        const d = msg.data ?? msg;
        if (!d || typeof d !== "object") return;
        const stream = String(msg.stream ?? "");
        if (d.e === "aggTrade" || d.e === "trade") {
          for (const t of parseBinanceAggTrade(d, "BINANCE_PERP")) this.ingest("BINANCE_PERP", t);
        } else if (d.e === "depthUpdate") {
          // PENTING: sejak update Binance, stream `@depth20@100ms` juga
          // mengirim event "depthUpdate" (bukan snapshot absolut terpisah).
          // Karena itu routing WAJIB memakai nama stream, bukan bentuk payload.
          if (stream.includes("@depth20@")) {
            this.applyBinanceTop20(stream.split("@")[0]?.toUpperCase() ?? "", d);
          } else {
            this.applyBinanceDiff(d);
          }
        } else if (Array.isArray(d.bids) && Array.isArray(d.asks)) {
          this.applyBinanceTop20(stream.split("@")[0]?.toUpperCase() ?? "", d);
        }
      },
    });
    this.register("BINANCE_PERP", link);
    // Pompa seed 1 simbol per tick supaya tidak membanjiri REST.
    this.bookSeedTimer = setInterval(() => this.pumpBookSeeds(), 9_000);
  }

  private connectBinanceSpot(): void {
    const syms = symbolsFor("BINANCE_SPOT");
    const streams = syms.map((s) => `${s.toLowerCase()}usdt@aggTrade`).join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    const link = new ResilientWs({
      name: "BINANCE_SPOT",
      url,
      idleTimeoutMs: 45_000,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ArtaTrade/1.0" },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        const d = msg.data ?? msg;
        if (!d) return;
        if (d.e === "aggTrade" || d.e === "trade") {
          for (const t of parseBinanceAggTrade(d, "BINANCE_SPOT")) this.ingest("BINANCE_SPOT", t);
        }
      },
    });
    this.register("BINANCE_SPOT", link);
  }

  private connectHyperliquid(): void {
    const coins = symbolsFor("HYPERLIQUID");
    const link = new ResilientWs({
      name: "HYPERLIQUID",
      url: "wss://api.hyperliquid.xyz/ws",
      idleTimeoutMs: 45_000,
      onOpen: (ws) => {
        // Format WAJIB: {method:"subscribe", subscription:{type, coin}}.
        // Format datar {"type":"trades","coin":"BTC"} DITOLAK bursa.
        for (const c of coins) {
          ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: c } }));
          ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: c } }));
          ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: c } }));
        }
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.channel === "trades") {
          for (const t of parseHyperliquidTrades(msg)) this.ingest("HYPERLIQUID", t);
        } else if (msg.channel === "l2Book") {
          const book = parseHyperliquidBook(msg);
          if (book) {
            this.publishBook("HYPERLIQUID", String(msg.data?.coin ?? "").toUpperCase(), book, Number(msg.data?.time ?? Date.now()));
          }
        } else if (msg.channel === "activeAssetCtx") {
          const parsed = parseHyperliquidCtx(msg);
          if (parsed) this.updateHlCtx(parsed.coin, parsed.ctx);
        }
      },
    });
    this.register("HYPERLIQUID", link);
  }

  private updateHlCtx(coin: string, ctx: any): void {
    const c = String(coin ?? "").toUpperCase();
    if (!c) return;
    const num = (v: any): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    this.hlCtx.set(c, {
      coin: c,
      dayNtlVlm: num(ctx.dayNtlVlm),
      funding: num(ctx.funding),
      openInterest: num(ctx.openInterest),
      markPx: num(ctx.markPx),
      midPx: num(ctx.midPx),
      prevDayPx: num(ctx.prevDayPx),
      oraclePx: num(ctx.oraclePx),
      premium: num(ctx.premium),
      updatedAt: Date.now(),
    });
    const oi = num(ctx.openInterest);
    if (oi != null) {
      const arr = this.oiHistory.get(c) ?? [];
      arr.push({ t: Date.now(), oi });
      while (arr.length && arr[0]!.t < Date.now() - 3 * 3600_000) arr.shift();
      this.oiHistory.set(c, arr);
    }
  }

  private async refreshHyperliquidInfo(): Promise<void> {
    try {
      const r = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return;
      const j: any = await r.json();
      const meta = j?.[0];
      const ctxs = j?.[1];
      if (!meta?.universe || !Array.isArray(ctxs)) return;
      for (let i = 0; i < meta.universe.length; i++) {
        const u = meta.universe[i];
        const ctx = ctxs[i];
        if (!u?.name || !ctx) continue;
        const coin = String(u.name).toUpperCase();
        if (!TRACKED_SYMBOLS.includes(coin)) continue;
        this.updateHlCtx(coin, {
          dayNtlVlm: ctx.dayNtlVlm, funding: ctx.funding, openInterest: ctx.openInterest,
          markPx: ctx.markPx, midPx: ctx.midPx, prevDayPx: ctx.prevDayPx,
          oraclePx: ctx.oraclePx, premium: ctx.premium,
        });
      }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "HL metaAndAssetCtxs gagal");
    }
  }

  private connectCoinbase(): void {
    const products = symbolsFor("COINBASE").map((s) => `${s}-USD`);
    const link = new ResilientWs({
      name: "COINBASE",
      url: "wss://ws-feed.exchange.coinbase.com",
      idleTimeoutMs: 90_000,
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: "subscribe", product_ids: products, channels: ["matches"] }));
        ws.send(JSON.stringify({ type: "subscribe", channels: ["heartbeat"] }));
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "match" || msg.type === "last_match") {
          for (const t of parseCoinbaseMatches(msg)) this.ingest("COINBASE", t);
        }
      },
    });
    this.register("COINBASE", link);
  }

  private connectBybit(venue: "BYBIT_PERP" | "BYBIT_SPOT", url: string): void {
    const syms = symbolsFor(venue);
    const link = new ResilientWs({
      name: venue,
      url,
      idleTimeoutMs: 60_000,
      onOpen: (ws) => {
        // PER SIMBOL: kalau satu simbol tidak dikenal, bursa menolak HANYA
        // subscribe itu — seluruh batch tidak ikut mati.
        for (const s of syms) {
          ws.send(JSON.stringify({ op: "subscribe", args: [`publicTrade.${s}USDT`] }));
        }
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.op === "subscribe" && msg.success === false) {
          logger.debug({ venue, arg: msg.req_msg }, "BYBIT subscribe ditolak");
          return;
        }
        for (const t of parseBybitTrades(msg)) this.ingest(venue, t);
      },
    });
    this.register(venue, link);
  }

  private connectOkx(): void {
    const syms = symbolsFor("OKX");
    const link = new ResilientWs({
      name: "OKX",
      url: "wss://ws.okx.com:8443/ws/v5/public",
      idleTimeoutMs: 60_000,
      onOpen: (ws) => {
        for (const s of syms) {
          ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: `${s}-USDT` }] }));
        }
        ws.send("ping");
      },
      onMessage: (raw) => {
        if (raw === "pong") return;
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.event) return; // ack subscribe
        for (const t of parseOkxTrades(msg)) this.ingest("OKX", t);
      },
    });
    this.register("OKX", link);
    this.okxPingTimer = setInterval(() => { link.send("ping"); }, 20_000);
  }

  private connectGate(): void {
    const pairs = symbolsFor("GATE").map((s) => `${s}_USDT`);
    const link = new ResilientWs({
      name: "GATE",
      url: "wss://api.gateio.ws/ws/v4/",
      idleTimeoutMs: 60_000,
      onOpen: (ws) => {
        // PER PASANG: Gate menolak SELURUH subscribe bila satu pair invalid.
        for (const p of pairs) {
          ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.trades", event: "subscribe", payload: [p] }));
        }
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.event === "subscribe" || msg.channel === "spot.pong") return;
        for (const t of parseGateTrades(msg)) this.ingest("GATE", t);
      },
    });
    this.register("GATE", link);
  }

  private connectBitget(): void {
    const syms = symbolsFor("BITGET");
    const link = new ResilientWs({
      name: "BITGET",
      url: "wss://ws.bitget.com/v2/ws/public",
      idleTimeoutMs: 60_000,
      // WAJIB: Bitget v2 membalas string polos "pong" — BUKAN JSON.
      // Format v1 `{"op":"ping"}` DITOLAK bursa dengan error 30002
      // ("Unrecognized request"), dan socket akhirnya ditutup paksa (1006)
      // secara berkala. Bukti A/B live 25 Okt 2026 (probe 240 dtk):
      //   mode "op"  -> CLOSED code=1006 di +122.4s, pong=0
      //   mode "raw" -> masih terbuka di +240s, pong=11, 152 trade
      // Bandingkan tools/probe-bitget-ws-close.ts.
      heartbeatMs: 25_000,
      heartbeatPayload: "ping",
      onOpen: (ws) => {
        for (const s of syms) {
          ws.send(JSON.stringify({ op: "subscribe", args: [{ instType: "SPOT", channel: "trade", instId: `${s}USDT` }] }));
        }
      },
      onMessage: (raw) => {
        if (raw === "pong") return;
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.event) return;
        for (const t of parseBitgetTrades(msg)) this.ingest("BITGET", t);
      },
    });
    this.register("BITGET", link);
  }

  private connectKucoin(): void {
    // KuCoin MENOLAK koneksi tanpa token bullet-public yang valid. Token
    // harus diambil DULU, baru socket dibuka (bukan sebaliknya).
    const state = { token: null as string | null, endpoint: "wss://ws-api-spot.kucoin.com/endpoint" };
    // Catatan: `endpoint` bursa sudah berisi skema; path WS tetap "/endpoint".
    const link = new ResilientWs({
      name: "KUCOIN",
      url: () => (state.token ? `${state.endpoint}?token=${encodeURIComponent(state.token)}` : state.endpoint),
      idleTimeoutMs: 90_000,
      // KuCoin MEMUTUS koneksi (code 1000 "Bye") 60 detik setelah connect
      // bila tidak menerima ping dari client — walau trade terus mengalir
      // (probe live 25 Okt 2026: apps/server/tools/probe-kucoin-ws-close.ts,
      // tanpa ping = CLOSED +60.5s, dengan ping 20s = tetap terbuka).
      heartbeatMs: 20_000,
      heartbeatPayload: () => ({ id: `at-ping-${Date.now()}`, type: "ping" }),
      onOpen: (ws) => {
        for (const s of symbolsFor("KUCOIN")) {
          ws.send(JSON.stringify({
            id: `at-${s}`, type: "subscribe", topic: `/market/match:${s}-USDT`,
            privateChannel: false, response: true,
          }));
        }
      },
      onMessage: (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "ack" || msg.type === "pong" || msg.type === "welcome") return;
        for (const t of parseKucoinTrades(msg)) this.ingest("KUCOIN", t);
      },
    });
    this.links.set("KUCOIN", link);
    void this.primeKucoin(state, link);
  }

  /** Ambil bullet-public token, baru sambung; perbarui token berkala. */
  private async primeKucoin(
    state: { token: string | null; endpoint: string },
    link: ResilientWs,
  ): Promise<void> {
    const ok = await this.fetchKucoinToken(state);
    if (!ok) {
      // Coba lagi sebentar lagi — jangan tinggalkan venue mati.
      this.kucoinRetryTimer = setTimeout(() => void this.primeKucoin(state, link), 20_000);
      return;
    }
    link.start();
    // Token berlaku ~30 menit; refresh sebelum kedaluwarsa + reconnect.
    this.kucoinTokenTimer = setInterval(() => {
      void this.fetchKucoinToken(state).then((ok2) => {
        if (!ok2) return;
        link.stop();
        link.start();
      });
    }, 25 * 60_000);
  }

  private async fetchKucoinToken(
    state: { token: string | null; endpoint: string },
  ): Promise<boolean> {
    try {
      const r = await fetch("https://api.kucoin.com/api/v1/bullet-public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { logger.warn({ status: r.status }, "KUCOIN bullet-public HTTP error"); return false; }
      const j: any = await r.json();
      const token = j?.data?.token;
      const srv = j?.data?.instanceServers?.[0];
      if (!token) { logger.warn("KUCOIN bullet-public tanpa token"); return false; }
      state.token = String(token);
      if (srv?.endpoint) {
        // `endpoint` dari bursa sudah BERISI skema ("wss://ws-api-spot.kucoin.com/")
        // dan path WS adalah "/endpoint" (bukan host polos).
        let base = String(srv.endpoint);
        if (!/^wss?:\/\//i.test(base)) {
          base = `${srv.encrypt === false ? "ws" : "wss"}://${base}`;
        }
        base = base.replace(/\/+$/, "");
        state.endpoint = `${base}/endpoint`;
      }
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "KUCOIN bullet-public gagal");
      return false;
    }
  }

  // ── Book Binance Futures (REST snapshot + diff) ───────────────────────────
  //
  // REST `/fapi/v1/depth?limit=1000` berbobot 20 per permintaan. Kalau 16
  // simbol disinkronkan serentak (terutama saat reconnect), IP kena 418/429
  // dan bursa memblokir host kita. Karena itu:
  //   1. Seed BERJADWAL: satu simbol per tick (antrean, bukan dadakan).
  //   2. Circuit breaker: saat kena 418/429, REST dihentikan sementara dan
  //      backoff naik. Stream WS (aggTrade/depth/depth20) TIDAK terpengaruh.
  //   3. Fallback: stream `@depth20@100ms` memberi snapshot top-20 mutlak
  //      sehingga Panel 2 tetap hidup walau REST sedang diblokir.

  /** Masukkan simbol ke antrean seed book (dedup, Fiber lama dibuang). */
  private requestBookSeed(symbols: string[]): void {
    for (const s of symbols) {
      if (this.bookSeedQueue.includes(s)) continue;
      this.bookSeedQueue.push(s);
    }
  }

  /** Tick pompa: 1 simbol per tick, Hormati blokir & backoff. */
  private pumpBookSeeds(): void {
    if (this.bookSeedBusy) return;
    if (Date.now() < this.bookSeedBlockedUntil) return;
    const sym = this.bookSeedQueue.shift();
    if (!sym) return;
    this.bookSeedBusy = true;
    void this.syncBinanceBook(sym)
      .then((status) => {
        if (status === "ok") this.bookSeedBackoffMs = 60_000;
      })
      .finally(() => { this.bookSeedBusy = false; });
  }

  private blockBookSeed(reason: string, status: number): void {
    this.bookSeedBlockedUntil = Date.now() + this.bookSeedBackoffMs;
    this.bookSeedBackoffMs = Math.min(this.bookSeedBackoffMs * 2, 15 * 60_000);
    logger.warn({
      reason, status, blockedSec: Math.round((this.bookSeedBlockedUntil - Date.now()) / 1000),
    }, "BINANCE_REST_BLOCKED");
  }

  /**
   * Sinkronisasi book Binance Futures.
   * Return: "ok" | "ratelimited" | "fail".
   */
  private async syncBinanceBook(symbol: string): Promise<"ok" | "ratelimited" | "fail"> {
    const sym = `${symbol}USDT`;
    // 28 Okt 2026: host bernomor fapi1-3 di-geo-block dari IP ini (302 ->
    // HTML, r.json() gagal = 3 percobaan percuma tiap seed). Pakai pool REST
    // yang dikonfigurasi operator (BINANCE_REST_POOL), sama seperti restPool.
    const hosts = env.BINANCE_REST_POOL.length > 0 ? env.BINANCE_REST_POOL : ["fapi.binance.com"];
    let sawRateLimit = false;
    for (const host of hosts) {
      try {
        const r = await fetch(`https://${host}/fapi/v1/depth?symbol=${sym}&limit=1000`, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ArtaTrade/1.0" },
        });
        if (r.status === 418 || r.status === 429) {
          sawRateLimit = true;
          // Don't hammer other hosts while banned — back off.
          break;
        }
        if (!r.ok) continue;
        const j: any = await r.json();
        if (!j?.bids || !j?.asks) continue;
        const bids = new Map<number, number>();
        const asks = new Map<number, number>();
        for (const [p, q] of j.bids) { const pn = Number(p), qn = Number(q); if (pn > 0 && qn > 0) bids.set(pn, qn); }
        for (const [p, q] of j.asks) { const pn = Number(p), qn = Number(q); if (pn > 0 && qn > 0) asks.set(pn, qn); }
        const existing = this.books.get(sym);
        const lastUpdateId = Number(j.lastUpdateId) || 0;
        const book: BinanceBook = {
          symbol: sym,
          lastUpdateId,
          bids, asks,
          topBids: existing?.topBids ?? new Map<number, number>(),
          topAsks: existing?.topAsks ?? new Map<number, number>(),
          synced: true,
          pendingDiffs: existing?.pendingDiffs ?? [],
          lastEventTime: existing?.lastEventTime ?? 0,
          lastUpdateAt: Date.now(),
        };
        this.books.set(sym, book);
        // Drain diff yang ter-buffer: buang yang u < lastUpdateId, lalu
        // terapkan yang menyambung (U <= lastUpdateId <= u).
        const buffered = book.pendingDiffs;
        book.pendingDiffs = [];
        for (const ev of buffered) {
          const U = Number(ev.U ?? 0);
          const u = Number(ev.u ?? 0);
          if (u < lastUpdateId) continue;
          if (U > lastUpdateId && u > lastUpdateId) {
            // Masih ada gap -> resync lagi (antrean).
            book.synced = false;
            book.pendingDiffs = [ev];
            this.requestBookSeed([sym.replace(/USDT$/, "")]);
            break;
          }
          this.applyBinanceLevels(book, ev);
          book.lastUpdateId = u;
        }
        this.emitBinanceBook(sym);
        return "ok";
      } catch {
        // coba host berikutnya
      }
    }
    if (sawRateLimit) {
      this.blockBookSeed("binance_fapi_depth", 418);
      return "ratelimited";
    }
    return "fail";
  }

  /**
   * Partial book depth stream (`@depth20@100ms`).
   *
   * PERHATIAN: di USD-M Futures stream ini sekarang mengirim event
   * `depthUpdate` dengan array `b`/`a` yang berisi level ABSOLUT top-20
   * (bukan delta seperti stream `@depth@100ms`). Karena itu isinya di-reset
   * tiap tick — level yang keluar dari top-20 harus hilang.
   */
  private applyBinanceTop20(baseSymbol: string, d: any): void {
    const base = baseSymbol.replace(/USDT$/, "").toUpperCase();
    if (!base) return;
    const sym = `${base}USDT`;
    let book = this.books.get(sym);
    if (!book) {
      book = {
        symbol: sym, lastUpdateId: 0,
        bids: new Map<number, number>(), asks: new Map<number, number>(),
        topBids: new Map<number, number>(), topAsks: new Map<number, number>(),
        synced: false, pendingDiffs: [], lastEventTime: 0, lastUpdateAt: Date.now(),
      };
      this.books.set(sym, book);
    }
    // Bentuk payload: {bids,asks} (absolut) ATAU {b,a} (depthUpdate futures).
    const rawBids = Array.isArray(d.bids) ? d.bids : (Array.isArray(d.b) ? d.b : []);
    const rawAsks = Array.isArray(d.asks) ? d.asks : (Array.isArray(d.a) ? d.a : []);
    book.topBids.clear();
    book.topAsks.clear();
    for (const [p, q] of rawBids) {
      const pn = Number(p), qn = Number(q);
      if (pn > 0 && qn > 0) book.topBids.set(pn, qn);
    }
    for (const [p, q] of rawAsks) {
      const pn = Number(p), qn = Number(q);
      if (pn > 0 && qn > 0) book.topAsks.set(pn, qn);
    }
    book.lastUpdateAt = Date.now();
    this.emitBinanceBook(sym);
  }

  /**
   * Terapkan diff L2 dengan algoritma resmi Binance ("How to manage a local
   * order book correctly"):
   *   1. Event sebelum snapshot di-BUFFER.
   *   2. Event dengan u < lastUpdateId dibuang (ketinggalan).
   *   3. Event pertama yang dipakai harus punya U <= lastUpdateId <= u.
   *   4. Event berikutnya harus punya pu == u dari event sebelumnya; kalau
   *      tidak -> ada gap -> resync (diantrekan, tidak membanjiri REST).
   */
  private applyBinanceDiff(d: any): void {
    const sym = String(d.s ?? "");
    if (!sym) return;
    let book = this.books.get(sym);
    if (!book) {
      book = {
        symbol: sym, lastUpdateId: 0,
        bids: new Map<number, number>(), asks: new Map<number, number>(),
        topBids: new Map<number, number>(), topAsks: new Map<number, number>(),
        synced: false, pendingDiffs: [], lastEventTime: 0, lastUpdateAt: Date.now(),
      };
      this.books.set(sym, book);
    }
    if (!book.synced) {
      // Book belum ter-seed REST -> buffer event, antrean seed snapshot.
      book.pendingDiffs.push(d);
      if (book.pendingDiffs.length > 2000) book.pendingDiffs.splice(0, book.pendingDiffs.length - 2000);
      this.requestBookSeed([sym.replace(/USDT$/, "")]);
      return;
    }
    const U = Number(d.U ?? 0);
    const u = Number(d.u ?? 0);
    const pu = Number(d.pu ?? 0);
    if (u < book.lastUpdateId) return; // event lama
    if (book.lastUpdateId > 0 && pu !== book.lastUpdateId) {
      // Event tidak menyambung -> resync (antrean).
      book.synced = false;
      book.pendingDiffs = [d];
      this.requestBookSeed([sym.replace(/USDT$/, "")]);
      return;
    }
    this.applyBinanceLevels(book, d);
    book.lastUpdateId = u;
    book.lastEventTime = Number(d.E ?? Date.now());
    book.lastUpdateAt = Date.now();
    this.emitBinanceBook(sym);
  }

  private applyBinanceLevels(book: BinanceBook, d: any): void {
    for (const [p, q] of d.b ?? []) {
      const pn = Number(p), qn = Number(q);
      if (!(pn > 0)) continue;
      if (qn > 0) book.bids.set(pn, qn); else book.bids.delete(pn);
    }
    for (const [p, q] of d.a ?? []) {
      const pn = Number(p), qn = Number(q);
      if (!(pn > 0)) continue;
      if (qn > 0) book.asks.set(pn, qn); else book.asks.delete(pn);
    }
  }

  private emitBinanceBook(sym: string): void {
    const book = this.books.get(sym);
    if (!book) return;
    const base = sym.replace(/USDT$/, "");
    // Gabung book penuh (REST seed + diff) dengan top-20 mutlak (stream).
    // Top-20 selalu lebih segar -> menang bila harga sama.
    const merge = (full: Map<number, number>, top: Map<number, number>): Map<number, number> => {
      const m = new Map(full);
      for (const [p, q] of top) m.set(p, q);
      return m;
    };
    const bids: BookLevel[] = [...merge(book.bids, book.topBids).entries()]
      .sort((a, b) => b[0] - a[0]).slice(0, 100)
      .map(([price, qty]) => ({ price, qty, notionalUsd: price * qty }));
    const asks: BookLevel[] = [...merge(book.asks, book.topAsks).entries()]
      .sort((a, b) => a[0] - b[0]).slice(0, 100)
      .map(([price, qty]) => ({ price, qty, notionalUsd: price * qty }));
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    this.publishBookRaw("BINANCE_PERP", base, bids, asks, bestBid, bestAsk, mid, book.lastUpdateAt);
  }

  private publishBook(venue: VenueId, symbol: string, book: ParsedBook, time: number): void {
    const bids: BookLevel[] = book.bids.map((l) => ({ price: l.price, qty: l.qty, notionalUsd: l.price * l.qty }))
      .sort((a, b) => b.price - a.price).slice(0, 100);
    const asks: BookLevel[] = book.asks.map((l) => ({ price: l.price, qty: l.qty, notionalUsd: l.price * l.qty }))
      .sort((a, b) => a.price - b.price).slice(0, 100);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    this.publishBookRaw(venue, symbol, bids, asks, bestBid, bestAsk, mid, time || Date.now());
  }

  private bookListeners = new Set<(snap: BookSnapshot) => void>();
  private lastBook = new Map<string, BookSnapshot>();

  private publishBookRaw(
    venue: VenueId, symbol: string,
    bids: BookLevel[], asks: BookLevel[],
    bestBid: number | null, bestAsk: number | null, mid: number | null, t: number,
  ): void {
    const snap: BookSnapshot = { venue, symbol, t, bids, asks, bestBid, bestAsk, mid };
    const k = key(venue, symbol);
    this.lastBook.set(k, snap);
    for (const l of this.bookListeners) { try { l(snap); } catch { /* noop */ } }
  }

  // ── API publik untuk modul lain ───────────────────────────────────────────

  getBook(venue: VenueId, symbol: string): BookSnapshot | null {
    return this.lastBook.get(key(venue, symbol)) ?? null;
  }

  onBook(fn: (snap: BookSnapshot) => void): () => void {
    this.bookListeners.add(fn);
    return () => { this.bookListeners.delete(fn); };
  }

  onSnapshot(fn: (snapshot: OrderFlowSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Listener SETIAP trade (termasuk < $10K) — dipakai volume profile & tier flow. */
  onTrade(fn: (trade: TapeTrade) => void): () => void {
    this.tradeListeners.add(fn);
    return () => { this.tradeListeners.delete(fn); };
  }

  venueHealth(): VenueHealth[] {
    const out: VenueHealth[] = [];
    for (const v of VENUES) {
      const link = this.links.get(v.id);
      let trades = 0;
      for (const [k, st] of this.states) {
        if (k.startsWith(`${v.id}|`)) trades += st.tradeCount;
      }
      out.push({
        venue: v.id,
        label: v.label,
        connected: link?.connected ?? false,
        connects: link?.connects ?? 0,
        reconnects: link?.reconnects ?? 0,
        messages: link?.messages ?? 0,
        lastMessageAtMs: link?.lastMessageAtMs ?? 0,
        lastError: link?.lastError ?? null,
        tradesIngested: trades,
      });
    }
    return out;
  }

  getTape(symbol: string | null, minUsd: number, limit: number): TapeTrade[] {
    const src = symbol ? (this.tape.get(symbol.toUpperCase()) ?? []) : this.largeTape;
    const filtered = src.filter((t) => t.usd >= minUsd && (!symbol || t.symbol === symbol.toUpperCase()));
    return filtered.slice(-limit).reverse();
  }

  /** Akumulasi buy/sell per window (detik). */
  private windowAgg(symbol: string, windowSec: number): { buy: number; sell: number; trades: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    let buy = 0, sell = 0, trades = 0;
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, symbol));
      if (!st) continue;
      // window <= 1 jam -> pakai ring per-detik; > 1 jam -> per-menit.
      if (windowSec <= SEC_CAPACITY) {
        buy += st.secBuy.sumFrom(from);
        sell += st.secSell.sumFrom(from);
        trades += st.secTrades.sumFrom(from);
      } else {
        const fromMin = Math.floor(from / 60);
        buy += st.minBuy.sumFrom(fromMin);
        sell += st.minSell.sumFrom(fromMin);
        trades += st.minTrades.sumFrom(fromMin);
      }
    }
    return { buy, sell, trades };
  }

  /** Delta per venue untuk symbol (window detik). */
  venueDeltas(symbol: string, windowSec: number): { venue: VenueId; buy: number; sell: number }[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    const fromMin = Math.floor(from / 60);
    const out: { venue: VenueId; buy: number; sell: number }[] = [];
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, symbol));
      if (!st) continue;
      const buy = windowSec <= SEC_CAPACITY ? st.secBuy.sumFrom(from) : st.minBuy.sumFrom(fromMin);
      const sell = windowSec <= SEC_CAPACITY ? st.secSell.sumFrom(from) : st.minSell.sumFrom(fromMin);
      out.push({ venue: v.id, buy, sell });
    }
    return out;
  }

  /** Seri CVD kumulatif per venue (delta dari mulai window). */
  private cvdSeriesFor(symbol: string, windowSec: number, venueIds: VenueId[]): CvdSeries[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    const step = Math.max(1, Math.ceil(windowSec / SERIES_TARGET_POINTS));
    const out: CvdSeries[] = [];
    for (const vid of venueIds) {
      const v = VENUE_BY_ID[vid];
      const st = this.states.get(key(vid, symbol));
      if (!st) continue;
      const points: { t: number; v: number }[] = [];
      let cum = 0;
      const raw = st.secBuy.pointsFrom(from);
      const rawSell = st.secSell.pointsFrom(from);
      const buyByTime = new Map<number, number>(raw.map((p) => [p.t, p.v]));
      const sellByTime = new Map<number, number>(rawSell.map((p) => [p.t, p.v]));
      // 25 Okt 2026 (BUG FIX, scan sistem): iterasi atas UNION detik buy+sell.
      // Sebelumnya hanya detik berisi BUY yang diiterasi (pointsFrom secBuy) —
      // detik yang berisi SELL-saja tidak pernah dikurangkan dari akumulasi,
      // sehingga kurva CVD selalu melebih-lebihkan delta window (repro scan:
      // seri = 9 padahal delta window = -41).
      const times = [...new Set([...buyByTime.keys(), ...sellByTime.keys()])].sort((a, b) => a - b);
      const lastT = times.length ? times[times.length - 1]! : from;
      for (const t of times) {
        cum += (buyByTime.get(t) ?? 0) - (sellByTime.get(t) ?? 0);
        if (t % step === 0 || t === lastT) points.push({ t: t * 1000, v: cum });
      }
      if (points.length === 0) points.push({ t: from * 1000, v: 0 });
      out.push({ venue: v.short, color: v.color, points });
    }
    return out;
  }

  /** Seri harga (dari priceHistory symbol). */
  private priceSeriesFor(symbol: string, windowSec: number): { t: number; v: number }[] {
    const sym = this.symbolStates.get(symbol.toUpperCase());
    if (!sym) return [];
    const from = Date.now() - windowSec * 1000;
    const step = Math.max(1, Math.ceil(windowSec / SERIES_TARGET_POINTS));
    return sym.priceHistory.seriesSince(from, step);
  }

  aggressionRows(symbol: string): AggressionRow[] {
    const defs: { w: AggressionRow["window"]; sec: number }[] = [
      { w: "1M", sec: 60 }, { w: "5M", sec: 300 }, { w: "15M", sec: 900 }, { w: "1H", sec: 3600 },
    ];
    return defs.map((d) => {
      const a = this.windowAgg(symbol, d.sec);
      const total = a.buy + a.sell;
      return {
        window: d.w,
        windowSec: d.sec,
        takerBuyUsd: a.buy,
        takerSellUsd: a.sell,
        buySharePct: total > 0 ? (a.buy / total) * 100 : 0,
        trades: a.trades,
        buySellRatio: a.sell > 0 ? a.buy / a.sell : (a.buy > 0 ? null : null),
      };
    });
  }

  marketStats(symbol: string): MarketStats | null {
    const sym = symbol.toUpperCase();
    const ctx = this.hlCtx.get(sym);
    if (!ctx) return null;
    const book = this.getBook("BINANCE_PERP", sym);
    const bestBid = book?.bestBid ?? null;
    const bestAsk = book?.bestAsk ?? null;
    const spreadAbs = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const mid = ctx.midPx ?? (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null);
    const spreadPct = spreadAbs != null && mid ? (spreadAbs / mid) * 100 : null;
    const oiHist = this.oiHistory.get(sym) ?? [];
    const oiNow = ctx.openInterest;
    const oiAt = (msAgo: number): number | null => {
      if (oiNow == null) return null;
      const target = Date.now() - msAgo;
      let best: { t: number; oi: number } | null = null;
      for (const p of oiHist) { if (p.t <= target && (!best || p.t > best.t)) best = p; }
      return best ? best.oi : null;
    };
    const oi15 = oiAt(15 * 60_000);
    const oi60 = oiAt(60 * 60_000);
    const funding = ctx.funding;
    // Hyperliquid memublish funding PER JAM (desimal per jam).
    const apr = funding != null ? funding * 24 * 365 * 100 : null;
    const dayVol = ctx.dayNtlVlm;
    const prevDay = ctx.prevDayPx;
    const dayChange = dayVol != null && prevDay != null && ctx.markPx != null && prevDay > 0
      ? ((ctx.markPx - prevDay) / prevDay) * 100 : null;
    // Book OBI Binance radius 2% dari mid.
    let obi: number | null = null;
    if (book && mid) {
      const lo = mid * 0.98, hi = mid * 1.02;
      let b = 0, a = 0;
      for (const l of book.bids) if (l.price >= lo) b += l.notionalUsd;
      for (const l of book.asks) if (l.price <= hi) a += l.notionalUsd;
      if (b + a > 0) obi = ((b - a) / (b + a)) * 100;
    }
    const lastTrade = this.states.get(key("HYPERLIQUID", sym))?.lastPrice ?? null;
    return {
      symbol: sym,
      mid,
      lastTrade,
      mark: ctx.markPx,
      oracle: ctx.oraclePx,
      premium: ctx.premium,
      fundingHourly: funding,
      fundingAprPct: apr,
      openInterestCoins: oiNow,
      openInterestUsd: oiNow != null && ctx.markPx != null ? oiNow * ctx.markPx : null,
      oiChange15mCoins: oiNow != null && oi15 != null ? oiNow - oi15 : null,
      oiChange1hCoins: oiNow != null && oi60 != null ? oiNow - oi60 : null,
      dayVolumeUsd: dayVol,
      dayVolumeChangePct: dayChange,
      spreadAbs,
      spreadPct,
      bookAgeMs: book ? Date.now() - book.t : null,
      bookObi2Pct: obi,
      updatedAt: ctx.updatedAt,
      source: "hyperliquid_stream",
    };
  }

  buildSnapshot(symbol: string, window: "15m" | "1h" | "session" = "15m"): OrderFlowSnapshot {
    const sym = symbol.toUpperCase();
    const windowSec = window === "15m" ? 900 : window === "1h" ? 3600 : Math.max(60, Math.floor((Date.now() - this.startedAt) / 1000));
    const useSecRing = windowSec <= SEC_CAPACITY;

    // Delta per venue.
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    const fromMin = Math.floor(from / 60);
    const perVenue: OrderFlowSnapshot["cvd"]["perVenue"] = [];
    let allVenues = 0, spotSum = 0, perpSum = 0;
    let venuesTrading = 0;
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, sym));
      if (!st) continue;
      const buy = useSecRing ? st.secBuy.sumFrom(from) : st.minBuy.sumFrom(fromMin);
      const sell = useSecRing ? st.secSell.sumFrom(from) : st.minSell.sumFrom(fromMin);
      const delta = buy - sell;
      perVenue.push({ venue: v.id, label: v.label, color: v.color, delta, buyUsd: buy, sellUsd: sell });
      allVenues += delta;
      if (v.market === "spot") spotSum += delta; else perpSum += delta;
      if (st.tradeCount > 0 && Date.now() - st.lastTradeAt < 120_000) venuesTrading++;
    }

    // Seri CVD: venue utama + agregat.
    const seriesVenueIds: VenueId[] = ["HYPERLIQUID", "BINANCE_PERP", "BINANCE_SPOT", "COINBASE"];
    const series: CvdSeries[] = [];
    // All venues (putih tebal).
    const allPts = this.aggregateCvdSeries(sym, windowSec, VENUES.map((v) => v.id));
    series.push({ venue: "ALL", color: "#ffffff", points: allPts });
    for (const s of this.cvdSeriesFor(sym, windowSec, seriesVenueIds)) series.push(s);
    // spot Σ & perp Σ (putus-putus) — digambar frontend dari agregat.
    series.push({ venue: "SPOT Σ", color: "#7a8290", points: this.aggregateCvdSeries(sym, windowSec, VENUES.filter((v) => v.market === "spot").map((v) => v.id)) });
    series.push({ venue: "PERP Σ", color: "#4b6bbf", points: this.aggregateCvdSeries(sym, windowSec, VENUES.filter((v) => v.market === "perp").map((v) => v.id)) });

    // Team read.
    const symState = this.symbolStates.get(sym);
    const structure = symState ? symState.structure.state() : new StructureTracker().state();
    const teamRead: OrderFlowSnapshot["teamRead"] = [];
    for (const tf of [{ k: "15M" as const, sec: 900 }, { k: "1H" as const, sec: 3600 }]) {
      const agg = this.windowAgg(sym, tf.sec);
      const total = agg.buy + agg.sell;
      const priceChange = this.priceChangePct(sym, tf.sec);
      const spot = this.marketKindDelta(sym, tf.sec, "spot");
      const perp = this.marketKindDelta(sym, tf.sec, "perp");
      teamRead.push({
        timeframe: tf.k,
        priceChangePct: priceChange,
        allVenueCvdDelta: agg.buy - agg.sell,
        spotCvd: spot,
        perpCvd: perp,
        buySharePct: total > 0 ? (agg.buy / total) * 100 : null,
        engineStructure: structure,
        flowVsPrice: classifyFlowVsPrice(priceChange, agg.buy - agg.sell),
      });
    }

    return {
      symbol: sym,
      window,
      generatedAt: Date.now(),
      venuesTrading,
      venuesExpected: VENUES.length,
      cvd: { allVenues, spotSum, perpSum, perVenue },
      series,
      priceSeries: this.priceSeriesFor(sym, windowSec),
      aggression: this.aggressionRows(sym),
      teamRead,
      marketStats: this.marketStats(sym),
      historyMinutes: Math.floor((Date.now() - this.startedAt) / 60000),
    };
  }

  private marketKindDelta(symbol: string, windowSec: number, kind: MarketKind): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    const fromMin = Math.floor(from / 60);
    let delta = 0;
    for (const v of VENUES) {
      if (v.market !== kind) continue;
      const st = this.states.get(key(v.id, symbol));
      if (!st) continue;
      const buy = windowSec <= SEC_CAPACITY ? st.secBuy.sumFrom(from) : st.minBuy.sumFrom(fromMin);
      const sell = windowSec <= SEC_CAPACITY ? st.secSell.sumFrom(from) : st.minSell.sumFrom(fromMin);
      delta += buy - sell;
    }
    return delta;
  }

  private aggregateCvdSeries(symbol: string, windowSec: number, venueIds: VenueId[]): { t: number; v: number }[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - windowSec;
    const step = Math.max(1, Math.ceil(windowSec / SERIES_TARGET_POINTS));
    const merged = new Map<number, number>();
    for (const vid of venueIds) {
      const st = this.states.get(key(vid, symbol));
      if (!st) continue;
      const buy = new Map(st.secBuy.pointsFrom(from).map((p) => [p.t, p.v]));
      const sell = new Map(st.secSell.pointsFrom(from).map((p) => [p.t, p.v]));
      // 25 Okt 2026 (BUG FIX, scan sistem): UNION detik buy+sell — detik
      // SELL-saja wajib ikut terhitung (sebelumnya hanya iterasi detik BUY).
      for (const t of new Set([...buy.keys(), ...sell.keys()])) {
        merged.set(t, (merged.get(t) ?? 0) + (buy.get(t) ?? 0) - (sell.get(t) ?? 0));
      }
    }
    const times = [...merged.keys()].sort((a, b) => a - b);
    const out: { t: number; v: number }[] = [];
    let cum = 0;
    const lastT = times.length ? times[times.length - 1]! : from;
    for (const t of times) {
      cum += merged.get(t) ?? 0;
      if (t % step === 0 || t === lastT) out.push({ t: t * 1000, v: cum });
    }
    if (out.length === 0) out.push({ t: from * 1000, v: 0 });
    return out;
  }

  private priceChangePct(symbol: string, windowSec: number): number | null {
    const sym = this.symbolStates.get(symbol.toUpperCase());
    if (!sym) return null;
    const from = Date.now() - windowSec * 1000;
    const first = sym.priceHistory.firstSince(from);
    const last = sym.lastPrice;
    if (first == null || last == null || !(first > 0)) return null;
    return ((last - first) / first) * 100;
  }

  /** Tier imbalance (Panel 5) untuk symbol & range. */
  tierImbalance(symbol: string, rangeSec: number): {
    rows: { tier: FlowTier; buyUsd: number; sellUsd: number; netDeltaUsd: number; buySharePct: number; trades: number }[];
  } {
    const sym = symbol.toUpperCase();
    const ts = this.tierStates.get(sym);
    const tiers: FlowTier[] = ["MEGA", "WHALE", "LARGE", "MEDIUM", "SMALL"];
    if (!ts) {
      return { rows: tiers.map((tier) => ({ tier, buyUsd: 0, sellUsd: 0, netDeltaUsd: 0, buySharePct: 0, trades: 0 })) };
    }
    const nowMin = Math.floor(Date.now() / 60000);
    const fromMin = Math.floor((Date.now() - rangeSec * 1000) / 60000);
    const useMinutes = rangeSec > MIN_CAPACITY * 60;
    const rows = tiers.map((tier, i) => {
      let buy = 0, sell = 0, trades = 0;
      if (useMinutes) {
        // Di luar retensi menit -> pakai kumulatif sejak start (diberi label).
        buy = ts.cumBuy[i]!; sell = ts.cumSell[i]!; trades = ts.cumTrades[i]!;
      } else {
        buy = ts.tierBuy[i]!.sumFrom(fromMin);
        sell = ts.tierSell[i]!.sumFrom(fromMin);
        trades = ts.tierTrades[i]!.sumFrom(fromMin);
        // Tambahkan menit berjalan yang belum ter-flush.
        if (ts.pendMinute === nowMin) { buy += ts.pendBuy[i]!; sell += ts.pendSell[i]!; trades += ts.pendTrades[i]!; }
      }
      const total = buy + sell;
      return {
        tier,
        buyUsd: buy, sellUsd: sell,
        netDeltaUsd: buy - sell,
        buySharePct: total > 0 ? (buy / total) * 100 : 0,
        trades,
      };
    });
    return { rows };
  }

  /** Net delta per exchange (Panel 5). */
  perExchangeDelta(symbol: string, rangeSec: number): { exchange: string; delta: number; buyUsd: number; sellUsd: number }[] {
    const sym = symbol.toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - rangeSec;
    const fromMin = Math.floor(from / 60);
    const acc = new Map<string, { buy: number; sell: number }>();
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, sym));
      if (!st) continue;
      const buy = rangeSec <= SEC_CAPACITY ? st.secBuy.sumFrom(from) : st.minBuy.sumFrom(fromMin);
      const sell = rangeSec <= SEC_CAPACITY ? st.secSell.sumFrom(from) : st.minSell.sumFrom(fromMin);
      const cur = acc.get(v.exchange) ?? { buy: 0, sell: 0 };
      cur.buy += buy; cur.sell += sell;
      acc.set(v.exchange, cur);
    }
    return [...acc.entries()].map(([exchange, v]) => ({ exchange, delta: v.buy - v.sell, buyUsd: v.buy, sellUsd: v.sell }));
  }

  /** Seri delta kumulatif per exchange (untuk chart Panel 5). */
  perExchangeSeries(symbol: string, rangeSec: number): { exchange: string; color: string; total: number; points: { t: number; v: number }[] }[] {
    const sym = symbol.toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - rangeSec;
    const step = Math.max(1, Math.ceil(rangeSec / SERIES_TARGET_POINTS));
    const byExchange = new Map<string, Map<number, number>>();
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, sym));
      if (!st) continue;
      let m = byExchange.get(v.exchange);
      if (!m) { m = new Map(); byExchange.set(v.exchange, m); }
      const buy = new Map(st.secBuy.pointsFrom(from).map((p) => [p.t, p.v]));
      const sell = new Map(st.secSell.pointsFrom(from).map((p) => [p.t, p.v]));
      // 25 Okt 2026 (BUG FIX, scan sistem): UNION detik buy+sell (lihat cvdSeriesFor).
      for (const t of new Set([...buy.keys(), ...sell.keys()])) {
        m.set(t, (m.get(t) ?? 0) + (buy.get(t) ?? 0) - (sell.get(t) ?? 0));
      }
    }
    const out: { exchange: string; color: string; total: number; points: { t: number; v: number }[] }[] = [];
    for (const [exchange, m] of byExchange) {
      const times = [...m.keys()].sort((a, b) => a - b);
      const points: { t: number; v: number }[] = [];
      let cum = 0;
      const lastT = times.length ? times[times.length - 1]! : from;
      for (const t of times) {
        cum += m.get(t) ?? 0;
        if (t % step === 0 || t === lastT) points.push({ t: t * 1000, v: cum });
      }
      out.push({ exchange, color: "", total: cum, points });
    }
    return out;
  }

  get startedAtMs(): number { return this.startedAt; }
  get isStarted(): boolean { return this.started; }
  /**
   * TAHAP 6B: waktu trade TERAKHIR yang benar-benar diterima untuk simbol ini
   * (epoch ms) — dipakai sebagai "waktu evidence sumber" untuk freshness.
   * `generatedAt` hanya waktu snapshot dibuat, BUKAN waktu data.
   * null = belum ada trade sama sekali untuk simbol ini.
   */
  lastTradeAtMs(symbol: string): number | null {
    const sym = symbol.toUpperCase();
    let latest: number | null = null;
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, sym));
      if (!st || st.tradeCount === 0 || st.lastTradeAt <= 0) continue;
      if (latest == null || st.lastTradeAt > latest) latest = st.lastTradeAt;
    }
    return latest;
  }

  /**
   * TAHAP 6B: waktu data DITERIMA proses untuk trade terakhir (epoch ms).
   * Berbeda dari `lastTradeAtMs` (waktu event di bursa): kalau bursa mengirim
   * trade yang sudah basi, waktu terima > waktu event. null = belum ada trade.
   */
  lastTradeReceivedAtMs(symbol: string): number | null {
    const sym = symbol.toUpperCase();
    let latest: number | null = null;
    for (const v of VENUES) {
      const st = this.states.get(key(v.id, sym));
      if (!st || st.tradeCount === 0 || st.lastTradeAt <= 0) continue;
      // TimeRing menyimpan bucketing per-detik; waktu terima paling baru
      // dicerminkan oleh bucket terakhir yang terisi. Kalau tidak tersedia,
      // tandai UNKNOWN (null) — jangan karang dari waktu sekarang.
      const received = st.lastTradeReceivedAt ?? null;
      if (received == null) continue;
      if (latest == null || received > latest) latest = received;
    }
    return latest;
  }
  /** Transaksi dibuang karena waktu di luar rentang (lihat ingest). */
  get droppedInvalidTimeCount(): number { return this.droppedInvalidTime; }
}

export const multiVenueOrderFlowHub = new MultiVenueOrderFlowHub();
