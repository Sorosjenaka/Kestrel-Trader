// apps/server/tests/researchLayer.test.ts - Uji Agen Lapis Riset & Scanner (FR-26, US-05, US-10).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { ResearchLayer, RESEARCH_AGENTS } from "../src/agents/researchLayer.js";
import { XkiroAdapter, LlmClient, LlmMessage, LlmCallOptions, LlmResponse, defaultLlmAdapter } from "../src/agents/llmAdapter.js";
import { evaluateAltMatrix } from "../src/engines/macroGate.js";

class MockAgentLlmClient implements LlmClient {
  public lastPrompt = "";

  async chat(messages: LlmMessage[], model: string, _options?: LlmCallOptions): Promise<LlmResponse> {
    this.lastPrompt = messages.map((m) => m.content).join("\n");
    const lastUser = messages.find((m) => m.role === "user")?.content ?? "";

    let content = "Analisa agen standar.";
    if (lastUser.startsWith("Scan:")) {
      content = "50 pemindai jalan; 3 kandidat lolos, ranking siap.";
    } else if (lastUser.includes("Data makro")) {
      content = "BTC 1 jam: TRENDING naik, ADX 28. Alt long aman terkendali.";
    } else if (lastUser.includes("Universe")) {
      content = "Dua simbol baru masuk; nol non-crypto lolos. Audit bersih.";
    } else if (lastUser.includes("regime") || lastUser.includes("Simbol")) {
      content = "Pasar sedang mendung tipis; chop naik, hati-hati.";
    }

    return {
      content,
      model,
      usage: {
        promptTokens: 80,
        completionTokens: 25,
        totalTokens: 105,
        estimatedCostUsd: 0.00003,
      },
      latencyMs: 95,
    };
  }
}

describe("FR-26, US-05, US-10: Research & Scanner Agents Layer", () => {
  const mockClient = new MockAgentLlmClient();
  const adapter = new XkiroAdapter({ client: mockClient });
  const layer = new ResearchLayer(adapter);

  it("RESEARCH_AGENTS mendefinisikan 4 profil agen unik dengan fashion & model FAST", () => {
    const keys = Object.keys(RESEARCH_AGENTS);
    expect(keys).toEqual(["macro-scout", "universe-curator", "regime-analyst", "scanner-supervisor"]);

    for (const key of keys) {
      const p = RESEARCH_AGENTS[key];
      expect(p.id).toBe(key);
      expect(p.model).toBe("FAST");
      expect(p.colors).toHaveLength(2);
      expect(p.personality.length).toBeGreaterThan(5);
    }
  });

  it("macro-scout (Vega) mengevaluasi kondisi makro dan memblokir saat dominasi BTC melonjak", async () => {
    const safeRes = await layer.runMacroScout({
      btcTrend: "TRENDING_UP",
      btcAdx: 28,
      btc1hChgPct: 0.8,
      ethTrend: "TRENDING_UP",
      eth1hChgPct: 0.6,
      btcDomChg1hPct: 0.1,
    });

    expect(safeRes.allowed).toBe(true);
    expect(safeRes.dialog.agentId).toBe("macro-scout");
    expect(safeRes.dialog.name).toBe("Vega");
    expect(safeRes.dialog.text).toContain("aman terkendali");
    expect(safeRes.dialog.context?.byLlm).toBe(true);

    // Blokir saat BTCDOM naik > 0.5% (FR-06)
    const blockedRes = await layer.runMacroScout({
      btcTrend: "TRENDING_UP",
      btcAdx: 28,
      btc1hChgPct: 0.8,
      ethTrend: "TRENDING_UP",
      eth1hChgPct: 0.6,
      btcDomChg1hPct: 0.75, // lonjakan dominasi
    });

    expect(blockedRes.allowed).toBe(false);
  });

  it("Vega mengamati matriks enam kondisi sebelum Arka tanpa mengubah hasil kode", async () => {
    const matrix = evaluateAltMatrix(-0.3, 1.1, -0.5);
    const result = await layer.observeAltMatrix({ symbol: "SOONUSDT", side: "LONG",
      btcTrend: "TRENDING BULLISH", btcAdx: 28, btc1hChgPct: 1.1,
      eth1hChgPct: -0.5, btcDomChg1hPct: -0.3, matrix,
      macroAllowed: true, macroDetail: "MATRIX_R4_PUMP" });
    expect(result.dialog.agentId).toBe("macro-scout");
    expect(result.dialog.context).toMatchObject({ matrixRow: 4, altBias: "PUMP", ethConfirmed: false, macroAllowed: true });
    expect(mockClient.lastPrompt).toContain("BTC.D turun + BTC naik = PUMP");
    expect(mockClient.lastPrompt).toContain("Hasil kode baris 4: PUMP");
  });

  it("universe-curator (Sena) menyajikan checklist audit universe crypto-only", async () => {
    const res = await layer.runUniverseCurator({
      totalSymbols: 526,
      cryptoPerpsCount: 526,
      nonCryptoFiltered: 204,
      manualBlacklistCount: 0,
    });

    expect(res.audited).toBe(true);
    expect(res.dialog.agentId).toBe("universe-curator");
    expect(res.dialog.name).toBe("Sena");
    expect(res.dialog.text).toContain("Audit bersih");
  });

  it("regime-analyst (Rhea) menyampaikan metafora cuaca pasar", async () => {
    const res = await layer.runRegimeAnalyst({
      symbol: "SOLUSDT",
      regime: "RANGING",
      chopIndex: 61.2,
      adx: 16.5,
      shieldActive: false,
    });

    expect(res.regime).toBe("RANGING");
    expect(res.dialog.agentId).toBe("regime-analyst");
    expect(res.dialog.name).toBe("Rhea");
    expect(res.dialog.text).toContain("mendung");
    expect(res.dialog.context?.byLlm).toBe(true);
  });

  it("scanner-supervisor (Bima) memimpin koordinasi 50 worker scanner pool", async () => {
    const res = await layer.runScannerSupervisor({
      activeWorkers: 50,
      totalPairsScanned: 526,
      candidatesPassed: 3,
      topSymbol: "BTCUSDT",
      topScore: 88,
    });

    expect(res.ready).toBe(true);
    expect(res.dialog.agentId).toBe("scanner-supervisor");
    expect(res.dialog.name).toBe("Bima");
    expect(res.dialog.text).toContain("50 pemindai jalan");
  });

  it("API /api/agents/feed dan /api/agents/research/evaluate merespons feed dialog", async () => {
    const app = createApp();
    // Endpoint integration tests must not spend real provider quota or inherit
    // network latency; LLM request/response behavior is tested in llmAdapter.test.
    const llmSpy = vi.spyOn(defaultLlmAdapter, "callFast").mockResolvedValue({
      content: "Analisis riset teruji dengan bukti konteks.",
      model: "xiaomi/mimo-v2.6-flash",
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11, estimatedCostUsd: 0 },
      latencyMs: 0,
    });
    try {
      const evalRes = await request(app).post("/api/agents/research/evaluate").set("x-api-token", "vitest-mutation-token")
        .send({ symbol: "ETHUSDT" })
        .expect(200);

      expect(evalRes.body.evaluations).toBeDefined();
      expect(evalRes.body.evaluations.macro).toBeDefined();
      expect(evalRes.body.evaluations.macro.dialog).toBeDefined();
      expect(evalRes.body.evaluations.macro.dialog.agentId).toBe("macro-scout");
      expect(evalRes.body.evaluations.universe).toBeDefined();
      expect(evalRes.body.evaluations.regime).toBeDefined();
      expect(evalRes.body.evaluations.scanner).toBeDefined();
      // Verify route contract and context, not model wording.
      expect(evalRes.body.evaluations.scanner.dialog.agentId).toBe("scanner-supervisor");
      expect(typeof evalRes.body.evaluations.scanner.dialog.text).toBe("string");
      expect(evalRes.body.evaluations.scanner.dialog.text.length).toBeGreaterThan(10);
      expect(evalRes.body.evaluations.scanner.dialog.context.candidatesPassed).toBe(3);
      expect(evalRes.body.evaluations.scanner.dialog.context.topSymbol).toBe("ETHUSDT");

      const feedRes = await request(app).get("/api/agents/feed?limit=5").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(feedRes.body.messages).toBeDefined();
      expect(Array.isArray(feedRes.body.messages)).toBe(true);
      expect(Array.isArray(feedRes.body.agents)).toBe(true);
      expect(feedRes.body.agents.length).toBeGreaterThanOrEqual(4);
    } finally {
      llmSpy.mockRestore();
    }
  }, 90000);
  it("fallback offline riset tetap merespons saat LLM gagal (berlabel jelas)", async () => {
    const offlineAdapter = new XkiroAdapter({
      client: {
        async chat() { throw new Error("LLM_SIMULATED_DOWN"); },
      },
    });
    const offlineLayer = new ResearchLayer(offlineAdapter);

    const macro = await offlineLayer.runMacroScout({
      btcTrend: "UP", btcAdx: 28, btc1hChgPct: 0.5,
      ethTrend: "UP", eth1hChgPct: 0.4, btcDomChg1hPct: 0.1,
    });
    expect(macro.allowed).toBe(true);
    expect(macro.dialog.text).toContain("Riset offline");
    expect(macro.dialog.text).toContain("LLM tidak tersedia");
    expect(macro.dialog.context?.byLlm).toBe(false);

    const scanner = await offlineLayer.runScannerSupervisor({
      activeWorkers: 50, totalPairsScanned: 526,
      candidatesPassed: 3, topSymbol: "BTCUSDT", topScore: 88,
    });
    expect(scanner.ready).toBe(true);
    expect(scanner.dialog.text).toContain("kandidat lolos");
    expect(scanner.dialog.context?.byLlm).toBe(false);
  });
});
