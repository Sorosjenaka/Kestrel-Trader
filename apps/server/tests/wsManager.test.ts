// apps/server/tests/wsManager.test.ts - uji OFFLINE WS manager (FR-39, FR-24, NFR-15).
import { afterEach, describe, expect, it } from "vitest";
import { WsMarkPriceManager } from "../src/marketdata/wsManager.js";

class MockSocket {
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  closed = false;
  constructor(public url: string) {}
  on(event: string, cb: (...args: any[]) => void): this {
    (this.handlers[event] ||= []).push(cb);
    return this;
  }
  emit(event: string, ...args: any[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 1000, "");
  }
}

let active: WsMarkPriceManager | null = null;
afterEach(() => { active?.stop(); active = null; });

function harness(opts: { hosts?: string[]; now?: () => number } = {}) {
  const created: { url: string; socket: MockSocket }[] = [];
  const events: string[] = [];
  const manager = new WsMarkPriceManager({
    hosts: opts.hosts ?? ["fstream.h1", "fstream.h2"],
    now: opts.now,
    makeSocket: (url: string) => {
      const socket = new MockSocket(url);
      created.push({ url, socket });
      return socket as any;
    },
    schedule: (fn) => { fn(); }, // reconnect langsung di test
    handlers: {
      host_switch: () => events.push("host_switch"),
      resubscribe: () => events.push("resubscribe"),
      quarantine: () => events.push("quarantine"),
      error: () => events.push("error"),
    },
  });
  active = manager;
  return { manager, created, events };
}

describe("WsMarkPriceManager (FR-39, FR-24, NFR-15)", () => {
  it("URL pertama: format baru /market/ws/ + stream !markPrice@arr@1s", () => {
    const { manager, created } = harness();
    manager.start();
    expect(created[0].url).toBe("wss://fstream.h1/market/ws/!markPrice@arr@1s");
    expect(created.length).toBe(1);
  });

  it("batch mark price terurai per simbol (multi + tunggal)", () => {
    const { manager, created } = harness({ now: () => 2000 });
    manager.start();
    created[0].socket.emit("open");
    created[0].socket.emit("message", JSON.stringify([
      { E: 2000, s: "BTCUSDT", p: "84000", i: "84010", r: "0.00010" },
      { E: 2000, s: "ETHUSDT", p: "3000" },
    ]));
    created[0].socket.emit("message", JSON.stringify({ E: 2000, s: "SOLUSDT", p: "150" }));
    expect(manager.health().symbolsTracked).toBe(3);
    expect(manager.getMark("BTCUSDT")?.markPrice).toBe(84000);
    expect(manager.getMark("SOLUSDT")?.markPrice).toBe(150);
    expect(manager.health().status).toBe("CONNECTED");
  });

  it("freshness p95 = p95(now - E) sesuai NFR-15", () => {
    const { manager, created } = harness({ now: () => 10_000 });
    manager.start();
    created[0].socket.emit("open");
    const batch = Array.from({ length: 20 }, (_, i) => ({ E: 10_000 - 100 - i, s: "P" + i + "USDT", p: "1" }));
    created[0].socket.emit("message", JSON.stringify(batch));
    const p95 = manager.freshnessP95Ms();
    expect(p95).not.toBeNull();
    expect(p95!).toBeGreaterThanOrEqual(100);
    expect(p95!).toBeLessThanOrEqual(119);
  });

  it("gap > 2 dtk -> auto-resubscribe ke URL SAMA dulu (bukan langsung rotasi)", () => {
    let fakeNow = 5000;
    const { manager, created, events } = harness({ now: () => fakeNow });
    manager.start();
    created[0].socket.emit("open");
    created[0].socket.emit("message", JSON.stringify([{ E: 5000, s: "BTCUSDT", p: "1" }]));
    fakeNow = 7500; // 2,5 dtk tanpa pesan -> melebihi gap 2 dtk
    const reconnected = manager.checkGap(fakeNow);
    expect(reconnected).toBe(true);
    expect(events).toContain("resubscribe");
    expect(created.length).toBe(2);
    expect(created[1].url).toBe(created[0].url);
    expect(manager.health().gaps).toBe(1);
  });

  it("quarantine: simbol macet > 5 dtk -> canTrade false; pesan segar memulihkan", () => {
    let fakeNow = 10_000;
    const { manager, created } = harness({ now: () => fakeNow });
    manager.start();
    created[0].socket.emit("open");
    created[0].socket.emit("message", JSON.stringify([{ E: 10_000, s: "BTCUSDT", p: "1" }]));
    expect(manager.canTrade("BTCUSDT")).toBe(true);
    fakeNow = 16_000;
    expect(manager.isQuarantined("BTCUSDT")).toBe(true);
    expect(manager.canTrade("BTCUSDT")).toBe(false);
    created[0].socket.emit("message", JSON.stringify([{ E: 16_000, s: "BTCUSDT", p: "2" }]));
    expect(manager.canTrade("BTCUSDT")).toBe(true);
  });

  it("putus cepat -> coba URL SAMA 3x dulu, baru rotasi (hemat kandidat mati)", () => {
    const { manager, created } = harness();
    manager.start();
    const first = created[0].url;
    created[0].socket.emit("open");
    created[0].socket.emit("close", 1006, ""); // retry-1: sama
    expect(created[1].url).toBe(first);
    created[1].socket.emit("close", 1006, ""); // retry-2: sama
    expect(created[2].url).toBe(first);
    created[2].socket.emit("close", 1006, ""); // retry-3: sama
    expect(created[3].url).toBe(first);
    created[3].socket.emit("close", 1006, ""); // habis -> rotasi
    expect(created[4].url).not.toBe(first);
    expect(manager.health().reconnects).toBeGreaterThanOrEqual(4);
  });

  it("putus setelah stabil >30 dtk -> langsung coba URL bagus yang sama (sticky)", () => {
    let fakeNow = 50_000;
    const { manager, created } = harness({ now: () => fakeNow });
    manager.start();
    const first = created[0].url;
    created[0].socket.emit("open");
    created[0].socket.emit("message", JSON.stringify([{ E: 50_000, s: "BTCUSDT", p: "1" }]));
    fakeNow += 31_000;
    created[0].socket.emit("close", 1006, "");
    expect(created[1].url).toBe(first);
  });

  it("failover host: setelah putaran kandidat, URL pindah host -> event host_switch", () => {
    const { manager, created, events } = harness();
    manager.start();
    // 4x putus cepat menghabiskan same-retry -> kandidat 2 (legacy, host sama)
    for (let i = 0; i < 4; i++) created[i].socket.emit("close", 1006, "");
    expect(created[4].url).not.toBe(created[0].url);
    // 4x lagi -> kandidat 3 (host h2) + event host_switch
    for (let i = 4; i < 8; i++) created[i].socket.emit("close", 1006, "");
    expect(created[8].url).toContain("fstream.h2");
    expect(events).toContain("host_switch");
  });

  it("pesan non-JSON tidak crash; pesan berikut tetap diproses; stop() benar", () => {    const { manager, created, events } = harness();
    manager.start();
    created[0].socket.emit("open");
    created[0].socket.emit("message", "garbage-not-json");
    expect(events).toContain("error");
    created[0].socket.emit("message", JSON.stringify([{ E: 1, s: "BTCUSDT", p: "9" }]));
    expect(manager.getMark("BTCUSDT")?.markPrice).toBe(9);
    const beforeStop = created.length;
    manager.stop();
    expect(manager.health().status).toBe("STOPPED");
    created[0].socket.emit("close", 1006, ""); // setelah stop tidak boleh reconnect
    expect(created.length).toBe(beforeStop);
  });

  it("diagnostik: connects/messages/error/close-code/dryStreak terlacak di health()", () => {
    const { manager, created } = harness();
    manager.start();
    created[0].socket.emit("open");
    created[0].socket.emit("message", JSON.stringify([{ E: 1, s: "BTCUSDT", p: "9" }]));
    const h = manager.health();
    expect(h.connects).toBeGreaterThanOrEqual(1);
    expect(h.messages).toBeGreaterThanOrEqual(1);
    expect(h.dryStreak).toBe(0);
    expect(h.lastError).toBeNull();
  });

  it("5 upaya kering beruntun -> cooldown 5 menit (bukan badai reconnect)", () => {
    const delays: number[] = [];
    const created: { url: string; socket: any }[] = [];
    const manager = new WsMarkPriceManager({
      hosts: ["hX"],
      makeSocket: (url: string) => {
        const socket = new MockSocket(url);
        created.push({ url, socket });
        return socket as any;
      },
      schedule: (fn, ms) => { delays.push(ms); fn(); },
    });
    try {
      manager.start();
      // Tiap upaya: tanpa open tanpa pesan -> close (kering). 6x putus.
      for (let i = 0; i < 6; i++) {
        created[created.length - 1].socket.emit("close", 1006, "");
      }
      const h = manager.health();
      expect(h.dryStreak).toBeGreaterThanOrEqual(5);
      expect(delays[delays.length - 1]).toBe(5 * 60_000);
    } finally {
      manager.stop();
    }
  });
});