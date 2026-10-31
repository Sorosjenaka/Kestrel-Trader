import { describe, it, expect } from "vitest";
import { parseStreamCandle } from "../../web/src/lib/klineStream.js";

/*
  23 Okt 2026 — test untuk route & payload kline stream.

  Bug yang diperbaiki periode ini (semua nyata, bukan rekaan):
   1. /api/binance/kline-stream tidak pernah ADA -> 404 -> chart jatuh polling.
   2. /api/binance/symbol-info tidak pernah ADA -> 404 -> tickSize selalu 0.01
      -> harga pair kecil (0.0187) tampil "0.02".
   3. Format payload SSE harus type=="kline" supaya parseStreamCandle
      menerimanya (frontend menolak payload tanpa type).
*/

function klinePayload(over: Record<string, unknown> = {}) {
  return {
    type: "kline",
    candle: {
      symbol: "SPKUSDT",
      interval: "1m",
      openTime: 1792741740000,
      closeTime: 1792741799999,
      time: 1792741740,
      open: 0.01865,
      high: 0.01871,
      low: 0.01864,
      close: 0.0187,
      volume: 12.5,
      quoteVolume: 233.4,
      takerBuyBase: 6,
      takerBuyQuote: 112,
      closed: false,
      eventTime: 1792741741283,
      receivedAt: 1792741741324,
      ...over,
    },
  };
}

describe("kline stream payload", () => {
  it("menerima payload type=kline dan mempertahankan presisi harga kecil", () => {
    const c = parseStreamCandle(klinePayload());
    expect(c).not.toBeNull();
    expect(c!.symbol).toBe("SPKUSDT");
    expect(c!.interval).toBe("1m");
    expect(c!.open).toBe(0.01865);
    expect(c!.close).toBe(0.0187);
    expect(c!.volume).toBe(12.5);
    expect(c!.closed).toBe(false);
  });

  it("menerima payload berupa string JSON (SSE event.data)", () => {
    const c = parseStreamCandle(JSON.stringify(klinePayload()));
    expect(c).not.toBeNull();
    expect(c!.symbol).toBe("SPKUSDT");
  });

  it("menolak payload tanpa type=kline (mis. ack subscribe Binance)", () => {
    expect(parseStreamCandle({ result: null, id: 7 })).toBeNull();
    expect(parseStreamCandle({ type: "status", connected: true })).toBeNull();
  });

  it("menolak candle dengan OHLC tidak konsisten", () => {
    expect(parseStreamCandle(klinePayload({ high: 0.01 }))).toBeNull();  // high < close
    expect(parseStreamCandle(klinePayload({ low: 0.05 }))).toBeNull();   // low > close
    expect(parseStreamCandle(klinePayload({ close: 0 }))).toBeNull();     // harga <= 0
  });

  it("menolak payload rusak / bukan objek", () => {
    expect(parseStreamCandle("not json")).toBeNull();
    expect(parseStreamCandle(null)).toBeNull();
    expect(parseStreamCandle(42)).toBeNull();
  });
});
