// apps/server/tests/drexVisionSwing.test.ts - Drex vision di jalur SWING
// (24 Okt 2026): apakah `images` benar-benar dikirim ke Drex lewat
// runSwingDrexJudge, dan TIDAK dikirim saat flag OFF.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: vi.fn() } } }));
import { env } from "../src/core/env.js";
import { DecisionRiskLayer, type SwingDrexJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
import { drexChartCache } from "../src/agents/drexChart.js";

const FAKE_KEY = "test-drex-key-not-real";

const baseInput: SwingDrexJudgeInput = {
  symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01", strategyName: "Orion",
  compositeScore: 74, zoneScore: 71, triggerScore: 66,
  entryPrice: 3200, slPrice: 3150, tp1Price: 3300,
};

const drexBody = JSON.stringify({
  model: "drex-max",
  answers: {
    entry_go: { type: "noul", noul: 0.9 },
    direction: { type: "choice", choice: "LONG", confidence: 0.8 },
    setup_strength: { type: "score", score: 3.2, confidence: 0.7 },
  },
  request_id: "req_swing_vision",
});

function bars(n: number) {
  const out = [];
  let p = 3200;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = open + (i % 3 === 0 ? 2 : -1.2);
    out.push({ openTime: 1_760_000_000_000 + i * 3_600_000, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 50 });
    p = close;
  }
  return out;
}

function buildLayer() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(drexBody, { status: 200, headers: { "content-type": "application/json" } });
  });
  const drex = new DrexAdapter({ fetchImpl, sleep: async () => undefined });
  const agent = new DecisionRiskLayer({ callReason: vi.fn() } as unknown as XkiroAdapter, drex);
  return { agent, calls };
}

beforeEach(() => {
  env.DREX_ENABLED = true;
  env.DREX_SWING_ENABLED = true;
  env.DREX_API_KEY = FAKE_KEY;
  env.DREX_MODEL = "drex-max";
  env.DREX_MIN_ENTRY_PROBABILITY = 0.55;
  env.DREX_MIN_SETUP_STRENGTH = 2;
  env.DREX_TIMEOUT_MS = 500;
  env.DREX_VISION_ENABLED = false;
  env.DREX_VISION_MAX_BARS = 120;
  env.DREX_VISION_TIMEFRAME = "1h";
  drexChartCache.reset();
});

describe("runSwingDrexJudge — Drex vision", () => {
  it("flag OFF (default) -> request body TIDAK punya images", async () => {
    const { agent, calls } = buildLayer();
    const v = await agent.runSwingDrexJudge({ ...baseInput, chartBars: bars(60) });
    expect(v.kind).toBe("go");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toBeUndefined();
  });

  it("flag ON -> request body punya images berisi PNG base64", async () => {
    env.DREX_VISION_ENABLED = true;
    const { agent, calls } = buildLayer();
    const v = await agent.runSwingDrexJudge({ ...baseInput, chartBars: bars(60) });
    expect(v.kind).toBe("go");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images).toHaveLength(1);
    const decoded = Buffer.from(body.images[0], "base64");
    expect(decoded.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("flag ON tapi chartBars kosong -> tetap request, TANPA images (fail-open)", async () => {
    env.DREX_VISION_ENABLED = true;
    const { agent, calls } = buildLayer();
    const v = await agent.runSwingDrexJudge({ ...baseInput });
    expect(v.kind).toBe("go");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toBeUndefined();
  });
});
