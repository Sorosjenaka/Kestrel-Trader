// apps/server/src/learning/swingEvalRegistry.ts
// Registry subjek evaluasi SWING PAPER yang benar-benar ada di source VPS.
//
// Operator 19 Okt 2026: EMPAT strategi SWING non-Fibonacci.
//   S-05   -> Polaris
//   RSW-01 -> Orion
//   RSW-02 -> Vega
//   RSW-03 -> Draco
//
// 21 Okt 2026 (Phase 2 plan audit): S-05 Polaris PINDAH ke arsip. Entry-nya
// sudah retired 20 Okt 2026 (edge negatif: master_v2 executed PF 0.7503,
// P(EV<=0)=99,9%). Eval loop kini hanya mengevaluasi 3 subjek entry
// (RSW-01/02/03) -> biaya LLM tidak lagi terkuras untuk strategi yang tidak
// bisa entry. Mesin S-05 (swingBreakoutEngine) TETAP HIDUP untuk historical
// replay (historicalReplay.ts -> evaluateSwingBreakoutArchive) dan worker
// forward paper Polaris (systemd artatrade-swing-paper-polaris.service) —
// keduanya independen dari registry ini.
//
// S-03 adalah Fibonacci Zone 0.5-0.618 (lihat strategyCatalog/setupStrategies
// dan ledger S-03). ID itu dinonaktifkan untuk entry/evaluasi/eksperimen SWING
// baru, tetapi tetap dipakai lane SCALP dan histori. Nama arsipnya: Atlas.
// Jangan memindahkan nama/ID Fibo ke strategi lain dan jangan mengganti FK.

export type SwingEvalDirection = "LONG" | "SHORT" | "BOTH" | "SHORT_ONLY";
export type SwingEvalLifecycle =
  | "REGISTERED_PAPER"
  | "FORWARD_PAPER"
  | "RESEARCH_HISTORICAL"
  | "DISABLED_BY_OPERATOR";

export interface SwingEvalStrategyIdentity {
  strategyId: string;
  /** Nama operator tanpa awalan Arta/ArtaSwing. */
  displayName: string;
  /** Nama teknis/riset lama; alias, bukan pengganti ID. */
  name: string;
  aliases: string[];
  version: string;
  parameterVersion: string;
  exitPolicyVersion: string;
  direction: SwingEvalDirection;
  supportedDirections: SwingEvalDirection;
  /** True hanya untuk identitas Fibonacci yang diarsipkan. */
  fibo: boolean;
  longComponent: string | null;
  shortComponent: string | null;
  signalTimeframe: string;
  executionTimeframe: string;
  exitPolicy: string;
  /** Evaluator entry point actually used by the PAPER funnel. */
  evaluator: string;
  /** SHA-256 of the primary evaluator/source files at freeze time. */
  sourceHash: string;
  gates: string[];
  lifecycle: SwingEvalLifecycle;
  researchOnly: boolean;
  sourcePaths: string[];
  evidenceLimit: string;
  provenance: string;
  disabledAt?: string;
  disabledReason?: string;
}

const SHARED_RR23 = "SWING RR23: TP1 50% @2R, BE, TP2/final 50% @3R";

export const SWING_EVAL_STRATEGIES: readonly SwingEvalStrategyIdentity[] = [
  {
    strategyId: "RSW-01",
    displayName: "Orion",
    name: "BOS D1 + PHEN Locked",
    aliases: ["RSW-01", "BOS LONG + PHEN SHORT", "Orion"],
    version: "orion-2026-10-19",
    parameterVersion: "rsw-port-2026-10-18",
    exitPolicyVersion: "SWING_50_2R_BE_50_3R_V1",
    direction: "BOTH",
    supportedDirections: "BOTH",
    fibo: false,
    longComponent: "BOS_LIMIT_RETEST + BTC_D1_ALIGN",
    shortComponent: "PHEN_FADE_LIMIT locked (ATR1.5, CONTROL)",
    signalTimeframe: "4h",
    executionTimeframe: "4h / 15m",
    exitPolicy: SHARED_RR23,
    evaluator: "buildRswPlans() -> rswSignals",
    sourceHash: "sha256:rswSignals=6a5f01a6ffa4;rswPlans=31d90f1f891e;swingEngine=06e297a05b24",
    gates: ["BTC_D1_ALIGN", "PHEN lock", "structural SL", "RR23 exit"],
    lifecycle: "FORWARD_PAPER",
    researchOnly: true,
    sourcePaths: ["apps/server/src/strategies/researchSwing/rswSignals.ts", "apps/server/src/strategies/researchSwing/rswPlans.ts"],
    evidenceLimit: "Ledger forward RSW harus dipisahkan per strategi; jangan menjumlahkan wallet bersama.",
    provenance: "RSW-01 = port riset LONG_BOS_D1_SHORT_LOCKED_PHEN; PHEN version tetap.",
  },
  {
    strategyId: "RSW-02",
    displayName: "Vega",
    name: "PHEN Profile + PHEN Locked",
    aliases: ["RSW-02", "PHEN BOTH", "Vega"],
    version: "vega-2026-10-19",
    parameterVersion: "rsw-port-2026-10-18",
    exitPolicyVersion: "SWING_50_2R_BE_50_3R_V1",
    direction: "BOTH",
    supportedDirections: "BOTH",
    fibo: false,
    longComponent: "PHEN_FADE_LIMIT + PROFILE_CONTEXT (POC/VWAP/RVOL/CLV)",
    shortComponent: "PHEN_FADE_LIMIT locked (ATR1.5, CONTROL)",
    signalTimeframe: "4h",
    executionTimeframe: "4h / 15m",
    exitPolicy: SHARED_RR23,
    evaluator: "buildRswPlans() -> rswSignals",
    sourceHash: "sha256:rswSignals=6a5f01a6ffa4;rswPlans=31d90f1f891e;swingEngine=06e297a05b24",
    gates: ["PROFILE_CONTEXT", "PHEN lock", "structural SL", "RR23 exit"],
    lifecycle: "FORWARD_PAPER",
    researchOnly: true,
    sourcePaths: ["apps/server/src/strategies/researchSwing/rswSignals.ts", "apps/server/src/strategies/researchSwing/rswPlans.ts"],
    evidenceLimit: "Ledger forward RSW harus dipisahkan per strategi; jangan menjumlahkan wallet bersama.",
    provenance: "RSW-02 = port LONG_PHEN_PROFILE_SHORT_LOCKED_PHEN; bukan klaim PHEN BOTH stand-alone.",
  },
  {
    strategyId: "RSW-03",
    displayName: "Draco",
    name: "AlgoChief Fade + Ridge",
    aliases: ["RSW-03", "AlgoChief SHORT", "Draco"],
    version: "draco-2026-10-19",
    parameterVersion: "rsw-port-2026-10-18",
    exitPolicyVersion: "SWING_50_2R_BE_50_3R_V1",
    direction: "SHORT_ONLY",
    supportedDirections: "SHORT_ONLY",
    fibo: false,
    longComponent: null,
    shortComponent: "AlgoChief SHORT + H4 ADX<25 + retrace 0.25 ATR + Ridge >= 0",
    signalTimeframe: "1h",
    executionTimeframe: "1h / 15m",
    exitPolicy: SHARED_RR23,
    evaluator: "buildRswPlans() -> rswSignals",
    sourceHash: "sha256:rswSignals=6a5f01a6ffa4;rswPlans=31d90f1f891e;swingEngine=06e297a05b24",
    gates: ["H4 ADX<25", "Ridge seed", "structural SL", "RR23 exit"],
    lifecycle: "FORWARD_PAPER",
    researchOnly: true,
    sourcePaths: ["apps/server/src/strategies/researchSwing/rswSignals.ts", "apps/server/src/strategies/researchSwing/rswPlans.ts"],
    evidenceLimit: "SHORT-only: LONG=N/A. Jangan menambah LONG dummy.",
    provenance: "RSW-03 = port swing_paper_signals.algo_signals, seed SHORT-only.",
  },
] as const;

export const SWING_EVAL_IDS = SWING_EVAL_STRATEGIES.map((s) => s.strategyId);

/**
 * Strategi SWING yang diarsipkan.
 *   S-03 -> Atlas (Fibonacci Zone 0.5-0.618), dinonaktifkan 19 Okt 2026.
 *   S-05 -> Polaris (Swing Breakout Pattern), entry di-retire 20 Okt 2026 dan
 *           dipindahkan ke arsip 21 Okt 2026 (Phase 2 plan audit).
 * ID lama tetap punya arti historis untuk label trade lama dan replay arsip;
 * objek ini hanya metadata lifecycle SWING PAPER, bukan entry source baru.
 */
export const ARCHIVED_SWING_STRATEGIES: readonly SwingEvalStrategyIdentity[] = [
  {
    strategyId: "S-03",
    displayName: "Atlas",
    name: "Fibonacci Zone 0.5-0.618 (SWING H1)",
    aliases: ["S-03", "Fibonacci Zone 0.5-0.618", "Atlas"],
    version: "catalog-2026-10-18",
    parameterVersion: "fib-zone-2026-10-07",
    exitPolicyVersion: "SWING_50_2R_BE_50_3R_V1",
    direction: "BOTH",
    supportedDirections: "BOTH",
    fibo: true,
    longComponent: "fibRetracementEngine",
    shortComponent: "fibRetracementEngine",
    signalTimeframe: "1h",
    executionTimeframe: "15m / 1h",
    exitPolicy: SHARED_RR23,
    evaluator: "evaluateFibRetracement() — ARCHIVED for SWING",
    // 21 Okt 2026 (P-4.19): hash lama salah referensi ke swingBreakoutEngine
    // (itu mesin S-05 Polaris, bukan Fibonacci). Sumber S-03 = fibRetracementEngine.
    // Karena arsip, hash source tidak lagi diverifikasi -> N/A-archived.
    sourceHash: "N/A-archived",
    gates: ["eligibility", "volume", "volatility", "score/KNN", "ARM/caps", "Drex/Xkiro"],
    lifecycle: "DISABLED_BY_OPERATOR",
    researchOnly: false,
    sourcePaths: ["apps/server/src/strategies/strategyCatalog.ts", "apps/server/src/strategies/setupStrategies.ts"],
    evidenceLimit: "Entry/evaluasi/eksperimen SWING baru dihentikan 19 Okt 2026; posisi lama tetap dikelola.",
    provenance: "Dibuktikan dari strategyCatalog S-03 = Fibonacci Zone 0.5-0.618 dan katalog SWING komposit.",
    disabledAt: "2026-10-19T00:00:00+07:00",
    disabledReason: "FIBONACCI_DISABLED_BY_OPERATOR_FOUR_NON_FIB_SWING",
  },
  {
    strategyId: "S-05",
    displayName: "Polaris",
    name: "Swing Breakout Pattern",
    aliases: ["S-05", "Swing Breakout", "Polaris"],
    version: "polaris-2026-10-19",
    parameterVersion: "catalog-2026-10-18",
    exitPolicyVersion: "SWING_50_2R_BE_50_3R_V1",
    direction: "BOTH",
    supportedDirections: "BOTH",
    fibo: false,
    longComponent: "swingBreakoutEngine",
    shortComponent: "swingBreakoutEngine",
    signalTimeframe: "1h",
    executionTimeframe: "15m / 1h",
    exitPolicy: SHARED_RR23,
    evaluator: "evaluateSwingBreakoutArchive() — RESEARCH/REPLAY ONLY (entry retired 20 Okt 2026)",
    sourceHash: "sha256:setupStrategies=a0fb1a89c500;swingBreakoutEngine=d948a24168e0",
    gates: ["eligibility", "volume", "volatility", "score/KNN", "ARM/caps", "Drex/Xkiro"],
    lifecycle: "RESEARCH_HISTORICAL",
    researchOnly: true,
    sourcePaths: ["apps/server/src/strategies/strategyCatalog.ts", "apps/server/src/strategies/setupStrategies.ts"],
    evidenceLimit: "Entry retired 20 Okt 2026 (edge negatif: master_v2 PF 0.7503, P(EV<=0)=99.9%). Mesin tetap hidup HANYA untuk historical replay dan riset arsip; bukan entry source.",
    provenance: "Port 1:1 swingBreakoutEngine/v2_breakout.py; katalog S-05. Entry dihapus 20 Okt 2026; arsip/replay dipertahankan.",
    disabledAt: "2026-10-20T00:00:00+07:00",
    disabledReason: "POLARIS_RETIRED_NEGATIVE_EDGE_ARCHIVED_FROM_EVAL_LOOP",
  },
] as const;

export const ARCHIVED_FIBONACCI_ID = "S-03";

export function swingEvalStrategy(id: string): SwingEvalStrategyIdentity | null {
  return SWING_EVAL_STRATEGIES.find((s) => s.strategyId === id) ?? null;
}

/**
 * Identitas STRATEGI yang dievaluasi loop (aktif) atau diarsipkan (arsip).
 * 21 Okt 2026: dipakai untuk lookup NAMA DISPLAY ONLY — S-05 sudah pindah ke
 * arsip, jadi lookup display tidak boleh gagal hanya karena archivenya berubah.
 * Untuk menentukan boleh/tidaknya dievaluasi, tetap pakai swingEvalStrategy()
 * (aktif) atau archivedSwingStrategy() (arsip).
 */
export function swingEvalIdentity(id: string): SwingEvalStrategyIdentity | null {
  return SWING_EVAL_STRATEGIES.find((s) => s.strategyId === id)
    ?? ARCHIVED_SWING_STRATEGIES.find((s) => s.strategyId === id)
    ?? null;
}

export function archivedSwingStrategy(id: string): SwingEvalStrategyIdentity | null {
  return ARCHIVED_SWING_STRATEGIES.find((s) => s.strategyId === id) ?? null;
}

/**
 * Kandidat historis yang tidak punya identitas runtime. Jangan membuat
 * strategi palsu atau menggabungkan ledger yang berbeda.
 */
export const ARCHIVED_SWING_CANDIDATES = [
  {
    candidate: "BOS LONG + Algo V7 SHORT",
    historicalLabel: "kandidat #3 (637 trade hybrid; ledger/version manifest tidak ditemukan)",
    runtimeStrategyId: null,
    reason: "Tidak ada strategyId/evaluator terdaftar; bukan RSW-03.",
  },
  {
    candidate: "PHEN stand-alone BOTH",
    historicalLabel: "kandidat #4 (1479 trade PHEN BOTH)",
    runtimeStrategyId: null,
    reason: "Tidak ada strategyId/evaluator terdaftar; komponen PHEN dipakai di RSW-01/02, tetapi ledger BOTH berbeda.",
  },
] as const;

export function isSwingEvalId(id: string): boolean {
  return SWING_EVAL_IDS.includes(id);
}

export function isArchivedSwingId(id: string): boolean {
  return ARCHIVED_SWING_STRATEGIES.some((s) => s.strategyId === id);
}

/**
 * Role map for the PAPER loop. This is a mapping to agents that ACTUALLY
 * exist in agentCatalog.ts, not a claim that every role is called every tick.
 * Only the evaluator is invoked in the current loop; the others are explicit
 * review roles for operator/roundtable use. Scheduler/accounting/backtest/gate/
 * risk/executor are deterministic code.
 */
export const SWING_EVAL_AGENT_ROLES = [
  { role: "Evaluator/thesis", agentId: "strategy-tuner", agentName: "Laras", model: "REASON", router: "XKIRO", schema: "SwingEvalFeedback", fallback: "DETERMINISTIC_FALLBACK", calledByLoop: true },
  { role: "Skeptic", agentId: "setup-judge", agentName: "Arka", model: "REASON", router: "XKIRO", schema: "counterEvidence[] + missingEvidence[]", fallback: "deterministic counter-evidence checklist", calledByLoop: false },
  { role: "Experiment designer", agentId: "strategy-tuner", agentName: "Laras", model: "REASON", router: "XKIRO", schema: "UNIVERSE_FILTER|RECHECK_BASELINE", fallback: "NO_CHANGE", calledByLoop: true },
  { role: "Contract/risk reviewer", agentId: "risk-officer", agentName: "Wardha", model: "REASON", router: "XKIRO", schema: "PAPER contract checklist (read-only)", fallback: "fail-closed deterministic guards", calledByLoop: false },
  { role: "Scheduler", agentId: "scanner-supervisor", agentName: "Bima", model: "DETERMINISTIC", router: "none", schema: "SwingEvalRun/state.json", fallback: "timer + cursor", calledByLoop: true },
  { role: "Accounting", agentId: "post-mortem", agentName: "Sesha", model: "DETERMINISTIC", router: "none", schema: "SwingEvalAggregate", fallback: "fee/funding labels", calledByLoop: true },
  { role: "Backtest/OOS gate", agentId: "backtest-auditor", agentName: "Varuna", model: "DETERMINISTIC", router: "none", schema: "SwingEvalBacktestResult", fallback: "INSUFFICIENT_DATA", calledByLoop: true },
  { role: "Risk planner/executor", agentId: "risk-officer", agentName: "Wardha", model: "DETERMINISTIC", router: "none", schema: "$1 risk + RR23 + caps", fallback: "reject admission", calledByLoop: true },
] as const;

export interface SwingThesisCard {
  strategyId: string;
  displayName: string;
  aliases: string[];
  version: string;
  parameterVersion: string;
  exitPolicyVersion: string;
  direction: SwingEvalDirection;
  hypothesis: string;
  matchingConditions: string[];
  breakConditions: string[];
  entryRules: string[];
  invalidation: string;
  exitPolicy: string;
  costAssumptions: string[];
  evidenceAvailable: string;
  unknown: string[];
  status: string;
  reviewCriteria: string[];
}

/** Structured hypothesis card consumed by the evaluation prompt/API. */
export function buildSwingThesisCard(strategyId: string): SwingThesisCard | null {
  const s = swingEvalStrategy(strategyId);
  if (!s) return null;
  return {
    strategyId: s.strategyId,
    displayName: s.displayName,
    aliases: s.aliases,
    version: s.version,
    parameterVersion: s.parameterVersion,
    exitPolicyVersion: s.exitPolicyVersion,
    direction: s.direction,
    hypothesis: `${s.displayName} memiliki edge hanya bila ${s.longComponent ?? "N/A"} / ${s.shortComponent ?? "N/A"} muncul pada kondisi yang dapat diukur dan biaya penuh masih tertutup.`,
    matchingConditions: s.gates,
    breakConditions: [
      "Sinyal muncul saat data stale atau candle belum tutup",
      "SL struktural lebih lebar dari batas biaya/risiko",
      "Exit policy berubah tanpa version baru",
      "Konsentrasi simbol/arah membuat hasil bukan bukti independen",
    ],
    entryRules: [s.longComponent ? `LONG: ${s.longComponent}` : "LONG: N/A", s.shortComponent ? `SHORT: ${s.shortComponent}` : "SHORT: N/A"],
    invalidation: "Invalidasi struktural pada level SL; bukan alasan untuk average down atau memperlebar SL.",
    exitPolicy: s.exitPolicy,
    costAssumptions: ["maker 0.0002; taker 0.0005 hanya referensi", "fee/funding aktual harus tercatat; legacy fee=0 tidak boleh dianggap net"],
    evidenceAvailable: s.evidenceLimit,
    unknown: ["sample OOS memadai", "funding point-in-time", "paritas paper-vs-live"],
    status: s.lifecycle,
    reviewCriteria: ["sample floor 500", "net EV > 0 setelah fee/funding", "arah dan simbol tidak terkonsentrasi", "hasil bertahan pada periode OOS terpisah"],
  };
}
