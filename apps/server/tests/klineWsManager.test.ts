// Offline regression tests for the Futures kline fan-in (UI-03 realtime fix).
// The browser/UI path is read-only: these tests never touch the runtime DB.
import { describe, expect, it } from "vitest";
import { parseKlineEvent } from "../src/marketdata/klineWsManager.js";

const base = {
  e: "kline", E: 1792444500123, s: "BTCUSDT",
  k: {
    t: 1792444500000, T: 1792444559999, s: "BTCUSDT", i: "1m", x: false,
    o: "82144.30", c: "82145.90", h: "82197.70", l: "82144.20",
    v: "111.613", q: "9171502.43900", V: "79.765", Q: "6554428.88430",
  },
};

describe("parseKlineEvent", () => {
  it("parses a raw kline payload", () => {
    const c = parseKlineEvent(base, 1792444500200);
    expect(c).not.toBeNull();
    expect(c!.symbol).toBe("BTCUSDT");
    expect(c!.interval).toBe("1m");
    expect(c!.time).toBe(1792444500); // ms -> chart UTC seconds
    expect(c!.open).toBe(82144.3);
    expect(c!.high).toBe(82197.7);
    expect(c!.low).toBe(82144.2);
    expect(c!.close).toBe(82145.9);
    expect(c!.volume).toBe(111.613);
    expect(c!.takerBuyBase).toBe(79.765);
    expect(c!.closed).toBe(false);
    expect(c!.receivedAt).toBe(1792444500200);
  });

  it("parses a combined-stream wrapper and normalized interval", () => {
    const c = parseKlineEvent({ stream: "btcusdt@kline_1h", data: { ...base, k: { ...base.k, i: "1h" } } });
    expect(c).not.toBeNull();
    expect(c!.interval).toBe("1h");
  });

  it("accepts 1d (UI displays 1D)", () => {
    const c = parseKlineEvent({ ...base, k: { ...base.k, i: "1D" } });
    expect(c).not.toBeNull();
    expect(c!.interval).toBe("1d");
  });

  it("rejects malformed JSON / foreign payloads", () => {
    expect(parseKlineEvent("not json")).toBeNull();
    expect(parseKlineEvent({ e: "aggTrade", k: base.k })).toBeNull();
    expect(parseKlineEvent(null)).toBeNull();
    expect(parseKlineEvent({ e: "kline" })).toBeNull(); // no k block
  });

  it("rejects non-finite and impossible OHLC", () => {
    expect(parseKlineEvent({ ...base, k: { ...base.k, o: "NaN" } })).toBeNull();
    expect(parseKlineEvent({ ...base, k: { ...base.k, h: "1", l: "2" } })).toBeNull(); // high < low
    expect(parseKlineEvent({ ...base, k: { ...base.k, h: "80000", o: "82000", c: "81000", l: "79000" } })).toBeNull(); // high < open
    expect(parseKlineEvent({ ...base, k: { ...base.k, v: "-1" } })).toBeNull();
    expect(parseKlineEvent({ ...base, k: { ...base.k, t: 0 } })).toBeNull();
    expect(parseKlineEvent({ ...base, k: { ...base.k, T: 1792444400000 } })).toBeNull(); // closeTime < openTime
  });

  it("rejects unsupported intervals/symbols", () => {
    expect(parseKlineEvent({ ...base, k: { ...base.k, i: "2m" } })).toBeNull();
    expect(parseKlineEvent({ ...base, k: { ...base.k, s: "BTCUSD_PERP" } })).toBeNull();
    expect(parseKlineEvent({ ...base, k: { ...base.k, s: "btcusdt" }, s: "BTCUSDT" })).not.toBeNull(); // uppercased on parse
  });
});