import { describe, expect, it } from "vitest";
import { ALLOWED_PARAMS, buildProposalPrompt, parseProposal, validateProposal } from "../src/learning/strategyProposal";

describe("strategyProposal", () => {
  it("allowlist parameter hanya memuat knob yang diizinkan", () => {
    expect(Object.keys(ALLOWED_PARAMS).sort()).toEqual(["pullBiasThreshold", "tp1R"]);
  });

  it("prompt memuat angka riset dan meminta JSON", () => {
    const p = buildProposalPrompt([
      { strategyId: "S-04", trades: 7, wins: 1, winRatePct: 25, evUsd: -0.4, profitFactor: 0.25, avgWinUsd: 1.6, avgLossUsd: -1 },
    ]);
    expect(p).toContain("S-04");
    expect(p).toContain("25.0");
    expect(p).toContain("HANYA JSON");
  });

  it("membaca proposal valid", () => {
    const r = parseProposal('{"action":"propose","strategyId":"S-04","param":"pullBiasThreshold","from":1.6,"to":1.3,"rationale":"WR turun"}');
    expect(r.ok).toBe(true);
    expect(r.proposal?.param).toBe("pullBiasThreshold");
    expect(r.reason).toBe("OK");
  });

  it("menolak parameter di luar allowlist dan nilai di luar band", () => {
    expect(validateProposal({ strategyId: "S-04", param: "maxLeverage", from: 1, to: 2 }).reason).toBe("PARAM_NOT_ALLOWED");
    expect(validateProposal({ strategyId: "S-04", param: "tp1R", from: 1.6, to: 9 }).reason).toBe("OUT_OF_BAND");
    expect(validateProposal({ strategyId: "S-04", param: "tp1R", from: 1.6, to: "x" }).reason).toBe("NOT_A_NUMBER");
    expect(validateProposal({ strategyId: "", param: "tp1R", from: 1.5, to: 1.5 }).reason).toBe("NO_STRATEGY");
  });

  it("AI memilih hold -> tidak ada proposal (tidak memaksa perubahan)", () => {
    const r = parseProposal('{"action":"hold"}');
    expect(r.ok).toBe(true);
    expect(r.proposal).toBeNull();
  });

  it("JSON rusak -> tidak ada proposal", () => {
    expect(parseProposal("maaf saya ragu").ok).toBe(false);
  });
});
