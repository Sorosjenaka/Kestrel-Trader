import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
import { StrategyTuner, type ParameterRepo, type ParameterVersionRow } from "../src/learning/strategyTuner.js";
import { clearAllRuntimeParams } from "../src/config/runtimeParams.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

class MemoryRepo implements ParameterRepo {
  rows: ParameterVersionRow[] = [];
  async createVersion(data: Omit<ParameterVersionRow, "id">) { const row = { ...data, id: this.rows.length + 1 }; this.rows.push(row); return row; }
  async findByVersion(version: string) { return this.rows.find(r => r.version === version) ?? null; }
  async findActiveVersion() { return this.rows.find(r => r.status === "ACTIVE") ?? null; }
  async updateVersion(id: number, data: Partial<ParameterVersionRow>) { Object.assign(this.rows.find(r => r.id === id)!, data); }
  async listVersions() { return this.rows; }
  async findCandidateFor(strategyId: string, mode: "SCALP" | "SWING") { return this.rows.find(r => { const p = JSON.parse(r.params); return r.status === "CANDIDATE" && p.strategyId === strategyId && p.mode === mode; }) ?? null; }
  async findAuditByDatasetHash() { return false; }
  async logEvent() {}
}
function fixture(content = "") {
  const repo = new MemoryRepo();
  const callReason = vi.fn(async () => ({ content }));
  return { repo, callReason, tuner: new StrategyTuner({ repo, adapter: { callReason } as unknown as XkiroAdapter }) };
}
afterEach(clearAllRuntimeParams);

describe("policy-approved bounded proposals", () => {
  it.each(["S-01", "S-03", "S-04", "S-05"])("reports locked %s tuning disabled without LLM calls or fake versions", async strategyId => {
    const f = fixture();
    const out = await f.tuner.proposeTuning({ strategyId, mode: strategyId === "S-05" ? "SWING" : "SCALP" });
    expect(out.disabled).toBe(true);
    expect(out.dialog.text).toContain("TUNING_DISABLED");
    expect(out.candidateVersion).toBe("");
    expect(f.repo.rows).toHaveLength(0);
    expect(f.callReason).not.toHaveBeenCalled();
  });
  it("proposes only the isolated S-02 pull-bias knob and reports its actual delta", async () => {
    const f = fixture(JSON.stringify({ param: "pullBiasThreshold", from: 1.6, to: 1.52, rationale: "Replay independent holdout." }));
    const out = await f.tuner.proposeTuning({ strategyId: "S-02", mode: "SCALP" });
    expect(out.proposal.param).toBe("pullBiasThreshold");
    expect(out.proposal.boundedPct).toBeCloseTo(5);
    expect(f.repo.rows[0]!.status).toBe("CANDIDATE");
  });
  it("rejects unbounded changes and malformed numerical claims", async () => {
    for (const content of ["{}", "", '{"param":"pullBiasThreshold","from":1.6,"to":1.1,"rationale":"too large"}']) {
      const f = fixture(content);
      await f.tuner.proposeTuning({ strategyId: "S-02" });
      expect(f.repo.rows[0]!.status).toBe("REJECTED");
    }
  });
  it("reuses a pending candidate and waits honestly for OOS input", async () => {
    const f = fixture('{"param":"pullBiasThreshold","from":1.6,"to":1.52,"rationale":"OOS experiment"}');
    const one = await f.tuner.proposeTuning({ strategyId: "S-02" });
    const two = await f.tuner.proposeTuning({ strategyId: "S-02" });
    expect(two.candidateVersion).toBe(one.candidateVersion);
    expect(f.callReason).toHaveBeenCalledTimes(1);
    const gate = await f.tuner.auditAndGateVersion(one.candidateVersion);
    expect(gate.audit).toMatchObject({ status: "CANDIDATE", passed: false, sampleCount: 0 });
    expect(gate.audit.reason).toContain("WAITING_FOR_VERIFIED");
  });
});
