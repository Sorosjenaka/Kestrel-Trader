import { describe, expect, it } from "vitest";
import { BinanceUsdMClient } from "../src/exec/binanceUsdMClient.js";
import { checkDepth } from "../src/exec/depthGuard.js";
import {
  assertTransition, canTransition, isTerminalState, nextState,
} from "../src/exec/orderStateMachine.js";

function fakeClient(response: unknown = { orderId: "123", status: "NEW", avgPrice: "0", executedQty: "0", cumQuote: "0" }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new BinanceUsdMClient({
    apiKey: "test-key", apiSecret: "test-secret", fetcher, now: () => 1_700_000_000_000,
  });
  return { client, calls };
}

describe("orderStateMachine (T-14)", () => {
  it("transisi legal NEW -> PARTIAL -> FILLED", () => {
    expect(canTransition("NEW", "PARTIAL")).toBe(true);
    expect(canTransition("PARTIAL", "FILLED")).toBe(true);
    expect(nextState("NEW", "FILL")).toBe("FILLED");
    expect(nextState("PARTIAL", "PARTIAL_FILL")).toBe("PARTIAL");
  });

  it("state terminal tidak keluar (kecuali state sama = idempotent)", () => {
    for (const s of ["FILLED", "CANCELED", "REJECTED", "EXPIRED"] as const) {
      expect(isTerminalState(s)).toBe(true);
      expect(canTransition(s, s)).toBe(true);
      expect(canTransition(s, "PARTIAL")).toBe(false);
    }
    expect(() => assertTransition("FILLED", "CANCELED")).toThrow("ORDER_STATE_ILLEGAL");
  });

  it("state/event tidak dikenal => false/null (fail-closed)", () => {
    expect(canTransition("WHATEVER", "FILLED")).toBe(false);
    expect(nextState("NEW", "NOPE" as any)).toBeNull();
  });
});

describe("depthGuard (T-13)", () => {
  it("BUY memakan ask: slippage dihitung dari best ask", () => {
    const r = checkDepth({
      side: "LONG", notionalUsd: 150, maxSlippageBps: 100,
      levels: [{ price: 100, qty: 1 }, { price: 101, qty: 1 }],
    });
    expect(r.allowed).toBe(true);
    expect(r.vwap).toBeCloseTo(150 / (1 + 50 / 101), 8);
    expect(r.slippageBps).toBeGreaterThan(0);
    expect(r.slippageBps).toBeLessThan(100);
  });

  it("SELL memakan bid dan slippage advers positif", () => {
    const r = checkDepth({
      side: "SHORT", notionalUsd: 150, maxSlippageBps: 100,
      levels: [{ price: 100, qty: 1 }, { price: 99, qty: 1 }],
    });
    expect(r.allowed).toBe(true);
    expect(r.slippageBps).toBeGreaterThan(0);
  });

  it("depth tidak cukup => reject INSUFFICIENT_DEPTH", () => {
    const r = checkDepth({ side: "LONG", notionalUsd: 1000, maxSlippageBps: 100, levels: [{ price: 100, qty: 1 }] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("INSUFFICIENT_DEPTH");
    expect(r.fillableNotionalUsd).toBeCloseTo(100, 6);
  });

  it("slippage melebihi batas => reject SLIPPAGE_EXCEEDED", () => {
    const r = checkDepth({
      side: "LONG", notionalUsd: 150, maxSlippageBps: 10,
      levels: [{ price: 100, qty: 1 }, { price: 105, qty: 1 }],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("SLIPPAGE_EXCEEDED");
  });

  it("input kosong/invalid => reject, bukan dianggap aman", () => {
    expect(checkDepth({ side: "LONG", notionalUsd: 0, maxSlippageBps: 10, levels: [] }).reason).toBe("INVALID_INPUT");
    expect(checkDepth({ side: "LONG", notionalUsd: 10, maxSlippageBps: 10, levels: [] }).reason).toBe("NO_DEPTH");
    expect(checkDepth({ side: "LONG", notionalUsd: 10, maxSlippageBps: 10, levels: [{ price: NaN, qty: 1 }] }).reason).toBe("NO_DEPTH");
  });
});

describe("BinanceUsdMClient — TIF/amend/depth (T-11/T-13)", () => {
  it("LIMIT default GTC dan bisa GTX (post-only)", async () => {
    const a = fakeClient();
    await a.client.postOrder({ clientOrderId: "AT_TEST_1", symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: 100, qty: 1 });
    expect(String(a.calls[0].init?.body)).toContain("timeInForce=GTC");

    const b = fakeClient();
    await b.client.postOrder({ clientOrderId: "AT_TEST_2", symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: 100, qty: 1, timeInForce: "GTX" });
    expect(String(b.calls[0].init?.body)).toContain("timeInForce=GTX");
  });

  it("amendOrder memakai PUT /fapi/v1/order dengan harga baru", async () => {
    const { client, calls } = fakeClient({ orderId: "123", status: "NEW", avgPrice: "0", executedQty: "0", cumQuote: "0" });
    await client.amendOrder("BTCUSDT", "AT_TEST_3", { price: 101.5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("PUT");
    expect(String(calls[0].init?.body)).toContain("origClientOrderId=AT_TEST_3");
    expect(String(calls[0].init?.body)).toContain("price=101.5");
  });

  it("amend tanpa patch ditolak sebelum request", async () => {
    const { client, calls } = fakeClient();
    await expect(client.amendOrder("BTCUSDT", "AT_TEST_4", {})).rejects.toThrow("AMEND_PATCH_EMPTY");
    expect(calls).toHaveLength(0);
  });

  it("placeTrailingStopGuard mengirim TRAILING_STOP_MARKET reduce-only", async () => {
    const { client, calls } = fakeClient({ algoId: "9", clientAlgoId: "TRAIL_1", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "100" });
    await client.placeTrailingStopGuard({
      symbol: "BTCUSDT", side: "SELL", activationPrice: 100, callbackRatePct: 1.5, quantity: 1, clientAlgoId: "TRAIL_1",
    });
    const body = String(calls[0].init?.body);
    expect(body).toContain("type=TRAILING_STOP_MARKET");
    expect(body).toContain("callbackRate=1.5");
    expect(body).toContain("reduceOnly=true");
  });

  it("placeTrailingStopGuard menolak callbackRate di luar 0-5%", async () => {
    const { client, calls } = fakeClient();
    await expect(client.placeTrailingStopGuard({
      symbol: "BTCUSDT", side: "SELL", activationPrice: 100, callbackRatePct: 0, quantity: 1, clientAlgoId: "TRAIL_2",
    })).rejects.toThrow("TRAILING_CALLBACK_RATE_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("getDepth mem-parse bids/asks publik", async () => {
    const { client, calls } = fakeClient({ bids: [["100", "2"]], asks: [["100.1", "3"]] });
    const book = await client.getDepth("BTCUSDT", 5);
    expect(book.bids).toEqual([["100", "2"]]);
    expect(book.asks).toEqual([["100.1", "3"]]);
    expect(calls[0].url).toContain("/fapi/v1/depth?symbol=BTCUSDT&limit=5");
  });

  it("getDepth response invalid => throw (bukan book kosong)", async () => {
    const { client } = fakeClient({ bids: "x", asks: [] });
    await expect(client.getDepth("BTCUSDT")).rejects.toThrow("BINANCE_DEPTH_RESPONSE_INVALID");
  });
});
