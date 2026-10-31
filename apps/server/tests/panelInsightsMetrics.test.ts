// 26 Okt 2026 (TAHAP 6B) — metrik panel AI: baris tersimpan memuat token AKTUAL,
// queueWaitMs (antrean), providerMs (durasi provider), attempts, finishReason,
// dan evidenceAgeMs (umur data SUMBER — dipisahkan dari waktu pembuatan
// analisis); panggilan LLM memakai queuePriority "low" (narasi) + fairnessKey
// per simbol; budget panel ditegakkan SEBELUM request dikirim.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  callReason: vi.fn(async (_p: string, _s: string, _o?: unknown) => ({
    content: "analisis uji", model: "xiaomi/mimo-v2.6-pro", latencyMs: 5, reasoningEffortRequested: "none",
    queueWaitMs: 7, providerMs: 5, attempts: 1, finishReason: "stop", httpStatus: 200,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0 },
  })),
}));

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: {
      create: vi.fn(async ({ data }: { data: { payload: string } }) => {
        mocks.rows.push(JSON.parse(data.payload)); return { id: mocks.rows.length };
      }),
      count: vi.fn(async () => mocks.rows.length),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => mocks.rows.map((r) => ({ payload: JSON.stringify(r) }))),
      deleteMany: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../src/agents/llmAdapter.js", () => ({ defaultLlmAdapter: { callReason: mocks.callReason } }));
vi.mock("../src/marketdata/multiVenueOrderFlowHub.js", () => ({
  multiVenueOrderFlowHub: {
    buildSnapshot: vi.fn(() => ({
      generatedAt: Date.now() - 2000, venuesTrading: 2, venuesExpected: 2,
      teamRead: [
        { timeframe: "15M", priceChangePct: 0.1, allVenueCvdDelta: 1, spotCvd: 0, perpCvd: 1, buySharePct: 50, flowVsPrice: "x" },
        { timeframe: "1H", priceChangePct: 0.2, allVenueCvdDelta: 2, spotCvd: 1, perpCvd: 1, buySharePct: 51, flowVsPrice: "x" },
      ],
      cvd: { allVenues: 1, perpSum: 1, spotSum: 0, perVenue: [{ venue: "BINANCE", delta: 1, buyUsd: 1, sellUsd: 0 }] },
    })),
    // TAHAP 6B: waktu evidence SUMBER (trade terakhir), bukan generatedAt.
    lastTradeAtMs: vi.fn(() => Date.now() - 1500),
    // TAHAP 6B: waktu DITERIMA (terpisah dari waktu event bursa).
    lastTradeReceivedAtMs: vi.fn(() => Date.now() - 1400),
  },
}));
vi.mock("../src/marketdata/wallLifelines.js", () => ({
  wallLifelines: {
    snapshot: vi.fn(() => ({
      venue: "BINANCE_PERP", updatedAt: Date.now() - 3000, mid: 100,
      summary: { active: 1, pulled: 0, eaten: 0, moved: 0, appeared: 1 },
      depth: [{ isWall: true, side: "BID", price: 99, notionalUsd: 1000, state: "ACTIVE" }],
      events: [], trend: null,
    })),
    lastBookAtMs: vi.fn(() => Date.now() - 2500),
    lastBookReceivedAtMs: vi.fn(() => Date.now() - 2400),
    oldestLiveWallAtMs: vi.fn(() => Date.now() - 60_000),
  },
}));
vi.mock("../src/marketdata/liquidationMapHub.js", () => ({
  liquidationMapHub: {
    snapshot: vi.fn(async () => ({
      source: "hyperliquid_onchain", updatedAt: Date.now() - 5000, sourceTsMs: Date.now() - 5000,
      sourceReceivedAtMs: Date.now() - 4900,
      bins: [{ longUsd: 1, shortUsd: 0 }], markPrice: 100, magnetDirection: "NONE",
      stale: false, note: null, topLongClustersBelow: [], topShortClustersAbove: [],
    })),
  },
}));
vi.mock("../src/marketdata/volumeProfileHub.js", () => ({
  TIER_FLOORS: [{ tier: "MEDIUM", floor: 10000 }],
  volumeProfileHub: {
    build: vi.fn(() => ({
      pocPrice: 100, vahPrice: 101, valPrice: 99, priceVsValueArea: "IN",
      totalUsd: 1000, pocBuySharePct: 50, partialWindow: false, updatedAt: Date.now() - 4000,
    })),
    largeTrades: vi.fn(() => []),
    lastTradeAtMs: vi.fn(() => Date.now() - 1800),
    lastTradeReceivedAtMs: vi.fn(() => Date.now() - 1700),
  },
}));
vi.mock("../src/marketdata/tierFlowHub.js", () => ({
  tierFlowHub: {
    tiers: vi.fn(() => [{ tier: "WHALE", netDeltaUsd: 5, buySharePct: 55, trades: 3 }]),
    whaleRetailBias: vi.fn(() => ({ bias: "NEUTRAL" })),
    perExchangeDelta: vi.fn(() => []),
    scanDivergences: vi.fn(() => []),
    startedAtMs: Date.now() - 60_000,
  },
}));

import { maybeTriggerPanelAnalysis, panelAiStats, readPanelAiLatest } from "../src/analysis/panelInsights.js";

beforeEach(() => { mocks.rows.length = 0; mocks.callReason.mockClear(); });

describe("TAHAP 6B: metrik panel AI terpisah + antrean low + fairness", () => {
  it("baris memuat tokens/queueWaitMs/providerMs/attempts/finishReason/evidenceAgeMs", async () => {
    maybeTriggerPanelAnalysis("ETH", { force: true });
    await vi.waitFor(() => {
      expect(mocks.rows.filter((r) => r.symbol === "ETH").length).toBeGreaterThanOrEqual(6);
    }, { timeout: 3000 });

    const success = mocks.rows.filter((r) => r.status === "LLM_SUCCESS");
    expect(success.length).toBeGreaterThanOrEqual(1);
    for (const r of success) {
      expect(r.tokens).toBe(15); // dari res.usage provider, bukan estimasi
      expect(r.promptTokens).toBe(10);
      expect(r.completionTokens).toBe(5);
      expect(typeof r.queueWaitMs).toBe("number");
      expect(typeof r.providerMs).toBe("number");
      expect(r.attempts).toBe(1);
      expect(r.finishReason).toBe("stop");
      expect(typeof r.evidenceAgeMs).toBe("number");
      expect(r.generatedAt).toBeTruthy();
    }
    // Narasi panel mengalah bila ada antrean supervisi, dan kunci adil per simbol.
    for (const call of mocks.callReason.mock.calls) {
      const opts = call[2] as { queuePriority?: string; fairnessKey?: string };
      expect(opts.queuePriority).toBe("low");
      expect(opts.fairnessKey).toBe("panel:ETH");
    }
    expect(panelAiStats.runs).toBeGreaterThanOrEqual(1);

    const read = await readPanelAiLatest("ETH");
    expect(read.panels.orderflow?.tokens).toBe(15);
  });
});
