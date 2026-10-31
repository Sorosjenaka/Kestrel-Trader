// apps/server/src/marketdata/liquidationHub.ts
// LIQUIDATION HUB (14 Okt 2026, permintaan operator — heatmap likuidasi real-time):
// subscribe stream publik Binance Futures `!forceOrder@arr` (SEMUA likuidasi,
// satu koneksi), simpan ring buffer per simbol + global, sajikan via REST
// /api/liquidations untuk heatmap web & snapshot LLM Market Analyst.
//  - !forceOrder@arr mengirim event likuidasi semua simbol (limit order IOC
//    "force" dari liquidation engine) — data resmi Binance, tanpa API key.
//  - side SELL  = LONG dilikuidasi; side BUY = SHORT diluidasi.
//  - Ring buffer 400 event/simbol + 1200 global (muat ~hari aktif).
import WebSocket, { type RawData } from "ws";
import { env } from "../core/env.js";

export interface LiquidationEvent {
  symbol: string;
  side: string;          // SELL = long likuid, BUY = short likuid
  price: number;
  qty: number;
  notionalUsd: number;
  time: number;          // epoch ms
}

const RING_PER_SYMBOL = 400;
const RING_GLOBAL = 1200;
const HOSTS = ["wss://fstream.binance.com/ws", "wss://fstream1.binance.com/ws"];
const STALE_MS = 3 * 60 * 60 * 1000; // buang event > 3 jam

/**
 * Parser murni payload !forceOrder@arr (diekspor untuk unit test):
 * SELL = LONG dilikuidasi, BUY = SHORT dilikuidasi. Mengembalikan null untuk
 * payload rusak/asing — JANGAN pernah mengarang event.
 */
export function parseForceOrderMessage(raw: string, now = Date.now()): LiquidationEvent | null {
  try {
    const msg = JSON.parse(raw);
    const o = msg?.o;
    if (!o || typeof o.s !== "string") return null;
    const price = Number(o.ap ?? o.p) || 0;
    const qty = Number(o.q) || 0;
    if (!(price > 0) || !(qty > 0)) return null;
    return {
      symbol: String(o.s).toUpperCase(),
      side: String(o.S ?? "").toUpperCase(),
      price,
      qty,
      notionalUsd: price * qty,
      time: Number(o.T) || now,
    };
  } catch {
    return null;
  }
}

class LiquidationHub {
  private global: LiquidationEvent[] = [];
  private bySymbol = new Map<string, LiquidationEvent[]>();
  private ws: WebSocket | null = null;
  private hostIdx = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  private lastEventAt = 0;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    const url = HOSTS[this.hostIdx % HOSTS.length]! + "/!forceOrder@arr";
    try {
      const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
      this.ws = ws;
      ws.on("open", () => { this.lastEventAt = Date.now(); });
      ws.on("message", (raw: RawData) => {
        const ev = parseForceOrderMessage(raw.toString());
        if (!ev) return; // payload rusak: abaikan, jangan mengarang data
        this.lastEventAt = Date.now();
        this.push(ev);
      });
      ws.on("error", () => { try { ws.close(); } catch { /* noop */ } });
      ws.on("close", () => {
        if (!this.started) return;
        this.hostIdx++;
        this.scheduleReconnect();
      });
    } catch {
      this.hostIdx++;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, 4000);
  }

  private push(ev: LiquidationEvent): void {
    this.global.push(ev);
    if (this.global.length > RING_GLOBAL) this.global.splice(0, this.global.length - RING_GLOBAL);
    let arr = this.bySymbol.get(ev.symbol);
    if (!arr) { arr = []; this.bySymbol.set(ev.symbol, arr); }
    arr.push(ev);
    if (arr.length > RING_PER_SYMBOL) arr.splice(0, arr.length - RING_PER_SYMBOL);
  }

  /** Buang event tua agar heatmap memang data segar. */
  private prune(): void {
    const cutoff = Date.now() - STALE_MS;
    while (this.global.length && this.global[0]!.time < cutoff) this.global.shift();
    for (const [sym, arr] of this.bySymbol) {
      while (arr.length && arr[0]!.time < cutoff) arr.shift();
      if (arr.length === 0) this.bySymbol.delete(sym);
    }
  }

  recent(symbol?: string, limit = 300): { events: LiquidationEvent[]; fetchedAt: number; stale: boolean } {
    this.prune();
    const src = symbol ? (this.bySymbol.get(symbol.toUpperCase()) ?? []) : this.global;
    const connected = this.ws?.readyState === WebSocket.OPEN;
    return {
      events: src.slice(-limit).reverse(), // terbaru dulu
      fetchedAt: Date.now(),
      // Data hanya dianggap fresh saat koneksi hidup; buffer saat putus = data lama.
      stale: !connected,
    };
  }

  /** Agregat ringkas untuk snapshot LLM analyst (window menit). */
  summary(windowMin = 60): {
    generatedAt: number;
    windowMin: number; totalNotionalUsd: number; longLiqUsd: number; shortLiqUsd: number;
    count: number; topSymbols: Array<{ symbol: string; notionalUsd: number; count: number }>;
  } {
    this.prune();
    const cutoff = Date.now() - windowMin * 60_000;
    const win = this.global.filter((e) => e.time >= cutoff);
    const longLiq = win.filter((e) => e.side === "SELL");
    const shortLiq = win.filter((e) => e.side === "BUY");
    const perSym = new Map<string, { notionalUsd: number; count: number }>();
    for (const e of win) {
      const cur = perSym.get(e.symbol) ?? { notionalUsd: 0, count: 0 };
      cur.notionalUsd += e.notionalUsd; cur.count++;
      perSym.set(e.symbol, cur);
    }
    const topSymbols = [...perSym.entries()]
      .map(([symbol, v]) => ({ symbol, ...v }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd)
      .slice(0, 5);
    return {
      generatedAt: Date.now(),
      windowMin,
      totalNotionalUsd: Math.round(win.reduce((s, e) => s + e.notionalUsd, 0)),
      longLiqUsd: Math.round(longLiq.reduce((s, e) => s + e.notionalUsd, 0)),
      shortLiqUsd: Math.round(shortLiq.reduce((s, e) => s + e.notionalUsd, 0)),
      count: win.length,
      topSymbols,
    };
  }

  /**
   * Status (audit 14 Okt 2026): kesehatan KONEKSI dipisah dari kebaruan EVENT.
   *  - dataState:   "CONNECTED" (WS open) | "DISCONNECTED" (putus/belum start)
   *  - eventState:  "FLOWING" (event terakhir <= 5 mnt) | "NO_RECENT_EVENTS"
   *    Stream sepat tanpa event TIDAK dianggap stale — itu kondisi normal pasar
   *    sepi. STALE hanya untuk buffer yang datanya tua saat koneksi putus.
   */
  dataState(): "CONNECTED" | "DISCONNECTED" {
    return this.ws?.readyState === WebSocket.OPEN ? "CONNECTED" : "DISCONNECTED";
  }

  eventState(): "FLOWING" | "NO_RECENT_EVENTS" {
    if (!this.lastEventAt) return "NO_RECENT_EVENTS";
    return Date.now() - this.lastEventAt <= 300_000 ? "FLOWING" : "NO_RECENT_EVENTS";
  }

  status() {
    const connected = this.ws?.readyState === WebSocket.OPEN;
    return {
      started: this.started,
      connected,
      dataState: this.dataState(),
      eventState: this.eventState(),
      // Buffer disimpan → datanya bisa disajikan walau koneksi baru putus;
      // tapi kalau koneksi putus, klaim kebaruan harus memburuk: mark stale.
      stale: !connected && this.global.length > 0,
      lastEventAt: this.lastEventAt || null,
      serverNow: Date.now(),
      globalBuffered: this.global.length,
      symbolsBuffered: this.bySymbol.size,
    };
  }
}

export const liquidationHub = new LiquidationHub();
