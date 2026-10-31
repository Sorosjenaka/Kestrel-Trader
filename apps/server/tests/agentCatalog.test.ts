// apps/server/tests/agentCatalog.test.ts - Uji Katalog 13 Agen Unik & Q&A (Design Bagian 6, FR-32, US-10; 27 Okt 2026 +trade-evaluator).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ALL_12_AGENTS, AgentManager } from "../src/agents/agentCatalog.js";
import { XkiroAdapter, LlmClient, LlmMessage, LlmCallOptions, LlmResponse } from "../src/agents/llmAdapter.js";

class MockCatalogLlmClient implements LlmClient {
  async chat(_messages: LlmMessage[], model: string, _options?: LlmCallOptions): Promise<LlmResponse> {
    return {
      content: "Respons kontekstual agen kustom non-template.",
      model,
      usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80, estimatedCostUsd: 0.00002 },
      latencyMs: 75,
    };
  }
}

describe("FR-32 & US-10: Complete Agents Catalog & Interactive Workspace", () => {
  it("ALL_12_AGENTS memiliki tepat 19 agen unik dengan 12 FAST dan 7 REASON (Design Bagian 6 + pemecahan beban analyst 27 Okt + analisis cepat & arena tesis)", () => {
    const list = Object.values(ALL_12_AGENTS);
    expect(list).toHaveLength(19);

    const fastAgents = list.filter((a) => a.model === "FAST");
    const reasonAgents = list.filter((a) => a.model === "REASON");

    expect(fastAgents).toHaveLength(12);
    expect(reasonAgents).toHaveLength(7);

    // Pastikan tidak ada pasangan warna yang bertabrakan (Design Bagian 6: setiap agen unik)
    const colorPairs = new Set(list.map((a) => `${a.colors[0]}_${a.colors[1]}`));
    expect(colorPairs.size).toBe(19);

    // Pastikan setiap agen memiliki nama, role, personality, style, dan movement
    for (const a of list) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.role.length).toBeGreaterThan(0);
      expect(a.personality.length).toBeGreaterThan(0);
      expect(a.movement.length).toBeGreaterThan(0);
    }
  });

  it("askAgent menjawab pertanyaan operator dengan persona spesifik dan mencatat memori", async () => {
    const mock = new MockCatalogLlmClient();
    const adapter = new XkiroAdapter({ client: mock });
    const manager = new AgentManager(adapter);

    const res = await manager.askAgent("narrator", "Bagaimana performa hari ini?");
    expect(res.agent.name).toBe("Kirana");
    expect(res.answer).toBe("Respons kontekstual agen kustom non-template.");
    expect(res.byLlm).toBe(true);
    expect(res.failureReason).toBeNull();
  });

  it("kegagalan LLM ditandai jelas, bukan jawaban normal buatan", async () => {
    const adapter = new XkiroAdapter({ client: { chat: async () => { throw new Error("LLM_TIMEOUT"); } } });
    const manager = new AgentManager(adapter);
    const res = await manager.askAgent("setup-judge", "Evaluasi audit tanpa order");
    expect(res.byLlm).toBe(false);
    expect(res.failureReason).toContain("LLM_TIMEOUT");
    expect(res.answer).toContain("AGENT_UNAVAILABLE");
  });

  it("respons LLM kosong juga ditandai tidak tersedia", async () => {
    const adapter = new XkiroAdapter({ client: { chat: async () => ({
      content: "   ",
      model: "mock",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      latencyMs: 0,
    }) } });
    const manager = new AgentManager(adapter);
    const res = await manager.askAgent("narrator", "Ringkas audit");
    expect(res.byLlm).toBe(false);
    expect(res.failureReason).toContain("EMPTY_LLM_RESPONSE");
    expect(res.answer).toContain("AGENT_UNAVAILABLE");
  });

  it("API GET /api/agents mengembalikan daftar 19 agen dan status biaya", async () => {
    const app = createApp();
    const res = await request(app).get("/api/agents").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(res.body.agents).toBeDefined();
    expect(res.body.agents).toHaveLength(19);
    expect(res.body.cost).toBeDefined();
    expect(typeof res.body.cost.monthlyBudgetUsd).toBe("number");
  });

  it("API POST /api/agents/ask merespons pertanyaan ke agen terpilih", async () => {
    const app = createApp();
    const res = await request(app).post("/api/agents/ask").set("x-api-token", "vitest-mutation-token")
      .send({ agentId: "setup-judge", question: "Apakah ada setup menarik?" })
      .expect(200);

    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.id).toBe("setup-judge");
    expect(res.body.agent.name).toBe("Arka");
    expect(typeof res.body.answer).toBe("string");
  }, 15000);
});
