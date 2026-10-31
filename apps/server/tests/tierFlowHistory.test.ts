// 25 Okt 2026 (FASE 5) — window harus jujur soal coverage: range 7d dengan
// retensi ring 2 hari => PARTIAL_HISTORY + rentang coverage yang tersedia,
// bukan angka 2 hari yang dilabeli 7 hari.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("tier-flow history coverage", () => {
  it("range 7d -> PARTIAL_HISTORY dengan coverage ~2 hari (retensi ring)", async () => {
    const app = createApp();
    const res = await request(app).get("/api/tier-flow/BTC?range=7d").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body.history.status).toBe("PARTIAL_HISTORY");
    expect(res.body.history.coverageSec).toBe(2880 * 60);
    expect(res.body.history.retentionSec).toBe(2880 * 60);
    // rentang coverage dilaporkan (bukan requestedFrom yang 7 hari)
    expect(res.body.history.coverageFrom).toBeGreaterThan(res.body.history.requestedFrom);
  });

  it("range 1h -> FULL_WINDOW", async () => {
    const app = createApp();
    const res = await request(app).get("/api/tier-flow/BTC?range=1h").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body.history.status).toBe("FULL_WINDOW");
    expect(res.body.history.coverageSec).toBe(3600);
  });
});
