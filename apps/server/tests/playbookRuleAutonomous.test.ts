import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));

import {
  autoPromoteProposedRule,
  autoRollbackRuleIfNeeded,
  evaluateProposedRuleDeterministically,
  interceptApprovedPlaybookRules,
  recordApprovedRuleApplication,
  type PlaybookRuleRow,
  type PlaybookRuleStore,
  type RuleGateEvaluation,
  type RuleSignalContext,
  type RuleTelemetryEvent,
} from "../src/learning/playbookRules.js";

class MemoryPlaybookStore implements PlaybookRuleStore {
  rules: PlaybookRuleRow[] = [];
  events: RuleTelemetryEvent[] = [];

  async findRule(id: string) { return this.rules.find((r) => r.id === id) ?? null; }
  async listProposedRules(limit: number) { return this.rules.filter((r) => r.status === "PROPOSED").slice(0, limit); }
  async listApprovedRules() { return this.rules.filter((r) => r.status === "APPROVED"); }
  async updateRule(id: string, data: Partial<Pick<PlaybookRuleRow, "status" | "appliedCount" | "violatedCount" | "updatedAt">>) {
    const row = this.rules.find((r) => r.id === id);
    if (!row) throw new Error("RULE_NOT_FOUND");
    Object.assign(row, data);
    return row;
  }
  async appendEvent(type: string, severity: string, payload: Record<string, unknown>) {
    this.events.push({ id: this.events.length + 1, type, severity, payload, createdAt: new Date() });
  }
  async listRuleEvents(ruleId: string) {
    return this.events.filter((e) => e.payload.ruleId === ruleId).sort((a, b) => b.id - a.id);
  }
  async loadRecentSamples() { return []; }
}

function rule(status: PlaybookRuleRow["status"] = "PROPOSED"): PlaybookRuleRow {
  return {
    id: "rule-1",
    ruleText: "Jika risk melewati baseline, blokir entry",
    triggerCondition: JSON.stringify({ kind: "PRE_TRADE_GUARD", field: "riskUsd", operator: "GT", value: 1.1 }),
    actionStatement: "BLOCK_ENTRY_IF_TRIGGER",
    source: "DERIVED",
    status,
    appliedCount: 0,
    violatedCount: 0,
    createdAt: new Date("2026-10-09T00:00:00Z"),
    updatedAt: new Date("2026-10-09T00:00:00Z"),
  };
}

const signal = (overrides: Partial<RuleSignalContext> = {}): RuleSignalContext => ({
  symbol: "BTCUSDT",
  side: "LONG",
  mode: "SCALP",
  strategyId: "S-01",
  entryPrice: 100,
  slPrice: 99,
  tp1Price: 101.5,
  riskUsd: 1.5,
  targetRiskUsd: 1,
  nowMs: Date.parse("2026-10-09T01:00:00Z"),
  ...overrides,
});

describe("Automated PlaybookRule Promotion, Hot-Path Interception, & Rollback", () => {
  it("cannot approve a hindsight-only mistake label even if a caller reports a passing gate", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push({ ...rule(), triggerCondition: JSON.stringify({ kind: "RECURRING_MISTAKE", executionMistake: "MISTAKE_SIZING" }) });
    const evaluate = vi.fn();
    const out = await autoPromoteProposedRule("rule-1", { store, evaluate });
    expect(out.status).toBe("REJECTED");
    expect(out.gate.reason).toBe("POST_TRADE_ONLY_RULE_NOT_AUTOMATABLE");
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("does not turn removal of post-trade mistakes into replay evidence", async () => {
    const r = { ...rule(), triggerCondition: JSON.stringify({ kind: "RECURRING_MISTAKE", executionMistake: "MISTAKE_SIZING" }) };
    const samples = Array.from({ length: 100 }, (_, i) => ({ rMultiple: i < 10 ? -1 : .2, executionMistake: i < 10 ? "MISTAKE_SIZING" : "MISTAKE_NONE" }));
    const out = await evaluateProposedRuleDeterministically(r, samples);
    expect(out.passed).toBe(false);
    expect(out.candidate).toEqual(out.baseline);
    expect(out.replayReference.valid).toBe(false);
  });
  it("keeps a proposed rule pending after a transient worker timeout", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule());
    const snapshot = { sampleCount: 100, executedTradeCount: 100, blockedTradeCount: 0, totalR: 0, expectancyR: 0, maxDrawdownR: 0 };
    const out = await autoPromoteProposedRule("rule-1", { store, evaluate: async () => ({ passed: false, reason: "WORKER_TIMEOUT", baseline: snapshot, candidate: snapshot, tradeRetentionPct: 100, maxDrawdownReductionPct: 0,
      replayReference: { source: "worker", valid: false, errors: ["WORKER_TIMEOUT"], tradeCount: 0 } }) });
    expect(out.status).toBe("PROPOSED");
    expect(store.events.at(-1)!.type).toBe("RULE_GATE_DEFERRED");
  });
  it("Gatekeeper: PROPOSED auto-APPROVED only when deterministic replay metrics pass", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule());
    const passing: RuleGateEvaluation = {
      passed: true,
      reason: "EXPECTANCY_IMPROVED",
      baseline: { sampleCount: 100, executedTradeCount: 100, blockedTradeCount: 0, totalR: -10, expectancyR: -0.1, maxDrawdownR: 5 },
      candidate: { sampleCount: 100, executedTradeCount: 80, blockedTradeCount: 20, totalR: 4, expectancyR: 0.05, maxDrawdownR: 4 },
      tradeRetentionPct: 80,
      maxDrawdownReductionPct: 20,
      replayReference: { source: "TEST_FIXTURE", valid: true, errors: [], tradeCount: 100 },
    };

    const result = await autoPromoteProposedRule("rule-1", {
      store,
      evaluate: async () => passing,
    });

    expect(result.status).toBe("APPROVED");
    expect(store.rules[0]!.status).toBe("APPROVED");
    expect(store.events.some((e) => e.type === "RULE_AUTO_PROMOTED")).toBe(true);
  });

  it("Gatekeeper: trade paralysis (>30% cut) rejects walau expectancy meningkat", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule());
    const failing: RuleGateEvaluation = {
      passed: false,
      reason: "TRADE_RETENTION_BELOW_70_PCT",
      baseline: { sampleCount: 100, executedTradeCount: 100, blockedTradeCount: 0, totalR: -10, expectancyR: -0.1, maxDrawdownR: 5 },
      candidate: { sampleCount: 100, executedTradeCount: 60, blockedTradeCount: 40, totalR: 10, expectancyR: 0.1667, maxDrawdownR: 2 },
      tradeRetentionPct: 60,
      maxDrawdownReductionPct: 60,
      replayReference: { source: "TEST_FIXTURE", valid: true, errors: [], tradeCount: 100 },
    };

    const result = await autoPromoteProposedRule("rule-1", { store, evaluate: async () => failing });

    expect(result.status).toBe("REJECTED");
    expect(store.rules[0]!.status).toBe("REJECTED");
    expect(store.events.find((e) => e.type === "RULE_AUTO_REJECTED")?.payload.reason).toBe("TRADE_RETENTION_BELOW_70_PCT");
  });

  it("Hot Path: APPROVED rule memblokir sinyal, violatedCount naik, event tercatat", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule("APPROVED"));

    const result = await interceptApprovedPlaybookRules(signal(), { store });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toEqual(["rule-1"]);
    expect(store.rules[0]!.violatedCount).toBe(1);
    expect(store.events).toContainEqual(expect.objectContaining({
      type: "ORDER_BLOCKED_BY_RULE",
      payload: expect.objectContaining({ ruleId: "rule-1", symbol: "BTCUSDT" }),
    }));
  });

  it("Hot Path: sinyal patuh lalu order sukses mencatat appliedCount", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule("APPROVED"));

    const result = await interceptApprovedPlaybookRules(signal({ riskUsd: 1 }), { store });
    expect(result.allowed).toBe(true);
    expect(result.appliedRuleIds).toEqual(["rule-1"]);

    await recordApprovedRuleApplication(result.appliedRuleIds, { store, tradeId: 123, rMultiple: 1.5 });

    expect(store.rules[0]!.appliedCount).toBe(1);
    expect(store.events).toContainEqual(expect.objectContaining({
      type: "RULE_APPLIED",
      payload: expect.objectContaining({ ruleId: "rule-1", tradeId: 123, rMultiple: 1.5 }),
    }));
  });

  it("Auto-Rollback: tiga RULE_FRICTION beruntun mengubah APPROVED menjadi ROLLED_BACK", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule("APPROVED"));
    store.events.push(
      { id: 1, type: "RULE_FRICTION", severity: "warn", payload: { ruleId: "rule-1", rMultiple: -1 }, createdAt: new Date() },
      { id: 2, type: "RULE_FRICTION", severity: "warn", payload: { ruleId: "rule-1", rMultiple: -1 }, createdAt: new Date() },
      { id: 3, type: "RULE_FRICTION", severity: "warn", payload: { ruleId: "rule-1", rMultiple: -1 }, createdAt: new Date() },
    );

    const result = await autoRollbackRuleIfNeeded("rule-1", { store });

    expect(result.rolledBack).toBe(true);
    expect(result.reason).toBe("CONSECUTIVE_FRICTION_THRESHOLD");
    expect(store.rules[0]!.status).toBe("ROLLED_BACK");
    expect(store.events.at(-1)).toMatchObject({
      type: "RULE_AUTO_ROLLBACK",
      payload: expect.objectContaining({ ruleId: "rule-1" }),
    });
  });

  it("Auto-Rollback: akumulasi trade terpengaruh <= -2R juga mematikan rule", async () => {
    const store = new MemoryPlaybookStore();
    store.rules.push(rule("APPROVED"));
    store.events.push(
      { id: 1, type: "RULE_APPLIED", severity: "info", payload: { ruleId: "rule-1", rMultiple: -1.2 }, createdAt: new Date() },
      { id: 2, type: "RULE_APPLIED", severity: "info", payload: { ruleId: "rule-1", rMultiple: -0.9 }, createdAt: new Date() },
    );

    const result = await autoRollbackRuleIfNeeded("rule-1", { store });

    expect(result.rolledBack).toBe(true);
    expect(result.reason).toBe("RULE_NET_DRAWDOWN_THRESHOLD");
    expect(store.rules[0]!.status).toBe("ROLLED_BACK");
  });
});
