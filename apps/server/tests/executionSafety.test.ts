import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionResult, ExchangeClient, OrderExecRepo, OrderExecRow, OrderStatus } from "../src/exec/orderExecutor.js";
import type { PositionRepo, PositionRow, TradeRow } from "../src/exec/positionSupervisor.js";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(), liveExecutor: { executeOrder: vi.fn(), cancelEntry: vi.fn() },
  eventCreate: vi.fn(async () => ({})), ruleEvents: vi.fn(async () => []),
}));
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: mocks.eventCreate, findMany: mocks.ruleEvents } } }));
vi.mock("../src/core/env.js", () => ({ env: { BINANCE_EXECUTION_MODE: "PAPER", PAPER_TOUCH_VERIFY: false } }));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { fetchKlines: vi.fn(async () => []) } }));
vi.mock("../src/risk/dailyGuard.js", () => ({ MAX_OPEN_POSITIONS: 20, defaultDailyRiskGuard: { evaluateStatus: mocks.guard } }));
vi.mock("../src/exec/liveRuntime.js", () => ({ LIVE_MODE: true, liveExchange: undefined,
  activeOrderExecutor: mocks.liveExecutor, flattenLiveSymbol: vi.fn(), checkLiveEntryGate: vi.fn(),
  livePositionWatcher: {}, prepareLiveSymbol: vi.fn() }));
vi.mock("../src/learning/playbookRules.js", () => ({ prismaPlaybookRuleStore: {},
  autoRollbackRuleIfNeeded: vi.fn(), recordApprovedRuleOutcomeForTrade: vi.fn(async () => undefined),
  interceptApprovedPlaybookRules: vi.fn(), recordApprovedRuleApplication: vi.fn() }));

import { OrderExecutor, paperPositionExecutor } from "../src/exec/orderExecutor.js";
import { PositionSupervisor, exitExecutorForPosition } from "../src/exec/positionSupervisor.js";
import { PositionReconciler } from "../src/exec/reconciler.js";
import { cleanupEntryAttempt, executePlannedEntry } from "../src/exec/plannedEntry.js";

class Orders implements OrderExecRepo {
  rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, { ...row }); return { ...row }; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number,
    filledAt?: Date, patch?: Partial<OrderExecRow>) {
    const row = this.rows.get(id)!;
    const updated = { ...row, ...patch, status, ...(fillPrice === undefined ? {} : { fillPrice }),
      ...(feeUsd === undefined ? {} : { feeUsd }), ...(filledAt === undefined ? {} : { filledAt }) };
    this.rows.set(id, updated); return { ...updated };
  }
}
function fixture(): PositionRow {
  return { id: 1, symbol: "BTCUSDT", side: "LONG", mode: "SCALP", source: "PAPER_AI",
    qty: 1, notional: 100, marginUsd: 4, leverage: 25, entryPrice: 100, slPrice: 99,
    tp1Price: 102, tp2Price: 102, tp1FilledAt: null, realizedPnlUsd: 0, tp1FillPrice: null,
    status: "OPEN", openedAt: new Date("2026-10-16T00:00:00Z"), closedAt: null,
    closeReason: null, pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
    originalSlPrice: 99, originalRiskUsd: 1, quantityStep: 0.1, accountingVersion: 1 };
}
function positionRepo() {
  let position = fixture();
  const trades: TradeRow[] = [], events: string[] = [];
  const repo: PositionRepo = {
    async findOpenPositions() { return position.status === "OPEN" ? [{ ...position }] : []; },
    async findById() { return { ...position }; }, async createPosition(data) { return { id: 1, ...data }; },
    async updatePosition(id, patch) { position = { ...position, ...patch }; return { ...position }; },
    async createTrade(trade) { trades.push(trade); return trade; },
    async logEvent(type) { events.push(type); },
  };
  return { repo, trades, events, get: () => position };
}
const execution = (patch: Partial<ExecutionResult> = {}): ExecutionResult => ({
  clientOrderId: "ENTRY", binanceOrderId: "SYNTHETIC", symbol: "BTCUSDT", status: "CANCELED",
  fillPrice: null, filledQty: 0, feeUsd: 0, ackLatencyMs: 0, fillLatencyMs: 0,
  isDuplicate: false, simulated: false, ...patch,
});

beforeEach(() => vi.clearAllMocks());

describe("execution audit: terminal cancellation and protected recovery", () => {
  it("does not store CANCELED when both cancellation and final query fail", async () => {
    const orders = new Orders();
    const exchange: ExchangeClient = {
      async postOrder() { return { orderId: "1", status: "NEW" }; },
      async queryOrder() { throw new Error("synthetic timeout"); },
      async cancelOrder() { throw new Error("synthetic timeout"); },
    };
    const executor = new OrderExecutor({ repo: orders, exchange, isArmed: () => true });
    const order = await executor.executeOrder({ clientOrderId: "ENTRY", symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: 100, qty: 1 });
    const result = await executor.cancelEntry("BTCUSDT", order.clientOrderId);
    expect(result.confirmed).toBe(false);
    expect(orders.rows.get("ENTRY")?.status).toBe("NEW");
  });

  it("queries cumulative racing fills even when the cancellation transport fails", async () => {
    const orders = new Orders();
    const exchange: ExchangeClient = {
      async postOrder() { return { orderId: "1", status: "NEW" }; },
      async queryOrder() { return { orderId: "1", status: "CANCELED", executedQty: 0.4, avgPrice: 100 }; },
      async cancelOrder() { throw new Error("synthetic timeout"); },
    };
    const executor = new OrderExecutor({ repo: orders, exchange, isArmed: () => true });
    await executor.executeOrder({ clientOrderId: "ENTRY", symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: 100, qty: 1 });
    const result = await executor.cancelEntry("BTCUSDT", "ENTRY");
    expect(result.confirmed).toBe(true);
    expect(result.execution?.filledQty).toBe(0.4);
    expect(orders.rows.get("ENTRY")?.filledQty).toBe(0.4);
  });

  it.each(["uncertain", "filled"])("retains every guard for an %s entry", async (state) => {
    const cancelAlgo = vi.fn();
    const result = { confirmed: state === "filled", execution: state === "filled" ? execution({ filledQty: 0.4, fillPrice: 100 }) : undefined };
    await cleanupEntryAttempt("BTCUSDT", "ENTRY", { ok: true, slClientAlgoId: "SL", tpClientAlgoId: "TP1", tp2ClientAlgoId: "TP2" },
      { executor: { cancelEntry: vi.fn(async () => result) }, client: { cancelAlgo } as never });
    expect(cancelAlgo).not.toHaveBeenCalled();
  });

  it("cleans TP2 together with SL/TP1 only after confirmed zero-fill settlement", async () => {
    const cancelAlgo = vi.fn(async () => ({}));
    await cleanupEntryAttempt("BTCUSDT", "ENTRY", { ok: true, slClientAlgoId: "SL", tpClientAlgoId: "TP1", tp2ClientAlgoId: "TP2" },
      { executor: { cancelEntry: vi.fn(async () => ({ confirmed: true, execution: execution() })) }, client: { cancelAlgo } as never });
    expect(cancelAlgo.mock.calls.map(([id]) => id)).toEqual(["TP2", "TP1", "SL"]);
  });
});

describe("execution audit: emergency exit supersedes a settled resting TP", () => {
  it.each(["SL", "KILL"])("settles an unfilled paper TP before %s closes the remaining position", async (reason) => {
    const orders = new Orders(), memory = positionRepo();
    const executor = new OrderExecutor({ repo: orders, paperTouchVerifier: async () => false });
    const supervisor = new PositionSupervisor({ repo: memory.repo, executor, gapVerifier: async () => ({ kind: "SL_FILL" }) });
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 102 });
    if (reason === "SL") await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 98 });
    else await supervisor.emergencyKill(1, 100);
    expect(memory.get().status).toBe("CLOSED");
    expect(memory.get().closeReason).toBe(reason);
    expect([...orders.rows.values()].map(row => [row.type, row.status])).toEqual([["LIMIT", "CANCELED"], ["MARKET", "FILLED"]]);
    expect(memory.trades).toHaveLength(1);
    // Fee penuh: pnlUsd = NET; GROSS = pnlUsd + feeUsd - fundingUsd = -1 (SL) / 0 (KILL).
    const emT = memory.trades[0];
    expect((emT.pnlUsd ?? 0) + (emT.feeUsd ?? 0) - (emT.fundingUsd ?? 0)).toBeCloseTo(reason === "SL" ? -1 : 0);
  });

  it("applies a partial fill raced with TP cancellation before sending only the remainder to SL", async () => {
    const orders = new Orders(), memory = positionRepo(), posted: Array<{ type: string; qty: number }> = [];
    const exchange: ExchangeClient = {
      async postOrder(req) { posted.push({ type: req.type, qty: req.qty }); return req.type === "LIMIT"
        ? { orderId: "TP", status: "NEW", executedQty: 0 }
        : { orderId: "SL", status: "FILLED", executedQty: req.qty, avgPrice: req.price }; },
      async cancelOrder() { return { status: "CANCELED" }; },
      async queryOrder() { return { orderId: "TP", status: "CANCELED", executedQty: 0.4, avgPrice: 102 }; },
    };
    const supervisor = new PositionSupervisor({ repo: memory.repo,
      executor: new OrderExecutor({ repo: orders, exchange }), gapVerifier: async () => ({ kind: "SL_FILL" }) });
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 102 });
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 98 });
    expect(posted).toEqual([{ type: "LIMIT", qty: 1 }, { type: "MARKET", qty: 0.6 }]);
    expect(memory.get().status).toBe("CLOSED");
    // Fee penuh: pnlUsd = NET; GROSS = pnlUsd + feeUsd - fundingUsd = 0.2.
    const pfT = memory.trades[0];
    expect((pfT.pnlUsd ?? 0) + (pfT.feeUsd ?? 0) - (pfT.fundingUsd ?? 0)).toBeCloseTo(0.2);
  });

  it("does not send a competing order while cancellation remains unknown", async () => {
    const memory = positionRepo();
    const send = vi.fn(async () => execution({ status: "NEW" }));
    const executor = { executeOrder: send, cancelEntry: vi.fn(async () => ({ confirmed: false })) } as unknown as OrderExecutor;
    const supervisor = new PositionSupervisor({ repo: memory.repo, executor, gapVerifier: async () => ({ kind: "SL_FILL" }) });
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 102 });
    await supervisor.emergencyKill(1, 100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(memory.get().status).toBe("OPEN");
    expect(memory.events).toContain("EXIT_WAITING_RECONCILIATION");
  });
});

describe("execution audit: account evidence and mode boundaries", () => {
  it("leaves the entire position ledger untouched when account snapshot fetch fails", async () => {
    const memory = positionRepo(), original = { ...memory.get() }, createTrade = vi.fn(), updatePosition = vi.fn();
    const reconciler = new PositionReconciler({ repo: { findOpenPositions: async () => [{ ...original, source: "LIVE_AI" }],
      updatePosition, createTrade, logEvent: vi.fn() }, exchange: { getOpenPositions: async () => { throw new Error("synthetic unavailable"); } } });
    await expect(reconciler.reconcile()).rejects.toThrow("RECONCILE_EXCHANGE_SNAPSHOT_UNAVAILABLE");
    expect(updatePosition).not.toHaveBeenCalled(); expect(createTrade).not.toHaveBeenCalled();
  });

  it("defers a flat LIVE position to evidence accounting without inventing SL/PnL", async () => {
    const updatePosition = vi.fn(), createTrade = vi.fn();
    const reconciler = new PositionReconciler({ repo: { findOpenPositions: async () => [{ ...fixture(), source: "LIVE_AI" }],
      updatePosition, createTrade, logEvent: vi.fn() }, exchange: { getOpenPositions: async () => [] } });
    const report = await reconciler.reconcile();
    expect(report.deferredCount).toBe(1); expect(report.reconciledClosedCount).toBe(0);
    expect(report.details[0].action).toBe("ACCOUNTING_DEFERRED");
    expect(updatePosition).not.toHaveBeenCalled(); expect(createTrade).not.toHaveBeenCalled();
  });

  it("routes retained PAPER positions to a simulated executor even when LIVE routing exists", () => {
    expect(exitExecutorForPosition({ source: "PAPER_AI" })).toBe(paperPositionExecutor);
    expect(exitExecutorForPosition({ source: "PAPER_MANUAL" })).toBe(paperPositionExecutor);
    expect(exitExecutorForPosition({ source: "LIVE_AI" })).toBe(mocks.liveExecutor);
  });

  it("LIVE ladder SWING tidak lagi diblokir awal; fail-closed di ARM sebelum mutasi", async () => {
    // 19 Okt 2026: ladder LIVE diaktifkan (engine paper -> live). ARM live tetap
    // hard-block; di sini guard mengembalikan armed=false dan tidak ada order.
    mocks.guard.mockResolvedValueOnce({ armed: false });
    await expect(executePlannedEntry({} as never, { mode: "SWING", source: "AI" })).rejects.toThrow("ARM_REQUIRED");
    expect(mocks.guard).toHaveBeenCalled(); expect(mocks.liveExecutor.executeOrder).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});
