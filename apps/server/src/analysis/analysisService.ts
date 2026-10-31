// apps/server/src/analysis/analysisService.ts - Orkestrator layer analisis.
// 23 Okt 2026 (Tahap 4). INFLUENSI TRADING: OFF (flag).
//
// Satu snapshot dipakai BERSAMA oleh semua agen (bukan tiap agen buka feed
// sendiri) — ini hemat RAM dan hemat rate-limit pada VPS 2 GB.
//
// MULTI-VENUE: tiap venue punya feed sendiri (akumulator terpisah) karena
//  - Binance WS   : taker side dari field `m` (m=true -> agresif SELL)
//  - Hyperliquid  : taker side dari field `side` ("B"=agresif BUY, "A"=SELL)
//  - Coinbase spot: hanya MAKER side -> dibalik (lihat coinbaseTrades.ts)
// Jadi angka antar venue TIDAK boleh dijumlahkan mentah-mentah tanpa
// menandai provenance-nya.

import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { logger } from "../core/logger.js";
import { DeltaAccumulator, type TradeTick } from "./deltaEngine.js";
import { computeStatus, emptyHealth, type FeedHealth, type TtlKind } from "./dataStatus.js";
import { parseBinanceAggTrade, binanceAggTradeUrl, binanceWsHosts } from "./feeds/binanceAggTrade.js";
import {
  parseHyperliquidTrades, hyperliquidWsUrl, hyperliquidSubscribePayload,
  hyperliquidPingPayload, parseHyperliquidAssetCtx,
  type HlAssetCtx,
} from "./feeds/hyperliquidTrades.js";
import {
  parseCoinbaseMarketTrades, coinbaseSubscribePayload, aratradeSymbolToCoinbaseProduct,
} from "./feeds/coinbaseTrades.js";
import {
  DATA_TTL_MS, type DataStatusInfo, type FeatureSnapshot, type InstrumentIdentity,
  type OiFunding,
} from "./contracts.js";

export type VenueCode = "BINANCE" | "HYPERLIQUID" | "COINBASE";

export interface AnalysisServiceOptions {
  symbol?: string;
  market?: "SPOT" | "PERP";
  maxSymbols?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Venue tambahan yang diaktifkan (default: BINANCE saja). */
  venues?: VenueCode[];
  /** Hyperliquid: pakai testnet? */
  hyperliquidTestnet?: boolean;
}

interface FeedState {
  health: FeedHealth;
  acc: DeltaAccumulator;
  socket: WebSocket | null;
  lastSymbol: string | null;
  /** Rotasi host: dipakai supaya reconnect pindah ke host cadangan. */
  hostCursor: number;
  /** Venue feed ini. */
  venue: VenueCode;
  /** Konteks OI/funding terakhir (venue yang menyediakannya). */
  ctx?: HlAssetCtx | null;
  /** Timer ping/keepalive (Hyperliquid idle timeout 60 dtk). */
  pingTimer?: NodeJS.Timeout | null;
}

const DEFAULT_SYMBOL = "BTCUSDT";

/**
 * AnalysisService — owning feed WS trade untuk venue+simbol yang diminta.
 * Sengaja TIDAK melakukan polling universe penuh: hanya simbol yang benar-benar
 * diminta, sesuai batas VPS.
 */
export class AnalysisService extends EventEmitter {
  private readonly feeds = new Map<string, FeedState>();
  private readonly symbol: string;
  private readonly market: "SPOT" | "PERP";
  private readonly now: () => number;
  private readonly venues: VenueCode[];
  private readonly hlTestnet: boolean;
  private started = false;
  private snapshotCounter = 0;
  private lastSnapshot: FeatureSnapshot | null = null;

  constructor(opts: AnalysisServiceOptions = {}) {
    super();
    this.symbol = (opts.symbol ?? DEFAULT_SYMBOL).toUpperCase();
    this.market = opts.market ?? "PERP";
    this.now = opts.now ?? (() => Date.now());
    this.venues = opts.venues?.length ? opts.venues : ["BINANCE"];
    this.hlTestnet = opts.hyperliquidTestnet ?? false;
  }

  isStarted(): boolean { return this.started; }

  /** Feed key: venue+market+symbol. */
  private key(venue: VenueCode, symbol: string, market: "SPOT" | "PERP"): string {
    return `${venue}:${market}:${symbol.toUpperCase()}`;
  }

  private ensureFeed(venue: VenueCode, symbol: string, market: "SPOT" | "PERP"): FeedState {
    const k = this.key(venue, symbol, market);
    let f = this.feeds.get(k);
    if (!f) {
      f = {
        health: emptyHealth(true), acc: new DeltaAccumulator(), socket: null,
        lastSymbol: symbol, hostCursor: 0, venue, ctx: null,
      };
      this.feeds.set(k, f);
    }
    return f;
  }

  /** Start feed untuk simbol (idempoten). */
  start(symbol: string = this.symbol, market: "SPOT" | "PERP" = this.market): void {
    this.started = true;
    for (const venue of this.venues) {
      // Coinbase hanya punya spot; Hyperliquid & Binance punya keduanya.
      if (venue === "COINBASE" && market !== "SPOT") continue;
      const feed = this.ensureFeed(venue, symbol, market);
      this.connectFeed(venue, symbol, market, feed);
    }
  }

  private connectFeed(venue: VenueCode, symbol: string, market: "SPOT" | "PERP", feed: FeedState): void {
    if (feed.socket) return;
    switch (venue) {
      case "BINANCE": this.connectBinance(symbol, market, feed); return;
      case "HYPERLIQUID": this.connectHyperliquid(symbol, feed); return;
      case "COINBASE": this.connectCoinbase(symbol, feed); return;
    }
  }

  // ── Binance ────────────────────────────────────────────────────────────
  private connectBinance(symbol: string, market: "SPOT" | "PERP", feed: FeedState): void {
    const hosts = binanceWsHosts(market);
    // Rotasi host: kalau host pertama gagal, pindah ke cadangan.
    const idx = feed.hostCursor % hosts.length;
    const host = hosts[idx]!;
    feed.hostCursor++;
    const url = binanceAggTradeUrl(host, symbol, market);
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      feed.health.errors.push("gagal membuka socket");
      this.scheduleReconnect("BINANCE", symbol, market, feed);
      return;
    }
    feed.socket = sock;
    sock.on("open", () => {
      feed.health.lastConnectAt = this.now();
      feed.health.lastDisconnectAt = null;
      feed.health.errors = [];
      this.emit("feed_status", { venue: "BINANCE", symbol, market, connected: true, host });
    });
    sock.on("message", (raw: Buffer | string) => {
      const parsed = parseBinanceAggTrade(String(raw), symbol);
      if (!parsed) return;
      feed.health.lastEventAt = this.now();
      feed.acc.ingest(parsed.tick);
      this.emit("trade", { venue: "BINANCE", symbol, market, tick: parsed.tick });
    });
    sock.on("error", (err: Error) => {
      feed.health.errors.push(String(err?.message ?? err).slice(0, 120));
    });
    sock.on("close", () => {
      feed.socket = null;
      feed.health.lastDisconnectAt = this.now();
      feed.health.reconnects++;
      this.emit("feed_status", { venue: "BINANCE", symbol, market, connected: false, host });
      this.scheduleReconnect("BINANCE", symbol, market, feed);
    });
  }

  // ── Hyperliquid ────────────────────────────────────────────────────────
  private connectHyperliquid(symbol: string, feed: FeedState): void {
    // HL memakai ticker BASE ("BTC"), bukan simbol ArtaTrade ("BTCUSDT").
    // hyperliquidCoinToSymbol() bekerja untuk arah sebaliknya (HL -> ArtaTrade),
    // jadi untuk arah ini kita potong sufiks kutipan.
    const coin = symbol.toUpperCase().replace(/USDT$|USDC$|BUSD$/, "");
    const url = hyperliquidWsUrl(this.hlTestnet);
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      feed.health.errors.push("gagal membuka socket");
      this.scheduleReconnect("HYPERLIQUID", symbol, "PERP", feed);
      return;
    }
    feed.socket = sock;
    sock.on("open", () => {
      feed.health.lastConnectAt = this.now();
      feed.health.lastDisconnectAt = null;
      feed.health.errors = [];
      // Subscribe trade + ctx (OI/funding/mark price).
      try {
        sock.send(hyperliquidSubscribePayload("trades", coin));
        sock.send(hyperliquidSubscribePayload("activeAssetCtx", coin));
      } catch { /* ignore */ }
      // Idle timeout HL = 60 dtk -> ping wajib.
      feed.pingTimer = setInterval(() => {
        try { sock.send(hyperliquidPingPayload()); } catch { /* ignore */ }
      }, 30_000);
      feed.pingTimer.unref?.();
      logger.info({ venue: "HYPERLIQUID", coin, url }, "ANALYTICS_FEED_OPEN");
      this.emit("feed_status", { venue: "HYPERLIQUID", symbol, market: "PERP", connected: true, host: url });
    });
    sock.on("message", (raw: Buffer | string) => {
      const text = String(raw);
      // Context aset (OI/funding/mark) — bukan trade.
      const ctx = parseHyperliquidAssetCtx(text, coin);
      if (ctx) {
        feed.ctx = ctx;
        feed.health.lastEventAt = this.now();
        return;
      }
      const ticks = parseHyperliquidTrades(text, coin);
      if (!ticks) return;
      feed.health.lastEventAt = this.now();
      for (const tick of ticks) {
        feed.acc.ingest(tick);
        this.emit("trade", { venue: "HYPERLIQUID", symbol, market: "PERP", tick });
      }
    });
    sock.on("error", (err: Error) => {
      const msg = String(err?.message ?? err).slice(0, 120);
      feed.health.errors.push(msg);
      logger.warn({ venue: "HYPERLIQUID", err: msg }, "ANALYTICS_FEED_ERROR");
    });
    sock.on("close", () => {
      feed.socket = null;
      feed.health.lastDisconnectAt = this.now();
      feed.health.reconnects++;
      if (feed.pingTimer) { clearInterval(feed.pingTimer); feed.pingTimer = null; }
      logger.warn({ venue: "HYPERLIQUID", reconnects: feed.health.reconnects, errors: feed.health.errors.slice(-3) },
        "ANALYTICS_FEED_CLOSED");
      this.emit("feed_status", { venue: "HYPERLIQUID", symbol, market: "PERP", connected: false });
      this.scheduleReconnect("HYPERLIQUID", symbol, "PERP", feed);
    });
  }

  // ── Coinbase ───────────────────────────────────────────────────────────
  private connectCoinbase(symbol: string, feed: FeedState): void {
    const product = aratradeSymbolToCoinbaseProduct(symbol);
    const url = "wss://advanced-trade-ws.coinbase.com";
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      feed.health.errors.push("gagal membuka socket");
      this.scheduleReconnect("COINBASE", symbol, "SPOT", feed);
      return;
    }
    feed.socket = sock;
    sock.on("open", () => {
      feed.health.lastConnectAt = this.now();
      feed.health.lastDisconnectAt = null;
      feed.health.errors = [];
      try {
        sock.send(coinbaseSubscribePayload(product));
      } catch { /* ignore */ }
      this.emit("feed_status", { venue: "COINBASE", symbol, market: "SPOT", connected: true, host: url });
    });
    sock.on("message", (raw: Buffer | string) => {
      const ticks = parseCoinbaseMarketTrades(String(raw), product);
      if (!ticks) return;
      feed.health.lastEventAt = this.now();
      for (const tick of ticks) {
        feed.acc.ingest(tick);
        this.emit("trade", { venue: "COINBASE", symbol, market: "SPOT", tick });
      }
    });
    sock.on("error", (err: Error) => {
      feed.health.errors.push(String(err?.message ?? err).slice(0, 120));
    });
    sock.on("close", () => {
      feed.socket = null;
      feed.health.lastDisconnectAt = this.now();
      feed.health.reconnects++;
      this.emit("feed_status", { venue: "COINBASE", symbol, market: "SPOT", connected: false });
      this.scheduleReconnect("COINBASE", symbol, "SPOT", feed);
    });
  }

  private scheduleReconnect(
    venue: VenueCode, symbol: string, market: "SPOT" | "PERP", feed: FeedState,
  ): void {
    if (!this.started) return;
    // Jeda 3 detik; host cursor sudah dimajukan di connectFeed.
    setTimeout(() => {
      if (this.started) this.connectFeed(venue, symbol, market, feed);
    }, 3_000).unref?.();
  }

  stop(): void {
    this.started = false;
    for (const feed of this.feeds.values()) {
      try { feed.socket?.close(); } catch { /* ignore */ }
      feed.socket = null;
      if (feed.pingTimer) { clearInterval(feed.pingTimer); feed.pingTimer = null; }
    }
  }

  /** Status per feed untuk UI. */
  feedStatuses(): Record<string, DataStatusInfo> {
    const now = this.now();
    const out: Record<string, DataStatusInfo> = {};
    for (const [k, f] of this.feeds) {
      out[k] = computeStatus(f.health, "trades" as TtlKind, now);
    }
    return out;
  }

  /** Feed venue utama (untuk identitas instrumen di snapshot). */
  private primaryFeed(): FeedState | undefined {
    for (const v of this.venues) {
      const f = this.feeds.get(this.key(v, this.symbol, this.market));
      if (f) return f;
    }
    return undefined;
  }

  /**
   * Bangun feature snapshot. INI yang dikirim ke agen (satu paket, dipakai
   * bersama). Tidak ada nilai yang dikarang: yang tidak ada = null.
   */
  buildSnapshot(): FeatureSnapshot {
    const now = this.now();
    this.snapshotCounter++;
    const k = this.key(this.venues[0] ?? "BINANCE", this.symbol, this.market);
    const feed = this.feeds.get(k);
    const acc = feed?.acc;
    const computed = acc ? acc.compute(now) : null;

    const venue = this.venues[0] ?? "BINANCE";
    const base = this.symbol.replace(/USDT$|USDC$|BUSD$/, "");
    const quote = this.symbol.endsWith("USDC") ? "USDC" : this.symbol.endsWith("BUSD") ? "BUSD" : "USDT";
    const identity: InstrumentIdentity = {
      venue,
      marketType: this.market,
      instrumentId: this.market === "PERP" ? `${this.symbol} PERPETUAL` : this.symbol,
      base,
      quote,
      // Hyperliquid Collateral = USDC; Binance perp = USDT.
      settlementAsset: venue === "HYPERLIQUID" ? "USDC" : "USDT",
      marginAsset: venue === "HYPERLIQUID" ? "USDC" : "USDT",
      contractType: this.market === "PERP" ? "LINEAR" : "NONE",
    };

    const limitations: string[] = [];
    if (!computed) limitations.push("Belum ada feed trade aktif — delta/CVD belum dihitung.");
    if (this.market === "SPOT") limitations.push("Venue ini spot: tidak ada short perpetual untuk perbandingan.");
    if (this.venues.includes("COINBASE")) {
      limitations.push("Coinbase spot hanya memberi MAKER side; delta di venue ini adalah proksi taker, bukan taker side eksplisit.");
    }
    limitations.push("Baris likuidasi di panel likuidasi adalah event yang sudah terjadi, bukan peta posisi.");
    limitations.push("Peta level posisi belum tersedia di sistem ini.");
    limitations.push("Funding antar-venue tidak dibandingkan di sini; hanya venue & periode yang sama.");

    const dataStatus: Record<string, DataStatusInfo> = {};
    for (const [fk, st] of Object.entries(this.feedStatuses())) dataStatus[fk] = st;

    const byWindow: FeatureSnapshot["features"]["deltaByWindow"] = {};
    if (computed) {
      for (const [w, v] of Object.entries(computed.byWindow)) {
        byWindow[w] = {
          window: w as "5m" | "15m" | "1h" | "4h",
          buyNotional: v.buyNotional,
          sellNotional: v.sellNotional,
          buyRatio: v.buyRatio,
          totalNotional: v.totalNotional,
          tradeCount: v.tradeCount,
          deltaNotional: v.deltaNotional,
          cvdSession: v.cvdSession,
          rollingDelta: v.rollingDelta,
          warmup: v.warmup,
          reconnectCount: v.reconnectCount,
        };
      }
    }

    // OI/funding: hanya venue yang menyediakan (Hyperliquid).
    const oiFunding = this.buildOiFunding(now);

    // Delta per venue: tiap venue punya akumulator sendiri (taker side
    // definisi & cakupan berbeda). TIDAK dijumlahkan mentah-mentah.
    const deltaByVenue: Record<string, FeatureSnapshot["features"]["deltaByWindow"]> = {};
    for (const [fk, f] of this.feeds) {
      if (!f.acc) continue;
      const vc = f.acc.compute(now);
      const w: FeatureSnapshot["features"]["deltaByWindow"] = {};
      for (const [wk, v] of Object.entries(vc.byWindow)) {
        w[wk] = {
          window: wk as "5m" | "15m" | "1h" | "4h",
          buyNotional: v.buyNotional,
          sellNotional: v.sellNotional,
          buyRatio: v.buyRatio,
          totalNotional: v.totalNotional,
          tradeCount: v.tradeCount,
          deltaNotional: v.deltaNotional,
          cvdSession: v.cvdSession,
          rollingDelta: v.rollingDelta,
          warmup: v.warmup,
          reconnectCount: v.reconnectCount,
        };
      }
      deltaByVenue[fk] = w;
    }

    const snap: FeatureSnapshot = {
      snapshotId: `snap-${now}-${this.snapshotCounter}`,
      featureVersion: "artatrade-feature-v1",
      builtAt: now,
      eventTimeMax: now,
      instrument: identity,
      dataStatus,
      coverage: {
        // Denominator belum diketahui (venue aktif < venue dijadwalkan) -> TIDAK 100%.
        trades: { present: computed?.ingested ?? 0, total: 0 },
        venues: { present: this.feeds.size, total: 4 },
      },
      features: {
        deltaByWindow: byWindow,
        deltaByVenue,
        bookBand: null,
        liquidationEvent: null,
        positionLevelMap: null,
        oiFunding,
      },
      evidenceRefs: [],
      sourceSwitches: [],
      limitations,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  /**
   * OI/funding dari Hyperliquid.
   * PENTING: openInterest dari HL dalam unit BASE asset, funding per jam.
   * Field yang tidak ada -> null (bukan 0).
   */
  private buildOiFunding(now: number): OiFunding | null {
    for (const v of this.venues) {
      const f = this.feeds.get(this.key(v, this.symbol, this.market));
      if (!f?.ctx) continue;
      const ctx = f.ctx;
      // OI dalam base asset -> konversi ke USD memakai mark price.
      const markPx = ctx.markPx ?? ctx.midPx ?? ctx.oraclePx;
      const oiUsd = ctx.openInterest !== null && markPx !== null
        ? ctx.openInterest * markPx
        : null;
      return {
        venue: v,
        symbol: this.symbol,
        openInterest: oiUsd ?? 0,
        openInterestContracts: ctx.openInterest,
        openInterestUsdChange: null,
        fundingRate: ctx.funding,
        fundingIntervalMinutes: 60,
        fundingNextAt: null,
        capturedAt: now,
      };
    }
    return null;
  }

  last(): FeatureSnapshot | null { return this.lastSnapshot; }
}

/** TTL map yang bisa dipakai UI untuk menampilkan batas kesegaran. */
export { DATA_TTL_MS };
