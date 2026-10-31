// apps/server/src/learning/strategyTuner.ts - Strategy Tuner + Backtest Auditor + ParameterVersion (FR-28, US-11, US-12).
import { XkiroAdapter, defaultLlmAdapter } from "../agents/llmAdapter.js";
import { ALL_12_AGENTS } from "../agents/agentCatalog.js";
import { AgentDialog } from "../agents/researchLayer.js";
import { calculateMetrics, type BacktestRunOutput, type RunBacktestOptions } from "../backtest/backtestEngine.js";
import type { HistoricalDataset } from "../backtest/historicalReplay.js";
import { datasetHash } from "../backtest/historicalReplay.js";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { randomUUID } from "node:crypto";
import { TRADING_EVIDENCE_POLICY } from "../agents/tradingPolicy.js";
import { extractJsonObject } from "./postMortemEvaluator.js";
import { SETUP_ENGINE, rrPolicyForMode, setRuntimeTp1R, clearRuntimeTp1R, type SetupMode } from "../config/setupEngine.js";
import { RUNTIME_PARAMS, clearAllRuntimeParams, isRuntimeSupported, isRuntimeTunable } from "../config/runtimeParams.js";
import { DEFAULT_LIQUIDITY_SNIPER_OPTIONS } from "../engines/indicatorLibrary.js";
import { blockBootstrapEv, deflatedSharpeOf } from "../analytics/stats/blockBootstrap.js";
import { runWorkerTask } from "../backtest/runWorker.js";
import { buildMicrostructurePromptBlock } from "../agents/marketIntel.js";

export type ParamVersionStatus = "CANDIDATE" | "TESTING" | "ACTIVE" | "REJECTED" | "ROLLED_BACK";

export interface ParameterVersionRow {
  id: number;
  version: string;
  params: string;
  status: ParamVersionStatus | string;
  backtestRunId?: number | null;
  activatedAt?: Date | null;
  rollbackAt?: Date | null;
  createdAt: Date;
}

export interface TunerProposal {
  param: "tp1R" | "pullBiasThreshold";
  from: number;
  to: number;
  boundedPct: number;
  rationale: string;
}

export interface AuditDecision {
  version: string;
  passed: boolean;
  winrate: number;
  evUsd: number;
  sampleCount: number;
  status: "ACTIVE" | "REJECTED" | "CANDIDATE";
  reason: string;
}

export interface ParameterRepo {
  createVersion(data: Omit<ParameterVersionRow, "id">): Promise<ParameterVersionRow>;
  findByVersion(version: string): Promise<ParameterVersionRow | null>;
  findActiveVersion(): Promise<ParameterVersionRow | null>;
  updateVersion(id: number, data: Partial<ParameterVersionRow>): Promise<void>;
  listVersions(): Promise<ParameterVersionRow[]>;
  findCandidateFor(strategyId: string, mode: SetupMode): Promise<ParameterVersionRow | null>;
  findAuditByDatasetHash(hash: string): Promise<boolean>;
  logEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void>;
}

export class StrategyTuner {
  private readonly adapter: XkiroAdapter;
  private readonly repo: ParameterRepo;
  private readonly backtestRunner: (options: RunBacktestOptions) => BacktestRunOutput | Promise<BacktestRunOutput>;

  constructor(options?: { adapter?: XkiroAdapter; repo?: ParameterRepo; backtestRunner?: (options: RunBacktestOptions) => BacktestRunOutput | Promise<BacktestRunOutput> }) {
    this.adapter = options?.adapter ?? defaultLlmAdapter;
    this.repo = options?.repo ?? prismaParameterRepo;
    this.backtestRunner = options?.backtestRunner ?? (async (options) => {
      const result = await runWorkerTask<{ output: BacktestRunOutput }>(new URL("../backtest/backtestWorker.js", import.meta.url), { options }, 300_000);
      return result.output;
    });
  }

  async proposeTuning(context?: {
    causeCode?: string;
    strategyId?: string;
    currentTp1R?: number;
    // 30 Sep 2026 — refactor SCALP-only: mode tunggal.
    mode?: SetupMode;
    cohortEvidence?: { sampleCount: number; lossCount: number; winCount: number; averageR: number; medianR: number; netPnlUsd: number; feesUsd: number };
  }): Promise<{ proposal: TunerProposal; candidateVersion: string; dialog: AgentDialog; disabled?: boolean }> {
    const agent = ALL_12_AGENTS["strategy-tuner"];
    const mode = context?.mode ?? "SCALP";
    const strategyId = context?.strategyId ?? "S-01";
    const cause = context?.causeCode ?? "SL_TIGHT";
    const param: TunerProposal["param"] = strategyId === "S-02" && mode === "SCALP" ? "pullBiasThreshold" : "tp1R";
    const currentTp1R = param === "pullBiasThreshold" ? DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold : rrPolicyForMode(mode, strategyId).tp1R;
    if (!isRuntimeTunable(param, mode, strategyId)) {
      const reason = "TUNING_DISABLED_RR_LOCKED_BY_OPERATOR: strategi/mode ini tidak memiliki parameter replay yang boleh berubah.";
      return { disabled: true, candidateVersion: "", proposal: { param, from: currentTp1R, to: currentTp1R, boundedPct: 0, rationale: reason },
        dialog: { agentId: agent.id, name: agent.name, text: reason, timestamp: new Date().toISOString(), context: { status: "DISABLED", mode, strategyId } } };
    }
    const baselineValid = RUNTIME_PARAMS[param]!.validate(currentTp1R) !== null;

    const existingCandidate = await this.repo.findCandidateFor(strategyId, mode);
    if (existingCandidate) {
      const stored = extractJsonObject(existingCandidate.params);
      const proposal: TunerProposal = {
        param, from: Number(stored?.from) || currentTp1R, to: Number(stored?.to) || currentTp1R,
        boundedPct: Number(stored?.boundedPct) || 0,
        rationale: String(stored?.rationale ?? "Kandidat yang sama masih menunggu replay OOS."),
      };
      const text = `Kandidat ${existingCandidate.version} untuk ${strategyId}/${mode} masih menunggu audit OOS; tidak dibuat duplikat dan belum aktif.`;
      return { proposal, candidateVersion: existingCandidate.version, dialog: { agentId: agent.id, name: agent.name, text, timestamp: new Date().toISOString(), context: { candidateVersion: existingCandidate.version, proposal, status: "CANDIDATE" } } };
    }

    const sysPrompt = `Anda adalah ${agent.name} (${agent.id}), peneliti penyetel parameter di Private Trade AI.
Model: DeepSeek Reasoning. Kepribadian: ${agent.personality}.
Gaya bicara: ${agent.style}.
${TRADING_EVIDENCE_POLICY}
Tugas: usulkan hanya perubahan ${param} pada strategi/mode yang disebutkan, bounded <=10% relatif. TP1/RR terkunci operator dan tidak boleh diubah. Ini hipotesis, belum bukti peningkatan. Gunakan agregat cohort bila tersedia; satu trade tidak mengidentifikasi sebab.
Jawab JSON {"param":"${param}","from":angkaBaseline,"to":angkaUsulan,"rationale":"hipotesis, bukti penyangkal, eksperimen pembanding"}. Jika bukti trade/path cohort tidak cukup, jawab {}.`;

    const cohort = context?.cohortEvidence;
    const cohortText = cohort
      ? `Cohort trade tertutup strategi/mode ini: n=${cohort.sampleCount}, loss=${cohort.lossCount}, win=${cohort.winCount}, averageR=${cohort.averageR}, medianR=${cohort.medianR}, netPnLUsd=${cohort.netPnlUsd}, feesUsd=${cohort.feesUsd}. Ini ringkasan outcome, bukan data path/cause.`
      : "Cohort lintas trade tidak diberikan; jangan menebak pola dan kembalikan {} bila bukti tidak cukup.";
    const userPrompt = `Kasus ${cause}; strategi ${strategyId}, mode ${mode}; ${param} saat ini ${currentTp1R}.\n${cohortText}\n${await buildMicrostructurePromptBlock("BTC")}\nUsulkan ${param} bounded (maksimal delta 10%) untuk replay baseline-kandidat pada data historis out-of-sample. RR, SL, biaya, dan risiko jangan diubah.`;

    let text = "";
    if (baselineValid) {
      try {
        const res = await this.adapter.callReason(userPrompt, sysPrompt, { maxTokens: 1400 });
        text = res.content.trim();
      } catch { /* No invented numerical proposal when the model is unavailable. */ }
    }
    const parsed = extractJsonObject(text);
    const from = currentTp1R;
    const to = typeof parsed?.to === "number" && Number.isFinite(parsed.to) ? parsed.to : from;
    const boundedPct = baselineValid ? Math.abs(to - from) / Math.abs(from) * 100 : 0;
    const validProposal = baselineValid && parsed?.param === param && parsed.from === from
      && RUNTIME_PARAMS[param]!.validate(to) !== null && to !== from && boundedPct <= 10 + 1e-10
      && typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0;
    const proposal: TunerProposal = {
      param, from, to, boundedPct,
      rationale: validProposal ? String(parsed!.rationale) : `INSUFFICIENT_DATA_OR_INVALID_PROPOSAL: baseline/JSON/perubahan <=10% wajib valid. ${text.slice(0, 500)}`,
    };
    const candidateVersion = `candidate-${randomUUID()}`;
    await this.repo.createVersion({
      version: candidateVersion,
      params: JSON.stringify({ ...proposal, mode, strategyId, unit: "THRESHOLD", validProposal, runtimeSupported: true, cohortSampleCount: cohort?.sampleCount ?? 0, cohortLossCount: cohort?.lossCount ?? 0 }),
      status: validProposal ? "CANDIDATE" : "REJECTED",
      createdAt: new Date(),
    });
    text = validProposal
      ? `Hipotesis ${param} ${from} -> ${to} (${boundedPct.toFixed(2)}% relatif) untuk ${strategyId}. Belum diterapkan; wajib replay OOS.`
      : proposal.rationale;

    const dialog: AgentDialog = {
      agentId: agent.id,
      name: agent.name,
      text,
      timestamp: new Date().toISOString(),
      context: { candidateVersion, proposal },
    };

    await this.repo.logEvent("PARAMETER_TUNING_PROPOSED", "info", { candidateVersion, proposal });

    return { proposal, candidateVersion, dialog };
  }
  async auditAndGateVersion(
    version: string,
    options?: { strategyId?: string; dataset?: HistoricalDataset; maxDrawdownUsd?: number; mockBacktestResult?: BacktestRunOutput; mockBaselineResult?: BacktestRunOutput }
  ): Promise<{ audit: AuditDecision; dialog: AgentDialog }> {
    const row = await this.repo.findByVersion(version);
    if (!row) throw new Error(`ParameterVersion ${version} tidak ditemukan`);
    if (row.status !== "CANDIDATE" && row.status !== "TESTING") throw new Error("PARAMETER_VERSION_NOT_CANDIDATE");

    const agent = ALL_12_AGENTS["backtest-auditor"];
    const params = extractJsonObject(row.params);
    // 30 Sep 2026 — refactor SCALP-only: parameter historis dipetakan ke SCALP.
    const mode: SetupMode = params?.mode === "SWING" ? "SWING" : "SCALP";
    const strategyId = String(params?.strategyId ?? options?.strategyId ?? "S-01");
    const param = typeof params?.param === "string" ? params.param : "";
    const baselineTp1R = Number(params?.from);
    const candidateTp1R = Number(params?.to);
    if (!isRuntimeTunable(param, mode, strategyId)) return this.finishAudit(row, {
      version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "REJECTED", reason: "TUNING_DISABLED_RR_LOCKED_OR_NO_RUNTIME_PATH",
    });
    // T-09: knob terdaftar (tp1R, pullBiasThreshold) boleh diuji di gate;
    // parameter tanpa jalur runtime ditahan CANDIDATE, bukan langsung REJECTED.
    if (!isRuntimeSupported(param) || params?.runtimeSupported !== true || !Number.isFinite(baselineTp1R) || !Number.isFinite(candidateTp1R)) {
      return this.finishAudit(row, { version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "REJECTED", reason: "UNSUPPORTED_OR_INVALID_PARAMETER_VERSION" });
    }
    if (!options?.dataset && !options?.mockBacktestResult) {
      const audit: AuditDecision = { version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "CANDIDATE", reason: "WAITING_FOR_VERIFIED_HISTORICAL_OOS_DATASET: tidak ada perubahan runtime." };
      return { audit, dialog: await this.auditDialog(agent, audit) };
    }
    if (env.BINANCE_EXECUTION_MODE !== "PAPER") {
      const audit: AuditDecision = { version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "CANDIDATE", reason: "PAPER_ONLY_PARAMETER_ACTIVATION; LIVE mode never auto-changes strategy parameters." };
      return { audit, dialog: await this.auditDialog(agent, audit) };
    }
    if ((options?.mockBacktestResult || options?.mockBaselineResult) && this.repo === prismaParameterRepo) throw new Error("MOCK_BACKTEST_FORBIDDEN_IN_PRODUCTION");

    const hash = options?.dataset ? datasetHash(options.dataset) : `test-${version}`;
    if (await this.repo.findAuditByDatasetHash(hash)) {
      return this.finishAudit(row, { version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "REJECTED", reason: "OOS_DATASET_ALREADY_USED_FOR_PARAMETER_SELECTION" });
    }

    const common = {
      strategyId, mode, dataset: options?.dataset, sampleCount: 0, minSamples: 500, minWinrate: 60,
      maxDrawdownUsd: options?.maxDrawdownUsd ?? 8,
    } satisfies Partial<RunBacktestOptions>;
    const paramDef = RUNTIME_PARAMS[param]!;
    if (paramDef.validate(baselineTp1R) === null || paramDef.validate(candidateTp1R) === null
      || candidateTp1R === baselineTp1R || Math.abs(candidateTp1R - baselineTp1R) / baselineTp1R > .1 + 1e-10) return this.finishAudit(row, {
      version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "REJECTED", reason: "INVALID_OR_UNBOUNDED_PARAMETER_CHANGE",
    });
    if (Math.abs(DEFAULT_LIQUIDITY_SNIPER_OPTIONS.pullBiasThreshold - baselineTp1R) > 1e-9) return this.finishAudit(row, {
      version, passed: false, winrate: 0, evUsd: 0, sampleCount: 0, status: "REJECTED", reason: "CURRENT_PARAMETER_BASELINE_CHANGED",
    });
    const candidateRun = options?.mockBacktestResult ?? await this.backtestRunner({ ...common, paramsVersion: version, pullBiasThresholdOverride: candidateTp1R } as RunBacktestOptions);
    const baselineRun = options?.mockBaselineResult ?? await this.backtestRunner({ ...common, paramsVersion: `baseline-${version}`, pullBiasThresholdOverride: baselineTp1R } as RunBacktestOptions);
    const winratePct = candidateRun.metrics.winrate;
    const candidateEvidence = candidateRun.provenance;
    const baselineEvidence = baselineRun.provenance;
    const errors: string[] = [];
    if (candidateRun.status !== "PASSED" || !candidateRun.gatePassed) errors.push("CANDIDATE_BACKTEST_GATE_FAILED");
    if (baselineRun.status !== "PASSED" || !baselineRun.gatePassed) errors.push("BASELINE_BACKTEST_GATE_FAILED");
    if (!Number.isInteger(candidateRun.metrics.sampleCount) || candidateRun.metrics.sampleCount < 500) errors.push("MIN_500_CLOSED_OOS_TRADES");
    if (!Number.isFinite(winratePct) || winratePct < 60 || winratePct > 100 || !(candidateRun.metrics.evUsd > 0) || !(candidateRun.metrics.totalNetPnlUsd > 0)) errors.push("CANDIDATE_NET_WR_OR_EXPECTANCY_FAILED");
    if (!(candidateRun.metrics.evUsd > baselineRun.metrics.evUsd)) errors.push("CANDIDATE_DID_NOT_IMPROVE_BASELINE_EV");
    if (!(candidateRun.metrics.maxDdUsd <= Math.min(options?.maxDrawdownUsd ?? 8, baselineRun.metrics.maxDdUsd * 1.05))) errors.push("CANDIDATE_DRAWDOWN_WORSE_THAN_BASELINE_OR_LIMIT");
    if (candidateEvidence?.kind !== "HISTORICAL_REPLAY" || !candidateEvidence.outOfSampleFrom || !candidateEvidence.outOfSampleTo) errors.push("CANDIDATE_OOS_HISTORICAL_EVIDENCE_REQUIRED");
    if (baselineEvidence?.kind !== "HISTORICAL_REPLAY" || !baselineEvidence.outOfSampleFrom || !baselineEvidence.outOfSampleTo) errors.push("BASELINE_OOS_HISTORICAL_EVIDENCE_REQUIRED");
    if (candidateRun.paramsVersion !== version || candidateEvidence?.strategyVersion !== version || !candidateEvidence.parametersApplied) errors.push("CANDIDATE_TP1R_NOT_ACTUALLY_REPLAYED");
    if (baselineRun.paramsVersion !== `baseline-${version}` || !baselineEvidence?.parametersApplied) errors.push("BASELINE_TP1R_NOT_ACTUALLY_REPLAYED");
    if (candidateEvidence?.appliedParameters?.[param] !== candidateTp1R || baselineEvidence?.appliedParameters?.[param] !== baselineTp1R) errors.push("PARAMETER_VALUE_NOT_VERIFIED_IN_REPLAY");
    if (!Array.isArray(candidateRun.trades) || candidateRun.trades.length !== candidateRun.metrics.sampleCount
      || !Array.isArray(baselineRun.trades) || baselineRun.trades.length !== baselineRun.metrics.sampleCount) errors.push("REPLAY_TRADE_COUNT_MISMATCH");
    for (const run of [candidateRun, baselineRun]) {
      const recalculated = calculateMetrics(run.trades ?? []);
      const auditOnly = new Set(["breakevenCount", "grossProfitUsd", "grossLossUsd", "profitFactor"]);
      if ((Object.keys(recalculated) as Array<keyof typeof recalculated>).some(key => {
        if (auditOnly.has(String(key))) return false;
        return !Number.isFinite(run.metrics[key] as number) || Math.abs((run.metrics[key] as number) - (recalculated[key] as number)) > 1e-5;
      })) errors.push("REPLAY_METRICS_DO_NOT_MATCH_TRADES");
    }
    if (candidateEvidence?.datasetHash !== baselineEvidence?.datasetHash || candidateEvidence?.datasetHash !== (options?.dataset ? hash : candidateEvidence?.datasetHash)) errors.push("BASELINE_CANDIDATE_DATASET_MISMATCH");
    if (candidateRun.strategyId !== strategyId || baselineRun.strategyId !== strategyId || candidateRun.mode !== mode || baselineRun.mode !== mode) errors.push("STRATEGY_OR_MODE_MISMATCH");
    // T-11: window tuning tidak boleh identik dengan window evaluasi (overfit terbuka).
    const tuningFrom = Date.parse(String((params as { tuningWindowFrom?: unknown })?.tuningWindowFrom ?? ""));
    const tuningTo = Date.parse(String((params as { tuningWindowTo?: unknown })?.tuningWindowTo ?? ""));
    const oosFrom = candidateEvidence?.outOfSampleFrom ? new Date(candidateEvidence.outOfSampleFrom).getTime() : NaN;
    const oosTo = candidateEvidence?.outOfSampleTo ? new Date(candidateEvidence.outOfSampleTo).getTime() : NaN;
    if (Number.isFinite(tuningFrom) && Number.isFinite(tuningTo) && tuningFrom < oosTo && tuningTo > oosFrom) {
      errors.push("TUNING_WINDOW_OVERLAPS_EVALUATION_WINDOW");
    }
    // T-12: EV wajib punya interval keyakinan dengan batas bawah > 0.
    const boot = blockBootstrapEv((candidateRun.trades ?? []).map((t) => t.netPnlUsd), { blockSize: 5, iterations: 1000, seed: 20261003 });
    if (!boot || !(boot.ciLower > 0)) errors.push("CANDIDATE_EV_CI_LOWER_NOT_POSITIVE");
    // T-10: Deflated Sharpe masuk teks audit (indikatif, bukan syarat tunggal).
    const dsr = deflatedSharpeOf((candidateRun.trades ?? []).map((t) => t.netPnlUsd));
    const dsrText = dsr ? ` DSR ${dsr.deflatedSharpe.toFixed(3)}.` : " DSR n/a.";
    const evCiText = boot ? ` EV 95% CI [${boot.ciLower.toFixed(4)}, ${boot.ciUpper.toFixed(4)}].` : "";
    const passed = errors.length === 0;
    const text = passed
      ? `Versi ${version} aktif setelah baseline-kandidat direplay pada dataset OOS yang sama: ${candidateRun.metrics.sampleCount} trade, WR ${winratePct.toFixed(1)}%, EV $${candidateRun.metrics.evUsd.toFixed(4)} vs baseline $${baselineRun.metrics.evUsd.toFixed(4)}, max DD $${candidateRun.metrics.maxDdUsd.toFixed(2)}.${dsrText}${evCiText}`
      : `Versi ${version} tidak aktif: ${errors.join("; ")}. Kandidat ${candidateRun.metrics.sampleCount} trade, WR ${winratePct}%, EV $${candidateRun.metrics.evUsd}; baseline EV $${baselineRun.metrics.evUsd}.${dsrText}${evCiText}`;
    const audit: AuditDecision = { version, passed, winrate: winratePct, evUsd: candidateRun.metrics.evUsd, sampleCount: candidateRun.metrics.sampleCount, status: passed ? "ACTIVE" : "REJECTED", reason: text };
    await this.repo.logEvent("PARAMETER_GATE_AUDIT", passed ? "info" : "warn", { ...audit, datasetHash: hash, strategyId, mode, baselineEvUsd: baselineRun.metrics.evUsd, candidateMaxDdUsd: candidateRun.metrics.maxDdUsd, baselineMaxDdUsd: baselineRun.metrics.maxDdUsd });
    if (passed) {
      const active = await this.repo.findActiveVersion();
      if (active && active.id !== row.id) await this.repo.updateVersion(active.id, { status: "ROLLED_BACK", rollbackAt: new Date() });
    }
    await this.repo.updateVersion(row.id, { status: passed ? "ACTIVE" : "REJECTED", activatedAt: passed ? new Date() : null, backtestRunId: typeof candidateRun.id === "number" && Number.isInteger(candidateRun.id) ? candidateRun.id : null });
    if (passed && !paramDef.apply(mode, strategyId, candidateTp1R, version)) {
      await this.repo.updateVersion(row.id, { status: "REJECTED", activatedAt: null });
      return this.finishAudit(row, { ...audit, passed: false, status: "REJECTED", reason: "RUNTIME_PARAMETER_VALIDATION_FAILED; version disarmed." });
    }
    return { audit, dialog: await this.auditDialog(agent, audit) };
  }

  // BAGIAN 3: Varuna (backtest-auditor) menerima konteks mikrostruktur & order
  // flow live pada dialog audit — fail-open, string kosong bila hub belum siap.
  private async auditDialog(agent: typeof ALL_12_AGENTS[string], audit: AuditDecision): Promise<AgentDialog> {
    const micro = await buildMicrostructurePromptBlock("BTC");
    return {
      agentId: agent.id, name: agent.name, text: audit.reason, timestamp: new Date().toISOString(),
      context: {
        version: audit.version, passed: audit.passed, status: audit.status,
        sampleCount: audit.sampleCount, winrate: audit.winrate, evUsd: audit.evUsd,
        ...(micro ? { microstructure: micro.trim() } : {}),
      },
    };
  }

  private async finishAudit(row: ParameterVersionRow, audit: AuditDecision): Promise<{ audit: AuditDecision; dialog: AgentDialog }> {
    await this.repo.updateVersion(row.id, { status: audit.status === "CANDIDATE" ? "CANDIDATE" : "REJECTED" });
    await this.repo.logEvent("PARAMETER_VERSION_REJECTED", audit.status === "CANDIDATE" ? "info" : "warn", audit as unknown as Record<string, unknown>);
    return { audit, dialog: await this.auditDialog(ALL_12_AGENTS["backtest-auditor"], audit) };
  }

}

export const prismaParameterRepo: ParameterRepo = {
  async createVersion(data) {
    const row = await db.parameterVersion.create({
      data: {
        version: data.version,
        params: data.params,
        status: data.status,
        createdAt: data.createdAt,
      },
    });
    return row as ParameterVersionRow;
  },

  async findByVersion(version) {
    const row = await db.parameterVersion.findUnique({
      where: { version },
    });
    return row as ParameterVersionRow | null;
  },

  async findActiveVersion() {
    const row = await db.parameterVersion.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { activatedAt: "desc" },
    });
    return row as ParameterVersionRow | null;
  },

  async updateVersion(id, data) {
    await db.parameterVersion.update({
      where: { id },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.activatedAt !== undefined ? { activatedAt: data.activatedAt } : {}),
        ...(data.rollbackAt !== undefined ? { rollbackAt: data.rollbackAt } : {}),
        ...(data.backtestRunId !== undefined ? { backtestRunId: data.backtestRunId } : {}),
      },
    });
  },

  async listVersions() {
    const rows = await db.parameterVersion.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows as ParameterVersionRow[];
  },

  async findCandidateFor(strategyId, mode) {
    const rows = await db.parameterVersion.findMany({ where: { status: "CANDIDATE" }, orderBy: { createdAt: "desc" } });
    return (rows as ParameterVersionRow[]).find((row) => {
      const params = extractJsonObject(row.params);
      return isRuntimeTunable(params?.param, mode, strategyId) && params?.runtimeSupported === true
        && params.strategyId === strategyId && params.mode === mode;
    }) ?? null;
  },

  async logEvent(type, severity, payload) {
    await db.eventLog.create({
      data: {
        type,
        severity,
        payload: JSON.stringify(payload),
      },
    });
  },

  async findAuditByDatasetHash(hash) {
    const event = await db.eventLog.findFirst({
      where: { type: "PARAMETER_GATE_AUDIT", payload: { contains: hash } },
      select: { id: true },
    });
    return Boolean(event);
  },
};

export async function refreshActiveParameterRuntime(): Promise<{ version: string | null; applied: boolean; reason: string }> {
  clearAllRuntimeParams();
  if (env.BINANCE_EXECUTION_MODE !== "PAPER") return { version: null, applied: false, reason: "AUTO_PARAMETER_RUNTIME_DISABLED_OUTSIDE_PAPER" };
  const active = await prismaParameterRepo.findActiveVersion();
  if (!active) return { version: null, applied: false, reason: "NO_ACTIVE_PARAMETER_VERSION" };
  const params = extractJsonObject(active.params);
  // 30 Sep 2026 — refactor SCALP-only: parameter historis dipetakan ke SCALP.
  const mode: SetupMode = params?.mode === "SWING" ? "SWING" : "SCALP";
  const strategyId = typeof params?.strategyId === "string" ? params.strategyId : "";
  const param = typeof params?.param === "string" ? params.param : "";
  const rawTo = Number((params as { to?: unknown })?.to);
  // T-09: parameter TANPA jalur runtime ditahan CANDIDATE (bukan REJECTED),
  // supaya Promote tidak membuang kandidat yang belum punya knob runtime.
  if (params?.runtimeSupported !== true || !isRuntimeSupported(param) || !isRuntimeTunable(param, mode, strategyId)) {
    await prismaParameterRepo.updateVersion(active.id, { status: "CANDIDATE" });
    await prismaParameterRepo.logEvent("ACTIVE_PARAMETER_NO_RUNTIME_PATH", "warn", { version: active.version, mode, strategyId, param });
    return { version: active.version, applied: false, reason: `NO_RUNTIME_PATH_FOR_PARAM ${param || "(kosong)"}` };
  }
  const def = RUNTIME_PARAMS[param]!;
  const value = def.validate(rawTo);
  if (value === null || !def.apply(mode, strategyId, value, active.version)) {
    await prismaParameterRepo.updateVersion(active.id, { status: "REJECTED", rollbackAt: new Date() });
    await prismaParameterRepo.logEvent("ACTIVE_PARAMETER_INVALID", "error", { version: active.version, mode, strategyId, param });
    return { version: active.version, applied: false, reason: "ACTIVE_PARAMETER_VALIDATION_FAILED_AND_DISARMED" };
  }
  return { version: active.version, applied: true, reason: def.describe(value) };
}

export const defaultStrategyTuner = new StrategyTuner();

