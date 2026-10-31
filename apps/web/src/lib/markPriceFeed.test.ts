// @vitest-environment node
// apps/web/src/lib/markPriceFeed.test.ts
//
// Kontrak feed mark price: URL combined stream, parser pesan, status segar,
// dan backoff. Logika jaringan (WebSocket/EventSource) tidak diuji di sini —
// kelasnya hanya orkestrasi tipis di atas fungsi murni ini.
import { describe, expect, it } from "vitest";
import {
  buildCombinedStreamUrl,
  isWsFresh,
  nextReconnectDelayMs,
  parseMarkPriceEvent,
  WS_FRESH_MS,
} from "./markPriceFeed.js";

describe("buildCombinedStreamUrl", () => {
  it("satu stream combined, lowercase, unik, terurut", () => {
    expect(buildCombinedStreamUrl(["ETHUSDT", "btcusdt", "ETHUSDT"])).toBe(
      "wss://fstream.binance.com/market/ws/stream?streams=btcusdt@markPrice@1s/ethusdt@markPrice@1s",
    );
  });

  it("membuang simbol tidak valid / kosong", () => {
    expect(buildCombinedStreamUrl(["", "  ", "BTC/USDT", "SOLUSDT"])).toBe(
      "wss://fstream.binance.com/market/ws/stream?streams=solusdt@markPrice@1s",
    );
  });
});

describe("parseMarkPriceEvent", () => {
  it("menerima payload combined stream", () => {
    const raw = JSON.stringify({
      stream: "btcusdt@markPrice@1s",
      data: { e: "markPriceUpdate", s: "BTCUSDT", p: "62000.5", E: 1793350000000 },
    });
    expect(parseMarkPriceEvent(raw)).toEqual({ symbol: "BTCUSDT", mark: 62000.5, at: 1793350000000 });
  });

  it("menerima payload polos (non-combined)", () => {
    const obj = { e: "markPriceUpdate", s: "solusdt", p: "150.25", E: 1793350000001 };
    expect(parseMarkPriceEvent(obj)).toEqual({ symbol: "SOLUSDT", mark: 150.25, at: 1793350000001 });
  });

  it("menolak event selain markPriceUpdate / angka tidak valid / JSON rusak", () => {
    expect(parseMarkPriceEvent({ e: "aggTrade", s: "BTCUSDT", p: "1" })).toBeNull();
    expect(parseMarkPriceEvent({ e: "markPriceUpdate", s: "BTCUSDT", p: "0" })).toBeNull();
    expect(parseMarkPriceEvent({ e: "markPriceUpdate", s: "BTCUSDT", p: "abc" })).toBeNull();
    expect(parseMarkPriceEvent({ e: "markPriceUpdate", s: "", p: "10" })).toBeNull();
    expect(parseMarkPriceEvent("{not json")).toBeNull();
    expect(parseMarkPriceEvent(null)).toBeNull();
  });
});

describe("isWsFresh — dasar badge DELAYED", () => {
  it("tick dalam jendela 3 dtk = segar", () => {
    expect(isWsFresh(1_000, 1_000 + WS_FRESH_MS)).toBe(true);
  });

  it("tick lebih tua dari 3 dtk / belum pernah = basi", () => {
    expect(isWsFresh(1_000, 1_001 + WS_FRESH_MS)).toBe(false);
    expect(isWsFresh(null, 1_000)).toBe(false);
    expect(isWsFresh(0, 1_000)).toBe(false);
  });
});

describe("nextReconnectDelayMs — backoff eksponensial dibatasi 15 dtk", () => {
  it("percobaan awal sekitar 1 dtk, tumbuh, lalu mentok 15 dtk", () => {
    const d0 = nextReconnectDelayMs(0);
    expect(d0).toBeGreaterThanOrEqual(1_000);
    expect(d0).toBeLessThanOrEqual(1_250);

    const d2 = nextReconnectDelayMs(2);
    expect(d2).toBeGreaterThanOrEqual(4_000);
    expect(d2).toBeLessThanOrEqual(4_250);

    for (const attempt of [5, 10, 99]) {
      const d = nextReconnectDelayMs(attempt);
      expect(d).toBeGreaterThanOrEqual(15_000);
      expect(d).toBeLessThanOrEqual(15_000);
    }
  });
});
