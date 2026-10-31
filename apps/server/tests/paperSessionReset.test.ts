import { describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";
import { defaultDailyRiskGuard } from "../src/risk/dailyGuard.js";

describe("PAPER session reset", () => {
  it("starts a new $200 dashboard period without deleting trades or lessons", async () => {
    const db = new PrismaClient();
    const app = createApp();
    const priorArm = defaultDailyRiskGuard.isArmed();
    const priorReset = await db.setting.findUnique({ where: { key: "paperResetAt" } });
    let positionId: number | undefined;
    let tradeId: number | undefined;
    try {
      await defaultDailyRiskGuard.setArmed(false, "TEST_RESET");
      const position = await db.position.create({ data: {
        symbol: "ZZRESETTESTUSDT", mode: "SCALP", side: "LONG", entryPrice: 100,
        qty: 1, notional: 100, leverage: 25, marginUsd: 4,
        slPrice: 99, tp1Price: 101, tp2Price: 102,
        status: "CLOSED", closeReason: "SL", closedAt: new Date(Date.now() - 5000), source: "PAPER_AI",
      } });
      positionId = position.id;
      const trade = await db.trade.create({ data: {
        positionId, symbol: position.symbol, mode: "SCALP", side: "LONG", riskUsd: 1,
        entryAvg: 100, exitAvg: 99, rMultiple: -1, pnlUsd: -1.05, feeUsd: 0.05,
        win: false, source: "PAPER_AI", accountingQuality: "SIMULATED", createdAt: new Date(Date.now() - 5000),
      } });
      tradeId = trade.id;
      await db.learningEntry.create({ data: {
        tradeId, causeCode: "SL_TIGHT", outcome: "LOSS", narrative: "test preserved",
        agentId: "post-mortem", createdAt: new Date(Date.now() - 5000),
      } });
      const result = await request(app).post("/api/trades/reset").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(result.body.startingEquityUsd).toBe(200);
      expect(result.body.closedPositionsCount).toBe(0);
      const trades = await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(trades.body.trades.some((t: { id: number }) => t.id === tradeId)).toBe(false);
      const overview = await request(app).get("/api/overview").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(overview.body.equity.currentUsd).toBe(200);
      expect(await db.trade.count({ where: { id: tradeId } })).toBe(1);
      expect(await db.learningEntry.count({ where: { tradeId } })).toBe(1);
    } finally {
      if (tradeId) await db.learningEntry.deleteMany({ where: { tradeId } });
      if (tradeId) await db.trade.delete({ where: { id: tradeId } });
      if (positionId) await db.position.delete({ where: { id: positionId } });
      if (priorReset) await db.setting.update({ where: { key: "paperResetAt" }, data: { value: priorReset.value } });
      else await db.setting.deleteMany({ where: { key: "paperResetAt" } });
      await defaultDailyRiskGuard.setArmed(priorArm, "TEST_RESTORE");
      await db.$disconnect();
    }
  });
});
