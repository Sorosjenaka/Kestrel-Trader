import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BinanceUsdMClient } from "../src/exec/binanceUsdMClient.js";
import { FuturesOrderManager } from "../src/exec/futuresOrderManager.js";
import { OrderExecutor, type OrderExecRepo, type OrderExecRow, type OrderStatus } from "../src/exec/orderExecutor.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

class MemoryRepo implements OrderExecRepo {
  readonly rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, { ...row }); return row; }
  async updateStatus(id: string, status: OrderStatus, _price?: number, _fee?: number, _at?: Date, patch?: Partial<OrderExecRow>) {
    const next = { ...this.rows.get(id)!, ...patch, status };
    this.rows.set(id, next);
    return next;
  }
}

describe("Binance USD-M private order manager (offline)", () => {
  it("signs the exact POST body, uses mainnet host and never sends credentials in URL", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://fapi.binance.com/fapi/v1/order");
      expect(init?.headers).toMatchObject({ "X-MBX-APIKEY": "key" });
      const params = new URLSearchParams(String(init?.body));
      const signature = params.get("signature");
      params.delete("signature");
      expect(signature).toBe(createHmac("sha256", "secret").update(params.toString()).digest("hex"));
      expect(params.get("timestamp")).toBe("1234567890");
      expect(params.get("quantity")).toBe("0.002");
      expect(params.get("positionSide")).toBe("BOTH");
      expect(params.get("type")).toBe("MARKET");
      return response({ orderId: 42, status: "FILLED", avgPrice: "60000", executedQty: "0.002" });
    });
    const client = new BinanceUsdMClient({ apiKey: "key", apiSecret: "secret", fetcher: fetcher as typeof fetch, now: () => 1234567890 });
    const result = await client.postOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", price: 60000, qty: 0.002, clientOrderId: "ENTRY_1" });
    expect(result.status).toBe("FILLED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the algo endpoint with closePosition and no quantity/reduceOnly", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("closePosition")).toBe("true");
      expect(params.get("workingType")).toBe("MARK_PRICE");
      expect(params.has("quantity")).toBe(false);
      expect(params.has("reduceOnly")).toBe(false);
      return response({ algoId: 77, clientAlgoId: "SL_ENTRY_1", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "59000" });
    });
    const client = new BinanceUsdMClient({ apiKey: "key", apiSecret: "secret", fetcher: fetcher as typeof fetch });
    await client.placeCloseAllStop({ symbol: "BTCUSDT", side: "SELL", triggerPrice: 59000, clientAlgoId: "SL_ENTRY_1" });
    expect(fetcher.mock.calls.length).toBe(1);
  });

  it("rejects hedge mode or existing external position before changing leverage", async () => {
    const client = new BinanceUsdMClient({ apiKey: "k", apiSecret: "s", fetcher: vi.fn() as typeof fetch });
    const repo = new MemoryRepo();
    const manager = new FuturesOrderManager(client, repo);
    vi.spyOn(client, "getPositionMode").mockResolvedValue(true);
    const leverage = vi.spyOn(client, "setLeverage");
    await expect(manager.prepareSymbol("BTCUSDT", 25, "CROSS")).rejects.toThrow("BINANCE_HEDGE_MODE_UNSUPPORTED");
    vi.mocked(client.getPositionMode).mockResolvedValue(false);
    vi.spyOn(client, "getPositionRisk").mockResolvedValue([{ symbol: "BTCUSDT", positionAmt: "0.01", leverage: "25", marginType: "cross" }]);
    await expect(manager.prepareSymbol("BTCUSDT", 25, "CROSS")).rejects.toThrow("BINANCE_SYMBOL_ALREADY_HAS_POSITION");
    expect(leverage).not.toHaveBeenCalled();
  });

  it("verifies the actual exchange leverage and margin mode after configuration", async () => {
    const client = new BinanceUsdMClient({ apiKey: "k", apiSecret: "s", fetcher: vi.fn() as typeof fetch });
    const manager = new FuturesOrderManager(client, new MemoryRepo());
    vi.spyOn(client, "getPositionMode").mockResolvedValue(false);
    vi.spyOn(client, "getPositionRisk")
      .mockResolvedValueOnce([{ symbol: "BTCUSDT", positionAmt: "0", leverage: "20", marginType: "isolated" }])
      .mockResolvedValueOnce([{ symbol: "BTCUSDT", positionAmt: "0", leverage: "25", marginType: "cross" }]);
    const margin = vi.spyOn(client, "setMarginType").mockResolvedValue();
    const lev = vi.spyOn(client, "setLeverage").mockResolvedValue(25);
    await manager.prepareSymbol("BTCUSDT", 25, "CROSS");
    expect(margin).toHaveBeenCalledWith("BTCUSDT", "CROSS");
    expect(lev).toHaveBeenCalledWith("BTCUSDT", 25);
  });

  it("persists stop intent before POST and queries after uncertain response without repeat POST", async () => {
    const client = new BinanceUsdMClient({ apiKey: "k", apiSecret: "s", fetcher: vi.fn() as typeof fetch });
    const repo = new MemoryRepo();
    const manager = new FuturesOrderManager(client, repo);
    vi.spyOn(client, "getPositionMode").mockResolvedValue(false);
    vi.spyOn(client, "getPositionRisk").mockResolvedValue([{ symbol: "BTCUSDT", positionAmt: "0.002", leverage: "25", marginType: "cross" }]);
    const post = vi.spyOn(client, "placeCloseAllStop").mockImplementation(async () => {
      expect(repo.rows.get("SL_ENTRY_1")?.status).toBe("NEW");
      throw new Error("network timeout");
    });
    const query = vi.spyOn(client, "queryAlgo").mockResolvedValue({ algoId: 77, clientAlgoId: "SL_ENTRY_1", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "59000" });
    const input = { entryClientOrderId: "ENTRY_1", symbol: "BTCUSDT", positionSide: "LONG" as const,
      entryPrice: 60000, triggerPrice: 59000, filledQty: 0.002 };
    const result = await manager.ensureCloseAllStop(input);
    expect(result.algoId).toBe("77");
    expect(post).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    await manager.ensureCloseAllStop(input);
    expect(post).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects reversed SL and mismatched stop reuse", async () => {
    const client = new BinanceUsdMClient({ apiKey: "k", apiSecret: "s", fetcher: vi.fn() as typeof fetch });
    const repo = new MemoryRepo();
    const manager = new FuturesOrderManager(client, repo);
    const input = { entryClientOrderId: "ENTRY_1", symbol: "BTCUSDT", positionSide: "LONG" as const,
      entryPrice: 60000, triggerPrice: 61000, filledQty: 0.002 };
    await expect(manager.ensureCloseAllStop(input)).rejects.toThrow("STOP_WRONG_SIDE");
    vi.spyOn(client, "getPositionMode").mockResolvedValue(false);
    vi.spyOn(client, "getPositionRisk").mockResolvedValue([{ symbol: "BTCUSDT", positionAmt: "0.002", leverage: "25", marginType: "cross" }]);
    await repo.create({ clientOrderId: "SL_ENTRY_1", symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", price: 58000,
      qty: 0.002, reduceOnly: true, status: "NEW" });
    await expect(manager.ensureCloseAllStop({ ...input, triggerPrice: 59000 })).rejects.toThrow("STOP_ID_CONFLICT");
  });

  it("fails closed when LIVE has no exchange, but permits reduce-only while disarmed", async () => {
    const repo = new MemoryRepo();
    const blocked = new OrderExecutor({ repo, paperAllowed: false });
    await expect(blocked.executeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", price: 60000, qty: 0.002 }))
      .rejects.toThrow("LIVE_ORDER_MANAGER_NOT_CONNECTED");
    expect(repo.rows.size).toBe(0);
    const exchange = { postOrder: vi.fn(async () => ({ orderId: 9, status: "FILLED", avgPrice: "60000", executedQty: "0.002" })),
      queryOrder: vi.fn(async () => ({ orderId: 9, status: "FILLED", avgPrice: "60000", executedQty: "0.002" })) };
    const executor = new OrderExecutor({ repo, exchange, isArmed: () => false });
    await expect(executor.executeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", price: 60000, qty: 0.002 }))
      .rejects.toThrow("ARM_REQUIRED");
    const exit = await executor.executeOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", price: 60000, qty: 0.002, reduceOnly: true });
    expect(exit.status).toBe("FILLED");
    expect(exchange.postOrder).toHaveBeenCalledTimes(1);
  });

  it("will not cancel the exchange SL while its symbol position is open", async () => {
    const client = new BinanceUsdMClient({ apiKey: "k", apiSecret: "s", fetcher: vi.fn() as typeof fetch });
    const repo = new MemoryRepo();
    const manager = new FuturesOrderManager(client, repo);
    await repo.create({ clientOrderId: "SL_ENTRY_1", symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", price: 59000,
      qty: 0.002, reduceOnly: true, status: "NEW", simulated: false });
    vi.spyOn(client, "getPositionRisk").mockResolvedValue([{ symbol: "BTCUSDT", positionAmt: "0.002", leverage: "25", marginType: "cross" }]);
    const cancel = vi.spyOn(client, "cancelAlgo");
    await expect(manager.cancelStop("SL_ENTRY_1")).rejects.toThrow("STOP_CANCEL_REQUIRES_FLAT_POSITION");
    expect(cancel).not.toHaveBeenCalled();
  });
});
