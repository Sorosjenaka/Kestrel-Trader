// apps/server/tests/drexSwingStateV2.test.ts — 26 Okt 2026 (TAHAP 5):
// state Drex SWING v2: horizon SWING, blok kandidat & BTC macro TERPISAH,
// missing/stale eksplisit, level tp2 dari plan sebenarnya.
import { describe, expect, it } from "vitest";
import { buildDrexSwingStateV2, DREX_SWING_QUESTIONS, DREX_SWING_STATE_SCHEMA_VERSION_V2 } from "../src/agents/drexState.js";
import type { MicrostructureFlowBlock } from "../src/agents/marketIntel.js";

const base = {
  symbol: "ETHUSDT", side: "LONG" as const, strategyId: "RSW-01",
  compositeScore: 74, entryPrice: 3200, slPrice: 3150, tp1Price: 3300,
};

function micro(status: MicrostructureFlowBlock["status"], extra: Partial<MicrostructureFlowBlock> = {}): MicrostructureFlowBlock {
  return { orderFlowCvd: null, wallLifelines: null, liquidationMap: null, volumeProfile: null, tierAndExchangeFlow: null, status, ...extra };
}

describe("buildDrexSwingStateV2", () => {
  it("schema v2 + horizon SWING + tp2 plan sebenarnya", () => {
    const ok = buildDrexSwingStateV2({ ...base, tp2Price: 3350 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.state.schemaVersion).toBe(DREX_SWING_STATE_SCHEMA_VERSION_V2);
    expect((ok.state.levels as Record<string, unknown>).tp2Price).toBe(3350);
    expect((ok.state.strategy as Record<string, unknown>).horizon).toContain("H1/H4");
  });

  it("mikrostruktur kandidat & BTC macro adalah blok terpisah", () => {
    const ok = buildDrexSwingStateV2({
      ...base,
      microstructure: micro("PARTIAL", { orderFlowCvd: { allVenues: 123, perpSum: 100, spotSum: 23, venuesTrading: 5, venuesExpected: 10, delta15m: 123 } }),
      btcMacro: { chg24hPct: 1.2, microstructure: micro("AVAILABLE", { liquidationMap: { source: "hyperliquid_onchain", magnetDirection: "UP", nearLongUsd: 1, nearShortUsd: 2, nearSkewPct: 10, topClusterBelow: null, topClusterAbove: null, stale: false, note: null } }) },
    });
    if (!ok.ok) throw new Error(ok.reason);
    const cand = ok.state.candidateMicrostructure as Record<string, unknown>;
    const btc = ok.state.btcMacro as Record<string, unknown>;
    expect(cand.status).toBe("PARTIAL");
    expect((cand.cvd as Record<string, unknown>).allVenues).toBe(123);
    expect(btc.chg24hPct).toBe(1.2);
    expect((btc.microstructure as Record<string, unknown>).liqMagnet).toBe("UP");
    // tidak saling mencemari
    expect(JSON.stringify(cand)).not.toContain("chg24hPct");
    expect(JSON.stringify(btc)).not.toContain("venuesTrading");
  });

  it("mikrostruktur kandidat hilang -> UNAVAILABLE eksplisit (bukan nol)", () => {
    const ok = buildDrexSwingStateV2({ ...base, microstructure: null, btcMacro: null });
    if (!ok.ok) throw new Error(ok.reason);
    expect((ok.state.candidateMicrostructure as Record<string, unknown>).status).toBe("UNAVAILABLE");
    expect((ok.state.btcMacro as Record<string, unknown>).status).toBe("UNAVAILABLE");
  });

  it("pertanyaan v2 menyebut horizon swing, bukan 'beberapa menit'", () => {
    const all = JSON.stringify(DREX_SWING_QUESTIONS).toLowerCase();
    expect(all).not.toContain("few minutes");
    expect(all).toContain("swing");
    expect(all).toMatch(/hours|h1\/h4/);
  });
});