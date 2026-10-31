// apps/web/src/lib/markPriceFeed.ts
//
// Feed mark price realtime untuk PnL/ROI di FRONTEND (branch feat/realtime-pnl).
//
// Sumber:
//   1. PRIMADONA — satu koneksi WebSocket publik Binance Futures, combined
//      stream: wss://fstream.binance.com/market/ws/stream?streams=btcusdt@markPrice@1s/…
//      Tanpa API key, tanpa endpoint signed.
//      PENTING (23 Okt 2026, terbukti ulang 30 Okt): path lama "/stream" dan
//      "/ws/" masih membuka handshake tapi TIDAK PERNAH mengirim data. Path
//      baru "/market/ws/stream" mengalir normal. Jangan kembalikan ke "/stream".
//   2. CADANGAN — hub harga backend (SSE /api/prices/stream lewat binanceWs),
//      yang menyiarkan mark dari WS server tiap ~1 dtk. Dipakai saat WS
//      langsung tidak terhubung/putus (jaringan yang memblokir WS).
//
// Status:
//   LIVE    = tick WS segar (<= WS_FRESH_MS)
//   DELAYED = memakai hub backend / tick WS basi -> UI wajib menampilkan badge
//
// ATURAN: display-only. Tidak mengirim order, tidak menulis DB, tidak
// menyentuh logika trading. Render dibatasi THROTTLE_MS (~4x/dtk) agar angka
// tidak membuat React render ratusan kali per detik.

import { binanceWs, type LiveTicker } from "./binanceWs.js";

export type MarkSource = "WS" | "HUB";
export type FeedStatus = "LIVE" | "DELAYED";
export type WsState = "CONNECTED" | "CONNECTING" | "OFFLINE";

export interface MarkTick {
  /** Mark price terakhir yang valid (> 0). */
  mark: number;
  /** Waktu tick (ms epoch) dari exchange, atau waktu terima. */
  at: number;
  /** Dari mana angka ini datang. */
  source: MarkSource;
}

export interface MarkFeedSnapshot {
  marks: Map<string, MarkTick>;
  status: FeedStatus;
  wsState: WsState;
}

/** Tick WS lebih tua dari ini dianggap putus -> fallback hub + DELAYED. */
export const WS_FRESH_MS = 3_000;
/** Render maksimal ~4x per detik. */
export const THROTTLE_MS = 250;
/** Debounce rebuild koneksi saat daftar simbol berubah (anti-flap). */
export const REBUILD_DEBOUNCE_MS = 300;
const WATCHDOG_MS = 2_000;
const MAX_RECONNECT_MS = 15_000;

/** URL combined stream publik untuk sekumpulan simbol. Simbol dinormalkan. */
export function buildCombinedStreamUrl(symbols: readonly string[]): string {
  const streams = Array.from(
    new Set(
      symbols
        .map((s) => String(s ?? "").trim().toLowerCase())
        .filter((s) => /^[a-z0-9]{3,20}$/.test(s)),
    ),
  ).sort();
  return `wss://fstream.binance.com/market/ws/stream?streams=${streams.map((s) => `${s}@markPrice@1s`).join("/")}`;
}

/**
 * Parse satu pesan WS markPrice (combined `{stream,data}` atau payload polos).
 * Mengembalikan null untuk pesan lain / angka tidak valid.
 */
export function parseMarkPriceEvent(raw: unknown): { symbol: string; mark: number; at: number } | null {
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const data: any = obj.data && typeof obj.data === "object" ? obj.data : obj;
  if (data.e !== "markPriceUpdate") return null;
  const symbol = String(data.s ?? "").toUpperCase();
  const mark = Number(data.p);
  if (!symbol || !Number.isFinite(mark) || mark <= 0) return null;
  const at = Number(data.E ?? data.T);
  return { symbol, mark, at: Number.isFinite(at) && at > 0 ? at : Date.now() };
}

/** True bila tick WS masih segar. */
export function isWsFresh(lastWsAt: number | null, now = Date.now(), maxAgeMs = WS_FRESH_MS): boolean {
  return lastWsAt != null && lastWsAt > 0 && now - lastWsAt <= maxAgeMs;
}

/** Backoff eksponensial 1s,2s,4s,… max 15s (+jitter kecil). */
export function nextReconnectDelayMs(attempt: number): number {
  const exp = Math.max(0, Math.min(10, Math.floor(attempt)));
  const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** exp);
  return Math.min(MAX_RECONNECT_MS, base + Math.floor(Math.random() * 250));
}

interface FeedSub {
  id: number;
  symbols: Set<string>;
  cb: (snap: MarkFeedSnapshot) => void;
}

class MarkPriceFeed {
  private marks = new Map<string, MarkTick>();
  private subs = new Map<number, FeedSub>();
  private idSeq = 0;

  private ws: WebSocket | null = null;
  private wsState: WsState = "OFFLINE";
  private lastWsAt: number | null = null;
  private attempt = 0;

  private symbolsKey = "";
  private symbols: string[] = [];
  private symbolSet = new Set<string>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private hubUnsub: (() => void) | null = null;
  private dirty = false;
  private lastStatus: FeedStatus = "DELAYED";

  /** Snapshot awal (dipakai useState sebelum subscribe pertama). */
  public getSnapshot(): MarkFeedSnapshot {
    return this.snapshot();
  }

  /** Berlangganan mark untuk sekumpulan simbol. Mengembalikan fungsi unsubscribe. */
  public subscribe(symbols: readonly string[], cb: (snap: MarkFeedSnapshot) => void): () => void {
    const id = ++this.idSeq;
    this.subs.set(id, {
      id,
      symbols: new Set(symbols.map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean)),
      cb,
    });
    cb(this.snapshot());
    this.syncSymbols();
    return () => {
      this.subs.delete(id);
      this.syncSymbols();
    };
  }

  private isWsLive(now = Date.now()): boolean {
    return this.wsState === "CONNECTED" && isWsFresh(this.lastWsAt, now);
  }

  private status(now = Date.now()): FeedStatus {
    return this.isWsLive(now) ? "LIVE" : "DELAYED";
  }

  private snapshot(): MarkFeedSnapshot {
    return {
      marks: new Map(this.marks),
      status: this.status(),
      wsState: this.wsState,
    };
  }

  private syncSymbols(): void {
    const union = new Set<string>();
    for (const sub of this.subs.values()) for (const s of sub.symbols) union.add(s);
    const key = [...union].sort().join(",");
    if (key === this.symbolsKey) return;
    const first = this.symbolsKey === "";
    this.symbolsKey = key;
    this.symbols = key ? key.split(",") : [];
    this.symbolSet = new Set(this.symbols);

    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (first || this.symbols.length === 0) {
      this.rebuild();
      return;
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  private rebuild(): void {
    this.teardownWs();
    this.teardownHub();
    // Buang mark simbol yang tidak lagi dibutuhkan.
    for (const sym of [...this.marks.keys()]) {
      if (!this.symbolSet.has(sym)) this.marks.delete(sym);
    }
    if (this.symbols.length === 0) {
      this.wsState = "OFFLINE";
      this.lastWsAt = null;
      this.emitNow();
      return;
    }
    // Cadangan selalu terpasang: bila WS diblokir, angka tetap bergerak (hub).
    this.hubUnsub = binanceWs.subscribeMulti(this.symbols, (tickers) => this.applyHubTickers(tickers));
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.symbols.length === 0) return;
    if (typeof WebSocket === "undefined") {
      this.wsState = "OFFLINE";
      this.emitNow();
      return;
    }
    this.clearReconnect();
    this.wsState = "CONNECTING";
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildCombinedStreamUrl(this.symbols));
    } catch {
      this.wsState = "OFFLINE";
      this.emitNow();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    if (typeof (ws as any).binaryType === "string") (ws as any).binaryType = "arraybuffer";

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsState = "CONNECTED";
      this.attempt = 0;
      this.lastWsAt = Date.now();
      this.emitNow();
      this.startWatchdog();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      const tick = parseMarkPriceEvent(event.data);
      if (!tick || !this.symbolSet.has(tick.symbol)) return;
      this.marks.set(tick.symbol, { mark: tick.mark, at: tick.at, source: "WS" });
      this.lastWsAt = Date.now();
      this.dirty = true;
      this.scheduleEmit();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsState = "OFFLINE";
      this.emitNow();
      this.scheduleReconnect();
    };
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      const status = this.status();
      if (status !== this.lastStatus) this.emitNow();
      if (this.wsState !== "CONNECTED") return;
      if (this.ws && !isWsFresh(this.lastWsAt)) {
        // Koneksi "terbuka" tapi tidak ada tick (mis. diblokir proxy).
        this.teardownWs();
        this.wsState = "OFFLINE";
        this.emitNow();
        this.scheduleReconnect();
      }
    }, WATCHDOG_MS);
    if (typeof (this.watchdogTimer as any)?.unref === "function") (this.watchdogTimer as any).unref();
  }

  private applyHubTickers(tickers: Map<string, LiveTicker>): void {
    if (this.isWsLive()) return; // WS primadona — jangan ditimpa hub
    const now = Date.now();
    let touched = false;
    for (const [sym, t] of tickers) {
      if (!this.symbolSet.has(sym)) continue;
      const mark = Number(t?.markPrice);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      this.marks.set(sym, { mark, at: Number(t.lastUpdated) || now, source: "HUB" });
      touched = true;
    }
    if (touched) {
      this.dirty = true;
      this.scheduleEmit();
    }
  }

  private scheduleReconnect(): void {
    if (this.symbols.length === 0 || this.reconnectTimer) return;
    const delay = nextReconnectDelayMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.emitNow();
    }, THROTTLE_MS);
  }

  private emitNow(): void {
    const snap = this.snapshot();
    this.lastStatus = snap.status;
    for (const sub of this.subs.values()) {
      try {
        sub.cb({ marks: new Map(snap.marks), status: snap.status, wsState: snap.wsState });
      } catch {
        /* listener rusak tidak boleh mematikan feed */
      }
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownWs(): void {
    this.clearReconnect();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.wsState = "OFFLINE";
    this.lastWsAt = null;
  }

  private teardownHub(): void {
    if (this.hubUnsub) {
      this.hubUnsub();
      this.hubUnsub = null;
    }
  }
}

export const markPriceFeed = new MarkPriceFeed();
