import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BreakevenStopExchange } from "../src/exec/liveRuntime.js";

const mocks = vi.hoisted(() => ({ event: vi.fn(async () => ({})), transaction: vi.fn(), klines: vi.fn(async () => []) }));
vi.mock("../src/core/env.js", () => ({ env: { BINANCE_EXECUTION_MODE: "PAPER", PAPER_TOUCH_VERIFY: false,
  BINANCE_API_KEY: "", BINANCE_API_SECRET: "" } }));
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: mocks.event }, $transaction: mocks.transaction } }));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/risk/dailyGuard.js", () => ({ defaultDailyRiskGuard: { isArmed: () => false } }));
vi.mock("../src/risk/lossCooldown.js", () => ({ lossCooldownGuard: { recordClose: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { fetchKlines: mocks.klines } }));

import { LivePositionWatcher, replaceOwnedStopAtBreakeven } from "../src/exec/liveRuntime.js";

function exchange() {
  const calls: string[] = [], cancelled = new Set<string>();
  let replacement: { clientAlgoId: string; symbol: string; triggerPrice: string; algoStatus: string };
  const client = {
    getOpenAlgoOrders: vi.fn(async () => [
      { clientAlgoId: "SLA_ENTRY_ONE", symbol: "BTCUSDT" },
      { clientAlgoId: "SLA_ENTRY_OTHER", symbol: "BTCUSDT" },
      { clientAlgoId: "SLA_ENTRY_ETH", symbol: "ETHUSDT" },
      { clientAlgoId: "MANUAL_STOP", symbol: "BTCUSDT" },
    ]),
    placeReduceOnlyGuard: vi.fn(async (req: { clientAlgoId: string; symbol: string; triggerPrice: number }) => {
      calls.push("PLACE_REPLACEMENT");
      replacement = { ...req, triggerPrice: String(req.triggerPrice), algoStatus: "NEW" };
      return { ...replacement, algoId: 1 };
    }),
    queryAlgo: vi.fn(async (id: string) => {
      calls.push(`QUERY_${id}`);
      return id === replacement?.clientAlgoId ? { ...replacement, algoId: 1 }
        : { algoId: 2, clientAlgoId: id, symbol: "BTCUSDT", triggerPrice: "99", algoStatus: cancelled.has(id) ? "CANCELED" : "NEW" };
    }),
    cancelAlgo: vi.fn(async (id: string) => {
      calls.push(`CANCEL_${id}`); cancelled.add(id);
      return { algoId: 2, clientAlgoId: id, symbol: "BTCUSDT", triggerPrice: "99", algoStatus: "CANCELED" };
    }),
    getPositionRisk: vi.fn(),
  };
  return { client, calls };
}
const pos = { id: 1, symbol: "BTCUSDT", side: "LONG", qty: 0.3, entryPrice: 100, priceTick: 0.01 };
beforeEach(() => vi.clearAllMocks());

describe("BE protection replacement never sacrifices existing protection", () => {
  it("places and queries the new stop before cancelling only this symbol/trade's old stop", async () => {
    const { client, calls } = exchange();
    const result = await replaceOwnedStopAtBreakeven({ pos, client: client as BreakevenStopExchange, entryClientOrderId: "ENTRY_ONE", now: () => 1 });
    expect(client.cancelAlgo.mock.calls.map(([id]) => id)).toEqual(["SLA_ENTRY_ONE"]);
    expect(calls.indexOf(`QUERY_${result.clientAlgoId}`)).toBeLessThan(calls.indexOf("CANCEL_SLA_ENTRY_ONE"));
    expect(client.placeReduceOnlyGuard).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTCUSDT", quantity: 0.3, triggerPrice: 100 }));
    expect(result.oldCancellationConfirmed).toBe(true);
  });

  it("retains all old stops when replacement placement fails", async () => {
    const { client } = exchange();
    client.placeReduceOnlyGuard.mockRejectedValue(new Error("synthetic replacement failed"));
    await expect(replaceOwnedStopAtBreakeven({ pos, client: client as BreakevenStopExchange, entryClientOrderId: "ENTRY_ONE" }))
      .rejects.toThrow("synthetic replacement failed");
    expect(client.cancelAlgo).not.toHaveBeenCalled();
  });

  it("retains all old stops if the replacement query cannot verify trigger or active status", async () => {
    const { client } = exchange();
    client.queryAlgo.mockResolvedValue({ algoId: 1, clientAlgoId: "wrong", symbol: "BTCUSDT", triggerPrice: "101", algoStatus: "NEW" });
    await expect(replaceOwnedStopAtBreakeven({ pos, client: client as BreakevenStopExchange, entryClientOrderId: "ENTRY_ONE" }))
      .rejects.toThrow("BE_STOP_NOT_VERIFIED");
    expect(client.cancelAlgo).not.toHaveBeenCalled();
  });

  it("does not mutate any order when ownership cannot be established", async () => {
    const { client } = exchange();
    await expect(replaceOwnedStopAtBreakeven({ pos, client: client as BreakevenStopExchange, entryClientOrderId: "UNKNOWN_ENTRY" }))
      .rejects.toThrow("BE_OWNED_STOP_UNAVAILABLE");
    expect(client.placeReduceOnlyGuard).not.toHaveBeenCalled(); expect(client.cancelAlgo).not.toHaveBeenCalled();
  });
});

describe("live watcher accounting requires actual exit evidence", () => {
  it.each([null, { complete: false, attribution: "FULL", exitAvg: 102 },
    { complete: true, attribution: "AMBIGUOUS", exitAvg: 102 }])("defers unavailable or ambiguous fills without closing the ledger: %j", async evidence => {
    const watcher = new LivePositionWatcher();
    vi.spyOn(watcher as never as { fetchExchangeExitEvidence: () => Promise<unknown> }, "fetchExchangeExitEvidence").mockResolvedValue(evidence);
    const internals = watcher as never as { finalizeClosedPosition: (position: unknown, price: number) => Promise<void> };
    await internals.finalizeClosedPosition({ id: 1, symbol: "BTCUSDT", side: "LONG", qty: 1, entryPrice: 100 }, 98);
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.klines).not.toHaveBeenCalled();
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "LIVE_EXIT_ACCOUNTING_DEFERRED" }) }));
  });

  it("finalizes a legacy single-target position from attributable actual fills with provenance", async () => {
    const watcher = new LivePositionWatcher();
    vi.spyOn(watcher as never as { fetchExchangeExitEvidence: () => Promise<unknown> }, "fetchExchangeExitEvidence").mockResolvedValue({
      complete: true, attribution: "FULL", exitAvg: 102, filledQty: 1, realizedPnlUsd: 2,
      feeUsd: 0.02, entryFeeUsd: 0.01, fundingUsd: -0.01, fundingVerified: true, feeAssetClean: true,
    });
    const update = vi.fn(async () => ({}));
    const create = vi.fn(async ({ data }: { data: object }) => ({ id: 1, ...data }));
    mocks.transaction.mockImplementation(async (callback: (tx: object) => Promise<unknown>) => callback({
      position: { update }, trade: { findUnique: vi.fn(async () => null), create },
    }));
    const internals = watcher as never as { finalizeClosedPosition: (position: unknown, price: number) => Promise<void> };
    await internals.finalizeClosedPosition({ id: 2, symbol: "BTCUSDT", source: "LIVE_AI", strategyId: "S-02",
      side: "LONG", mode: "SCALP", qty: 1, originalQty: 1, entryPrice: 100, slPrice: 99, originalSlPrice: 99,
      originalRiskUsd: 1, openedAt: new Date("2026-10-16T00:00:00Z"), mfePrice: 103, maePrice: 99.2 }, 98);
    // Fee penuh (18 Okt 2026): DB pnlUsd = NET = gross 2 - fee (0.02+0.01) + funding (-0.01) = 1.96.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLOSED", pnlUsd: 1.96 }) }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      exitAvg: 102, pnlUsd: 1.96, source: "LIVE_AI", strategyId: "S-02", accountingQuality: "VERIFIED",
    }) }));
    expect(mocks.klines).not.toHaveBeenCalled();
  });
});
