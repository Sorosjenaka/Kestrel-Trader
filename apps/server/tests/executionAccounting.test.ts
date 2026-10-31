import { describe, expect, it } from "vitest";
import { PositionSupervisor, type PositionRepo, type PositionRow, type TradeRow } from "../src/exec/positionSupervisor.js";
import { OrderExecutor, type ExecutionResult, type OrderExecRepo, type OrderExecRow, type OrderRequest, type OrderStatus } from "../src/exec/orderExecutor.js";

class Positions implements PositionRepo {
  row: PositionRow;
  trades: TradeRow[] = [];
  events: string[] = [];
  constructor(overrides: Partial<PositionRow> = {}) {
    this.row = { id: 801, symbol: "TESTUSDT", mode: "SCALP", side: "LONG", entryPrice: 100, qty: 1,
      notional: 100, leverage: 25, marginUsd: 4, slPrice: 98, tp1Price: 102, tp2Price: 105,
      beMoved: false, tp1FilledAt: null, tp2FilledAt: null, realizedPnlUsd: 0, tp1FillPrice: null,
      status: "OPEN", openedAt: new Date(1700000000000), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1, originalSlPrice: 98,
      originalRiskUsd: 2, entryFeeUsd: 0.05, quantityStep: 0.01, priceTick: 0.1,
      accountingVersion: 1, mfePrice: 100, maePrice: 100, source: "PAPER_AI", ...overrides };
  }
  async findOpenPositions(symbol?: string) { return this.row.status === "OPEN" && (!symbol || symbol === this.row.symbol) ? [{ ...this.row }] : []; }
  async findById() { return { ...this.row }; }
  async createPosition(data: Omit<PositionRow, "id">) { this.row = { ...data, id: 801 }; return this.row; }
  async updatePosition(_id: number, patch: Partial<PositionRow>) { this.row = { ...this.row, ...patch }; return { ...this.row }; }
  async createTrade(trade: TradeRow) { this.trades.push(trade); return trade; }
  async closePositionWithTrade(id: number, patch: Partial<PositionRow>, trade: TradeRow) { await this.updatePosition(id, patch); return this.createTrade(trade); }
  async logEvent(action: string) { this.events.push(action); }
}
class Orders implements OrderExecRepo {
  rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, { ...row }); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date, execution?: Partial<OrderExecRow>) {
    const row = { ...this.rows.get(id)!, ...execution, status, fillPrice, feeUsd, filledAt };
    this.rows.set(id, row); return row;
  }
}
function result(req: OrderRequest, patch: Partial<ExecutionResult> = {}): ExecutionResult {
  return { clientOrderId: req.clientOrderId!, binanceOrderId: "SIM_TEST", symbol: req.symbol, status: "FILLED",
    fillPrice: req.price, filledQty: req.qty, feeUsd: 0, feeEstimated: false, ackLatencyMs: 0, fillLatencyMs: 0,
    isDuplicate: false, simulated: true, ...patch };
}
function supervisor(repo: Positions, execute: (req: OrderRequest) => Promise<ExecutionResult>) {
  return new PositionSupervisor({ repo, executor: { executeOrder: execute } as OrderExecutor,
    now: () => 1700000060000 });
}
const tick = (price: number) => ({ symbol: "TESTUSDT", markPrice: price });

describe("confirmed fill accounting", () => {
  it("a rejected TP1 cannot realize profit, move SL or shrink quantity", async () => {
    const repo = new Positions();
    const s = supervisor(repo, async (req) => result(req, { status: "REJECTED", filledQty: 0, fillPrice: null }));
    expect((await s.evaluatePriceTick(tick(102)))[0].action).toBe("NONE");
    expect(repo.row.qty).toBe(1);
    expect(repo.row.realizedPnlUsd).toBe(0); expect(repo.trades).toHaveLength(0);
  });
  it("partial fills use actual quantity, cumulative retries never double count", async () => {
    const repo = new Positions(); let calls = 0; const ids: string[] = [];
    const s = supervisor(repo, async (req) => {
      ids.push(req.clientOrderId!); calls++;
      return result(req, { status: calls < 3 ? "PARTIAL" : "FILLED", filledQty: calls < 3 ? 0.2 : 1,
        fillPrice: 102.1, feeUsd: calls < 3 ? 0.01 : 0.02 });
    });
    await s.evaluatePriceTick(tick(102)); expect(repo.row.qty).toBeCloseTo(0.8); expect(repo.row.status).toBe("OPEN");
    const realized = repo.row.realizedPnlUsd;
    await s.evaluatePriceTick(tick(102)); expect(repo.row.qty).toBeCloseTo(0.8); expect(repo.row.realizedPnlUsd).toBe(realized);
    await s.evaluatePriceTick(tick(102)); expect(repo.row.qty).toBeCloseTo(0); expect(repo.row.status).toBe("CLOSED");
    expect(new Set(ids).size).toBe(1); expect(repo.row.originalRiskUsd).toBe(2);
  });
  it("single target gap: 100% keluar di TP1 dengan fee penuh (NET)", async () => {
    const repo = new Positions(); const requests: OrderRequest[] = [];
    const s = supervisor(repo, async (req) => { requests.push(req); return result(req, { fillPrice: requests.length === 1 ? 102.1 : 105.2, feeUsd: 0.01 }); });
    const actions = await s.evaluatePriceTick(tick(106));
    expect(actions.map((r) => r.action)).toEqual(["TP1"]);
    expect(repo.row.qty).toBe(0); expect(repo.row.status).toBe("CLOSED");
    expect(repo.trades[0].exitAvg).toBeCloseTo(102.1);
    // Fee penuh: entry taker 0.05 + exit 0.01 = 0.06 (feeUsd = rincian; sudah dibakar ke pnlUsd NET).
    expect(repo.trades[0].feeUsd).toBeCloseTo(0.06);
    // pnlUsd NET = gross 2.1 - fee 0.06 = 2.04. rMultiple tetap GROSS (2.1/2 = 1.05).
    expect(repo.trades[0].pnlUsd).toBeCloseTo(2.04);
    expect(repo.trades[0].rMultiple).toBeCloseTo(1.05);
    expect(repo.trades[0].riskUsd).toBe(2);
    expect(repo.trades[0].accountingQuality).toBe("SIMULATED");
    expect(repo.trades[0].fundingVerified).toBe(false);
  });
  it("concurrent price ticks and emergency exit cannot duplicate reductions", async () => {
    const repo = new Positions(); const requests: OrderRequest[] = [];
    const s = supervisor(repo, async (req) => { requests.push(req); await Promise.resolve(); return result(req); });
    await Promise.all([s.evaluatePriceTick(tick(106)), s.evaluatePriceTick(tick(106)), s.emergencyKill(801, 106)]);
    expect(requests.reduce((n, r) => n + r.qty, 0)).toBeCloseTo(1);
    expect(repo.trades).toHaveLength(1);
  });
  it("step-sized position closes without zero quantity runner", async () => {
    const repo = new Positions({ qty: 0.01, originalQty: 0.01, originalRiskUsd: 0.02, entryFeeUsd: 0.0005 });
    const quantities: number[] = [];
    const s = supervisor(repo, async (req) => { quantities.push(req.qty); return result(req); });
    await s.evaluatePriceTick(tick(102));
    expect(quantities).toEqual([0.01]); expect(repo.row.status).toBe("CLOSED"); expect(repo.row.closeReason).toBe("TP1");
  });
  it("step-sized qty keluar penuh di TP1 dan menyimpan risk yang immutable", async () => {
    const repo = new Positions({ qty: 0.03, originalQty: 0.03, originalRiskUsd: 0.06, entryFeeUsd: 0 });
    const quantities: number[] = [];
    const s = supervisor(repo, async (req) => { quantities.push(req.qty); return result(req); });
    await s.evaluatePriceTick(tick(102));
    expect(quantities).toEqual([0.03]);
    expect(repo.row.status).toBe("CLOSED"); expect(repo.row.closeReason).toBe("TP1");
    expect(repo.trades[0].riskUsd).toBe(0.06);
    expect(repo.trades[0].exitAvg).toBeCloseTo(102);
  });
  it("stop gap records observed executable paper price, not stale stop level", async () => {
    const repo = new Positions();
    const s = supervisor(repo, async (req) => result(req));
    await s.evaluatePriceTick(tick(90));
    expect(repo.row.closeReason).toBe("SL"); expect(repo.trades[0].exitAvg).toBe(90);
    // Fee penuh: NET = gross -10 - entry fee 0.05 (exit fee mock 0) = -10.05.
    expect(repo.trades[0].pnlUsd).toBeCloseTo(-10.05);
    expect(repo.trades[0].feeUsd).toBeCloseTo(0.05);
    expect(repo.trades[0].rMultiple).toBeCloseTo(-5); // gross -10 / risk 2
  });
  it("MFE/MAE come from observed ticks even for losing trade", async () => {
    const repo = new Positions(); const s = supervisor(repo, async (req) => result(req));
    await s.evaluatePriceTick(tick(101.5)); await s.evaluatePriceTick(tick(97.5));
    expect(repo.trades[0].mfeR).toBeCloseTo(0.75); expect(repo.trades[0].maeR).toBeCloseTo(1.25);
    expect(repo.trades[0].excursionsVerified).toBe(true);
  });
  it("isolated approximation never fabricates a liquidation exit", async () => {
    const repo = new Positions({ slPrice: 95, originalSlPrice: 95, originalRiskUsd: 5 });
    const s = new PositionSupervisor({ repo, marginMode: "ISOLATED",
      executor: { executeOrder: async (req: OrderRequest) => result(req) } as OrderExecutor });
    await s.evaluatePriceTick(tick(96)); expect(repo.row.status).toBe("OPEN");
  });
});

describe("executor execution evidence", () => {
  it("concurrent identical ids submit once and preserve paper provenance on retry", async () => {
    const repo = new Orders(); const executor = new OrderExecutor({ repo });
    const req: OrderRequest = { clientOrderId: "same", symbol: "TESTUSDT", side: "BUY", type: "MARKET", qty: 1, price: 100 };
    const results = await Promise.all([executor.executeOrder(req), executor.executeOrder(req)]);
    expect(repo.rows.size).toBe(1); expect(results.every((r) => r.simulated)).toBe(true);
    // Fee penuh: MARKET = taker 0,05% -> 1 * 100 * 0.0005 = 0.05.
    expect(results[0].feeUsd).toBeCloseTo(0.05, 6); expect((await executor.executeOrder(req)).simulated).toBe(true);
  });
  it("persists partial cumulative qty, fill price, exchange id and fee evidence", async () => {
    const repo = new Orders(); const executor = new OrderExecutor({ repo, isArmed: () => true, exchange: {
      postOrder: async () => ({ orderId: "42", status: "PARTIALLY_FILLED", avgPrice: 101, executedQty: 0.2, feeUsd: 0.01 }),
      queryOrder: async () => ({ orderId: "42", status: "FILLED", avgPrice: 102, executedQty: 1, feeUsd: 0.05 }),
    } });
    const req: OrderRequest = { clientOrderId: "real", symbol: "TESTUSDT", side: "BUY", type: "MARKET", qty: 1, price: 100 };
    const first = await executor.executeOrder(req); expect(first.filledQty).toBe(0.2); expect(first.fillPrice).toBe(101);
    const next = await executor.executeOrder(req); expect(next.filledQty).toBe(1); expect(next.fillPrice).toBe(102);
    expect(repo.rows.get("real")?.binanceOrderId).toBe("42"); expect(next.feeEstimated).toBe(true);
  });
  it("no exchange does not transform unresolved NEW order into a fill", async () => {
    const repo = new Orders(); await repo.create({ clientOrderId: "unknown", symbol: "TESTUSDT", side: "BUY", type: "MARKET", price: 100, qty: 1, reduceOnly: false, status: "NEW" });
    const value = await new OrderExecutor({ repo }).verifyFill("TESTUSDT", "unknown");
    expect(value.status).toBe("NEW"); expect(value.filledQty).toBe(0); expect(value.simulated).toBe(false);
  });
});
