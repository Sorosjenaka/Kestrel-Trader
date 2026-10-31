// 26 Okt 2026 — REPLAY: bukti rantai DREX_SWING_SHADOW benar-benar dieksekusi
// untuk kandidat YANG SAMA dengan verdict v1 (permintaan operator: "Replay boleh
// dipakai terpisah dan diberi label REPLAY"). Shadow TIDAK mengikat: verdict
// produksi tetap v1; v2 hanya dicatat ke EventLog DREX_SWING_SHADOW_COMPARE.
//
// Konteks: sejak build shadow di-deploy (26 Okt 12:59/13:07 CST) belum ada
// kandidat SWING yang mencapai judge pada runtime, sehingga event produksi = 0.
// Test ini memutar ulang satu kandidat untuk membuktikan jalurnya hidup.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as Array<{ type: string; severity: string; payload: string }>,
}));

vi.mock("../src/core/db.js", () => ({
  db: { eventLog: { create: vi.fn(async (args: { data: { type: string; severity: string; payload: string } }) => {
    mocks.events.push(args.data); return { id: 1 };
  }) } },
}));
vi.mock("../src/agents/marketIntel.js", () => ({
  buildMicrostructureBlock: vi.fn(async (symbol: string) => ({
    orderFlowCvd: null, wallLifelines: null, liquidationMap: null,
    largeTradesVp: null, tierFlow: null,
    note: `REPLAY stub micro (${symbol})`,
  })),
}));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({
  binanceFuturesClient: { getHubChg24: vi.fn(() => ({ BTCUSDT: -1.2 })) },
}));

// TAHAP 6B: shadow v2 kini WAJIB punya snapshot evidence pra-keputusan.
// Test lama ini (TAHAP 5) tetap menguji invarian yang sama — verdict v1 tidak
// berubah oleh shadow — tetapi memakai snapshot minimal supaya sesuai kontrak
// baru. Snapshot panel lengkap diuji di drexV2PanelReplay.test.ts.
vi.mock("../src/analysis/drexPanelEvidence.js", () => ({
  renderDrexPanelBrief: vi.fn(() => ({
    brief: "EVIDENCE LIMA PANEL (REPLAY stub)\n## orderflow [fresh] evidenceId=ev_orderflow_stub",
    freshness: { status: "fresh", stalePanels: [], maxAgeMs: 100, usable: true },
  })),
}));

import { env } from "../src/core/env.js";
import { DecisionRiskLayer, type SwingDrexJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const input: SwingDrexJudgeInput = {
  symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01", strategyName: "Orion",
  compositeScore: 74, zoneScore: 71, triggerScore: 66,
  entryPrice: 3200, slPrice: 3150, tp1Price: 3300, tp2Price: 3500,
};

/** Snapshot pra-keputusan minimal (TAHAP 6B). */
const panelSnapshot = {
  schemaVersion: "artatrade-drex-panel-evidence-v1",
  featureVersion: "panel-ai-v1",
  correlationId: "ETHUSDT:LONG:RSW-01:3200",
  candidateId: "ETHUSDT:LONG:RSW-01",
  planId: "RSW-01:ETHUSDT:3200:3150:3300",
  strategyId: "RSW-01",
  symbol: "ETHUSDT",
  evidenceSymbol: "ETH",
  side: "LONG" as const,
  venue: "BINANCE_PERP",
  marketType: "PERPETUAL",
  horizon: "H1/H4",
  capturedAtMs: Date.now(),
  panels: [],
  crossConflict: [],
  stalePanels: [],
  unavailablePanels: [],
  coverage: { total: 5, fresh: 5, stale: 0, partial: 0, unavailable: 0, unknown: 0 },
  inputHash: "0123456789abcdef",
};

function drexBody(p: number, dir: string, score = 3.2): string {
  return JSON.stringify({
    model: "drex-max",
    answers: {
      entry_go: { type: "noul", noul: p },
      direction: { type: "choice", choice: dir, confidence: 0.7, probabilities: { LONG: 0.7, SHORT: 0.3 } },
      setup_strength: { type: "score", score, confidence: 0.6, legend: ["very_weak", "weak", "moderate", "strong", "very_strong"], probabilities: {} },
    },
    evaluation_time_ms: 40,
    request_id: "req_replay_shadow_1",
  });
}

function buildLayer(handler: () => Response) {
  const fetchImpl = vi.fn(async () => handler());
  const drex = new DrexAdapter({ fetchImpl, sleep: async () => undefined });
  const agent = new DecisionRiskLayer({ callReason: vi.fn() } as unknown as XkiroAdapter, drex);
  return { agent, fetchImpl };
}

const resp = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

// Shadow fire-and-forget: tunggu event-nya muncul sebelum assert.
const waitForShadow = async () => {
  await vi.waitFor(() => {
    expect(mocks.events.some((e) => e.type === "DREX_SWING_SHADOW_COMPARE")).toBe(true);
  }, { timeout: 2000 });
};

beforeEach(() => {
  mocks.events.length = 0;
  env.DREX_ENABLED = true;
  env.DREX_SWING_ENABLED = true;
  env.DREX_SWING_SHADOW = true;
  env.DREX_API_KEY = "test-drex-key-not-real";
  env.DREX_MIN_ENTRY_PROBABILITY = 0.55;
  env.DREX_MIN_SETUP_STRENGTH = 2;
  env.DREX_TIMEOUT_MS = 500;
});

describe("REPLAY: DREX_SWING_SHADOW pada kandidat yang sama dengan verdict v1", () => {
  it("v1 GO -> shadow v2 dicatat dengan inputHash/model/latency; verdict produksi tetap v1", async () => {
    const { agent, fetchImpl } = buildLayer(() => resp(drexBody(0.8, "LONG")));
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot });
    expect(verdict.kind).toBe("go"); // keputusan produksi = v1
    await waitForShadow();
    // Dua evaluasi dipanggil: v1 (state lama) + v2 shadow (state v2).
    expect(fetchImpl.mock.calls.length).toBe(2);
    const shadow = mocks.events.find((e) => e.type === "DREX_SWING_SHADOW_COMPARE");
    expect(shadow).toBeDefined();
    const p = JSON.parse(shadow!.payload);
    expect(p.symbol).toBe("ETHUSDT");
    expect(p.v1Kind).toBe("go");
    expect(p.v1.kind).toBe("go");
    expect(p.shadow.schemaVersion).toBe("artatrade-swing-state-v2");
    expect(p.shadow.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p.shadow.model).toBeTruthy();
    expect(typeof p.shadow.latencyMs).toBe("number");
    expect(p.shadow.v2.kind).toBe("go"); // prob 0.8, arah LONG, strength 3.2
    expect(p.generatedAt).toBeTruthy();
  });

  it("v1 REJECT tetap dicatat ke shadow (termasuk kandidat ditolak)", async () => {
    const { agent } = buildLayer(() => resp(drexBody(0.2, "SHORT")));
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot });
    expect(verdict.kind).toBe("reject");
    await waitForShadow();
    const shadow = mocks.events.find((e) => e.type === "DREX_SWING_SHADOW_COMPARE");
    expect(shadow).toBeDefined();
    const p = JSON.parse(shadow!.payload);
    expect(p.v1Kind).toBe("reject");
    expect(p.shadow.v2.kind).toBe("reject");
  });

  it("shadow TIDAK PERNAH mengubah verdict v1 (go v2 saat v1 reject tetap reject produksi)", async () => {
    // v1 menjawab jelek tapi v2 menerima -> produksi tetap mengikuti v1.
    let call = 0;
    const bodies = [drexBody(0.1, "SHORT", 0.5), drexBody(0.9, "LONG", 3.5)];
    const { agent } = buildLayer(() => resp(bodies[call++] ?? bodies[0]!));
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot });
    expect(verdict.kind).toBe("reject"); // v1 = reject (prob 0.1)
    await waitForShadow();
    const p = JSON.parse(mocks.events.find((e) => e.type === "DREX_SWING_SHADOW_COMPARE")!.payload);
    expect(p.shadow.v2.kind).toBe("go"); // v2 berbeda -> hanya dicatat
  });
});
