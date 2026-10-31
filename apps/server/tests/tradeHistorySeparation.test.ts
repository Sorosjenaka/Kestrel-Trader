import { describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";

describe("Trade History Separation (Scalp vs Swing API)", () => {
  it("GET /api/trades menyertakan byMode untuk SCALP dan SWING", async () => {
    const app = createApp();
    const res = await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(res.body.analytics).toBeDefined();
    expect(res.body.analytics.byMode).toBeDefined();
    expect(res.body.analytics.byMode.SCALP).toBeDefined();
    expect(res.body.analytics.byMode.SWING).toBeDefined();
    expect(typeof res.body.analytics.byMode.SCALP.totalTrades).toBe("number");
    expect(typeof res.body.analytics.byMode.SWING.totalTrades).toBe("number");
  });

  it("GET /api/trades?mode=SCALP dan /api/trades/scalp hanya mengembalikan trade SCALP", async () => {
    const db = new PrismaClient();
    const stamp = Date.now();
    const symScalp = `ZSCALP${stamp % 100000}USDT`;
    const symSwing = `ZSWING${stamp % 100000}USDT`;

    const posScalp = await db.position.create({
      data: {
        symbol: symScalp, mode: "SCALP", side: "LONG", entryPrice: 10, qty: 1, notional: 10, leverage: 10, marginUsd: 1,
        slPrice: 9.9, tp1Price: 10.15, tp2Price: 10.3, status: "CLOSED", closedAt: new Date(), closeReason: "TP1", pnlUsd: 0.15,
      },
    });
    await db.trade.create({
      data: {
        positionId: posScalp.id, symbol: symScalp, mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 10, exitAvg: 10.15,
        rMultiple: 1.5, pnlUsd: 0.15, feeUsd: 0.005, win: true, createdAt: new Date(), strategyId: "S-02", source: "PAPER_AI",
      },
    });

    const posSwing = await db.position.create({
      data: {
        symbol: symSwing, mode: "SWING", side: "LONG", entryPrice: 100, qty: 0.1, notional: 10, leverage: 5, marginUsd: 2,
        slPrice: 98, tp1Price: 105, tp2Price: 108, status: "CLOSED", closedAt: new Date(), closeReason: "TP", pnlUsd: 0.5,
      },
    });
    await db.trade.create({
      data: {
        positionId: posSwing.id, symbol: symSwing, mode: "SWING", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 105,
        rMultiple: 2.5, pnlUsd: 0.5, feeUsd: 0.005, win: true, createdAt: new Date(), strategyId: "S-05", source: "PAPER_AI",
      },
    });

    const app = createApp();

    // Test ?mode=SCALP
    const resScalp = await request(app).get("/api/trades?mode=SCALP").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(resScalp.body.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of resScalp.body.trades) {
      expect(t.mode).toBe("SCALP");
    }

    // Test /api/trades/scalp
    const resScalpRoute = await request(app).get("/api/trades/scalp").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(resScalpRoute.body.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of resScalpRoute.body.trades) {
      expect(t.mode).toBe("SCALP");
    }

    // Test ?mode=SWING
    const resSwing = await request(app).get("/api/trades?mode=SWING").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(resSwing.body.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of resSwing.body.trades) {
      expect(t.mode).toBe("SWING");
    }

    // Test /api/trades/swing
    const resSwingRoute = await request(app).get("/api/trades/swing").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(resSwingRoute.body.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of resSwingRoute.body.trades) {
      expect(t.mode).toBe("SWING");
    }
  });
});
