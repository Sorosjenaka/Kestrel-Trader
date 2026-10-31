// @vitest-environment jsdom
// apps/web/src/lib/klineStream.test.ts
// Kontrak feed kline direct-WS: refcount + debounce 300ms rebuild — jangan
// close/reopen tiap subscribe (React StrictMode mount/unmount ganda membuat
// koneksi tidak pernah stabil), satu koneksi combined untuk semua pair,
// dan payload Binance asli (`{e:"kline",k:{…}}`) ter-parse.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("klineStream multi: refcount + debounce rebuild (WebSocket)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules(); // state modul (socket/timer) harus segar per test
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("subscribe beruntun/berpasangan tidak close/reopen koneksi", async () => {
    const { subscribeKlineStreamMulti } = await import("./klineStream.js");

    const un1 = subscribeKlineStreamMulti("BTCUSDT", "15m", () => {}, () => {});
    expect(FakeWebSocket.instances.length).toBe(1); // koneksi pertama langsung

    un1();
    const un2 = subscribeKlineStreamMulti("BTCUSDT", "15m", () => {}, () => {});
    await vi.advanceTimersByTimeAsync(300);

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0]!.closeCalls).toBe(0);
    un2();
  });

  it("pairs berubah -> tepat satu rebuild setelah debounce", async () => {
    const { subscribeKlineStreamMulti } = await import("./klineStream.js");

    const un1 = subscribeKlineStreamMulti("BTCUSDT", "15m", () => {}, () => {});
    const un2 = subscribeKlineStreamMulti("ETHUSDT", "15m", () => {}, () => {});
    await vi.advanceTimersByTimeAsync(299);
    expect(FakeWebSocket.instances.length).toBe(1); // belum rebuild
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances.length).toBe(2); // 1 rebuild, bukan 2
    expect(FakeWebSocket.instances[0]!.closeCalls).toBe(1);
    expect(FakeWebSocket.instances[1]!.url).toContain("btcusdt@kline_15m");
    expect(FakeWebSocket.instances[1]!.url).toContain("ethusdt@kline_15m");
    expect(FakeWebSocket.instances[1]!.url).toContain("/market/ws/stream");
    un1();
    un2();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWebSocket.instances.length).toBe(2); // idle: tidak bikin baru
  });

  it("payload kline Binance asli -> onCandle + status WS_ACTIVE", async () => {
    const { subscribeKlineStreamMulti } = await import("./klineStream.js");
    const candles: any[] = [];
    const statuses: string[] = [];
    const un = subscribeKlineStreamMulti("BTCUSDT", "1m", (c) => candles.push(c), (s) => statuses.push(s.state));
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({
      e: "kline",
      E: 1793355000123,
      s: "BTCUSDT",
      k: { t: 1793354940000, T: 1793354999999, s: "BTCUSDT", i: "1m", o: "77900.1", c: "77950.5", h: "77960.0", l: "77890.0", v: "12.5", q: "974000", V: "6.1", Q: "475000", x: false },
    });
    expect(candles.length).toBe(1);
    expect(candles[0]).toMatchObject({ symbol: "BTCUSDT", interval: "1m", open: 77900.1, close: 77950.5, closeTime: 1793354999999, volume: 12.5, closed: false });
    expect(statuses).toContain("WS_ACTIVE");
    un();
  });
});
