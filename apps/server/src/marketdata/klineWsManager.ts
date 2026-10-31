// Public Binance USDⓈ-M Futures kline stream fan-in.
//
// One upstream combined WebSocket is shared by every browser panel. The
// browser receives read-only SSE from /api/binance/kline-stream; no private
// endpoint, no order client and no REST polling on the normal path.
import WebSocket from "ws";
import { env } from "../core/env.js";

export type KlineStreamStatus = "STOPPED" | "CONNECTING" | "CONNECTED" | "DEGRADED";

export interface StreamCandle {
  symbol: string;
  interval: string;
  openTime: number;   // milliseconds, Binance source
  closeTime: number;
  time: number;       // UTC seconds, chart contract
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  takerBuyBase: number;
  takerBuyQuote: number;
  closed: boolean;
  eventTime: number;  // milliseconds
  receivedAt: number; // milliseconds
}

interface Subscriber {
  symbol: string;
  interval: string;
  onCandle: (candle: StreamCandle) => void;
}

interface CandidateHost {
  host: string;
  path: string;
}

const INTERVAL_RE = /^(1m|3m|5m|15m|1h|4h|1d)$/;
const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;
const HEARTBEAT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 20_000;
// Probed from this VPS on 2026-10-20: the documented legacy routes /stream and
// /ws complete the handshake but deliver ZERO kline messages; only the
// /market/* routes stream data. Dead routes must never sit ahead of the live
// one, or the reconnect rotation stalls on them.
const COMBINED_PATH = "/market/stream?streams=";

function normalizeInterval(value: string): string {
  const v = String(value || "").trim().toLowerCase();
  return v === "1D".toLowerCase() ? "1d" : v;
}

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNegative(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse one Binance kline payload. Kept pure so it can be tested offline.
 * Returns null for malformed/foreign messages and never throws.
 */
export function parseKlineEvent(raw: unknown, receivedAt = Date.now()): StreamCandle | null {
  let payload: any = raw;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  // Combined stream: {"stream":"btcusdt@kline_1h","data":{...}}
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    payload = payload.data;
  }
  if (!payload || typeof payload !== "object") return null;
  const k = payload.k;
  if (!k || typeof k !== "object") return null;
  if (payload.e !== "kline" && payload.e !== undefined) return null;
  const symbol = String(k.s ?? payload.s ?? "").toUpperCase();
  const interval = normalizeInterval(String(k.i ?? ""));
  if (!SYMBOL_RE.test(symbol) || !INTERVAL_RE.test(interval)) return null;
  const openTime = Number(k.t);
  const closeTime = Number(k.T);
  const open = finitePositive(k.o);
  const high = finitePositive(k.h);
  const low = finitePositive(k.l);
  const close = finitePositive(k.c);
  const volume = finiteNonNegative(k.v);
  const quoteVolume = finiteNonNegative(k.q) ?? 0;
  const takerBuyBase = finiteNonNegative(k.V) ?? 0;
  const takerBuyQuote = finiteNonNegative(k.Q) ?? 0;
  if (![openTime, closeTime, open, high, low, close, volume].every((v) => Number.isFinite(v))) return null;
  if (openTime <= 0 || closeTime < openTime || high! < low! || high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) return null;
  return {
    symbol, interval, openTime, closeTime, time: Math.floor(openTime / 1000),
    open: open!, high: high!, low: low!, close: close!, volume: volume!,
    quoteVolume, takerBuyBase, takerBuyQuote, closed: Boolean(k.x),
    eventTime: Number.isFinite(Number(payload.E)) ? Number(payload.E) : receivedAt,
    receivedAt,
  };
}

class KlineStreamManager {
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private subscribers = new Set<Subscriber>();
  private latest = new Map<string, StreamCandle>();
  private candidate = 0;
  private status: KlineStreamStatus = "STOPPED";
  private lastMessageAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private reconnects = 0;
  private messages = 0;
  private connects = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maintainTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 250;
  private lastPingAt: number | null = null;
  private openedAt: number | null = null;
  /** Stream yang sudah terdaftar di socket saat ini (23 Okt 2026: SUBSCRIBE dinamis). */
  private subscribedStreams = new Set<string>();
  /** Stream yang menunggu socket OPEN untuk di-SUBSCRIBE. */
  private pendingSubscribe = new Set<string>();
  private subscribeId = 0;

  constructor() {
    this.maintainTimer = setInterval(() => this.maintain(), 1000);
  }

  private key(symbol: string, interval: string): string {
    return `${symbol.toUpperCase()}:${normalizeInterval(interval)}`;
  }

  private streams(): string[] {
    return [...new Set([...this.subscribers].map((s) => `${s.symbol.toLowerCase()}@kline_${normalizeInterval(s.interval)}`))];
  }

  private candidates(): CandidateHost[] {
    const hosts = [env.BINANCE_WS_PRIMARY, env.BINANCE_WS_FALLBACK].filter(Boolean);
    // Probe from this VPS (20 Okt 2026): only the /market combined route
    // delivers kline data; the legacy /stream and /ws routes handshake but
    // stay silent. Rotating onto a silent route caused reconnect storms.
    return hosts.map((host) => ({ host, path: COMBINED_PATH }));
  }

  private nextUrl(): string | null {
    const streams = this.streams();
    if (!streams.length) return null;
    const all = this.candidates();
    if (!all.length) return null;
    const c = all[this.candidate % all.length];
    this.candidate += 1;
    return `wss://${c.host}${c.path}${streams.join("/")}`;
  }

  /**
   * 23 Okt 2026: tambah stream ke socket yang HIDUP tanpa reconnect.
   * Binance combined stream menerima SUBSCRIBE runtime.
   *
   * PENTING: sock.send() HANYA aman kalau socket sudah OPEN (readyState 1).
   * Kalau socket masih CONNECTING, send() melempar "WebSocket is not open" —
   * dulu itu memicu closeSocket() + reconnect, jadi 8 panel yang subscribe
   * hampir bersamaan =&gt; reconnect storm =&gt; sebagian panel tidak pernah
   * dapat kline (state CONNECTING selamanya).
   *
   * Solusi: stream yang belum terdaftar di socket disimpan di pendingSubscribe
   * dan dikirim setelah event "open".
   */
  private sendSubscribe(streamName: string): void {
    const sock = this.socket;
    if (!sock) return;
    if ((sock as unknown as { readyState?: number }).readyState !== 1) {
      this.pendingSubscribe.add(streamName);
      return;
    }
    try {
      sock.send(JSON.stringify({ method: "SUBSCRIBE", params: [streamName], id: ++this.subscribeId }));
      this.subscribedStreams.add(streamName);
      this.pendingSubscribe.delete(streamName);
    } catch {
      // Socket tidak bisa menerima -> paksa rebuild sekali.
      this.pendingSubscribe.add(streamName);
      this.closeSocket();
      this.scheduleReconnect();
    }
  }

  private closeSocket(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    const sock = this.socket;
    this.socket = null;
    this.socketGeneration += 1;
    this.openedAt = null;
    this.subscribedStreams.clear();
    // pendingSubscribe TIDAK dihapus: stream itu masih dibutuhkan dan akan
    // dikirim ke socket berikutnya. Yang hilang hanya status "sudah terkirim".
    if (sock) { try { sock.close(); } catch { /* ignore */ } }
    this.status = "DEGRADED";
  }

  private scheduleConnect(delay = 0): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.streams().length) { this.status = "STOPPED"; return; }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.socket || !this.streams().length) return;
    const url = this.nextUrl();
    if (!url) return;
    this.status = "CONNECTING";
    this.connects += 1;
    const generation = ++this.socketGeneration;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    this.connectTimer = setTimeout(() => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      this.lastError = "KLINE_CONNECT_TIMEOUT";
      this.closeSocket();
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    sock.on("open", () => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.status = "CONNECTED";
      this.lastError = null;
      this.reconnectDelay = 250;
      // Streams yang sudah di-SUBSCRIBE pada socket ini (23 Okt 2026). Kalau
      // socket dibangun ulang, daftar harus diisi ulang supaya subscribe
      // berikutnya tidak mengirim SUBSCRIBE ganda.
      this.subscribedStreams.clear();
      for (const s of this.streams()) this.subscribedStreams.add(s);
      // Stream yang arrive saat socket masih CONNECTING -> kirim sekarang.
      for (const s of this.pendingSubscribe) {
        try { sock.send(JSON.stringify({ method: "SUBSCRIBE", params: [s], id: ++this.subscribeId })); this.subscribedStreams.add(s); this.pendingSubscribe.delete(s); } catch { /* retry next open */ }
      }
      // Per-connection freshness baseline. A stale timestamp carried over
      // from a previous socket used to make maintain() kill a brand-new
      // connection on its very first tick.
      this.openedAt = Date.now();
      this.lastMessageAt = null;
      this.lastPingAt = Date.now();
    });
    // Protocol pings count as transport activity so a legitimately quiet
    // stream (4h/1d bar, thin pair) is not mistaken for a stall.
    sock.on("ping", () => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      this.lastPingAt = Date.now();
    });
    sock.on("message", (data: unknown) => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      this.messages += 1;
      this.lastMessageAt = Date.now();
      this.handleMessage(typeof data === "string" ? data : String(data));
    });
    sock.on("error", (err: unknown) => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      this.lastError = String((err as Error)?.message ?? err).slice(0, 160);
      try { sock.close(); } catch { /* close handler owns reconnect */ }
    });
    sock.on("close", (code?: number) => {
      if (this.socket !== sock || generation !== this.socketGeneration) return;
      this.socket = null;
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.status = "DEGRADED";
      this.lastError = this.lastError ?? `KLINE_CLOSE_${code ?? "UNKNOWN"}`;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.streams().length) { this.status = "STOPPED"; return; }
    this.reconnects += 1;
    const delay = Math.min(30_000, this.reconnectDelay);
    this.reconnectDelay = Math.min(30_000, Math.round(this.reconnectDelay * 1.8));
    this.scheduleConnect(delay);
  }

  private handleMessage(text: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { this.lastError = "KLINE_MALFORMED_JSON"; return; }
    /*
       23 Okt 2026: Binance membalas SUBSCRIBE dinamis dengan ack
       {"result":null,"id":N}. Ack itu BUKAN payload kline — harus diabaikan
       tanpa menandai lastError (kalau tidak, health melaporkan
       KLINE_INVALID_PAYLOAD padahal stream sehat).
    */
    const maybeAck = parsed as { result?: unknown; id?: unknown; e?: unknown } | null;
    if (maybeAck && typeof maybeAck === "object" && maybeAck.e === undefined && "id" in maybeAck && !("stream" in maybeAck) && !("data" in maybeAck)) {
      return; // ack subscribe/unsubscribe
    }
    const candle = parseKlineEvent(parsed);
    if (!candle) {
      this.lastError = "KLINE_INVALID_PAYLOAD";
      return;
    }
    const key = this.key(candle.symbol, candle.interval);
    const prev = this.latest.get(key);
    if (prev && candle.openTime < prev.openTime) return; // stale/out-of-order event
    this.latest.set(key, candle);
    this.lastEventAt = Date.now();
    this.reconnectDelay = 250; // real data proves the route is alive
    for (const sub of this.subscribers) {
      if (sub.symbol === candle.symbol && normalizeInterval(sub.interval) === candle.interval) {
        try { sub.onCandle(candle); } catch { /* one client must not stop fan-out */ }
      }
    }
  }

  private maintain(): void {
    /*
       23 Okt 2026: flush pending SUBSCRIBE.
       Stream yang arrive saat socket masih CONNECTING menunggu di
       pendingSubscribe. Kalau handler "open" sudah lewat (mis. socket
       dibangun sebelum panel keempat subscribe), stream itu tidak pernah
       terkirim -> panel itu selamanya CONNECTING tanpa kline.
       Flush berkala menutup celah itu tanpa reconnect.
    */
    if (this.socket && this.socket.readyState === 1 && this.pendingSubscribe.size > 0) {
      for (const s of [...this.pendingSubscribe]) this.sendSubscribe(s);
    }
    if (!this.streams().length) {
      if (this.socket) this.closeSocket();
      this.status = "STOPPED";
      return;
    }
    if (!this.socket) {
      if (!this.reconnectTimer) this.scheduleConnect(0);
      return;
    }
    const activityAt = Math.max(this.lastMessageAt ?? 0, this.lastPingAt ?? 0);
    const silentMs = activityAt > 0 ? Date.now() - activityAt : this.openedAt ? Date.now() - this.openedAt : 0;
    if (silentMs > HEARTBEAT_MS + 10_000) {
      this.lastError = activityAt > 0 ? "KLINE_STREAM_STALLED" : "KLINE_NO_DATA_SINCE_OPEN";
      this.closeSocket();
      this.scheduleReconnect();
    }
  }

  /** Shared ref-counted subscription. Returns an idempotent unsubscribe. */
  subscribe(symbol: string, interval: string, onCandle: (candle: StreamCandle) => void): () => void {
    const sym = String(symbol || "").toUpperCase();
    const iv = normalizeInterval(interval);
    if (!SYMBOL_RE.test(sym) || !INTERVAL_RE.test(iv)) throw new Error("INVALID_KLINE_SUBSCRIPTION");
    const sub: Subscriber = { symbol: sym, interval: iv, onCandle };
    this.subscribers.add(sub);
    const existing = this.latest.get(this.key(sym, iv));
    if (existing) { try { onCandle(existing); } catch { /* initial snapshot is best effort */ } }
    /*
       23 Okt 2026 (BUG FIX REKONEKSI): subscribe() sebelumnya menutup socket
       yang hidup dan reconnect (debounce 80ms) supaya URL memuat stream baru.
       Pada layout 8 monitor itu 8x reconnect saat panel dibuka -> stream
       mati-mati -> frontend DEGRADED -> chart jatuh ke polling.

       Binance combined stream mendukung SUBSCRIBE runtime, jadi stream baru
       cukup ditambahkan lewat pesan tanpaftekan koneksi:
         {"method":"SUBSCRIBE","params":["btcusdt@kline_1m"],"id":n}
       Socket yang hidup tetap hidup; reconnect HANYA kalau socket memang
       tidak ada / sudah rusak.
    */
    if (this.socket) {
      const streamName = `${sym.toLowerCase()}@kline_${normalizeInterval(iv)}`;
      if (!this.subscribedStreams.has(streamName) && !this.pendingSubscribe.has(streamName)) {
        this.sendSubscribe(streamName);
      }
      // Kalau socket SUDAH OPEN tapi SUBSCRIBE tadi gagal/terlewat, coba lagi.
      else if (this.socket.readyState === 1 && this.pendingSubscribe.has(streamName)) {
        this.sendSubscribe(streamName);
      }
    } else {
      this.scheduleConnect(20);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(sub);
      if (!this.subscribers.size) {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.closeSocket();
        this.status = "STOPPED";
      }
    };
  }

  health() {
    return {
      status: this.status,
      streams: this.streams().length,
      subscribers: this.subscribers.size,
      connected: this.status === "CONNECTED",
      lastMessageAgeMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
      lastEventAgeMs: this.lastEventAt ? Date.now() - this.lastEventAt : null,
      lastPingAgeMs: this.lastPingAt ? Date.now() - this.lastPingAt : null,
      openedAgeMs: this.openedAt ? Date.now() - this.openedAt : null,
      reconnects: this.reconnects,
      connects: this.connects,
      messages: this.messages,
      lastError: this.lastError,
    };
  }
}

export const klineStreamManager = new KlineStreamManager();
