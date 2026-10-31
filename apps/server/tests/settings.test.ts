// apps/server/tests/settings.test.ts - Uji Settings & Security (FR-35, NFR-08, US-15).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { env } from "../src/core/env.js";

describe("FR-35, NFR-08, US-15: Settings & Security", () => {
  it("GET /api/settings mengembalikan status ter-mask, mode, blacklist, dan thresholds", async () => {
    const app = createApp();
    const res = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(typeof res.body.arm).toBe("boolean");
    expect(res.body.keys).toBeDefined();
    expect(["SET", "MISSING"]).toContain(res.body.keys.binance);
    expect(["SET", "MISSING"]).toContain(res.body.keys.xkiro);
    expect(["SET", "MISSING"]).toContain(res.body.keys.llm);

    expect(res.body.modes).toBeDefined();
    expect(typeof res.body.modes.scalp).toBe("boolean");
    expect(typeof res.body.modes.scalp).toBe("boolean");

    expect(Array.isArray(res.body.blacklistManual)).toBe(true);

    expect(res.body.thresholds).toBeDefined();
    expect(res.body.thresholds.riskPerTradeUsd).toBe(Number(env.RISK_PER_TRADE_USD || 1.0));
    expect(res.body.thresholds.marginCapPct).toBe(40);
    // Perintah operator: guard harian & drawdown DIMATIKAN (0 = tanpa batas).
    expect(res.body.thresholds.dailyStopUsd).toBe(0);
    expect(res.body.thresholds.autoDisarmDdUsd).toBe(0);
    expect(res.body.thresholds.dailyGuardEnabled).toBe(false);
    expect(res.body.thresholds.drawdownGuardEnabled).toBe(false);
    expect(res.body.thresholds.maxOpenPositions).toBe(20);
    expect(res.body.thresholds.startingEquityUsd).toBe(200);
  });

  it("NFR-08: respon GET /api/settings tidak pernah membocorkan nilai secret", async () => {
    const app = createApp();
    const res = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    const bodyStr = JSON.stringify(res.body);

    for (const secret of [env.BINANCE_API_KEY, env.BINANCE_API_SECRET, env.XKIRO_API_KEY]) {
      if (secret && secret.length > 8) {
        expect(bodyStr).not.toContain(secret);
      }
    }
  });

  it("PUT /api/settings menolak perubahan mode yang memerlukan restart", async () => {
    const app = createApp();
    const before = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    await request(app).put("/api/settings").set("x-api-token", "vitest-mutation-token")
      .send({ arm: !before.body.arm, modes: { scalp: true } })
      .expect(409);

    const getRes = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(getRes.body.arm).toBe(before.body.arm);
    expect(getRes.body.tradingStyle).toBe("SWING");
    expect(getRes.body.modes).toEqual({ scalp: false, swing: true });

    // Kembalikan ke false
    await request(app).put("/api/settings").set("x-api-token", "vitest-mutation-token")
      .send({ arm: false })
      .expect(200);
  });

  it("POST & DELETE /api/settings/blacklist mengelola daftar blacklist manual", async () => {
    const app = createApp();
    const testSym = "TESTCOINUSDT";

    // 1. Tambah blacklist
    await request(app).post("/api/settings/blacklist").set("x-api-token", "vitest-mutation-token")
      .send({ symbol: testSym, reason: "Test manual blacklist" })
      .expect(200);

    let getRes = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(getRes.body.blacklistManual.some((b: { symbol: string }) => b.symbol === testSym)).toBe(true);

    // 2. Hapus blacklist
    await request(app).delete(`/api/settings/blacklist/${testSym}`).set("x-api-token", "vitest-mutation-token")
      .expect(200);

    getRes = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(getRes.body.blacklistManual.some((b: { symbol: string }) => b.symbol === testSym)).toBe(false);
  });

  it("POST /api/settings/kill mematikan ARM dan menutup posisi secara darurat", async () => {
    const app = createApp();
    const killRes = await request(app).post("/api/settings/kill").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(killRes.body.ok).toBe(true);
    expect(killRes.body.armed).toBe(false);

    const getRes = await request(app).get("/api/settings").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(getRes.body.arm).toBe(false);
  });
});
