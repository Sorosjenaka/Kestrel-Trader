// apps/server/src/learning/swingEvalLoop.ts
//
// Persistent evaluation loop for the THREE active SWING PAPER subjects:
// RSW-01 (Orion), RSW-02 (Vega), RSW-03 (Draco).
// S-03 (Atlas / Fibonacci) is archived for NEW SWING work by operator order.
// S-05 (Polaris) joined the archive 21 Okt 2026 (Phase 2 plan audit): its entry
// was retired 20 Okt 2026 (negative edge), so evaluating it only burned LLM cost
// on a strategy that can no longer open a position. The S-05 engine itself
// stays alive for historical replay and for the standalone forward-paper
// worker; both are independent of this loop.
//
// Scope boundaries:
//  - No exchange client, no private endpoint, no order/cancel/ARM.
//  - No change to active strategy config, exit policy, risk, leverage, margin.
//  - LLM output is interpretation only, schema-validated; all money numbers are
//    computed by deterministic code from the ledger.
//  - Automatic execution is limited to RECHECK_BASELINE (same config). A
//    parameter-changing proposal is stored for operator review, never applied.
//
// State machine:
//   EVALUATION_QUEUED -> EVALUATING -> FEEDBACK_VALIDATED
//   -> EXPERIMENT_PROPOSED -> EXPERIMENT_VALIDATED
//   -> BACKTEST_QUEUED -> BACKTEST_RUNNING -> BACKTEST_COMPLETED -> OOS_GATE
//   -> PAPER_QUEUED -> PAPER_RUNNING -> REVIEW_DUE -> EVALUATION_QUEUED
//
// Branches: NO_CHANGE, REJECTED, INSUFFICIENT_DATA, NEEDS_OPERATOR, FAILED,
// RETRY_PENDING, ARCHIVED.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { db } from "../core/db.js";
import { defaultLlmAdapter, type XkiroAdapter } from "../agents/llmAdapter.js";
import { ALL_12_AGENTS } from "../agents/agentCatalog.js";
import { logResearchFinding } from "./researchFinding.js";
import { SWING_EVAL_IDS, SWING_EVAL_STRATEGIES, swingEvalStrategy, buildSwingThesisCard, archivedSwingStrategy } from "./swingEvalRegistry.js";
import { candidateParameterHash, createPaperCandidate } from "./paperCandidateHarness.js";

export const SWING_EVAL_STATES = [
  "EVALUATION_QUEUED", "EVALUATING", "FEEDBACK_VALIDATED",
  "EXPERIMENT_PROPOSED", "EXPERIMENT_VALIDATED",
  "BACKTEST_QUEUED", "BACKTEST_RUNNING", "BACKTEST_COMPLETED", "OOS_GATE",
  "PAPER_QUEUED", "PAPER_RUNNING", "REVIEW_DUE",
  "NO_CHANGE", "REJECTED", "INSUFFICIENT_DATA", "NEEDS_OPERATOR",
  "FAILED", "RETRY_PENDING", "ARCHIVED",
] as const;
export type SwingEvalState = (typeof SWING_EVAL_STATES)[number];

const TERMINAL = new Set<SwingEvalState>(["NO_CHANGE", "REJECTED", "INSUFFICIENT_DATA", "NEEDS_OPERATOR", "FAILED", "ARCHIVED"]);
const ACTIVE = new Set<SwingEvalState>([
  "EVALUATION_QUEUED", "EVALUATING", "FEEDBACK_VALIDATED", "EXPERIMENT_PROPOSED",
  "EXPERIMENT_VALIDATED", "BACKTEST_QUEUED", "BACKTEST_RUNNING", "BACKTEST_COMPLETED",
  "OOS_GATE", "PAPER_QUEUED", "PAPER_RUNNING", "REVIEW_DUE", "RETRY_PENDING",
]);

export function isTerminalSwingEvalState(state: SwingEvalState): boolean {
  return TERMINAL.has(state);
}
export function isActiveSwingEvalState(state: SwingEvalState): boolean {
  return ACTIVE.has(state);
}

/** Only these transitions are legal. Terminal states never move. */
const TRANSITIONS: Record<SwingEvalState, readonly SwingEvalState[]> = {
  EVALUATION_QUEUED: ["EVALUATING", "INSUFFICIENT_DATA", "FAILED", "RETRY_PENDING"],
  EVALUATING: ["FEEDBACK_VALIDATED", "NO_CHANGE", "INSUFFICIENT_DATA", "RETRY_PENDING", "FAILED"],
  FEEDBACK_VALIDATED: ["EXPERIMENT_PROPOSED", "NO_CHANGE", "NEEDS_OPERATOR", "FAILED"],
  EXPERIMENT_PROPOSED: ["EXPERIMENT_VALIDATED", "NEEDS_OPERATOR", "REJECTED", "FAILED"],
  EXPERIMENT_VALIDATED: ["BACKTEST_QUEUED", "REJECTED", "FAILED"],
  BACKTEST_QUEUED: ["BACKTEST_RUNNING", "INSUFFICIENT_DATA", "RETRY_PENDING", "FAILED"],
  BACKTEST_RUNNING: ["BACKTEST_COMPLETED", "INSUFFICIENT_DATA", "RETRY_PENDING", "FAILED"],
  BACKTEST_COMPLETED: ["OOS_GATE", "INSUFFICIENT_DATA", "REJECTED", "FAILED"],
  OOS_GATE: ["PAPER_QUEUED", "REJECTED", "INSUFFICIENT_DATA", "NEEDS_OPERATOR"],
  PAPER_QUEUED: ["PAPER_RUNNING", "NEEDS_OPERATOR", "REJECTED"],
  PAPER_RUNNING: ["REVIEW_DUE", "FAILED", "ARCHIVED"],
  REVIEW_DUE: ["EVALUATION_QUEUED", "ARCHIVED"],
  NO_CHANGE: [],
  REJECTED: [],
  INSUFFICIENT_DATA: [],
  NEEDS_OPERATOR: [],
  FAILED: [],
  RETRY_PENDING: ["EVALUATION_QUEUED", "BACKTEST_QUEUED", "ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionSwingEval(from: SwingEvalState, to: SwingEvalState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface SwingEvalTradeEvidence {
  tradeId: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  netPnlUsd: number;
  grossPnlUsd: number;
  feeUsd: number;
  /** Positive = cost paid, regardless of ledger sign convention. */
  fundingCostUsd: number;
  rMultiple: number | null;
  source: string;
  accountingQuality: string;
  feeCoverage: "RECORDED" | "ZERO_LEGACY" | "UNKNOWN";
  fundingCoverage?: "RECORDED" | "UNKNOWN" | "ZERO_LEGACY";
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
}

export interface SwingEvalAggregate {
  sampleCount: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  netPnlUsd: number;
  grossPnlUsd: number;
  feeUsd: number;
  fundingCostUsd: number;
  sumR: number;
  avgR: number | null;
  winRatePct: number | null;
  profitFactor: number | null;
  maxDrawdownUsd: number | null;
  feeCoverage: "RECORDED" | "MIXED" | "ZERO_LEGACY" | "NONE";
  fundingCoverage: "RECORDED" | "MIXED" | "ZERO_LEGACY" | "NONE";
  firstClosedAt: string | null;
  lastClosedAt: string | null;
  sources: string[];
}

export interface SwingEvalEvidence {
  strategyId: string;
  aggregate: SwingEvalAggregate;
  trades: SwingEvalTradeEvidence[];
  inputHash: string;
  cursor: number;
  notes: string[];
}

export interface SwingEvalFeedback {
  observation: string;
  edgeHypothesis: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  missingEvidence: string[];
  thesisDrift: "NONE" | "WEAKENING" | "STRENGTHENING" | "UNKNOWN";
  experiment: null | {
    /**
     * "PARAMETER_PATCH" is a DISABLED tombstone (operator D-2, 20 Okt 2026).
     * The LLM may still propose it; the validator rejects it outright for
     * every strategy, so it can never reach a backtest or a candidate cohort.
     */
    kind: "RECHECK_BASELINE" | "UNIVERSE_FILTER" | "PARAMETER_PATCH";
    rationale: string;
    preEntryFeatures: string[];
    /** For UNIVERSE_FILTER: max 4 public dataset symbols, no synthetic data. */
    symbols?: string[];
    /** Disabled with PARAMETER_PATCH; retained only so the shape stays typed. */
    patches?: { volumeContrThresh?: number; slMult?: number };
  };
  operatorProposal: string | null;
}

export interface SwingEvalRoleRun {
  role: "skeptic" | "contract";
  roleRunId: string;
  agentId: string;
  agentName: string;
  model: string | null;
  inputHash: string;
  outputHash: string | null;
  status: "VALIDATED" | "FALLBACK" | "FAILED";
  fallback: string | null;
  startedAt: string;
  latencyMs: number;
  result: Record<string, unknown> | null;
}

export interface SwingEvalLlmResult {
  ok: boolean;
  feedback: SwingEvalFeedback | null;
  model: string | null;
  provider: string | null;
  durationMs: number;
  failureCode: string | null;
  rawHash: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number } | null;
}

export interface SwingEvalBacktestResult {
  ok: boolean;
  metrics: {
    sampleCount: number;
    winrate: number;
    evUsd: number;
    totalNetPnlUsd: number;
    maxDdUsd: number;
    totalFeesUsd: number;
    totalFundingUsd: number;
    fundingCoverage?: "FULL" | "PARTIAL" | "MISSING" | "UNKNOWN";
  } | null;
  datasetHash: string | null;
  runRef: string | null;
  reasons: string[];
  diagnostics?: Record<string, unknown>;
}

export interface SwingEvalPaperResult {
  ok: boolean;
  mode: "EXISTING_ISOLATED_FORWARD" | "EXISTING_MAIN_PAPER_BASELINE" | "NONE";
  note: string;
  closedCount: number | null;
  statePath?: string | null;
  candidateId?: string | null;
  workerPid?: number | null;
}

export interface SwingEvalDeps {
  adapter?: XkiroAdapter;
  loadEvidence?: (strategyId: string, afterTradeId: number, statePath?: string | null) => Promise<SwingEvalEvidence>;
  runBacktest?: (input: { strategyId: string; evidence: SwingEvalEvidence; experiment?: SwingEvalFeedback["experiment"] }) => Promise<SwingEvalBacktestResult>;
  datasetFingerprint?: () => string | null;
  enqueuePaper?: (input: { runId: string; strategyId: string; evidence: SwingEvalEvidence; experiment?: SwingEvalFeedback["experiment"] }) => Promise<SwingEvalPaperResult>;
  writeFinding?: (input: { runId: string; strategyId: string; verdict: "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE"; conclusion: string; metrics: Record<string, unknown> }) => Promise<void>;
  logEvent?: (type: string, severity: "info" | "warn" | "error", payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
  statePath?: string;
  intervalMs?: number;
  maxRunsPerTick?: number;
  maxAttempts?: number;
}

export interface SwingEvalRun {
  runId: string;
  correlationId: string;
  strategyId: string;
  strategyVersion: string;
  trigger: "BOOTSTRAP" | "TRADE_BATCH" | "PAPER_REVIEW" | "SCHEDULE";
  state: SwingEvalState;
  parentRunId: string | null;
  cursorBefore: number;
  cursorAfter: number;
  evidenceHash: string | null;
  tradeIds: string[];
  feedback: SwingEvalFeedback | null;
  aggregate: SwingEvalAggregate | null;
  feedbackSource: "LLM" | "DETERMINISTIC_FALLBACK" | null;
  roleRuns?: SwingEvalRoleRun[];
  llm: { model: string | null; provider: string | null; durationMs: number; failureCode: string | null; usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number } | null } | null;
  experiment: SwingEvalFeedback["experiment"];
  backtest: SwingEvalBacktestResult["metrics"];
  backtestDiagnostics?: Record<string, unknown> | null;
  /** Stable trace IDs for feedback -> candidate -> backtest -> gate -> forward -> review. */
  backtestRunId?: string | null;
  gateDecisionId?: string | null;
  forwardRunId?: string | null;
  reviewRunId?: string | null;
  datasetFingerprint?: string | null;
  triggerReason?: string | null;
  nextEligibleAt?: string | null;
  gate: { passed: boolean; verdict: "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE"; reasons: string[] } | null;
  paper: SwingEvalPaperResult | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LoopStateFile {
  schemaVersion: 1;
  updatedAt: string;
  runs: Record<string, SwingEvalRun>;
  cursors: Record<string, number>;
  dedupe: Record<string, string>;
}

const EMPTY_STATE = (): LoopStateFile => ({ schemaVersion: 1, updatedAt: new Date(0).toISOString(), runs: {}, cursors: {}, dedupe: {} });

/** Atomic JSON store; one loop process owns the file. */
export class FileSwingEvalStore {
  constructor(private readonly file: string) {}
  private loaded: LoopStateFile | null = null;

  load(): LoopStateFile {
    if (this.loaded) return this.loaded;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as LoopStateFile;
      this.loaded = parsed?.schemaVersion === 1 && parsed.runs && parsed.cursors && parsed.dedupe ? parsed : EMPTY_STATE();
    } catch {
      this.loaded = EMPTY_STATE();
    }
    return this.loaded;
  }

  save(state: LoopStateFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.loaded = state;
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic aggregation from ledger rows. No LLM arithmetic. */
export function aggregateSwingEvidence(strategyId: string, trades: SwingEvalTradeEvidence[]): SwingEvalAggregate {
  const sorted = [...trades].sort((a, b) => {
    const at = a.closedAt ? Date.parse(a.closedAt) : 0;
    const bt = b.closedAt ? Date.parse(b.closedAt) : 0;
    return at - bt || a.tradeId.localeCompare(b.tradeId);
  });
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0; let losses = 0; let be = 0;
  let long = 0; let short = 0;
  let gross = 0; let net = 0; let fee = 0; let funding = 0; let sumR = 0;
  let recordedFees = 0;
  for (const t of sorted) {
    net += t.netPnlUsd;
    gross += t.grossPnlUsd;
    fee += t.feeUsd;
    funding += t.fundingCostUsd;
    sumR += t.rMultiple ?? 0;
    if (t.feeUsd > 0) recordedFees++;
    if (t.netPnlUsd > 1e-9) wins++; else if (t.netPnlUsd < -1e-9) losses++; else be++;
    if (t.side === "LONG") long++; else short++;
    cumulative += t.netPnlUsd;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
  }
  const grossWin = sorted.filter((t) => t.netPnlUsd > 0).reduce((a, t) => a + t.netPnlUsd, 0);
  const grossLoss = Math.abs(sorted.filter((t) => t.netPnlUsd < 0).reduce((a, t) => a + t.netPnlUsd, 0));
  const n = sorted.length;
  return {
    sampleCount: n,
    longTrades: long,
    shortTrades: short,
    wins, losses, breakEven: be,
    netPnlUsd: Number(net.toFixed(6)),
    grossPnlUsd: Number(gross.toFixed(6)),
    feeUsd: Number(fee.toFixed(6)),
    fundingCostUsd: Number(funding.toFixed(6)),
    sumR: Number(sumR.toFixed(6)),
    avgR: n > 0 ? Number((sumR / n).toFixed(6)) : null,
    winRatePct: n > 0 ? Number(((wins / n) * 100).toFixed(4)) : null,
    // No artificial huge number when there are no losses.
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(6)) : null,
    maxDrawdownUsd: n > 0 ? Number(maxDd.toFixed(6)) : null,
    feeCoverage: n === 0 ? "NONE" : recordedFees === n ? "RECORDED" : recordedFees === 0 ? "ZERO_LEGACY" : "MIXED",
    fundingCoverage: n === 0 ? "NONE" : sorted.every((t) => t.fundingCoverage === "RECORDED") ? "RECORDED"
      : sorted.every((t) => t.fundingCoverage === "ZERO_LEGACY") ? "ZERO_LEGACY" : "MIXED",
    firstClosedAt: sorted[0]?.closedAt ?? null,
    lastClosedAt: sorted[n - 1]?.closedAt ?? null,
    sources: [...new Set(sorted.map((t) => t.source))].sort(),
  };
}

function normalizeDbTrade(row: {
  id: number; strategyId: string | null; symbol: string; side: string; pnlUsd: number; feeUsd: number;
  fundingUsd: number; fundingVerified?: boolean; rMultiple: number; source: string | null; accountingQuality: string;
  createdAt: Date; position: { closeReason?: string | null; openedAt?: Date | null; closedAt?: Date | null } | null;
}): SwingEvalTradeEvidence | null {
  const strategyId = row.strategyId;
  if (!strategyId || !SWING_EVAL_IDS.includes(strategyId)) return null;
  const side = row.side === "LONG" || row.side === "SHORT" ? row.side : null;
  if (!side) return null;
  const net = asFinite(row.pnlUsd); const fee = asFinite(row.feeUsd); const fund = asFinite(row.fundingUsd);
  if (net === null || fee === null || fund === null) return null;
  const fundingCost = -fund; // DB convention: negative = paid.
  return {
    tradeId: `db:${row.id}`,
    strategyId,
    symbol: row.symbol,
    side,
    netPnlUsd: net,
    grossPnlUsd: Number((net + fee - fund).toFixed(6)),
    feeUsd: fee,
    fundingCostUsd: Number(fundingCost.toFixed(6)),
    rMultiple: asFinite(row.rMultiple),
    source: row.source ?? "UNKNOWN",
    accountingQuality: row.accountingQuality,
    feeCoverage: fee > 0 ? "RECORDED" : "ZERO_LEGACY",
    fundingCoverage: row.fundingVerified === true ? "RECORDED" : "UNKNOWN",
    openedAt: row.position?.openedAt?.toISOString() ?? null,
    closedAt: row.position?.closedAt?.toISOString() ?? row.createdAt.toISOString(),
    closeReason: row.position?.closeReason ?? null,
  };
}

/** DB + isolated forward-worker evidence, read-only. */
export async function loadDefaultSwingEvidence(strategyId: string, afterTradeId: number, statePath?: string | null): Promise<SwingEvalEvidence> {
  const rows = await db.trade.findMany({
    where: {
      mode: "SWING",
      strategyId,
      id: { gt: afterTradeId },
      source: { in: ["PAPER_AI", "PAPER_MANUAL"] },
      accountingQuality: { in: ["SIMULATED", "VERIFIED"] },
    },
    include: { position: true },
    orderBy: { id: "asc" },
    take: 1000,
  });
  const dbTrades = rows.map((r) => normalizeDbTrade(r as never)).filter((t): t is SwingEvalTradeEvidence => t !== null);
  let cursor = afterTradeId;
  for (const r of rows) cursor = Math.max(cursor, r.id);

  // Isolated RSW forward worker state is a separate ledger; only RSW IDs.
  const forward: SwingEvalTradeEvidence[] = [];
  if (strategyId.startsWith("RSW-")) {
    try {
      const walletPath = statePath ?? path.join(process.cwd(), "data", "swing-paper-runtime", `forward-wallet-${strategyId}.json`);
      const wallet = JSON.parse(fs.readFileSync(walletPath, "utf8")) as { closed?: Array<Record<string, unknown>> };
      for (const row of wallet.closed ?? []) {
        if (String(row.strategyId) !== strategyId) continue;
        const net = asFinite(row.netPnl); const fee = asFinite(row.fees); const fund = asFinite(row.funding);
        if (net === null || fee === null || fund === null) continue;
        const side = String(row.side).toUpperCase() === "LONG" ? "LONG" : "SHORT";
        const symbol = String(row.symbol ?? "UNKNOWN");
        const closed = row.exitTime ? new Date(Number(row.exitTime)).toISOString() : null;
        forward.push({
          tradeId: `fwd:${strategyId}:${symbol}:${String(row.time ?? closed ?? "")}:${side}`,
          strategyId, symbol, side,
          netPnlUsd: net, grossPnlUsd: Number((net + fee - fund).toFixed(6)),
          feeUsd: fee, fundingCostUsd: fund, rMultiple: asFinite(row.rMultiple),
          source: "FORWARD_PAPER_ISOLATED", accountingQuality: "SIMULATED",
          feeCoverage: fee > 0 ? "RECORDED" : "ZERO_LEGACY",
          fundingCoverage: "RECORDED",
          openedAt: row.time ? new Date(Number(row.time)).toISOString() : null,
          closedAt: closed, closeReason: typeof row.reason === "string" ? row.reason : null,
        });
      }
    } catch {
      // Missing worker state is normal before the first forward trade.
    }
  }
  const merged = [...dbTrades, ...forward].sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""));
  const aggregate = aggregateSwingEvidence(strategyId, merged);
  const input = { strategyId, trades: merged.map((t) => ({ ...t })), aggregate };
  return {
    strategyId, aggregate, trades: merged, cursor,
    inputHash: sha256(input),
    notes: [
      "DB source is PAPER_AI/PAPER_MANUAL SIMULATED/VERIFIED only.",
      "Forward worker is a separate $200 wallet; never summed with main PAPER wallet.",
      aggregate.feeCoverage === "ZERO_LEGACY" ? "feeUsd=0 on all rows: NET is as-recorded and may be overstated." : "Fee coverage recorded for at least one row.",
      aggregate.sampleCount < 500 ? "Sample below 500; gate must return INSUFFICIENT/INCONCLUSIVE, not PASS." : "Sample floor met for gate consideration.",
    ],
  };
}

/** LLM evaluator; evidence numbers come from code, never from the model. */
export class XkiroSwingEvaluator {
  constructor(private readonly adapter: XkiroAdapter = defaultLlmAdapter) {}

  async evaluate(evidence: SwingEvalEvidence): Promise<SwingEvalLlmResult> {
    const started = Date.now();
    const agent = ALL_12_AGENTS["strategy-tuner"];
    const system = `Anda ${agent.name} (${agent.id}), peneliti hipotesis strategi di ArtaTrade.
Anda TIDAK menghitung uang, TIDAK mengubah strategi, TIDAK memberi izin LIVE, dan TIDAK mengarang data.
Gunakan hanya evidence yang diberikan. Angka sudah dihitung kode; kutip bila perlu, jangan hitung ulang.
Pisahkan fakta, hipotesis, dan ketidaktahuan. Jika sampel kecil, katakan tidak cukup bukti.
Jawab JSON saja:
{"observation":"...","edgeHypothesis":"...","supportingEvidence":["ref"],"counterEvidence":["ref"],"missingEvidence":["..."],"thesisDrift":"NONE|WEAKENING|STRENGTHENING|UNKNOWN","experiment":null|{"kind":"RECHECK_BASELINE|UNIVERSE_FILTER","rationale":"...","preEntryFeatures":["..."],"symbols":["BTCUSDT"]},"operatorProposal":null|"..."}
Aturan: experiment harus dari allowlist. RECHECK_BASELINE = konfigurasi sama; UNIVERSE_FILTER = subset dataset publik. Eksperimen parameter (PARAMETER_PATCH) dimatikan 20 Okt 2026 dan tidak lagi tersedia untuk strategi mana pun — jangan mengusulkannya. Perubahan exit/risk/LIVE/SCALP dan parameter entry lain HARUS masuk operatorProposal.`;
    const user = `Strategi: ${evidence.strategyId}; identitas: ${JSON.stringify(swingEvalStrategy(evidence.strategyId))}; kartu hipotesis: ${JSON.stringify(buildSwingThesisCard(evidence.strategyId))}.
Agregat deterministik: ${JSON.stringify(evidence.aggregate)}.
Catatan: ${evidence.notes.join(" | ")}.
Evidence rows (maks 20 terbaru): ${JSON.stringify(evidence.trades.slice(-20))}`;
    let last: SwingEvalLlmResult | null = null;
    // One bounded format retry only. Invalid JSON never authorizes a gate; after
    // the retry the caller labels the deterministic fallback explicitly.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const correction = attempt === 0 ? "" : "\nRETRY: JSON sebelumnya tidak valid. Kembalikan JSON valid sesuai schema; jangan mengarang evidence.";
        const res = await this.adapter.callReason(user, system + correction, { maxTokens: 2200, timeoutMs: 45_000 });
        const parsed = extractJsonObject(res.content ?? "");
        const feedback = validateSwingEvalFeedback(parsed, evidence);
        if (feedback.ok) {
          return { ok: true, feedback: feedback.feedback, model: res.model ?? null, provider: "XKIRO", durationMs: Date.now() - started, failureCode: null, rawHash: sha256(res.content ?? ""), usage: res.usage ?? null };
        }
        last = { ok: false, feedback: null, model: res.model ?? null, provider: "XKIRO", durationMs: Date.now() - started, failureCode: feedback.reason, rawHash: sha256(res.content ?? ""), usage: res.usage ?? null };
        if (!/TOO_SHORT|INVALID|MISSING|NOT_AN_OBJECT|ARRAYS/.test(feedback.reason)) return last;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failureCode = message.match(/LLM_[A-Z0-9_]+/)?.[0] ?? "LLM_UNAVAILABLE";
        last = { ok: false, feedback: null, model: null, provider: "XKIRO", durationMs: Date.now() - started, failureCode, rawHash: null, usage: null };
        // Network/timeouts may be retried once; the retry is still bounded.
      }
    }
    return last ?? { ok: false, feedback: null, model: null, provider: "XKIRO", durationMs: Date.now() - started, failureCode: "LLM_SCHEMA_RETRY_EXHAUSTED", rawHash: null, usage: null };
  }

  /**
   * A-08: bounded role calls. They consume evidence already computed by code,
   * cannot change risk/exit/mode, and are recorded separately from the primary
   * evaluator. Failure is an explicit fallback, never fabricated agreement.
   */
  async reviewRoles(evidence: SwingEvalEvidence, feedback: SwingEvalFeedback): Promise<SwingEvalRoleRun[]> {
    const roles = [
      { role: "skeptic" as const, agent: ALL_12_AGENTS["setup-judge"]!, schema: '{"verdict":"SUPPORTED|WEAKENED|INCONCLUSIVE","counterEvidence":["..."],"missingEvidence":["..."],"notes":"..."}' },
      { role: "contract" as const, agent: ALL_12_AGENTS["risk-officer"]!, schema: '{"paperOnly":true,"experimentAllowed":true|false,"reasons":["..."],"notes":"..."}' },
    ];
    const out: SwingEvalRoleRun[] = [];
    for (const item of roles) {
      const started = Date.now();
      const inputHash = sha256({ strategyId: evidence.strategyId, evidenceHash: evidence.inputHash, feedback, role: item.role });
      const base: SwingEvalRoleRun = {
        role: item.role, roleRunId: `ROLE-${randomUUID()}`, agentId: item.agent.id, agentName: item.agent.name,
        model: null, inputHash, outputHash: null, status: "FAILED", fallback: null,
        startedAt: this.nowIso(), latencyMs: 0, result: null,
      };
      try {
        const res = await this.adapter.callReason(
          `Role=${item.role}. Evidence deterministik: ${JSON.stringify({ aggregate: evidence.aggregate, notes: evidence.notes, recent: evidence.trades.slice(-10) })}. Feedback: ${JSON.stringify(feedback)}. PAPER only; no LIVE/SCALP/risk/exit changes.`,
          `Anda ${item.agent.name}. Periksa bukti yang diberikan, jangan menghitung nominal atau mengarang evidence. Output JSON saja: ${item.schema}`,
          { maxTokens: 800, timeoutMs: 30_000 },
        );
        const parsed = extractJsonObject(res.content ?? "");
        const validated = this.validateRoleResult(item.role, parsed);
        base.model = res.model ?? null;
        base.latencyMs = Date.now() - started;
        base.outputHash = sha256(res.content ?? "");
        if (validated) { base.status = "VALIDATED"; base.result = validated; }
        else { base.status = "FALLBACK"; base.fallback = "ROLE_SCHEMA_INVALID"; base.result = { note: "deterministic role fallback; no LLM approval" }; }
      } catch (err) {
        base.latencyMs = Date.now() - started;
        base.status = "FALLBACK";
        base.fallback = err instanceof Error ? err.message.slice(0, 120) : "ROLE_CALL_FAILED";
        base.result = { note: "deterministic role fallback; no LLM approval" };
      }
      out.push(base);
    }
    return out;
  }

  private validateRoleResult(role: "skeptic" | "contract", parsed: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!parsed) return null;
    if (role === "skeptic") {
      const verdict = String(parsed.verdict ?? "");
      if (!["SUPPORTED", "WEAKENED", "INCONCLUSIVE"].includes(verdict)) return null;
      if (!Array.isArray(parsed.counterEvidence) || !Array.isArray(parsed.missingEvidence)) return null;
      return { verdict, counterEvidence: parsed.counterEvidence.slice(0, 6), missingEvidence: parsed.missingEvidence.slice(0, 6), notes: String(parsed.notes ?? "").slice(0, 500) };
    }
    if (parsed.paperOnly !== true) return null;
    if (typeof parsed.experimentAllowed !== "boolean" || !Array.isArray(parsed.reasons)) return null;
    return { paperOnly: true, experimentAllowed: parsed.experimentAllowed, reasons: parsed.reasons.slice(0, 6), notes: String(parsed.notes ?? "").slice(0, 500) };
  }

  private nowIso(): string { return new Date().toISOString(); }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function stringArray(value: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim().slice(0, 500)).slice(0, max);
  return out.length >= min ? out : null;
}

/** Strict schema; invalid LLM output is not approval. */
export function validateSwingEvalFeedback(raw: unknown, evidence: SwingEvalEvidence): { ok: true; feedback: SwingEvalFeedback } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "NOT_AN_OBJECT" };
  const p = raw as Record<string, unknown>;
  const observation = typeof p.observation === "string" ? p.observation.trim() : "";
  const edgeHypothesis = typeof p.edgeHypothesis === "string" ? p.edgeHypothesis.trim() : "";
  if (observation.length < 40) return { ok: false, reason: "OBSERVATION_TOO_SHORT" };
  if (edgeHypothesis.length < 20) return { ok: false, reason: "HYPOTHESIS_TOO_SHORT" };
  const supporting = stringArray(p.supportingEvidence, 1, 6);
  const counter = stringArray(p.counterEvidence, 0, 6);
  const missing = stringArray(p.missingEvidence, 1, 6);
  if (!supporting || !counter || !missing) return { ok: false, reason: "EVIDENCE_ARRAYS_INVALID" };
  const drift = p.thesisDrift;
  if (drift !== "NONE" && drift !== "WEAKENING" && drift !== "STRENGTHENING" && drift !== "UNKNOWN") return { ok: false, reason: "THESIS_DRIFT_INVALID" };
  let experiment: SwingEvalFeedback["experiment"] = null;
  if (p.experiment && typeof p.experiment === "object" && !Array.isArray(p.experiment)) {
    const e = p.experiment as Record<string, unknown>;
    if (e.kind !== "RECHECK_BASELINE" && e.kind !== "UNIVERSE_FILTER" && e.kind !== "PARAMETER_PATCH") return { ok: false, reason: "EXPERIMENT_NOT_ALLOWLISTED" };
    // Operator D-2 (20 Okt 2026): parameter experiments are off for EVERY
    // strategy. Reject before any patch parsing so no strategy can smuggle a
    // parameter change through the eval loop.
    if (e.kind === "PARAMETER_PATCH") return { ok: false, reason: "PARAMETER_PATCH_DISABLED" };
    const rationale = typeof e.rationale === "string" ? e.rationale.trim() : "";
    const features = stringArray(e.preEntryFeatures, 1, 8);
    if (rationale.length < 20 || !features) return { ok: false, reason: "EXPERIMENT_INVALID" };
    if (e.kind === "RECHECK_BASELINE") {
      experiment = { kind: "RECHECK_BASELINE", rationale, preEntryFeatures: features };
    } else {
      const rawSymbols = stringArray(e.symbols, 1, 4);
      const symbols = rawSymbols?.map((v) => v.toUpperCase()).filter((v) => /^[A-Z0-9]{2,15}USDT$/.test(v)) ?? [];
      if (symbols.length < 1 || symbols.length !== rawSymbols?.length) return { ok: false, reason: "UNIVERSE_FILTER_INVALID" };
      experiment = { kind: "UNIVERSE_FILTER", rationale, preEntryFeatures: features, symbols: [...new Set(symbols)] };
    }
  }
  const operatorProposal = typeof p.operatorProposal === "string" && p.operatorProposal.trim().length > 0 ? p.operatorProposal.trim().slice(0, 1200) : null;
  // Guard against a strategy identity swap.
  const text = `${observation} ${edgeHypothesis} ${supporting.join(" ")}`;
  if (!text.toUpperCase().includes(evidence.strategyId.toUpperCase())) return { ok: false, reason: "STRATEGY_ID_MISSING_IN_TEXT" };
  return { ok: true, feedback: { observation, edgeHypothesis, supportingEvidence: supporting, counterEvidence: counter, missingEvidence: missing, thesisDrift: drift, experiment, operatorProposal } };
}

/** Deterministic fallback is explicitly labelled and cannot authorize promotion. */
export function deterministicSwingFeedback(evidence: SwingEvalEvidence): SwingEvalFeedback {
  const a = evidence.aggregate;
  const insufficient = a.sampleCount < 30 || a.feeCoverage === "ZERO_LEGACY";
  return {
    observation: `${evidence.strategyId}: ${a.sampleCount} closed trade(s), net as-recorded ${a.netPnlUsd} USD, fee coverage ${a.feeCoverage}. ${insufficient ? "Evidence is insufficient for an edge conclusion." : "Evidence is still observational."}`,
    edgeHypothesis: insufficient ? "Belum ada dasar kuantitatif untuk menambah atau mengurangi eksposur." : "Perlu pembanding baseline/kandidat pada data out-of-sample.",
    supportingEvidence: ["deterministic:aggregate"],
    counterEvidence: a.sampleCount > 0 ? ["deterministic:sample-floor-not-met"] : [],
    missingEvidence: ["fee-covered sample", "point-in-time OOS evidence", "candidate/baseline comparison"],
    thesisDrift: "UNKNOWN",
    experiment: null,
    operatorProposal: null,
  };
}

/**
 * Executable PAPER experiments. Entry/exit/risk knobs remain excluded.
 *
 * 21 Okt 2026 (Phase 2 plan audit): entri PARAMETER_PATCH dihapus dari daftar
 * ini. Allowlist ini tidak pernah dibaca kode mana pun (dead constant), dan
 * versi lamanya tetap menyisakan jalur parameter-patch untuk S-05 — sekarang
 * semua jalur itu sudah dimatikan di validateSwingEvalFeedback().
 */
export const SWING_EVAL_ALLOWLIST = {
  RECHECK_BASELINE: {
    changesConfig: false,
    description: "Re-run the frozen baseline on the same evidence/dataset; no parameter, exit, risk, or wallet change.",
  },
  UNIVERSE_FILTER: {
    changesConfig: false,
    scopeOnly: true,
    description: "Run the frozen strategy on a declared subset of public datasets; no entry/exit/risk change, no wallet reuse.",
  },
} as const;

export function validateExperiment(feedback: SwingEvalFeedback): { ok: boolean; reason: string } {
  if (!feedback.experiment) return { ok: true, reason: "NO_CHANGE" };
  if (feedback.experiment.kind !== "RECHECK_BASELINE" && feedback.experiment.kind !== "UNIVERSE_FILTER" && feedback.experiment.kind !== "PARAMETER_PATCH") {
    return { ok: false, reason: "EXPERIMENT_NOT_ALLOWLISTED" };
  }
  if (feedback.experiment.kind === "UNIVERSE_FILTER") {
    const symbols = feedback.experiment.symbols ?? [];
    if (symbols.length === 0) return { ok: false, reason: "UNIVERSE_FILTER_EMPTY" };
    if (symbols.some((s) => !/^[A-Z0-9]{2,15}USDT$/.test(s))) return { ok: false, reason: "UNIVERSE_FILTER_INVALID" };
  }
  if (feedback.experiment.kind === "PARAMETER_PATCH") {
    // Operator D-2 (20 Okt 2026): parameter experiments are disabled for every
    // strategy. Kept as an explicit rejection (not a silent pass) so a
    // proposed patch can never authorize a backtest or a candidate cohort.
    return { ok: false, reason: "PARAMETER_PATCH_DISABLED" };
  }
  // An operator proposal (e.g. fix fee accounting) is stored alongside the
  // executable experiment but does not change strategy config; review-only.
  return { ok: true, reason: feedback.operatorProposal ? "EXPERIMENT_ALLOWED_OPERATOR_PROPOSAL_SEPARATE" : "EXPERIMENT_ALLOWED" };
}

// ---- default adapters -------------------------------------------------------

export async function runDefaultSwingBacktest(input: { strategyId: string; evidence: SwingEvalEvidence; experiment?: SwingEvalFeedback["experiment"] }): Promise<SwingEvalBacktestResult> {
  const { calculateMetrics } = await import("../backtest/backtestEngine.js");
  const { runWorkerTask } = await import("../backtest/runWorker.js");
  const dir = path.join(process.cwd(), "data", "history");
  const allFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith("_1m.json")) : [];
  const wanted = input.experiment?.kind === "UNIVERSE_FILTER" ? new Set(input.experiment.symbols ?? []) : null;
  const files = wanted ? allFiles.filter((f) => wanted.has(f.replace(/_1m\.json$/, ""))) : allFiles;
  if (files.length === 0) return { ok: false, metrics: null, datasetHash: null, runRef: null, reasons: ["NO_LOCAL_HISTORY_DATASET", ...(wanted ? ["UNIVERSE_FILTER_NO_DATASET"] : [])] };
  const trades: Array<Record<string, unknown>> = [];
  const hashes: string[] = [];
  const reasons: string[] = [];
  const funnels: Array<Record<string, unknown>> = [];
  let coverage: "FULL" | "PARTIAL" | "MISSING" | "UNKNOWN" = "UNKNOWN";
  const workerUrl = new URL("../backtest/backtestWorker.js", import.meta.url);
  // RSW-01 BOS_LONG needs point-in-time BTC D1 context. Use the same verified
  // BTC 1m dataset and expose only completed daily buckets in historicalReplay.
  let btcDailyBars: Array<{ openTime: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  try {
    const btcPath = path.join(dir, "BTCUSDT_1m.json");
    if (fs.existsSync(btcPath)) {
      const btc = JSON.parse(fs.readFileSync(btcPath, "utf8")) as { bars: typeof btcDailyBars; intervalMs: number; outOfSampleTo: number };
      const { aggregateClosedBars } = await import("../backtest/historicalReplay.js");
      btcDailyBars = aggregateClosedBars(btc.bars, 86_400_000, btc.outOfSampleTo, btc.intervalMs);
    }
  } catch { btcDailyBars = []; }
  for (const file of files) {
    try {
      const dataset = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const result = await runWorkerTask<{ output: { trades?: unknown[]; provenance?: { datasetHash?: string }; failedGateReasons?: string[]; diagnostics?: { funnel?: { fundingCoverage?: "FULL" | "PARTIAL" | "MISSING"; [key: string]: unknown } } } }>(
        workerUrl,
        {
          options: {
            strategyId: input.strategyId, mode: "SWING", dataset, minSamples: 1, minWinrate: 0,
            fees: { makerRate: 0.0002, takerRate: 0.0005 }, slippageBps: 0,
            initialEquityUsd: 200, targetRiskUsd: 1, marginMode: "CROSS", btcDailyBars,
          },
        },
        300_000,
      );
      const out = result.output;
      if (out.trades?.length) trades.push(...out.trades as Array<Record<string, unknown>>);
      hashes.push(`${file}:${out.provenance?.datasetHash ?? "no-hash"}`);
      funnels.push({ file, ...(out.diagnostics?.funnel ?? {}) });
      const c = out.diagnostics?.funnel?.fundingCoverage;
      if (c === "MISSING" || coverage === "MISSING") coverage = "MISSING";
      else if (c === "PARTIAL" || coverage === "PARTIAL") coverage = "PARTIAL";
      else if (c === "FULL" && coverage === "UNKNOWN") coverage = "FULL";
      if (out.failedGateReasons?.length) reasons.push(...out.failedGateReasons);
    } catch (err) {
      reasons.push(`${file}:${err instanceof Error ? err.message.slice(0, 120) : "FAILED"}`);
    }
  }
  if (!trades.length) return { ok: false, metrics: null, datasetHash: sha256(hashes), runRef: "data/history", reasons: [...new Set(reasons), "NO_TRADES"], diagnostics: { funnels, fundingCoverage: coverage, experiment: input.experiment ?? null } };
  const metrics = calculateMetrics(trades as never[]);
  return {
    ok: true,
    metrics: {
      sampleCount: metrics.sampleCount, winrate: metrics.winrate, evUsd: metrics.evUsd,
      totalNetPnlUsd: metrics.totalNetPnlUsd, maxDdUsd: metrics.maxDdUsd,
      totalFeesUsd: metrics.totalFeesUsd, totalFundingUsd: metrics.totalFundingUsd,
      fundingCoverage: coverage,
    },
    datasetHash: sha256(hashes), runRef: `data/history:${files.join(",")}`, reasons: [...new Set(reasons)],
    diagnostics: { funnels, fundingCoverage: coverage, experiment: input.experiment ?? null },
  };
}

/** Create a separate candidate cohort + public-data worker for an RSW study. */
export function startRswCandidate(input: { runId: string; strategyId: string; evidence: SwingEvalEvidence; experiment?: SwingEvalFeedback["experiment"] }): SwingEvalPaperResult {
  const exp = input.experiment;
  if (!input.strategyId.startsWith("RSW-") || !exp || (exp.kind !== "RECHECK_BASELINE" && exp.kind !== "UNIVERSE_FILTER")) {
    return { ok: false, mode: "NONE", note: "RSW_CANDIDATE_EXPERIMENT_INVALID", closedCount: null };
  }
  const identity = swingEvalStrategy(input.strategyId);
  if (!identity) return { ok: false, mode: "NONE", note: "RSW_IDENTITY_MISSING", closedCount: null };
  const candidateId = `cand-${input.runId.replace(/[^A-Za-z0-9:-]/g, "-")}`.slice(0, 90);
  const params = { experimentKind: exp.kind, universeFilter: JSON.stringify(exp.symbols ?? []), rationale: exp.rationale.slice(0, 120) };
  const parameterHash = candidateParameterHash(input.strategyId, identity.version, params);
  const created = createPaperCandidate(process.cwd(), {
    candidateId, strategyId: input.strategyId, experimentId: input.runId, parentVersion: identity.version,
    parameterHash, parameters: params, executionMode: "PAPER", walletId: `wallet-${candidateId}`,
  });
  if (!created.ok || !created.statePath) return { ok: false, mode: "NONE", note: created.reason, closedCount: null };
  let pid: number | null = null;
  if (process.env.NODE_ENV !== "test" && process.env.SWING_CANDIDATE_WORKER_ENABLED !== "false") {
    try {
      const port = 8900 + (parseInt(parameterHash.slice(0, 6), 16) % 90);
      const logFd = fs.openSync(path.join(path.dirname(created.statePath), "worker.log"), "a", 0o600);
      const child = spawn("python3", [
        "research/swing_forward_paper.py", "--strategy", input.strategyId, "--candidate-id", candidateId,
        "--state", created.statePath, "--port", String(port),
      ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONUNBUFFERED: "1" }, stdio: ["ignore", logFd, logFd] });
      child.unref(); pid = child.pid ?? null; fs.closeSync(logFd);
    } catch {
      return { ok: false, mode: "NONE", note: "CANDIDATE_WORKER_SPAWN_FAILED", closedCount: null, statePath: created.statePath, candidateId };
    }
  }
  return { ok: true, mode: "EXISTING_ISOLATED_FORWARD", note: `${input.strategyId} candidate ${candidateId} isolated at ${created.statePath}`, closedCount: 0, statePath: created.statePath, candidateId, workerPid: pid };
}

export function enqueueDefaultPaper(input: { runId: string; strategyId: string; evidence: SwingEvalEvidence; experiment?: SwingEvalFeedback["experiment"] }): Promise<SwingEvalPaperResult> {
  if (input.strategyId.startsWith("RSW-")) {
    if (input.experiment) return Promise.resolve(startRswCandidate(input));
    try {
      // Each RSW study now has its own worker, state, cursor and $200 wallet.
      // Never attach a candidate to the shared portfolio wallet.
      const statePath = path.join(process.cwd(), "data", "swing-paper-runtime", `forward-wallet-${input.strategyId}.json`);
      const wallet = JSON.parse(fs.readFileSync(statePath, "utf8")) as { closed?: unknown[]; initialBalance?: number };
      if (wallet.initialBalance !== 200) return Promise.resolve({ ok: false, mode: "NONE", note: "ISOLATED_WALLET_BALANCE_NOT_200", closedCount: null });
      return Promise.resolve({
        ok: true, mode: "EXISTING_ISOLATED_FORWARD",
        note: `${input.strategyId} attached to its own isolated $200 PAPER worker; not the shared portfolio wallet.`,
        closedCount: Array.isArray(wallet.closed) ? wallet.closed.length : 0,
      });
    } catch {
      return Promise.resolve({ ok: false, mode: "NONE", note: "ISOLATED_FORWARD_WORKER_STATE_UNAVAILABLE", closedCount: null });
    }
  }
  // 21 Okt 2026 (Phase 2 plan audit): cabang S-05 dihapus. S-05 sudah diarsipkan
  // dan tidak lagi menjadi subjek evaluasi, jadi loop tidak boleh membuat cohort
  // kandidat baru untuknya. Worker forward-paper Polaris berjalan sebagai systemd
  // service terpisah (artatrade-swing-paper-polaris.service) dan tidak bergantung
  // pada jalur ini.
  return Promise.resolve({ ok: false, mode: "NONE", note: "NO_PAPER_HARNESS_FOR_ARCHIVED_STRATEGY", closedCount: null });
}

// ---- loop -----------------------------------------------------------------

/** Content identity for scheduler dedupe. mtime/size only select a cached
 * digest; the digest itself is SHA-256 of the file bytes, so touching an
 * identical file does not create a new experiment. */
const datasetDigestCache = new Map<string, { size: number; mtimeMs: number; digest: string }>();
export function defaultDatasetFingerprint(): string | null {
  try {
    const dir = path.join(process.cwd(), "data", "history");
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith("_1m.json")).sort();
    if (files.length === 0) return null;
    const identity = files.map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const cached = datasetDigestCache.get(full);
      let digest = cached?.digest;
      if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
        digest = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        datasetDigestCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, digest });
      }
      return `${f}:${st.size}:${digest}`;
    }).join("|");
    return sha256(identity);
  } catch { return null; }
}

export class SwingEvaluationLoop {
  private readonly store: FileSwingEvalStore;
  private readonly evaluator: XkiroSwingEvaluator;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly maxRunsPerTick: number;
  private readonly maxAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SwingEvalDeps = {}) {
    this.store = new FileSwingEvalStore(deps.statePath ?? path.join(process.cwd(), "data", "swing-eval-loop", "state.json"));
    this.evaluator = new XkiroSwingEvaluator(deps.adapter);
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.maxRunsPerTick = deps.maxRunsPerTick ?? 2;
    this.maxAttempts = deps.maxAttempts ?? 3;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Archived/retired runs never remain actionable after a restart. */
  private archiveRetiredRuns(): void {
    const state = this.store.load();
    let changed = false;
    for (const run of Object.values(state.runs)) {
      const archived = archivedSwingStrategy(run.strategyId);
      if (!archived) continue;
      if (!ACTIVE.has(run.state) && run.state !== "RETRY_PENDING") continue;
      state.runs[run.runId] = {
        ...run,
        state: "ARCHIVED",
        lastError: "DISABLED_BY_OPERATOR_ARCHIVED_STRATEGY",
        updatedAt: this.now().toISOString(),
      };
      changed = true;
      void this.event("SWING_EVAL_ARCHIVED", "info", {
        runId: run.runId, strategyId: run.strategyId, reason: archived.disabledReason ?? "ARCHIVED_BY_OPERATOR",
      });
    }
    if (changed) this.store.save(state);
  }

  /** Enqueue all three active subjects once; a restart never duplicates terminal work. */
  bootstrap(): string[] {
    this.archiveRetiredRuns();
    const ids: string[] = [];
    const state = this.store.load();
    for (const strategyId of SWING_EVAL_IDS) {
      if (Object.values(state.runs).some((r) => r.strategyId === strategyId)) continue;
      const run = this.enqueue(strategyId, "BOOTSTRAP");
      if (run) ids.push(run.runId);
    }
    return ids;
  }

  enqueue(strategyId: string, trigger: SwingEvalRun["trigger"], parentRunId: string | null = null): SwingEvalRun | null {
    if (!swingEvalStrategy(strategyId)) return null;
    if (archivedSwingStrategy(strategyId)) return null;
    const state = this.store.load();
    const active = Object.values(state.runs).find((r) => r.strategyId === strategyId && ACTIVE.has(r.state));
    if (active) return null;
    const now = this.now().toISOString();
    const run: SwingEvalRun = {
      runId: `SWEV-${randomUUID()}`,
      correlationId: `SWEV-CORR-${randomUUID()}`,
      strategyId,
      strategyVersion: swingEvalStrategy(strategyId)!.version,
      trigger,
      state: "EVALUATION_QUEUED",
      parentRunId,
      cursorBefore: state.cursors[strategyId] ?? 0,
      cursorAfter: state.cursors[strategyId] ?? 0,
      evidenceHash: null,
      tradeIds: [],
      feedback: null,
      aggregate: null,
      feedbackSource: null,
      roleRuns: [],
      llm: null,
      experiment: null,
      backtest: null,
      backtestDiagnostics: null,
      backtestRunId: null,
      gateDecisionId: null,
      forwardRunId: null,
      reviewRunId: null,
      gate: null,
      paper: null,
      attempts: 0,
      lastError: null,
      triggerReason: trigger,
      nextEligibleAt: new Date(this.now().getTime() + this.intervalMs).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    state.runs[run.runId] = run;
    this.store.save(state);
    void this.event("SWING_EVAL_QUEUED", "info", { runId: run.runId, strategyId, trigger });
    return run;
  }

  status(): { schemaVersion: 1; updatedAt: string; runs: SwingEvalRun[]; cursors: Record<string, number>; dedupeCount: number } {
    const state = this.store.load();
    return {
      schemaVersion: 1, updatedAt: state.updatedAt,
      runs: Object.values(state.runs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((r) => ({
        ...r,
        triggerReason: r.triggerReason ?? r.trigger,
        nextEligibleAt: r.nextEligibleAt ?? (ACTIVE.has(r.state) ? null : new Date(Date.parse(r.updatedAt) + this.intervalMs).toISOString()),
      })),
      cursors: state.cursors, dedupeCount: Object.keys(state.dedupe).length,
    };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.discover();
      const state = this.store.load();
      const actionable = Object.values(state.runs)
        .filter((r) => ACTIVE.has(r.state) || r.state === "RETRY_PENDING")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, this.maxRunsPerTick);
      for (const run of actionable) await this.advance(run);
    } finally {
      this.ticking = false;
    }
  }

  /** Detect new closed trades after the last consumed cursor. */
  private async discover(): Promise<void> {
    const state = this.store.load();
    for (const strategyId of SWING_EVAL_IDS) {
      if (Object.values(state.runs).some((r) => r.strategyId === strategyId && (ACTIVE.has(r.state) || r.state === "RETRY_PENDING"))) continue;
      const cursor = state.cursors[strategyId] ?? 0;
      try {
        const evidence = await (this.deps.loadEvidence ?? loadDefaultSwingEvidence)(strategyId, cursor);
        if (evidence.trades.length === 0) {
          // A-05: dataset readiness is itself a valid research trigger. It does
          // not call the LLM and does not pretend there are closed trades.
          const fingerprint = (this.deps.datasetFingerprint ?? defaultDatasetFingerprint)();
          if (!fingerprint) continue;
          const key = `dataset:${strategyId}:${fingerprint}`;
          if (state.dedupe[key]) continue;
          const run = this.enqueue(strategyId, "SCHEDULE");
          if (!run) continue;
          const nextState = this.store.load();
          const queued = {
            ...run,
            state: "BACKTEST_QUEUED" as const,
            experiment: { kind: "RECHECK_BASELINE" as const, rationale: "Dataset readiness trigger; frozen baseline replay before any forward sample.", preEntryFeatures: ["dataset_fingerprint"] },
            datasetFingerprint: fingerprint,
            triggerReason: "DATASET_READY",
            nextEligibleAt: null,
            updatedAt: this.now().toISOString(),
          };
          nextState.runs[run.runId] = queued;
          nextState.dedupe[key] = run.runId;
          this.store.save(nextState);
          void this.event("SWING_EVAL_DATASET_READY", "info", { runId: run.runId, strategyId, datasetFingerprint: fingerprint });
          continue;
        }
        const alreadyProcessed = Object.values(state.runs).some((r) => r.strategyId === strategyId && r.evidenceHash === evidence.inputHash);
        if (!alreadyProcessed) this.enqueue(strategyId, "TRADE_BATCH");
      } catch { /* a read failure must not stop the loop; next tick retries */ }
    }
  }

  private update(run: SwingEvalRun, next: SwingEvalState, patch: Partial<SwingEvalRun> = {}): SwingEvalRun {
    if (!canTransitionSwingEval(run.state, next)) throw new Error(`ILLEGAL_SWING_EVAL_TRANSITION:${run.state}->${next}`);
    const state = this.store.load();
    const updated = { ...run, ...patch, state: next, updatedAt: this.now().toISOString() };
    state.runs[run.runId] = updated;
    // Advance only after the evidence has been evaluated enough to be consumed;
    // this prevents a new scheduler tick from re-queuing the same batch.
    if (updated.cursorAfter > (state.cursors[run.strategyId] ?? 0)) state.cursors[run.strategyId] = updated.cursorAfter;
    this.store.save(state);
    void this.event(`SWING_EVAL_${next}`, next === "FAILED" || next === "REJECTED" ? "warn" : "info", { runId: run.runId, strategyId: run.strategyId, from: run.state, to: next, error: updated.lastError });
    return updated;
  }

  private async advance(run: SwingEvalRun): Promise<void> {
    try {
      switch (run.state) {
        case "EVALUATION_QUEUED": return await this.doEvaluate(run);
        case "FEEDBACK_VALIDATED": return await this.doPropose(run);
        case "EXPERIMENT_PROPOSED": return await this.doValidateExperiment(run);
        case "EXPERIMENT_VALIDATED": return await this.doQueueBacktest(run);
        case "BACKTEST_QUEUED": return await this.doBacktest(run);
        case "BACKTEST_RUNNING": return await this.doBacktest(run); // crash/restart resume
        case "BACKTEST_COMPLETED": return await this.doGate(run);
        case "OOS_GATE": return await this.doPaper(run);
        case "PAPER_QUEUED": return await this.doStartPaper(run);
        case "PAPER_RUNNING": return await this.doReview(run);
        case "REVIEW_DUE": return await this.doReviewEnqueue(run);
        case "RETRY_PENDING": return await this.doRetry(run);
        default: return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : "UNKNOWN";
      const attempts = run.attempts + 1;
      if (attempts >= this.maxAttempts) this.update(run, "FAILED", { attempts, lastError: message });
      else this.update(run, "RETRY_PENDING", { attempts, lastError: message });
    }
  }

  private async evidenceFor(run: SwingEvalRun): Promise<SwingEvalEvidence> {
    const loader = this.deps.loadEvidence ?? loadDefaultSwingEvidence;
    return loader(run.strategyId, run.cursorBefore, run.paper?.statePath ?? null);
  }

  private async evidenceAfter(run: SwingEvalRun): Promise<SwingEvalEvidence> {
    const loader = this.deps.loadEvidence ?? loadDefaultSwingEvidence;
    return loader(run.strategyId, run.cursorAfter, run.paper?.statePath ?? null);
  }

  private async doEvaluate(run: SwingEvalRun): Promise<void> {
    const evidence = await this.evidenceFor(run);
    if (evidence.aggregate.sampleCount === 0) {
      this.update(run, "INSUFFICIENT_DATA", { evidenceHash: evidence.inputHash, cursorAfter: evidence.cursor, lastError: "NO_CLOSED_SWING_TRADES" });
      return;
    }
    const evaluating = this.update(run, "EVALUATING", { evidenceHash: evidence.inputHash, aggregate: evidence.aggregate, tradeIds: evidence.trades.map((t) => t.tradeId), cursorAfter: evidence.cursor });
    const result = await this.evaluator.evaluate(evidence);
    if (!result.ok || !result.feedback) {
      // Fallback is allowed as a journal entry, but it cannot authorize a gate.
      const fallback = deterministicSwingFeedback(evidence);
      this.update(evaluating, "FEEDBACK_VALIDATED", {
        feedback: fallback, feedbackSource: "DETERMINISTIC_FALLBACK",
        llm: { model: result.model, provider: result.provider, durationMs: result.durationMs, failureCode: result.failureCode, usage: result.usage },
        lastError: result.failureCode,
      });
      return;
    }
    const roleRuns = await this.evaluator.reviewRoles(evidence, result.feedback);
    this.update(evaluating, "FEEDBACK_VALIDATED", {
      feedback: result.feedback, feedbackSource: "LLM", roleRuns,
      llm: { model: result.model, provider: result.provider, durationMs: result.durationMs, failureCode: null, usage: result.usage },
    });
  }

  private async doPropose(run: SwingEvalRun): Promise<void> {
    if (!run.feedback) throw new Error("MISSING_FEEDBACK");
    if (!run.feedback.experiment) {
      this.update(run, "NO_CHANGE", { lastError: "LLM_OR_FALLBACK_PROPOSED_NO_CHANGE" });
      return;
    }
    this.update(run, "EXPERIMENT_PROPOSED", { experiment: run.feedback.experiment, lastError: null });
  }

  private async doValidateExperiment(run: SwingEvalRun): Promise<void> {
    if (!run.feedback) throw new Error("MISSING_FEEDBACK");
    const check = validateExperiment(run.feedback);
    if (!check.ok) {
      const operator = run.feedback.operatorProposal ? "OPERATOR_PROPOSAL_REQUIRES_REVIEW" : check.reason;
      this.update(run, "NEEDS_OPERATOR", { lastError: operator });
      return;
    }
    if (run.feedbackSource !== "LLM") {
      this.update(run, "NO_CHANGE", { lastError: "FALLBACK_CANNOT_AUTHORIZE_GATE" });
      return;
    }
    this.update(run, "EXPERIMENT_VALIDATED", { lastError: null });
  }

  private async doQueueBacktest(run: SwingEvalRun): Promise<void> {
    this.update(run, "BACKTEST_QUEUED", { lastError: null });
  }

  private async doBacktest(run: SwingEvalRun): Promise<void> {
    const evidence = await this.evidenceFor(run);
    // Do not block the first replay on forward-closed sample size. The replay
    // must run on eligible historical input; the gate still enforces its floor.
    // A process killed after this write leaves BACKTEST_RUNNING; the next tick
    // resumes the deterministic replay instead of stalling forever.
    const running = run.state === "BACKTEST_QUEUED"
      ? this.update(run, "BACKTEST_RUNNING", { cursorAfter: evidence.cursor, evidenceHash: evidence.inputHash })
      : run;
    const runner = this.deps.runBacktest ?? runDefaultSwingBacktest;
    const result = await runner({ strategyId: run.strategyId, evidence, experiment: run.experiment });
    const backtestRunId = result.runRef ?? `BACKTEST-${run.runId}`;
    if (!result.ok || !result.metrics) {
      this.update(running, "INSUFFICIENT_DATA", { backtest: result.metrics, backtestRunId, lastError: result.reasons.join(",") || "BACKTEST_NO_METRICS" });
      return;
    }
    if (result.metrics.sampleCount < 500) {
      this.update(running, "INSUFFICIENT_DATA", { backtest: result.metrics, backtestRunId, backtestDiagnostics: result.diagnostics ?? null, lastError: `SAMPLES_LT_500:${result.metrics.sampleCount}` });
      return;
    }
    this.update(running, "BACKTEST_COMPLETED", { backtest: result.metrics, backtestRunId, backtestDiagnostics: result.diagnostics ?? null, lastError: null });
  }

  private async doGate(run: SwingEvalRun): Promise<void> {
    const metrics = run.backtest;
    if (!metrics) throw new Error("MISSING_BACKTEST");
    const coverage = metrics.fundingCoverage ?? "UNKNOWN";
    const costsComplete = coverage === "FULL";
    const passed = metrics.sampleCount >= 500 && Number.isFinite(metrics.evUsd) && metrics.evUsd > 0
      && Number.isFinite(metrics.winrate) && costsComplete;
    const verdict = metrics.sampleCount < 500 ? "INCONCLUSIVE" : passed ? "SUPPORTIVE" : "REFUTED";
    const reasons = passed ? [] : [
      metrics.sampleCount < 500 ? "SAMPLES_LT_500" : null,
      !Number.isFinite(metrics.evUsd) || metrics.evUsd <= 0 ? "EV_NET_FEE_LE_0" : null,
      !costsComplete ? `FUNDING_COVERAGE_${coverage}` : null,
    ].filter((x): x is string => x !== null);
    const gate = { passed, verdict, reasons } as const;
    const gateDecisionId = `GATE-${run.runId}`;
    await this.writeFinding(run, verdict, `Gate ${verdict}: sample=${metrics.sampleCount}, evUsd=${metrics.evUsd}. No promotion.`, { ...metrics, gateDecisionId });
    if (!passed) {
      this.update(run, verdict === "INCONCLUSIVE" ? "INSUFFICIENT_DATA" : "REJECTED", { gate, gateDecisionId, lastError: gate.reasons.join(",") });
      return;
    }
    this.update(run, "OOS_GATE", { gate, gateDecisionId, lastError: null });
  }

  private async doPaper(run: SwingEvalRun): Promise<void> {
    // Gate already passed; this stage only runs for same-config recheck.
    const evidence = await this.evidenceFor(run);
    const gateway = this.deps.enqueuePaper ?? enqueueDefaultPaper;
    const result = await gateway({ runId: run.runId, strategyId: run.strategyId, evidence, experiment: run.experiment });
    if (!result.ok) {
      this.update(run, "NEEDS_OPERATOR", { paper: result, lastError: result.note });
      return;
    }
    const forwardRunId = result.candidateId ?? result.statePath ?? `FORWARD-${run.runId}`;
    this.update(run, "PAPER_QUEUED", { paper: result, forwardRunId, lastError: null });
  }

  private async doStartPaper(run: SwingEvalRun): Promise<void> {
    if (!run.paper?.ok) throw new Error("PAPER_NOT_QUEUED");
    this.update(run, "PAPER_RUNNING", { lastError: null });
  }

  private async doReview(run: SwingEvalRun): Promise<void> {
    // A new closed row in the strategy's own ledger is the review trigger.
    // The adapter is responsible for giving each strategy its own namespace.
    const evidence = await this.evidenceAfter(run);
    const known = new Set(run.tradeIds);
    const unseen = evidence.trades.filter((t) => !known.has(t.tradeId));
    if (unseen.length > 0) {
      this.update(run, "REVIEW_DUE", { cursorAfter: evidence.cursor, tradeIds: [...known, ...unseen.map((t) => t.tradeId)], lastError: null });
    }
  }

  private async doReviewEnqueue(run: SwingEvalRun): Promise<void> {
    // Archive the parent first; enqueue() rejects a second active run for the
    // same strategy by design.
    this.update(run, "ARCHIVED", { lastError: "REVIEW_HANDOFF" });
    const child = this.enqueue(run.strategyId, "PAPER_REVIEW", run.runId);
    if (child) {
      const state = this.store.load();
      state.runs[run.runId] = { ...state.runs[run.runId]!, reviewRunId: child.runId, updatedAt: this.now().toISOString() };
      this.store.save(state);
    } else {
      const state = this.store.load();
      state.runs[run.runId] = { ...state.runs[run.runId]!, lastError: "ACTIVE_RUN_ALREADY_EXISTS", updatedAt: this.now().toISOString() };
      this.store.save(state);
    }
  }

  private async doRetry(run: SwingEvalRun): Promise<void> {
    if (run.attempts >= this.maxAttempts) {
      this.update(run, "FAILED", { lastError: "MAX_ATTEMPTS" });
      return;
    }
    const target: SwingEvalState = run.backtest ? "BACKTEST_QUEUED" : "EVALUATION_QUEUED";
    this.update(run, target, { lastError: null });
  }

  private async writeFinding(run: SwingEvalRun, verdict: "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE", conclusion: string, metrics: Record<string, unknown>): Promise<void> {
    const sink = this.deps.writeFinding;
    if (sink) return sink({ runId: run.runId, strategyId: run.strategyId, verdict, conclusion, metrics });
    try {
      await logResearchFinding({
        title: `SwingEvalLoop ${run.strategyId} ${run.runId.slice(0, 12)}`,
        hypothesis: `Baseline ${run.strategyId} dapat direkonsiliasi dan diuji pada data OOS yang tersedia.`,
        experimentType: "BACKTEST",
        verdict,
        conclusion,
        runRefs: [{ kind: "BACKTEST", label: run.runId }],
        metrics: { ...metrics, runId: run.runId, correlationId: run.correlationId },
      });
    } catch { /* best effort; state remains the source of truth */ }
  }

  private async event(type: string, severity: "info" | "warn" | "error", payload: Record<string, unknown>): Promise<void> {
    if (this.deps.logEvent) return this.deps.logEvent(type, severity, payload);
    try {
      await db.eventLog.create({ data: { type, severity, payload: JSON.stringify(payload) } });
    } catch { /* best effort */ }
  }
}

export const defaultSwingEvaluationLoop = new SwingEvaluationLoop();
