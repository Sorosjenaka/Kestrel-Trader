import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
import { StrategyTuner, type ParameterRepo, type ParameterVersionRow } from "../src/learning/strategyTuner.js";
import { calculateMetrics, type BacktestRunOutput, type TradeResult } from "../src/backtest/backtestEngine.js";
import { clearAllRuntimeParams, runtimeParamsApplied } from "../src/config/runtimeParams.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

class MemoryRepo implements ParameterRepo {
  rows: ParameterVersionRow[] = [];
  async createVersion(data: Omit<ParameterVersionRow, "id">) { const row = { ...data, id: this.rows.length + 1 }; this.rows.push(row); return row; }
  async findByVersion(version: string) { return this.rows.find(r => r.version === version) ?? null; }
  async findActiveVersion() { return this.rows.find(r => r.status === "ACTIVE") ?? null; }
  async updateVersion(id: number, data: Partial<ParameterVersionRow>) { Object.assign(this.rows.find(r => r.id === id)!, data); }
  async listVersions() { return this.rows; }
  async findCandidateFor() { return null; }
  async findAuditByDatasetHash() { return false; }
  async logEvent() {}
}
function run(version: string, value: number, pnl: number): BacktestRunOutput {
  const trades: TradeResult[] = Array.from({ length: 500 }, (_, i) => ({
    symbol: "BTCUSDT", direction: "LONG", entryPrice: 100, exitPrice: 101,
    entryAt: new Date(1800000000000 + i * 60000), exitAt: new Date(1800000060000 + i * 60000),
    exitReason: "TP1", slPct: .02, effectiveNotional: 50, effectiveRiskUsd: 1,
    grossR: pnl, grossPnlUsd: pnl, feesUsd: 0, netPnlUsd: pnl, netR: pnl, isWin: pnl > 0,
  }));
  return { strategyId: "S-02", strategyName: "Liquidity Sniper", mode: "SCALP", paramsVersion: version,
    fromDate: new Date("2026-08-01"), toDate: new Date("2026-09-01"), status: "PASSED", gatePassed: true,
    failedGateReasons: [], distributionR: [], trades, metrics: calculateMetrics(trades),
    provenance: { kind: "HISTORICAL_REPLAY", scope: "DETERMINISTIC_SINGLE_SYMBOL", datasetHash: "holdout-1",
      outOfSampleFrom: Date.parse("2026-08-01"), outOfSampleTo: Date.parse("2026-09-01"),
      strategyVersion: version, parametersApplied: true, appliedParameters: { pullBiasThreshold: value },
      llmReplayed: false, portfolioReplayed: false, limitations: [] },
  };
}
async function fixture(extra: Record<string, unknown> = {}) {
  const repo = new MemoryRepo();
  await repo.createVersion({ version: "candidate", status: "CANDIDATE", createdAt: new Date(), params: JSON.stringify({
    strategyId: "S-02", mode: "SCALP", param: "pullBiasThreshold", from: 1.6, to: 1.52, runtimeSupported: true, ...extra,
  }) });
  const runner = vi.fn();
  const tuner = new StrategyTuner({ repo, adapter: {} as XkiroAdapter, backtestRunner: runner });
  return { repo, tuner, runner, candidate: run("candidate", 1.52, .2), baseline: run("baseline-candidate", 1.6, .1) };
}
afterEach(clearAllRuntimeParams);
describe("replay-proven parameter activation", () => {
  it("activates only a bounded isolated parameter with matching replay evidence", async () => {
    const f = await fixture();
    const out = await f.tuner.auditAndGateVersion("candidate", { mockBacktestResult: f.candidate, mockBaselineResult: f.baseline });
    expect(out.audit.passed).toBe(true);
    expect(out.audit.reason).toContain("EV 95% CI");
    expect(runtimeParamsApplied()).toContainEqual(expect.objectContaining({ param: "pullBiasThreshold", strategyId: "S-02", value: 1.52 }));
  });
  it("does not accept a claimed override without its actual parameter value", async () => {
    const f = await fixture();
    f.candidate.provenance!.appliedParameters = {};
    const out = await f.tuner.auditAndGateVersion("candidate", { mockBacktestResult: f.candidate, mockBaselineResult: f.baseline });
    expect(out.audit.reason).toContain("PARAMETER_VALUE_NOT_VERIFIED");
    expect(runtimeParamsApplied()).toEqual([]);
  });
  it("rejects missing trade evidence even when summary metrics say 500 trades", async () => {
    const f = await fixture();
    f.candidate.trades = f.candidate.trades!.slice(0, 2);
    const out = await f.tuner.auditAndGateVersion("candidate", { mockBacktestResult: f.candidate, mockBaselineResult: f.baseline });
    expect(out.audit.reason).toContain("REPLAY_TRADE_COUNT_MISMATCH");
  });
  it("rejects overlapping tuning/evaluation windows", async () => {
    const f = await fixture({ tuningWindowFrom: "2026-07-15", tuningWindowTo: "2026-08-15" });
    const out = await f.tuner.auditAndGateVersion("candidate", { mockBacktestResult: f.candidate, mockBaselineResult: f.baseline });
    expect(out.audit.reason).toContain("TUNING_WINDOW_OVERLAPS_EVALUATION_WINDOW");
  });
  it("never replays or activates a locked TP proposal", async () => {
    const f = await fixture({ param: "tp1R", from: 1.7, to: 1.6, strategyId: "S-01" });
    const out = await f.tuner.auditAndGateVersion("candidate", { mockBacktestResult: f.candidate, mockBaselineResult: f.baseline });
    expect(out.audit.reason).toContain("TUNING_DISABLED");
    expect(f.runner).not.toHaveBeenCalled();
  });
});
