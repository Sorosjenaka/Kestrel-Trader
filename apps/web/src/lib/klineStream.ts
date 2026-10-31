// apps/web/src/lib/klineStream.ts
//
// Feed candle realtime untuk SEMUA chart (Terminal, Market, chart posisi Live).
//
// Transport (30 Okt 2026, perintah operator): satu WebSocket publik Binance
// Futures combined stream langsung dari browser:
//   wss://fstream.binance.com/market/ws/stream?streams=btcusdt@kline_1m/…
// Path lama "/stream" dan "/ws/" membuka handshake tapi TIDAK mengirim data;
// "/market/ws/stream" terbukti mengalir (lihat markPriceFeed.ts).
//
// Kontrak lama dipertahankan: refcount listener per (symbol,interval), satu
// koneksi gabungan untuk semua panel, rebuild di-debounce 300ms saat daftar
// pairs berubah (React StrictMode tidak boleh mengganti koneksi), status per
// entry + auto-reconnect backoff. TIDAK ada polling REST di modul ini —
// history awal tetap diambil konsumen lewat klineCache sekali saat mount.
export interface StreamCandle {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  takerBuyBase: number;
  takerBuyQuote: number;
  closed: boolean;
  eventTime: number;
  receivedAt: number;
}

export type StreamState = "CONNECTING" | "WS_ACTIVE" | "WS_QUIET" | "DEGRADED" | "ERROR";

export interface StreamStatus {
  state: StreamState;
  lastEventAt: number | null;
  lastReceiveAt: number | null;
  detail?: string;
}

export interface StreamPair {
  symbol: string;
  interval: string;
}

type Listener = (candle: StreamCandle) => void;
type StatusListener = (status: StreamStatus) => void;

interface Entry {
  key: string;
  symbol: string;
  interval: string;
  listeners: Set<Listener>;
  statusListeners: Set<StatusListener>;
  lastEventAt: number | null;
  lastReceiveAt: number | null;
}

const entries = new Map<string, Entry>();
let socket: WebSocket | null = null;
let socketPairs = "";
let rebuildTimer: number | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let watchdog: number | null = null;

export const REBUILD_DEBOUNCE_MS = 300;
const MAX_RECONNECT_MS = 15_000;
const QUIET_MS = 8_000;
const DEGRADED_MS = 20_000;

function normalizeInterval(interval: string): string {
  return String(interval ?? "").toLowerCase();
}

function keyOf(symbol: string, interval: string): string {
  return `${String(symbol ?? "").toUpperCase()}:${normalizeInterval(interval)}`;
}

/** URL combined stream publik (satu koneksi untuk semua pair). */
export function buildKlineStreamUrl(pairs: readonly StreamPair[]): string {
  const streams = Array.from(
    new Set(pairs.map((p) => `${String(p.symbol).toLowerCase()}@kline_${normalizeInterval(p.interval)}`)),
  ).sort();
  return `wss://fstream.binance.com/market/ws/stream?streams=${streams.join("/")}`;
}

function pairsKey(): string {
  return [...entries.keys()].sort().join(",");
}

function parsePairs(key: string): StreamPair[] {
  if (!key) return [];
  return key.split(",").map((k) => {
    const [symbol, interval] = k.split(":");
    return { symbol: symbol!, interval: interval! };
  });
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse payload kline Binance (`{e:"kline",k:{…}}`) atau bentuk relay lama. */
export function parseStreamCandle(raw: unknown): StreamCandle | null {
  let payload: any = raw;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  let c: any;
  let eventTime: number | null = null;
  if (payload.e === "kline" && payload.k) {
    c = payload.k;
    eventTime = finite(payload.E) ?? finite(payload.k?.t);
  } else if (payload.type === "kline" && payload.candle) {
    c = payload.candle;
    eventTime = finite(c.eventTime) ?? null;
  } else {
    return null;
  }

  const symbol = String(c.symbol ?? c.s ?? "").toUpperCase();
  const interval = normalizeInterval(c.interval ?? c.i ?? "");
  const openTime = finite(c.openTime ?? c.t);
  const open = finite(c.open ?? c.o), high = finite(c.high ?? c.h), low = finite(c.low ?? c.l), close = finite(c.close ?? c.c);
  const volume = finite(c.volume ?? c.v);
  const time = finite(c.time) ?? (openTime !== null ? Math.floor(openTime / 1000) : null);
  if (!symbol || !interval || openTime === null || time === null || open === null || high === null || low === null || close === null || volume === null) return null;
  if (openTime <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return {
    symbol,
    interval,
    openTime,
    closeTime: finite(c.closeTime ?? c.T) ?? openTime,
    time,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: finite(c.quoteVolume ?? c.q) ?? 0,
    takerBuyBase: finite(c.takerBuyBase ?? c.V) ?? 0,
    takerBuyQuote: finite(c.takerBuyQuote ?? c.Q) ?? 0,
    closed: Boolean(c.closed ?? c.x),
    eventTime: eventTime ?? Date.now(),
    receivedAt: Date.now(),
  };
}

function emitStatus(entry: Entry, status: StreamStatus): void {
  for (const listener of entry.statusListeners) {
    try {
      listener(status);
    } catch {
      /* one panel must not break others */
    }
  }
}

function statusFor(entry: Entry, now = Date.now()): StreamState {
  if (entry.lastReceiveAt === null || entry.lastEventAt === null) return "CONNECTING";
  const age = now - entry.lastEventAt;
  if (age > DEGRADED_MS) return "DEGRADED";
  if (age > QUIET_MS) return "WS_QUIET";
  return "WS_ACTIVE";
}

function ensureWatchdog(): void {
  if (watchdog !== null || typeof window === "undefined") return;
  watchdog = window.setInterval(() => {
    const now = Date.now();
    for (const entry of entries.values()) {
      const state = statusFor(entry, now);
      if (state !== "WS_ACTIVE") {
        emitStatus(entry, {
          state,
          lastEventAt: entry.lastEventAt,
          lastReceiveAt: entry.lastReceiveAt,
          detail: state === "DEGRADED" ? "NO_KLINE_EVENT" : undefined,
        });
      }
    }
    if (!socket && reconnectTimer === null) scheduleReconnect();
  }, 5_000);
}

function stopWatchdogIfIdle(): void {
  if (entries.size > 0) return;
  if (watchdog !== null) {
    window.clearInterval(watchdog);
    watchdog = null;
  }
}

function clearReconnect(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (entries.size === 0 || typeof window === "undefined" || reconnectTimer !== null) return;
  const delay = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** Math.min(10, reconnectAttempt++));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (entries.size === 0 || typeof window === "undefined" || typeof WebSocket === "undefined") return;
  const pairs = parsePairs(pairsKey());
  const url = buildKlineStreamUrl(pairs);
  socketPairs = pairsKey();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    for (const entry of entries.values()) {
      emitStatus(entry, { state: "ERROR", lastEventAt: entry.lastEventAt, lastReceiveAt: entry.lastReceiveAt, detail: (e as Error).message });
    }
    scheduleReconnect();
    return;
  }
  socket = ws;
  for (const entry of entries.values()) {
    emitStatus(entry, { state: "CONNECTING", lastEventAt: entry.lastEventAt, lastReceiveAt: entry.lastReceiveAt });
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
  };
  ws.onmessage = (event: MessageEvent) => {
    if (socket !== ws) return;
    const candle = parseStreamCandle(event.data);
    if (!candle) return;
    const entry = entries.get(keyOf(candle.symbol, candle.interval));
    if (!entry) return;
    const now = Date.now();
    entry.lastReceiveAt = now;
    entry.lastEventAt = now;
    for (const listener of entry.listeners) {
      try {
        listener({ ...candle, receivedAt: now });
      } catch {
        /* ignore */
      }
    }
    emitStatus(entry, { state: "WS_ACTIVE", lastEventAt: entry.lastEventAt, lastReceiveAt: entry.lastReceiveAt });
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    for (const entry of entries.values()) {
      emitStatus(entry, { state: "DEGRADED", lastEventAt: entry.lastEventAt, lastReceiveAt: entry.lastReceiveAt, detail: "WS_RECONNECTING" });
    }
    scheduleReconnect();
  };
}

function closeSocket(): void {
  clearReconnect();
  if (socket) {
    const ws = socket;
    socket = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

function rebuildNow(): void {
  rebuildTimer = null;
  const pairs = pairsKey();
  if (!pairs) {
    closeSocket();
    stopWatchdogIfIdle();
    socketPairs = "";
    return;
  }
  if (pairs === socketPairs && socket && socket.readyState !== 2 /* CLOSED */) return;
  closeSocket();
  connect();
}

function scheduleRebuild(): void {
  if (typeof window === "undefined") return;
  if (rebuildTimer !== null) return;
  rebuildTimer = window.setTimeout(rebuildNow, REBUILD_DEBOUNCE_MS);
}

/**
 * Subscribe satu pasangan (symbol, interval) ke stream multiplex.
 * Return fungsi unsubscribe idempotent.
 */
export function subscribeKlineStreamMulti(
  symbol: string,
  interval: string,
  onCandle: (candle: StreamCandle) => void,
  onStatus: (status: StreamStatus) => void,
): () => void {
  const normSymbol = String(symbol ?? "").toUpperCase();
  const normInterval = normalizeInterval(interval);
  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    onStatus({ state: "ERROR", lastEventAt: null, lastReceiveAt: null, detail: "WEBSOCKET_UNAVAILABLE" });
    return () => {};
  }
  const key = keyOf(normSymbol, normInterval);
  let entry = entries.get(key);
  const isNew = !entry;
  if (!entry) {
    entry = { key, symbol: normSymbol, interval: normInterval, listeners: new Set(), statusListeners: new Set(), lastEventAt: null, lastReceiveAt: null };
    entries.set(key, entry);
  }
  entry.listeners.add(onCandle);
  entry.statusListeners.add(onStatus);
  onStatus({ state: "CONNECTING", lastEventAt: entry.lastEventAt, lastReceiveAt: entry.lastReceiveAt });
  ensureWatchdog();
  if (isNew) {
    // pairs berubah -> URL berubah. Jangan close/reopen seketika (debounce):
    // mount/unmount berpasangan dalam 300ms tidak mengganti koneksi.
    if (socket) scheduleRebuild();
    else connect();
  } else {
    connect();
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const e = entries.get(key);
    if (!e) return;
    e.listeners.delete(onCandle);
    e.statusListeners.delete(onStatus);
    if (e.listeners.size === 0 && e.statusListeners.size === 0) {
      entries.delete(key);
      scheduleRebuild();
    }
  };
}

/** Subscribe satu pasangan (API lama) — delegasi ke multiplex. */
export function subscribeKlineStream(
  symbol: string,
  interval: string,
  onCandle: (candle: StreamCandle) => void,
  onStatus: (status: StreamStatus) => void,
): () => void {
  return subscribeKlineStreamMulti(symbol, interval, onCandle, onStatus);
}
