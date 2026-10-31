// apps/server/src/marketdata/wsLink.ts
// Koneksi WebSocket yang pulih sendiri untuk hub mikrostruktur.
//  - auto-reconnect dengan backoff eksponensial (jitter)
//  - heartbeat: deteksi socket mati yang tidak memicu 'close'
//  - backpressure guard: jangan queue tanpa batas
// Semua koneksi ada di backend VPS 24/7 (bukan polling dari browser).
import WebSocket, { type RawData } from "ws";
import { logger } from "../core/logger.js";

export interface WsLinkOptions {
  name: string;
  url: string | (() => string);
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: string, ws: WebSocket) => void;
  onClose?: (code: number, reason: string) => void;
  /** Interval heartbeat ms; 0 = tanpa heartbeat. */
  heartbeatMs?: number;
  /**
   * Payload keep-alive yang dikirim tiap heartbeat. WAJIB untuk bursa yang
   * memutus koneksi tanpa traffic dari client — mis. KuCoin menutup socket
   * (code 1000 "Bye") 60 detik setelah connect bila tidak menerima
   * JSON `{"type":"ping"}` (dibuktikan probe live 25 Okt 2026:
   * apps/server/tools/probe-kucoin-ws-close.ts).
   */
  heartbeatPayload?: string | object | (() => string | object);
  /** deemed dead bila tidak ada pesan selama ini (ms). */
  idleTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Header tambahan (mis. User-Agent Binance). */
  headers?: Record<string, string>;
  /** factory socket (untuk unit test offline). */
  makeSocket?: (url: string) => WebSocket;
}

/**
 * Redaksi URL WS untuk log: hilangkan credential di query string.
 *
 * WAJIB: endpoint KUCOIN memuat bullet-public token di query (?token=...).
 * Sebelum ada fungsi ini, token bocor PENUH ke journalctl setiap reconnect
 * (terbukti di journal 25 Okt 2026 baris WS_CONNECTED). Cukup sisakan
 * nama parameter sebagai `present=true` — jangan pernah nilai aslinya.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.search) return u.toString();
    const parts: string[] = [];
    for (const [k, v] of u.searchParams.entries()) {
      parts.push(`${k}=${v ? "present=true" : ""}`);
    }
    u.search = `?${parts.join("&")}`;
    return u.toString();
  } catch {
    // URL tidak valid — jangan pernah log mentah-mentah.
    return "<invalid-url>";
  }
}

export class ResilientWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private connectTimeout: NodeJS.Timeout | null = null;

  connected = false;
  connects = 0;
  messages = 0;
  reconnects = 0;
  lastError: string | null = null;
  lastMessageAtMs = 0;

  constructor(private readonly opts: WsLinkOptions) {}

  /**
   * Mulai (atau RESTART) koneksi.
   *
   * PENTING (fix 25 Okt 2026): `start()` SEBELUMNYA bail-out kalau
   * `stopped === true`, sehingga pasangan `link.stop(); link.start();`
   * (dipakai refresh token KUCOIN tiap 25 menit) menjadi NO-OP dan venue
   * mati permanen tanpa error. `start()` kini selalu menyambung ulang —
   * pemanggil yang benar-benar tidak mau restart cukup TIDAK memanggil
   * `start()` lagi. `stop()` tetap berarti "matikan".
   */
  start(): void {
    this.stopped = false;
    // Batalkan reconnect yang masih tertunda supaya tidak ada dua socket.
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Socket lama masih hidup? Tutup dulu supaya start() = koneksi baru.
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      this.connected = false;
      try { ws.removeAllListeners(); ws.close(); } catch { /* noop */ }
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.connectTimeout) { clearTimeout(this.connectTimeout); this.connectTimeout = null; }
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* noop */ } }
  }

  /** Kirim payload; otomatis reconnect bila socket belum siap. */
  send(data: string | object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof data === "string" ? data : JSON.stringify(data));
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      return false;
    }
  }

  private currentUrl(): string {
    return typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.currentUrl();
    let ws: WebSocket;
    try {
      const factory = this.opts.makeSocket ?? ((u: string) => new WebSocket(u, { handshakeTimeout: 12_000, headers: this.opts.headers }));
      ws = factory(url);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connects++;

    // Socket yang tidak OPEN dalam 12 detik = blackhole -> paksa tutup.
    this.connectTimeout = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        this.lastError = "connect timeout";
        try { ws.terminate(); } catch { /* noop */ }
      }
    }, 12_000);

    ws.on("open", () => {
      if (this.connectTimeout) { clearTimeout(this.connectTimeout); this.connectTimeout = null; }
      this.connected = true;
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.lastMessageAtMs = this.lastMessageAt;
      logger.info({ link: this.opts.name, url: redactUrl(url) }, "WS_CONNECTED");
      try { this.opts.onOpen?.(ws); } catch (err) {
        logger.warn({ link: this.opts.name, err: (err as Error).message }, "WS onOpen gagal");
      }
      this.armIdleWatchdog();
      this.armHeartbeat();
    });

    ws.on("message", (raw: RawData) => {
      this.messages++;
      this.lastMessageAt = Date.now();
      this.lastMessageAtMs = this.lastMessageAt;
      this.armIdleWatchdog();
      try {
        this.opts.onMessage(raw.toString(), ws);
      } catch (err) {
        logger.warn({ link: this.opts.name, err: (err as Error).message }, "WS handler gagal");
      }
    });

    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      logger.warn({ link: this.opts.name, err: err.message }, "WS_ERROR");
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.connectTimeout) { clearTimeout(this.connectTimeout); this.connectTimeout = null; }
      if (this.ws === ws) this.ws = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (wasConnected) {
        this.reconnects++;
        logger.warn({ link: this.opts.name, code, reason: reason?.toString()?.slice(0, 80) }, "WS_CLOSED");
      }
      try { this.opts.onClose?.(code, reason?.toString?.() ?? ""); } catch { /* noop */ }
      this.scheduleReconnect();
    });
  }

  /** Watchdog: socket yang diam terlalu lama dianggap mati → reconnect. */
  private armIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeout = this.opts.idleTimeoutMs ?? 0;
    if (!timeout) return;
    this.idleTimer = setTimeout(() => {
      if (this.stopped) return;
      this.lastError = `idle > ${timeout}ms`;
      logger.warn({ link: this.opts.name }, "WS_IDLE_TIMEOUT");
      try { this.ws?.terminate(); } catch { /* noop */ }
    }, timeout);
  }

  /**
   * Heartbeat: kirim payload keep-alive secara periodik.
   * Tanpa ini, bursa seperti KuCoin menutup koneksi (code 1000 "Bye")
   * tepat 60 detik setelah connect karena tidak ada traffic dari client —
   * walau subscribe sudah ack dan trade terus mengalir (lihat probe live
   * apps/server/tools/probe-kucoin-ws-close.ts, 25 Okt 2026).
   */
  private armHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = this.opts.heartbeatMs ?? 0;
    const payload = this.opts.heartbeatPayload;
    if (!interval || !payload) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped) return;
      this.send(typeof payload === "function" ? payload() : payload);
    }, interval);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.opts.reconnectBaseMs ?? 1500;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.retry, 6));
    // jitter ±25% supaya banyak venue tidak reconnect serempak
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    this.retry++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, Math.max(500, delay + jitter));
  }
}
