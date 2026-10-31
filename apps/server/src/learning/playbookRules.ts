// SMB T-05/T-06 (9 Okt 2026): aturan If-Then playbook + telemetry friction.
// Aturan baru lahir PROPOSED; runner deterministik dapat mempromosikan otomatis
// hanya setelah replay gate lolos. Tidak ada LLM yang menghitung metrik/menentukan status.
//
// Desain friction (jujur): aturan DERIVED punya trigger terstruktur (JSON) sehingga
// pelanggaran dapat diukur deterministik: trade yang menutup dengan tipe kesalahan
// yang sama dengan trigger aturan APPROVED = VIOLATED; trade bersih = APPLIED.
// Aturan MANUAL berisi teks bebas — friction-nya hanya bisa ditandai manual oleh
// operator lewat CLI (sistem tidak menebak makna teks bebas).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../core/db.js";
import { runWorkerTask } from "../backtest/runWorker.js";

import { RECURRING_MISTAKE_THRESHOLDS } from "../analytics/metricsRegistry.js";
import type { ExecutionMistake } from "./executionMistakes.js";

export const PLAYBOOK_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "ARCHIVED", "ROLLED_BACK"] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** Automated rule lifecycle constants. All decisions are deterministic TypeScript. */
export const AUTOMATED_RULE_LIMITS = {
  MIN_REPLAY_TRADES: 100,
  MIN_TRADE_RETENTION_PCT: 70,
  MIN_DRAWDOWN_REDUCTION_PCT: 10,
  MAX_CONSECUTIVE_FRICTION: 3,
  MAX_RULE_DRAWDOWN_R: -2,
} as const;
export const PLAYBOOK_SOURCES = ["MANUAL", "DERIVED"] as const;
export type PlaybookSource = (typeof PLAYBOOK_SOURCES)[number];

export interface RuleMetricSnapshot {
  sampleCount: number;
  executedTradeCount: number;
  blockedTradeCount: number;
  totalR: number;
  expectancyR: number;
  maxDrawdownR: number;
}

export interface RuleGateEvaluation {
  passed: boolean;
  reason: string;
  baseline: RuleMetricSnapshot;
  candidate: RuleMetricSnapshot;
  tradeRetentionPct: number;
  maxDrawdownReductionPct: number;
  replayReference: { source: string; valid: boolean; errors: string[]; tradeCount: number };
}

export interface RuleSignalContext {
  symbol: string;
  side: "LONG" | "SHORT";
  mode: string;
  strategyId?: string | null;
  entryPrice: number;
  slPrice: number;
  tp1Price?: number | null;
  riskUsd: number;
  targetRiskUsd: number;
  nowMs: number;
  [key: string]: unknown;
}

export interface RuleTelemetryEvent {
  id: number;
  type: string;
  severity: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PlaybookRuleStore {
  findRule(id: string): Promise<PlaybookRuleRow | null>;
  listProposedRules(limit: number): Promise<PlaybookRuleRow[]>;
  listApprovedRules(): Promise<PlaybookRuleRow[]>;
  updateRule(id: string, data: Partial<Pick<PlaybookRuleRow, "status" | "appliedCount" | "violatedCount" | "updatedAt">>): Promise<PlaybookRuleRow>;
  appendEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void>;
  listRuleEvents(ruleId: string): Promise<RuleTelemetryEvent[]>;
  listAllRuleEvents?(): Promise<RuleTelemetryEvent[]>;
  loadRecentSamples(limit: number): Promise<Array<{ rMultiple: number; blockedByRuleIds?: string[]; tradeId?: number; executionMistake?: string | null; symbol?: string }>>;
}

export interface RuleGateRunnerOptions {
  store: PlaybookRuleStore;
  evaluate: (rule: PlaybookRuleRow, samples: Array<{ rMultiple: number; blockedByRuleIds?: string[]; tradeId?: number }>) => Promise<RuleGateEvaluation>;
}

export interface PlaybookRuleRow {
  id: string;
  ruleText: string;
  triggerCondition: string;
  actionStatement: string;
  source: string;
  status: string;
  appliedCount: number;
  violatedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DerivedTrigger {
  kind: "RECURRING_MISTAKE";
  executionMistake: ExecutionMistake;
}

export function parseDerivedTrigger(triggerCondition: string): DerivedTrigger | null {
  try {
    const parsed: unknown = JSON.parse(triggerCondition);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (p.kind !== "RECURRING_MISTAKE" || typeof p.executionMistake !== "string") return null;
    return { kind: "RECURRING_MISTAKE", executionMistake: p.executionMistake as ExecutionMistake };
  } catch {
    return null;
  }
}

/** frictionScore: rasio pelanggaran terhadap total observasi aturan (0..1). */
export function frictionScore(appliedCount: number, violatedCount: number): number {
  const total = appliedCount + violatedCount;
  return total > 0 ? violatedCount / total : 0;
}

/**
 * Buat draft aturan PROPOSED dari kesalahan berulang. Idempoten: tidak membuat
 * duplikat bila sudah ada draft PROPOSED dengan trigger yang sama.
 */
export async function proposeRuleFromRecurringMistake(mistake: ExecutionMistake, occurrences: number, windowTrades: number): Promise<{ created: boolean; rule: PlaybookRuleRow }> {
  const triggerCondition = JSON.stringify({ kind: "RECURRING_MISTAKE", executionMistake: mistake } satisfies DerivedTrigger);
  const existing = await db.playbookRule.findFirst({ where: { triggerCondition, status: { in: ["PROPOSED", "APPROVED", "REJECTED"] } } });
  if (existing) return { created: false, rule: existing as unknown as PlaybookRuleRow };
  const rule = await db.playbookRule.create({
    data: {
      ruleText: `${mistake} terjadi ${occurrences}x dalam ${windowTrades} trade terakhir (ambang ${RECURRING_MISTAKE_THRESHOLDS.MIN_OCCURRENCES}). Perlu aturan If-Then otomatis untuk mencegahnya.`,
      triggerCondition,
      actionStatement: `Jika kondisi pemicu ${mistake} terdeteksi pada sinyal yang dapat diukur, blokir entry secara deterministik; jika tidak tersedia pada pre-entry, catat sebagai post-trade friction.`,
      source: "DERIVED",
      status: "PROPOSED",
    },
  });
  const typedRule = rule as unknown as PlaybookRuleRow;
  // Autonomous trigger: promotion starts without the operator CLI; the periodic
  // runner retries the same deterministic gate after transient failures.
  scheduleRulePromotion(typedRule.id);
  return { created: true, rule: typedRule };
}

export async function loadApprovedRules(): Promise<PlaybookRuleRow[]> {
  const rows = await db.playbookRule.findMany({ where: { status: "APPROVED" }, orderBy: { createdAt: "asc" } });
  return rows as unknown as PlaybookRuleRow[];
}

export interface FrictionOutcome {
  rule: PlaybookRuleRow;
  outcome: "VIOLATED" | "APPLIED" | "NOT_APPLICABLE";
}

/**
 * Evaluasi friction deterministik untuk satu trade tertutup:
 * - VIOLATED  : trade mencatat kesalahan eksekusi yang sama dengan trigger aturan.
 * - APPLIED   : aturan relevan dan trade TIDAK mencatat kesalahan itu (aturan bertahan).
 * - NOT_APPLICABLE : trigger aturan tidak cocok dengan konteks trade.
 */
export function evaluateRuleFriction(rule: PlaybookRuleRow, tradeMistake: ExecutionMistake): FrictionOutcome["outcome"] {
  const trigger = parseDerivedTrigger(rule.triggerCondition);
  if (!trigger) return "NOT_APPLICABLE"; // aturan teks bebas: tidak dinilai mesin
  return tradeMistake === trigger.executionMistake ? "VIOLATED" : "APPLIED";
}

/**
 * Terapkan hasil friction ke DB + EventLog. Dipanggil dari post-mortem setelah
 * klasifikasi kesalahan eksekusi tersimpan. Return daftar event untuk jurnal.
 */
export async function recordRuleFriction(rules: PlaybookRuleRow[], tradeMistake: ExecutionMistake, tradeId: number): Promise<FrictionOutcome[]> {
  const outcomes: FrictionOutcome[] = [];
  for (const rule of rules) {
    const outcome = evaluateRuleFriction(rule, tradeMistake);
    if (outcome === "NOT_APPLICABLE") { outcomes.push({ rule, outcome }); continue; }
    const inc = outcome === "VIOLATED" ? { violatedCount: { increment: 1 } } : { appliedCount: { increment: 1 } };
    await db.playbookRule.update({ where: { id: rule.id }, data: { ...inc, updatedAt: new Date() } });
    rule.appliedCount += outcome === "APPLIED" ? 1 : 0;
    rule.violatedCount += outcome === "VIOLATED" ? 1 : 0;
    if (outcome === "VIOLATED") {
      await db.eventLog.create({
        data: {
          type: "RULE_FRICTION",
          severity: "warn",
          payload: JSON.stringify({ ruleId: rule.id, tradeId, executionMistake: tradeMistake, trigger: rule.triggerCondition }),
        },
      });
    }
    outcomes.push({ rule, outcome });
  }
  return outcomes;
}

function conditionMatches(rule: PlaybookRuleRow, signal: RuleSignalContext): { matches: boolean; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(rule.triggerCondition); } catch { return { matches: false, reason: "TRIGGER_NOT_MACHINE_READABLE" }; }
  if (!parsed || typeof parsed !== "object") return { matches: false, reason: "TRIGGER_NOT_OBJECT" };
  const p = parsed as Record<string, unknown>;
  if (p.kind === "RECURRING_MISTAKE") return { matches: false, reason: "POST_TRADE_TRIGGER_NOT_PRE_ENTRY" };
  if (p.kind !== "PRE_TRADE_GUARD" || typeof p.field !== "string" || typeof p.operator !== "string") return { matches: false, reason: "UNSUPPORTED_TRIGGER" };
  const actual = signal[p.field];
  const expected = p.value;
  if (typeof actual !== "number" || typeof expected !== "number" || !Number.isFinite(actual) || !Number.isFinite(expected)) {
    return { matches: false, reason: `TRIGGER_DATA_UNKNOWN:${p.field}` };
  }
  const matches = p.operator === "GT" ? actual > expected
    : p.operator === "GTE" ? actual >= expected
    : p.operator === "LT" ? actual < expected
    : p.operator === "LTE" ? actual <= expected
    : p.operator === "EQ" ? actual === expected : false;
  return { matches, reason: `${p.field} ${p.operator} ${expected}; actual=${actual}` };
}

export function evaluateRuleAgainstSignal(rule: PlaybookRuleRow, signal: RuleSignalContext): { matches: boolean; reason: string } {
  return conditionMatches(rule, signal);
}

/** Hot-path interception. Only APPROVED rules can block; ROLLED_BACK never blocks. */
export async function interceptApprovedPlaybookRules(signal: RuleSignalContext, options: { store: PlaybookRuleStore }): Promise<{ allowed: boolean; blockedBy: string[]; appliedRuleIds: string[]; reasons: string[] }> {
  const blockedBy: string[] = [];
  const appliedRuleIds: string[] = [];
  const reasons: string[] = [];
  for (const rule of await options.store.listApprovedRules()) {
    const check = evaluateRuleAgainstSignal(rule, signal);
    reasons.push(`${rule.id}:${check.reason}`);
    if (check.matches) {
      blockedBy.push(rule.id);
      await options.store.updateRule(rule.id, { violatedCount: rule.violatedCount + 1, updatedAt: new Date() });
      await options.store.appendEvent("ORDER_BLOCKED_BY_RULE", "warn", {
        ruleId: rule.id, symbol: signal.symbol, side: signal.side, strategyId: signal.strategyId ?? null,
        reason: check.reason, action: rule.actionStatement,
      });
    } else if (!check.reason.includes("TRIGGER") && check.reason !== "POST_TRADE_TRIGGER_NOT_PRE_ENTRY") {
      appliedRuleIds.push(rule.id);
    }
  }
  return { allowed: blockedBy.length === 0, blockedBy, appliedRuleIds, reasons };
}

export async function recordApprovedRuleApplication(ruleIds: string[], input: { store: PlaybookRuleStore; tradeId: number; rMultiple: number | null }): Promise<void> {
  for (const ruleId of ruleIds) {
    const rule = await input.store.findRule(ruleId);
    if (!rule || rule.status !== "APPROVED") continue;
    await input.store.updateRule(ruleId, { appliedCount: rule.appliedCount + 1, updatedAt: new Date() });
    await input.store.appendEvent("RULE_APPLIED", "info", { ruleId, tradeId: input.tradeId, positionId: input.tradeId, rMultiple: input.rMultiple });
  }
}

/** Attach the realized trade R to the rule application recorded before the order. */
export async function recordApprovedRuleOutcomeForTrade(positionId: number, rMultiple: number, options: { store: PlaybookRuleStore }): Promise<void> {
  const events = options.store.listAllRuleEvents
    ? await options.store.listAllRuleEvents()
    : [];
  for (const event of events) {
    if (event.type !== "RULE_APPLIED") continue;
    const eventPositionId = event.payload.positionId ?? event.payload.tradeId;
    if (eventPositionId !== positionId && eventPositionId !== String(positionId)) continue;
    const ruleId = event.payload.ruleId;
    if (typeof ruleId !== "string") continue;
    await options.store.appendEvent("RULE_TRADE_OUTCOME", "info", { ruleId, positionId, tradeId: positionId, rMultiple });
  }
}

function validateGateMetrics(gate: RuleGateEvaluation): string | null {
  const numeric = [gate.baseline.sampleCount, gate.baseline.executedTradeCount, gate.baseline.blockedTradeCount, gate.baseline.expectancyR, gate.baseline.maxDrawdownR, gate.candidate.sampleCount, gate.candidate.executedTradeCount, gate.candidate.blockedTradeCount, gate.candidate.expectancyR, gate.candidate.maxDrawdownR, gate.tradeRetentionPct, gate.maxDrawdownReductionPct];
  if (!numeric.every(Number.isFinite)) return "INVALID_GATE_METRICS";
  if (!gate.replayReference.valid || gate.replayReference.tradeCount < AUTOMATED_RULE_LIMITS.MIN_REPLAY_TRADES) return "REPLAY_EVIDENCE_BELOW_100_TRADES";
  return null;
}

export async function autoPromoteProposedRule(ruleId: string, options: RuleGateRunnerOptions): Promise<{ status: PlaybookStatus; gate: RuleGateEvaluation; rule: PlaybookRuleRow }> {
  const rule = await options.store.findRule(ruleId);
  if (!rule) throw new Error("RULE_NOT_FOUND");
  const samples = await options.store.loadRecentSamples(AUTOMATED_RULE_LIMITS.MIN_REPLAY_TRADES);
  // A label known only after close is not an entry predicate. Never accept a
  // fabricated improvement from deleting those outcomes, even from a caller.
  const postTradeOnly = parseDerivedTrigger(rule.triggerCondition) !== null;
  const baseline = metricsFromSamples(samples);
  const gate = postTradeOnly ? {
    passed: false, reason: "POST_TRADE_ONLY_RULE_NOT_AUTOMATABLE", baseline, candidate: baseline,
    tradeRetentionPct: 100, maxDrawdownReductionPct: 0,
    replayReference: { source: "NONE", valid: false, errors: ["NO_PRE_ENTRY_PREDICATE"], tradeCount: 0 },
  } : await options.evaluate(rule, samples);
  const metricError = validateGateMetrics(gate);
  const expectancyImproved = gate.candidate.expectancyR > gate.baseline.expectancyR;
  const drawdownReduced = gate.maxDrawdownReductionPct >= AUTOMATED_RULE_LIMITS.MIN_DRAWDOWN_REDUCTION_PCT;
  const retentionPass = gate.tradeRetentionPct >= AUTOMATED_RULE_LIMITS.MIN_TRADE_RETENTION_PCT;
  const pass = rule.status === "PROPOSED" && !metricError && gate.passed && (expectancyImproved || drawdownReduced) && retentionPass;
  const transient = !postTradeOnly && !gate.replayReference.valid && gate.replayReference.errors.some(e => /TIMEOUT|WORKER|NO_VALID|NO_CLOSED|INSUFFICIENT|BELOW/.test(e));
  const status: PlaybookStatus = pass ? "APPROVED" : transient ? "PROPOSED" : "REJECTED";
  const reason = postTradeOnly ? gate.reason : metricError ?? (pass ? "DETERMINISTIC_GATE_PASSED" : gate.reason);
  const updated = await options.store.updateRule(ruleId, { status, updatedAt: new Date() });
  await options.store.appendEvent(pass ? "RULE_AUTO_PROMOTED" : transient ? "RULE_GATE_DEFERRED" : "RULE_AUTO_REJECTED", pass ? "info" : "warn", {
    ruleId, status, reason, baseline: gate.baseline, candidate: gate.candidate,
    tradeRetentionPct: gate.tradeRetentionPct, maxDrawdownReductionPct: gate.maxDrawdownReductionPct,
    replayReference: gate.replayReference,
  });
  return { status, gate: { ...gate, reason }, rule: updated };
}

export async function autoRollbackRuleIfNeeded(ruleId: string, options: { store: PlaybookRuleStore }): Promise<{ rolledBack: boolean; reason: string | null; rule: PlaybookRuleRow }> {
  const rule = await options.store.findRule(ruleId);
  if (!rule) throw new Error("RULE_NOT_FOUND");
  if (rule.status !== "APPROVED") return { rolledBack: false, reason: null, rule };
  if (parseDerivedTrigger(rule.triggerCondition)) {
    const reason = "POST_TRADE_ONLY_RULE_NOT_AUTOMATABLE";
    const updated = await options.store.updateRule(ruleId, { status: "ROLLED_BACK", updatedAt: new Date() });
    await options.store.appendEvent("RULE_AUTO_ROLLBACK", "warn", { ruleId, reason, from: "APPROVED", to: "ROLLED_BACK" });
    return { rolledBack: true, reason, rule: updated };
  }
  const events = await options.store.listRuleEvents(ruleId);
  const ordered = events.slice().sort((a, b) => b.id - a.id);
  let consecutiveFriction = 0;
  for (const event of ordered) {
    if (event.type !== "RULE_FRICTION") break;
    consecutiveFriction += 1;
  }
  const netR = events.reduce((sum, event) => {
    const value = event.payload.rMultiple;
    return typeof value === "number" && Number.isFinite(value) && (event.type === "RULE_TRADE_OUTCOME" || event.type === "RULE_APPLIED" || event.type === "RULE_FRICTION") ? sum + value : sum;
  }, 0);
  const reason = consecutiveFriction >= AUTOMATED_RULE_LIMITS.MAX_CONSECUTIVE_FRICTION
    ? "CONSECUTIVE_FRICTION_THRESHOLD"
    : netR <= AUTOMATED_RULE_LIMITS.MAX_RULE_DRAWDOWN_R ? "RULE_NET_DRAWDOWN_THRESHOLD" : null;
  if (!reason) return { rolledBack: false, reason: null, rule };
  const updated = await options.store.updateRule(ruleId, { status: "ROLLED_BACK", updatedAt: new Date() });
  await options.store.appendEvent("RULE_AUTO_ROLLBACK", "error", { ruleId, from: "APPROVED", to: "ROLLED_BACK", reason, consecutiveFriction, netR });
  return { rolledBack: true, reason, rule: updated };
}

function parseEventPayload(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Prisma-backed store: production path for promotion, hot-path telemetry, and rollback. */
export const prismaPlaybookRuleStore: PlaybookRuleStore = {
  async findRule(id) {
    const row = await db.playbookRule.findUnique({ where: { id } });
    return row as unknown as PlaybookRuleRow | null;
  },
  async listProposedRules(limit) {
    const rows = await db.playbookRule.findMany({ where: { status: "PROPOSED" }, orderBy: { createdAt: "asc" }, take: limit });
    return rows as unknown as PlaybookRuleRow[];
  },
  async listApprovedRules() {
    const rows = await db.playbookRule.findMany({ where: { status: "APPROVED" }, orderBy: { createdAt: "asc" } });
    return rows as unknown as PlaybookRuleRow[];
  },
  async updateRule(id, data) {
    const row = await db.playbookRule.update({ where: { id }, data });
    return row as unknown as PlaybookRuleRow;
  },
  async appendEvent(type, severity, payload) {
    await db.eventLog.create({ data: { type, severity, payload: JSON.stringify(payload) } });
  },
  async listRuleEvents(ruleId) {
    const rows = await this.listAllRuleEvents!();
    return rows.filter((row) => row.payload.ruleId === ruleId);
  },
  async listAllRuleEvents() {
    const rows = await db.eventLog.findMany({
      where: { type: { in: ["RULE_FRICTION", "RULE_APPLIED", "RULE_TRADE_OUTCOME", "ORDER_BLOCKED_BY_RULE"] } },
      orderBy: { id: "desc" }, take: 500,
    });
    return rows.flatMap((row) => {
      const payload = parseEventPayload(row.payload);
      return [{ id: row.id, type: row.type, severity: row.severity, payload, createdAt: row.createdAt }];
    });
  },
  async loadRecentSamples(limit) {
    const rows = await db.learningEntry.findMany({
      where: { tradeId: { not: null }, trade: { is: { source: { not: "DEMO" } } } },
      include: { trade: true }, orderBy: { createdAt: "desc" }, take: limit,
    });
    return rows.flatMap((row) => row.trade ? [{
      rMultiple: Number(row.trade.rMultiple), tradeId: row.trade.id, symbol: row.trade.symbol,
      executionMistake: row.executionMistake ?? null,
    }] : []);
  },
};

function sampleMatchesRule(rule: PlaybookRuleRow, sample: { executionMistake?: string | null; riskUsd?: number; targetRiskUsd?: number }): boolean {
  const recurring = parseDerivedTrigger(rule.triggerCondition);
  if (recurring) return sample.executionMistake === recurring.executionMistake;
  return false;
}

function metricsFromSamples(samples: Array<{ rMultiple: number }>): RuleMetricSnapshot {
  const valid = samples.map((s) => s.rMultiple).filter(Number.isFinite);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of valid) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cumulative);
  }
  return {
    sampleCount: valid.length,
    executedTradeCount: valid.length,
    blockedTradeCount: 0,
    totalR: valid.reduce((sum, value) => sum + value, 0),
    expectancyR: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0,
    maxDrawdownR,
  };
}

function replayGateCandidateFiles(): string[] {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  return [
    path.resolve(root, "apps/server/data/datasets/BTCUSDT_1m_90d.json"),
    path.resolve(root, "apps/server/data/datasets/BTCUSDT_2026.json"),
  ];
}

/**
 * 14 Okt 2026 (BUG FIX hang boot): replay dataset 1m 90 hari (~130 ribu bar)
// tidak boleh jalan di main thread — dulu versi sinkronnya memblokir event
 * loop berbab menit setiap boot (API 000, funnel & supervisor mati). Replay
 * kini dieksekusi di worker thread (replayGateWorker.ts) dengan timeout
 * fail-closed: kalau worker tidak selesai tepat waktu, gate dianggap tidak
 * valid (tidak pernah fabricate hasil).
 */
async function loadNearestValidReplayReference(): Promise<{ source: string; valid: boolean; errors: string[]; tradeCount: number }> {
  try {
    return await runWorkerTask(new URL("./replayGateWorker.js", import.meta.url), {
      candidates: replayGateCandidateFiles(), strategyId: "S-01", mode: "SCALP",
    } satisfies import("./replayGateWorker.js").ReplayGateRequest);
  } catch (error) {
    return { source: "LOCAL_HISTORICAL_REPLAY", valid: false,
      errors: [error instanceof Error ? error.message.slice(0, 180) : "REPLAY_WORKER_ERROR"], tradeCount: 0 };
  }
}

/** Deterministic gate used by the autonomous runner after a PROPOSED draft. */
export async function evaluateProposedRuleDeterministically(rule: PlaybookRuleRow, samples: Array<{ rMultiple: number; executionMistake?: string | null }>): Promise<RuleGateEvaluation> {
  const baseline = metricsFromSamples(samples);
  // There is no historical pre-entry feature store for these rule predicates.
  // A generic S-01 replay cannot certify a different filter. Keep the missing
  // experiment explicit instead of deleting losing outcomes with hindsight.
  const reason = parseDerivedTrigger(rule.triggerCondition) ? "POST_TRADE_ONLY_RULE_NOT_AUTOMATABLE" : "RULE_SPECIFIC_PRE_ENTRY_REPLAY_UNSUPPORTED";
  return {
    passed: false, reason, baseline, candidate: { ...baseline }, tradeRetentionPct: 100, maxDrawdownReductionPct: 0,
    replayReference: { source: "NONE", valid: false, errors: [reason], tradeCount: 0 },
  };
}

let promotionInFlight: Promise<void> | null = null;
const rulePromotionInFlight = new Set<string>();

/** Triggered directly when a draft is created; periodic runner is the retry/recovery path. */
export function scheduleRulePromotion(ruleId: string): void {
  if (rulePromotionInFlight.has(ruleId)) return;
  rulePromotionInFlight.add(ruleId);
  void autoPromoteProposedRule(ruleId, { store: prismaPlaybookRuleStore, evaluate: evaluateProposedRuleDeterministically })
    .catch((error) => prismaPlaybookRuleStore.appendEvent("RULE_AUTO_PROMOTION_FAILED", "error", { ruleId, reason: error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN" }))
    .finally(() => rulePromotionInFlight.delete(ruleId));
}

export async function runAutomatedPlaybookRuleCycle(): Promise<void> {
  for (const rule of await prismaPlaybookRuleStore.listProposedRules(10)) scheduleRulePromotion(rule.id);
  for (const rule of await prismaPlaybookRuleStore.listApprovedRules()) {
    await autoRollbackRuleIfNeeded(rule.id, { store: prismaPlaybookRuleStore });
  }
}

export function startAutomatedPlaybookRuleRunner(intervalMs = 60_000): () => void {
  void runAutomatedPlaybookRuleCycle().catch(() => undefined);
  const timer = setInterval(() => { void runAutomatedPlaybookRuleCycle().catch(() => undefined); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function formatRuleSummary(rules: PlaybookRuleRow[]): string[] {
  return rules.map((r) => `- [${r.status}] ${r.ruleText.slice(0, 140)} (applied ${r.appliedCount}, violated ${r.violatedCount}, friction ${(frictionScore(r.appliedCount, r.violatedCount) * 100).toFixed(1)}%)`);
}
