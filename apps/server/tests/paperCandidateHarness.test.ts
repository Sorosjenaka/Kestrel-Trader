import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPaperCandidate, loadPaperCandidate, candidateParameterHash } from "../src/learning/paperCandidateHarness.js";

// 21 Okt 2026 (Phase 2 plan audit): fixture berpindah dari S-05 (Polaris) ke
// RSW-01 (Orion). S-05 sudah diarsipkan, jadi createPaperCandidate menolaknya
// dengan ARCHIVED_OR_UNKNOWN_STRATEGY — cohort kandidat S-05 tidak lagi bisa
// dibuat dari sisi server.
const STRATEGY_ID = "RSW-01";
const PARENT_VERSION = "orion-2026-10-19";

describe("paper candidate harness", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arta-candidate-"));
  // Parameter yang benar-benar dipakai startRswCandidate(): bukan patch
  // parameter entry (PARAMETER_PATCH sudah dimatikan untuk semua strategi).
  const params = { experimentKind: "RECHECK_BASELINE", universeFilter: "[]", rationale: "Uji ulang baseline tanpa perubahan konfigurasi." };
  const id = "CAND-TEST-01";
  const walletId = "WALLET-TEST-01";
  const experimentId = "EXPERIMENT-TEST-01";
  const parameterHash = candidateParameterHash(STRATEGY_ID, PARENT_VERSION, params);

  it("creates an isolated $200 candidate wallet and refuses a reset/identity swap", () => {
    const first = createPaperCandidate(root, {
      candidateId: id, strategyId: STRATEGY_ID, experimentId, parentVersion: PARENT_VERSION,
      parameterHash, parameters: params, executionMode: "PAPER", walletId,
    });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    const statePath = first.statePath!;
    expect(statePath).toContain("/candidates/CAND-TEST-01/wallet.json");
    const wallet = loadPaperCandidate(root, id)!;
    expect(wallet.initialBalanceUsd).toBe(200);
    expect(wallet.mode).toBe("ISOLATED_PAPER_ONLY");
    expect(wallet.liveEnabled).toBe(false);
    expect(wallet.candidateId).toBe(id);

    const reopened = createPaperCandidate(root, {
      candidateId: id, strategyId: STRATEGY_ID, experimentId, parentVersion: PARENT_VERSION,
      parameterHash, parameters: params, executionMode: "PAPER", walletId,
    });
    expect(reopened.ok).toBe(true);
    expect(reopened.created).toBe(false);
    expect(reopened.reason).toBe("CANDIDATE_STATE_REUSED");

    const swappedParams = { ...params, universeFilter: "[\"BTCUSDT\"]" };
    const swapped = createPaperCandidate(root, {
      candidateId: id, strategyId: STRATEGY_ID, experimentId, parentVersion: PARENT_VERSION,
      parameterHash: candidateParameterHash(STRATEGY_ID, PARENT_VERSION, swappedParams),
      parameters: swappedParams, executionMode: "PAPER", walletId,
    });
    expect(swapped.ok).toBe(false);
    expect(swapped.reason).toBe("CANDIDATE_STATE_IDENTITY_CONFLICT");
  });

  it("rejects non-PAPER, archived/unknown strategy, invalid hash and empty params", () => {
    expect(createPaperCandidate(root, { candidateId: "CAND-X", strategyId: STRATEGY_ID, experimentId, parentVersion: "v", parameterHash, parameters: params, executionMode: "LIVE" as never, walletId }).reason).toBe("NON_PAPER_REJECTED");
    expect(createPaperCandidate(root, { candidateId: "CAND-Y", strategyId: "S-03", experimentId, parentVersion: "v", parameterHash, parameters: params, executionMode: "PAPER", walletId }).reason).toBe("ARCHIVED_OR_UNKNOWN_STRATEGY");
    expect(createPaperCandidate(root, { candidateId: "CAND-Z", strategyId: STRATEGY_ID, experimentId, parentVersion: "v", parameterHash: "bad", parameters: params, executionMode: "PAPER", walletId }).reason).toBe("INVALID_PARAMETER_HASH");
    expect(createPaperCandidate(root, { candidateId: "CAND-Q", strategyId: STRATEGY_ID, experimentId, parentVersion: "v", parameterHash: candidateParameterHash(STRATEGY_ID, "v", {}), parameters: {}, executionMode: "PAPER", walletId }).reason).toBe("EMPTY_PARAMETER_SNAPSHOT");
  });

  it("refuses to spawn a candidate cohort for the archived S-05 Polaris", () => {
    const s05Params = { experimentKind: "PARAMETER_PATCH", volumeContrThresh: 0.75 };
    const res = createPaperCandidate(root, {
      candidateId: "CAND-S05", strategyId: "S-05", experimentId, parentVersion: "polaris-2026-10-19",
      parameterHash: candidateParameterHash("S-05", "polaris-2026-10-19", s05Params),
      parameters: s05Params, executionMode: "PAPER", walletId: "WALLET-S05",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("ARCHIVED_OR_UNKNOWN_STRATEGY");
  });

  it("keeps two candidates separate and never uses the baseline path", () => {
    const otherId = "CAND-TEST-02";
    const otherParams = { experimentKind: "UNIVERSE_FILTER", universeFilter: "[\"BTCUSDT\"]", rationale: "Subset likuid untuk uji out-of-sample." };
    const otherHash = candidateParameterHash(STRATEGY_ID, PARENT_VERSION, otherParams);
    const a = createPaperCandidate(root, { candidateId: otherId, strategyId: STRATEGY_ID, experimentId: "EXPERIMENT-TEST-02", parentVersion: PARENT_VERSION, parameterHash: otherHash, parameters: otherParams, executionMode: "PAPER", walletId: "WALLET-TEST-02" });
    expect(a.ok).toBe(true);
    expect(loadPaperCandidate(root, id)?.parameterHash).not.toBe(loadPaperCandidate(root, otherId)?.parameterHash);
    // Kandidat hidup di direktori candidates/, tidak pernah di wallet baseline.
    expect(a.statePath).toContain("/candidates/CAND-TEST-02/wallet.json");
    expect(a.statePath).not.toContain("forward-wallet");
  });
});
