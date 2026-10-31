import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SwingEvaluationLoop,
  aggregateSwingEvidence,
  canTransitionSwingEval,
  validateSwingEvalFeedback,
  validateExperiment,
  deterministicSwingFeedback,
  type SwingEvalEvidence,
  type SwingEvalTradeEvidence,
} from "../src/learning/swingEvalLoop.js";
import { SWING_EVAL_IDS, ARCHIVED_SWING_STRATEGIES, ARCHIVED_SWING_CANDIDATES } from "../src/learning/swingEvalRegistry.js";
import type { SwingEvalFeedback } from "../src/learning/swingEvalLoop.js";

// 21 Okt 2026 (Phase 2 plan audit): S-05 (Polaris) dipindahkan ke arsip, jadi
// fixture aktif memakai RSW-01 (Orion). S-05 tidak lagi bisa di-enqueue dan
// tidak lagi punya harness PAPER kandidat.
function trade(i: number, strategyId = "RSW-01", net = 0.5): SwingEvalTradeEvidence {
  return {
    tradeId: `test:${strategyId}:${i}`,
    strategyId,
    symbol: "TESTUSDT",
    side: i % 2 ? "LONG" : "SHORT",
    netPnlUsd: net,
    grossPnlUsd: net + 0.02,
    feeUsd: 0.02,
    fundingCostUsd: 0,
    rMultiple: net > 0 ? 1 : -1,
    source: "PAPER_AI",
    accountingQuality: "SIMULATED",
    feeCoverage: "RECORDED",
    openedAt: new Date(2026, 0, 1 + (i % 28)).toISOString(),
    closedAt: new Date(2026, 0, 1 + (i % 28), 1).toISOString(),
    closeReason: net > 0 ? "TP2" : "SL",
  };
}

function evidence(strategyId = "RSW-01", n = 600): SwingEvalEvidence {
  const trades = Array.from({ length: n }, (_, i) => trade(i, strategyId, i % 3 === 0 ? -1 : 0.65));
  return {
    strategyId,
    aggregate: aggregateSwingEvidence(strategyId, trades),
    trades,
    inputHash: `hash-${strategyId}-${n}`,
    cursor: n,
    notes: [],
  };
}

const validFeedback = {
  // observation WAJIB menyebut strategyId evidence (guard STRATEGY_ID_MISSING_IN_TEXT).
  observation: "RSW-01 menunjukkan sampel yang belum cukup untuk menyimpulkan edge; biaya dan funding harus diverifikasi.",
  edgeHypothesis: "Baseline perlu diuji ulang pada data out-of-sample yang sama sebelum ada perubahan.",
  supportingEvidence: ["aggregate"],
  counterEvidence: ["sample-floor"],
  missingEvidence: ["fee-covered sample", "funding verification"],
  thesisDrift: "UNKNOWN",
  experiment: { kind: "RECHECK_BASELINE", rationale: "Uji ulang baseline tanpa mengubah konfigurasi.", preEntryFeatures: ["strategyId"] },
  operatorProposal: null,
};

describe("swing eval registry", () => {
  it("has exactly the three active non-Fibonacci runtime identities", () => {
    expect(SWING_EVAL_IDS).toEqual(["RSW-01", "RSW-02", "RSW-03"]);
    expect(ARCHIVED_SWING_STRATEGIES.map((s) => s.strategyId)).toEqual(["S-03", "S-05"]);
    expect(ARCHIVED_SWING_STRATEGIES[0]!.fibo).toBe(true);
    expect(ARCHIVED_SWING_STRATEGIES[0]!.displayName).toBe("Atlas");
  });

  it("archives S-05 Polaris as research-only, not an evaluated subject", () => {
    const polaris = ARCHIVED_SWING_STRATEGIES.find((s) => s.strategyId === "S-05")!;
    expect(polaris).toBeDefined();
    expect(polaris.displayName).toBe("Polaris");
    expect(polaris.lifecycle).toBe("RESEARCH_HISTORICAL");
    expect(polaris.researchOnly).toBe(true);
    expect(SWING_EVAL_IDS).not.toContain("S-05");
  });

  it("rejects parameter patch for every strategy since PARAMETER_PATCH is disabled (D-2, 20 Okt 2026)", () => {
    // 21 Okt 2026 (Phase 2 plan audit): PARAMETER_PATCH tidak lagi berlaku untuk
    // satu pun strategi. Sebelumnya cabang ini hanya menolak selain S-05, jadi
    // S-05 masih bisa membuat eksperimen parameter. Sekarang blanket reject.
    const evidenceRsw = evidence("RSW-01");
    const base = {
      ...validFeedback,
      experiment: {
        kind: "PARAMETER_PATCH" as const,
        rationale: "Uji volume contraction pada RSW-01 dengan risk dan RR23 tetap.",
        preEntryFeatures: ["volumeContrThresh"],
        patches: { volumeContrThresh: 0.75, slMult: 1.5 },
      },
    };
    const parsed = validateSwingEvalFeedback(base, evidenceRsw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("PARAMETER_PATCH_DISABLED");
    // validateExperiment juga menolak eksplisit — tidak ada jalur diam-diam lolos.
    const asFeedback = base as unknown as SwingEvalFeedback;
    expect(validateExperiment(asFeedback)).toEqual({ ok: false, reason: "PARAMETER_PATCH_DISABLED" });
  });

  it("accepts a declared universe-filter experiment, not only RECHECK", () => {
    const feedback = { ...validFeedback, experiment: { kind: "UNIVERSE_FILTER" as const, rationale: "Uji konsentrasi pada subset likuid tanpa mengubah entry atau risiko.", preEntryFeatures: ["symbol"], symbols: ["BTCUSDT", "ETHUSDT"] } };
    expect(validateExperiment(feedback)).toEqual({ ok: true, reason: "EXPERIMENT_ALLOWED" });
    expect(validateExperiment({ ...feedback, experiment: { ...feedback.experiment, symbols: ["NOPE"] } }).ok).toBe(false);
  });

  it("does not map historical candidates #3/#4 to a fake ID", () => {
    expect(ARCHIVED_SWING_CANDIDATES.every((c) => c.runtimeStrategyId === null)).toBe(true);
  });
});

describe("swing evidence aggregation", () => {
  it("computes deterministic PF/WR/DD and never invents PF without losses", () => {
    const a = aggregateSwingEvidence("S-03", [trade(1, "S-03", 1), trade(2, "S-03", -0.5), trade(3, "S-03", 0)]);
    expect(a.sampleCount).toBe(3);
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.breakEven).toBe(1);
    expect(a.profitFactor).toBe(2);
    const noLoss = aggregateSwingEvidence("S-03", [trade(1, "S-03", 1)]);
    expect(noLoss.profitFactor).toBeNull();
  });
  it("marks legacy zero-fee rows explicitly", () => {
    const t = { ...trade(1), feeUsd: 0, feeCoverage: "ZERO_LEGACY" as const };
    const a = aggregateSwingEvidence("S-03", [t]);
    expect(a.feeCoverage).toBe("ZERO_LEGACY");
  });
  it("reconciles NET = gross - fee + funding and labels funding cost", () => {
    const t = { ...trade(1), netPnlUsd: 9, grossPnlUsd: 10.5, feeUsd: 1, fundingCostUsd: 0.5 };
    const a = aggregateSwingEvidence("S-03", [t]);
    expect(a.grossPnlUsd).toBe(10.5);
    expect(a.netPnlUsd).toBe(9);
    expect(a.feeUsd).toBe(1);
    expect(a.fundingCostUsd).toBe(0.5);
  });
});

describe("swing feedback schema", () => {
  it("accepts only RECHECK_BASELINE experiment", () => {
    const r = validateSwingEvalFeedback(validFeedback, evidence());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.experiment?.kind).toBe("RECHECK_BASELINE");
    const bad = validateSwingEvalFeedback({ ...validFeedback, experiment: { kind: "SIDE_FILTER", rationale: "x".repeat(30), preEntryFeatures: ["side"] } }, evidence());
    expect(bad.ok).toBe(false);
  });
  it("rejects feedback for a different strategy identity", () => {
    const r = validateSwingEvalFeedback({ ...validFeedback, observation: "RSW-03..." }, evidence("RSW-02"));
    expect(r.ok).toBe(false);
  });
  it("does not allow a parameter-changing proposal to be an automatic experiment", () => {
    const f = { ...deterministicSwingFeedback(evidence()), experiment: null };
    expect(validateExperiment(f).ok).toBe(true);
    const withProposal = { ...f, operatorProposal: "ubah score" };
    expect(validateExperiment(withProposal).ok).toBe(true); // no experiment, proposal stays review-only
    const recheckWithProposal = validateSwingEvalFeedback({ ...validFeedback, operatorProposal: "fix fee accounting" }, evidence());
    expect(recheckWithProposal.ok).toBe(true);
    if (recheckWithProposal.ok) expect(validateExperiment(recheckWithProposal.feedback).ok).toBe(true);
  });
});

describe("swing evaluation loop", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "swing-eval-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function makeLoop(overrides: Record<string, unknown> = {}) {
    const adapter = {
      callReason: async () => ({ content: JSON.stringify(validFeedback), model: "test-model" }),
    };
    const loop = new SwingEvaluationLoop({
      statePath: path.join(dir, "state.json"),
      loadEvidence: async (strategyId: string, afterTradeId = 0) => {
        if (afterTradeId > 0) return { ...evidence(strategyId, 0), aggregate: aggregateSwingEvidence(strategyId, []), trades: [], inputHash: `empty-${strategyId}`, cursor: afterTradeId };
        return evidence(strategyId);
      },
      runBacktest: async () => ({
        ok: true,
        metrics: { sampleCount: 600, winrate: 42, evUsd: 0.12, totalNetPnlUsd: 72, maxDdUsd: 4, totalFeesUsd: 2, totalFundingUsd: 0, fundingCoverage: "FULL" },
        datasetHash: "fixture-hash",
        runRef: "fixture",
        reasons: [],
      }),
      enqueuePaper: async () => ({ ok: true, mode: "EXISTING_ISOLATED_FORWARD", note: "fixture", closedCount: 0 }),
      writeFinding: async () => undefined,
      logEvent: async () => undefined,
      adapter: adapter as never,
      intervalMs: 999999,
      maxRunsPerTick: 10,
      ...overrides,
    });
    return loop;
  }

  it("moves a fixture run through evaluation -> gate -> paper and survives restart", async () => {
    const loop = makeLoop();
    const run = loop.enqueue("RSW-01", "BOOTSTRAP");
    expect(run).not.toBeNull();
    for (let i = 0; i < 10; i += 1) await loop.tick();
    const after = loop.status().runs.find((r) => r.runId === run!.runId)!;
    expect(["PAPER_RUNNING", "PAPER_QUEUED", "REVIEW_DUE"]).toContain(after.state);
    expect(after.feedbackSource).toBe("LLM");
    expect(after.gate?.passed).toBe(true);

    const restarted = makeLoop();
    const persisted = restarted.status().runs.find((r) => r.runId === run!.runId)!;
    expect(persisted.state).toBe(after.state);
  });

  it("resumes a BACKTEST_RUNNING run after a process restart", async () => {
    const statePath = path.join(dir, "restart-state.json");
    const loop = makeLoop({ statePath, maxRunsPerTick: 1, datasetFingerprint: () => null });
    const run = loop.enqueue("RSW-01", "BOOTSTRAP")!;
    // Simulate SIGKILL after the RUNNING write and before the backtest result.
    // This is the exact recovery state; no evaluator stage is skipped.
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    saved.runs[run.runId].state = "BACKTEST_RUNNING";
    fs.writeFileSync(statePath, JSON.stringify(saved));
    let calls = 0;
    const restarted = makeLoop({
      statePath, maxRunsPerTick: 1, datasetFingerprint: () => null,
      runBacktest: async () => {
        calls += 1;
        return { ok: true, metrics: { sampleCount: 600, winrate: 42, evUsd: 0.12, totalNetPnlUsd: 72, maxDdUsd: 4, totalFeesUsd: 2, totalFundingUsd: 0, fundingCoverage: "FULL" }, datasetHash: "fixture-hash", runRef: "fixture", reasons: [] };
      },
    });
    await restarted.tick();
    const after = restarted.status().runs.find((r) => r.runId === run.runId)!;
    expect(calls).toBe(1);
    expect(after.state).toBe("BACKTEST_COMPLETED");
  });

  it("records actual skeptic and contract role runs with validated schemas", async () => {
    let calls = 0;
    const adapter = {
      callReason: async () => {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify(validFeedback), model: "role-test" };
        if (calls === 2) return { content: JSON.stringify({ verdict: "WEAKENED", counterEvidence: ["sample-small"], missingEvidence: ["funding"], notes: "PAPER only" }), model: "role-test" };
        return { content: JSON.stringify({ paperOnly: true, experimentAllowed: true, reasons: ["allowlist"], notes: "PAPER only" }), model: "role-test" };
      },
    };
    const loop = makeLoop({ adapter, maxRunsPerTick: 1, datasetFingerprint: () => "role-dataset" });
    const run = loop.enqueue("RSW-01", "BOOTSTRAP")!;
    for (let i = 0; i < 4; i += 1) await loop.tick();
    const after = loop.status().runs.find((r) => r.runId === run.runId)!;
    expect(after.roleRuns).toHaveLength(2);
    expect(after.roleRuns?.map((r) => r.role)).toEqual(["skeptic", "contract"]);
    expect(after.roleRuns?.every((r) => r.status === "VALIDATED")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("creates a truthful dataset-ready backtest trigger without closed trades", async () => {
    const loop = makeLoop({
      loadEvidence: async (strategyId: string) => ({
        ...evidence(strategyId, 0),
        trades: [],
        aggregate: aggregateSwingEvidence(strategyId, []),
        inputHash: `empty-${strategyId}`,
        cursor: 0,
      }),
      datasetFingerprint: () => "fixture-dataset-v1",
      maxRunsPerTick: 1,
    });
    await loop.tick();
    const run = loop.status().runs.find((r) => r.trigger === "SCHEDULE")!;
    expect(run).toBeDefined();
    expect(run.datasetFingerprint).toBe("fixture-dataset-v1");
    expect(run.triggerReason).toBe("DATASET_READY");
    expect(["BACKTEST_QUEUED", "BACKTEST_RUNNING", "BACKTEST_COMPLETED", "OOS_GATE", "INSUFFICIENT_DATA", "REJECTED", "PAPER_QUEUED", "PAPER_RUNNING"]).toContain(run.state);
    // Identical dataset fingerprint is deduped, not re-enqueued every tick.
    await loop.tick();
    const same = loop.status().runs.filter((r) => r.trigger === "SCHEDULE" && r.datasetFingerprint === "fixture-dataset-v1");
    // One baseline trigger per active strategy, but no duplicate per strategy.
    expect(same.length).toBe(3);
  });

  it("deduplicates an active strategy run", () => {
    const loop = makeLoop();
    expect(loop.enqueue("RSW-01", "BOOTSTRAP")).not.toBeNull();
    expect(loop.enqueue("RSW-01", "BOOTSTRAP")).toBeNull();
  });

  it("stops at INSUFFICIENT_DATA when there are no closed trades", async () => {
    const loop = makeLoop({
      loadEvidence: async (strategyId: string) => ({ ...evidence(strategyId, 0), aggregate: aggregateSwingEvidence(strategyId, []), trades: [], inputHash: "empty", cursor: 0 }),
    });
    const run = loop.enqueue("RSW-03", "BOOTSTRAP")!;
    await loop.tick();
    const after = loop.status().runs.find((r) => r.runId === run.runId)!;
    expect(after.state).toBe("INSUFFICIENT_DATA");
  });

  it("runs all three active subjects through the fixture loop and keeps them separate", async () => {
    const loop = makeLoop({ maxRunsPerTick: 10 });
    const ids = loop.bootstrap();
    expect(ids.length).toBe(3);
    for (let i = 0; i < 14; i += 1) await loop.tick();
    const runs = loop.status().runs;
    expect(new Set(runs.map((r) => r.strategyId))).toEqual(new Set(SWING_EVAL_IDS));
    for (const id of SWING_EVAL_IDS) {
      const r = runs.find((x) => x.strategyId === id)!;
      expect(["PAPER_RUNNING", "PAPER_QUEUED", "INSUFFICIENT_DATA", "NO_CHANGE", "NEEDS_OPERATOR"]).toContain(r.state);
    }
  });

  it("refuses a gate PASS when funding coverage is partial/unknown", async () => {
    const loop = makeLoop({
      runBacktest: async () => ({
        ok: true,
        metrics: { sampleCount: 600, winrate: 52, evUsd: 0.2, totalNetPnlUsd: 120, maxDdUsd: 4, totalFeesUsd: 2, totalFundingUsd: 0, fundingCoverage: "PARTIAL" },
        datasetHash: "fixture-partial", runRef: "fixture-partial", reasons: [],
      }),
    });
    const run = loop.enqueue("RSW-01", "BOOTSTRAP")!;
    for (let i = 0; i < 10; i += 1) await loop.tick();
    const after = loop.status().runs.find((r) => r.runId === run.runId)!;
    expect(after.state).toBe("REJECTED");
    expect(after.gate?.passed).toBe(false);
    expect(after.gate?.reasons).toContain("FUNDING_COVERAGE_PARTIAL");
  });

  it("does not promote when the backtest sample floor fails", async () => {
    const loop = makeLoop({
      runBacktest: async () => ({
        ok: true,
        metrics: { sampleCount: 11, winrate: 36, evUsd: -0.09, totalNetPnlUsd: -1, maxDdUsd: 4, totalFeesUsd: 0.3, totalFundingUsd: 0, fundingCoverage: "FULL" },
        datasetHash: "fixture", runRef: "fixture", reasons: [],
      }),
    });
    const run = loop.enqueue("RSW-01", "BOOTSTRAP")!;
    for (let i = 0; i < 10; i += 1) await loop.tick();
    const after = loop.status().runs.find((r) => r.runId === run.runId)!;
    expect(after.state).toBe("INSUFFICIENT_DATA");
    expect(after.paper).toBeNull();
  });

  it("rejects an illegal state transition", () => {
    expect(canTransitionSwingEval("NO_CHANGE", "EVALUATION_QUEUED")).toBe(false);
    expect(canTransitionSwingEval("EVALUATION_QUEUED", "EVALUATING")).toBe(true);
  });
});
