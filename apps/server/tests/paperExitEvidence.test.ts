import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({ db: { eventLog: { findMany: async () => [] } } }));
vi.mock("../src/core/env.js", () => ({ env: { PAPER_TOUCH_VERIFY: true, BINANCE_EXECUTION_MODE: "PAPER" } }));
vi.mock("../src/exec/liveRuntime.js", () => ({ activeOrderExecutor: {} }));
vi.mock("../src/learning/playbookRules.js", () => ({
  prismaPlaybookRuleStore: {}, recordApprovedRuleOutcomeForTrade: async () => {}, autoRollbackRuleIfNeeded: async () => {},
}));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { fetchKlines: vi.fn(async () => []) } }));

import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";
import { PositionSupervisor, type PositionRow, type PositionRepo, type TradeRow } from "../src/exec/positionSupervisor.js";
import { paperKlineTouchVerifier, type OrderExecutor, type OrderRequest } from "../src/exec/orderExecutor.js";

const minute = 60_000;
const candle = (time: number, high: number, low: number, open = 100, close = 100) =>
  [time, open, high, low, close];
const klines = vi.mocked(binanceFuturesClient.fetchKlines);
afterEach(() => { vi.clearAllMocks(); klines.mockResolvedValue([]); });

function fixture(mode = "SCALP", opened = minute) {
  let position = { id: 1, symbol: "MOCKUSDT", mode, side: "LONG", entryPrice: 100,
    qty: 0.5, originalQty: 0.5, slPrice: 98, originalSlPrice: 98, originalRiskUsd: 1,
    tp1Price: 103.4, tp2Price: 106.8, openedAt: new Date(opened), status: "OPEN", source: "PAPER_AI",
    leverage: 25, quantityStep: 0.001, accountingVersion: 1 } as PositionRow;
  let now = 4 * minute;
  const trades: TradeRow[] = [];
  const repo = {
    findOpenPositions: async () => position.status === "OPEN" ? [position] : [],
    findById: async () => position,
    updatePosition: async (_id: number, patch: Partial<PositionRow>) => (position = { ...position, ...patch }),
    logEvent: async () => {},
    closePositionWithTrade: async (_id: number, patch: Partial<PositionRow>, trade: TradeRow) => {
      position = { ...position, ...patch }; trades.push(trade); return trade;
    },
  } as unknown as PositionRepo;
  const executor = { executeOrder: vi.fn(async (request: OrderRequest) => ({ status: "FILLED", filledQty: request.qty,
    fillPrice: request.price, feeUsd: 0, simulated: true })) } as unknown as OrderExecutor;
  const makeSupervisor = () => new PositionSupervisor({ repo, executor, now: () => now });
  const supervisor = makeSupervisor();
  return { supervisor, restart: makeSupervisor, get: () => position, trades, executor,
    setNow: (time: number) => { now = time; },
    tick: (price: number) => supervisor.evaluatePriceTick({ symbol: "MOCKUSDT", markPrice: price }) };
}

describe("PAPER execution requires causal candle evidence", () => {
  it("does not fill a LIMIT when klines are empty", async () => {
    klines.mockResolvedValue([]);
    expect(await paperKlineTouchVerifier("MOCKUSDT", 103.4, "SELL", minute)).toBe(false);
  });
  it("ignores both completed pre-order candles and overlapping entry-minute wicks", async () => {
    klines.mockResolvedValue([candle(0, 110, 99), candle(minute, 110, 99)] as never);
    expect(await paperKlineTouchVerifier("MOCKUSDT", 105, "SELL", minute + 45_000)).toBe(false);
    klines.mockResolvedValue([candle(2 * minute, 110, 99)] as never);
    expect(await paperKlineTouchVerifier("MOCKUSDT", 105, "SELL", minute + 45_000)).toBe(true);
  });
  it("closes at an earlier SL rather than a later TP wick", async () => {
    const f = fixture();
    klines.mockResolvedValue([candle(minute, 101, 97.5), candle(2 * minute, 104, 99)] as never);
    await f.tick(100);
    expect(f.get().closeReason).toBe("SL");
    expect(f.trades[0].pnlUsd).toBeCloseTo(-1);
  });
  it("honors an earlier TP before the latest mark subsequently crosses SL", async () => {
    const f = fixture();
    klines.mockResolvedValue([candle(minute, 104, 99), candle(2 * minute, 101, 97.5)] as never);
    await f.tick(97);
    expect(f.get().closeReason).toBe("TP1");
    expect(f.trades[0].pnlUsd).toBeCloseTo(1.7);
  });
  it("selects SL first when a candle touches both levels", async () => {
    const f = fixture();
    klines.mockResolvedValue([candle(minute, 104, 97.5)] as never);
    await f.tick(100);
    expect(f.get().closeReason).toBe("SL");
  });
  it("does not jump across a missing candle to award a later TP", async () => {
    const f = fixture();
    klines.mockResolvedValue([candle(2 * minute, 104, 99)] as never);
    await f.tick(100);
    expect(f.get().status).toBe("OPEN");
    expect(f.trades).toHaveLength(0);
  });
  it("preserves a pending TP candle through restart until its fill is settled", async () => {
    const f = fixture();
    klines.mockResolvedValue([candle(minute, 104, 99)] as never);
    vi.mocked(f.executor.executeOrder).mockResolvedValueOnce({
      status: "NEW", filledQty: 0, fillPrice: null, feeUsd: 0, simulated: true,
    } as never);
    await f.tick(100);
    expect(f.get().qty).toBe(0.5);
    expect(JSON.parse(f.get().exitAccounting!).paperCandleCursorMs).toBe(minute);
    await f.restart().evaluatePriceTick({ symbol: "MOCKUSDT", markPrice: 100 });
    expect(f.get().status).toBe("CLOSED");
    expect(f.trades).toHaveLength(1);
    expect(f.trades[0].pnlUsd).toBeCloseTo(1.7);
  });
  it("applies the same stop-first chronology to SHORT positions", async () => {
    const f = fixture();
    Object.assign(f.get(), { side: "SHORT", slPrice: 102, originalSlPrice: 102, tp1Price: 96.6 });
    klines.mockResolvedValue([candle(minute, 102.5, 99), candle(2 * minute, 101, 96)] as never);
    await f.tick(100);
    expect(f.get().closeReason).toBe("SL");
    expect(f.trades[0].pnlUsd).toBeCloseTo(-1);
  });
  it("does not retrospectively use a candle overlapping entry", async () => {
    const f = fixture("SCALP", minute + 45_000);
    klines.mockResolvedValue([candle(minute, 110, 97)] as never);
    await f.tick(100);
    expect(f.get().status).toBe("OPEN");
  });
  it("persists the candle cursor across restart and applies BE only on the next candle", async () => {
    const f = fixture("SWING");
    f.setNow(2 * minute);
    // Low99 precedes the BE transition in an ambiguous first candle. It must
    // not retrospectively hit the new stop100 after this candle is consumed.
    klines.mockResolvedValue([candle(minute, 107, 99)] as never);
    await f.tick(106.9);
    expect(f.get().qty).toBeCloseTo(0.15);
    expect(f.get().slPrice).toBe(100);
    f.setNow(3 * minute);
    klines.mockResolvedValue([candle(minute, 107, 99), candle(2 * minute, 107, 105, 106, 106)] as never);
    await f.restart().evaluatePriceTick({ symbol: "MOCKUSDT", markPrice: 106 });
    expect(f.get().status).toBe("OPEN");
    expect(f.get().qty).toBeCloseTo(0.15);
  });
  it("retries a failed BE hook after TP2 has completed", async () => {
    const f = fixture("SWING");
    // Current, unfinished candle supplies current-mark TP evidence without
    // triggering completed-candle recovery in this transition-specific test.
    klines.mockResolvedValue([candle(4 * minute, 107, 101, 103, 106)] as never);
    const hook = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    f.supervisor.setBeMoveHook(hook);
    await f.tick(103.5);
    await f.tick(106.9);
    expect(f.get().slPrice).toBe(98);
    await f.tick(106.9);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(f.get().slPrice).toBe(100);
    expect(f.get().qty).toBeCloseTo(0.15);
  });
});
