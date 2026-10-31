// apps/server/src/marketdata/wsManager.ts - WS mark price SEMUA pair (FR-39, FR-24, NFR-15).
//  - Stream: !markPrice@arr@1s (update tiap 1 detik, satu koneksi untuk SEMUA simbol)
//  - URL kandidat: format baru "/market/ws/" lalu format lama "/ws/" x host fstream -> fstream1
//    (migrasi Binance: /public /market /private - lihat Schema.md Bagian 2.2)
//  - Gap > 2 dtk: auto-resubscribe (tutup + reconnect, kandidat URL berputar)
//  - Pair macet > 5 dtk: QUARANTINE (canTrade = false sampai data segar kembali)
//  - Freshness p95 = p95(now - E) per entri mark price (target NFR-15 <= 1.000 ms)
//  - Socket & timer bisa disuntik -> unit test OFFLINE.
import WebSocket from "ws";
import { env } from "../core/env.js";

export const MARKPRICE_STREAM = "!markPrice@arr@1s";
export const DEFAULT_GAP_LIMIT_MS = 2000;
export const DEFAULT_QUARANTINE_MS = 5000;
export const DEFAULT_LATENCY_WINDOW = 300;
export const DEFAULT_RECONNECT_BASE_MS = 250;
export const DEFAULT_MAINTAIN_INTERVAL_MS = 500;
// Batas handshake: kandidat yang tidak OPEN dalam N ms dianggap mati (jaringan
// memblokir/blackhole) -> socket ditutup paksa agar rotasi kandidat jalan cepat.
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

export type MakeSocket = (url: string) => {
  on: (event: string, callback: (...args: any[]) => void) => unknown;
  close: () => void;
};

export type WsEvent =
  | "mark"
  | "batch"
  | "host_switch"
  | "resubscribe"
  | "quarantine"
  | "error"
  | "status";

export interface MarkPrice {
  symbol: string;
  markPrice: number;
  indexPrice: number | null;
  fundingRate: number | null;
  eventTimeMs: number;
  receivedAtMs: number;
}

export type WsStatus = "STOPPED" | "CONNECTING" | "CONNECTED" | "DEGRADED";

export interface WsHealth {
  status: WsStatus;
  url: string | null;
  lastMessageAgeMs: number | null;
  symbolsTracked: number;
  freshnessP95Ms: number | null;
  quarantined: string[];
  reconnects: number;
  gaps: number;
  /** Diagnostik T-5.49: hitung koneksi/pesan + error terakhir. */
  connects: number;
  messages: number;
  lastError: string | null;
  lastCloseCode: number | null;
  /** Upaya beruntun tanpa satu pesan pun (indikasi throttle/blokir WS). */
  dryStreak: number;
}

export interface WsManagerOptions {
  hosts?: string[];
  makeSocket?: MakeSocket;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  gapLimitMs?: number;
  quarantineMs?: number;
  latencyWindow?: number;
  reconnectBaseMs?: number;
  maintainIntervalMs?: number;
  connectTimeoutMs?: number;
  handlers?: Partial<Record<WsEvent, (payload: any) => void>>;
}

const defaultMakeSocket: MakeSocket = (url) =>
  new WebSocket(url) as unknown as ReturnType<MakeSocket>;

defaultMakeSocket satisfies MakeSocket;

interface SymbolState {
  markPrice: number;
  indexPrice: number | null;
  fundingRate: number | null;
  lastEventMs: number;
}

export class WsMarkPriceManager {
  private readonly hosts: string[];
  private readonly paths = ["/market/ws/", "/ws/"];
  private readonly makeSocket: MakeSocket;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly gapLimitMs: number;
  private readonly quarantineMs: number;
  private readonly latencyWindow: number;
  private readonly reconnectBaseMs: number;
  private readonly maintainIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly handlers: Partial<Record<WsEvent, (payload: any) => void>>;

  private socket: ReturnType<MakeSocket> | null = null;
  private url: string | null = null;
  private candidate = 0;
  private lastIdx = 0;
  private openAt: number | null = null;
  // Retry kandidat SAMA (bukan rotasi) saat putus: 3x beruntun, lalu rotasi.
  // Mencegah rotasi mahal ke 3 URL mati saat yang bagus hanya tersendat sesaat.
  private sameRetry = 0;
  private stopped = true;
  private status: WsStatus = "STOPPED";
  private lastMsgAt: number | null = null;
  private reconnects = 0;
  private gaps = 0;
  private maintainTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  // Diagnostik T-5.49 (jawab "bot jalan atau mati" dengan data, bukan tebakan).
  private connects = 0;
  private messages = 0;
  private messagesAtConnect = 0;
  private lastError: string | null = null;
  private lastCloseCode: number | null = null;
  private dryStreak = 0;
  private readonly symbols = new Map<string, SymbolState>();
  private readonly latencies: number[] = [];
  private readonly quarantinedNow = new Set<string>();

  constructor(opts: WsManagerOptions = {}) {
    this.hosts = opts.hosts ?? [env.BINANCE_WS_PRIMARY, env.BINANCE_WS_FALLBACK];
    if (this.hosts.length === 0) throw new Error("WsMarkPriceManager: hosts kosong");
    this.makeSocket = opts.makeSocket ?? defaultMakeSocket;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.gapLimitMs = opts.gapLimitMs ?? DEFAULT_GAP_LIMIT_MS;
    this.quarantineMs = opts.quarantineMs ?? DEFAULT_QUARANTINE_MS;
    this.latencyWindow = opts.latencyWindow ?? DEFAULT_LATENCY_WINDOW;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.maintainIntervalMs = opts.maintainIntervalMs ?? DEFAULT_MAINTAIN_INTERVAL_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.handlers = opts.handlers ?? {};
  }

  private emit(event: WsEvent, payload?: unknown): void {
    const cb = this.handlers[event];
    if (cb) cb(payload as any);
  }

  private nextUrl(): string {
    const total = this.hosts.length * this.paths.length;
    const idx = this.candidate % total;
    this.candidate += 1;
    this.lastIdx = idx;
    const host = this.hosts[Math.floor(idx / this.paths.length)];
    const path = this.paths[idx % this.paths.length];
    return "wss://" + host + path + MARKPRICE_STREAM;
  }

  private connect(): void {
    if (this.stopped) return;
    const prev = this.url;
    const url = this.nextUrl();
    this.url = url;
    this.status = "CONNECTING";
    if (prev !== null && prev !== url) {
      const hostOf = (u: string) => u.split("/")[2] ?? "";
      if (hostOf(prev) !== hostOf(url)) {
        this.emit("host_switch", { from: hostOf(prev), to: hostOf(url), url });
      }
    }
    const sock = this.makeSocket(url);
    this.socket = sock;
    this.connects += 1;
    this.messagesAtConnect = this.messages;
    // Guard handshake: kandidat blackhole (SYN menggantung, tanpa open/error)
    // dipaksa tutup -> jalur close -> reconnect kandidat berikutnya. Tanpa ini
    // manager bisa macet ber-menit pada satu URL mati (kasus jaringan ID).
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.stopped || this.socket !== sock) return;
      try { sock.close(); } catch { /* abaikan */ }
    }, this.connectTimeoutMs);
    sock.on("open", () => {
      if (this.stopped || this.socket !== sock) return;
      if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.openAt = this.now();
      this.sameRetry = 0;
      this.status = "CONNECTED";
    });
    sock.on("message", (data: unknown) => {
      if (this.stopped || this.socket !== sock) return;
      this.sameRetry = 0; // ada data mengalir -> reset hitungan retry
      this.messages += 1;
      this.onMessage(typeof data === "string" ? data : String(data));
    });
    sock.on("error", (err: unknown) => {
      const msg = String((err as Error)?.message ?? err);
      this.lastError = msg.slice(0, 160);
      this.emit("error", msg);
      try { sock.close(); } catch { /* abaikan */ }
    });
    sock.on("close", (code?: unknown, _reason?: unknown) => {
      if (this.stopped || this.socket !== sock) return;
      if (typeof code === "number") this.lastCloseCode = code;
      // Upaya KERING = sejak connect tidak ada satu pesan pun masuk (handshake
      // ditolak / hang / throttle WS). Beda dengan putus setelah melayani data.
      if (this.messages === this.messagesAtConnect) {
        this.dryStreak += 1;
      } else {
        this.dryStreak = 0;
      }
      // Sticky-good: koneksi yang TERBUKTI stabil (>30 dtk melayani data) dicoba
      // LAGI duluan saat putus — jangan rotasi ke kandidat mati bila yang bagus
      // hanya terputus sesaat. Koneksi yang flapping (<30 dtk) lanjut rotasi.
      // Same-retry: putus TANPA pernah stabil (gap/timeout) -> coba URL yang SAMA
      // hingga 3x (jaringan goyang), baru rotasi. Mencegah burn 3 URL mati + ban WS.
      const servedMs = this.openAt !== null ? this.now() - this.openAt : 0;
      this.openAt = null;
      if (servedMs > 30_000) {
        this.candidate = this.lastIdx;
        this.sameRetry = 0;
      } else if (this.sameRetry < 3) {
        this.candidate = this.lastIdx;
        this.sameRetry += 1;
      } else {
        this.sameRetry = 0;
      }
      this.socket = null;
      this.status = "DEGRADED";
      this.reconnects += 1;
      // Backoff eksponensial hingga ~32 dtk (jangan spam reconnect -> WS ikut di-ban).
      // Eskalasi T-5.49: >=5 upaya KERING beruntun (handshake ditolak/throttle) ->
      // cooldown 5 menit agar IP dingin, bukan badai handshake tiap ~30 dtk.
      let waitMs: number;
      if (this.dryStreak >= 5) {
        waitMs = 5 * 60_000;
        this.emit("error", `WS_THROTTLED: ${this.dryStreak}x upaya kering beruntun, cooldown 5 mnt`);
      } else {
        const attempt = Math.min(this.reconnects, 8);
        waitMs = this.reconnectBaseMs * Math.pow(2, attempt - 1);
      }
      this.schedule(() => this.connect(), waitMs);
    });
  }

  private onMessage(text: string): void {
    const now = this.now();
    this.lastMsgAt = now;
    if (this.status !== "CONNECTED") this.status = "CONNECTED";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emit("error", "bukan JSON: " + text.slice(0, 80));
      return;
    }
    const entries: any[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "s" in (parsed as object)
        ? [parsed]
        : [];
    if (entries.length === 0) return;
    for (const e of entries) {
      if (!e || typeof e.s !== "string") continue;
      const eventTime = typeof e.E === "number" ? e.E : now;
      const latency = Math.max(0, now - eventTime);
      this.latencies.push(latency);
      if (this.latencies.length > this.latencyWindow) this.latencies.shift();
      const prev = this.symbols.get(e.s);
      this.symbols.set(e.s, {
        markPrice: typeof e.p === "string" ? Number(e.p) : (typeof e.p === "number" ? e.p : prev?.markPrice ?? 0),
        indexPrice: e.i !== undefined ? Number(e.i) : prev?.indexPrice ?? null,
        fundingRate: e.r !== undefined ? Number(e.r) : prev?.fundingRate ?? null,
        lastEventMs: eventTime,
      });
      this.quarantinedNow.delete(e.s);
      this.emit("mark", { symbol: e.s, markPrice: this.symbols.get(e.s)!.markPrice, indexPrice: this.symbols.get(e.s)!.indexPrice, fundingRate: this.symbols.get(e.s)!.fundingRate, eventTimeMs: eventTime, receivedAtMs: now } satisfies MarkPrice);
    }
    this.emit("batch", { count: entries.length, atMs: now });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnects = 0;
    this.gaps = 0;
    this.connect();
    this.maintainTimer = setInterval(() => this.maintain(), this.maintainIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.status = "STOPPED";
    if (this.maintainTimer !== null) { clearInterval(this.maintainTimer); this.maintainTimer = null; }
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    const sock = this.socket;
    this.socket = null;
    if (sock) { try { sock.close(); } catch { /* abaikan */ } }
    this.emit("status", this.status);
  }

  maintain(): void {
    if (this.stopped) return;
    const now = this.now();
    this.checkGap(now);
    this.checkQuarantine(now);
  }

  checkGap(now: number): boolean {
    if (this.socket === null) return false;
    if (this.lastMsgAt === null) return false; // belum pernah pesan -> gap diukur setelah pesan pertama
    if (now - this.lastMsgAt > this.gapLimitMs) {
      this.gaps += 1;
      this.status = "DEGRADED";
      this.lastMsgAt = now; // cegah pemicu ganda sampai pesan berikutnya
      this.emit("resubscribe", { afterMs: now - this.lastMsgAt, url: this.url });
      const sock = this.socket;
      try { sock.close(); } catch { /* abaikan */ }
      return true;
    }
    return false;
  }

  checkQuarantine(now: number): string[] {
    const newly: string[] = [];
    for (const [sym, st] of this.symbols) {
      const q = now - st.lastEventMs > this.quarantineMs;
      if (q && !this.quarantinedNow.has(sym)) {
        this.quarantinedNow.add(sym);
        newly.push(sym);
      } else if (!q && this.quarantinedNow.has(sym)) {
        this.quarantinedNow.delete(sym);
      }
    }
    if (newly.length > 0) this.emit("quarantine", { symbols: newly, atMs: now });
    return Array.from(this.quarantinedNow);
  }

  getMark(symbol: string): MarkPrice | null {
    const st = this.symbols.get(symbol);
    if (!st) return null;
    return { symbol, markPrice: st.markPrice, indexPrice: st.indexPrice, fundingRate: st.fundingRate, eventTimeMs: st.lastEventMs, receivedAtMs: this.lastMsgAt ?? st.lastEventMs };
  }

  isQuarantined(symbol: string): boolean {
    const st = this.symbols.get(symbol);
    if (!st) return true; // belum ada data = belum boleh ditrade
    return this.now() - st.lastEventMs > this.quarantineMs;
  }

  canTrade(symbol: string): boolean {
    return this.status === "CONNECTED" && !this.isQuarantined(symbol);
  }

  freshnessP95Ms(): number | null {
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[Math.max(0, idx)];
  }

  health(): WsHealth {
    const now = this.now();
    return {
      status: this.status,
      url: this.url,
      lastMessageAgeMs: this.lastMsgAt === null ? null : Math.max(0, now - this.lastMsgAt),
      symbolsTracked: this.symbols.size,
      freshnessP95Ms: this.freshnessP95Ms(),
      quarantined: Array.from(this.quarantinedNow),
      reconnects: this.reconnects,
      gaps: this.gaps,
      connects: this.connects,
      messages: this.messages,
      lastError: this.lastError,
      lastCloseCode: this.lastCloseCode,
      dryStreak: this.dryStreak,
    };
  }
}

// Instance siap pakai untuk jobs berikutnya.
export const binanceMarkPrice = new WsMarkPriceManager();