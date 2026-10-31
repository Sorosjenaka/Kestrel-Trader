import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
const actions = vi.hoisted(() => ({ blocked: false, close: vi.fn() }));
vi.mock("../src/api/positionActions.js", () => ({
  liveAccountMutationBlocked: () => actions.blocked, closePaperPositions: actions.close,
}));
import { createApp } from "../src/app.js";
import { defaultDailyRiskGuard } from "../src/risk/dailyGuard.js";
import { autonomousTradingBot } from "../src/exec/autonomousTradingBot.js";
import { db } from "../src/core/db.js";

afterEach(() => { actions.blocked = false; vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("managed PAPER shutdown API", () => {
  it("rejects LIVE shutdown paths before any ARM or position action", async () => {
    actions.blocked = true;
    const arm = vi.spyOn(defaultDailyRiskGuard, "setArmed");
    const stop = vi.spyOn(autonomousTradingBot, "stop");
    for (const endpoint of ["/api/settings/kill", "/api/positions/kill-all", "/api/positions/1/kill"]) {
      const response = await request(createApp()).post(endpoint).set("x-api-token", "vitest-mutation-token").send({ exitPrice: 999 }).expect(403);
      expect(response.body.error).toBe("LIVE_ACCOUNT_MUTATIONS_BLOCKED");
    }
    expect(arm).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(actions.close).not.toHaveBeenCalled();
  });

  it("cannot claim success while positions remain unclosed", async () => {
    const state = { ok: false, closedPositionsCount: 0, remainingPositions: [{ id: 1, symbol: "BTCUSDT", qty: 1 }],
      failures: [{ positionId: 1, reason: "FRESH_FUTURES_MARK_REQUIRED" }] };
    actions.close.mockResolvedValue(state);
    vi.spyOn(defaultDailyRiskGuard, "setArmed").mockResolvedValue(undefined);
    vi.spyOn(autonomousTradingBot, "stop").mockImplementation(() => {});
    vi.spyOn(db.eventLog, "create").mockResolvedValue({} as never);
    for (const endpoint of ["/api/settings/kill", "/api/positions/kill-all"]) {
      const response = await request(createApp()).post(endpoint).set("x-api-token", "vitest-mutation-token").expect(409);
      expect(response.body).toMatchObject(state);
    }
  });

  it("rejects client assertions of a fill or mark price", async () => {
    for (const endpoint of ["/api/positions/tick", "/api/positions/1/hit-tp1"]) {
      await request(createApp()).post(endpoint).set("x-api-token", "vitest-mutation-token").send({ markPrice: 1000000 }).expect(409);
    }
    expect(actions.close).not.toHaveBeenCalled();
  });
});
