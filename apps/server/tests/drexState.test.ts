// apps/server/tests/drexState.test.ts - Uji pembangun state Drex: nilai nyata,
// tanpa fabrikasi/placeholder, fail-closed bila field inti hilang.
import { describe, expect, it } from "vitest";
import { buildDrexState, DREX_QUESTIONS, DREX_STATE_SCHEMA_VERSION } from "../src/agents/drexState.js";
import type { SetupJudgeInput } from "../src/agents/decisionRiskLayer.js";

const full: SetupJudgeInput = {
  symbol: "BTCUSDT",
  side: "LONG",
  mode: "SCALP",
  zoneScore: 72,
  triggerScore: 65,
  knnProb: 0.58,
  compositeScore: 71,
  regime: "TRENDING",
  strategyId: "S-01",
  strategyName: "Liquidity Sweep Reclaim",
  slPct: 0.0099,
  entryPrice: 64250,
  slPrice: 63610,
  tp1Price: 65210,
  minScore: 70,
  minKnn: 0.55,
  emptySlots: 12,
  maxPositions: 20,
  macroDetail: "BTC 1h above VWAP",
  macroObserverText: "Vega: risk-on",
  macroAllowed: true,
  strategyEvidence: ["sweep low 0.12 ATR below zone"],
  structureAdx: 27.4,
  structureChop: 0.31,
  biasAdx: 31,
  biasChop: 0.22,
  structureAtrPct: 0.0042,
  volumeUsd: 24_500_000,
  fundingRate: 0.00012,
  lessons: ["lesson 1", "lesson 2"],
  marketFilterStatus: "PASS (L2)",
  progressiveLevel: 2,
  paperDeterministicEntry: true,
};

describe("buildDrexState — kontrak artatrade-scalp-state-v1", () => {
  it("membangun state dari nilai nyata call site (symbol/side/skor/level/konteks)", () => {
    const res = buildDrexState(full);
    if (!res.ok) throw new Error(res.reason);
    const s = res.state;
    expect(s.schemaVersion).toBe(DREX_STATE_SCHEMA_VERSION);
    expect(s.symbol).toBe("BTCUSDT");
    expect(s.side).toBe("LONG");
    expect(s.mode).toBe("SCALP");
    expect(s.scores).toMatchObject({ zoneScore: 72, triggerScore: 65, compositeScore: 71, knnProb: 0.58, knnProbCalibrated: false });
    expect(s.levels).toEqual({ entryPrice: 64250, slPrice: 63610, tp1Price: 65210, slPct: 0.0099 });
    expect(s.strategy).toMatchObject({ id: "S-01", name: "Liquidity Sweep Reclaim", rr: 1.7 });
    expect(s.marketContext).toMatchObject({ volumeUsd: 24_500_000, fundingRate: 0.00012, structureAdx: 27.4 });
    expect(s.macro).toMatchObject({ allowed: true, detail: "BTC 1h above VWAP" });
    expect(s.session).toMatchObject({ paperDeterministicEntry: true, minScore: 70, emptySlots: 12 });
    expect(s.lessons).toEqual(["lesson 1", "lesson 2"]);
    // Peta timeframe diambil dari config kode, bukan hardcode.
    expect(s.timeframes).toMatchObject({ trigger: "1m", confirm: "3m", structure: "5m", bias: "15m" });
  });

  it("gagal eksplisit (fail-closed) bila field inti hilang — tanpa fabrikasi", () => {
    const noScores = { ...full, compositeScore: NaN };
    const res2 = buildDrexState(noScores);
    expect(res2.ok).toBe(false);
    if (res2.ok) throw new Error("expected failure");
    expect(res2.reason).toContain("DREX_STATE_INCOMPLETE");
    expect(res2.reason).toContain("compositeScore");
    const badSide = { ...full, side: "FLAT" as unknown as "LONG" };
    expect(buildDrexState(badSide).ok).toBe(false);
    const noSymbol = { ...full, symbol: "" };
    const res3 = buildDrexState(noSymbol);
    expect(res3.ok).toBe(false);
    if (res3.ok) throw new Error("expected failure");
    expect(res3.reason).toContain("symbol");
  });

  it("harga belum ada (kandidat tanpa plan di FASE B) -> levels dilewatkan, Drex tetap dinilai", () => {
    const noPrices = { ...full, entryPrice: undefined, slPrice: undefined, tp1Price: undefined, slPct: undefined };
    const res = buildDrexState(noPrices);
    if (!res.ok) throw new Error(res.reason); // tidak boleh gagal: Drex harus tetap primer
    expect(res.state.levels).toEqual({});
    expect(JSON.stringify(res.state)).not.toContain('"entryPrice"');
    expect(JSON.stringify(res.state)).not.toContain('"slPrice":0');
  });

  it("menghilangkan nilai opsional yang tidak ada — tanpa placeholder 0", () => {
    const sparse: SetupJudgeInput = {
      symbol: "ETHUSDT", side: "SHORT", mode: "SCALP",
      zoneScore: 60, triggerScore: 55, compositeScore: 58, regime: "RANGING",
      entryPrice: 100, slPrice: 102, tp1Price: 97,
      knnProb: null,
      volumeUsd: null, fundingRate: null,
      structureAdx: null, structureChop: null, biasAdx: null, biasChop: null, structureAtrPct: null,
      macroDetail: null, macroObserverText: null,
    };
    const res = buildDrexState(sparse);
    if (!res.ok) throw new Error(res.reason);
    const s = res.state;
    expect(s.scores).not.toHaveProperty("knnProb"); // null -> key tidak ditulis
    expect(s.marketContext).toEqual({});
    expect(s.macro).toEqual({});
    expect(s).not.toHaveProperty("lessons");
    expect(s.levels).not.toHaveProperty("slPct");
    // Tidak ada nilai 0 palsu yang menyamar sebagai data.
    expect(JSON.stringify(s)).not.toContain('"volumeUsd":0');
    expect(JSON.stringify(s)).not.toContain('"fundingRate":0');
    expect(JSON.stringify(s)).not.toContain('"knnProb":0');
  });

  it("definisi pertanyaan mengikuti kontrak Drex: choice/score memakai criteria", () => {
    expect(DREX_QUESTIONS.entry_go.type).toBe("noul");
    expect(DREX_QUESTIONS.direction.type).toBe("choice");
    expect(DREX_QUESTIONS.direction.criteria).toEqual({
      LONG: expect.any(String),
      SHORT: expect.any(String),
    });
    expect(DREX_QUESTIONS.setup_strength.type).toBe("score");
    expect(DREX_QUESTIONS.setup_strength.criteria).toEqual(["very_weak", "weak", "moderate", "strong", "very_strong"]);
    expect(DREX_QUESTIONS.direction).not.toHaveProperty("options");
    expect(DREX_QUESTIONS.setup_strength).not.toHaveProperty("levels");
  });
});
