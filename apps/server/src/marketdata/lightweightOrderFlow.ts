// apps/server/src/marketdata/lightweightOrderFlow.ts
// Modul Ringan untuk Akses Order Book Real-Time (GRATIS via WS Public Stream).
// Tidak menyimpan full book, hanya snapshot top-N levels untuk kecepatan & hemat RAM.

import WebSocket from "ws";
import { logger } from "../core/logger.js";

export interface DepthLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  timestamp: number;
  bids: DepthLevel[]; // Top N Bid (descending price)
  asks: DepthLevel[]; // Top N Ask (ascending price)
  bestBid: number | null;
  bestAsk: number | null;
  spreadAbs: number | null;
  spreadPct: number | null;
  totalBidVol: number;
  totalAskVol: number;
  imbalanceRatio: number; // (BidVol - AskVol) / (BidVol + AskVol), range [-1, 1]
}

interface SubscriptionState {
  ws: WebSocket | null;
  lastUpdate: OrderBookSnapshot | null;
  reconnectTimer: NodeJS.Timeout | null;
}

class LightweightOrderFlowManager {
  private subscriptions = new Map<string, SubscriptionState>();
  private readonly BASE_URL = "wss://fstream.binance.com/ws";
  private readonly DEPTH_LEVELS = 5; // Top 5 levels cukup untuk scalping imbalances

  /**
   * Mulai berlangganan order book untuk simbol tertentu.
   * Idempotent: jika sudah langganan, tidak melakukan apa-apa.
   */
  subscribe(symbol: string): void {
    const symUpper = symbol.toUpperCase();
    if (this.subscriptions.has(symUpper)) return;

    logger.info(`[OrderFlow] Subscribing to depth for ${symUpper}`);
    
    const state: SubscriptionState = {
      ws: null,
      lastUpdate: null,
      reconnectTimer: null,
    };
    this.subscriptions.set(symUpper, state);

    this.connectWebSocket(symUpper, state);
  }

  /**
   * Berhenti berlangganan dan bersihkan resource.
   */
  unsubscribe(symbol: string): void {
    const symUpper = symbol.toUpperCase();
    const state = this.subscriptions.get(symUpper);
    if (!state) return;

    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    this.subscriptions.delete(symUpper);
    logger.info(`[OrderFlow] Unsubscribed from ${symUpper}`);
  }

  /**
   * Ambil snapshot terakhir yang tersimpan di memori.
   * Return null jika belum ada data atau belum langganan.
   */
  getSnapshot(symbol: string): OrderBookSnapshot | null {
    const symUpper = symbol.toUpperCase();
    const state = this.subscriptions.get(symUpper);
    if (!state || !state.lastUpdate) return null;
    
    // Cek freshness: jika data lebih tua dari 2 detik, anggap stale
    const ageMs = Date.now() - state.lastUpdate.timestamp;
    if (ageMs > 2000) return null; 

    return state.lastUpdate;
  }

  private connectWebSocket(symbol: string, state: SubscriptionState): void {
    // Menggunakan @depth5 stream untuk Binance Futures
    const url = `${this.BASE_URL}/${symbol.toLowerCase()}@depth5`;
    
    try {
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.on("open", () => {
        logger.debug(`[OrderFlow] Connected to ${symbol}`);
      });

      ws.on("message", (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          this.mergeDepthUpdate(symbol, data, state);
        } catch (e) {
          // Ignore parse errors silently to prevent spam
        }
      });

      ws.on("close", (code) => {
        logger.warn(`[OrderFlow] Disconnected from ${symbol}, code: ${code}. Reconnecting...`);
        state.ws = null;
        this.scheduleReconnect(symbol, state);
      });

      ws.on("error", (err) => {
        logger.error(`[OrderFlow] WS Error for ${symbol}: ${err.message}`);
      });

    } catch (err) {
      logger.error(`[OrderFlow] Failed to create WS for ${symbol}: ${(err as Error).message}`);
      this.scheduleReconnect(symbol, state);
    }
  }

  private scheduleReconnect(symbol: string, state: SubscriptionState): void {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (this.subscriptions.has(symbol)) {
        this.connectWebSocket(symbol, state);
      }
    }, 2000);
  }

  private mergeDepthUpdate(symbol: string, msg: any, state: SubscriptionState): void {
    // Inisialisasi buku jika null
    if (!state.lastUpdate) {
      state.lastUpdate = {
        symbol,
        timestamp: 0,
        bids: [],
        asks: [],
        bestBid: null,
        bestAsk: null,
        spreadAbs: null,
        spreadPct: null,
        totalBidVol: 0,
        totalAskVol: 0,
        imbalanceRatio: 0,
      };
    }

    const book = state.lastUpdate;
    
    // Proses Bids
    if (msg.b && Array.isArray(msg.b)) {
      msg.b.forEach(([priceStr, qtyStr]: [string, string]) => {
        const price = parseFloat(priceStr);
        const qty = parseFloat(qtyStr);
        const idx = book.bids.findIndex(l => l.price === price);
        if (qty === 0) {
          if (idx !== -1) book.bids.splice(idx, 1);
        } else {
          if (idx !== -1) book.bids[idx].quantity = qty;
          else book.bids.push({ price, quantity: qty });
        }
      });
      book.bids.sort((a, b) => b.price - a.price);
      book.bids = book.bids.slice(0, this.DEPTH_LEVELS);
    }

    // Proses Asks
    if (msg.a && Array.isArray(msg.a)) {
      msg.a.forEach(([priceStr, qtyStr]: [string, string]) => {
        const price = parseFloat(priceStr);
        const qty = parseFloat(qtyStr);
        const idx = book.asks.findIndex(l => l.price === price);
        if (qty === 0) {
          if (idx !== -1) book.asks.splice(idx, 1);
        } else {
          if (idx !== -1) book.asks[idx].quantity = qty;
          else book.asks.push({ price, quantity: qty });
        }
      });
      book.asks.sort((a, b) => a.price - b.price);
      book.asks = book.asks.slice(0, this.DEPTH_LEVELS);
    }

    // Hitung Ulang Metrik
    if (book.bids.length > 0 && book.asks.length > 0) {
      book.bestBid = book.bids[0].price;
      book.bestAsk = book.asks[0].price;
      book.spreadAbs = book.bestAsk - book.bestBid;
      const mid = (book.bestBid + book.bestAsk) / 2;
      book.spreadPct = mid > 0 ? (book.spreadAbs / mid) * 100 : 0;
      
      book.totalBidVol = book.bids.reduce((s, l) => s + l.quantity, 0);
      book.totalAskVol = book.asks.reduce((s, l) => s + l.quantity, 0);
      const tot = book.totalBidVol + book.totalAskVol;
      book.imbalanceRatio = tot === 0 ? 0 : (book.totalBidVol - book.totalAskVol) / tot;
      book.timestamp = Date.now();
    }
  }
}

export const orderFlowManager = new LightweightOrderFlowManager();

/**
 * Fungsi utilitas untuk mendapatkan statistik order flow saat ini.
 * Jika belum subscribed, otomatis subscribe dulu (lazy loading).
 */
export async function getOrderBookStats(symbol: string): Promise<OrderBookSnapshot | null> {
  orderFlowManager.subscribe(symbol);
  
  // Beri waktu kecil untuk koneksi awal jika benar-benar baru
  let snap = orderFlowManager.getSnapshot(symbol);
  if (!snap) {
    await new Promise(r => setTimeout(r, 500));
    snap = orderFlowManager.getSnapshot(symbol);
  }
  return snap;
}
