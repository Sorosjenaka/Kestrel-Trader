// apps/server/tests/overview.test.ts - Uji endpoint Dashboard Overview (FR-29, US-09).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("FR-29 & US-09: Dashboard Overview", () => {
  it("GET /api/overview mengembalikan equity, pnl, guard status, llm budget, dan top movers", async () => {
    const app = createApp();
    const res = await request(app).get("/api/overview").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(res.body.equity).toBeDefined();
    expect(typeof res.body.equity.startingUsd).toBe("number");
    expect(typeof res.body.equity.currentUsd).toBe("number");
    expect(typeof res.body.equity.dailyPnlUsd).toBe("number");

    expect(res.body.guard).toBeDefined();
    expect(typeof res.body.guard.canTrade).toBe("boolean");
    expect(typeof res.body.guard.openPositionsCount).toBe("number");

    expect(Array.isArray(res.body.positions)).toBe(true);

    expect(res.body.llm).toBeDefined();
    expect(typeof res.body.llm.dailyCostUsd).toBe("number");
    expect(typeof res.body.llm.monthlyBudgetUsd).toBe("number");

    expect(res.body.topMovers).toBeDefined();
    expect(Array.isArray(res.body.topMovers.gainers)).toBe(true);
    expect(Array.isArray(res.body.topMovers.losers)).toBe(true);
    expect(res.body.topMovers.gainers.length).toBeLessThanOrEqual(5);
    expect(res.body.topMovers.losers.length).toBeLessThanOrEqual(5);

    expect(typeof res.body.refreshedAt).toBe("string");
  });
});
