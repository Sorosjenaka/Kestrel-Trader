// S-05 Polaris functional path on a real research fixture:
// known closed 1h signal -> evaluator (ARSIP) -> plan -> deterministic
// $1/CROSS 25x sizing -> PAPER LIMIT fill. No exchange, DB, main wallet, or
// LIVE import.
//
// 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05 dihapus
// dari katalog AKTIF, jadi jalur ENTRY-nya fail-closed. Test ini sengaja
// memakai evaluator ARSIP (evaluateSwingBreakoutArchive) supaya mesin
// sizing + fill tetap teruji: operator akan meracik backtest dari strategi
// lain, dan riskEngine + OrderExecutor tidak boleh ikut rusak.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bar } from "../src/universe/eligibility.js";
import { runSwingBreakoutSignals } from "../src/strategies/swingBreakoutEngine.js";
import { evaluateSwingBreakoutArchive, type StrategyContext } from "../src/strategies/setupStrategies.js";
import { calculateOrderPlan } from "../src/risk/riskEngine.js";
import { OrderExecutor, type OrderExecRepo, type OrderExecRow, type OrderStatus } from "../src/exec/orderExecutor.js";

const FIXTURES = join(__dirname, "fixtures", "swing");
const APR_1_MS = Date.parse("2026-04-01T00:00:00Z");

function loadBars(symbol: string): Bar[] {
  return readFileSync(join(FIXTURES, `${symbol}-1h.csv`), "utf8")
    .split(/\r?\n/)
    .map((row) => row.split(",").map(Number))
    .filter((x) => x.length >= 6 && Number.isFinite(x[0]) && x[0]! >= APR_1_MS)
    .map((x) => ({ openTime: x[0]!, open: x[1]!, high: x[2]!, low: x[3]!, close: x[4]!, volume: x[5]! }));
}

function ctx(symbol: string, bars: Bar[]): StrategyContext {
  const price = bars.at(-1)!.close;
  return {
    analysis: {
      symbol, mode: "SWING", side: "LONG", price, usable: true, reason: null,
      tfSummary: "S-05 fixture", biasAligned: true, analyzedAt: bars.at(-1)!.openTime,
      timeframes: [], trigger: null, structure: null, bias: null, confirm: null,
      confirmAligned: true, zoneScore: 0, triggerScore: 0, trendScore: 50,
      compositeScore: 50, bestZone: null, zoneAnalysis: null, atrTrigger: null, atrStructure: null,
    } as unknown as StrategyContext["analysis"],
    price, mode: "SWING", swing: { h1Bars: bars },
  };
}

class MemoryOrders implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, { ...row, id: this.rows.size + 1 }); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date, execution?: Partial<OrderExecRow>) {
    const old = this.rows.get(id);
    if (!old) throw new Error("ORDER_NOT_FOUND");
    const row = { ...old, status, ...(fillPrice !== undefined ? { fillPrice } : {}), ...(feeUsd !== undefined ? { feeUsd } : {}), ...(filledAt !== undefined ? { filledAt } : {}), ...(execution?.filledQty !== undefined ? { filledQty: execution.filledQty } : {}), ...(execution?.simulated !== undefined ? { simulated: execution.simulated } : {}) };
    this.rows.set(id, row);
    return row;
  }
}

describe("S-05 Polaris known-signal PAPER entry path", () => {
  it("real fixture signal -> matched plan -> CROSS 25x sizing -> PAPER LIMIT FILLED", async () => {
    const bars = loadBars("DOGEUSDT");
    expect(bars.length).toBeGreaterThan(4000);
    const signals = runSwingBreakoutSignals(bars);
    expect(signals.length).toBeGreaterThan(10);

    let selected: { plan: ReturnType<typeof evaluateSwingBreakoutArchive>; slice: Bar[] } | null = null;
    for (const signal of signals.slice(-20).reverse()) {
      const slice = bars.slice(0, signal.index + 1);
      const plan = evaluateSwingBreakoutArchive(ctx("DOGEUSDT", slice));
      if (plan.matched && plan.side === signal.side) { selected = { plan, slice }; break; }
    }
    expect(selected, "no matching S-05 fixture plan").not.toBeNull();
    const plan = selected!.plan;
    const order = calculateOrderPlan({
      symbol: "DOGEUSDT", mode: "SWING", strategyId: "S-05", side: plan.side,
      entryPrice: plan.entryPrice, slPrice: plan.slPrice, tp1Price: plan.tp1Price,
      equityUsd: 200, targetRiskUsd: 1, now: plan.entryAt ?? 1_700_000_000_000,
      riskBudgetMode: "NET", entryFeeRate: 0.0005, exitFeeRate: 0.0002, slippageBps: 0,
      leverageTarget: 25, marginMode: "CROSS",
      symbolRules: { symbol: "DOGEUSDT", tickSize: 0.00001, stepSize: 1, minQty: 1, minNotional: 5, maxLeverage: 25, leverageUpdatedAt: 1_700_000_000_000 },
    });
    expect(order.allowed, order.rejectReason ?? "").toBe(true);
    expect(order.qty).toBeGreaterThan(0);
    expect(order.notionalUsd).toBeGreaterThanOrEqual(5);
    const executor = new OrderExecutor({ repo: new MemoryOrders(), paperAllowed: true, isArmed: () => true });
    const fill = await executor.executeOrder({
      symbol: "DOGEUSDT", side: plan.side === "LONG" ? "BUY" : "SELL", type: "LIMIT",
      price: order.entryPrice, qty: order.qty, clientOrderId: "TEST_S05_FUNCTIONAL",
    });
    expect(fill.simulated).toBe(true);
    expect(fill.status).toBe("FILLED");
    expect(fill.filledQty).toBeCloseTo(order.qty, 8);
  });
});
