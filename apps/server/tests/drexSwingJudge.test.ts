// apps/server/tests/drexSwingJudge.test.ts - Drex lane SWING (23 Okt 2026):
// verdict go/reject/skip, fail-open saat Drex tak tersedia, state SWING fail-closed.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: vi.fn() } } }));
import { env } from "../src/core/env.js";
import { DecisionRiskLayer, type SwingDrexJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
import { buildDrexSwingState } from "../src/agents/drexState.js";

const FAKE_KEY = "test-drex-key-not-real";

const input: SwingDrexJudgeInput = {
  symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01", strategyName: "Orion",
  compositeScore: 74, zoneScore: 71, triggerScore: 66,
  entryPrice: 3200, slPrice: 3150, tp1Price: 3300,
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
    request_id: "req_swing_1",
  });
}

function buildLayer(drexResponse?: () => Promise<Response>) {
  const fetchImpl = vi.fn(async () => {
    if (!drexResponse) throw new Error("no drex handler");
    return drexResponse();
  });
  const drex = new DrexAdapter({ fetchImpl, sleep: async () => undefined });
  const agent = new DecisionRiskLayer({ callReason: vi.fn() } as unknown as XkiroAdapter, drex);
  return { agent, fetchImpl };
}

const resp = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  env.DREX_ENABLED = true;
  env.DREX_SWING_ENABLED = true;
  env.DREX_API_KEY = FAKE_KEY;
  env.DREX_MIN_ENTRY_PROBABILITY = 0.55;
  env.DREX_MIN_SETUP_STRENGTH = 2;
  env.DREX_TIMEOUT_MS = 500;
});

describe("buildDrexSwingState", () => {
  it("fail-closed bila field inti hilang", () => {
    const bad = buildDrexSwingState({ ...input, compositeScore: Number.NaN });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("compositeScore");
  });

  it("state SWING lengkap tanpa fabrikasi knnProb", () => {
    const ok = buildDrexSwingState(input);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const s = ok.state;
    expect(s.schemaVersion).toBe("artatrade-swing-state-v1");
    expect(s.mode).toBe("SWING");
    expect((s.session as Record<string, unknown>).lane).toBe("SWING");
    expect((s.strategy as Record<string, unknown>).id).toBe("RSW-01");
    // knnProb tidak dihitung lane SWING — tidak boleh muncul di state
    expect(JSON.stringify(s)).not.toContain("knn");
  });
});

describe("runSwingDrexJudge", () => {
  it("skip saat flag SWING mati", async () => {
    env.DREX_SWING_ENABLED = false;
    const { agent } = buildLayer(async () => resp(200, drexBody(0.9, "LONG")));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("skip");
    if (v.kind === "skip") expect(v.reason).toBe("DREX_SWING_DISABLED");
  });

  it("GO bila probabilitas, arah, dan conviction lolos", async () => {
    const { agent } = buildLayer(async () => resp(200, drexBody(0.9, "LONG", 3.2)));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("go");
    if (v.kind === "go") {
      expect(v.p).toBeCloseTo(0.9);
      expect(v.direction).toBe("LONG");
      expect(v.data.model).toBe("drex-max");
    }
  });

  it("reject bila arah tidak cocok", async () => {
    const { agent } = buildLayer(async () => resp(200, drexBody(0.9, "SHORT", 3.2)));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reason).toContain("DIRECTION_SHORT!=LONG");
  });

  it("reject bila conviction di bawah ambang", async () => {
    const { agent } = buildLayer(async () => resp(200, drexBody(0.9, "LONG", 1.1)));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reason).toContain("SETUP_STRENGTH");
  });

  it("reject bila probabilitas di bawah ambang", async () => {
    const { agent } = buildLayer(async () => resp(200, drexBody(0.3, "LONG", 3.2)));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("reject");
    if (v.kind === "reject") expect(v.reason).toContain("ENTRY_PROB");
  });

  it("fail-open (skip) saat Drex error — entry tidak dibekukan", async () => {
    const { agent } = buildLayer(async () => resp(500, "upstream"));
    const v = await agent.runSwingDrexJudge(input);
    expect(v.kind).toBe("skip");
    if (v.kind === "skip") expect(v.reason).toBe("DREX_UNAVAILABLE");
  });
});