// apps/server/tests/health.test.ts - happy-path FR-35 + NFR-04 (Rules Bagian 5).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { env } from "../src/core/env.js";

const app = createApp();

describe("GET /api/health", () => {
  it("status ok, mode TERMINAL, ARM OTOMATIS ON (perintah operator: bot berjalan = bersenjata)", async () => {
    const r = await request(app).get("/api/health").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.mode).toBe("TERMINAL");
    expect(r.body.arm).toBe(true);
    expect(typeof r.body.version).toBe("string");
    expect(typeof r.body.clock.utc).toBe("string");
  });

  it("key hanya disajikan sebagai SET/MISSING (FR-35)", async () => {
    const r = await request(app).get("/api/health").set("x-api-token", "vitest-mutation-token").expect(200);
expect(Object.keys(r.body.keys).sort()).toEqual(["binance", "drex", "llm", "llmProvider", "vike", "xkiro"]);
    expect(["SET", "MISSING"]).toContain(r.body.keys.binance);
    expect(["SET", "MISSING"]).toContain(r.body.keys.xkiro);
    expect(["SET", "MISSING"]).toContain(r.body.keys.llm);
    expect(["SET", "MISSING"]).toContain(r.body.keys.drex);
    expect(["SET", "MISSING"]).toContain(r.body.keys.vike);
    expect(r.body.keys.llmProvider).toBe("XKIRO");
  });

  it("nilai key tidak pernah bocor ke respons (NFR-08)", async () => {
    const r = await request(app).get("/api/health").set("x-api-token", "vitest-mutation-token").expect(200);
    const body = JSON.stringify(r.body);
    for (const secret of [env.XKIRO_API_KEY, env.BINANCE_API_KEY, env.BINANCE_API_SECRET, env.DREX_API_KEY, env.VIKE_API_KEY]) {
      if (secret && secret.length > 8) expect(body).not.toContain(secret);
    }
    expect(body.toLowerCase()).not.toContain("api_key");
    expect(body.toLowerCase()).not.toContain("apisecret");
  });
});
