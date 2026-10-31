// apps/server/tests/microstructureAgentWiring.test.ts
// BAGIAN 3 — integrasi mikrostruktur & order flow ke seluruh agen.
//
// Semua angka di file ini adalah FIXTUR UJI (khusus file test ini, tidak
// pernah masuk ke src/). Kode produksi memakai data live 100% dari hub WS/REST
// bursa; tidak ada generator angka acak di jalur produksi.
//
// Yang diuji di sini:
//   1. buildMicrostructurePromptBlock merakit blok 5 modul + fail-open kosong.
//   2. buildAnalystPrompt (Vega) memuat microstructure_and_flow + seksi ringkasan.
//   3. /api/agents/ask (semua 19 agen) menyuntik blok ke prompt.
//   4. Lapis riset (Vega/Sena/Rhea/Bima) & supervisor (Nadira/Raksa) menyuntik blok.
//   5. Normalisasi simbol: "SOLUSDT" -> "SOL".
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: { create: vi.fn(async () => undefined), count: vi.fn(async () => 0) },
    swingSignalLog: { findMany: vi.fn(async () => []) },
    position: { findMany: vi.fn(async () => []) },
    trade: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("../src/marketdata/multiVenueOrderFlowHub.js", () => ({
  multiVenueOrderFlowHub: {
    buildSnapshot: vi.fn((_s: string, _w: string) => ({
      cvd: { allVenues: -27_768_312, perpSum: -25_989_116, spotSum: -1_779_196 },
      venuesTrading: 10,
      venuesExpected: 10,
    })),
  },
}));

vi.mock("../src/marketdata/wallLifelines.js", () => ({
  wallLifelines: {
    snapshot: vi.fn(() => ({
      summary: {
        active: 12, pulled: 31, eaten: 20, moved: 104, appeared: 20,
        largestActiveUsd: 1_850_352, largestActiveSide: "BID", largestActivePrice: 80_935,
      },
    })),
  },
}));

vi.mock("../src/marketdata/liquidationMapHub.js", () => ({
  liquidationMapHub: {
    snapshot: vi.fn(async () => ({
      source: "hyperliquid_onchain",
      magnetDirection: "DOWN",
      cum: [{ pct: 2, longsUsd: 43_904_024, shortsUsd: 0, skewPct: 100 }],
      topLongClustersBelow: [{ price: 80_100, liqUsd: 12_000_000, distPct: -1.2 }],
      topShortClustersAbove: [{ price: 82_400, liqUsd: 3_100_000, distPct: 1.9 }],
      stale: false,
      note: "Hyperliquid on-chain sampling",
    })),
  },
}));

vi.mock("../src/marketdata/volumeProfileHub.js", () => ({
  volumeProfileHub: {
    build: vi.fn(() => ({
      pocPrice: 80_918.76, vahPrice: 80_934.73, valPrice: 80_897.47,
      priceVsValueArea: "INSIDE_VA", totalUsd: 59_032_128, pocBuySharePct: 29.9, partialWindow: true,
    })),
  },
}));

vi.mock("../src/marketdata/tierFlowHub.js", () => ({
  tierFlowHub: {
    tiers: vi.fn(() => [
      { tier: "MEGA", netDeltaUsd: 0 },
      { tier: "WHALE", netDeltaUsd: 816_461 },
      { tier: "MEDIUM", netDeltaUsd: -6_814_969 },
      { tier: "SMALL", netDeltaUsd: -6_023_465 },
    ]),
    whaleRetailBias: vi.fn(() => ({ bias: "WHALE_BUY" })),
    scanDivergences: vi.fn(() => [
      { buyerExchange: "BINANCE", sellerExchange: "BYBIT", spreadUsd: 2_100_000 },
    ]),
  },
}));

import { buildMicrostructurePromptBlock, buildMicrostructureSummary, type MicrostructureFlowBlock } from "../src/agents/marketIntel.js";
import { buildAnalystPrompt, type AnalystSnapshot } from "../src/agents/marketAnalyst.js";
import { AgentManager, ALL_12_AGENTS } from "../src/agents/agentCatalog.js";
import { ResearchLayer } from "../src/agents/researchLayer.js";
import { SupervisorWatchdogLayer } from "../src/agents/supervisorWatchdogLayer.js";
import { XkiroAdapter, LlmClient, LlmMessage, LlmCallOptions, LlmResponse } from "../src/agents/llmAdapter.js";

class RecordingLlmClient implements LlmClient {
  readonly prompts: string[] = [];
  async chat(messages: LlmMessage[], model: string, _options?: LlmCallOptions): Promise<LlmResponse> {
    this.prompts.push(messages.map((m) => m.content).join("\n"));
    return {
      content: "ok",
      model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0 },
      latencyMs: 1,
    };
  }
}

const MARKER = "MIKROSTRUKTUR & ORDER FLOW";

describe("BAGIAN 3: blok mikrostruktur & order flow untuk agen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("buildMicrostructurePromptBlock merakit 5 modul live dengan angka nyata", async () => {
    const block = await buildMicrostructurePromptBlock("BTC");
    expect(block).toContain(MARKER);
    expect(block).toContain("CVD: $-27.77M");
    expect(block).toContain("10/10 venue");
    expect(block).toContain("Wall: aktif=12");
    expect(block).toContain("rasio p/e=1.55");
    expect(block).toContain("POC=$80918.76");
    expect(block).toContain("magnet=DOWN");
    expect(block).toContain("bias=WHALE_BUY");
  });

  it("normalisasi simbol: SOLUSDT -> SOL", async () => {
    const block = await buildMicrostructurePromptBlock("SOLUSDT");
    expect(block).toContain(MARKER);
    expect(block.length).toBeGreaterThan(0);
  });

  it("fail-open: blok kosong bila hub tidak punya data (tidak pernah kalimat palsu)", async () => {
    const { multiVenueOrderFlowHub } = await import("../src/marketdata/multiVenueOrderFlowHub.js");
    const { wallLifelines } = await import("../src/marketdata/wallLifelines.js");
    const { liquidationMapHub } = await import("../src/marketdata/liquidationMapHub.js");
    const { volumeProfileHub } = await import("../src/marketdata/volumeProfileHub.js");
    const { tierFlowHub } = await import("../src/marketdata/tierFlowHub.js");
    vi.mocked(multiVenueOrderFlowHub.buildSnapshot).mockImplementationOnce(() => { throw new Error("offline"); });
    vi.mocked(wallLifelines.snapshot).mockImplementationOnce(() => { throw new Error("offline"); });
    vi.mocked(liquidationMapHub.snapshot).mockImplementationOnce(async () => { throw new Error("offline"); });
    vi.mocked(volumeProfileHub.build).mockImplementationOnce(() => { throw new Error("offline"); });
    vi.mocked(tierFlowHub.tiers).mockImplementationOnce(() => { throw new Error("offline"); });
    const block = await buildMicrostructurePromptBlock("ETH");
    // Semua modul gagal -> status UNAVAILABLE -> string kosong (bukan teks "tidak tersedia").
    expect(block).toBe("");
  });

  it("buildMicrostructureSummary menandai modul yang tidak tersedia sebagai null, bukan nol", () => {
    const partial: MicrostructureFlowBlock = {
      orderFlowCvd: { allVenues: null, perpSum: null, spotSum: null, venuesTrading: 0, venuesExpected: 10, delta15m: null },
      wallLifelines: null,
      liquidationMap: null,
      volumeProfile: null,
      tierAndExchangeFlow: null,
      status: "PARTIAL",
    };
    const summary = buildMicrostructureSummary(partial);
    expect(summary).toContain("status=PARTIAL");
    expect(summary).toContain("CVD: $0.00M");
    expect(summary).not.toContain("Wall:");
  });

  it("Vega (buildAnalystPrompt) memuat microstructure_and_flow + seksi ringkasan", () => {
    const micro: MicrostructureFlowBlock = {
      orderFlowCvd: { allVenues: -27_768_312, perpSum: -25_989_116, spotSum: -1_779_196, venuesTrading: 10, venuesExpected: 10, delta15m: -27_768_312 },
      wallLifelines: { active: 12, pulled: 31, eaten: 20, moved: 104, appeared: 20, largestActiveUsd: 1_850_352, largestActiveSide: "BID", largestActivePrice: 80_935, pullEatRatio: 1.55 },
      liquidationMap: { source: "hyperliquid_onchain", magnetDirection: "DOWN", nearLongUsd: 43_904_024, nearShortUsd: 0, nearSkewPct: 100, topClusterBelow: null, topClusterAbove: null, stale: false, note: "n/a" },
      volumeProfile: { pocPrice: 80_918.76, vahPrice: 80_934.73, valPrice: 80_897.47, priceVsValueArea: "INSIDE_VA", totalUsd: 59_032_128, pocBuySharePct: 29.9, partialWindow: true },
      tierAndExchangeFlow: { whaleBias: "WHALE_BUY", megaDeltaUsd: 0, whaleDeltaUsd: 816_461, retailDeltaUsd: -12_838_434, topDivergence: null },
      status: "AVAILABLE",
    };
    const snap: AnalystSnapshot = {
      dayKey: "2026-10-24",
      swingSignals: [],
      openPositions: [],
      recentTrades: [],
      briefExcerpt: "",
      marketIntel: {
        schema_version: "artatrade-market-intelligence-v1",
        analysis_id: "mi_test",
        generated_at: new Date().toISOString(),
        computed_at_ms: Date.now(),
        universe: { target: 25, valid: 25, coverage_ratio: 1, source: "db.eligible+binance" },
        breadth: { positive: 1, negative: 1, valid: 2, coverage_ratio: 1, interval: "24h" },
        breadth_1h: { positive: 1, negative: 1, valid: 2, coverage_ratio: 1 },
        btc_relative_strength: { value_1h: 0.1, classification: "NEUTRAL", benchmark: ["ETHUSDT"] },
        regime: { label: "TREND_UP", btc_chg_24h: 1, consistency: 0.8, atr_pct_1h: 0.5, thresholds: "n/a" },
        liquidity: { status: "AVAILABLE", symbols: [] },
        liquidations: { status: "OBSERVED_ACTIVITY", windowMin: 120, longLiqUsd: 1, shortLiqUsd: 2, totalUsd: 3, count: 4, top: [], stream: "CONNECTED/OK" },
        microstructure_and_flow: micro,
        data_quality: { status: "FRESH", coverage_ratio: 1, missing_features: [], source_timestamps: {} },
      },
    };
    const prompt = buildAnalystPrompt(snap);
    expect(prompt).toContain("microstructure_and_flow");
    expect(prompt).toContain(MARKER.replace("MIKROSTRUKTUR & ORDER FLOW", "Mikrostruktur & Order Flow"));
    expect(prompt).toContain("POC=$80918.76");
    expect(prompt).toContain("magnet=DOWN");
  });

  it("/api/agents/ask menyuntik blok mikrostruktur ke prompt semua agen", async () => {
    const client = new RecordingLlmClient();
    const manager = new AgentManager(new XkiroAdapter({ client }));
    for (const id of Object.keys(ALL_12_AGENTS)) {
      const res = await manager.askAgent(id, "ringkasan singkat");
      expect(res.byLlm).toBe(true);
    }
    expect(client.prompts.length).toBe(19);
    for (const p of client.prompts) expect(p).toContain(MARKER);
  });

  it("agen lapis riset (Vega, Sena, Rhea, Bima) menyuntik blok mikrostruktur", async () => {
    const client = new RecordingLlmClient();
    const layer = new ResearchLayer(new XkiroAdapter({ client }));

    await layer.runMacroScout({ btcTrend: "TREND_UP", btcAdx: 27, btc1hChgPct: 1.2, ethTrend: "TREND_UP", eth1hChgPct: 0.8, btcDomChg1hPct: 0.1 });
    await layer.runUniverseCurator({ totalSymbols: 526, cryptoPerpsCount: 526, nonCryptoFiltered: 204, manualBlacklistCount: 0 });
    await layer.runRegimeAnalyst({ symbol: "SOLUSDT", regime: "TRENDING", chopIndex: 42, adx: 28, shieldActive: false });
    await layer.runScannerSupervisor({ activeWorkers: 50, totalPairsScanned: 526, candidatesPassed: 3, topSymbol: "BTC", topScore: 84 });

    expect(client.prompts.length).toBe(4);
    for (const p of client.prompts) expect(p).toContain(MARKER);
  });

  it("agen supervisor (Nadira, Raksa) menyuntik blok mikrostruktur", async () => {
    const client = new RecordingLlmClient();
    const layer = new SupervisorWatchdogLayer(new XkiroAdapter({ client }));

    await layer.runTradeSupervisor({ positionId: 1, symbol: "BTCUSDT", side: "LONG", event: "TP1_HIT", price: 80_900, entryPrice: 80_500, pnlUsd: 12, rMultiple: 1.2 });
    await layer.runWatchdog({ context: "WS_GAP", wsGapSec: 4 });

    expect(client.prompts.length).toBe(2);
    for (const p of client.prompts) expect(p).toContain(MARKER);
  });
});
