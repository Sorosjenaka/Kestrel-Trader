import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: vi.fn() } } }));
import { DecisionRiskLayer, type SetupJudgeInput, type RiskOfficerInput } from "../src/agents/decisionRiskLayer.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
const setup: SetupJudgeInput = { symbol: "BTCUSDT", side: "LONG", mode: "SCALP", zoneScore: 82, triggerScore: 78, knnProb: .65, compositeScore: 80, regime: "TRENDING" };
const risk: RiskOfficerInput = { symbol: "BTCUSDT", side: "LONG", entryPrice: 100, slPrice: 98, equityUsd: 200, targetRiskUsd: 1, leverageTarget: 25, maxLeverageSnapshot: 25 };
function layer(content: string, fails = false) {
  const callReason = vi.fn(async () => { if (fails) throw new Error("offline"); return { content }; });
  return { agent: new DecisionRiskLayer({ callReason } as unknown as XkiroAdapter), callReason };
}
const go = "PUTUSAN: GO\nKEYAKINAN: 80\nALASAN: Bukti zona dan trigger selaras; perhatikan konflik makro.";
const approve = "PUTUSAN: APPROVED\nALASAN: Angka final sesuai hard gate.";
describe("Decision and risk fail-closed contracts", () => {
  it("uses an explicit valid verdict; confidence is not a win probability", async () => {
    const result = await layer(go).agent.runSetupJudge(setup);
    expect(result).toMatchObject({ verdict: "GO", byLlm: true, confidence: 80, winProbability: null, confidenceKind: "SUBJECTIVE_NOT_CALIBRATED" });
  });
  it.each(["", "Looks valid", "GO", "PUTUSAN: GO\nKEYAKINAN: 80", go + "\nPUTUSAN: NO-GO"])("rejects malformed judge response %s", async (text) => {
    expect(await layer(text).agent.runSetupJudge(setup)).toMatchObject({ verdict: "NO-GO", byLlm: false });
  });
  it("model failure rejects, explicit deterministic mode remains identified", async () => {
    expect((await layer("", true).agent.runSetupJudge(setup)).verdict).toBe("NO-GO");
    expect(await layer("", true).agent.runSetupJudge({ ...setup, knnProb: null, skipLlm: true })).toMatchObject({ verdict: "GO", byLlm: false, confidence: 0 });
  });
  it("explains missing KNN and passed macro gate without inventing a probability", async () => {
    const { agent, callReason } = layer(go);
    await agent.runSetupJudge({ ...setup, mode: "SCALP", strategyId: "S-04",
      knnProb: null, macroAllowed: true, macroDetail: "BTC RANGING NEUTRAL",
      macroObserverText: "Vega melihat matriks R4 PUMP mendukung LONG.",
      strategyEvidence: ["TREND_BEARISH_SCORE_70", "PULLBACK_ZLEMA_1h"],
      structureAdx: 30, structureChop: 45, biasAdx: 27, biasChop: 42,
      structureAtrPct: 0.8 });
    const prompt = String(callReason.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("KNN: belum ada probabilitas terkalibrasi");
    expect(prompt).toContain("bukan hard gate");
    expect(prompt).toContain("Gate makro deterministik: PASS");
    expect(prompt).toContain("PULLBACK_ZLEMA_1h");
    expect(prompt).toContain("Filter anti-sideways telah PASS");
    expect(prompt).toContain("Observasi Vega");
  });
  it.each([{ compositeScore: 20 }, { knnProb: .1 }, { compositeScore: NaN }, { knnProb: 2 }])("LLM GO cannot bypass numeric gate %j", async (invalid) => {
    expect((await layer(go).agent.runSetupJudge({ ...setup, ...invalid })).verdict).toBe("NO-GO");
  });
  it("EXPLORATION_GO L0: LLM GO + keyakinan cukup boleh override skor lunak", async () => {
    const low = { ...setup, compositeScore: 48, knnProb: 0.3, minScore: 45, minKnn: 0,
      progressiveLevel: 0, allowExplorationGo: true, explorationMinConfidence: 55 };
    // composite 48 >= minScore 45 & knn 0.3 >= 0 -> deterministicPass true -> GO.
    expect((await layer(go).agent.runSetupJudge(low)).verdict).toBe("GO");
    // Skor di bawah ambang lunak + LLM GO yakin 80 -> EXPLORATION_GO.
    const below = { ...low, compositeScore: 42, minScore: 45 };
    const res = await layer(go).agent.runSetupJudge(below);
    expect(res.verdict).toBe("GO");
    expect(res.reason).toContain("EXPLORATION_GO_L0");
    // Keyakinan rendah (<55) tidak boleh override.
    const shy = "PUTUSAN: GO\nKEYAKINAN: 40\nALASAN: Ragu tapi terlihat ok.";
    expect((await layer(shy).agent.runSetupJudge(below)).verdict).toBe("NO-GO");
    // L5: tidak ada exploration override.
    expect((await layer(go).agent.runSetupJudge({ ...below, progressiveLevel: 5, allowExplorationGo: false })).verdict).toBe("NO-GO");
    // Data INVALID tetap NO-GO walau eksplorasi.
    expect((await layer(go).agent.runSetupJudge({ ...below, compositeScore: NaN })).verdict).toBe("NO-GO");
  });
  it("outageFallback: deterministik GO berlabel jujur saat LLM mati", async () => {
    const outage = { ...setup, compositeScore: 80, knnProb: 0.6, minScore: 50, minKnn: 0,
      skipLlm: true, outageFallback: true };
    const res = await layer("", true).agent.runSetupJudge(outage);
    expect(res).toMatchObject({ verdict: "GO", byLlm: false });
    expect(res.dialog.text).toContain("DETERMINISTIC_GO_NO_LLM");
    expect(res.dialog.context).toMatchObject({ outageFallback: true });
    // Di bawah ambang lunak -> tetap NO-GO walau outage (tidak boleh asal-asalan).
    expect((await layer("", true).agent.runSetupJudge({ ...outage, compositeScore: 20 })).verdict).toBe("NO-GO");
  });
  it("uses the same 25x leverage as the plan and caps at verified pair leverage", async () => {
    expect((await layer(approve).agent.runRiskOfficer(risk)).sizing).toMatchObject({ leverage: 25, notionalUsd: 50, marginUsd: 2 });
    expect((await layer(approve).agent.runRiskOfficer({ ...risk, maxLeverageSnapshot: 20 })).sizing.leverage).toBe(20);
  });
  it.each(["", "Lolos", "APPROVED", "PUTUSAN: APPROVED"])("rejects malformed risk response %s", async (content) => {
    expect((await layer(content).agent.runRiskOfficer(risk)).approved).toBe(false);
  });
  it.each([{ slPrice: 90 }, { slPrice: 101 }, { slPrice: 100 }, { equityUsd: 0 }, { targetRiskUsd: 1.2 }, { maxLeverageSnapshot: undefined }, { entryPrice: NaN }])("hard risk gates veto approval %j", async (invalid) => {
    const { agent, callReason } = layer(approve);
    expect((await agent.runRiskOfficer({ ...risk, ...invalid })).approved).toBe(false);
    expect(callReason).not.toHaveBeenCalled();
  });
  it("reviews final plan rather than an alternative sizing", async () => {
    const finalPlan = { qty: .45, notionalUsd: 45, marginUsd: 1.8, leverage: 25, effectiveRiskUsd: .9, estimatedNetRiskUsd: .95, allowed: true };
    const accepted = await layer(approve).agent.runRiskOfficer({ ...risk, finalPlan });
    expect(accepted.approved).toBe(true);
    expect(accepted.sizing.notionalUsd).toBe(45);
    expect((await layer(approve).agent.runRiskOfficer({ ...risk, finalPlan: { ...finalPlan, estimatedNetRiskUsd: 1.01 } })).approved).toBe(false);
    expect((await layer(approve).agent.runRiskOfficer({ ...risk, finalPlan: { ...finalPlan, qty: 4.5 } })).approved).toBe(false);
    expect((await layer(approve).agent.runRiskOfficer({ ...risk, finalPlan: { ...finalPlan, allowed: false, rejectReason: "EXCHANGE_FILTER" } })).reason).toContain("EXCHANGE_FILTER");
  });
  it("approves RR klasik sizing with <=25% step-size quantization overhang", async () => {
    // AVAX scenario: effectiveRisk 1.107, estimatedNetRisk 1.15, notional 46.8, margin 1.872
    const overhangPlan = {
      qty: 4,
      notionalUsd: 46.8,
      marginUsd: 1.872,
      leverage: 25,
      effectiveRiskUsd: 1.1072,
      estimatedNetRiskUsd: 1.154,
      allowed: true,
    };
    const avaxRisk: RiskOfficerInput = {
      symbol: "AVAXUSDT",
      side: "LONG",
      entryPrice: 11.7,
      slPrice: 11.4232,
      equityUsd: 200,
      targetRiskUsd: 1,
      leverageTarget: 25,
      maxLeverageSnapshot: 25,
      finalPlan: overhangPlan,
    };
    const res = await layer(approve).agent.runRiskOfficer(avaxRisk);
    expect(res.approved).toBe(true);
    expect(res.sizing.effectiveRiskUsd).toBe(1.1072);
  });
  // ── MENU SL/TP DETERMINISTIK (Opsi 2 Hybrid, 2 Okt 2026) ───────────────────
  const menu = {
    sl: [
      { id: "A", label: "struktural", slPrice: 98.5, slPct: 0.015, basis: "STRUCTURAL" },
      { id: "B", label: "struktural + buffer ATR", slPrice: 98.27, slPct: 0.0173, basis: "STRUCTURAL_ATR_BUFFER" },
    ],
    tp: [
      { id: "A", label: "2.0R", r: 2.0 },
      { id: "B", label: "1.75R", r: 1.75 },
      { id: "C", label: "1.5R", r: 1.5 },
    ],
    defaultSlId: "A",
    defaultTpId: "A",
  };
  it("menu SL/TP: pilihan ID valid diteruskan; angka tetap milik kode (dilarang di prompt)", async () => {
    const { agent, callReason } = layer(
      "PUTUSAN: GO\nKEYAKINAN: 80\nPILIHAN_SL: B\nPILIHAN_TP: C\nALASAN: Struktur jelas; ambil TP konservatif."
    );
    const res = await agent.runSetupJudge({ ...setup, slTpMenu: menu });
    expect(res).toMatchObject({ verdict: "GO", byLlm: true, slChoice: "B", tpChoice: "C", menuFallback: false });
    const sys = String(callReason.mock.calls[0]?.[1] ?? "");
    expect(sys).toContain("PILIHAN_SL: [A | B]");
    expect(sys).toContain("PILIHAN_TP: [A | B | C]");
    expect(sys).toContain("DILARANG menulis harga/angka sendiri");
  });
  it.each([
    "PUTUSAN: GO\nKEYAKINAN: 80\nPILIHAN_SL: Z\nPILIHAN_TP: A\nALASAN: di luar menu",
    "PUTUSAN: GO\nKEYAKINAN: 80\nPILIHAN_SL: A\nPILIHAN_SL: A\nPILIHAN_TP: A\nALASAN: duplikat",
    go,
  ])("menu SL/TP: pilihan tidak valid -> fallback default (fail-safe)", async (text) => {
    const res = await layer(text).agent.runSetupJudge({ ...setup, slTpMenu: menu });
    expect(res.slChoice).toBeNull();
    expect(res.tpChoice === null || res.tpChoice === "A").toBe(true);
    expect(res.menuFallback).toBe(true);
  });
  it("tanpa menu, kontrak 3 baris lama utuh dan tidak ada pilihan", async () => {
    const res = await layer(go).agent.runSetupJudge(setup);
    expect(res).toMatchObject({ verdict: "GO", slChoice: null, menuFallback: false });
  });
  it("LLM outage/malformed dengan menu -> tidak ada pilihan (deterministik default)", async () => {
    const res = await layer("", true).agent.runSetupJudge({ ...setup, slTpMenu: menu, knnProb: null, skipLlm: true });
    expect(res).toMatchObject({ byLlm: false, slChoice: null, tpChoice: null, menuFallback: true });
  });
});
