// apps/server/tests/supervisorWatchdogLayer.test.ts - Uji Agen Supervisor & Watchdog (FR-26, US-13).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { SupervisorWatchdogLayer, SUPERVISOR_WATCHDOG_AGENTS } from "../src/agents/supervisorWatchdogLayer.js";
import { XkiroAdapter, LlmClient, LlmMessage, LlmCallOptions, LlmResponse } from "../src/agents/llmAdapter.js";

class MockSupervisorLlmClient implements LlmClient {
  async chat(messages: LlmMessage[], model: string, _options?: LlmCallOptions): Promise<LlmResponse> {
    const lastUser = messages.find((m) => m.role === "user")?.content ?? "";
    let content = "Status supervisi.";

    if (lastUser.includes("TP1_HIT")) {
      content = "TP kena. 100 persen posisi ditutup di target tunggal.";
    } else if (lastUser.includes("HOST_SWITCH")) {
      content = "fapi2 lambat tiga percobaan. Sudah pindah host.";
    } else if (lastUser.includes("CIRCUIT_BREAKER")) {
      content = "Circuit breaker terbuka selama 30 detik; host utama tidak stabil.";
    }

    return {
      content,
      model,
      usage: {
        promptTokens: 75,
        completionTokens: 25,
        totalTokens: 100,
        estimatedCostUsd: 0.00003,
      },
      latencyMs: 90,
    };
  }
}

describe("FR-26 & US-13: Supervisor & Watchdog Agents Layer", () => {
  const mockClient = new MockSupervisorLlmClient();
  const adapter = new XkiroAdapter({ client: mockClient });
  const layer = new SupervisorWatchdogLayer(adapter);

  it("SUPERVISOR_WATCHDOG_AGENTS mendefinisikan Trade Supervisor & Watchdog dengan model FAST", () => {
    const keys = Object.keys(SUPERVISOR_WATCHDOG_AGENTS);
    expect(keys).toEqual(["trade-supervisor", "watchdog"]);

    for (const key of keys) {
      const p = SUPERVISOR_WATCHDOG_AGENTS[key];
      expect(p.model).toBe("FAST");
      expect(p.colors).toHaveLength(2);
      expect(p.style.length).toBeGreaterThan(10);
    }
  });

  it("trade-supervisor (Nadira) merespons transisi TP hit (single target 100%)", async () => {
    const res = await layer.runTradeSupervisor({
      positionId: 10,
      symbol: "BTCUSDT",
      side: "LONG",
      event: "TP1_HIT",
      price: 60600,
      entryPrice: 60000,
    });

    expect(res.action).toBe("TP1_HIT");
    expect(res.dialog.agentId).toBe("trade-supervisor");
    expect(res.dialog.name).toBe("Nadira");
    expect(res.dialog.text).toContain("TP kena");
  });

  it("watchdog (Raksa) mendeteksi failover host dan menaikkan status WARN", async () => {
    const res = await layer.runWatchdog({
      context: "HOST_SWITCH",
      previousHost: "fapi2.binance.com",
      activeHost: "fapi3.binance.com",
      failsCount: 3,
    });

    expect(res.alertLevel).toBe("WARN");
    expect(res.dialog.agentId).toBe("watchdog");
    expect(res.dialog.name).toBe("Raksa");
    expect(res.dialog.text).toContain("Sudah pindah host");
  });

  it("watchdog (Raksa) menandai status CRITICAL saat circuit breaker terbuka atau >= 5 gagal", async () => {
    const res = await layer.runWatchdog({
      context: "CIRCUIT_BREAKER",
      failsCount: 5,
    });

    expect(res.alertLevel).toBe("CRITICAL");
    expect(res.dialog.text).toContain("Circuit breaker terbuka");
  });

  it("API /api/agents/supervisor/evaluate dan /api/agents/feed mengembalikan 8 agen terintegrasi", async () => {
    const app = createApp();

    const evalRes = await request(app).post("/api/agents/supervisor/evaluate").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "BTCUSDT",
        event: "TP1_HIT",
        context: "HOST_SWITCH",
      })
      .expect(200);

    expect(evalRes.body.evaluations).toBeDefined();
    expect(evalRes.body.evaluations.supervisor).toBeDefined();
    expect(evalRes.body.evaluations.watchdog).toBeDefined();

    const feedRes = await request(app).get("/api/agents/feed").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(feedRes.body.agents).toBeDefined();
    expect(feedRes.body.agents.length).toBeGreaterThanOrEqual(8);
  }, 90000);
});
