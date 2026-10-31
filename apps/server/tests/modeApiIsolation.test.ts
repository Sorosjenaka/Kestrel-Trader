import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { db } from "../src/core/db.js";
import { createApp } from "../src/app.js";
import { setTradingStyleOverride } from "../src/exec/slotFillPolicy.js";

afterEach(() => setTradingStyleOverride(null));

describe("runtime mode API isolation", () => {
  it("reports configured lanes and rejects disabled or malformed manual entry/preview modes", async () => {
    const app = createApp();
    for (const style of ["SCALP", "SWING", "BOTH"] as const) {
      setTradingStyleOverride(style);
      const settings = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(settings.body.tradingStyle).toBe(style);
      expect(settings.body.modes).toEqual({ scalp: style !== "SWING", swing: style !== "SCALP" });
      for (const endpoint of ["/api/orders/plan", "/api/positions/open"]) {
        const invalid = await request(app).post(endpoint).set("x-api-token", "vitest-mutation-token").send({ mode: "invalid" }).expect(400);
        expect(invalid.body.error).toBe("INVALID_TRADING_MODE");
        if (style !== "BOTH") {
          const disabled = await request(app).post(endpoint).set("x-api-token", "vitest-mutation-token")
            .send({ mode: style === "SWING" ? "SCALP" : "SWING" }).expect(403);
          expect(disabled.body.error).toBe("TRADING_MODE_DISABLED");
        }
      }
    }
  });

  it("keeps dual-mode counts, PnL and equity separate even behind 205 trades in the other lane", async () => {
    const originalReset = await db.setting.findUnique({ where: { key: "paperResetAt" } });
    const prefix = "MODEAPI_ISOLATION_";
    const start = new Date("2035-01-01T00:00:00Z");
    try {
      await db.setting.upsert({ where: { key: "paperResetAt" },
        update: { value: start.toISOString() }, create: { key: "paperResetAt", value: start.toISOString() } });
      await db.$transaction(Array.from({ length: 206 }, (_, index) => {
        const mode = index === 0 ? "SWING" : "SCALP";
        const pnl = index === 0 ? -2 : 1;
        const at = new Date(start.getTime() + (index + 1) * 1000);
        return db.position.create({ data: {
          symbol: `${prefix}${index}USDT`, mode, side: "LONG", entryPrice: 100,
          qty: 1, notional: 100, leverage: 25, marginUsd: 4,
          slPrice: 98, tp1Price: 102, tp2Price: 102,
          status: "CLOSED", openedAt: start, closedAt: at, closeReason: pnl > 0 ? "TP1" : "SL",
          source: "PAPER_AI", strategyId: "S-02",
          trade: { create: {
            symbol: `${prefix}${index}USDT`, mode, side: "LONG", strategyId: "S-02",
            riskUsd: 1, entryAvg: 100, exitAvg: 100 + pnl, pnlUsd: pnl,
            rMultiple: pnl, feeUsd: 0, win: pnl > 0, createdAt: at,
            source: "PAPER_AI", accountingQuality: "SIMULATED",
          } },
        } });
      }));
      const app = createApp();
      const all = (await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200)).body;
      expect(all.analytics.totalTrades).toBe(206);
      expect(all.trades).toHaveLength(200);
      expect(all.trades.every((trade: { mode: string }) => trade.mode === "SCALP")).toBe(true);
      expect(all.analytics.byMode.SWING).toMatchObject({ totalTrades: 1, netPnlUsd: -2, winCount: 0 });
      expect(all.analytics.byMode.SCALP).toMatchObject({ totalTrades: 205, netPnlUsd: 205, winCount: 205 });
      for (const endpoint of ["/api/trades?mode=SWING", "/api/trades/swing"]) {
        const swing = (await request(app).get(endpoint).set("x-api-token", "vitest-mutation-token").expect(200)).body;
        expect(swing.trades).toHaveLength(1);
        expect(swing.trades[0].mode).toBe("SWING");
        expect(swing.analytics).toMatchObject({ totalTrades: 1, netPnlUsd: -2, currentEquityUsd: 198 });
        expect(swing.analytics.strategyStats.find((row: { id: string }) => row.id === "S-02"))
          .toMatchObject({ trades: 1, pnl: -2, winRate: 0 });
        expect(swing.equityCurve.at(-1).equity).toBe(198);
      }
      const scalp = (await request(app).get("/api/trades?mode=SCALP").set("x-api-token", "vitest-mutation-token").expect(200)).body;
      expect(scalp.trades).toHaveLength(200);
      expect(scalp.analytics).toMatchObject({ totalTrades: 205, netPnlUsd: 205, currentEquityUsd: 405 });
      expect(scalp.analytics.strategyStats.find((row: { id: string }) => row.id === "S-02"))
        .toMatchObject({ trades: 205, pnl: 205, winRate: 100 });
      expect(scalp.equityCurve[0].equity).toBe(205);
      expect(scalp.equityCurve.at(-1).equity).toBe(405);
    } finally {
      await db.position.deleteMany({ where: { symbol: { startsWith: prefix } } });
      if (originalReset) await db.setting.update({ where: { key: "paperResetAt" }, data: { value: originalReset.value } });
      else await db.setting.deleteMany({ where: { key: "paperResetAt" } });
    }
  });
});
