import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({
  db: {
    directionBattle: { create: vi.fn(async ({ data }) => ({ id: 1, ...data })) },
    eventLog: { create: vi.fn(async () => undefined) },
  },
}));

import { runDirectionBattle, type DirectionBattleInput } from "../src/agents/directionalBattleArena.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const microstructure = {
  status: "AVAILABLE" as const,
  orderFlowCvd: null,
  wallLifelines: null,
  liquidationMap: null,
  volumeProfile: null,
  tierAndExchangeFlow: null,
};

const base: DirectionBattleInput = {
  symbol: "BTCUSDT",
  mode: "SWING",
  proposedSide: "LONG",
  trendScore: 70,
  regime: "TREND_UP",
  adx: 30,
  chop: 35,
  macroAllowed: true,
  macroDetail: "BTC trend supports direction",
  compositeScore: 82,
  knnProb: null,
  microstructure,
};

function adapterFor(response: (side: "LONG" | "SHORT") => string): XkiroAdapter {
  return {
    callFast: vi.fn(async (user: string) => {
      const side = user.match(/Proposal side: (LONG|SHORT)/)?.[1] as "LONG" | "SHORT";
      return { content: response(side) };
    }),
  } as unknown as XkiroAdapter;
}

describe("directional battle arena", () => {
  it("approves a strong LONG consensus", async () => {
    const result = await runDirectionBattle(base, adapterFor((side) => JSON.stringify({
      stance: side === "LONG" ? "SUPPORT" : "REJECT",
      confidence: side === "LONG" ? 90 : 20,
      reasoning: "Evidence is aligned with the evaluated side.",
    })));

    expect(result.status).toBe("GO");
    expect(result.winner).toBe("LONG");
    expect(result.margin).toBeGreaterThanOrEqual(120);
    expect(result.votes.filter((vote) => vote.byLlm)).toHaveLength(6);
    expect(result.dataQuality).toBe("USABLE");
  });

  it("approves a strong SHORT consensus when trend is SHORT", async () => {
    const result = await runDirectionBattle({ ...base, proposedSide: "SHORT", trendScore: 30, regime: "TREND_DOWN" }, adapterFor((side) => JSON.stringify({
      stance: side === "SHORT" ? "SUPPORT" : "REJECT",
      confidence: side === "SHORT" ? 90 : 20,
      reasoning: "Evidence is aligned with the evaluated side.",
    })));

    expect(result.status).toBe("GO");
    expect(result.winner).toBe("SHORT");
  });

  it("rejects malformed or unavailable votes", async () => {
    const result = await runDirectionBattle(base, adapterFor(() => "not-json"));

    expect(result.status).toBe("REJECT");
    expect(result.winner).toBeNull();
    expect(result.reasons).toContain("INSUFFICIENT_ARENA_VOTES");
  });

  it("rejects a consensus that contradicts the clear trend", async () => {
    const result = await runDirectionBattle(base, adapterFor((side) => JSON.stringify({
      stance: side === "SHORT" ? "SUPPORT" : "REJECT",
      confidence: side === "SHORT" ? 95 : 10,
      reasoning: "The evaluated side has stronger evidence.",
    })));

    expect(result.status).toBe("REJECT");
    expect(result.winner).toBeNull();
    expect(result.reasons).toContain("TREND_CONTRADICTION_LONG");
  });

  it("applies macro permission to the selected winner side", async () => {
    const result = await runDirectionBattle({
      ...base,
      macroAllowed: true,
      macroAllowedBySide: { LONG: false, SHORT: true },
      trendScore: 30,
      microstructure,
    }, adapterFor((side) => JSON.stringify({
      stance: side === "SHORT" ? "SUPPORT" : "REJECT",
      confidence: side === "SHORT" ? 95 : 10,
      reasoning: "The evaluated side has stronger evidence.",
    })));

    expect(result.status).toBe("GO");
    expect(result.winner).toBe("SHORT");
  });

  it("rejects a macro veto and unavailable microstructure", async () => {
    const result = await runDirectionBattle({ ...base, macroAllowed: false, microstructure: null }, adapterFor((side) => JSON.stringify({
      stance: side === "LONG" ? "SUPPORT" : "REJECT",
      confidence: 95,
      reasoning: "The evaluated side has evidence.",
    })));

    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("MACRO_NOT_ALLOWED");
    expect(result.reasons).toContain("MICROSTRUCTURE_UNAVAILABLE");
    expect(result.dataQuality).toBe("UNAVAILABLE");
  });

  it("rejects a tie without inventing a direction", async () => {
    const result = await runDirectionBattle(base, adapterFor(() => JSON.stringify({
      stance: "NEUTRAL",
      confidence: 80,
      reasoning: "Evidence is balanced.",
    })));

    expect(result.status).toBe("REJECT");
    expect(result.winner).toBeNull();
    expect(result.reasons).toContain("NO_DIRECTIONAL_CONSENSUS");
  });

  it("writes one AGENT_DIALOG per voter so the agent dashboard sees battle evidence", async () => {
    const { db } = await import("../src/core/db.js");
    const eventLogCreate = db.eventLog.create as ReturnType<typeof vi.fn>;
    eventLogCreate.mockClear();

    await runDirectionBattle(base, adapterFor((side) => JSON.stringify({
      stance: side === "LONG" ? "SUPPORT" : "REJECT",
      confidence: side === "LONG" ? 90 : 20,
      reasoning: "Evidence is aligned with the evaluated side.",
    })));

    const dialogPayloads = eventLogCreate.mock.calls
      .map((call: unknown[]) => (call[0] as { data: { type: string; payload: string } }).data)
      .filter((d) => d.type === "AGENT_DIALOG")
      .map((d) => JSON.parse(d.payload) as { agentId: string; name: string; text: string; context: { kind: string; battleId: string } });

    expect(dialogPayloads).toHaveLength(3);
    expect(dialogPayloads.map((p) => p.agentId).sort()).toEqual(["macro-scout", "risk-officer", "setup-judge"]);
    // Nama persona diambil dari katalog 12 agen (bukan id polos).
    expect(dialogPayloads.map((p) => p.name).sort()).toEqual(["Arka", "Vega", "Wardha"]);
    for (const p of dialogPayloads) {
      expect(p.context.kind).toBe("direction_battle");
      expect(p.context.battleId).toBeTruthy();
      expect(p.text).toContain("Battle arah BTCUSDT");
    }
  });
});
