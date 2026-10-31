// apps/server/tests/leverageSync.test.ts — uji OFFLINE wiring sinkron leverage (FR-16).
import { describe, expect, it } from "vitest";
import {
  makeLeverageBracketFetcher,
  runLeverageSync,
  type LeverageBracketFetcher,
} from "../src/universe/leverageSync.js";

function fakeFetch(status: number, payload: unknown) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

describe("runLeverageSync", () => {
  it("mengembalikan hasil dan event OK saat sync sukses", async () => {
    const events: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    const fetcher: LeverageBracketFetcher = async () => ({ data: [] });
    const out = await runLeverageSync({
      sync: async () => ({ updated: 2, unchanged: 3 }),
      fetcher,
      onEvent: (payload, msg) => events.push({ payload, msg }),
    });
    expect(out).toEqual({ ok: true, updated: 2, unchanged: 3 });
    expect(events).toEqual([{ payload: { updated: 2, unchanged: 3 }, msg: "LEVERAGE_SYNC_OK" }]);
  });

  it("tidak melempar saat sync gagal — kembali sebagai hasil + event FAIL", async () => {
    const events: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    const fetcher: LeverageBracketFetcher = async () => ({ data: [] });
    const out = await runLeverageSync({
      sync: async () => {
        throw new Error("HTTP 401");
      },
      fetcher,
      onEvent: (payload, msg) => events.push({ payload, msg }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("HTTP 401");
    expect(events[0].msg).toBe("LEVERAGE_SYNC_FAIL");
  });
});

describe("makeLeverageBracketFetcher", () => {
  it("memanggil endpoint dengan header API key dan mengembalikan data", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const doFetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return fakeFetch(200, { data: [{ symbol: "BTCUSDT", brackets: [] }] })();
    }) as unknown as typeof fetch;
    const fetcher = makeLeverageBracketFetcher("KEY-TEST", doFetch);
    const res = await fetcher("/fapi/v1/leverageBracket?timestamp=1&signature=abc");
    expect(calledUrl).toContain("/fapi/v1/leverageBracket?timestamp=1");
    expect((calledInit?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("KEY-TEST");
    expect(res.data[0].symbol).toBe("BTCUSDT");
  });

  it("melempar error berisi status saat endpoint menolak", async () => {
    const doFetch = (async () => fakeFetch(401, { code: -2015, msg: "Invalid API-key" })()) as unknown as typeof fetch;
    const fetcher = makeLeverageBracketFetcher("KEY-TEST", doFetch);
    await expect(fetcher("/x")).rejects.toThrow(/HTTP 401/);
  });

  // Bentuk respons asli Binance GET /fapi/v1/leverageBracket = JSON array telanjang
  // (bukan { data: [...] }). Tanpa normalisasi ini sync senyap: 0 simbol terproses.
  it("menerima respons array telanjang (bentuk asli Binance)", async () => {
    const doFetch = (async () => fakeFetch(200, [{ symbol: "ETHUSDT", brackets: [] }])()) as unknown as typeof fetch;
    const fetcher = makeLeverageBracketFetcher("KEY-TEST", doFetch);
    const res = await fetcher("/x");
    expect(res.data).toHaveLength(1);
    expect(res.data[0].symbol).toBe("ETHUSDT");
  });

  it("tetap menerima bentuk wrapper { data: [...] }", async () => {
    const doFetch = (async () => fakeFetch(200, { data: [{ symbol: "BTCUSDT", brackets: [] }, { symbol: "SOLUSDT", brackets: [] }] })()) as unknown as typeof fetch;
    const fetcher = makeLeverageBracketFetcher("KEY-TEST", doFetch);
    const res = await fetcher("/x");
    expect(res.data.map((e) => e.symbol)).toEqual(["BTCUSDT", "SOLUSDT"]);
  });
});
