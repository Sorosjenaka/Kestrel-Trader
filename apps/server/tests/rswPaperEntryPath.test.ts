// End-to-end smoke for a known RSW fixture signal: plan -> deterministic order
// sizing -> PAPER OrderExecutor fill. No exchange client, no DB, no main wallet.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateOrderPlan, checkSwingLiquidation, estimateCrossLiquidationPrice } from "../src/risk/riskEngine.js";
import { OrderExecutor, type OrderExecRepo, type OrderExecRow, type OrderStatus } from "../src/exec/orderExecutor.js";

class MemoryOrders implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, { ...row, id: this.rows.size + 1 }); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date, execution?: Partial<OrderExecRow>) {
    const old = this.rows.get(id); if (!old) throw new Error("ORDER_NOT_FOUND");
    const row = { ...old, status, ...(fillPrice !== undefined ? { fillPrice } : {}), ...(feeUsd !== undefined ? { feeUsd } : {}), ...(filledAt !== undefined ? { filledAt } : {}), ...(execution?.filledQty !== undefined ? { filledQty: execution.filledQty } : {}), ...(execution?.simulated !== undefined ? { simulated: execution.simulated } : {}) };
    this.rows.set(id, row); return row;
  }
}

describe("RSW known-signal PAPER entry smoke", () => {
  const root = join(__dirname, "..", "..", "..");
  const fixture = JSON.parse(readFileSync(join(root, "research", "data", "rsw-parity", "avax-h1h4d1.json"), "utf8")) as { signals: Array<{ strategyId: string; side: "LONG" | "SHORT"; entry: number; sl: number }> };
  for (const sid of ["RSW-01", "RSW-02", "RSW-03"]) {
    it(`${sid}: known entry -> order allowed -> PAPER LIMIT FILLED, no exchange`, async () => {
      const s = fixture.signals.find((x) => x.strategyId === sid)!;
      expect(s).toBeDefined();
      const sign = s.side === "LONG" ? 1 : -1;
      const r = Math.abs(s.entry - s.sl);
      const order = calculateOrderPlan({
        symbol: "AVAXUSDT", mode: "SWING", strategyId: sid, side: s.side,
        entryPrice: s.entry, slPrice: s.sl, tp1Price: s.entry + sign * 2 * r,
        equityUsd: 200, targetRiskUsd: 1, now: 1_700_000_000_000, riskBudgetMode: "NET",
        entryFeeRate: 0.0005, exitFeeRate: 0.0002, slippageBps: 0, leverageTarget: 25,
        symbolRules: { symbol: "AVAXUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, maxLeverage: 25, leverageUpdatedAt: 1_700_000_000_000 },
      });
      // The operator keeps 25x. ISOLATED cannot survive this structural SL,
      // but CROSS uses the $200 account equity as the buffer. The current
      // plannedEntry guard must not apply the isolated formula in CROSS.
      expect(order.allowed).toBe(false);
      expect(order.rejectReason).toBe("LIQUIDATION_TOO_CLOSE");
      const cross = calculateOrderPlan({
        symbol: "AVAXUSDT", mode: "SWING", strategyId: sid, side: s.side,
        entryPrice: s.entry, slPrice: s.sl, tp1Price: s.entry + sign * 2 * r,
        equityUsd: 200, targetRiskUsd: 1, now: 1_700_000_000_000, riskBudgetMode: "NET",
        entryFeeRate: 0.0005, exitFeeRate: 0.0002, slippageBps: 0, leverageTarget: 25,
        marginMode: "CROSS",
        symbolRules: { symbol: "AVAXUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, maxLeverage: 25, leverageUpdatedAt: 1_700_000_000_000 },
      });
      expect(cross.allowed).toBe(true);
      const crossLiq = estimateCrossLiquidationPrice(s.entry, s.side, 200, cross.notionalUsd, cross.notionalUsd);
      expect(crossLiq).not.toBeNull();
      if (s.side === "SHORT") expect(crossLiq!).toBeGreaterThan(s.sl);
      else expect(crossLiq!).toBeLessThan(s.sl);
      const guardCross = checkSwingLiquidation({ marginMode: "CROSS", side: s.side, entryPrice: s.entry, slPrice: s.sl, leverage: 25, equityUsd: 200, totalOpenNotionalUsd: 0, positionNotionalUsd: cross.notionalUsd });
      expect(guardCross.allowed).toBe(true);
      const guardIsolated = checkSwingLiquidation({ marginMode: "ISOLATED", side: s.side, entryPrice: s.entry, slPrice: s.sl, leverage: 25, equityUsd: 200, totalOpenNotionalUsd: 0, positionNotionalUsd: cross.notionalUsd });
      expect(guardIsolated.allowed).toBe(false);
      const executor = new OrderExecutor({ repo: new MemoryOrders(), paperAllowed: true, isArmed: () => true });
      const fill = await executor.executeOrder({ symbol: "AVAXUSDT", side: s.side === "LONG" ? "BUY" : "SELL", type: "LIMIT", price: cross.entryPrice, qty: cross.qty, clientOrderId: `TEST_${sid}` });
      expect(fill.simulated).toBe(true);
      expect(fill.status).toBe("FILLED");
      expect(fill.filledQty).toBeCloseTo(cross.qty, 8);
    });
  }
});
