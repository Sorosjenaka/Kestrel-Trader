// apps/server/tests/tvMcpBridge.test.ts - Uji TV Bridge MCP OAuth (Standby OFF) (FR-37, US-08).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { TvMcpBridge } from "../src/tv/tvMcpBridge.js";

describe("FR-37 & US-08: TV Bridge MCP OAuth (Standby OFF)", () => {
  it("default status adalah STANDBY_OFF dan fitur lain tetap berjalan normal (FR-37)", () => {
    const bridge = new TvMcpBridge({ enabled: false });
    const status = bridge.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.status).toBe("STANDBY_OFF");
    expect(status.accountTier).toBe("FREE");
    expect(status.notice).toContain("FREE");
  });

  it("saat standby OFF, syncWatchlist dan createAlerts dilewati dengan aman (skipped=true) tanpa error", async () => {
    const bridge = new TvMcpBridge({ enabled: false });

    const watchRes = await bridge.syncWatchlist(["BTCUSDT", "ETHUSDT"]);
    expect(watchRes.success).toBe(true);
    expect(watchRes.skipped).toBe(true);
    expect(watchRes.reason).toContain("STANDBY_OFF");

    const alertRes = await bridge.createOrUpdate4LevelAlerts({
      symbol: "BTCUSDT",
      levels: { entry: 60000, sl: 59400, tp1: 60600, tp2: 61200 },
    });
    expect(alertRes.success).toBe(true);
    expect(alertRes.skipped).toBe(true);
  });

  it("saat diaktifkan dengan akun ESSENTIAL_PLUS, syncWatchlist dan alerts berhasil dieksekusi", async () => {
    const bridge = new TvMcpBridge({ enabled: true, accountTier: "ESSENTIAL_PLUS" });
    const status = bridge.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.status).toBe("CONNECTED");

    const watchRes = await bridge.syncWatchlist(["SOLUSDT", "BNBUSDT"]);
    expect(watchRes.success).toBe(true);
    expect(watchRes.syncedCount).toBe(2);
    expect(watchRes.skipped).toBe(false);

    const alertRes = await bridge.createOrUpdate4LevelAlerts({
      symbol: "SOLUSDT",
      levels: { entry: 150, sl: 147, tp1: 153, tp2: 159 },
    });
    expect(alertRes.success).toBe(true);
    expect(alertRes.skipped).toBe(false);
    expect(alertRes.alertId).toBeDefined();
  });

  it("API /api/tv/mcp/status dan /api/tv/mcp/sync-watchlist berfungsi", async () => {
    const app = createApp();

    const statusRes = await request(app).get("/api/tv/mcp/status").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(statusRes.body.status).toBeDefined();
    expect(statusRes.body.status.watchlistName).toBe("Bot Active");

    const syncRes = await request(app).post("/api/tv/mcp/sync-watchlist").set("x-api-token", "vitest-mutation-token")
      .send({ symbols: ["BTCUSDT"] })
      .expect(200);

    expect(syncRes.body.success).toBe(true);
    expect(syncRes.body.skipped).toBe(true);
  });
});
