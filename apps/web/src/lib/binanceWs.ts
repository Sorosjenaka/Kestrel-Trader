// apps/web/src/lib/binanceWs.ts
// Real-time Binance Futures Live Ticker & Mark Price Synchronization Client.
// Backend-driven: Server-Sent Events (SSE) + Fast REST Polling ke /api backend.
// (Koneksi WS langsung ke fstream.binance.com DIHAPUS — terblokir di jaringan ID:
// handshake menggantung/timeout dan tidak pernah memberi data. Backend server kini
// memegang WS futures !markPrice@arr@1s untuk SEMUA simbol, lalu meneruskan
// ke browser via SSE/hub — 0 koneksi WS dari browser, tahan blokir.)

export interface LiveTicker {
  symbol: string;
  markPrice: number;
  lastPrice: number;
  indexPrice?: number;
  chg24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fundingRate: number | null;
  nextFundingTime?: number;
  direction: "UP" | "DOWN" | "FLAT";
  lastUpdated: number;
  /** Sumber harga dari backend — selalu FUTURES (tanpa fallback pasar lain). */
  src?: "FUTURES";
  /** True bila angka berasal dari feed live (bukan seed placeholder). */
  live?: boolean;
}

export type TickerListener = (ticker: LiveTicker) => void;

export function isFreshTicker(ticker: LiveTicker, now = Date.now()): boolean {
  return ticker.live === true && ticker.markPrice > 0 && ticker.lastUpdated > 0 &&
    now - ticker.lastUpdated >= 0 && now - ticker.lastUpdated <= 5000;
}

const emptyTicker = (symbol: string): LiveTicker => ({
  symbol, markPrice: 0, lastPrice: 0, chg24hPct: 0, high24h: 0, low24h: 0,
  volume24h: 0, fundingRate: null, direction: "FLAT", lastUpdated: 0, live: false,
});

export type MultiTickerListener = (tickers: Map<string, LiveTicker>) => void;

class BinanceWsClient {
  private sse: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentSymbol: string = "BTCUSDT";
  private listeners: Set<TickerListener> = new Set();
  private lastMarkPrice: number = 0;
  // Multi-symbol live map: semua posisi terbuka update tanpa klik pair.
  private multiTickers: Map<string, LiveTicker> = new Map();
  private multiListeners: Set<MultiTickerListener> = new Set();
  private multiSse: EventSource | null = null;
  private multiPollTimer: ReturnType<typeof setInterval> | null = null;
  private multiSymbols: string[] = [];
  private multiLastPrice: Map<string, number> = new Map();
  private cachedTicker: LiveTicker = emptyTicker("BTCUSDT");

  public subscribe(symbol: string, callback: TickerListener): () => void {
    this.listeners.add(callback);
    callback(this.cachedTicker);

    if (symbol.toUpperCase() !== this.currentSymbol) {
      this.setSymbol(symbol);
    } else if (!this.sse && !this.pollTimer) {
      this.initStream();
    }

    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) this.cleanup();
    };
  }

  public setSymbol(symbol: string, seed?: Partial<LiveTicker>): void {
    const s = symbol.toUpperCase();
    if (s === this.currentSymbol && !seed) return;

    this.currentSymbol = s;
    this.lastMarkPrice = seed?.markPrice || seed?.lastPrice || 0;

    this.cachedTicker = {
      ...emptyTicker(s),
      symbol: s,
      markPrice: seed?.markPrice ?? seed?.lastPrice ?? 0,
      lastPrice: seed?.lastPrice ?? 0,
      chg24hPct: seed?.chg24hPct ?? 0,
      high24h: seed?.high24h ?? 0,
      low24h: seed?.low24h ?? 0,
      volume24h: seed?.volume24h ?? 0,
      direction: "FLAT",
      lastUpdated: 0,
      live: false,
    };
    this.notify();

    this.cleanup();
    this.initStream();
  }

  public getCurrentTicker(): LiveTicker {
    return this.cachedTicker;
  }

  private cleanup(): void {
    if (this.sse) {
      try {
        this.sse.close();
      } catch {}
      this.sse = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private initStream(): void {
    if (typeof window === "undefined") return;

    const sym = this.currentSymbol;

    // 1. Immediate REST fetch for 0ms latency sync
    this.fetchRestTicker(sym);

    // 2. Guaranteed Server-Sent Events (SSE) stream from local backend
    try {
      const sseUrl = `/api/binance/stream?symbol=${encodeURIComponent(sym)}`;
      this.sse = new EventSource(sseUrl);

      this.sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.symbol === this.currentSymbol) {
            this.applyLiveTick(data);
          }
        } catch {}
      };

      this.sse.onerror = () => {
        if (!this.pollTimer) {
          this.pollTimer = setInterval(() => {
            this.fetchRestTicker(this.currentSymbol);
          }, 1500);
        }
      };
    } catch {
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => {
          this.fetchRestTicker(this.currentSymbol);
        }, 1500);
      }
    }
    // TIDAK ada WS langsung ke Binance dari browser (terblokir di ID).
    // Backend meneruskan feed live (futures WS + spot WS) via SSE di atas.
  }

  private async fetchRestTicker(sym: string): Promise<void> {
    try {
      const res = await fetch(`/api/binance/ticker?symbol=${encodeURIComponent(sym)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.symbol === this.currentSymbol) {
          this.applyLiveTick(data);
        }
      }
    } catch {}
  }

  private applyLiveTick(data: any): void {
    const markPrice = Number(data.markPrice) || Number(data.lastPrice);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    let dir: "UP" | "DOWN" | "FLAT" = data.direction || "FLAT";

    if (this.lastMarkPrice > 0) {
      if (markPrice > this.lastMarkPrice) dir = "UP";
      else if (markPrice < this.lastMarkPrice) dir = "DOWN";
    }
    this.lastMarkPrice = markPrice;

    this.cachedTicker = {
      symbol: data.symbol || this.currentSymbol,
      markPrice,
      lastPrice: Number(data.lastPrice) || markPrice,
      indexPrice: Number(data.indexPrice) || markPrice,
      chg24hPct: Number(data.chg24hPct ?? data.chg24h) || 0,
      high24h: Number(data.high24h) || 0,
      low24h: Number(data.low24h) || 0,
      volume24h: Number(data.volume24h ?? data.vol24hUsd) || 0,
      fundingRate: data.fundingRate !== undefined ? Number(data.fundingRate) : this.cachedTicker.fundingRate,
      nextFundingTime: data.nextFundingTime ? Number(data.nextFundingTime) : this.cachedTicker.nextFundingTime,
      direction: dir,
      lastUpdated: data.lastUpdated || Date.now(),
      src: "FUTURES",
      live: data.live !== undefined ? Boolean(data.live) : true,
    };

    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.cachedTicker);
    }
  }

  // Multi-symbol subscription: update SEMUA posisi terbuka real-time tanpa klik.
  public subscribeMulti(symbols: string[], cb: MultiTickerListener): () => void {
    this.multiListeners.add(cb);
    cb(new Map(this.multiTickers));
    const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean)));
    if (upper.sort().join(",") !== [...this.multiSymbols].sort().join(",")) {
      this.multiSymbols = upper;
      this.restartMultiStream();
    }
    return () => {
      this.multiListeners.delete(cb);
      if (this.multiListeners.size === 0) this.cleanupMulti();
    };
  }

  public getMultiTickers(): Map<string, LiveTicker> {
    return new Map(this.multiTickers);
  }

  private notifyMulti(): void {
    const snap = new Map(this.multiTickers);
    for (const cb of this.multiListeners) {
      try {
        cb(snap);
      } catch {}
    }
  }

  private cleanupMulti(): void {
    if (this.multiSse) {
      try {
        this.multiSse.close();
      } catch {}
      this.multiSse = null;
    }
    if (this.multiPollTimer) {
      clearInterval(this.multiPollTimer);
      this.multiPollTimer = null;
    }
    this.multiSymbols = [];
  }

  // Transport multi-simbol via backend price hub (SSE 1 dtk + JSON fallback 2 dtk).
  // Tanpa koneksi WS langsung: tahan di jaringan yang memblokir WebSocket.
  private restartMultiStream(): void {
    if (this.multiSse) {
      try {
        this.multiSse.close();
      } catch {}
      this.multiSse = null;
    }
    if (this.multiPollTimer) {
      clearInterval(this.multiPollTimer);
      this.multiPollTimer = null;
    }
    if (this.multiSymbols.length === 0 || typeof window === "undefined") return;

    this.fetchHubBatch();
    try {
      const url = `/api/prices/stream?symbols=${encodeURIComponent(this.multiSymbols.join(","))}`;
      this.multiSse = new EventSource(url);
      this.multiSse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.prices) this.applyHubPrices(data.prices);
        } catch {}
      };
      this.multiSse.onerror = () => {
        if (!this.multiPollTimer) {
          this.multiPollTimer = setInterval(() => this.fetchHubBatch(), 2000);
        }
      };
    } catch {
      if (!this.multiPollTimer) {
        this.multiPollTimer = setInterval(() => this.fetchHubBatch(), 2000);
      }
    }
  }

  private async fetchHubBatch(): Promise<void> {
    if (this.multiSymbols.length === 0) return;
    try {
      const res = await fetch(`/api/prices/live?symbols=${encodeURIComponent(this.multiSymbols.join(","))}`);
      if (!res.ok) return;
      const d = await res.json();
      if (d && d.prices) this.applyHubPrices(d.prices);
    } catch {}
  }

  private applyHubPrices(prices: Record<string, { p?: number; m?: number; s?: string; t?: number; c?: number; v?: number; h?: number; l?: number; r?: number }>): void {
    const now = Date.now();
    let touched = false;
    for (const sym of this.multiSymbols) {
      const hit = prices[sym];
      if (!hit) continue;
      const mp = Number(hit.m) || Number(hit.p) || 0;
      if (!Number.isFinite(mp) || mp <= 0) continue;
      const prev = this.multiTickers.get(sym);
      const last = this.multiLastPrice.get(sym) ?? prev?.markPrice ?? 0;
      const dir = last > 0 ? (mp > last ? "UP" : mp < last ? "DOWN" : "FLAT") : "FLAT";
      this.multiLastPrice.set(sym, mp);
      this.multiTickers.set(sym, {
        symbol: sym,
        markPrice: mp,
        lastPrice: Number(hit.p) || prev?.lastPrice || mp,
        indexPrice: prev?.indexPrice ?? mp,
        // 23 Okt 2026: chg24h / volume24h / high / low kini ikut dari hub
        // (field c/v/h/l). Sebelumnya selalu 0 karena hub hanya mengirim p/m —
        // UI menampilkan volume & %24h yang salah/tak terisi untuk pair
        // yang tidak ada di snapshot single-ticker.
        chg24hPct: Number.isFinite(Number(hit.c)) ? Number(hit.c) : (prev?.chg24hPct ?? 0),
        high24h: Number.isFinite(Number(hit.h)) ? Number(hit.h) : (prev?.high24h ?? 0),
        low24h: Number.isFinite(Number(hit.l)) ? Number(hit.l) : (prev?.low24h ?? 0),
        volume24h: Number.isFinite(Number(hit.v)) ? Number(hit.v) : (prev?.volume24h ?? 0),
        // 23 Okt 2026 (Tahap 8): funding rate per 8 jam ikut dari hub (field r).
        // null = belum ada funding yang tercatat untuk simbol itu (JANGAN
        // ditampilkan sebagai 0%, karena 0% berarti "netral", bukan "tidak ada data").
        fundingRate: hit.r !== undefined && hit.r !== null && Number.isFinite(Number(hit.r))
          ? Number(hit.r)
          : (prev?.fundingRate ?? null),
        nextFundingTime: prev?.nextFundingTime,
        direction: dir,
        lastUpdated: hit.t ?? now,
        live: true,
        src: "FUTURES",
      });
      touched = true;
    }
    if (touched) this.notifyMulti();
  }
}

export const binanceWs = new BinanceWsClient();
