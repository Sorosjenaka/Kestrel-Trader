import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceFuturesClient, klineCacheTtlMs } from "../src/markets/binanceFuturesClient.js";
import { binanceRest } from "../src/marketdata/restPool.js";

afterEach(() => vi.restoreAllMocks());

describe("paced futures kline fetch", () => {
  it("deduplicates concurrent 5m requests and reuses them within TTL", async () => {
    const row = [1, "100", "101", "99", "100", "42"];
    const get = vi.spyOn(binanceRest, "get").mockResolvedValue({ data: [row] } as any);
    const [a, b] = await Promise.all([
      binanceFuturesClient.fetchKlines("ETHUSDT", "5m", 100),
      binanceFuturesClient.fetchKlines("ETHUSDT", "5m", 100),
    ]);
    expect(a).toEqual([row]);
    expect(b).toEqual([row]);
    expect(get).toHaveBeenCalledTimes(1);
    await binanceFuturesClient.fetchKlines("ETHUSDT", "5m", 100);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps 1m trigger uncached", async () => {
    const get = vi.spyOn(binanceRest, "get").mockResolvedValue({ data: [[1, "100"]] } as any);
    await binanceFuturesClient.fetchKlines("BTCUSDT", "1m", 90);
    await binanceFuturesClient.fetchKlines("BTCUSDT", "1m", 90);
    expect(klineCacheTtlMs("1m")).toBe(0);
    expect(klineCacheTtlMs("3m")).toBe(60_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("requests bounded, capped, read-only history ranges for trade forensics", async () => {
    const rows = [[60_000, "100", "102", "98", "101", "42"]];
    const get = vi.spyOn(binanceRest, "get").mockResolvedValue({ data: rows } as any);
    const result = await binanceFuturesClient.fetchKlinesRange("solusdt", "1m", 60_000, 120_000, 50_000);
    expect(result).toEqual(rows);
    const requestedPath = String(get.mock.calls[0]?.[0]);
    expect(requestedPath).toContain("/fapi/v1/klines?");
    expect(requestedPath).toContain("symbol=SOLUSDT");
    expect(requestedPath).toContain("interval=1m");
    expect(requestedPath).toContain("startTime=60000");
    expect(requestedPath).toContain("endTime=120000");
    expect(requestedPath).toContain("limit=1000");
  });
});
