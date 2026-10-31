// tests/wsLinkRestart.test.ts — Regresi restart ResilientWs (25 Okt 2026).
//
// Bug yang dijaga: `start()` pernah bail-out kalau `stopped === true`.
// Pola `link.stop(); link.start();` (dipakai refresh token KUCOIN tiap
// 25 menit di multiVenueOrderFlowHub.primeKucoin) menjadi NO-OP =>
// venue mati permanen tanpa error/log. Bukti live: KUCOIN conn=false,
// reconnects=24, lastMessageAgeMs=10.4 juta (~2 jam 54 menit).
//
// Fix: `start()` selalu menyambung ulang, cancels reconnect tertunda,
// dan menutup socket lama supaya tidak ada dua koneksi paralel.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { ResilientWs, redactUrl } from "../src/marketdata/wsLink.js";

/** Socket palsu: rekam lifecycle open/close tanpa jaringan. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  terminate(): void {
    this.closed = true;
    this.readyState = 3;
  }
  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}

describe("ResilientWs start/stop restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop(); start() menyambung ulang (bukan no-op)", () => {
    const sockets: FakeSocket[] = [];
    const link = new ResilientWs({
      name: "TEST",
      url: "wss://example.invalid/endpoint",
      onMessage: () => {},
      idleTimeoutMs: 0,
      makeSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as never;
      },
    });

    link.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit("open");
    expect(link.connected).toBe(true);

    link.stop();
    expect(link.connected).toBe(false);
    expect(sockets[0]!.closed).toBe(true);

    // INI yang dulu no-op → venue mati permanen.
    link.start();
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    expect(link.connected).toBe(true);
    expect(link.connects).toBe(2);

    link.stop();
  });

  it("start() membatalkan reconnect tertunda (tidak ada socket ganda)", () => {
    const sockets: FakeSocket[] = [];
    const link = new ResilientWs({
      name: "TEST",
      url: "wss://example.invalid/endpoint",
      onMessage: () => {},
      idleTimeoutMs: 0,
      reconnectBaseMs: 1000,
      makeSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as never;
      },
    });

    link.start();
    sockets[0]!.emit("open");
    // Socket ditutup bursa -> reconnect dijadwalkan 1 dtk.
    sockets[0]!.close();
    sockets[0]!.emit("close", 1006, Buffer.from(""));

    // Sebelum timer reconnect jalan, pemanggil lakukan stop()+start().
    link.stop();
    link.start();
    expect(sockets).toHaveLength(2);

    // Timer lama harus sudah dibatalkan: tidak boleh ada socket ke-3.
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);

    link.stop();
  });

  it("heartbeat tetap aktif setelah restart", () => {
    const sockets: FakeSocket[] = [];
    const link = new ResilientWs({
      name: "TEST",
      url: "wss://example.invalid/endpoint",
      onMessage: () => {},
      heartbeatMs: 20_000,
      heartbeatPayload: "ping",
      idleTimeoutMs: 0,
      makeSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as never;
      },
    });

    link.start();
    sockets[0]!.emit("open");
    link.stop();
    link.start();
    sockets[1]!.emit("open");

    vi.advanceTimersByTime(20_000);
    expect(sockets[1]!.sent).toEqual(["ping"]);

    link.stop();
  });
});

describe("redactUrl", () => {
  it("menyembunyikan nilai query param (token) tapi menyisakan nama param", () => {
    const out = redactUrl("wss://ws-api-spot.kucoin.com/endpoint?token=SECRETVALUE123");
    expect(out).not.toContain("SECRETVALUE123");
    expect(out).toContain("token=");
    expect(out).toContain("present=true");
  });

  it("URL tanpa query tetap utuh", () => {
    expect(redactUrl("wss://ws.bitget.com/v2/ws/public")).toBe("wss://ws.bitget.com/v2/ws/public");
  });

  it("URL tidak valid tidak bocor mentah", () => {
    const out = redactUrl("not a url SECRET");
    expect(out).not.toContain("SECRET");
  });
});
