// apps/server/tests/hubFundingRate.test.ts
// Regresi untuk funding rate di hub payload (23 Okt 2026, Tahap 8).
//
// BUG: getHubPrices() hanya mengirim p/m/c/v/h/l. Field funding rate ("r")
// TIDAK pernah dikirim, padahal UI butuh TOP FUNDING (long/short bias)
// tanpa N request REST per simbol.
//
// Test ini menguji KODE ASLI (BinanceFuturesClient.getHubPrices), bukan
// replika logika. Feed state diisi lewat applyFuturesMark() yang juga
// merupakan kode produksi (jalur WS mark-price).
//
// Offline: tidak menyentuh jaringan, DB, atau engine.

import { describe, expect, it } from "vitest";
import { BinanceFuturesClient } from "../src/markets/binanceFuturesClient.js";

/** Isi feed state untuk satu simbol lewat jalur produksi applyFuturesMark(). */
function seed(client: BinanceFuturesClient, symbol: string, mark: number, funding: number | null): void {
  const anyClient = client as unknown as {
    applyFuturesMark(symbol: unknown, mark: unknown, index: unknown, funding: unknown): void;
  };
  anyClient.applyFuturesMark(symbol, mark, mark, funding);
}

describe("kontrak payload hub: funding rate ikut terkirim", () => {
  it("funding rate nyata ikut di payload (field r)", () => {
    const c = new BinanceFuturesClient();
    seed(c, "BTCUSDT", 81582.63, 0.0001);
    const { map } = c.getHubPrices(["BTCUSDT"]);
    expect(map.BTCUSDT).toBeDefined();
    expect(map.BTCUSDT!.r).toBe(0.0001);
  });

  it("funding negatif (short bias) tidak dibalik tandanya", () => {
    const c = new BinanceFuturesClient();
    seed(c, "ETHUSDT", 2392.85, -0.00035);
    const { map } = c.getHubPrices(["ETHUSDT"]);
    expect(map.ETHUSDT!.r).toBe(-0.00035);
  });

  it("funding unknown = null, BUKAN 0 (0% berarti netral, bukan 'tidak ada data')", () => {
    const c = new BinanceFuturesClient();
    seed(c, "SOLUSDT", 142.5, null);
    const { map } = c.getHubPrices(["SOLUSDT"]);
    expect(map.SOLUSDT!.r).toBeNull();
    expect(map.SOLUSDT!.r).not.toBe(0);
  });

  it("funding 0 yang sah tetap 0 (tidak jadi null)", () => {
    const c = new BinanceFuturesClient();
    seed(c, "XRPUSDT", 2.31, 0);
    const { map } = c.getHubPrices(["XRPUSDT"]);
    expect(map.XRPUSDT!.r).toBe(0);
  });

  it("payload punya key 'r' (bukan 'funding'/'fundingRate')", () => {
    const c = new BinanceFuturesClient();
    seed(c, "BNBUSDT", 601.2, 0.0001);
    const { map } = c.getHubPrices(["BNBUSDT"]);
    const keys = Object.keys(map.BNBUSDT!);
    expect(keys).toContain("r");
    expect(keys).not.toContain("funding");
    expect(keys).not.toContain("fundingRate");
  });

  it("field lain tetap utuh saat funding ditambahkan (regresi silent-drop)", () => {
    const c = new BinanceFuturesClient();
    seed(c, "DOGEUSDT", 0.1872, 0.00025);
    const { map } = c.getHubPrices(["DOGEUSDT"]);
    const e = map.DOGEUSDT!;
    expect(e.m).toBe(0.1872);
    expect(e.s).toBe("FUTURES");
    expect(e.t).toBeGreaterThan(0);
    // Field numerik lain harus ada (walau 0 kalau feed belum punya snapshot).
    expect(Number.isFinite(e.c)).toBe(true);
    expect(Number.isFinite(e.v)).toBe(true);
    expect(Number.isFinite(e.h)).toBe(true);
    expect(Number.isFinite(e.l)).toBe(true);
  });

  it("simbol yang tidak ada di feed -> tidak muncul di payload (tidak dikarang)", () => {
    const c = new BinanceFuturesClient();
    const { map } = c.getHubPrices(["NOTAREALPAIRUSDT"]);
    expect(map.NOTAREALPAIRUSDT).toBeUndefined();
  });

  it("funding rate dari feed tidak bocor ke simbol lain", () => {
    const c = new BinanceFuturesClient();
    seed(c, "BTCUSDT", 81582.63, 0.0001);
    seed(c, "ETHUSDT", 2392.85, -0.00035);
    const { map } = c.getHubPrices();
    expect(map.BTCUSDT!.r).toBe(0.0001);
    expect(map.ETHUSDT!.r).toBe(-0.00035);
  });
});
