import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
vi.mock("../src/exec/plannedEntry.js", async (original) => ({
  ...await original<typeof import("../src/exec/plannedEntry.js")>(),
  executePlannedEntry: vi.fn(async (input, metadata) => ({
    position: { mode: metadata.mode }, plan: input, fill: { simulated: true },
  })),
}));
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";
import { defaultDailyRiskGuard } from "../src/risk/dailyGuard.js";
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";
import { prismaUniverseRepo } from "../src/universe/universeManager.js";
import { executePlannedEntry } from "../src/exec/plannedEntry.js";
import { setTradingStyleOverride } from "../src/exec/slotFillPolicy.js";

afterEach(() => { setTradingStyleOverride(null); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("manual route passes validated mode to sizing and execution", () => {
  it.each(["SCALP", "SWING"] as const)("preserves %s through preview and manual opening without sending an order", async mode => {
    setTradingStyleOverride(mode);
    vi.spyOn(defaultDailyRiskGuard, "canOpenPosition").mockResolvedValue({ allowed: true } as never);
    vi.spyOn(defaultDailyRiskGuard, "evaluateStatus").mockResolvedValue({ cumulativePnlUsd: 0 } as never);
    vi.spyOn(prismaUniverseRepo, "getManualBlacklist").mockResolvedValue([]);
    vi.spyOn(db.position, "count").mockResolvedValue(0);
    vi.spyOn(db.symbol, "findUnique").mockResolvedValue({ symbol: "BTCUSDT", minNotional: 5, tickSize: 0.0001,
      stepSize: 0.001, maxLeverage: 25, maxLeverageUpdatedAt: new Date(), isBlacklisted: false } as never);
    vi.spyOn(binanceFuturesClient, "fetchSymbolTicker").mockResolvedValue({ markPrice: 100, volume24h: 100_000_000 } as never);
    vi.spyOn(binanceFuturesClient, "isPriceLive").mockReturnValue(true);
    const app = createApp();
    const body = { symbol: "BTCUSDT", mode, side: "LONG", entryPrice: 100, slPrice: 98, leverage: 25, equityUsd: 200 };
    const preview = await request(app).post("/api/orders/plan").set("x-api-token", "vitest-mutation-token").send(body).expect(200);
    expect(preview.body.allowed).toBe(true);
    expect(preview.body.plan.tp1Price).toBeCloseTo(mode === "SWING" ? 104 : 103.4, 4);
    expect(preview.body.plan.tp2Price).toBeCloseTo(mode === "SWING" ? 106 : 103.4, 4);
    if (mode === "SWING") {
      const missingStop = await request(app).post("/api/positions/open").set("x-api-token", "vitest-mutation-token").send({ ...body, slPrice: undefined }).expect(403);
      expect(missingStop.body.error).toBe("SWING_STRUCTURAL_SL_REQUIRED");
      expect(executePlannedEntry).not.toHaveBeenCalled();
    }
    const opened = await request(app).post("/api/positions/open").set("x-api-token", "vitest-mutation-token").send(body).expect(201);
    expect(opened.body.position.mode).toBe(mode);
    expect(executePlannedEntry).toHaveBeenCalledOnce();
    const [input, metadata] = vi.mocked(executePlannedEntry).mock.calls[0]!;
    expect(input.mode).toBe(mode);
    expect(metadata.mode).toBe(mode);
    expect(input.maxMarginUsd).toBe(mode === "SWING" ? 2 : 4.8);
  });
});
