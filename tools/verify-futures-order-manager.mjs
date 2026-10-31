// Offline smoke test for the signed Binance adapter. No credentials or network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BinanceUsdMClient } from "../apps/server/dist/exec/binanceUsdMClient.js";
import { FuturesOrderManager } from "../apps/server/dist/exec/futuresOrderManager.js";
import { OrderExecutor } from "../apps/server/dist/exec/orderExecutor.js";

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const params = new URLSearchParams(String(init.body ?? String(url).split("?")[1]));
  const signature = params.get("signature");
  params.delete("signature");
  assert.equal(signature, createHmac("sha256", "secret").update(params.toString()).digest("hex"));
  if (String(url).endsWith("/fapi/v1/order")) {
    assert.equal(params.get("quantity"), "0.002");
    return new Response(JSON.stringify({ orderId: 42, status: "FILLED", avgPrice: "60000", executedQty: "0.002" }));
  }
  if (String(url).endsWith("/fapi/v1/algoOrder")) {
    assert.equal(params.get("closePosition"), "true");
    assert.equal(params.has("quantity"), false);
    return new Response(JSON.stringify({ algoId: 77, clientAlgoId: "SL_ENTRY_1", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "59000" }));
  }
  throw new Error("Unexpected endpoint");
};
const client = new BinanceUsdMClient({ apiKey: "key", apiSecret: "secret", fetcher: fakeFetch, now: () => 1234567890 });
const order = await client.postOrder({ clientOrderId: "ENTRY_1", symbol: "BTCUSDT", side: "BUY", type: "MARKET", price: 60000, qty: 0.002 });
assert.equal(order.status, "FILLED");

const rows = new Map();
const repo = {
  async findByClientOrderId(id) { return rows.get(id) ?? null; },
  async create(row) { rows.set(row.clientOrderId, { ...row }); return row; },
  async updateStatus(id, status, _price, _fee, _at, patch) {
    const row = { ...rows.get(id), ...patch, status };
    rows.set(id, row);
    return row;
  },
};
client.getPositionMode = async () => false;
client.getPositionRisk = async () => [{ symbol: "BTCUSDT", positionAmt: "0.002", leverage: "25", marginType: "cross" }];
const manager = new FuturesOrderManager(client, repo);
const stop = await manager.ensureCloseAllStop({ entryClientOrderId: "ENTRY_1", symbol: "BTCUSDT", positionSide: "LONG", entryPrice: 60000, triggerPrice: 59000, filledQty: 0.002 });
assert.equal(stop.status, "NEW");
assert.equal(rows.get("SL_ENTRY_1").status, "NEW");
assert.equal(calls.length, 2);
client.queryAlgo = async () => ({ algoId: 77, clientAlgoId: "SL_ENTRY_1", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "59000" });
await manager.ensureCloseAllStop({ entryClientOrderId: "ENTRY_1", symbol: "BTCUSDT", positionSide: "LONG", entryPrice: 60000, triggerPrice: 59000, filledQty: 0.002 });
assert.equal(calls.length, 2, "same stop id must not POST twice");
await assert.rejects(() => manager.cancelStop("SL_ENTRY_1"), /STOP_CANCEL_REQUIRES_FLAT_POSITION/);
let uncertainPosts = 0;
client.placeCloseAllStop = async () => { uncertainPosts++; assert.equal(rows.get("SL_ENTRY_2")?.status, "NEW"); throw new Error("timeout"); };
client.queryAlgo = async () => ({ algoId: 78, clientAlgoId: "SL_ENTRY_2", algoStatus: "NEW", symbol: "BTCUSDT", triggerPrice: "59000" });
await manager.ensureCloseAllStop({ entryClientOrderId: "ENTRY_2", symbol: "BTCUSDT", positionSide: "LONG", entryPrice: 60000, triggerPrice: 59000, filledQty: 0.002 });
assert.equal(uncertainPosts, 1, "unknown POST must be queried, never resent");
client.getPositionRisk = async () => [{ symbol: "BTCUSDT", positionAmt: "0", leverage: "25", marginType: "cross" }];
client.setMarginType = async () => {};
client.setLeverage = async (_symbol, leverage) => leverage;
await manager.prepareSymbol("BTCUSDT", 25, "CROSS");
await assert.rejects(() => new OrderExecutor({ repo, paperAllowed: false }).executeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", price: 60000, qty: 0.002 }), /LIVE_ORDER_MANAGER_NOT_CONNECTED/);
console.log("Futures order manager offline smoke: PASS (signature, account preflight, durable/idempotent SL, uncertain POST, cancel guard, live fail-closed)");
