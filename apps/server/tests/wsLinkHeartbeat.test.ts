// tests/wsLinkHeartbeat.test.ts — Regresi heartbeat ResilientWs (25 Okt 2026).
//
// Bug yang dijaga: `heartbeatMs` dideklarasikan di WsLinkOptions tapi TIDAK
// PERNAH diimplementasikan — heartbeatTimer tidak pernah di-set. Akibatnya
// KuCoin memutus koneksi (code 1000 "Bye") tepat 60 detik setelah connect
// karena tidak ada ping dari client (bukti probe live:
// apps/server/tools/probe-kucoin-ws-close.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { ResilientWs } from "../src/marketdata/wsLink.js";

/** Socket palsu: cukup untuk open/send/close tanpa jaringan. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  }
  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}

describe("ResilientWs heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeLink(payload?: unknown, heartbeatMs?: number) {
    const socket = new FakeSocket();
    const link = new ResilientWs({
      name: "TEST",
      url: "wss://example.invalid/endpoint",
      onMessage: () => {},
      heartbeatMs,
      heartbeatPayload: payload as never,
      idleTimeoutMs: 0,
      makeSocket: () => socket as never,
    });
    return { socket, link };
  }

  it("mengirim payload keep-alive tiap heartbeatMs", () => {
    const { socket, link } = makeLink({ type: "ping" }, 20_000);
    link.start();
    socket.emit("open");

    expect(socket.sent).toHaveLength(0);
    vi.advanceTimersByTime(20_000);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "ping" });

    vi.advanceTimersByTime(20_000);
    expect(socket.sent).toHaveLength(2);
    link.stop();
  });

  it("heartbeatPayload berupa factory dipanggil tiap tick", () => {
    let n = 0;
    const { socket, link } = makeLink(() => ({ type: "ping", n: ++n }), 10_000);
    link.start();
    socket.emit("open");
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(10_000);
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "ping", n: 1 });
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: "ping", n: 2 });
    link.stop();
  });

  it("tanpa heartbeatMs atau tanpa payload: tidak ada yang dikirim", () => {
    const a = makeLink({ type: "ping" }, undefined);
    a.link.start();
    a.socket.emit("open");
    vi.advanceTimersByTime(120_000);
    expect(a.socket.sent).toHaveLength(0);
    a.link.stop();

    const b = makeLink(undefined, 20_000);
    b.link.start();
    b.socket.emit("open");
    vi.advanceTimersByTime(120_000);
    expect(b.socket.sent).toHaveLength(0);
    b.link.stop();
  });

  it("stop() menghentikan heartbeat (tidak ada kirim setelah stop)", () => {
    const { socket, link } = makeLink({ type: "ping" }, 20_000);
    link.start();
    socket.emit("open");
    vi.advanceTimersByTime(20_000);
    expect(socket.sent).toHaveLength(1);
    link.stop();
    vi.advanceTimersByTime(60_000);
    expect(socket.sent).toHaveLength(1);
  });
});
