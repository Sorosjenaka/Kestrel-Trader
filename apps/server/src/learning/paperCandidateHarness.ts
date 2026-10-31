// PAPER candidate cohort store. No LIVE imports, no exchange client, no wallet
// reset. A candidate is immutable by candidateId/parameterHash and lives in its
// own directory; the baseline wallet and the main PAPER wallet are rejected.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { swingEvalStrategy } from "./swingEvalRegistry.js";

export type CandidateExecutionMode = "PAPER";

export interface PaperCandidateInput {
  candidateId: string;
  strategyId: string;
  experimentId: string;
  parentVersion: string;
  parameterHash: string;
  parameters: Record<string, number | string | boolean>;
  executionMode: CandidateExecutionMode;
  walletId: string;
  now?: string;
}

export interface PaperCandidateWallet {
  schemaVersion: 1;
  mode: "ISOLATED_PAPER_ONLY";
  candidateId: string;
  strategyId: string;
  experimentId: string;
  parentVersion: string;
  parameterHash: string;
  parameters: Record<string, number | string | boolean>;
  walletId: string;
  initialBalanceUsd: 200;
  cashUsd: 200;
  equityUsd: 200;
  /** Python PAPER worker-compatible aliases; same ledger, not a second wallet. */
  initialBalance: 200;
  cash: 200;
  positions: unknown[];
  pending: unknown[];
  closed: unknown[];
  decisions: unknown[];
  seen: string[];
  labels: unknown[];
  models: Record<string, unknown>;
  lastMarks: Record<string, number>;
  bankrupt: false;
  cursor: Record<string, number>;
  risk: { maxPositions: 3; maxDailyLosses: 6; riskBudgetUsd: 1; feeAllowanceUsd: 0.2; timezone: "Asia/Jakarta" };
  lease: { owner: string | null; heartbeatAt: string | null };
  /** Milliseconds: Python PAPER worker uses createdAt for cursor arithmetic. */
  createdAt: number;
  updatedAt: string;
  resetAvailable: false;
  liveEnabled: false;
}

export interface PaperCandidateResult {
  ok: boolean;
  statePath: string | null;
  created: boolean;
  reason: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,96}$/;

export function paperCandidateDir(root: string, candidateId: string): string {
  if (!ID_RE.test(candidateId)) throw new Error("INVALID_CANDIDATE_ID");
  return path.join(root, "data", "swing-eval-loop", "candidates", candidateId);
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Create or reopen an immutable candidate cohort. Existing identity wins: a
 * different parameterHash/candidateId is never silently overwritten/reset.
 */
export function createPaperCandidate(root: string, input: PaperCandidateInput): PaperCandidateResult {
  if (input.executionMode !== "PAPER") return { ok: false, statePath: null, created: false, reason: "NON_PAPER_REJECTED" };
  const identity = swingEvalStrategy(input.strategyId);
  if (!identity) return { ok: false, statePath: null, created: false, reason: "ARCHIVED_OR_UNKNOWN_STRATEGY" };
  if (!ID_RE.test(input.candidateId) || !ID_RE.test(input.walletId) || !ID_RE.test(input.experimentId)) {
    return { ok: false, statePath: null, created: false, reason: "INVALID_NAMESPACE" };
  }
  if (!/^[a-f0-9]{64}$/i.test(input.parameterHash)) return { ok: false, statePath: null, created: false, reason: "INVALID_PARAMETER_HASH" };
  if (input.parentVersion.trim().length === 0) return { ok: false, statePath: null, created: false, reason: "INVALID_PARENT_VERSION" };
  if (Object.keys(input.parameters).length === 0) return { ok: false, statePath: null, created: false, reason: "EMPTY_PARAMETER_SNAPSHOT" };
  const statePath = path.join(paperCandidateDir(root, input.candidateId), "wallet.json");
  const expectedHash = canonicalHash({ strategyId: input.strategyId, parameters: input.parameters, parentVersion: input.parentVersion });
  if (input.parameterHash.toLowerCase() !== expectedHash) return { ok: false, statePath: null, created: false, reason: "PARAMETER_HASH_MISMATCH" };
  const nowIso = input.now ?? new Date().toISOString();
  const now = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (fs.existsSync(statePath)) {
    try {
      const old = JSON.parse(fs.readFileSync(statePath, "utf8")) as PaperCandidateWallet;
      if (old.candidateId !== input.candidateId || old.strategyId !== input.strategyId ||
          old.parameterHash.toLowerCase() !== input.parameterHash.toLowerCase() ||
          old.walletId !== input.walletId || old.mode !== "ISOLATED_PAPER_ONLY" || old.initialBalanceUsd !== 200 ||
          old.initialBalance !== 200) {
        return { ok: false, statePath: null, created: false, reason: "CANDIDATE_STATE_IDENTITY_CONFLICT" };
      }
      return { ok: true, statePath, created: false, reason: "CANDIDATE_STATE_REUSED" };
    } catch { return { ok: false, statePath: null, created: false, reason: "CANDIDATE_STATE_CORRUPT" }; }
  }
  const wallet: PaperCandidateWallet = {
    schemaVersion: 1, mode: "ISOLATED_PAPER_ONLY",
    candidateId: input.candidateId, strategyId: input.strategyId, experimentId: input.experimentId,
    parentVersion: input.parentVersion, parameterHash: input.parameterHash.toLowerCase(),
    parameters: input.parameters, walletId: input.walletId,
    initialBalanceUsd: 200, cashUsd: 200, equityUsd: 200, initialBalance: 200, cash: 200,
    positions: [], pending: [], closed: [], decisions: [], seen: [], labels: [], models: {}, lastMarks: {}, bankrupt: false, cursor: {},
    risk: { maxPositions: 3, maxDailyLosses: 6, riskBudgetUsd: 1, feeAllowanceUsd: 0.2, timezone: "Asia/Jakarta" },
    lease: { owner: null, heartbeatAt: null }, createdAt: now, updatedAt: new Date(now).toISOString(),
    resetAvailable: false, liveEnabled: false,
  };
  const tmp = `${statePath}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(wallet), "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, statePath);
  return { ok: true, statePath, created: true, reason: "CANDIDATE_STATE_CREATED" };
}

export function loadPaperCandidate(root: string, candidateId: string): PaperCandidateWallet | null {
  try {
    const statePath = path.join(paperCandidateDir(root, candidateId), "wallet.json");
    const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as PaperCandidateWallet;
    if (value.mode !== "ISOLATED_PAPER_ONLY" || value.initialBalanceUsd !== 200 || value.liveEnabled !== false) return null;
    return value;
  } catch { return null; }
}

export function candidateParameterHash(strategyId: string, parentVersion: string, parameters: Record<string, unknown>): string {
  return canonicalHash({ strategyId, parameters, parentVersion });
}
