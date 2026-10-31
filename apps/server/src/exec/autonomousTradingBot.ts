// apps/server/src/exec/autonomousTradingBot.ts
// Autonomous Trading Bot Orchestrator & Continuous Looping Learning Engine.
import type { Prisma } from "@prisma/client";
import { env } from "../core/env.js";
import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { scannerPool, CandidateItem } from "../scanner/scannerPool.js";
import { defaultDailyRiskGuard, MAX_OPEN_POSITIONS } from "../risk/dailyGuard.js";
import { executionScopedOpenWhere, swingSlotCap } from "../risk/positionScope.js";
import { AUTO_STOP_GAP_BPS, calculateOrderPlan, checkMarginLevel, maxMarginForMode, performanceScore, resolveMarginPolicy, START_EQUITY_USD } from "../risk/riskEngine.js";
import { lossCooldownGuard, seedLossCooldownOnce } from "../risk/lossCooldown.js";
import { defaultOrderExecutor } from "./orderExecutor.js";
import { executePlannedEntry } from "./plannedEntry.js";
import { defaultPositionSupervisor } from "./positionSupervisor.js";
import { defaultDecisionRiskLayer } from "../agents/decisionRiskLayer.js";
import { calculate1hChangePct, evaluateAltMatrix, evaluateMacroGate, analyzeMacroSymbol, analyzeBtcDom, MACRO_KLINE_LIMIT, type AltMatrixResult } from "../engines/macroGate.js";
import { Bar, evaluateEligibility } from "../universe/eligibility.js";
import { evaluateVolatilityShield } from "../engines/regimeTrendEngine.js";
import { calculateEfficiencyRatio } from "../engines/trendQuality.js";
import { buildVolumeProfile, distanceFromPocInBins } from "../engines/volumeProfile.js";
import { fetchOpenInterestChangePct, calculateBetaBtc, getBtcReferenceBars } from "../engines/perceptionB4.js";
import { linkDecisionToPosition, logDecision } from "../learning/decisionLog.js";
import { buildSwingDecisionFeatures, mapSwingDecisionToDecisionLog } from "../learning/swingDecisionFeatures.js";
import { checkAssetClass, isPerpListed } from "../universe/assetClassGuard.js";
import { slotFillBudget, slotFillThresholds, agentReviewScoreFloor, isFreshEntryScan, isEntryCandidateReady, isAgentReviewCandidate, entryOncePerPair, trendFlipSideCooldown, postCloseReentryCooldown, REENTRY_COOLDOWN_MS, swingEntrySpacing, checkPairRedundancy, checkTradeVolume, getTradeVolumeFloor, checkChopVeto, canOpenTradingLane, prioritizeTradingLanes, selectRotatingTargets, scanGateMsFor, mtfWindowPlan, allowedStrategiesFor, symbolProbation, isStrategySideLocked, scalpLaneEnabled, swingLaneEnabled, getTradingStyle, type ModeCounts } from "./slotFillPolicy.js";
import { buildEntryAttrs } from "./entryAttrs.js";
import { prismaUniverseRepo } from "../universe/universeManager.js";
import { defaultPostMortemEvaluator, extractJsonObject, hasCompleteAgentPanel, prismaLearningRepo, shouldRetryAgentPanel } from "../learning/postMortemEvaluator.js";
import { defaultStrategyTuner, refreshActiveParameterRuntime } from "../learning/strategyTuner.js";
import { isRuntimeTunable } from "../config/runtimeParams.js";
import { learningModeOf, resolvedEntrySnapshot, swingCooldownDeadline, type EntryLearningSnapshot } from "../learning/learningContext.js";
import { decisionVeto } from "../agents/decisionVeto.js";

import { summarizeClosedTrades, buildResearchBrief, deriveTradeQty } from "../learning/researchBrief.js";
import type { TradeForEvaluation } from "../learning/postMortemEvaluator.js";
import { buildDailyReport, computeProcessReportCard, renderProcessReportCard, reportFileName } from "../agents/reportWriter.js";
import { formatRuleSummary } from "../learning/playbookRules.js";
import { evaluateThresholds, MetricAlertLog, type MetricAlert } from "../analytics/metricsRegistry.js";
import { runtimeParamsApplied } from "../config/runtimeParams.js";
import { defaultLlmAdapter } from "../agents/llmAdapter.js";
import { defaultResearchLayer } from "../agents/researchLayer.js";
import { defaultSupervisorWatchdogLayer } from "../agents/supervisorWatchdogLayer.js";
import { runMarketAnalystCycle } from "../agents/marketAnalyst.js";
import { ALL_12_AGENTS } from "../agents/agentCatalog.js";
import { confirmedMacroFlipDirection, readTrendWithAgents, TrendFlipConfirmationGuard } from "../agents/trendReversalEngine.js";
import { analyzeMultiTimeframe, getCachedMtf, type MtfAnalysis } from "../engines/multiTimeframeAnalyzer.js";
import { buildKnnFeatures, defaultKnnLibrary, serializeKnnLibrary, parseKnnLibraryFile } from "../engines/knnAnalogEngine.js";
import { selectBestPlan, buildSlTpMenu, applySlTpChoice, type StrategyPlan } from "../strategies/setupStrategies.js";
import { loadScalpMrvContext, loadSwingRswContext, countPositionsByMode } from "../strategies/modeContext.js";
import { SETUP_ENGINE, rrPolicyForMode, slBandFor } from "../config/setupEngine.js";
import { getTimeframePlan } from "../config/timeframes.js";
import { checkAgentReviewMarketFit, checkModeMarketFit, isSidewaysBias, loserDropAllowed, sidewaysEntryAllowed, MIN_SCALP_STRUCTURE_ATR_PCT } from "./marketSelectionPolicy.js";
import { progressiveEnabled, progressiveOverride, progressiveThresholdsFor, resolveProgressiveLevel, type ProgressiveLevel } from "./progressivePolicy.js";
import { activeProgressiveLevel } from "./slotFillPolicy.js";
import { gatherMarketContextSnapshot, buildMicrostructurePromptBlock, type MicrostructureFlowBlock } from "../agents/marketIntel.js";
import { maybeTriggerPanelAnalysis } from "../analysis/panelInsights.js";
import { captureDrexPanelSnapshot } from "../analysis/drexPanelEvidence.js";
import { swingLadderLevelsFromTp1 } from "../strategies/swing/swingLevels.js";
import { runDirectionBattle } from "../agents/directionalBattleArena.js";
import { runThesisArenaSession } from "../agents/thesisArena.js";
import { linkDirectionBattleToPosition } from "../learning/directionBattleLearning.js";

// Seed sekali probation simbol dari DB saat siklus supervisi pertama
// (anti-churn, keputusan operator 4 Okt 2026: 3 loss beruntun -> blokir 45 menit).
let symbolProbationSeeded = false;
async function seedSymbolProbationOnce(): Promise<void> {
  if (symbolProbationSeeded) return;
  symbolProbationSeeded = true;
  try {
    const trades = await db.trade.findMany({
      where: { source: { not: "DEMO" } },
      orderBy: { id: "asc" },
      select: { symbol: true, win: true, createdAt: true },
    });
    const streak = new Map<string, { n: number; lastLossAt: number }>();
    for (const t of trades) {
      const cur = streak.get(t.symbol) ?? { n: 0, lastLossAt: 0 };
      if (t.win) {
        streak.set(t.symbol, { n: 0, lastLossAt: cur.lastLossAt });
      } else {
        streak.set(t.symbol, { n: cur.n + 1, lastLossAt: new Date(t.createdAt).getTime() });
      }
    }
    for (const [sym, s] of streak) symbolProbation.seed(sym, s.n, s.lastLossAt);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "SYMBOL_PROBATION_SEED_FAILED");
  }
}

export interface AutonomousBotStats {
  cycleCount: number;
  totalScans: number;
  tradesOpened: number;
  tradesClosed: number;
  tp1Hits: number;
  slHits: number;
  learningsCompleted: number;
  parametersTuned: number;
  backtestAudits: number;
  lastCycleAt: number;
  lastScanAt: number;
}

type MoverPair = { symbol: string; chg24h: number; vol24hUsd: number };

/** Rank volatile leaders from both sides so a large gainer cannot starve losers. */
function rankMoversBothDirections<T extends MoverPair>(pairs: T[]): T[] {
  const score = (a: T, b: T) =>
    performanceScore(Math.abs(b.chg24h), b.vol24hUsd) - performanceScore(Math.abs(a.chg24h), a.vol24hUsd);
  const gainers = pairs.filter((p) => p.chg24h > 0).sort(score);
  const losers = pairs.filter((p) => p.chg24h < 0).sort(score);
  const neutral = pairs.filter((p) => p.chg24h === 0).sort((a, b) => b.vol24hUsd - a.vol24hUsd);
  const ranked: T[] = [];
  for (let i = 0; i < Math.max(gainers.length, losers.length); i++) {
    if (gainers[i]) ranked.push(gainers[i]!);
    if (losers[i]) ranked.push(losers[i]!);
  }
  return ranked.concat(neutral);
}

// 27 Okt 2026 (insiden go-live 07:15 WIB): "OPEN" di DB tidak otomatis =
// exposure nyata. Di mode LIVE hanya posisi LIVE_* yang benar-benar ada di
// exchange; posisi PAPER_AI peninggalan simulasi TIDAK boleh:
//   (a) memakan slot posisi LIVE (cap 3) — insiden: 11 posisi simulasi
//       memblokir funnel SWING 100% -> 0 order live selama 2 jam,
//   (b) ikut dihitung margin/floating/notional likuidasi (plannedEntry),
//   (c) membuat pair terblokir entry live padahal airinya sendiri.
// Semua pemanggil memakai satu helper (risk/positionScope.ts) supaya
// scope PAPER-vs-LIVE konsisten di seluruh jalur.
function activePositionWhere(): Prisma.PositionWhereInput { return executionScopedOpenWhere(); }

// Batas trend-watch per siklus supervisi (percepatan isi-slot 27 Sep 2026):
// cold start 20 posisi tidak boleh menahan supervisi sampai timeout 40 dtk
// (dulu pembacaan di-await berurutan sehingga pembebasan slot tertunda).
const MAX_TREND_WATCH_PER_CYCLE = 6;
const TREND_WATCH_CONCURRENCY = 3;
// Provider-safe fan-out: twenty simultaneous reasoning calls were timing out
// and turning every review into NO-GO. Eight keeps entry responsive while the
// LLM still evaluates several candidates per fill cycle.
const MAX_JUDGE_QUEUE_PER_CYCLE = 8;

interface MacroGateCheck {
  allowed: boolean;
  detail: string;
  observation?: {
    btcTrend: string; btcAdx: number; btc1hChgPct: number;
    eth1hChgPct: number; btcDomChg1hPct: number; matrix: AltMatrixResult;
  };
}

export interface AutonomousBotStatus {
  isRunning: boolean;
  timersAlive: boolean;
  isScanning: boolean;
  cycleCount: number;
  openPositionsCount: number;
  stats: AutonomousBotStats;
  lastError: string | null;
  lastEntryRejection: { symbol: string; reason: string; detail: string; at: string } | null;
  activePairsCount: number;
  topCandidatesCount: number;
  slotFill: { target: number; empty: number; filterReadyCandidates: number; scanFresh: boolean; state: string; scanGateMs: number };
  knnLibrary: { total: number; scalp: number };
  progressive: { level: ProgressiveLevel; trades: number; winrate: number | null; expectancyUsd: number | null };
  llmOutage: { active: boolean; failStreak: number; lastFailure: string | null; deterministicFallback: boolean };
  /** Bukti entry pertama bot benar-benar terisi (perintah operator 30 Sep 2026). */
  firstEntry: { at: number; symbol: string; side: string; mode: string; strategyId: string } | null;
}

export class AutonomousTradingBot {
  private isRunning: boolean = false;
  private isStepRunning: boolean = false;
  private isEntryRunning: boolean = false;
  private isScanRunning: boolean = false;
  // WATCHDOG LOCK (audit 30 Sep 2026): step() & pengisi slot bisa nyangkut bila
  // satu await REST/LLM di dalamnya menggantung tanpa timeout (dulu entry timer
  // berhenti total ~35 mnt dengan isEntryRunning/isStepRunning tertahan true).
  // Timestamp ini memungkinkan lock basi dilepas paksa TANPA menyentuh gate.
  private stepLockStartedAt: number = 0;
  private entryLockStartedAt: number = 0;
  /** Batas maksimum lock step/entry tertahan sebelum dianggap basi (fail-safe). */
  private static readonly STEP_LOCK_MAX_MS = 180_000;
  private static readonly ENTRY_LOCK_MAX_MS = 90_000;
  private learningLoopInFlight: boolean = false;
  private learningBackfillCursor = 0;
  private lastParameterRefreshAt: number = 0;
  /** T-07/T-14/T-16: job harian (brief riset, laporan, METRIC_ALERT) sekali per hari. */
  private lastDailyJobDay: string = "";
  private metricAlertLog = new MetricAlertLog();
  private timer: NodeJS.Timeout | null = null;
  /** LANE SWING (S-05): timer funnel independen (20 dtk). */
  private swingTimer: NodeJS.Timeout | null = null;
  private analystTimer: NodeJS.Timeout | null = null;
  private entryTimer: NodeJS.Timeout | null = null;
  private scannerTimer: NodeJS.Timeout | null = null;
  // TIMER SUPERVISOR INDEPENDEN (fix 9 Okt 2026, kasus JCTUSDT #2760): polling
  // SL/TP punya timer + lock + timeout SENDIRI, terpisah total dari lock siklus
  // utama. Sebelumnya supervisePositions menumpang di step() yang bisa stall
  // ~10 menit (STEP_LOCK_STALE_RESET) — selama itu supervisor buta, SL yang sudah
  // tersentuh baru terdeteksi jauh kemudian dan overrun besar salah dibaca gap
  // pasar (fill -6.81R padahal risk $1).
  private supervisorTimer: NodeJS.Timeout | null = null;
  // AGENT HEARTBEAT (27 Okt 2026): denyut periodik untuk agen yang tadinya
  // hanya on-demand (/api/agents/*): Vega, Sena, Rhea (researchLayer) dan
  // Raksa (supervisorWatchdogLayer). Lihat runAgentHeartbeat().
  private agentHeartbeatTimer: NodeJS.Timeout | null = null;
  private agentHeartbeatRunning = false;
  private readonly lastAgentBeatAt: Map<string, number> = new Map();
  private isSupervisorRunning: boolean = false;
  private supervisorLockStartedAt: number = 0;
  private static readonly SUPERVISOR_LOCK_MAX_MS = 60_000;
  private cycleCount: number = 0;
  private lastCycleAt: number = 0;
  private lastScanAt: number = 0;
  private lastError: string | null = null;
  private lastEntryRejection: AutonomousBotStatus["lastEntryRejection"] = null;
  private maxPositions: number = MAX_OPEN_POSITIONS;
  // Throttle bicara agen agar berulang-ulang tiap siklus (anti-spam feed).
  private lastSpokeAt: Map<string, number> = new Map();
  // Snapshot jumlah posisi OPEN terakhir (dipakai /api/bot/status tanpa query async).
  private lastOpenPositionsCount: number = 0;
  // Entry PERTAMA yang berhasil dibuka (observabilitas operator 30 Sep 2026:
  // "tambahkan notifikasi/log ringkas saat entry pertama terjadi").
  private firstEntry: AutonomousBotStatus["firstEntry"] = null;
  /** Jumlah pair yang dianalisis multi-timeframe pada siklus scan terakhir (T-5.15). */
  private lastMtfAnalyzedCount: number = 0;
  /** Pair fokus dari tombol terminal "JALANKAN BOT" — dinilai pertama, tanpa jalan pintas gate. */
  private focusSymbol: string | null = null;
  /** Throttle putusan LLM Arka: hemat budget (maks/decycle + cooldown/simbol). */
  private lastJudgeAt: Map<string, number> = new Map();
  private judgeCallsThisCycle: number = 0;
  /** Cache mikrostruktur per siklus entry (BAGIAN 3, 24 Okt 2026). */
  private cycleMicrostructure: MicrostructureFlowBlock | null = null;
  /** Timestamp scan penuh (fresh) terakhir — full scan dibatasi >= 50 dtk (anti-ban). */
  private lastFullScanAt: number = 0;
  /** Kursor rotasi window MTF segar (24 teratas selalu fresh + 24 rotasi). */
  private mtfCursor: number = 0;
  /**
   * Fitur entry menunggu resolusi (KNN): symbol -> fitur + mode, dicatat saat
   * posisi DIBUKA, dikonsumsi (win/loss) saat trade DIEVALUASI di learning loop.
   * In-memory (hilang saat restart — acceptable v1; tidak ada skema DB baru).
   */
  private pendingKnn = new Map<number, EntryLearningSnapshot>();
  /** Cache level progresif (DB dihitung ulang maks 1x/60 dtk; override env selalu menang). */
  private progCache: { level: ProgressiveLevel; at: number; n: number; wr: number | null; ex: number | null } | null = null;
  /**
   * Detektor outage LLM (28 Sep 2026: provider 402 massal -> 0 trade).
   * Tiap verdict Arka tanpa LLM menambah streak; verdict LLM me-reset ke 0.
   * Streak >= 5 = outage -> vonis deterministik (skipLlm) bila env
   * DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE=true. Pulih otomatis saat LLM menjawab lagi.
   */
  private llmFailStreak = 0;
  private lastLlmFailure: string | null = null;
  private llmOutageNotifiedAt = 0;
  private static readonly LLM_OUTAGE_STREAK = 5;

  private llmOutageActive(): boolean {
    return this.llmFailStreak >= AutonomousTradingBot.LLM_OUTAGE_STREAK;
  }

  /**
   * Level eksplorasi progresif aktif (28 Sep 2026).
   * AUTO: hitung dari bukti PAPER terverifikasi (bukan LEGACY/DEMO) — jumlah trade,
   * winrate, expectancy. Performa buruk = tetap eksplorasi longgar; bagus = ambang
   * naik bertahap 45 -> 50 -> 55 -> 60 -> 64 -> 68. Override angka via env
   * PROGRESSIVE_LEVEL_OVERRIDE=0..5; nonaktif total via PROGRESSIVE_ENABLED=false (=L5).
   */
  private async getProgressive(): Promise<{ level: ProgressiveLevel; n: number; wr: number | null; ex: number | null }> {
    if (!progressiveEnabled(env.PROGRESSIVE_ENABLED)) return { level: 5, n: 0, wr: null, ex: null };
    const ov = progressiveOverride(env.PROGRESSIVE_LEVEL_OVERRIDE);
    if (ov !== "AUTO") return { level: ov, n: this.progCache?.n ?? 0, wr: this.progCache?.wr ?? null, ex: this.progCache?.ex ?? null };
    const now = Date.now();
    if (this.progCache && now - this.progCache.at < 60_000) {
      return { level: this.progCache.level, n: this.progCache.n, wr: this.progCache.wr, ex: this.progCache.ex };
    }
    try {
      const rows = await db.trade.findMany({
        where: { source: { in: ["LIVE_AI", "LIVE_MANUAL", "PAPER_AI", "PAPER_MANUAL"] }, accountingQuality: { in: ["VERIFIED", "SIMULATED"] } },
        select: { win: true, pnlUsd: true },
        orderBy: { id: "desc" },
        take: 1000,
      });
      const n = rows.length;
      const wr = n > 0 ? rows.filter((r) => r.win).length / n : null;
      const ex = n > 0 ? rows.reduce((a, r) => a + (Number(r.pnlUsd) || 0), 0) / n : null;
      const level = resolveProgressiveLevel({ verifiedTrades: n, winrate: wr, expectancyUsd: ex }, "AUTO");
      this.progCache = { level, at: now, n, wr, ex };
      return { level, n, wr, ex };
    } catch {
      return { level: this.progCache?.level ?? 0, n: 0, wr: null, ex: null };
    }
  }

  private stats: AutonomousBotStats = {
    cycleCount: 0,
    totalScans: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    tp1Hits: 0,
    slHits: 0,
    learningsCompleted: 0,
    parametersTuned: 0,
    backtestAudits: 0,
    lastCycleAt: 0,
    lastScanAt: 0,
  };

  public isBotRunning(): boolean {
    return this.isRunning;
  }

  public getStatus(openPositionsCount = this.lastOpenPositionsCount): AutonomousBotStatus {
    const scanView = scannerPool.getScanView();
    const empty = Math.max(0, this.maxPositions - openPositionsCount);
    const scanFresh = isFreshEntryScan(scanView.scan.refreshedAt);
    const statusLevel = this.progCache?.level ?? activeProgressiveLevel();
    const filterReadyCandidates = scanFresh
      ? scanView.candidates.filter((c) => isAgentReviewCandidate(c, empty, Date.now(), statusLevel)).length
      : 0;
    const state = empty === 0 ? "FULL" : !this.isRunning ? "BOT_STOPPED" :
      !defaultDailyRiskGuard.isArmed() ? "DISARMED" : !scanFresh ? "WAIT_FRESH_SCAN" :
      filterReadyCandidates === 0 ? "WAIT_VALID_SETUP" : "REVIEWING_CANDIDATES";
    return {
      isRunning: this.isRunning,
      /*
         23 Okt 2026 (BUG FIX timersAlive): entryTimer HANYA dibuat kalau
         scalpLaneEnabled(). Mode aktif = SWING (TRADING_STYLE default "SWING"),
         jadi entryTimer selalu null -> timersAlive selalu false ->
         runNow() thinks the bot is dead -> stop()+start() tiap kali ->
         restart loop (state hilang, cycle ke-reset).

         Sekarang: timer yang WAJIB hidup = timer + scannerTimer +
         supervisorTimer. Timer lane opsional (entry/swing/analyst) hanya
         dihitung kalau lane-nya memang aktif.
      */
      timersAlive: Boolean(this.timer && this.scannerTimer && this.supervisorTimer),
      isScanning: scannerPool.isScanning(),
      cycleCount: this.cycleCount,
      openPositionsCount,
      stats: { ...this.stats },
      lastError: this.lastError,
      lastEntryRejection: this.lastEntryRejection,
      activePairsCount: binanceFuturesClient.getCachedPairs().length,
      topCandidatesCount: scanView.candidates.length,
      slotFill: { target: this.maxPositions, empty, filterReadyCandidates, scanFresh, state, scanGateMs: scanGateMsFor(empty) },
      knnLibrary: { total: defaultKnnLibrary.count(), scalp: defaultKnnLibrary.count("SCALP") },
      progressive: {
        level: statusLevel,
        trades: this.progCache?.n ?? 0,
        winrate: this.progCache?.wr ?? null,
        expectancyUsd: this.progCache?.ex ?? null,
      },
      firstEntry: this.firstEntry ? { ...this.firstEntry } : null,
      llmOutage: {
        active: this.llmOutageActive(),
        failStreak: this.llmFailStreak,
        lastFailure: this.lastLlmFailure,
        // PAPER-only: di LIVE tetap fail-closed tanpa vonis LLM.
        deterministicFallback: this.llmOutageActive() && env.DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE &&
          env.BINANCE_EXECUTION_MODE === "PAPER",
      },
    };
  }

  public start(intervalMs = 3500): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Seed cooldown TREND_FLIP dari histori DB supaya restart tidak lupa arah
    // yang baru saja ditutup — kalau tidak, guard in-memory mulai kosong dan
    // bisa langsung mengulang kesalahan searah dalam menit pertama hidup.
    void (async () => {
      try {
        const flips = await db.position.findMany({
          where: { closeReason: "TREND_FLIP" },
          select: { symbol: true, side: true, closedAt: true, openedAt: true },
          orderBy: { id: "desc" },
          take: 60,
        });
        for (const flip of flips) {
          const closedAt = flip.closedAt ? new Date(flip.closedAt).getTime() : NaN;
          const openedAt = flip.openedAt ? new Date(flip.openedAt).getTime() : NaN;
          const at = Number.isFinite(closedAt) ? closedAt : openedAt;
          if (Number.isFinite(at)) trendFlipSideCooldown.record(String(flip.symbol), String(flip.side), at);
        }
        // Seed cooldown re-entry pasca-CLOSE (semua jenis close, kedua sisi) untuk cegah
        // double-loss setelah restart - guard in-memory mulai kosong saat boot.
        const closes = await db.position.findMany({
          where: { status: "CLOSED" },
          select: { symbol: true, closedAt: true, openedAt: true },
          orderBy: { id: "desc" },
          take: 60,
        });
        for (const c of closes) {
          const cClosed = c.closedAt ? new Date(c.closedAt).getTime() : NaN;
          const cOpened = c.openedAt ? new Date(c.openedAt).getTime() : NaN;
          const atMs = Number.isFinite(cClosed) ? cClosed : cOpened;
          if (Number.isFinite(atMs)) postCloseReentryCooldown.record(String(c.symbol), atMs);
        }
        // 11 Okt 2026 — seed cooldown pasca-LOSS dari loss terakhir di DB (aturan sama
        // dengan jalur live: state in-memory harus pulih setelah restart).
        await seedLossCooldownOnce();
      } catch {}
    })();
    // 14 Okt 2026: auto-prune saat boot DINONAKTIFKAN — deleteMany EventLog 790k
    // baris via Prisma memblokir event loop Node >10 menit (CPU 100%, API hang).
    // Purge dilakukan offline via sqlite3 CLI (cron maintenance), bukan di boot.
    // Retensi di maintenance.ts tetap 3 hari (dipakai endpoint /api/maintenance/prune).
    void (async () => {})();
    const activeTradingStyle = getTradingStyle();
    logger.info({
      tradingStyle: activeTradingStyle,
      scalpLaneActive: scalpLaneEnabled(),
      swingLaneActive: swingLaneEnabled(),
    }, "Autonomous Trading Bot aktif (Scanner + 12 AI Agents + Continuous Learning Loop)");
    // KNN: pulihkan library analog dari file (akumulasi selamat dari restart).
    this.loadKnnLibrary();
    // Starting the scanner/supervisor must never override an explicit DISARM.
    // ARM state is restored before start() at boot and changed only by the operator.
    binanceFuturesClient.startAutoSync(3000);
    this.step().catch((err) => { this.lastError = (err as Error).message; });
    this.timer = setInterval(() => {
      if (this.isRunning) {
        this.step().catch((err) => { this.lastError = (err as Error).message; });
      }
    }, intervalMs);
    // TIMER PENGISI SLOT: berjalan terpisah sesuai mode gaya trading yang aktif
    if (!this.entryTimer && scalpLaneEnabled()) {
      this.entryTimer = setInterval(() => {
        if (this.isRunning) void this.tryFillSlots();
      }, 8000);
    }
    // LANE SWING: funnel independen dengan timer sendiri
    if (!this.swingTimer && swingLaneEnabled()) {
      this.swingTimer = setInterval(() => {
        if (this.isRunning) void this.fillSwingSlots();
      }, 20000);
    }
      // LLM MARKET ANALYST (14 Okt 2026): loop riset/analisis berkala read-only —
      // baca SwingSignalLog + posisi + trade close, tulis analisis via model
      // penalaran. Fail-open, tak pernah menyentuh keputusan entry (GR #1).
      if (!this.analystTimer && env.LLM_ANALYST_INTERVAL_MIN > 0) {
        this.analystTimer = setInterval(() => {
          if (!this.isRunning) return;
          void this.runAnalystCycle();
        }, Math.max(5, env.LLM_ANALYST_INTERVAL_MIN) * 60_000);
      }
    // TIMER SCANNER (independen): memastikan daftar kandidat SELALU tersedia
    // walau siklus utama tersendat (mis. REST Binance lambat / menggantung).
    if (!this.scannerTimer) {
      // 30 Sep 2026 (operator: "percepat kadens scan"): 20s -> 15s agar kandidat
      // segar selalu tersedia saat slot kosong; gate kualitas di scan tidak berubah.
      this.scannerTimer = setInterval(() => {
        if (this.isRunning) void this.tryScan();
      }, 15000);
    }
    // TIMER SUPERVISOR (independen, fix 9 Okt 2026): eksekusi SL/TP tidak boleh
    // lagi ikut macet bersama siklus utama. Tiap 5 dtk, lock + timeout sendiri.
    if (!this.supervisorTimer) {
      this.supervisorTimer = setInterval(() => {
        if (this.isRunning) void this.runSupervisorTick();
      }, 5000);
    }
    // HEARTBEAT AGEN (27 Okt 2026): Vega/Sena/Rhea/Raksa berdenyut di loop
    // live — sebelumnya hanya bisa dipanggil via /api/agents/* (on-demand).
    this.startAgentHeartbeat();
  }

  /**
   * AGENT HEARTBEAT (27 Okt 2026). Audit menemukan Vega (macro-scout), Sena
   * (universe-curator), dan Raksa (watchdog) TIDAK PERNAH dipanggil loop live —
   * LLM mereka hanya hidup saat operator membuka /api/agents/* (on-demand),
   * sehingga dashboard selalu TANPA BUKTI. Denyut ini memanggil researchLayer /
   * watchdogLayer yang sudah menulis AGENT_DIALOG sendiri. Fail-safe: satu
   * agen gagal tidak mengganggu agen lain maupun loop trading (GR #1 — tidak
   * menyentuh keputusan entry/exit). Kadens rendah (30-60 mnt) supaya beban
   * LLM tetap kecil.
   */
  private startAgentHeartbeat(): void {
    if (this.agentHeartbeatTimer) return;
    this.agentHeartbeatTimer = setInterval(() => {
      if (this.isRunning) void this.runAgentHeartbeat();
    }, 5 * 60_000);
  }

  private async runAgentHeartbeat(): Promise<void> {
    if (this.agentHeartbeatRunning) return;
    this.agentHeartbeatRunning = true;
    try {
      const now = Date.now();
      const due = (id: string, periodMs: number): boolean =>
        now - (this.lastAgentBeatAt.get(id) ?? 0) >= periodMs;

      // Vega + Rhea: satu pembacaan klines makro melayani dua agen.
      if (due("macro-scout", 30 * 60_000) || due("regime-analyst", 60 * 60_000)) {
        const macro = await this.readMacroForTrend();
        if (due("macro-scout", 30 * 60_000)) {
          this.lastAgentBeatAt.set("macro-scout", now);
          await defaultResearchLayer.runMacroScout({
            btcTrend: macro.btcTrend,
            btcAdx: macro.adx,
            btc1hChgPct: macro.chg1hPct,
            ethTrend: macro.ethTrend,
            eth1hChgPct: macro.ethChg1hPct,
            btcDomChg1hPct: macro.btcDomChg,
          }).catch((err) => logger.warn({ agentId: "macro-scout", err: (err as Error)?.message }, "AGENT_HEARTBEAT_FAIL"));
        }
        if (due("regime-analyst", 60 * 60_000)) {
          this.lastAgentBeatAt.set("regime-analyst", now);
          await defaultResearchLayer.runRegimeAnalyst({
            symbol: "BTCUSDT",
            regime: String(macro.btcRegime ?? (macro.btcTrend === "NEUTRAL" ? "RANGING" : "TRENDING")),
            chopIndex: Math.round(Math.max(0, Math.min(100, 100 - macro.adx * 2))),
            adx: macro.adx,
            shieldActive: macro.shieldActive,
          }).catch((err) => logger.warn({ agentId: "regime-analyst", err: (err as Error)?.message }, "AGENT_HEARTBEAT_FAIL"));
        }
      }

      // Sena: audit universe dari tabel Symbol (angka nyata, bukan dummy).
      if (due("universe-curator", 60 * 60_000)) {
        this.lastAgentBeatAt.set("universe-curator", now);
        const counts = await Promise.all([
          db.symbol.count(),
          db.symbol.count({ where: { isBlacklisted: true } }),
          db.symbol.count({ where: { blacklistReason: "manual" } }),
        ]).catch(() => [0, 0, 0] as const);
        const [total, blacklisted, manual] = counts;
        await defaultResearchLayer.runUniverseCurator({
          totalSymbols: total,
          cryptoPerpsCount: total - blacklisted,
          nonCryptoFiltered: blacklisted - manual,
          manualBlacklistCount: manual,
        }).catch((err) => logger.warn({ agentId: "universe-curator", err: (err as Error)?.message }, "AGENT_HEARTBEAT_FAIL"));
      }

      // Raksa: heartbeat watchdog HEALTH_OK (laporan kondisi infrastruktur).
      if (due("watchdog", 30 * 60_000)) {
        this.lastAgentBeatAt.set("watchdog", now);
        await defaultSupervisorWatchdogLayer.runWatchdog({ context: "HEALTH_OK" })
          .catch((err) => logger.warn({ agentId: "watchdog", err: (err as Error)?.message }, "AGENT_HEARTBEAT_FAIL"));
      }
    } finally {
      this.agentHeartbeatRunning = false;
    }
  }

  /**
   * Tick supervisor independen (fix 9 Okt 2026, kasus JCTUSDT #2760). Lock,
   * stale-reset, dan timeout-nya MILIK SENDIRI — stall scanner/judge/learning di
   * step() tidak pernah lagi menunda deteksi SL/TP. supervisePositions() sendiri
   * sudah fast-path (price hub WS + fallback REST paralel 3 dtk per posisi).
   */
  private async runSupervisorTick(): Promise<void> {
    const now = Date.now();
    if (this.isSupervisorRunning) {
      if (this.supervisorLockStartedAt > 0 &&
          now - this.supervisorLockStartedAt > AutonomousTradingBot.SUPERVISOR_LOCK_MAX_MS) {
        logger.warn({ heldMs: now - this.supervisorLockStartedAt, maxMs: AutonomousTradingBot.SUPERVISOR_LOCK_MAX_MS },
          "SUPERVISOR_LOCK_STALE_RESET: lock supervisor tertahan, dilepas paksa");
        this.isSupervisorRunning = false;
        this.supervisorLockStartedAt = 0;
      } else {
        return;
      }
    }
    this.isSupervisorRunning = true;
    this.supervisorLockStartedAt = Date.now();
    try {
      await this.withTimeout(this.supervisePositions(), 20_000, "supervisePositions");
    } catch (err: any) {
      this.lastError = `SUPERVISOR: ${err?.message || String(err)}`;
    } finally {
      this.isSupervisorRunning = false;
      this.supervisorLockStartedAt = 0;
    }
  }

  // ── Persistensi library analog KNN (file JSON di samping database) ──
  // Alasan: library in-memory + restart berkala (deploy) = tidak pernah mencapai
  // 50 sampel -> Arka kekurangan bukti statistik selamanya. File membuat
  // akumulasi win/loss selamat antar-restart.
  private knnFilePath(): string | null {
    try {
      // 30 Sep 2026 (operator): lokasi library KNN eksplisit via KNN_LIBRARY_PATH
      // agar tidak lagi menempel ke DATABASE_URL. Bila kosong, fallback lama
      // (turunan dari sisi file DATABASE_URL) tetap dipakai demi kompatibilitas.
      const explicit = String(process.env.KNN_LIBRARY_PATH ?? "").trim();
      if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
      const url = String(process.env.DATABASE_URL ?? "");
      const m = url.match(/^file:(.+)$/i);
      if (!m?.[1]) return null;
      const abs = path.isAbsolute(m[1]) ? m[1] : path.resolve(process.cwd(), m[1]);
      return path.join(path.dirname(abs), "knn-library.json");
    } catch {
      return null;
    }
  }

  private saveKnnLibrary(): void {
    try {
      const fp = this.knnFilePath();
      if (!fp) return;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, serializeKnnLibrary(defaultKnnLibrary.snapshot()));
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "KNN_LIBRARY_SAVE_FAIL");
    }
  }

  private loadKnnLibrary(): void {
    try {
      const fp = this.knnFilePath();
      if (!fp || !fs.existsSync(fp)) return;
      const items = parseKnnLibraryFile(fs.readFileSync(fp, "utf8"));
      if (items.length > 0) {
        defaultKnnLibrary.seedItems(items);
        logger.info({ count: items.length, knnTotal: defaultKnnLibrary.count() }, "KNN_LIBRARY_RESTORED");
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "KNN_LIBRARY_LOAD_FAIL");
    }
  }

  // Jalankan siklus scanner dengan lock + pelaporan error (tanpa menelan).
  private async tryScan(): Promise<void> {
    if (this.isScanRunning) return;
    this.isScanRunning = true;
    try {
      const refreshed = await this.runMarketScannerCycle();
      if (refreshed) {
        const now = Date.now();
        this.lastScanAt = now;
        this.stats.lastScanAt = now;
      }
    } catch (err: any) {
      this.lastError = `SCAN: ${err?.message || String(err)}`;
      logger.warn({ err: err?.message }, "Siklus scanner gagal");
    } finally {
      this.isScanRunning = false;
    }
  }

  // Timeout guard: operasi jaringan (REST Binance) tidak boleh memblokir siklus.
  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.lastError = `${label}: TIMEOUT ${ms}ms (dilewati, siklus lanjut)`;
            logger.warn({ label, ms }, "Operasi melewati batas waktu — siklus dilanjutkan");
            resolve();
          }, ms);
        }),
      ]);
    } catch (err: any) {
      this.lastError = `${label}: ${err?.message || String(err)}`;
      logger.warn({ label, err: err?.message }, "Operasi gagal — siklus dilanjutkan");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Pengisi slot: memastikan bot SELALU berusaha memenuhi 20 slot posisi.
  // ── LANE SWING (S-05 Swing Breakout) — 13 Okt 2026 (perintah operator:
  // "Swing semua untuk Live trading dan paper mode backtest di website") ──
  // Funnel sendiri, terpisah dari pengisi slot SCALP:
  //  - sinyal = mesin S-05 pada bar 1h TERTUTUP (analyzeSymbolMtf mode SWING);
  //  - ARM wajib (GOLDEN RULE #3), cap 2 posisi GLOBAL dijaga executePlannedEntry;
  //  - jeda 15 menit antar entry S-05 (anti konvoi breakout serentak;
  //    60->15 sejak 28 Okt 2026, perintah operator);
  //  - cooldown per simbol 24 jam pasca-close S-05;
  //  - gap entry vs close sinyal maks maxEntryGapPct.SWING (1%);
  //  - sizing: risk $1 di SL struktur, margin plafon $8 (SWING_MAX_MARGIN_USD);
  //  - putusan deterministik mesin (tanpa LLM): sinyal paritas 16/16 riset ADALAH
  //    trigger-nya; seluruh guard numerik tetap fail-closed di plannedEntry.
  private swingSpacingSeeded = false;
  private swingSymbolCooldown = new Map<string, number>();
  /** 14 Okt: rotasi window target funnel SWING per tick (anti dead-lock di 2 simbol pertama). */
  private swingTick = 0;
  private swingLastHeartbeatAt = 0;
  /** Anti-reentrancy: tick timer baru menunggu; tidak ada dua funnel SWING paralel. */
  private isSwingRunning = false;

  private async fillSwingSlots(): Promise<void> {
    if (this.isSwingRunning) return;
    this.isSwingRunning = true;
    try {
      await this.fillSwingSlotsOnce();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "SWING_FUNNEL_ERROR");
    } finally {
      this.isSwingRunning = false;
    }
  }

  private async fillSwingSlotsOnce(): Promise<void> {
    if (!swingLaneEnabled()) return;
    // Seed jeda antar-entry dari posisi S-05 open (idempoten, sekali per proses).
    // 27 Okt 2026 (insiden go-live): jeda antar-entry di LIVE dihitung dari entry
    // LIVE terakhir. Posisi simulasi (PAPER_AI) yang masih OPEN tidak boleh
    // menyegel jeda entry live — tidak ada exposure nyata yang perlu dijarangi.
    if (!this.swingSpacingSeeded) {
      this.swingSpacingSeeded = true;
      const lastSwing = await db.position.findFirst({
        where: { ...executionScopedOpenWhere("SWING") },
        orderBy: { openedAt: "desc" },
        select: { openedAt: true },
      }).catch(() => null);
      swingEntrySpacing.seed(lastSwing?.openedAt ? new Date(lastSwing.openedAt).getTime() : null);
    }

    // 14 Okt 2026 (permintaan operator): PAPER boleh cap 20; di LIVE cap swing
    // TETAP terkunci ke LIVE_MAX_OPEN_POSITIONS — naiknya slot hanya untuk paper.
    // 27 Okt 2026 (insiden go-live 07:15 WIB): hitungan slot WAJIB memakai scope
    // mode eksekusi. Antesnya `source: { not: "DEMO" }` ikut menghitung 11 posisi
    // PAPER_AI (simulasi, tidak ada di exchange) -> 11 >= cap 3 -> funnel SWING
    // memblokir dirinya sendiri 100% (350x SWING_GATE: PAPER_GLOBAL_SLOT_CAP
    // sejak 08:15 CST) -> 0 order live, padahal 0 posisi LIVE ada.
    const isLiveMode = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
    const swingCap = swingSlotCap({
      isLive: isLiveMode,
      swingMaxPositions: Number(env.SWING_MAX_POSITIONS ?? 2),
      liveMaxOpenPositions: Number(env.LIVE_MAX_OPEN_POSITIONS ?? 1),
      paperMaxPositions: MAX_OPEN_POSITIONS,
    });
    const swingOpen = await db.position.count({
      where: executionScopedOpenWhere("SWING"),
    }).catch(() => 0);
    // PAPER only: pending entry orders reserve a slot before they become a
    // Position. Count them conservatively; LIVE keeps its existing path.
    const pendingEntries = isLiveMode ? 0 : await db.orderExec.count({
      where: {
        reduceOnly: false,
        status: { in: ["NEW", "PARTIAL"] },
        createdAt: { gte: new Date(Date.now() - 4 * 3_600_000) },
      },
    }).catch(() => 0);
    const reservedSlots = swingOpen + pendingEntries;
    if (reservedSlots >= swingCap) {
      logger.info({ swingOpen, pendingEntries, reservedSlots, swingCap }, "SWING_GATE: PAPER_GLOBAL_SLOT_CAP");
      await this.logSwingSignal({
        symbol: "PORTFOLIO", side: "LONG", strategyId: "PORTFOLIO",
        decision: "SLOT_FULL",
        reason: `reserved=${reservedSlots} cap=${swingCap}; four strategies share one global cap`,
      });
      return;
    }
    if (!isLiveMode) {
      // PAPER contract: max 6 net-loss closed SWING trades per Asia/Jakarta day.
      const jakarta = new Date(Date.now() + 7 * 3_600_000);
      const dayStartUtc = Date.UTC(jakarta.getUTCFullYear(), jakarta.getUTCMonth(), jakarta.getUTCDate()) - 7 * 3_600_000;
      const paperLosses = await db.trade.count({
        where: {
          mode: "SWING",
          source: { in: ["PAPER_AI", "PAPER_MANUAL"] },
          pnlUsd: { lt: 0 },
          createdAt: { gte: new Date(dayStartUtc) },
        },
      }).catch(() => 0);
      if (paperLosses >= 6) {
        logger.info({ paperLosses, dayStartUtc }, "SWING_GATE: PAPER_SIX_NET_LOSS_CAP");
        await this.logSwingSignal({
          symbol: "PORTFOLIO", side: "LONG", strategyId: "PORTFOLIO",
          decision: "DAILY_LOSS_CAP",
          reason: `net losses=${paperLosses}/6 on Asia/Jakarta day; no new PAPER admission`,
        });
        return;
      }
    }

    const guardStatus = await defaultDailyRiskGuard.evaluateStatus();
    if (!guardStatus.canTrade) {
      logger.info({ reasons: guardStatus.reasons, dailyPnlUsd: guardStatus.dailyPnlUsd, openCount: guardStatus.openPositionsCount }, "SWING_GATE_BLOCKED: canTrade=false");
      return;
    }
    // GOLDEN RULE #3: tidak ada order baru tanpa ARM eksplisit operator.
    if (!defaultDailyRiskGuard.isArmed()) {
      logger.info("SWING_GATE_BLOCKED: ARM=false");
      return;
    }
    // Jeda antar entry S-05 (15 mnt sejak 28 Okt 2026, perintah operator).
    if (swingEntrySpacing.isBlocked()) {
      logger.info("SWING_GATE_BLOCKED: spacing");
      return;
    }

    // Cooldown per simbol pasca-close S-05 (24 jam): pertahankan map, tambahkan
    // simbol yang baru saja menutup posisi S-05.
    const nowMs = Date.now();
    const recentlyClosed = await db.position.findMany({
      where: {
        source: { not: "DEMO" }, mode: "SWING",
        closedAt: { gte: new Date(nowMs - 24 * 3_600_000) },
      },
      select: { symbol: true, closedAt: true },
    }).catch(() => [] as Array<{ symbol: string; closedAt: Date | null }>);
    if (recentlyClosed.length > 0) {
      for (const row of recentlyClosed) {
        const deadline = swingCooldownDeadline(row.closedAt, nowMs);
        if (deadline !== null) this.swingSymbolCooldown.set(row.symbol, Math.max(this.swingSymbolCooldown.get(row.symbol) ?? 0, deadline));
      }
    }

    const symbols = binanceFuturesClient.getCachedPairs()
      .map((p) => p.symbol)
      .filter((s) => {
        const until = this.swingSymbolCooldown.get(s) ?? 0;
        return nowMs >= until;
      });
    /*
       23 Okt 2026 (BUG FIX): jalur SWING/RSW TIDAK pernah melewati gate volume
       operator. Scanner (tryScan) memfilter checkTradeVolume(), tapi funnel SWING
       mengambil target langsung dari getCachedPairs() tanpa filter itu — sehingga
       pair seperti SPKUSDT (vol 24h ~$1.56M, di bawah VOLUME_MIN_USD $7jt)
       tetap bisa membuka posisi. 16 dari 20 posisi PAPER terbuka saat ini ada di
       pair di bawah ambang. Gate volume WAJIB diulang di jalur entry, bukan
       hanya di scanner (pola yang sama seperti gate harga live & gap entry).
    */
    const swingLiquidSymbols = symbols.filter((s) => {
      const pair = binanceFuturesClient.getCachedPairs().find((p) => p.symbol === s);
      const gate = checkTradeVolume(pair?.vol24hUsd);
      if (!gate.allowed) {
        logger.debug({ symbol: s, volumeUsd: gate.volumeUsd, reason: gate.reason }, "SWING_SKIP: VOLUME_BELOW_MIN");
      }
      return gate.allowed;
    });
    if (swingLiquidSymbols.length === 0) {
      logger.warn({ total: symbols.length }, "SWING_GATE: semua simbol di bawah lantai volume — tidak ada kandidat");
      return;
    }
    const symbolsForSweep = swingLiquidSymbols;
    if (symbols.length === 0) {
      logger.warn({ cooldownActive: this.swingSymbolCooldown.size }, "SWING_GATE: semua simbol cooldown — tidak ada kandidat");
      return;
    }

    // 14 Okt (audit funnel): slice(0,2) statis selalu ambil 2 simbol pertama
    // urutan cache (alfabetis) — kalau keduanya tidak lolos eligibility, funnel
    // diam selamanya tanpa log. Rotasi window per tick supaya semua simbol
    // kesampaian dianalisis dalam putaran.
    const ROT = 2;
    const offset = (this.swingTick * ROT) % symbolsForSweep.length;
    const targets = symbolsForSweep.slice(offset, offset + ROT);
    if (targets.length < ROT) targets.push(...symbolsForSweep.slice(0, ROT - targets.length));
    this.swingTick++;
    this.swingLastHeartbeatAt = nowMs;
    logger.debug({ tick: this.swingTick, offset, targets }, "SWING_FUNNEL_TICK");
    const results = await scannerPool.runPool(
      targets,
      async (s) => this.analyzeSymbolMtf(s, "SWING", true),
      2
    );
    for (let i = 0; i < targets.length; i++) {
      const symbol = targets[i]!;
      const analysis = results[i]?.success && results[i]?.data ? results[i]!.data : null;
      if (!analysis?.usable) {
        logger.debug({ symbol, ok: results[i]?.success, usable: false, err: results[i]?.error ?? null }, "SWING_ANALYSIS_UNUSABLE");
        continue;
      }
      // 29 Okt 2026 (BUG FIX): SWING funnel tidak punya duplikat check —
      // simbol yang sudah punya posisi OPEN terus dievaluasi mahal (RSW data,
      // Thesis Arena, DREX, Council) padahal tidak akan bisa entry lagi.
      // Ini buang-buang LLM call dan menahan slot untuk kandidat lain.
      // Cek DB langsung (bukan cache) — sama seperti LAPIS 2 di SCALP pipeline.
      const swingDup = await db.position.count({ where: { ...activePositionWhere(), symbol } }).catch(() => 0);
      if (swingDup > 0 || entryOncePerPair.isBlocked(symbol)) {
        logger.info({ symbol, openForSymbol: swingDup }, "SWING_SKIP: DUPLICATE_SYMBOL_OPEN");
        continue;
      }
      // 14 Okt 2026 (BUG FIX): S-05 selalu SWING_NO_DATA:0 karena ctx.swing
      // tidak pernah disuplai. Konversi bar 1h tertutup dari analyzer ke format
      // Bar[] yang dibutuhkan evaluateSwingBreakout.
      // analysis.trigger.barsData sudah Bar[] dari analyzer — jangan double-convert
      const h1Bars = analysis.trigger.barsData as unknown as import("../universe/eligibility.js").Bar[];
      // T0.6 (19 Okt 2026): supply data RSW (h4Bars >=200, h1BarsLong >=801,
      // btcDailyBars) via loader cache-aware — sebelumnya hanya h1Bars sehingga
      // RSW-01/02/03 tidak pernah fire (fail-closed tanpa h4Bars). Fetch
      // gagal/kosong tetap fail-closed di buildRswPlans (tidak mengarang sinyal).
      const rswData = await loadSwingRswContext(symbol, allowedStrategiesFor("SWING"),
        (s, i, l) => binanceFuturesClient.fetchKlines(s, i, l));
      const sel = await selectBestPlan(
        { analysis, price: analysis.price, mode: "SWING", swing: { h1Bars, ...(rswData ?? {}) } },
        Date.now(),
        allowedStrategiesFor("SWING")
      );
      const plan = sel?.plan ?? null;
      if (!plan?.matched) {
        // 14 Okt: rekam ALASAN asli tiap plan (S-03/S-05) supaya funnel tidak
        // "blackbox" — operator bisa lihat kenapa sinyal tidak jadi entry.
        const reasons = (sel?.all ?? [])
          .map((pl) => `${pl.strategyId}:${(pl.reasons ?? []).join(",") || "ok"}`)
          .join(" | ")
          .slice(0, 400);
        // 20 Okt 2026: S-05 dihapus -> tidak ada lagi "plan S-05" sebagai
        // placeholder. strategyId = "S-99" (bucket arsip) karena kolom
        // strategyId di log TIDAK nullable; plan null = tidak ada strategi
        // yang menolak (lihat logSwingDecision di bawah: strategyId null).
        await this.logSwingSignal({ symbol, side: analysis.side ?? "LONG", strategyId: "S-99", decision: "SIGNAL_NO_PLAN", reason: reasons || "usable tapi tidak ada plan strategi yang match" });
        // Big Brain 16 Okt: tanpa plan = SKIPPED (bukan veto atas setup) —
        // strategyId null (tidak ada strategi yang menolak).
        await this.logSwingDecision({ symbol, side: analysis.side ?? "LONG", strategyId: null, swingDecision: "SIGNAL_NO_PLAN", rejectReason: reasons || "usable tapi tidak ada plan strategi yang match", analysis, h1Bars, price: analysis.price });
        continue;
      }

      // Harga live WAJIB tersambung (anti entry basi — konvensi jalur SCALP).
      const live = binanceFuturesClient.getHubPrices([symbol]).map[symbol]?.m;
      if (!live || live <= 0 || !binanceFuturesClient.isPriceLive(symbol)) continue;
      /*
         23 Okt 2026: gate volume DIULANG tepat sebelum entry (fail-closed).
         Filter di atas menyaring target, tapi volume bisa anjlok antara filter
         dan eksekusi. Data diambil dari snapshot futures 24j terbaru; kalau
         volumenya tidak diketahui -> TOLAK (jangan menebak likuiditas).
      */
      const swingPairMeta = binanceFuturesClient.getCachedPairs().find((p) => p.symbol === symbol);
      const swingVolumeGate = checkTradeVolume(swingPairMeta?.vol24hUsd);
      if (!swingVolumeGate.allowed) {
        logger.info({ symbol, volumeUsd: swingVolumeGate.volumeUsd, reason: swingVolumeGate.reason },
          "SWING_SKIP: VOLUME_BELOW_MIN");
        await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason: `VOLUME_BELOW_MIN: ${swingVolumeGate.reason}`, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
        await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "SKIP_VOLUME_BELOW_MIN", rejectReason: swingVolumeGate.reason, analysis, h1Bars, price: live });
        continue;
      }
      // Anti fill "ajaib": harga live menyimpang > 1% dari close sinyal -> skip.
      const gap = Math.abs(live - plan.entryPrice) / plan.entryPrice;
      if (gap > SETUP_ENGINE.maxEntryGapPct.SWING) {
        logger.info({ symbol, gapPct: Number((gap * 100).toFixed(2)), close: plan.entryPrice, live },
          "SWING_SKIP: ENTRY_GAP");
        await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "SKIP_ENTRY_GAP", reason: `gap ${(gap * 100).toFixed(2)}% > max`, entryPrice: plan.entryPrice, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
        await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "SKIP_ENTRY_GAP", rejectReason: `gap ${(gap * 100).toFixed(2)}% > max`, analysis, h1Bars, price: analysis.price });
        continue;
      }

      const equityUsd = Number((START_EQUITY_USD + guardStatus.cumulativePnlUsd).toFixed(2));
      // 27 Okt 2026: tickSize dibutuhkan untuk toleransi pembulatan pada cap SL
      // SWING (SL di-grid ke tick, % SL bisa naik sedikit di atas cap).
      const swingTickSize = (await db.symbol.findUnique({ where: { symbol }, select: { tickSize: true } }))?.tickSize;
      // Sizing SWING: risk $1 di SL struktur (structuralRiskSizing di plannedEntry),
      // margin plafon $8, leverage otomatis. policy hanya menyumbang targetRisk/lev.
      const policy = resolveMarginPolicy({ mode: "SWING", equityUsd, score: plan.quality, seed: symbol, structuralSlPct: Math.abs(plan.entryPrice - plan.slPrice) / plan.entryPrice, strategyId: plan.strategyId, tickSize: swingTickSize, entryPrice: plan.entryPrice });
      if (!policy.allowed) {
        logger.info({ symbol, reason: policy.reason }, "SWING_GATE_BLOCKED: margin policy");
        continue;
      }

      // 23 Okt 2026 (perintah operator): Drex Max menilai kandidat SWING
      // SEBELUM eksekusi. Tersedia = putusannya mengikat; tak tersedia =
      // fail-open (gate lama tetap jalan, log jujur). Gagal Drex TIDAK PERNAH
      // menyentuh sizing/harga — hanya veto GO atas plan yang sudah ada.
      //
      // TAHAP 6B + DREX v2 (26 Okt 2026): snapshot evidence LIMA PANEL diambil
      // DI SINI — setelah gate deterministik (volume, gap, margin policy) tapi
      // SEBELUM runSwingDrexJudge. Ini definisi "sebelum keputusan": evidence
      // berasal dari sebelum verdict, bukan informasi yang muncul sesudah entry.
      // Snapshot bersifat immutable (deep copy) dan TIDAK mengubah jalur v1.
      const preDecisionPanelSnapshot = await captureDrexPanelSnapshot({
        symbol, side: plan.side, strategyId: plan.strategyId,
        planId: `${plan.strategyId}:${symbol}:${plan.entryPrice}:${plan.slPrice}:${plan.tp1Price}`,
        candidateId: `${symbol}:${plan.side}:${plan.strategyId}`,
        correlationId: `${symbol}:${plan.side}:${plan.strategyId}:${plan.entryPrice}`,
        marketType: "PERPETUAL",
        venue: "BINANCE_PERP",
        horizon: "H1/H4",
      }).catch((err) => {
        logger.warn({ symbol, err: (err as Error).message }, "DREX_PANEL_SNAPSHOT_FAILED");
        return null;
      });

      let battleId: string | null = null;
      if (env.DIRECTION_BATTLE_ENABLED) {
        const [longMacro, shortMacro, intelSnapshot] = await Promise.all([
          this.checkMacroGate(symbol, "LONG"),
          this.checkMacroGate(symbol, "SHORT"),
          gatherMarketContextSnapshot().catch((err) => {
            logger.warn({ symbol, err: (err as Error).message }, "DIRECTION_BATTLE_MICROSTRUCTURE_FETCH_FAIL");
            return null;
          }),
        ]);
        const battle = await runDirectionBattle({
          symbol,
          mode: "SWING",
          proposedSide: plan.side,
          trendScore: analysis.trendScore,
          regime: analysis.bias?.regime ?? null,
          adx: analysis.structure?.adx ?? null,
          chop: analysis.structure?.chop ?? null,
          macroAllowed: longMacro.allowed || shortMacro.allowed,
          macroAllowedBySide: { LONG: longMacro.allowed, SHORT: shortMacro.allowed },
          macroDetail: `LONG: ${longMacro.detail}; SHORT: ${shortMacro.detail}`,
          compositeScore: analysis.compositeScore,
          knnProb: null,
          microstructure: intelSnapshot?.microstructure_and_flow ?? null,
        });
        battleId = battle.battleId;
        if (battle.status !== "GO" || battle.winner !== plan.side) {
          const reason = battle.reasons.join("|") || `WINNER_${battle.winner ?? "NONE"}`;
          logger.info({ symbol, planSide: plan.side, battleStatus: battle.status, winner: battle.winner, reason }, "SWING_ENTRY_REJECTED_DIRECTION_BATTLE");
          await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason: `DIRECTION_BATTLE: ${reason}`, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
          await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_REJECTED", rejectReason: `DIRECTION_BATTLE: ${reason}`, analysis, h1Bars, price: live });
          continue;
        }
      }

      // 27 Okt 2026 (opsi B, persetujuan operator): verdict ARENA TESIS menjadi
      // gate entry — fail-closed kualitas: entry hanya bila tesis USABLE dan
      // pemenang arena sejalan sisi plan. Penjaga anti-looping + wajib kutip
      // bukti ada di dalam arena (thesisArena.ts). Dipasang SETELAH gate
      // deterministik (volume/gap/margin), SEBELUM judge — gate LLM di titik
      // pre-eksekusi dengan volume kandidat nyata (rule 79).
      if (env.THESIS_ARENA_GATE_ENABLED) {
        const thesisVerdict = await runThesisArenaSession({
          symbol,
          dayKey: new Date().toISOString().slice(0, 10),
          analysisSummary: `RSW plan ${plan.strategyId} ${plan.side}: entry ${live}, SL ${plan.slPrice}, TP1 ${plan.tp1Price}, kualitas ${plan.quality}, trend ${analysis.trendScore ?? "?"}, regime ${analysis.bias?.regime ?? "?"}, adx ${analysis.structure?.adx ?? "?"}, chop ${analysis.structure?.chop ?? "?"}.`,
          evidence: {
            entryPrice: live,
            slPrice: plan.slPrice,
            tp1Price: plan.tp1Price,
            slPctPct: Number(((Math.abs(live - plan.slPrice) / live) * 100).toFixed(2)),
            trendScore: analysis.trendScore ?? -1,
            compositeScore: analysis.compositeScore,
            adx: analysis.structure?.adx ?? -1,
            chop: analysis.structure?.chop ?? -1,
            planQuality: plan.quality,
          },
        }).catch(() => null);
        if (!thesisVerdict || thesisVerdict.status !== "USABLE" || thesisVerdict.winner !== plan.side) {
          const reason = !thesisVerdict
            ? "THESIS_ARENA_UNAVAILABLE"
            : thesisVerdict.reasons.join("|") || `WINNER_${thesisVerdict.winner ?? "NONE"}`;
          logger.info({ symbol, planSide: plan.side, thesisStatus: thesisVerdict?.status ?? null, thesisWinner: thesisVerdict?.winner ?? null, reason }, "SWING_ENTRY_REJECTED_THESIS_ARENA");
          await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason: `THESIS_ARENA: ${reason}`, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
          await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_REJECTED", rejectReason: `THESIS_ARENA: ${reason}`, analysis, h1Bars, price: live });
          continue;
        }
      }

      const drexSwing = await defaultDecisionRiskLayer.runSwingDrexJudge({
        symbol, side: plan.side, strategyId: plan.strategyId, strategyName: plan.strategyName,
        compositeScore: analysis.compositeScore, zoneScore: analysis.zoneScore,
        triggerScore: analysis.triggerScore, trendScore: analysis.trendScore,
        regime: analysis.bias?.regime ?? null,
        entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price,
        // TAHAP 5: level TP2/final dari plan sebenarnya (RR23: 3R) untuk state
        // Drex v2 shadow; dihitung dari geometri yang sama dengan plannedEntry.
        tp2Price: swingLadderLevelsFromTp1(plan.side, live, plan.tp1Price, true).tp2,
        slPct: Math.abs(live - plan.slPrice) / live,
        planQuality: plan.quality, entryType: plan.entryType, zoneType: plan.zoneType,
        tfSummary: plan.tfSummary,
        structureAdx: analysis.structure?.adx ?? null,
        structureChop: analysis.structure?.chop ?? null,
        structureAtrPct: analysis.trigger?.atrPct ?? null,
        equityUsd, swingOpen, swingCap,
        // TAHAP 6B: snapshot evidence pra-keputusan (DREX v2 shadow saja).
        panelSnapshot: preDecisionPanelSnapshot,
        // Drex vision (24 Okt 2026): bar 1h tertutup untuk render chart PNG.
        // Flag DREX_VISION_ENABLED default false -> tidak ada render, tidak ada
        // gambar yang dikirim, perilaku produksi tidak berubah.
        chartBars: h1Bars,
      });
      if (drexSwing.kind === "reject") {
        logger.info({ symbol, strategyId: plan.strategyId, reason: drexSwing.reason, p: drexSwing.p, strength: drexSwing.strength },
          "SWING_ENTRY_REJECTED_DREX");
        await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason: `DREX_SWING: ${drexSwing.reason}`, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
        await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_REJECTED", rejectReason: `DREX_SWING: ${drexSwing.reason}`, analysis, h1Bars, price: live });
        continue;
      }
      if (drexSwing.kind === "go") {
        logger.info({ symbol, strategyId: plan.strategyId, p: drexSwing.p, direction: drexSwing.direction, strength: drexSwing.strength, model: drexSwing.data.model, requestId: drexSwing.data.requestId },
          "DREX_SWING_GO");
      } else {
        logger.info({ symbol, strategyId: plan.strategyId, reason: drexSwing.reason }, "DREX_SWING_SKIP");
      }
      // TAHAP 4D: kandidat SWING = perubahan material -> picu analisis AI panel
      // untuk simbol kandidat (dedup+budget internal; fail-open; async).
      maybeTriggerPanelAnalysis(symbol.replace(/USDT$/i, ""));

      const symbolRulesRow = await db.symbol.findUnique({ where: { symbol } });
      const riskPlanInput = {
        symbol, mode: "SWING" as const, strategyId: plan.strategyId,
        side: plan.side, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price,
        equityUsd, targetRiskUsd: policy.targetRiskUsd,
        riskBudgetMode: "GROSS" as const,
        allowStepOverhang: true,
        slippageBps: 0,
        leverageTarget: policy.leverage,
        marginMode: (env.MARGIN_MODE === "ISOLATED" ? "ISOLATED" : "CROSS") as "CROSS" | "ISOLATED",
        maxMarginUsd: maxMarginForMode("SWING"),
        marginCapPct: equityUsd < 180 ? 0.25 : 0.4,
        symbolRules: {
          symbol, minNotional: symbolRulesRow?.minNotional ?? 5,
          tickSize: symbolRulesRow?.tickSize ?? 0.0001,
          stepSize: symbolRulesRow?.stepSize ?? 0.001,
          maxLeverage: symbolRulesRow?.maxLeverage ?? 25,
          leverageUpdatedAt: symbolRulesRow?.maxLeverageUpdatedAt?.getTime() ?? Date.now(),
          isBlacklisted: symbolRulesRow?.isBlacklisted ?? false,
        },
      };
      // 27 Okt 2026 (permintaan operator): AI Council di FUNNEL ENTRY, bukan di
      // level scan — hanya kandidat yang SIAP dieksekusi yang di-vote 3 agen
      // (Vega/Arka/Wardha). Fail-closed: veto/timeout = entry ditahan. Bukti
      // keputusan tercatat di EventLog COUNCIL_DECISION (mesh dashboard).
      if (env.ENABLE_AI_COUNCIL) {
        const { runPreEntryCouncil } = await import("../agents/councilEngine.js");
        const councilGate = await runPreEntryCouncil({
          symbol, side: plan.side, mode: "SWING", strategyId: plan.strategyId,
          entryPrice: live, slPrice: plan.slPrice, tpPrice: plan.tp1Price,
          atrValue: analysis.trigger?.atrPct ?? undefined,
          regimeInfo: plan.tfSummary || analysis.bias?.regime || "UNKNOWN",
          technicalScore: plan.quality,
        });
        if (!councilGate.approved) {
          const reason = `COUNCIL: ${councilGate.decision.summaryNarrative}`.slice(0, 200);
          logger.info({ symbol, reason }, "SWING_ENTRY_REJECTED_COUNCIL");
          await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
          await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_REJECTED", rejectReason: reason, analysis, h1Bars, price: live });
          continue;
        }
      }

      let opened: Awaited<ReturnType<typeof executePlannedEntry>> | null = null;
      try {
        opened = await executePlannedEntry(riskPlanInput as never, {
          mode: "SWING", source: "AI", strategyId: plan.strategyId,
          // 20 Okt 2026: S-05 Polaris dihapus -> hanya RSW-01/02/03 yang hidup.
          strategyName: plan.strategyId === "RSW-01" ? "Orion" : plan.strategyId === "RSW-02" ? "Vega" : plan.strategyId === "RSW-03" ? "Draco" : plan.strategyName,
          entryType: plan.entryType,
          zoneType: plan.zoneType, zoneTop: plan.zoneTop, zoneBottom: plan.zoneBottom,
          outlookText: plan.strategyId.startsWith("RSW-")
              ? `Setup ${plan.strategyId === "RSW-01" ? "Orion" : plan.strategyId === "RSW-02" ? "Vega" : "Draco"} ${plan.side} SWING PAPER: sinyal riset terverifikasi; RR23 dikunci.`
              : `Setup ${plan.strategyId} ${plan.side} SWING PAPER.`,
        });
      } catch (err: any) {
        // Cap/kondisi berubah antar cek -> throw fail-closed; log & lanjut.
        logger.info({ symbol, reason: err?.message }, "SWING_ENTRY_REJECTED");
        await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_REJECTED", reason: err?.message ?? null, entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price });
        // Big Brain 16 Okt: kandidat terbentuk lalu ditolak = NO_GO (sampel negatif kalibrasi).
        await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_REJECTED", rejectReason: err?.message ?? null, analysis, h1Bars, price: live });
        continue;
      }

      // Sukses: catat jeda antar entry + narasi agen.
      if (opened?.position.id != null) {
        await linkDirectionBattleToPosition(battleId, opened.position.id);

        const volume24hUsd = binanceFuturesClient.getCachedPairs().find(p => p.symbol === symbol)?.vol24hUsd;
        const scores = [analysis.zoneScore, analysis.triggerScore, analysis.trendScore, analysis.structure.adx, volume24hUsd];
        if (scores.every(n => typeof n === "number" && Number.isFinite(n))) this.pendingKnn.set(opened.position.id, {
          symbol: symbol.toUpperCase(), mode: "SWING",
          features: buildKnnFeatures({ zoneScore: analysis.zoneScore, triggerScore: analysis.triggerScore,
            trendScore: analysis.trendScore, adx: analysis.structure.adx, volume24hUsd }),
        });
      }
      swingEntrySpacing.record();
      entryOncePerPair.mark(symbol);
      this.stats.tradesOpened++;
      logger.info(
        { symbol, side: plan.side, entry: live, sl: plan.slPrice, tp1: plan.tp1Price,
          strategyId: plan.strategyId, swingOpen: swingOpen + 1, swingCap },
        "SWING_ENTRY_OPENED"
      );
      await this.logSwingSignal({ symbol, side: plan.side, strategyId: plan.strategyId, decision: "ENTRY_OPENED", entryPrice: live, slPrice: plan.slPrice, tp1Price: plan.tp1Price, positionId: opened?.position.id ?? null });
      // Big Brain 16 Okt: GO + link positionId (JOIN kalibrasi keputusan->posisi).
      await this.logSwingDecision({ symbol, side: plan.side, strategyId: plan.strategyId, swingDecision: "ENTRY_OPENED", analysis, h1Bars, price: live, positionId: opened?.position.id ?? null });
      await this.speak(
        "trade-supervisor",
        `SWING ${symbol} ${plan.side} @ ${live.toFixed(4)} (${plan.strategyId}): SL ${plan.slPrice.toFixed(4)}, TP1 ${plan.tp1Price.toFixed(4)}. RR23: TP1 50% @2R, BE, final 50% @3R. cap ${swingOpen + 1}/${swingCap}.`,
        plan.strategyId.startsWith("RSW-")
            ? `Entry ${plan.strategyId === "RSW-01" ? "Orion" : plan.strategyId === "RSW-02" ? "Vega" : "Draco"} ${symbol} ${plan.side}: PAPER research. RR23: 50% @2R, BE, 50% @3R.`
            : `Entry ${plan.strategyId} ${symbol} ${plan.side}: PAPER.`,
        { symbol, strategyId: plan.strategyId, mode: "SWING", entry: live, sl: plan.slPrice, tp1: plan.tp1Price },
        { throttleMs: 0 }
      );
      return; // satu entry SWING per tick — jeda 60 mnt berlaku untuk berikutnya
    }
  }

  private async tryFillSlots(): Promise<void> {
    this.releaseStaleLocks();
    if (this.isEntryRunning) return; // lock dipegang pengisi lain
    const openCount = await db.position.count({ where: activePositionWhere() }).catch(() => this.lastOpenPositionsCount);
    if (openCount >= this.maxPositions) return; // slot penuh
    // Kandidat kosong? paksa scan sekarang supaya slot bisa segera diisi.
    const scanView = scannerPool.getScanView();
    const emptySlots = this.maxPositions - openCount;
    const progTry = this.progCache?.level ?? activeProgressiveLevel();
    if (!isFreshEntryScan(scanView.scan.refreshedAt) ||
        !scanView.candidates.some((c) => isAgentReviewCandidate(c, emptySlots, Date.now(), progTry))) {
      await this.tryScan();
    }
    await this.evaluateAndExecuteTrades(); // lock diambil di dalam
  }

  /**
   * WATCHDOG LOCK (audit 30 Sep 2026): bila satu await di jalur entry menggantung
   * (REST Binance/LLM tanpa timeout), lock step/entry bisa tertahan true selamanya
   * — entry timer berhenti tanpa log & slot 0/20 beku. Fungsi ini melepas lock
   * yang tertahan melampaui batas aman TANPA mengubah gate/threshold apa pun.
   */
  private releaseStaleLocks(): void {
    const now = Date.now();
    if (this.isEntryRunning && this.entryLockStartedAt > 0 &&
        now - this.entryLockStartedAt > AutonomousTradingBot.ENTRY_LOCK_MAX_MS) {
      logger.warn({ heldMs: now - this.entryLockStartedAt, maxMs: AutonomousTradingBot.ENTRY_LOCK_MAX_MS },
        "ENTRY_LOCK_STALE_RESET: lock pengisi slot tertahan, dilepas paksa");
      this.isEntryRunning = false;
      this.entryLockStartedAt = 0;
    }
    if (this.isStepRunning && this.stepLockStartedAt > 0 &&
        now - this.stepLockStartedAt > AutonomousTradingBot.STEP_LOCK_MAX_MS) {
      logger.warn({ heldMs: now - this.stepLockStartedAt, maxMs: AutonomousTradingBot.STEP_LOCK_MAX_MS },
        "STEP_LOCK_STALE_RESET: lock siklus utama tertahan, dilepas paksa");
      this.isStepRunning = false;
      this.stepLockStartedAt = 0;
    }
  }

  /**
   * 16 Okt 2026 (Big Brain): tulis DecisionLog untuk lane SWING + link
   * positionId. Selama ini loop belajar mati total karena logDecision hanya
   * tercapai lewat judge SCALP yang early-return. Fail-open ganda: logDecision
   * sudah fail-open, dan kegagalan di sini tidak pernah menyentuh trading.
   */
  private async logSwingDecision(input: {
    symbol: string; side: "LONG" | "SHORT"; strategyId: string | null;
    swingDecision: "ENTRY_OPENED" | "ENTRY_REJECTED" | "SKIP_ENTRY_GAP" | "SIGNAL_NO_PLAN" | "SKIP_VOLUME_BELOW_MIN";
    rejectReason?: string | null; analysis: MtfAnalysis; h1Bars: Bar[]; price: number;
    positionId?: number | null;
  }): Promise<void> {
    try {
      const features = buildSwingDecisionFeatures({
        symbol: input.symbol, side: input.side, strategyId: input.strategyId,
        decision: mapSwingDecisionToDecisionLog(input.swingDecision),
        rejectReason: input.rejectReason ?? null,
        analysis: input.analysis, h1Bars: input.h1Bars, price: input.price,
      });
      const decisionLogId = await logDecision(features);
      if (input.positionId != null) await linkDecisionToPosition(decisionLogId, input.positionId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), symbol: input.symbol },
        "SWING_DECISION_LOG_FAIL"); // fail-open — trading tak pernah terganggu
    }
  }

  /**
   * Ingatan jalur SWING (14 Okt 2026): catat tiap evaluasi sinyal swing yang
   * BENAR-BENAR ada sinyalnya ke SwingSignalLog (bahan riset LLM Market Analyst
   * + kalibrasi funnel). Fail-open — kegagalan log tak pernah mengganggu trading.
   */
  private async logSwingSignal(row: {
    symbol: string; side: string; strategyId: string; decision: string;
    reason?: string | null; entryPrice?: number | null; slPrice?: number | null;
    tp1Price?: number | null; rr?: number | null; positionId?: number | null;
  }): Promise<void> {
    await db.swingSignalLog.create({ data: {
      symbol: row.symbol, side: row.side, strategyId: row.strategyId,
      decision: row.decision, reason: row.reason ?? null,
      entryPrice: row.entryPrice ?? null, slPrice: row.slPrice ?? null,
      tp1Price: row.tp1Price ?? null, rr: row.rr ?? null,
      positionId: row.positionId ?? null,
    } }).catch(() => undefined);
  }

  /** Satu siklus LLM Market Analyst (fail-open; dayKey UTC dari jam sekarang). */
  private async runAnalystCycle(): Promise<void> {
    const dayKey = new Date().toISOString().slice(0, 10);
    await runMarketAnalystCycle(dayKey).catch(() => undefined);
  }

  /**
   * 23 Okt 2026 (F-C): stop() SEKARANG MENUNGGU pekerjaan in-flight.
   * Sebelumnya stop() hanya clearInterval 6 timer; step() yang sedang berjalan
   * (evaluateAndExecuteTrades / tryScan) tetap lanjut dan bisa mengirim order
   * SETELAH perintah berhenti. Itu berbahaya: restart/deploy bisa membuka
   * posisi baru di detik terakhir. Sekarang: hentikan timer, lalu tunggu step
   * in-flight selesai (dengan batas waktu keras supaya tidak menggantung).
   * Batas: stopTimeoutMs. Kalau lewat, log jujur — in-flight dibiarkan
   * (membunuh mid-order lebih berbahaya daripada menunggu).
   */
  public async stop(opts?: { timeoutMs?: number }): Promise<{ waitedMs: number; inFlightTimedOut: boolean }> {
    if (!this.isRunning) return { waitedMs: 0, inFlightTimedOut: false };
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.entryTimer) {
      clearInterval(this.entryTimer);
      this.entryTimer = null;
    }
    if (this.scannerTimer) {
      clearInterval(this.scannerTimer);
      this.scannerTimer = null;
    }
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = null;
    }
    if (this.swingTimer) {
      clearInterval(this.swingTimer);
      this.swingTimer = null;
    }
    if (this.analystTimer) {
      clearInterval(this.analystTimer);
      this.analystTimer = null;
    }
    if (this.agentHeartbeatTimer) {
      clearInterval(this.agentHeartbeatTimer);
      this.agentHeartbeatTimer = null;
    }
    // Tunggu step in-flight (jika ada) supaya tidak ada order yang lolos
    // setelah perintah berhenti.
    const timeoutMs = opts?.timeoutMs ?? 150_000;
    const started = Date.now();
    let timedOut = false;
    while (this.isStepRunning && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.isStepRunning) {
      timedOut = true;
      logger.warn({ waitedMs: Date.now() - started, timeoutMs },
        "BOT_STOP: langkah in-flight belum selesai dalam batas waktu — dibiarkan (membunuh mid-order lebih berbahaya)");
    }
    const waitedMs = Date.now() - started;
    logger.info({ waitedMs, inFlightTimedOut: timedOut }, "Autonomous Trading Bot dinonaktifkan");
    return { waitedMs, inFlightTimedOut: timedOut };
  }

  /**
   * JALANKAN BOT SEKARANG (tombol terminal "JALANKAN BOT").
   * Menyalakan ulang sistem bila mati/berhenti, lalu memaksa SATU siklus penuh
   * segera (supervisi + scan + evaluasi entry) tanpa menunggu timer berikutnya.
   * Bila focusSymbol diisi, pair itu diprioritaskan sebagai kandidat pertama
   * (tetap wajib lolos semua gate: volume > VOLUME_MIN_USD, harga live, strategi match).
   */
  public async runNow(focusSymbol?: string): Promise<{
    started: boolean;
    isRunning: boolean;
    openedNow: number;
    openPositions: number;
    lastError: string | null;
    focusSymbol: string | null;
  }> {
    const wasRunning = this.isRunning;
    /*
       23 Okt 2026 (BUG FIX): sama seperti status(), hanya cek timer WAJIB.
       Kalau entryTimer ikut dihitung, mode SWING (tanpa scalp lane) selalu
       terlihat "mati" -> stop()+start() loop.
    */
    const timersAlive = Boolean(this.timer && this.scannerTimer && this.supervisorTimer);
    if (!this.isRunning || !timersAlive) {
      // 23 Okt 2026 (F-C): stop() jadi async (menunggu langkah in-flight).
      if (this.isRunning) await this.stop();
      this.start();
    }
    const focus = typeof focusSymbol === "string" ? focusSymbol.toUpperCase() : null;
    if (focus) {
      logger.info({ symbol: focus }, "BOT_RUN_NOW: fokus pair dari tombol terminal");
    }
    this.focusSymbol = focus;
    const before = await db.position.count({ where: activePositionWhere() }).catch(() => 0);
    try {
      await this.step();
    } finally {
      this.focusSymbol = null;
    }
    const after = await db.position.count({ where: activePositionWhere() }).catch(() => before);
    return {
      started: !wasRunning || !timersAlive,
      isRunning: this.isRunning,
      openedNow: Math.max(0, after - before),
      openPositions: after,
      lastError: this.lastError,
      focusSymbol: focus,
    };
  }

  public async step(): Promise<void> {
    this.releaseStaleLocks();
    if (this.isStepRunning) return;
    this.isStepRunning = true;
    this.stepLockStartedAt = Date.now();
    this.cycleCount++;
    this.stats.cycleCount = this.cycleCount;
    this.lastCycleAt = Date.now();
    this.stats.lastCycleAt = this.lastCycleAt;

    try {
      // 9 Okt 2026 (fix JCTUSDT #2760): supervisePositions DIPINDAHKAN ke timer
      // independen runSupervisorTick() — eksekusi SL/TP tidak lagi menumpang lock
      // siklus utama (yang terbukti bisa stall ~10 menit dan membutakan supervisor).
      if (Date.now() - this.lastParameterRefreshAt >= 30_000) {
        this.lastParameterRefreshAt = Date.now();
        const runtime = await refreshActiveParameterRuntime().catch((error) => ({ version: null, applied: false, reason: (error as Error)?.message ?? "PARAMETER_REFRESH_FAILED" }));
        if (runtime.version) logger.info(runtime, "GATED_PARAMETER_RUNTIME_REFRESH");
      }
      // T-07/T-14/T-16: satu job harian — brief riset, laporan artefak, alert metrik.
      const dailyJobDay = new Date().toISOString().slice(0, 10);
      if (this.lastDailyJobDay !== dailyJobDay) {
        this.lastDailyJobDay = dailyJobDay;
        await this.runDailyJobs(dailyJobDay).catch((error) => logger.warn({ err: (error as Error)?.message }, "DAILY_JOBS_FAILED"));
      }
      // PRIORITAS ISI SLOT (perintah operator): saat masih ada slot kosong,
      // loop pembelajaran (post-mortem + tuner + backtest = banyak panggilan LLM)
      // DILEWATI sementara supaya penilaian entry (Arka/Wardha) dapat jatah
      // waktu & kuota LLM lebih besar. Tetap dijalankan tiap 5 siklus & saat penuh.
      const slotsEmpty = this.lastOpenPositionsCount < this.maxPositions;
      const learningDue = !slotsEmpty || this.cycleCount % 5 === 0;
      // Post-mortem now consults the whole agent panel; it must not block scanning or entry.
      if (learningDue && !this.learningLoopInFlight) this.startLearningLoopInBackground();
      const now = Date.now();
      if (now - this.lastScanAt >= 8000 || this.stats.totalScans === 0) {
        await this.withTimeout(this.tryScan(), 90_000, "scannerCycle");
      }
      // WATCHDOG (audit 30 Sep 2026): jalur entry WAJIB dibungkus timeout, sama
      // seperti supervisePositions/tryScan. Sebelumnya await langsung ke
      // evaluateAndExecuteTrades() membuat satu REST/LLM yang menggantung
      // membekukan SELURUH siklus (cycle macet, slot 0/20) tanpa log.
      await this.withTimeout(this.evaluateAndExecuteTrades(), 120_000, "fillSlotsOnce");
    } catch (err: any) {
      this.lastError = err?.message || String(err);
    } finally {
      this.isStepRunning = false;
      this.stepLockStartedAt = 0;
    }
  }

  private startLearningLoopInBackground(): void {
    this.learningLoopInFlight = true;
    void this.runContinuousLearningLoop()
      .catch((err) => logger.warn({ err: (err as Error)?.message }, "LEARNING_LOOP_FAILED"))
      .finally(() => { this.learningLoopInFlight = false; });
  }

  private async supervisePositions(): Promise<void> {
    try {
      await seedSymbolProbationOnce();
      // 10 Okt 2026 (jalur LIVE): posisi LIVE ditutup oleh SL/TP resting di
      // exchange (livePositionWatcher mencatatnya di DB). Supervisor internal
      // (mark-price polling) HANYA untuk posisi PAPER — supervisor LIVE di sini
      // akan double-exit melawan resting order exchange.
      const openPositions = await db.position.findMany({ where: { status: "OPEN", source: { notIn: ["DEMO"], not: { startsWith: "LIVE_" } } } });
      const activeBefore = openPositions.filter((p) => p.source !== "DEMO").length;
      this.lastOpenPositionsCount = activeBefore;
      // SATU TRADE PER PAIR: sinkronkan guard dengan kenyataan DB setiap siklus.
      //  - pair yang OPEN            -> ditandai (entry ulang dilarang)
      //  - pair yang sudah tidak OPEN -> dirilis (trade selesai, boleh entry lagi)
      // 27 Okt 2026 (insiden go-live): openSet WAJIB memuat SEMUA posisi OPEN
      // (paper + live). Sebelumnya hanya posisi paper; di mode LIVE posisi
      // LIVE_* yang masih OPEN terbaca "tidak ada di openSet" -> pair dilepas +
      // cooldown 120 mnt + probation dicatat untuk trade yang MASIH HIDUP.
      const allOpen = await db.position.findMany({
        where: { status: "OPEN", source: { not: "DEMO" } },
        select: { symbol: true },
      });
      const openSet = new Set(allOpen.map((p) => p.symbol));
      for (const sym of openSet) entryOncePerPair.mark(sym);
      for (const sym of entryOncePerPair.active()) {
        if (!openSet.has(sym)) {
          entryOncePerPair.release(sym);
          // Re-entry cooldown pasca-CLOSE (2 Okt 2026): begitu trade selesai (SL/TP/BE/
          // TREND_FLIP, apa pun), pair diblokir untuk entry baru (kedua sisi) selama
          // REENTRY_COOLDOWN_MS - cegah double-loss beruntun (SAND/ENJ/CAP style).
          postCloseReentryCooldown.record(sym);
          // Probation simbol anti-churn (4 Okt 2026): catat hasil close; 3 loss
          // beruntun pada simbol yang sama -> simbol diblokir 45 menit.
          try {
            // 27 Okt 2026 (insiden go-live): hasil close yang dipakai probation
            // dan cooldown global harus SESUAI mode. Di LIVE, trade simulasi
            // (PAPER_AI) tidak boleh memicu probation/cooldown entry live.
            const isLiveMode = String(process.env.BINANCE_EXECUTION_MODE ?? "PAPER").trim().toUpperCase() === "LIVE";
            const lastTrade = await db.trade.findFirst({
              where: {
                symbol: sym,
                ...(isLiveMode ? { source: { startsWith: "LIVE_" } } : { source: { not: "DEMO" } }),
              },
              orderBy: { id: "desc" },
              select: { win: true, position: { select: { closeReason: true } } },
            });
            symbolProbation.recordClose(sym, lastTrade?.win === true);
          // 11 Okt 2026 — cooldown pasca-LOSS global (audit 5 Whys): catat loss terakhir.
          // 13 Okt 2026 — closeReason "SL" memicu blokir panjang 60 menit (perintah operator).
          if (lastTrade && lastTrade.win === false) {
            lossCooldownGuard.recordClose(false, undefined, lastTrade.position?.closeReason);
          }
          } catch (err) {
            logger.warn({ err: (err as Error)?.message, symbol: sym }, "SYMBOL_PROBATION_RECORD_FAILED");
          }
          logger.info({ symbol: sym, cooldownMs: REENTRY_COOLDOWN_MS, probationStreak: symbolProbation.currentStreak(sym) }, "PAIR_TRADE_SELESAI: pair dirilis; re-entry (kedua sisi) diblokir 120 menit (post-close cooldown, 14 Okt)");
        }
      }
      const priceMap = new Map<string, number>();
      // P2 FAST-PATH (perintah operator 26 Sep 2026): harga UTAMA dari PRICE HUB WS
      // (0 REST, segar <15 dtk). Fallback REST per posisi dijalankan PARALEL dengan
      // timeout singkat 3 dtk — posisi tanpa harga DILEWATI siklus ini (lanjut),
      // bukan memblokir seluruh supervisi 8 dtk × N posisi (biang timeout 40 dtk).
      const hub = binanceFuturesClient.getHubPrices();
      const hubLive = binanceFuturesClient.isHubLive(15000);
      const needRest = openPositions.filter(
        (pos) => !hubLive || !(Number(hub.map[pos.symbol]?.m ?? 0) > 0)
      );
      const restMarks = new Map<string, number>();
      if (needRest.length > 0) {
        const fetched = await Promise.all(
          needRest.map(async (pos) => {
            try {
              const t = await Promise.race([
                binanceFuturesClient.fetchSymbolTicker(pos.symbol),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
              ]);
              const mp = Number((t as { markPrice?: unknown } | null)?.markPrice ?? 0);
              return { symbol: pos.symbol, markPrice: mp > 0 ? mp : 0 };
            } catch {
              return { symbol: pos.symbol, markPrice: 0 };
            }
          })
        );
        for (const f of fetched) {
          if (f.markPrice > 0) restMarks.set(f.symbol, f.markPrice);
        }
      }
      for (const pos of openPositions) {
        const markPrice =
          (hubLive ? Number(hub.map[pos.symbol]?.m ?? 0) : 0) || restMarks.get(pos.symbol) || 0;
        if (!(markPrice > 0)) continue;
        const currentPrice = markPrice;
        priceMap.set(pos.symbol, currentPrice);
        const evals = await defaultPositionSupervisor.evaluatePriceTick({
          symbol: pos.symbol,
          markPrice: currentPrice,
        });

        for (const ev of evals) {
          if (ev.action === "TP1") {
            this.stats.tp1Hits++;
            await this.speak(
              "trade-supervisor",
              `TP ${pos.symbol} ${pos.side} kena di $${currentPrice.toFixed(4)} (entry $${pos.entryPrice}). 100% posisi ditutup profit (single target RR klasik).`,
              `TP tercapai pada ${pos.symbol} di harga $${currentPrice.toFixed(4)}. Seluruh posisi ditutup profit; tidak ada runner 35% / SL-ke-BE.`,
              { symbol: pos.symbol, action: "TP1", price: currentPrice }
            );
          } else if (ev.action === "SL") {
            this.stats.slHits++;
            this.stats.tradesClosed++;
            await this.speak(
              "trade-supervisor",
              `SL ${pos.symbol} tersentuh di $${currentPrice.toFixed(4)} (entry $${pos.entryPrice}). Posisi dipotong disiplin, rugi terbatas $1. Alasan: ${ev.reason ?? "stop loss"}.`,
              `Stop Loss tersentuh pada ${pos.symbol} di harga $${currentPrice.toFixed(4)}. Posisi ditutup disiplin sesuai batas risiko per trade $1.`,
              { symbol: pos.symbol, action: "SL", price: currentPrice }
            );
          }
        }

      }

      // ── TREND-REVERSAL WATCH — DIHAPUS dari siklus produksi (30 Sep 2026) ──
      // Operator meminta HANYA SL/TP yang menutup posisi. Perintah 30 Sep 2026
      // menghapus exit TP2/BE/TIMEOUT untuk SCALP; ladder TP2/BE/TPmax SWING
      // dipulihkan 15-16 Okt 2026 di positionSupervisor. Metode
      // watchTrendReversal() / exitOnTrendFlip() tetap ada untuk unit test saja.

      const activeAfter = await db.position.count({ where: activePositionWhere() });
      this.lastOpenPositionsCount = activeAfter;
      if (activeAfter < activeBefore && this.isRunning) {
        // Refill segera setelah TP/SL membebaskan slot; lock entry dan
        // pemeriksaan akhir tetap mencegah double order.
        void this.tryFillSlots();
      }
    } catch {}
  }

  // Throttle pembacaan trend per simbol: 1x per 30 detik (anti-spam LLM + hemat budget).
  /** T-07/T-16: brief riset harian + laporan artefak dari angka deterministik. */
  private async runDailyJobs(dayKey: string): Promise<void> {
    const closed = await db.trade.findMany({
      where: { OR: [{ source: null }, { source: { not: "DEMO" } }] },
      orderBy: { createdAt: "desc" },
      take: 500,
      // 8 Okt 2026 (fix era-mixed + fee notional): openedAt posisi menentukan
      // makna nomor strategi (canonicalStrategyKey); slPrice dipakai derive qty;
      // closeReason menentukan rate exit (TP limit = maker, SL = taker).
      include: { position: { select: { openedAt: true, slPrice: true, closeReason: true } } },
    });
    const rows = closed.map((t) => ({
      ...t,
      strategyId: t.strategyId ?? "UNKNOWN",
      openedAt: t.position?.openedAt ?? null,
      closeReason: t.position?.closeReason ?? null,
      qty: deriveTradeQty(t, t.position?.slPrice ?? null),
    })) as unknown as TradeForEvaluation[];
    const stats = summarizeClosedTrades(rows);
    const nowIso = `${dayKey}T00:00:00.000Z`;
    const briefPath = path.join(process.cwd(), "data", "research", `brief-${dayKey}.md`);
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    // T-19: narasi opsional dari LLM. Angka tetap milik TS; label byLlm jujur.
    const narration = await defaultResearchLayer
      .narrateResearchBrief(stats, dayKey)
      .catch(() => ({ text: "", byLlm: false }));
    const narrationBlock = ["", "## Narasi", "", narration.text || "(tidak ada narasi)", "",
      `> Narasi ditulis LLM: ${narration.byLlm ? "ya" : "tidak (fallback deterministik)"}. Angka di atas tidak diubah oleh LLM (Golden Rules #1).`, ""].join("\n");
    fs.writeFileSync(briefPath, buildResearchBrief(stats, dayKey) + narrationBlock, "utf8");
    const alerts = await this.emitMetricAlerts(dayKey);
    const reportPath = path.join(process.cwd(), "data", "reports", reportFileName(nowIso));
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const appliedParams = runtimeParamsApplied().map((a) => ({ param: a.param, strategyId: a.strategyId, value: a.value, version: a.version }));
    // SMB T-02 (9 Okt 2026): report card disiplin proses dari kolom executionMistake
    // jurnal + event RULE_FRICTION hari ini. 100% deterministik (GR #1).
    const learnings = await db.learningEntry.findMany({
      where: { createdAt: { gte: new Date(`${dayKey}T00:00:00.000Z`), lt: new Date(new Date(`${dayKey}T00:00:00.000Z`).getTime() + 86_400_000) } },
      include: { trade: { include: { position: { select: { closeReason: true, slPrice: true, originalSlPrice: true } } } } },
    });
    const cardTrades = learnings.filter((l) => l.trade).map((l) => {
      const t = l.trade!;
      const pos = t.position as unknown as { closeReason?: string | null; slPrice?: number | null; originalSlPrice?: number | null } | null;
      return {
        tradeId: l.tradeId,
        symbol: t.symbol,
        executionMistake: l.executionMistake ?? "MISTAKE_NONE",
        isExecutionMistake: Boolean(l.isExecutionMistake),
        closeReason: pos?.closeReason ?? null,
        riskUsd: t.riskUsd,
        plannedSlPrice: pos?.originalSlPrice ?? pos?.slPrice ?? null,
        executedSlPrice: pos?.slPrice ?? null,
      };
    });
    const dayStartMs = new Date(`${dayKey}T00:00:00.000Z`).getTime();
    const frictionEventsToday = await db.eventLog.count({
      where: { type: "RULE_FRICTION", createdAt: { gte: new Date(dayStartMs), lt: new Date(dayStartMs + 86_400_000) } },
    });
    const approvedRules = await db.playbookRule.findMany({ where: { status: "APPROVED" } });
    const card = computeProcessReportCard({ trades: cardTrades, frictionEventsToday });
    const processReportCard = renderProcessReportCard(card, approvedRules.length ? formatRuleSummary(approvedRules as unknown as Parameters<typeof formatRuleSummary>[0]) : []);
    fs.writeFileSync(reportPath, buildDailyReport({ stats, alerts, appliedParams, now: nowIso, processReportCard }), "utf8");
    // Kirana (narrator, 27 Okt 2026): laporan harian yang ditulis tadi juga
    // diumumkan ke feed agen — sebelumnya file jalan tapi Kirana bisu sejak
    // 26 Okt karena tidak ada yang menulis dialognya dari jalur ini.
    await this.speak(
      "narrator",
      `Laporan ${dayKey}: ${rows.length} trade ditutup, ${alerts.length} alert metrik, ${card.mistakes} kesalahan proses, ${frictionEventsToday} friksi aturan.`,
      `Laporan harian ${dayKey} selesai dibuat; ${card.mistakes} kesalahan proses tercatat hari ini.`,
      { dayKey, reportPath }
    );
    logger.info({ briefPath, reportPath, alerts: alerts.length, processMistakes: card.mistakes, frictionEventsToday }, "DAILY_JOBS_DONE");
  }

  /** T-14: METRIC_ALERT ke EventLog — satu kali per (kode, strategi) per hari. */
  private async emitMetricAlerts(dayKey: string): Promise<MetricAlert[]> {
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
    const today = await db.trade.findMany({
      where: { createdAt: { gte: dayStart }, OR: [{ source: null }, { source: { not: "DEMO" } }] },
      orderBy: { createdAt: "asc" },
    });
    const byStrategy = new Map<string, typeof today>();
    for (const t of today) {
      const key = t.strategyId ?? "UNKNOWN";
      byStrategy.set(key, [...(byStrategy.get(key) ?? []), t]);
    }
    const alerts: MetricAlert[] = [];
    for (const [strategyId, list] of byStrategy) {
      const winsToday = list.filter((t) => t.win).length;
      const pnlTodayUsd = list.reduce((a, t) => a + t.pnlUsd, 0);
      let losingStreak = 0;
      for (let i = list.length - 1; i >= 0 && !list[i].win; i--) losingStreak++;
      let run = 0;
      let worst = 0;
      for (const t of list) {
        run += t.pnlUsd;
        if (run < worst) worst = run;
      }
      const snapshot = { strategyId, tradesToday: list.length, winsToday, pnlTodayUsd, losingStreak,
        drawdownUsd: Math.max(0, -worst), winRatePct: list.length ? (winsToday / list.length) * 100 : 0 };
      for (const alert of evaluateThresholds(snapshot)) {
        if (!this.metricAlertLog.shouldEmit(alert.code, strategyId, dayKey)) continue;
        alerts.push(alert);
        await db.eventLog.create({ data: { type: "METRIC_ALERT", severity: "warn", payload: JSON.stringify({ ...alert, dayKey }) } });
      }
    }
    return alerts;
  }

  private lastTrendWatchAt: Map<string, number> = new Map();
  /** Debounce cross-market trend flips so a one-cycle wobble cannot close/reverse a trade. */
  private readonly trendFlipConfirmations = new TrendFlipConfirmationGuard();
  // Catatan simbol non-crypto yang diblokir penjaga kelas aset (audit).
  private blockedAssetNotes: Map<string, string> = new Map();
  // Cache blacklist manual operator (Setting + tabel Symbol), TTL 60 detik.
  private manualBlacklistCache: { set: Set<string>; atMs: number } | null = null;

  /**
   * Blacklist manual operator (Rules §1.8: blacklist manual SELALU menang).
   * Dipakai sebagai argumen checkAssetClass di scanner & pre-order supaya pair
   * yang di-blacklist operator dari Settings tidak pernah ditrading bot.
   * Gagal baca DB -> pakai cache lama (fail-safe, bukan fail-open kosong).
   */
  private async loadManualBlacklist(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.manualBlacklistCache && now - this.manualBlacklistCache.atMs < 60_000) {
      return this.manualBlacklistCache.set;
    }
    try {
      const manual = await prismaUniverseRepo.getManualBlacklist();
      this.manualBlacklistCache = { set: new Set(manual), atMs: now };
    } catch {
      if (!this.manualBlacklistCache) this.manualBlacklistCache = { set: new Set(), atMs: now };
    }
    return this.manualBlacklistCache.set;
  }

  // Baca makro ringkas untuk konteks trend (reuse fungsi deterministik macroGate).
  private async readMacroForTrend(): Promise<{
    btcTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    ethTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    btcDomChg: number;
    adx: number;
    chg1hPct: number;
    ethChg1hPct: number;
    btcRegime: string;
    shieldActive: boolean;
  }> {
    try {
      const { btcK, ethK, domK } = await this.getMacroKlines();
      const toBars = (k: unknown): Bar[] =>
        (Array.isArray(k) ? k : [])
          .map((b: any) => ({
            openTime: Number(b[0]),
            open: Number(b[1]),
            high: Number(b[2]),
            low: Number(b[3]),
            close: Number(b[4]),
            volume: Number(b[5]),
          }))
          .filter((b) => Number.isFinite(b.close) && b.close > 0);
      const btcBars = toBars(btcK);
      const ethBars = toBars(ethK);
      const domBars = toBars(domK);
      if (btcBars.length < 2 || ethBars.length < 2) {
        return { btcTrend: "NEUTRAL", ethTrend: "NEUTRAL", btcDomChg: 0, adx: 0, chg1hPct: 0, ethChg1hPct: 0, btcRegime: "RANGING", shieldActive: false };
      }
      const btc = analyzeMacroSymbol("BTCUSDT", btcBars);
      const eth = analyzeMacroSymbol("ETHUSDT", ethBars);
      const dom = analyzeBtcDom(domBars);
      return {
        btcTrend: btc.trendDirection,
        ethTrend: eth.trendDirection,
        btcDomChg: dom.chg1hPct,
        adx: btc.adx,
        chg1hPct: btc.chg1hPct,
        ethChg1hPct: eth.chg1hPct,
        btcRegime: String(btc.regime),
        shieldActive: Boolean(btc.shieldActive),
      };
    } catch {
      return { btcTrend: "NEUTRAL", ethTrend: "NEUTRAL", btcDomChg: 0, adx: 0, chg1hPct: 0, ethChg1hPct: 0, btcRegime: "RANGING", shieldActive: false };
    }
  }

  // ============================================================
  // TREND-REVERSAL WATCH — 12 AI Agents membaca arah trend posisi OPEN.
  // Rhea (regime-analyst) = pembaca utama; Vega (macro-scout) = konteks makro;
  // Nadira (trade-supervisor) = eksekutor close cerdas.
  // LLM hanya klasifikasi ARAH + KEYAKINAN; semua angka exit dihitung TS.
  // ============================================================
  /** Throttle per simbol: basis 30 dtk + 10 dtk per posisi terbuka (anti-spam LLM). */
  private trendWatchDue(symbol: string): boolean {
    const throttleMs = Math.max(30_000, this.lastOpenPositionsCount * 10_000);
    const last = this.lastTrendWatchAt.get(String(symbol ?? "").toUpperCase()) ?? 0;
    return Date.now() - last >= throttleMs;
  }

  /** Jalankan tugas async dengan batas paralel (anti-burst LLM/REST). */
  private async runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      let task = queue.shift();
      while (task) {
        await task().catch(() => undefined);
        task = queue.shift();
      }
    });
    await Promise.all(workers);
  }

  private async watchTrendReversal(pos: any, currentPrice: number): Promise<void> {
    try {
      // Throttle ADAPTIF kini diputus di supervisor (trendWatchDue + reservasi
      // timestamp saat dispatch) supaya pembacaan bisa paralel terbatas.
      // Basis 30 dtk, +10 dtk per posisi terbuka (maks 20 -> 200 dtk).
      const fresh: any = await db.position.findUnique({ where: { id: pos.id } });
      if (!fresh || fresh.status !== "OPEN") return;

      const side: "LONG" | "SHORT" = String(fresh.side).toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const entryPrice = Number(fresh.entryPrice);
      // 30 Sep 2026: SL-ke-BE dihapus; single target 100% — tak ada status runner.
      const beMoved = false;
      const qty = Number(fresh.qty || 0);
      const unrealizedNetUsd = Number((side === "LONG" ? (currentPrice - entryPrice) * qty : (entryPrice - currentPrice) * qty).toFixed(4));
      const holdMinutes = Math.max(1, Math.round((Date.now() - new Date(fresh.openedAt).getTime()) / 60000));

      const macro = await this.readMacroForTrend();

      // A macro-only one-read flip previously masqueraded as a confirmed pair trend.
      // Require BTC + ETH alignment, directional BTC 1h momentum, and two separated
      // readings before asking the agent to authorize the exit. The hard SL remains active.
      const reversalDirection = confirmedMacroFlipDirection({
        side,
        btcTrend: macro.btcTrend,
        ethTrend: macro.ethTrend,
        btcAdx: macro.adx,
        btcChange1hPct: macro.chg1hPct,
      });
      if (!reversalDirection) {
        this.trendFlipConfirmations.clear(String(fresh.symbol), side);
        return;
      }
      const zlemaIsFlip = true;
      const zlemaDirection = reversalDirection;
      const trendScore = Math.max(70, Math.min(95, Math.round(50 + macro.adx)));
      if (!this.trendFlipConfirmations.observe(String(fresh.symbol), side, reversalDirection)) return;

      const reading = await readTrendWithAgents(
        {
          symbol: String(fresh.symbol),
          side,
          entryPrice,
          currentPrice,
          zlemaDirection: zlemaDirection as "BULLISH" | "BEARISH" | "NEUTRAL",
          zlemaIsFlip,
          trendScore,
          adx: macro.adx,
          chg1hPct: macro.chg1hPct,
          btcTrend: macro.btcTrend,
          ethTrend: macro.ethTrend,
          btcDomChg1hPct: macro.btcDomChg,
          unrealizedNetUsd,
          beMoved,
          holdMinutes,
        },
        async (system, user) => {
          const res = await defaultLlmAdapter.callFast(user, system);
          return res.content;
        },
        "regime-analyst",
        "Rhea"
      );

      await this.logAgentDialog("regime-analyst", reading.narrative, {
        symbol: fresh.symbol,
        positionId: fresh.id,
        newTrend: reading.newTrend,
        confidence: reading.confidence,
        strength: reading.strength,
        urgency: reading.exitUrgency,
        byLlm: reading.byLlm,
      });

      if (!reading.shouldExit) {
        if (reading.exitUrgency === "WATCH") {
          await this.speak(
            "macro-scout",
            `Awas ${fresh.symbol}: trend ${reading.newTrend} ${reading.strength} melawan ${side}. Masih dipantau, belum close.`,
            `Trend ${reading.newTrend} terdeteksi melawan posisi ${fresh.symbol} (${side}). Status WATCH, dipantau satu siklus lagi.`,
            { symbol: fresh.symbol, positionId: fresh.id, newTrend: reading.newTrend },
            { throttleMs: 60_000 }
          );
        }
        return;
      }

      // EXIT_NOW: Nadira eksekusi close cerdas (reason TREND_FLIP).
      const ok = await defaultPositionSupervisor.exitOnTrendFlip(fresh.id, currentPrice, {
        newTrend: reading.newTrend,
        confidence: reading.confidence,
        strength: reading.strength,
        narrative: reading.narrative,
      });
      if (ok) {
        this.stats.tradesClosed++;
        await this.speak(
          "trade-supervisor",
        `Trend ${reading.newTrend} ${reading.strength} terkonfirmasi melawan ${side} di ${fresh.symbol}. Sisa posisi ditutup di $${currentPrice.toFixed(4)}; scanner mencari setup arah baru jika seluruh filter lolos.`,
          `TREND-FLIP EXIT ${fresh.symbol}: trend ${reading.newTrend} melawan ${side} (conf ${(reading.confidence * 100).toFixed(0)}%). Sisa posisi ditutup di $${currentPrice.toFixed(4)}.`,
          { symbol: fresh.symbol, positionId: fresh.id, newTrend: reading.newTrend, price: currentPrice }
        );
      }
    } catch {}
  }

  private async runContinuousLearningLoop(): Promise<void> {
    try {
      // Review trade baru DAN backfill jurnal lama yang belum memiliki 12 review
      // sukses plus roundtable berbukti. Satu trade per siklus menjaga loop entry
      // tetap responsif; kegagalan provider cooldown 15 menit lalu dicoba lagi.
      const eligibleTrades = await db.trade.findMany({
        where: { id: { gt: this.learningBackfillCursor }, source: { in: ["LIVE_AI", "LIVE_MANUAL", "PAPER_AI", "PAPER_MANUAL"] }, accountingQuality: { in: ["VERIFIED", "SIMULATED"] } },
        include: { position: true, learnings: { select: { proposal: true } } },
        orderBy: { id: "asc" },
        take: 100,
      });
      const now = Date.now();
      const pendingTrade = eligibleTrades.find((trade) => {
        const entry = trade.learnings[0];
        return !entry || shouldRetryAgentPanel({ proposal: entry.proposal }, now);
      });
      if (pendingTrade) this.learningBackfillCursor = pendingTrade.id;
      else if (eligibleTrades.length > 0) this.learningBackfillCursor = eligibleTrades[eligibleTrades.length - 1]!.id;
      else this.learningBackfillCursor = 0;
      const unlearnedTrades = pendingTrade ? [pendingTrade] : [];

      for (const trade of unlearnedTrades) {
        try {
          const learningEntry = await defaultPostMortemEvaluator.evaluateTrade(trade.id);
          this.stats.learningsCompleted++;

          // KNN: catat hasil resolved (win/loss + R) ke library analog Lorentzian.
          // Fitur dari momen ENTRY (pendingKnn); fallback netral bila tak ada.
          try {
            const pend = resolvedEntrySnapshot(this.pendingKnn, trade);
            if (pend) defaultKnnLibrary.addItem({
              id: trade.id,
              symbol: trade.symbol.toUpperCase(),
              mode: pend.mode,
              features: pend.features,
              win: Boolean(trade.win),
              rMultiple: Number(trade.rMultiple) || 0,
              timestamp: trade.createdAt.getTime(),
            });
            if (trade.positionId !== null) this.pendingKnn.delete(trade.positionId);
            if (pend) this.saveKnnLibrary();
          } catch {}
          const isLoss = learningEntry.outcome.startsWith("LOSS");
          const analysisByLlm = extractJsonObject(learningEntry.proposal ?? "")?.generationSource === "LLM";
          const panelComplete = hasCompleteAgentPanel(learningEntry);
          // 30 Sep 2026 — refactor SCALP-only: trade historis tetap dibaca apa adanya.
          const modeForTuning = learningModeOf(trade.mode);
          const strategyForTuning = trade.strategyId ?? "S-01";
          const tuningEnabled = modeForTuning !== null && isRuntimeTunable("pullBiasThreshold", modeForTuning, strategyForTuning);
          const cohortRows = isLoss && analysisByLlm && panelComplete && tuningEnabled ? await db.trade.findMany({
            where: { strategyId: strategyForTuning, mode: modeForTuning ?? undefined, source: { in: ["LIVE_AI", "LIVE_MANUAL", "PAPER_AI", "PAPER_MANUAL"] }, accountingQuality: { in: ["VERIFIED", "SIMULATED"] } },
            select: { pnlUsd: true, rMultiple: true, feeUsd: true }, orderBy: { id: "desc" }, take: 500,
          }) : [];
          const cohort = cohortRows.filter((row) => Number.isFinite(row.pnlUsd) && Number.isFinite(row.rMultiple) && Number.isFinite(row.feeUsd));
          const cohortLossCount = cohort.filter((row) => row.pnlUsd < 0).length;
          const cohortReady = cohort.length >= 30 && cohortLossCount >= 10;
          const rValues = cohort.map((row) => row.rMultiple).sort((a, b) => a - b);
          const medianR = rValues.length ? (rValues.length % 2 ? rValues[Math.floor(rValues.length / 2)]! : (rValues[rValues.length / 2 - 1]! + rValues[rValues.length / 2]!) / 2) : 0;
          const cohortEvidence = cohortReady ? {
            sampleCount: cohort.length, lossCount: cohortLossCount, winCount: cohort.filter((row) => row.pnlUsd > 0).length,
            averageR: Number((rValues.reduce((sum, value) => sum + value, 0) / rValues.length).toFixed(4)),
            medianR: Number(medianR.toFixed(4)),
            netPnlUsd: Number(cohort.reduce((sum, row) => sum + row.pnlUsd, 0).toFixed(4)),
            feesUsd: Number(cohort.reduce((sum, row) => sum + row.feeUsd, 0).toFixed(4)),
          } : undefined;

          await this.logAgentDialog(
            "post-mortem",
            `${analysisByLlm ? "ANALISIS_LLM" : "FALLBACK_TANPA_LLM"} ${learningEntry.outcome}: ${learningEntry.narrative} | Pelajaran: ${learningEntry.lesson ?? "-"}`,
            { tradeId: trade.id, causeCode: learningEntry.causeCode, outcome: learningEntry.outcome, byLlm: analysisByLlm }
          );

          // Tuning parameter hanya untuk LOSS (kemenangan diperkuat, bukan diubah).
          if (isLoss && analysisByLlm && panelComplete && !tuningEnabled) {
            await this.logAgentDialog("strategy-tuner", "TUNING_DISABLED_RR_LOCKED_OR_NO_RUNTIME_PATH: pelajaran dicatat; parameter strategi/mode ini tidak dapat berubah otomatis.", { tradeId: trade.id, strategyId: strategyForTuning, mode: modeForTuning });
          } else if (isLoss && analysisByLlm && panelComplete && cohortReady && modeForTuning) {
            const mode = modeForTuning;
            const strategyId = trade.strategyId ?? "S-01";
            const { proposal, candidateVersion, dialog: tunerDialog } = await defaultStrategyTuner.proposeTuning({
              causeCode: learningEntry.causeCode,
              strategyId,
              currentTp1R: rrPolicyForMode(mode, strategyId).tp1R,
              mode,
              cohortEvidence,
            });

            const { audit, dialog: auditDialog } = await defaultStrategyTuner.auditAndGateVersion(candidateVersion, { strategyId });
            if (audit.status === "ACTIVE") this.stats.parametersTuned++;
            if (audit.status !== "CANDIDATE") this.stats.backtestAudits++;

            // Dialog Sesha berlabel sumber; Laras mengusulkan hipotesis, Varuna mengaudit gate.
            await this.logAgentDialog(
              "strategy-tuner",
              tunerDialog.text,
              { tradeId: trade.id, candidateVersion, proposal }
            );
            await this.logAgentDialog(
              "backtest-auditor",
              auditDialog.text,
              { tradeId: trade.id, candidateVersion, status: audit.status }
            );
            await this.speak(
              "narrator",
              `Trade #${trade.id} ${trade.symbol} ${trade.side} rugi $${trade.pnlUsd}. Sebab tercatat ${learningEntry.causeCode}. Kandidat TP1 ${proposal.from}R ke ${proposal.to}R; status ${audit.status}: ${audit.reason}`,
              `Evaluasi Trade #${trade.id} (${trade.symbol} ${trade.side}): kandidat TP1_R ${audit.status}; parameter aktif tidak berubah sebelum gate OOS.`,
              { tradeId: trade.id, causeCode: learningEntry.causeCode, candidateVersion, status: audit.status }
            );
          } else if (isLoss && analysisByLlm && panelComplete) {
            await this.logAgentDialog("strategy-tuner", `MENUNGGU COHORT ${strategyForTuning}/${modeForTuning}: ${cohort.length}/30 trade valid, ${cohortLossCount}/10 loss. Belum cukup sampel untuk usulan TP1_R; parameter tidak diubah.`, { tradeId: trade.id, strategyId: strategyForTuning, mode: modeForTuning, sampleCount: cohort.length, lossCount: cohortLossCount });
          } else if (isLoss && analysisByLlm) {
            await this.speak(
              "narrator",
              `Trade #${trade.id} ${trade.symbol} tercatat loss; review 12 agen/roundtable belum lengkap. Tuning ditahan sampai evaluasi bukti selesai.`,
              `Trade #${trade.id}: review panel belum lengkap; kandidat parameter belum dibuat.`,
              { tradeId: trade.id, outcome: learningEntry.outcome, agentReviewsCompleted: extractJsonObject(learningEntry.proposal ?? "")?.agentPanel && (extractJsonObject(learningEntry.proposal ?? "")!.agentPanel as Record<string, unknown>).completedAgents }
            );
          } else if (!analysisByLlm) {
            await this.speak(
              "narrator",
              `Trade #${trade.id} ${trade.symbol} ${learningEntry.outcome} dicatat sebagai fallback tanpa LLM. Tidak ada pelajaran AI atau penyetelan parameter dari evaluasi ini.`,
              `Trade #${trade.id}: evaluasi LLM belum tersedia; catatan fallback disimpan terpisah.`,
              { tradeId: trade.id, outcome: learningEntry.outcome, byLlm: false }
            );
          } else {
            await this.speak(
              "narrator",
              `Trade #${trade.id} ${trade.symbol} ${trade.side} ${learningEntry.outcome} profit $${trade.pnlUsd}. Pelajaran: ${learningEntry.lesson ?? learningEntry.causeCode}. Pelajaran dicatat untuk pengujian; parameter belum berubah.`,
              `Evaluasi Trade #${trade.id} (${trade.symbol} ${trade.side}): ${learningEntry.outcome} — ${learningEntry.causeCode}.`,
              { tradeId: trade.id, causeCode: learningEntry.causeCode, outcome: learningEntry.outcome }
            );
          }
        } catch (err) {
          logger.warn({ tradeId: trade.id, err: (err as Error)?.message }, "LEARNING_SKIP: evaluasi trade gagal, lanjut ke berikutnya");
        }
      }

      // No evidence-free periodic tuning; candidates must originate from attributable outcomes.
    } catch {}
  }

  // ── MESIN SETUP (T-5.15): analisis multi-timeframe + pemilihan strategi ──
  // 30 Sep 2026 — refactor SCALP-only: parameter mode selalu "SCALP".
  private async analyzeSymbolMtf(symbol: string, mode: "SCALP" | "SWING", skipCache = false): Promise<MtfAnalysis | null> {
    try {
      return await analyzeMultiTimeframe(symbol, mode, (s, i, l) => binanceFuturesClient.fetchKlines(s, i, l), {
        cacheTtlMs: SETUP_ENGINE.mtfCacheTtlMs,
        skipCache,
      });
    } catch (err: any) {
      logger.warn({ symbol, err: err?.message }, "MTF_ANALYZE_FAIL");
      return null;
    }
  }

  /**
   * Analisis fresh atau cache maksimum 90 dtk. Trigger 1m yang lebih tua
   * ditolak demi mencegah entry dari setup yang sudah berubah.
   */
  private async analyzeSymbolMtfResilient(symbol: string, mode: "SCALP" | "SWING"): Promise<MtfAnalysis | null> {
    const fresh = await this.analyzeSymbolMtf(symbol, mode, true);
    if (fresh?.usable) return fresh;
    try {
      const cached = getCachedMtf(symbol, mode, 90_000, Date.now());
      if (cached) {
        logger.info({ symbol, mode }, "MTF_RECENT_CACHE: pakai cache <90 dtk (REST di-ban/gagal)");
        return cached;
      }
    } catch {}
    return null;
  }

  /**
   * P1 — "kontainer" paralel (perintah operator 26 Sep 2026): MTF dianalisis oleh
   * worker paralel via scannerPool. Anti-ban: concurrency dibatasi + start
   * tiap simbol di-stagger 100 mdtk agar burst REST tidak memicu 429 (yang dulu
   * berujung cooldown 5 mnt + MTF_UNAVAILABLE massal + slot kosong).
   * Gagal fetch per simbol = SKIP siklus ini (fresh-or-skip; TANPA baca cache basi).
   */
  private async warmMtfCache(symbols: string[], mode: "SCALP"): Promise<Map<string, MtfAnalysis>> {
    const out = new Map<string, MtfAnalysis>();
    if (symbols.length === 0) return out;
    // REGRESI 28 Sep 2026: cap 3 dilepas -> ikut env MTF_CONCURRENCY=12 ->
    // 12 analisis MTF paralel memicu 429 sehingga SELURUH kandidat jatuh ke
    // Jalur B (MTF_UNAVAILABLE, planGate false) dan tidak ada strategy match.
    // Cap keras dipulihkan (2..3) lewat env MTF_CONCURRENCY_CAP.
    const cap = Math.max(2, Math.min(3, Number(env.MTF_CONCURRENCY_CAP) || 3));
    const concurrency = Math.max(2, Math.min(cap, Number(env.MTF_CONCURRENCY ?? 3) || 3));
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const results = await scannerPool.runPool(
      symbols,
      async (s, idx) => {
        await sleep((idx % concurrency) * 200);
        return this.analyzeSymbolMtf(s, mode, true);
      },
      concurrency
    );
    results.forEach((r, idx) => {
      if (r.success && r.data?.usable) out.set(symbols[idx]!, r.data);
    });
    return out;
  }

  /** Rencana entry terbaik untuk 1 simbol pada harga live (dipakai loop entry). */
  // 30 Sep 2026 — refactor SCALP-only: evaluasi kini satu mode
  // dihapus. Selalu satu lane: SCALP.
  private async planForEntry(
    symbol: string,
    mode: "SCALP",
    price: number
  ): Promise<{ plan: StrategyPlan | null; analysis: MtfAnalysis | null; all: StrategyPlan[]; mode: "SCALP" }> {
    const analysis = getCachedMtf(symbol, mode, 90_000, Date.now()) ?? await this.analyzeSymbolMtfResilient(symbol, mode);
    const sel = analysis && analysis.usable
      ? await selectBestPlan({ analysis, price: price > 0 ? price : analysis.price, mode, mrv: await loadScalpMrvContext(symbol, allowedStrategiesFor(mode), (s, i, l) => binanceFuturesClient.fetchKlines(s, i, l)) }, Date.now(), allowedStrategiesFor(mode))
      : null;

    return { plan: sel?.plan ?? null, analysis: analysis ?? null, all: sel?.all ?? [], mode };
  }

  private async runMarketScannerCycle(): Promise<boolean> {
    try {
      // Kadens adaptif (T-5.50): makin banyak slot kosong, makin cepat full scan
      // berikutnya (40/35/30 dtk) supaya kandidat segar terus tersedia untuk
      // mengisi slot; tanpa slot kosong kadens kembali normal (hemat REST).
      // Di antara full scan, tryScan no-op murah (view segar, entry pakai analisis terakhir).
      const openBeforeScan = await db.position.count({ where: activePositionWhere() }).catch(() => this.lastOpenPositionsCount);
      const nowScan = Date.now();
      if (nowScan - this.lastFullScanAt < scanGateMsFor(Math.max(0, this.maxPositions - openBeforeScan))) return false;
      this.lastFullScanAt = nowScan;

      let pairs = binanceFuturesClient.getCachedPairs();
      if (!pairs || pairs.length === 0) {
        await binanceFuturesClient.fetchReal24hTickers();
        pairs = binanceFuturesClient.getCachedPairs();
      }

      // Lantai volume mengikuti VOLUME_MIN_USD dan berlaku strict-greater.
      const manualBlacklist = await this.loadManualBlacklist();
      const usdtPairs = pairs.filter(
        (p) => p.symbol.endsWith("USDT") && isPerpListed(p.symbol) !== false
      );
      // SCAN SEMUA PAIR ELIGIBLE (perintah operator 26 Sep 2026): tanpa potongan 50.
      // HANYA volume 24j DI ATAS lantai efektif (gate operator — strict).
      // Cap pengaman 200 simbol/siklus (universe kini ~117 eligible).
      const liquidPairs = usdtPairs
        .filter((p) => checkTradeVolume(p.vol24hUsd).allowed)
        // Penjaga kelas aset: komoditas/equity (mis. BZUSDT = Brent Oil) TIDAK
        // PERNAH masuk kandidat. Crypto-only, blacklist mengalahkan semua filter.
        // Termasuk blacklist manual operator (loadManualBlacklist).
        .filter((p) => {
          const check = checkAssetClass(p.symbol, manualBlacklist);
          if (check.blocked) {
            this.blockedAssetNotes.set(p.symbol, check.reason ?? "BLOCKED");
            return false;
          }
          return true;
        })
        .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
        .slice(0, 200);

      // Ambang PROGRESIF (28 Sep 2026): L0=45/0% -> L5=68/55%. Naik bertahap
      // saat bukti PAPER membaik; performa buruk menahan tetap eksplorasi.
      const openForScan = openBeforeScan;
      const progScan = await this.getProgressive();
      const scanFill = slotFillThresholds(Math.max(0, this.maxPositions - openForScan), this.maxPositions, progScan.level);
      const progT = progressiveThresholdsFor(progScan.level);

      if (liquidPairs.length === 0) return false;

      const symbols = liquidPairs.map((p) => p.symbol);

      // Scan strong gainers and losers in alternating rank order. This only
      // changes observation priority; real setup triggers and risk gates remain.
      const ranked = rankMoversBothDirections(liquidPairs);

      // ── MESIN SETUP: klines FRESH untuk window (tanpa cache basi), sisanya top-up
      // cache TAHAN-BAN <10 mnt. 24 pair teratas (paling bergerak) SELALU fresh +
      // 24 jendela ROTASI (cakupan penuh universe dalam ~3-5 siklus). Gagal fetch =
      // simbol dilewati / fallback cache — TIDAK PERNAH MTF_UNAVAILABLE massal lagi.
      // Jendela adaptif (T-5.50): 24 anchor fresh + rotasi 24; saat >=10 slot kosong rotasi +8.
      // Rotasi mengecualikan anchor agar permintaan REST tidak terbuang.
      const windowPlan = mtfWindowPlan(Math.max(0, this.maxPositions - openForScan), SETUP_ENGINE.mtfTopN);
      const freshTop = Math.min(windowPlan.freshTop, ranked.length);
      const rotating = windowPlan.rotating;
      const scalpWindow = selectRotatingTargets(ranked, this.mtfCursor, freshTop, rotating);
      this.mtfCursor = scalpWindow.nextCursor;
      const mtfSymbols = scalpWindow.targets.map((p) => p.symbol);
      const mtfMap = await this.warmMtfCache(mtfSymbols, "SCALP");
      // Top-up cache pendek untuk sisa ranked (0 REST); trigger 1m tidak boleh
      // berasal dari analisis lebih lama dari 90 dtk.
      let topUp = 0;
      for (const p of ranked) {
        if (mtfMap.has(p.symbol)) continue;
        try {
          const cached = getCachedMtf(p.symbol, "SCALP", 90_000, Date.now());
          if (cached) {
            mtfMap.set(p.symbol, cached);
            topUp++;
          }
        } catch {}
      }
      logger.info(
        { pairs: ranked.length, fresh: mtfSymbols.length, topUp, cursor: this.mtfCursor, analyzed: mtfMap.size, tf: getTimeframePlan("SCALP").summary, topN: windowPlan.width, scanGateMs: scanGateMsFor(Math.max(0, this.maxPositions - openForScan)) },
        "MTF_ANALYSIS_DONE"
      );
      // F3 RETRY PRIORITAS TOP-MOVER (perintah operator 26 Sep 2026): 10 pair
      // teratas TANPA MTF langsung dicoba ulang SEKALI sebelum scanCycle berjalan
      // (bukan menunggu siklus berikut). Murah saat di-ban (cooldown fast-fail).
      try {
        const missingTop = ranked
          .slice(0, 10)
          .map((p) => p.symbol)
          .filter((s) => !mtfMap.has(s));
        if (missingTop.length > 0) {
          const retry = await this.warmMtfCache(missingTop, "SCALP");
          let added = 0;
          retry.forEach((v, k) => {
            mtfMap.set(k, v);
            added++;
          });
          if (added > 0 || missingTop.length > 0) {
            logger.info({ missing: missingTop.length, recovered: added }, "MTF_RETRY_TOP");
          }
        }
      } catch {}
      this.lastMtfAnalyzedCount = mtfMap.size;

      const scanOutput = await scannerPool.scanCycle(symbols, "SCALP", async (sym: string): Promise<CandidateItem | null> => {
        const pair = ranked.find((p) => p.symbol === sym);
        if (!pair) return null;

        const absChg = Math.abs(pair.chg24h);
        const isBullish = pair.chg24h >= 0;
        // 13 Okt 2026 — GATE TOP-LOSER (operator): koin jatuh > 15%/24jam DILARANG
        // di-scan/di-trade (JCTUSDT -39.9% & USUSDT -37.6% lolos tanpa gate ini).
        const loserGate = loserDropAllowed(pair.chg24h);
        if (!loserGate.allowed) {
          logger.info({ symbol: sym, chg24h: pair.chg24h, why: loserGate.reason }, "SCAN_SKIP: LOSER_DROP_TOO_DEEP");
          return null;
        }
        const perf = performanceScore(absChg, pair.vol24hUsd);
        const perfBoost = Math.min(14, Math.round(perf));
        const liveHint = pair.markPrice > 0 ? pair.markPrice : pair.price;

        const mtf = mtfMap.get(sym);

        // Jalur A (utama): skor dari zona/trigger/bias klines nyata + rencana
        // strategi. SCALP dikunci ke allowlist (default hanya S-01 Squeeze Breakout).
        if (mtf && mtf.usable) {
          // 30 Sep 2026 — refactor SCALP-only: fallback mode lama di scan worker
          // dihapus (dulu mengambil 3 TF ekstra dari 50 worker -> burst REST).
          const sel = await selectBestPlan({ analysis: mtf, price: liveHint, mode: "SCALP", mrv: await loadScalpMrvContext(sym, allowedStrategiesFor("SCALP"), (s, i, l) => binanceFuturesClient.fetchKlines(s, i, l)) }, Date.now(), allowedStrategiesFor("SCALP"));
          const chosenMtf = mtf;
          const chosenMode: "SCALP" = "SCALP";

          const plan = sel.plan;
          // ANTI-SIDEWAYS (evaluateEligibility, FR-04): chop & ADX dari TF struktur
          // (0 REST tambahan — bar sudah ada di cache MTF). CHOP_HIGH / ADX_LOW =
          // kandidat TIDAK READY untuk semua strategi, termasuk S-01.
          const structBars = chosenMtf.structure?.barsData ?? chosenMtf.trigger?.barsData ?? [];
          const elig = evaluateEligibility(
            { symbol: sym, volume24hUsd: pair.vol24hUsd, klines: structBars },
            { minVolume24hUsd: getTradeVolumeFloor() }
          );
          const chopCheck = checkChopVeto(elig.metrics.choppiness, elig.metrics.adx, progScan.level);
          const chopBlocked = chopCheck.vetoed;
          const biasCheck = checkChopVeto(chosenMtf.bias.chop, chosenMtf.bias.adx, progScan.level);
          const biasSideways = isSidewaysBias({ mode: chosenMode,
            structureChop: elig.metrics.choppiness, structureAdx: elig.metrics.adx,
            structureAtrPct: chosenMtf.structure.atrPct,
            biasChop: chosenMtf.bias.chop, biasAdx: chosenMtf.bias.adx,
            biasTrend: chosenMtf.bias.trend, biasRegime: chosenMtf.bias.regime });
          // 29 Sep 2026 (perintah operator "gw ga mau trading di chart sideaways"):
          // sideways DILARANG di semua mode & level — hanya regime TRENDING
          // dengan bias berarah yang boleh jadi kandidat entry (VOLATILE
          // dikeluarkan 14 Okt 2026, Tahap A4).
          const biasPass = !biasCheck.vetoed && (!sidewaysEntryAllowed() ? !biasSideways
            : (progT.allowSidewaysReview || !biasSideways));
          const marketFit = checkModeMarketFit({ mode: chosenMode,
            structureChop: elig.metrics.choppiness, structureAdx: elig.metrics.adx,
            structureAtrPct: chosenMtf.structure.atrPct,
            biasChop: chosenMtf.bias.chop, biasAdx: chosenMtf.bias.adx,
            biasTrend: chosenMtf.bias.trend, biasRegime: chosenMtf.bias.regime }, undefined, progScan.level);
          // 14 Okt 2026 (Tahap A3 bug fix): volatilityGate memakai Volatility Shield
          // ASLI (ATR ratio > 2x baseline) — sebelumnya hardcoded true sehingga
          // shield tidak pernah memblokir kandidat di jalur scan ini.
          const volatilityShield = evaluateVolatilityShield(structBars);
          const gatesPass = {
            volumeGate: checkTradeVolume(pair.vol24hUsd).allowed,
            regimeGate: biasPass,
            trendGate: chosenMtf.trendScore >= 50,
            scoreGate: true,
            planGate: plan !== null,
            chopGate: !chopBlocked,
            volatilityGate: !volatilityShield.blockNewSignals,

          };
          // 14 Okt 2026 (Tahap A3 bug fix): trendGate & volatilityGate ikut
          // keputusan — sebelumnya dihitung tapi tidak dipakai (jalur mati).
          const allPass = marketFit.allowed && gatesPass.volumeGate && gatesPass.regimeGate && gatesPass.chopGate && gatesPass.planGate && gatesPass.trendGate && gatesPass.volatilityGate;
          // Big Brain Tahap B2/B3 (14 Okt 2026): fitur kualitas tren & struktur
          // volume — dihitung LOKAL dari bar cache (0 REST). Fitur saja (bukan
          // gate): mengalir ke DecisionLog untuk kalibrasi Tahap C.
          const er = calculateEfficiencyRatio(structBars);
          const vpProfile = buildVolumeProfile(structBars);
          const lastClose = structBars.length > 0 ? structBars[structBars.length - 1]!.close : null;
          const pocDistanceBins = lastClose !== null ? distanceFromPocInBins(vpProfile, lastClose) : null;
          // Big Brain Tahap B4: OI + beta-BTC — butuh REST (di-cache TTL).
          //
          // 24 Okt 2026 (BUG FIX kolom kosong di Live Market Scanner):
          // DULUNYA metric ini hanya diambil kalau `allPass` (semua gate lolos).
          // Di produksi hanya 2 dari 146 kandidat yang allPass, jadi 144 baris
          // SELALU punya oiChangePct=null + betaBtc=null dan UI menulis "—".
          // Operator butuh OI/BETA sebagai BUKTI PER SETIAP kandidat (bukan
          // hanya yang lolos gate) — persis seperti kolom ER/SMC/SQUEEZE.
          //
          //  Jadwal: OI di-cache TTL 5 menit per simbol; bar BTC di-cache 60
          //  detik dipakai bersama semua simbol. Endpoint OI resmi Binance
          //  (weight 1, tanpa API key) menerima permintaan ini tanpa
          //  key — sudah diverifikasi live (HTTP 200). Tidak ada env/API key
          //  baru yang dibutuhkan; kalau endpoint mati, status FETCH_FAILED
          //  tampil jujur (bukan angka tebakan).
          //
          //  PENTING (Golden Rule #5): OI/beta FITUR SAJA, bukan gate. Nilai
          //  tidak pernah memengaruhi keputusan entry.
          let oiChangePct: number | null = null;
          let betaBtc: number | null = null;
          let oiStatus: "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED" | null = null;
          let oiReason: string | null = null;
          let betaStatus: "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED" | null = null;
          let betaReason: string | null = null;
          try {
            const [oiRes, btcRef] = await Promise.all([
              fetchOpenInterestChangePct(sym, (p) => binanceFuturesClient.fetchPublic(p)),
              getBtcReferenceBars((s, i, l) => binanceFuturesClient.fetchKlines(s, i as "5m", l)),
            ]);
            oiChangePct = oiRes.value;
            oiStatus = oiRes.status;
            oiReason = oiRes.reason;
            const betaRes = calculateBetaBtc(structBars, btcRef.bars);
            betaBtc = betaRes.value;
            betaStatus = betaRes.status;
            betaReason = betaRes.reason;
          } catch (e) {
            // Fail-open: fitur persepsi tidak boleh menggagalkan scan.
            oiStatus = "FETCH_FAILED";
            oiReason = "OI_FETCH_FAILED";
            betaStatus = "FETCH_FAILED";
            betaReason = "BETA_FETCH_FAILED";
          }
          // KNN analog Lorentzian: probabilitas dari histori resolved (null bila <50 sampel).
          let knnProb: number | null = null;
          let knnN = 0;
          let knnLabel: string | null = null;
          try {
            const knnQ = defaultKnnLibrary.query(
              buildKnnFeatures({
                zoneScore: chosenMtf.zoneScore,
                triggerScore: chosenMtf.triggerScore,
                trendScore: chosenMtf.trendScore,
                adx: chosenMtf.bias.adx ?? chosenMtf.structure.adx ?? null,
                volume24hUsd: pair.vol24hUsd,
              }),
              chosenMode
            );
            knnProb = knnQ.knnProb;
            knnN = knnQ.knnN;
            knnLabel = knnQ.labelReason;
          } catch {}
          return {
            symbol: sym,
            score: chosenMtf.compositeScore,
            mode: chosenMode,
            regime: chosenMtf.bias.regime,
            zoneScore: chosenMtf.zoneScore,
            triggerScore: chosenMtf.triggerScore,
            trendScore: chosenMtf.trendScore,
            knnProb,
            knnN,
            knnLabel,
            gatesPass,
            status: allPass ? "READY" : "WAIT",
            rejectReason: allPass ? null : marketFit.reason ?? (!plan ? "NO_STRATEGY_PLAN" : "GATES_UNMET"),
            chop: elig.metrics.choppiness,
            chopAdx: elig.metrics.adx,
            structureAtrPct: chosenMtf.structure.atrPct,
            er,
            erStatus: er !== null ? "OK" : "INSUFFICIENT_SAMPLES",
            pocDistanceBins,
            oiChangePct,
            oiStatus,
            oiReason,
            betaBtc,
            betaStatus,
            betaReason,
            biasChop: chosenMtf.bias.chop,
            biasAdx: chosenMtf.bias.adx,
            biasTrend: chosenMtf.bias.trend,
            eligReasons: elig.reasons,
            strategyId: plan?.strategyId ?? null,
            strategyName: plan?.strategyName ?? null,
            entryType: plan?.entryType ?? null,
            plan,
            planCandidates: sel.all.map((p) => ({ strategyId: p.strategyId, matched: p.matched, quality: p.quality, reasons: p.reasons.slice(0, 4) })),
            zoneType: plan?.zoneType ?? chosenMtf.bestZone?.type ?? null,
            zoneTop: plan?.zoneTop ?? chosenMtf.bestZone?.top ?? null,
            zoneBottom: plan?.zoneBottom ?? chosenMtf.bestZone?.bottom ?? null,
            tfSummary: chosenMtf.tfSummary,
            mtfAnalyzed: true,
            mtfAnalyzedAt: chosenMtf.analyzedAt,
          };
        }

        // Jalur B (cadangan): tanpa klines/MTF tidak boleh membuka trade (WAIT) demi menjaga kualitas dan winrate > 57%
        const trendScore = Math.min(98, Math.max(30, Math.round(50 + pair.chg24h * 2.5 + (isBullish ? perfBoost * 0.3 : 0))));
        const zoneScore = Math.min(95, Math.max(45, Math.round(55 + (pair.vol24hUsd / 25_000_000) * 8 + (isBullish ? 8 : -4) + perfBoost * 0.4)));
        const triggerScore = Math.min(95, Math.max(40, Math.round(50 + (absChg > 4 ? 30 : absChg * 6) + perfBoost * 0.3)));

        const knnProb = null;
        const knnN = 0;
        // Jalur B = tanpa klines/MTF. Semua metrik persepsi honestly null
        // dengan status eksplisit (tidak ada bar = tidak ada bukti).
        const knnLabel = "KNN_POOL_NO_MTF";
        const erStatus = "NO_DATA" as const;
        const oiStatus = "NO_DATA" as const;
        const oiReason = "OI_NO_MTF";
        const betaStatus = "NO_DATA" as const;
        const betaReason = "BETA_NO_MTF";

        const compositeScore = Math.round(trendScore * 0.35 + zoneScore * 0.35 + triggerScore * 0.30);
        const regime = (absChg > 8 ? "VOLATILE" : absChg > 2 ? "TRENDING" : "RANGING") as string;

        const gatesPass = {
          volumeGate: checkTradeVolume(pair.vol24hUsd).allowed,
          regimeGate: true,
          trendGate: trendScore >= 50,
          scoreGate: compositeScore >= 70,
          planGate: false,
          chopGate: false, // Tanpa klines tidak ada bukti market bukan sideways.
          volatilityGate: false,
        };

        return {
          symbol: sym,
          score: compositeScore,
          mode: "SCALP",
          regime,
          zoneScore,
          triggerScore,
          trendScore,
          knnProb,
          knnN,
          knnLabel,
          gatesPass,
          status: "WAIT",
          rejectReason: "MTF_UNAVAILABLE",
          chop: null,
          chopAdx: null,
          structureAtrPct: null,
          er: null,
          erStatus,
          pocDistanceBins: null,
          oiChangePct: null,
          oiStatus,
          oiReason,
          betaBtc: null,
          betaStatus,
          betaReason,
          biasChop: null,
          biasAdx: null,
          biasTrend: "NEUTRAL",
          eligReasons: [],
          strategyId: null,
          strategyName: null,
          entryType: null,
          plan: null,
          planCandidates: [],
          zoneType: null,
          zoneTop: null,
          zoneBottom: null,
          tfSummary: "1m/5m/15m (heuristik ticker)",
          mtfAnalyzed: false,
          mtfAnalyzedAt: undefined,
        };
      });

      this.stats.totalScans++;

      const validCandidates = scanOutput.candidates.filter((c) => isEntryCandidateReady(c, scanFill, Date.now(), progScan.level));
      if (validCandidates.length > 0) {
        await scannerPool.persistCandidates(validCandidates.slice(0, 5));
      }

      // 30 Sep 2026 — refactor SCALP-only: jalur kedua sudah dihapus total.

      if (this.stats.totalScans % 4 === 1) {
        const top = validCandidates[0];
        await this.speak(
          "scanner-supervisor",
          `Siklus #${scanOutput.cycleId}: ${symbols.length} pair dipindai, ${validCandidates.length} kandidat lolos${top ? `, teratas ${top.symbol} skor ${top.score}` : ""}.`,
          `Siklus scanner #${scanOutput.cycleId} tuntas dalam ${scanOutput.durationMs}ms (P95 ${scanOutput.p95SymbolMs}ms). Memindai ${symbols.length} pair Binance Futures; ${validCandidates.length} kandidat siap.`,
          { cycleId: scanOutput.cycleId, candidates: validCandidates.length }
        );
      }
      return true;
    } catch (err) {
      throw err;
    }
  }

  // 30 Sep 2026 — refactor SCALP-only: jalur kedua (lane cadangan
  // dedikasi) DIHAPUS TOTAL. Slot kini murni diisi lane SCALP; sisa slot
  // ditangani rotasi target (`selectRotatingTargets`) + gate entry yang sama.

  private async evaluateAndExecuteTrades(): Promise<void> {
    // LOCK TUNGGAL: jalur siklus utama (step) & timer pengisi slot tidak boleh
    // mengisi bersamaan (dulu bisa -> posisi melebihi batas 20).
    this.releaseStaleLocks();
    if (this.isEntryRunning) return;
    this.isEntryRunning = true;
    this.entryLockStartedAt = Date.now();
    try {
      await this.fillSlotsOnce();
    } catch (err: any) {
      this.lastError = err?.message || String(err);
    } finally {
      this.isEntryRunning = false;
      this.entryLockStartedAt = 0;
    }
  }

  private async fillSlotsOnce(): Promise<void> {
    try {
      // 14 Okt 2026 (perintah operator: metode SWING): lane SCALP mati total —
      // satu-satunya pembuka posisi baru = funnel SWING (fillSwingSlots).
      // Supervisor posisi open tetap jalan (exit tidak terganggu).
      if (!scalpLaneEnabled()) return;
      const currentOpen = await db.position.count({ where: activePositionWhere() });
      if (currentOpen >= this.maxPositions) return;

      const guardStatus = await defaultDailyRiskGuard.evaluateStatus();
      if (!guardStatus.canTrade) return;
      // GOLDEN RULE #3: tidak ada order baru tanpa ARM eksplisit operator.
      // (BUG lama: bot tetap membuka posisi walau DISARMED.)
      if (!defaultDailyRiskGuard.isArmed()) return;
      // Equity real (bukan hardcode): modal awal + PnL kumulatif. Equity tipis => hemat margin.
      const equityUsd = Number((START_EQUITY_USD + guardStatus.cumulativePnlUsd).toFixed(2));

      const scanView = scannerPool.getScanView();
      if (!isFreshEntryScan(scanView.scan.refreshedAt)) {
        logger.info({ refreshedAt: scanView.scan.refreshedAt, emptySlots: this.maxPositions - currentOpen }, "FILL_SLOTS_WAIT_FRESH_SCAN");
        return;
      }
      // ===== KEBIJAKAN PROGRESIF (28 Sep 2026) =====
      // L0 longgar (LLM menilai semua) -> L5 ketat. Agen tetap yang menilai &
      // memutuskan; ambang naik bertahap saat bukti PAPER membaik.
      const emptySlots = Math.max(0, this.maxPositions - currentOpen);
      const prog = await this.getProgressive();
      const progT = progressiveThresholdsFor(prog.level);
      const fill = slotFillThresholds(emptySlots, this.maxPositions, prog.level);
      const budget = slotFillBudget(emptySlots);

      // Peta performa |chg| x volume untuk prioritas top performer (sekali per siklus).
      const moverRank = new Map(rankMoversBothDirections(binanceFuturesClient.getCachedPairs())
        .map((p, index) => [p.symbol, index] as const));
      const perfBySymbol = new Map(
        binanceFuturesClient.getCachedPairs().map((p) => [p.symbol, performanceScore(Math.abs(p.chg24h), p.vol24hUsd)] as const)
      );

      const topCandidates = [...scanView.candidates]
        .filter((c) => isAgentReviewCandidate(c, emptySlots, Date.now(), prog.level))
        .sort((a, b) => {
          // Fokus tombol JALANKAN BOT: pair pilihan operator dinilai pertama
          // (tetap wajib lolos semua gate di bawah — tanpa jalan pintas).
          if (this.focusSymbol) {
            if (a.symbol === this.focusSymbol && b.symbol !== this.focusSymbol) return -1;
            if (b.symbol === this.focusSymbol && a.symbol !== this.focusSymbol) return 1;
          }
          // Interleave the two mover directions before score breaks ties.
          const ra = moverRank.get(a.symbol) ?? Number.MAX_SAFE_INTEGER;
          const rb = moverRank.get(b.symbol) ?? Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          // Mode mix and hard setup/risk gates still run below.
          const pa = perfBySymbol.get(a.symbol) ?? 0;
          const pb = perfBySymbol.get(b.symbol) ?? 0;
          if (pb !== pa) return pb - pa;
          return (b.plan?.quality ?? b.score) - (a.plan?.quality ?? a.score);
        });
      // Reset kuota putusan LLM per siklus isi-slot (hemat budget bulanan).
      this.judgeCallsThisCycle = 0;

      if (emptySlots > 0) {
        logger.info(
          { currentOpen, emptySlots, budget, tier: fill.tier, progLevel: prog.level, progN: prog.n, progWr: prog.wr, progEx: prog.ex, strictMinScore: fill.minScore, reviewMinScore: agentReviewScoreFloor(emptySlots, prog.level), candidates: topCandidates.length, candidatesTotal: scanView.candidates.length },
          "FILL_SLOTS_START"
        );
        await this.speak(
          "scanner-supervisor",
          `Slot kosong ${emptySlots}/${this.maxPositions}. Progresif L${prog.level} (${prog.n} trade, WR ${prog.wr === null ? "-" : (prog.wr * 100).toFixed(1) + "%"}): Arka menilai kandidat MTF skor>=${agentReviewScoreFloor(emptySlots, prog.level)}; safety tetap aktif. ${topCandidates.length} kandidat masuk review.`,
          `ISI SLOT ${fill.tier} PROGRESIF L${prog.level}: ${emptySlots}/${this.maxPositions} kosong — review skor>=${agentReviewScoreFloor(emptySlots, prog.level)}, lunak READY>=${fill.minScore}; ${topCandidates.length} kandidat lanjut ke agen. ${progT.directive}`,
          { emptySlots, tier: fill.tier, progLevel: prog.level, candidates: topCandidates.length, reviewMinScore: agentReviewScoreFloor(emptySlots, prog.level), strictMinScore: fill.minScore },
          { throttleMs: 60000 }
        );
      }

      if (topCandidates.length === 0 || budget === 0) return;

      const existingPositions = await db.position.findMany({
        where: activePositionWhere(),
        select: { symbol: true, marginUsd: true, mode: true },
      });
      const existingSymbols = new Set(existingPositions.map((p) => p.symbol));
      // 30 Sep 2026 — refactor SCALP-only: hanya lane SCALP yang dihitung.
      // 13 Okt 2026: hitung dua-lane (SCALP vs SWING S-05) — data cap global.
      const swingExistingCount = countPositionsByMode(existingPositions).SWING;
      const modeCounts: ModeCounts = {
        SCALP: existingPositions.length - swingExistingCount,
        SWING: swingExistingCount,
      };
      const plannedCounts: ModeCounts = { ...modeCounts };
      // 30 Sep 2026 — refactor SCALP-only: tidak ada mix lane; seluruh 20 slot
      // diperebutkan kandidat SCALP (prioritizeTradingLanes kini pass-through).
      const orderedCandidates = prioritizeTradingLanes(topCandidates, modeCounts, this.maxPositions);
      // ── SATU TRADE PER PAIR (perintah operator 25 Sep 2026 — FINAL) ──
      // Operator: "kalau mau entry pair yang sama harus terselesaikan dulu trade-nya,
      //  baru bisa entry lagi... kalau di dalam 20 posisi ada double entry kan aneh."
      // Jadi TIDAK ADA toleransi waktu: pair yang posisinya sudah dibuka (belum CLOSED)
      // DILEWATI sampai trade-nya selesai. 20 slot = 20 pair berbeda.
      // `entryOncePerPair` mencatat pair yang dibuka di sesi ini; entry-nya dirilis saat
      // supervise mendeteksi posisi pair itu sudah CLOSED.
      // Pemulihan setelah restart: seed dari posisi OPEN yang ada di DB.
      for (const sym of existingSymbols) entryOncePerPair.mark(sym);
      // Margin terpakai LIVE: bertambah setiap posisi baru dibuka di siklus ini.
      let usedMarginLive = existingPositions.reduce((a, p: any) => a + (p.marginUsd || 0), 0);
      let openedThisCycle = 0;

      // Coba kandidat berurutan; buka sampai budget siklus tercapai (isi slot).
      // FASE A (murah, sekuensial): cek live + guard deterministik + makro cache.
      // FASE B (mahal, PARALEL): putusan LLM Arka. FASE C (sekuensial): order.
      interface JudgeQueueItem {
        candidate: CandidateItem;
        side: "LONG" | "SHORT";
        mode: "SCALP";
        policy: ReturnType<typeof resolveMarginPolicy>;
        macro: MacroGateCheck;
        macroOverridden: boolean;
        strictMarketAllowed: boolean;
        pairMeta: { vol24hUsd: number; fundingRate: number } | undefined;
        lessons: string[];
      }
      const judgeQueue: JudgeQueueItem[] = [];
      for (const candidate of orderedCandidates) {
        if (openedThisCycle >= budget) break;
        if (!canOpenTradingLane(candidate.mode, plannedCounts, this.maxPositions)) continue;
        // Verifikasi LIVE sebelum tiap entry: batas 20 posisi TIDAK BOLEH terlewati
        // (dulu sempat 21/20 karena dua jalur pengisian berjalan bersamaan).
        const liveOpen = await db.position.count({ where: activePositionWhere() });
        if (liveOpen >= this.maxPositions) break;
        // LAPIS 2 anti-double-entry di titik terakhir sebelum order: cek LIVE ke DB
        // (bukan cache) supaya tidak ada celah antara siklus/timer pengisi slot.
        const liveDup = await db.position.count({ where: { ...activePositionWhere(), symbol: candidate.symbol } });
        const redundancy = checkPairRedundancy(liveDup);
        if (redundancy.blocked) {
          logger.info({ symbol: candidate.symbol, openForSymbol: liveDup }, "ENTRY_SKIP: DUPLICATE_SYMBOL_OPEN");
          continue;
        }
        if (existingSymbols.has(candidate.symbol)) continue;

        // Cooldown re-entry pasca-CLOSE (kedua sisi, semua jenis close) - cegah double-loss
        // (perintah operator 2 Okt 2026): pair yang baru saja ditutup (SL/TP/BE/TREND_FLIP,
        // apa pun) tidak boleh di-entry lagi (sisi apa pun) selama REENTRY_COOLDOWN_MS.
        if (postCloseReentryCooldown.isBlocked(candidate.symbol)) {
          logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: POST_CLOSE_REENTRY_COOLDOWN");
          await this.speak(
            "risk-officer",
            `Lewati ${candidate.symbol}: pair ini baru saja ditutup; cooldown re-entry 60 menit masih jalan untuk mencegah double-loss.`,
            `ENTRY ${candidate.symbol} DITOLAK (cooldown pasca-close): pair ini baru ditutup dan masih dalam masa tunggu re-entry 60 menit (kedua sisi). Menunggu cooldown habis sebelum entry baru.`,
            { symbol: candidate.symbol, reason: "POST_CLOSE_REENTRY_COOLDOWN" },
            { throttleMs: 120000 }
          );
          continue;
        }
        // 11 Okt 2026 — cooldown pasca-LOSS global 15 menit (audit 5 Whys: 15/15 trade
        // ber-kesalahan entry <15m setelah loss). SEMUA simbol; event-based (bukan filter jam).
        if (env.LOSS_COOLDOWN_ENABLED && lossCooldownGuard.isBlocked()) {
          logger.info({ symbol: candidate.symbol, sinceLossMin: lossCooldownGuard.sinceLossMin(), remainingMin: Math.ceil(lossCooldownGuard.remainingMs() / 60_000) }, "ENTRY_SKIP: LOSS_COOLDOWN");
          await this.speak(
            "risk-officer",
            `Lewati ${candidate.symbol}: pasca-loss/SL masih cooldown; sisa ${Math.ceil(lossCooldownGuard.remainingMs() / 60_000)} menit (loss 15 menit semua simbol, SL 60 menit — aturan operator 13 Okt).`,
            `ENTRY ${candidate.symbol} DITOLAK (cooldown pasca-loss/SL): sisa ${Math.ceil(lossCooldownGuard.remainingMs() / 60_000)} menit. Aturan: loss non-SL 15 menit semua simbol; close SL membekukan semua simbol 60 menit (perintah operator 13 Okt 2026).`,
            { symbol: candidate.symbol, reason: "LOSS_COOLDOWN" },
            { throttleMs: 120000 }
          );
          continue;
        }

        // Probation simbol anti-churn (keputusan operator 4 Okt 2026): simbol dengan
        // 3 loss BERUNTUN diblokir dari entry baru (kedua sisi) selama 45 menit.
        // Bukti kebutuhan: AINUSDT 9 entry (-$4.0), BRUSDT 7x, ONEUSDT 7x dalam 1 run.
        if (symbolProbation.isBlocked(candidate.symbol)) {
          logger.info({ symbol: candidate.symbol, remainingMs: symbolProbation.remainingMs(candidate.symbol) }, "ENTRY_SKIP: SYMBOL_PROBATION");
          await this.speak(
            "risk-officer",
            `Lewati ${candidate.symbol}: simbol ini kena probation setelah 3 loss beruntun; blokir 45 menit masih jalan.`,
            `ENTRY ${candidate.symbol} DITOLAK (probation anti-churn): 3 loss beruntun terdeteksi pada simbol ini. Entry kedua sisi diblokir 45 menit supaya tidak mengulang kerugian di simbol yang sedang tidak cocok.`,
            { symbol: candidate.symbol, reason: "SYMBOL_PROBATION" },
            { throttleMs: 120000 }
          );
          continue;
        }

        // Cooldown SISI-SEARAH pasca TREND_FLIP (perintah operator 28 Sep 2026):
        // pasangan yang baru ditutup TREND_FLIP tidak boleh di-entry lagi dengan
        // ARAH YANG SAMA selama TREND_FLIP_SIDE_COOLDOWN_MS — itu pengulangan
        // kesalahan yang sama. Arah LAWAN tetap diizinkan (tetap wajib lolos
        // semua gate di bawah: strategi match, makro, Arka, Wardha, dsb).
        const candidateSide = candidate.plan?.side ?? (candidate.trendScore >= 50 ? "LONG" : "SHORT");
        if (trendFlipSideCooldown.isBlocked(candidate.symbol, candidateSide)) {
          logger.info({ symbol: candidate.symbol, side: candidateSide }, "ENTRY_SKIP: TREND_FLIP_SIDE_COOLDOWN");
          await this.speak(
            "risk-officer",
            `Lewati ${candidate.symbol} ${candidateSide}: pair ini baru ditutup TREND_FLIP; cooldown arah yang sama masih jalan. Arah lawan tetap dipertimbangkan normal.`,
            `ENTRY ${candidate.symbol} DITOLAK (cooldown pasca-TREND_FLIP): arah ${candidateSide} yang sama baru saja ditutup paksa. Menunggu cooldown sebelum mengulang arah yang sama.`,
            { symbol: candidate.symbol, side: candidateSide, reason: "TREND_FLIP_SIDE_COOLDOWN" },
            { throttleMs: 120000 }
          );
          continue;
        }

        // Kandidat yang baru dinilai agen tidak diubah menjadi GO deterministik
        // saat cooldown; giliran ini diberikan kepada pair valid berikutnya.
        if (emptySlots <= 0 && Date.now() - (this.lastJudgeAt.get(candidate.symbol) ?? 0) < 15_000) continue;

        // SATU TRADE PER PAIR: pair yang sudah dibuka (belum CLOSED) tidak boleh di-entry lagi.
        // Tidak ada toleransi waktu — entry ulang HANYA setelah trade-nya selesai.
        if (entryOncePerPair.isBlocked(candidate.symbol)) {
          logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: PAIR_TRADE_BELUM_SELESAI");
          await this.speak(
            "risk-officer",
            `Lewati ${candidate.symbol}: trade pair ini belum selesai. Tidak ada double entry — tunggu TP/SL dulu.`,
            `ENTRY ${candidate.symbol} DILEWATI (satu trade per pair): posisi pair ini masih berjalan / belum dirilis. Bot akan memilih pair lain dari 20 slot yang tersedia.`,
            { symbol: candidate.symbol, reason: "PAIR_TRADE_BELUM_SELESAI" },
            { throttleMs: 120000 }
          );
          continue;
        }

        // LAPIS 2 penjaga kelas aset: walau lolos scanner, non-crypto tetap DITOLAK.
        // Blacklist manual operator ikut diperiksa (SELALU menang, Rules §1.8).
        // LAPIS 2b ONLY FUTURES: di luar allowlist PERPETUAL (spot/delivery) = TOLAK.
        const assetCheck = checkAssetClass(candidate.symbol, await this.loadManualBlacklist());
        const perpOk = isPerpListed(candidate.symbol) !== false;
        if (assetCheck.blocked) {
          await this.speak(
            "universe-curator",
            `Tolak ${candidate.symbol}: kelas aset ${assetCheck.assetClass} (${assetCheck.reason}). Hanya crypto yang boleh ditradingkan.`,
            `Kandidat ${candidate.symbol} DITOLAK oleh penjaga kelas aset: ${assetCheck.reason}. Sistem hanya trading pair crypto.`,
            { symbol: candidate.symbol, assetClass: assetCheck.assetClass, reason: assetCheck.reason },
            { throttleMs: 120000 }
          );
          continue;
        }
        if (!perpOk) {
          logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: NON_PERPETUAL");
          await this.speak(
            "universe-curator",
            `Tolak ${candidate.symbol}: bukan futures PERPETUAL (spot/delivery). Hanya pair Binance Futures.`,
            `Kandidat ${candidate.symbol} DITOLAK (NON_PERPETUAL): di luar allowlist PERPETUAL exchangeInfo.`,
            { symbol: candidate.symbol, reason: "NON_PERPETUAL" },
            { throttleMs: 120000 }
          );
          continue;
        }
        // GATE VOLUME OPERATOR: bot hanya pair dengan volume futures 24h di atas configured floor.
        // Dicek ulang dari data pair live sesaat sebelum order (bukan hanya saat scan),
        // supaya pair yang volumenya anjlok / tak terdata tetap DITOLAK. Tanpa kecuali.
        const pairMeta = binanceFuturesClient.getCachedPairs().find((p) => p.symbol === candidate.symbol);
        const volGate = checkTradeVolume(pairMeta?.vol24hUsd);
        if (!volGate.allowed) {
          logger.info({ symbol: candidate.symbol, volumeUsd: volGate.volumeUsd, minVolumeUsd: volGate.minVolumeUsd }, "ENTRY_SKIP: VOLUME_BELOW_MIN");
          await this.speak(
            "risk-officer",
            `Tolak ${candidate.symbol}: ${volGate.reason}. Ambang futures 24h $${volGate.minVolumeUsd.toLocaleString("en-US")} berlaku strict-greater.`,
            `Entry ${candidate.symbol} DITOLAK (gate volume operator): ${volGate.reason}.`,
            { symbol: candidate.symbol, reason: "VOLUME_BELOW_MIN", volumeUsd: volGate.volumeUsd, minVolumeUsd: volGate.minVolumeUsd },
            { throttleMs: 120000 }
          );
          continue;
        }
        // PROGRESIF: borderline masuk review Arka; status strict disampaikan
        // sebagai BORDERLINE_REVIEW agar LLM menimbang, bukan veto buta.
        const strictEntryMarket = checkModeMarketFit({ mode: candidate.mode,
          structureChop: candidate.chop, structureAdx: candidate.chopAdx,
          structureAtrPct: candidate.structureAtrPct,
          biasChop: candidate.biasChop, biasAdx: candidate.biasAdx,
          biasTrend: candidate.biasTrend, biasRegime: candidate.regime }, undefined, prog.level);
        const reviewEntryMarket = checkAgentReviewMarketFit({ mode: candidate.mode,
          structureChop: candidate.chop, structureAdx: candidate.chopAdx,
          structureAtrPct: candidate.structureAtrPct,
          biasChop: candidate.biasChop, biasAdx: candidate.biasAdx,
          biasTrend: candidate.biasTrend, biasRegime: candidate.regime }, undefined, prog.level);
        if (!reviewEntryMarket.allowed) {
          const chopReason = reviewEntryMarket.reason ?? "MARKET_FILTER_FAILED";
          logger.info({ symbol: candidate.symbol, mode: candidate.mode, reason: chopReason,
            chop: candidate.chop, adx: candidate.chopAdx, atrPct: candidate.structureAtrPct }, "ENTRY_SKIP: MARKET_FILTER");
          await this.speak(
            "risk-officer",
            `Tolak ${candidate.symbol} ${candidate.mode}: ${chopReason}. Menunggu tren dan volatilitas sesuai mode.`,
            `Entry ${candidate.symbol} DITOLAK (${chopReason}): Choppiness ${candidate.chop ?? "n/a"} / ADX ${candidate.chopAdx ?? "n/a"} / ATR% ${candidate.structureAtrPct ?? "n/a"}.`,
            { symbol: candidate.symbol, reason: chopReason, chop: candidate.chop, adx: candidate.chopAdx, atrPct: candidate.structureAtrPct },
            { throttleMs: 120000 }
          );
          continue;
        }
        let side: "LONG" | "SHORT" = candidate.plan?.side ?? (candidate.trendScore >= 50 ? "LONG" : "SHORT");
        // 30 Sep 2026 — refactor SCALP-only: SEMUA kandidat dievaluasi di lane
        // SCALP. Fallback label mode lama (skor<80) dihapus agar tidak pernah ada
        // planForEntry(mode lain) dengan allowlist kosong -> NO_STRATEGY_MATCH.
        let mode: "SCALP" = "SCALP";

        const policy = resolveMarginPolicy({ mode, equityUsd, score: candidate.score, seed: candidate.symbol });
        if (!policy.allowed) {
          await this.speak(
            "risk-officer",
            `Tahan ${candidate.symbol} ${mode}: ${policy.reason}. Equity $${equityUsd} saya lindungi dulu.`,
            `Entry ${candidate.symbol} (${mode}) DITAHAN: ${policy.reason}. Equity $${equityUsd} dilindungi dari margin besar/liquidation.`,
            { symbol: candidate.symbol, mode, equityUsd, reason: policy.reason },
            { throttleMs: 60000 }
          );
          continue;
        }
        // Anti-liquidation tingkat akun: total margin + rencana < 70% equity.
        const level = checkMarginLevel(equityUsd, usedMarginLive + policy.marginUsd);
        if (!level.allowed) {
          await this.speak(
            "risk-officer",
            `Tahan ${candidate.symbol}: margin terpakai sudah ${(level.usedPct * 100).toFixed(0)}% equity. Tunggu slot bebas, jangan paksakan entry.`,
            `Entry ${candidate.symbol} (${mode}) DITAHAN: MARGIN_LEVEL_GUARD — margin terpakai $${usedMarginLive.toFixed(2)} + rencana $${policy.marginUsd.toFixed(2)} = ${(level.usedPct * 100).toFixed(0)}% equity. Menunggu slot bebas agar jauh dari liquidation.`,
            { symbol: candidate.symbol, mode, equityUsd, usedMarginUsd: usedMarginLive, reason: level.reason },
            { throttleMs: 60000 }
          );
          continue;
        }

      // ===== MAKRO CHECK (VEGA) — konteks untuk Arka =====
      // PROGRESIF L0-L1: gagal macro tetap boleh direview LLM (override eksplorasi,
      // PAPER-only, risiko $1). L2+: gagal macro = tahan, menunggu rezim selaras.
      const macro = await this.checkMacroGate(candidate.symbol, side);
      let macroOverridden = false;
      if (!macro.allowed) {
        if (progT.allowMacroOverride) {
          macroOverridden = true;
          logger.info({ symbol: candidate.symbol, side, detail: macro.detail, progLevel: prog.level }, "MACRO_OVERRIDE_EXPLORATION: lanjut ke review LLM");
        } else {
          await this.speak(
            "macro-scout",
            `Tahan ${candidate.symbol} ${side}: ${macro.detail}. Rezim makro belum mendukung.`,
            `Entry ${candidate.symbol} ${side} DITAHAN Vega: ${macro.detail}. Menunggu rezim makro selaras.`,
            { symbol: candidate.symbol, side, allowed: false, detail: macro.detail },
            { throttleMs: 45000 }
          );
          continue;
        }
      }

      // ===== FASE A SELESAI: antre untuk keputusan LLM paralel (maks 12) =====
      // Loop murah di atas (DB counts, guard deterministik, makro cache) jalan
      // sekuensial; putusan LLM yang lambat (detik per panggilan) dijalankan
      // PARALEL di Fase B agar pengisian 20 slot tidak merangkak.
      if (judgeQueue.length >= MAX_JUDGE_QUEUE_PER_CYCLE) break;
      const lessons = await this.getRecentLessons(candidate.symbol);
      judgeQueue.push({ candidate, side, mode, policy, macro, macroOverridden, strictMarketAllowed: strictEntryMarket.allowed, pairMeta, lessons });
      plannedCounts[mode]++;
    }

    // ===== FASE B: KEPUTUSAN LLM PARALEL (atau deterministik saat outage) =====
    // Outage (streak>=5, mis. provider 402): vonis deterministik skipLlm agar
    // screening tetap bisa entry; berlabel DETERMINISTIC_GO_NO_LLM dan pulih
    // otomatis saat LLM menjawab lagi. Safety plan/margin/macro/harga tetap penuh.
    // Probe pemulihan: tiap 6 siklus, coba LLM lagi (gagal 402 itu cepat/murah).
    // Bila provider pulih, streak reset dan vonis LLM kembali penuh.
    // PAPER-ONLY: di mode LIVE verdict LLM tetap wajib (fail-closed), tidak ada
    // fallback tak-billionaire — perintah operator hanya untuk simulasi PAPER.
    const outageDeterministic = this.llmFailStreak >= AutonomousTradingBot.LLM_OUTAGE_STREAK &&
      env.DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE &&
      env.BINANCE_EXECUTION_MODE === "PAPER" &&
      !(this.llmOutageActive() && this.cycleCount % 6 === 0);
    if (this.llmOutageActive() && !outageDeterministic && env.BINANCE_EXECUTION_MODE !== "PAPER" && judgeQueue.length > 0) {
      logger.warn({ failStreak: this.llmFailStreak, mode: env.BINANCE_EXECUTION_MODE }, "LLM_OUTAGE_LIVE_FAIL_CLOSED");
    }
    if (outageDeterministic && judgeQueue.length > 0 && Date.now() - this.llmOutageNotifiedAt > 300_000) {
      this.llmOutageNotifiedAt = Date.now();
      logger.warn({ failStreak: this.llmFailStreak, lastFailure: this.lastLlmFailure, queue: judgeQueue.length }, "LLM_OUTAGE_DETERMINISTIC_MODE");
      await this.speak(
        "risk-officer",
        `LLM provider outage (${this.lastLlmFailure ?? "gagal"} x${this.llmFailStreak}). Saya ambil alih vonis deterministik L${prog.level} agar screening tetap entry; semua safety plan/margin/makro tetap aktif.`,
        `LLM OUTAGE: ${judgeQueue.length} kandidat dinilai deterministik (provider ${this.lastLlmFailure ?? "gagal"}). Pulih otomatis saat LLM menjawab.`,
        { failStreak: this.llmFailStreak, lastFailure: this.lastLlmFailure, progLevel: prog.level },
        { throttleMs: 300000 }
      );
    }
    const nowJudgeB = Date.now();
    for (const item of judgeQueue) this.lastJudgeAt.set(item.candidate.symbol, nowJudgeB);
    // T-04: veto NO-GO ber-TTL. Penolakan Arka DIINGAT selama jendela waktu,
    // supaya kandidat yang sama tidak mendapat GO deterministik beberapa menit
    // setelah ditolak (temuan audit 26 Sep 2026 baris 304).
    const judgeable = judgeQueue.filter((item) => {
      const key = decisionVeto.keyOf({ symbol: item.candidate.symbol, strategyId: String(item.candidate.strategyId ?? ""), side: item.side });
      if (!decisionVeto.isBlocked(key)) return true;
      logger.info(
        { symbol: item.candidate.symbol, side: item.side, strategyId: item.candidate.strategyId, reason: decisionVeto.reasonFor(key) },
        "ENTRY_SKIP: AGENT_VETO_ACTIVE"
      );
      return false;
    });
    // BAGIAN 3 (24 Okt 2026): ambil mikrostruktur & order flow sekali per siklus,
    // lalu bagikan ke semua kandidat. Fail-open: null bila error.
    let cycleMicrostructure: Awaited<ReturnType<typeof gatherMarketContextSnapshot>>["microstructure_and_flow"] | null = null;
    try {
      const intelSnap = await gatherMarketContextSnapshot();
      cycleMicrostructure = intelSnap.microstructure_and_flow;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "MICROSTRUCTURE_FETCH_FAIL_OPEN");
    }
    const judged = await Promise.all(
      judgeable.map(async (item) => {
        const vega = item.macro.observation
          ? await defaultResearchLayer.observeAltMatrix({ symbol: item.candidate.symbol,
            side: item.side, ...item.macro.observation,
            macroAllowed: item.macro.allowed, macroDetail: item.macro.detail })
          : null;
        // -- MENU SL/TP DETERMINISTIK (Opsi 2 Hybrid): Arka memilih ID varian;
        // seluruh angka tetap milik kode. Menu dari plan deterministik kandidat.
        const slTpMenu = item.candidate.plan
          ? buildSlTpMenu(item.candidate.plan.entryPrice, item.side,
              { slPrice: item.candidate.plan.slPrice, slAtrPct: item.candidate.plan.slAtrPct ?? null,
                strategyId: item.candidate.plan.strategyId },
              item.mode)
          : null;
        const judgeRes = await defaultDecisionRiskLayer.runSetupJudge({
          symbol: item.candidate.symbol,
          side: item.side,
          mode: item.mode,
          zoneScore: item.candidate.zoneScore,
          triggerScore: item.candidate.triggerScore,
          knnProb: item.candidate.knnProb ?? null,
          compositeScore: item.candidate.score,
          regime: item.candidate.regime,
          strategyId: item.candidate.strategyId,
          strategyName: item.candidate.strategyName,
          slPct: item.candidate.plan?.slPct,
          entryPrice: item.candidate.plan?.entryPrice,
          slPrice: item.candidate.plan?.slPrice,
          tp1Price: item.candidate.plan?.tp1Price,
          slTpMenu,
          minScore: agentReviewScoreFloor(emptySlots, prog.level),
          minKnn: fill.minKnn,
          emptySlots,
          maxPositions: this.maxPositions,
          progressiveLevel: prog.level,
          allowExplorationGo: progT.allowExplorationGo,
          explorationMinConfidence: progT.explorationMinConfidence,
          macroDetail: `${item.macro.detail}${item.macroOverridden ? " (MACRO_OVERRIDE_EXPLORATION L" + prog.level + ": Vega FAIL tapi LLM boleh menilai; GO hanya bila konfluensi pair sangat meyakinkan)" : ""}${item.strictMarketAllowed ? "" : " (STRICT_MARKET BORDERLINE: chop/ADX/regime di bawah standar ketat — timbang risiko sideways)"}`,
          macroObserverText: vega?.dialog.text ?? null,
          macroAllowed: item.macro.allowed || item.macroOverridden,
          strategyEvidence: item.candidate.plan?.reasons ?? [],
          structureAdx: item.candidate.chopAdx,
          structureChop: item.candidate.chop,
          biasAdx: item.candidate.biasAdx,
          biasChop: item.candidate.biasChop,
          structureAtrPct: item.candidate.structureAtrPct,
          // Big Brain B2/B3/B4: fitur persepsi untuk DecisionLog.
          trendScore: item.candidate.trendScore,
          er: item.candidate.er,
          pocDistanceBins: item.candidate.pocDistanceBins,
          oiChangePct: item.candidate.oiChangePct,
          betaBtc: item.candidate.betaBtc,
          volumeUsd: item.pairMeta?.vol24hUsd ?? null,
          fundingRate: item.pairMeta?.fundingRate ?? null,
          lessons: item.lessons,
          marketFilterStatus: (() => {
            const strict = checkModeMarketFit({ mode: item.candidate.mode,
              structureChop: item.candidate.chop, structureAdx: item.candidate.chopAdx,
              structureAtrPct: item.candidate.structureAtrPct,
              biasChop: item.candidate.biasChop, biasAdx: item.candidate.biasAdx,
              biasTrend: item.candidate.biasTrend, biasRegime: item.candidate.regime }, undefined, prog.level);
            return strict.allowed ? `PASS (L${prog.level})` : `BORDERLINE_REVIEW L${prog.level} (strict ${strict.reason ?? "filter"})`;
          })(),
          skipLlm: outageDeterministic,
          outageFallback: outageDeterministic,
          // PAPER-only (perintah operator 30 Sep 2026): gate deterministik yang
          // menentukan verdict saat LLM menolak setup yang sebenarnya lolos skor.
          // Di LIVE di-nol-kan agar verdict LLM tetap wajib (fail-closed).
          paperDeterministicEntry: env.PAPER_DETERMINISTIC_ENTRY && env.BINANCE_EXECUTION_MODE === "PAPER",
          // BAGIAN 3 (24 Okt 2026): mikrostruktur & order flow untuk Arka.
          microstructure: cycleMicrostructure,
        });
        return { item, judgeRes };
      })
    );
    for (const { item, judgeRes } of judged) {
      // Streak outage: reset saat LLM menjawab, tambah saat gagal (termasuk
      // mode deterministik — streak menahan mode sampai LLM benar-benar pulih).
      if (judgeRes.byLlm) {
        if (this.llmFailStreak >= AutonomousTradingBot.LLM_OUTAGE_STREAK) {
          logger.info({ symbol: item.candidate.symbol }, "LLM_RECOVERED_FROM_OUTAGE");
        }
        this.llmFailStreak = 0;
        this.lastLlmFailure = null;
        this.judgeCallsThisCycle++;
      } else {
        this.llmFailStreak++;
        this.lastLlmFailure = judgeRes.reason?.slice(0, 80) ?? "UNKNOWN";
        this.lastJudgeAt.set(item.candidate.symbol, Date.now() - 150_000); // retry technical failure after 30s, not 3m
      }
      if (judgeRes.verdict !== "GO") {
        if (judgeRes.byLlm) {
          decisionVeto.recordNoGo(
            decisionVeto.keyOf({ symbol: item.candidate.symbol, strategyId: String(item.candidate.strategyId ?? ""), side: item.side }),
            judgeRes.reason?.slice(0, 200) ?? "NO-GO"
          );
        }
        logger.info(
          { symbol: item.candidate.symbol, score: item.candidate.score, knn: item.candidate.knnProb, verdict: judgeRes.verdict, byLlm: judgeRes.byLlm, reason: judgeRes.reason },
          "ENTRY_SKIP: judge NO-GO"
        );
      }
    }

    // ===== FASE C: EKSEKUSI SEQUENSIAL (cek live + order — urutan menentukan) =====
    for (const { item, judgeRes } of judged) {
      if (judgeRes.verdict !== "GO") continue;
      const { candidate, policy, pairMeta } = item;
      const rejectEntry = (reason: string, detail = "") => {
        this.lastEntryRejection = { symbol: candidate.symbol, reason, detail, at: new Date().toISOString() };
      };
      let { side, mode } = item;
      if (openedThisCycle >= budget) break;
      // Verifikasi LIVE ulang sesaat sebelum order (keadaan bisa berubah selama Fase B).
      const liveOpen = await db.position.count({ where: activePositionWhere() });
      if (liveOpen >= this.maxPositions) break;
      // 30 Sep 2026 — refactor SCALP-only: kapasitas tunggal = total posisi OPEN.
      // 13 Okt 2026: dua-lane — hitung posisi S-05 terpisah untuk cap global.
      const liveCounts: ModeCounts = {
        SCALP: liveOpen - swingExistingCount,
        SWING: swingExistingCount,
      };
      // 30 Sep 2026 — refactor SCALP-only: kapasitas tunggal (tidak ada plafon
      // mix lagi, sebelumnya bug plafon 12/20 -> MODE_CAP_REACHED).
      if (!canOpenTradingLane(mode, liveCounts, this.maxPositions)) {
        logger.info({ symbol: candidate.symbol, mode, liveCounts }, "ENTRY_SKIP: MODE_CAP_REACHED");
        continue;
      }
      const currentEmptySlots = this.maxPositions - liveOpen;
      // 13 Okt 2026 — GATE TOP-LOSER (jaring terakhir sebelum order): koin jatuh
      // > 15%/24jam TIDAK BOLEH entry, walau lolos scan/judge.
      const entryLoserGate = loserDropAllowed(
        binanceFuturesClient.getCachedPairs().find((p) => p.symbol === candidate.symbol)?.chg24h,
      );
      if (!entryLoserGate.allowed) {
        rejectEntry(entryLoserGate.reason ?? "LOSER_DROP_TOO_DEEP");
        logger.info({ symbol: candidate.symbol, why: entryLoserGate.reason }, "ENTRY_SKIP: LOSER_DROP_TOO_DEEP");
        continue;
      }
      if (!isFreshEntryScan(scannerPool.getScanView().scan.refreshedAt) ||
          !isAgentReviewCandidate(candidate, currentEmptySlots, Date.now(), prog.level) ||
          !checkTradeVolume(binanceFuturesClient.getCachedPairs().find((p) => p.symbol === candidate.symbol)?.vol24hUsd).allowed) {
        rejectEntry("SCAN_OR_FILTER_STALE_AFTER_JUDGE");
        logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: SCAN_OR_FILTER_STALE_AFTER_JUDGE");
        continue;
      }
      const liveDup = await db.position.count({ where: { ...activePositionWhere(), symbol: candidate.symbol } });
      if (checkPairRedundancy(liveDup).blocked) {
        logger.info({ symbol: candidate.symbol, openForSymbol: liveDup }, "ENTRY_SKIP: DUPLICATE_SYMBOL_OPEN");
        continue;
      }
      if (existingSymbols.has(candidate.symbol) || entryOncePerPair.isBlocked(candidate.symbol)) {
        logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: PAIR_TRADE_BELUM_SELESAI");
        continue;
      }
      // Cooldown sisi-searah pasca TREND_FLIP juga berlaku di pemeriksaan akhir
      // sebelum order (keputusan judge bisa basi beberapa detik).
      if (trendFlipSideCooldown.isBlocked(candidate.symbol, side)) {
        logger.info({ symbol: candidate.symbol, side }, "ENTRY_SKIP: TREND_FLIP_SIDE_COOLDOWN");
        rejectEntry("TREND_FLIP_SIDE_COOLDOWN", `arah ${side} yang sama baru ditutup TREND_FLIP; cooldown belum habis`);
        continue;
      }
      // Cooldown re-entry pasca-CLOSE juga berlaku di pemeriksaan akhir sebelum order.
      if (postCloseReentryCooldown.isBlocked(candidate.symbol)) {
        logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: POST_CLOSE_REENTRY_COOLDOWN");
        rejectEntry("POST_CLOSE_REENTRY_COOLDOWN", `pair ini baru ditutup; cooldown re-entry 60 menit (kedua sisi) belum habis`);
        continue;
      }
      // 11 Okt 2026 — cooldown pasca-LOSS global 15 menit (audit 5 Whys 15/15) juga dicek
      // di pemeriksaan akhir (jaring kedua sebelum seam pra-order di plannedEntry).
      if (env.LOSS_COOLDOWN_ENABLED && lossCooldownGuard.isBlocked()) {
        logger.info({ symbol: candidate.symbol, sinceLossMin: lossCooldownGuard.sinceLossMin() }, "ENTRY_SKIP: LOSS_COOLDOWN");
        rejectEntry("LOSS_COOLDOWN", `pasca-loss/SL masih cooldown; sisa ${Math.ceil(lossCooldownGuard.remainingMs() / 60_000)} menit (loss 15m semua simbol, SL 60m)`);
        continue;
      }
      const finalMacro = await this.checkMacroGate(candidate.symbol, side);
      if (!finalMacro.allowed && !(progT.allowMacroOverride && item.macroOverridden)) {
        rejectEntry("MACRO_CHANGED_AFTER_JUDGE", finalMacro.detail);
        logger.info({ symbol: candidate.symbol, reason: finalMacro.detail }, "ENTRY_SKIP: MACRO_CHANGED_AFTER_JUDGE");
        continue;
      }
      if (!finalMacro.allowed && item.macroOverridden) {
        logger.info({ symbol: candidate.symbol, progLevel: prog.level }, "MACRO_OVERRIDE_EXPLORATION: order lanjut walau macro FAIL (PAPER, risiko $1)");
      }
      await this.speak(
        "setup-judge",
        `GO ${candidate.symbol} ${side}: ${judgeRes.reason}`,
        `Arka GO ${candidate.symbol} (${side} ${mode}): ${judgeRes.reason}`,
        { symbol: candidate.symbol, side, mode, verdict: "GO", byLlm: judgeRes.byLlm, reason: judgeRes.reason },
        { throttleMs: 45000 }
      );

      const ticker = await binanceFuturesClient.fetchSymbolTicker(candidate.symbol);
      // WAJIB harga live Binance Futures (bukan seed/fallback): cegah entry basi.
      if (!ticker || ticker.markPrice <= 0 || !binanceFuturesClient.isPriceLive(candidate.symbol)) {
        rejectEntry("PRICE_NOT_LIVE");
        await this.speak(
          "risk-officer",
          `Batalkan ${candidate.symbol}: harga live putus. Entry basi sama dengan judi; tunggu chart pulih.`,
          `Entry ${candidate.symbol} DIBATALKAN: harga live tidak tersedia (basi/terputus). Menunggu chart real-time pulih.`,
          { symbol: candidate.symbol, reason: "PRICE_NOT_LIVE" },
          { throttleMs: 60000 }
        );
        continue;
      }
      const entryPrice = ticker.markPrice;

      // Progressive review may relax scores, but never fabricates an entry:
      // a concrete trigger from one of the five active strategies must match.
      const setupPlan = await this.planForEntry(candidate.symbol, mode, entryPrice);
      let p = setupPlan.plan;
      if (!p) {
        const why = setupPlan.analysis ? setupPlan.analysis.reason ?? "TIDAK_ADA_STRATEGI_MATCH" : "MTF_TIDAK_TERSEDIA";
        rejectEntry("NO_STRATEGY_MATCH", why);
        logger.info({ symbol: candidate.symbol, mode, why, progLevel: prog.level, plans: setupPlan.all.map((p) => `${p.strategyId}:${p.matched ? "OK" : p.reasons[0]}`) }, "ENTRY_SKIP: NO_STRATEGY_MATCH");
        await this.speak(
          "setup-judge",
          `Tolak ${candidate.symbol}: tidak ada strategi aktif (S-02, RSW-01/02/03) yang match pada harga live. Kualitas diutamakan.`,
          `Entry ${candidate.symbol} DITOLAK Arka: tidak ada strategi kuantitatif aktif S-01/S-02/S-03/S-04/S-05 yang match dengan zona dan struktur market pada harga live.`,
          { symbol: candidate.symbol, reason: "NO_STRATEGY_MATCH" },
          { throttleMs: 60000 }
        );
        continue;
      }
      // -- MENU SL/TP DETERMINISTIK (Opsi 2 Hybrid, 2 Okt 2026): Arka memilih ID
      // varian, kode menetapkan semua angka. Fail-safe: pilihan tak valid atau LLM
      // outage -> plan default deterministik (SL A / TP A). Angka LLM tidak pernah
      // masuk plan; hanya ID yang dibaca.
      const slTpMenu = buildSlTpMenu(entryPrice, p.side, p, p.mode);
      const applied = applySlTpChoice(p, slTpMenu, judgeRes.slChoice ?? null, judgeRes.tpChoice ?? null);
      p = applied.plan;
      if (applied.fellBack) {
        logger.info({ symbol: candidate.symbol, judgeSl: judgeRes.slChoice ?? null, judgeTp: judgeRes.tpChoice ?? null,
          slId: applied.slId, tpId: applied.tpId }, "ENTRY_MENU_FALLBACK_DEFAULT");
      } else {
        logger.info({ symbol: candidate.symbol, slId: applied.slId, tpId: applied.tpId,
          slPrice: p.slPrice, tp1Price: p.tp1Price }, "ENTRY_MENU_CHOICE");
      }
      if (p.side !== side || p.mode !== mode) { rejectEntry("SETUP_CHANGED_AFTER_JUDGE"); continue; }
      // Analisis diulang setelah verdict LLM. Jangan gunakan ADX/CHOP dari scan
      // lama bila struktur market telah berubah sebelum order dikirim.
      const finalAnalysis = setupPlan.analysis;
      if (!finalAnalysis?.usable) { rejectEntry("FINAL_MTF_UNAVAILABLE"); continue; }
      const finalBars = finalAnalysis.structure?.barsData ?? finalAnalysis.trigger?.barsData ?? [];
      const finalEligibility = evaluateEligibility(
        { symbol: candidate.symbol, volume24hUsd: pairMeta?.vol24hUsd ?? 0, klines: finalBars },
        { minVolume24hUsd: getTradeVolumeFloor() }
      );
      const finalMarket = checkModeMarketFit({ mode,
        structureChop: finalEligibility.metrics.choppiness, structureAdx: finalEligibility.metrics.adx,
        structureAtrPct: finalAnalysis.structure.atrPct,
        biasChop: finalAnalysis.bias.chop, biasAdx: finalAnalysis.bias.adx,
        biasTrend: finalAnalysis.bias.trend, biasRegime: finalAnalysis.bias.regime }, undefined, prog.level);
      const finalReviewMarket = checkAgentReviewMarketFit({ mode,
        structureChop: finalEligibility.metrics.choppiness, structureAdx: finalEligibility.metrics.adx,
        structureAtrPct: finalAnalysis.structure.atrPct,
        biasChop: finalAnalysis.bias.chop, biasAdx: finalAnalysis.bias.adx,
        biasTrend: finalAnalysis.bias.trend, biasRegime: finalAnalysis.bias.regime }, undefined, prog.level);
      if (!finalMarket.allowed && !finalReviewMarket.allowed) {
        rejectEntry("MARKET_FILTER_AFTER_JUDGE", finalReviewMarket.reason ?? finalMarket.reason ?? "");
        logger.info({ symbol: candidate.symbol, mode, reason: finalReviewMarket.reason ?? finalMarket.reason,
          chop: finalEligibility.metrics.choppiness, adx: finalEligibility.metrics.adx,
          biasChop: finalAnalysis.bias.chop, biasAdx: finalAnalysis.bias.adx,
          atrPct: finalAnalysis.structure.atrPct },
        "ENTRY_SKIP: MARKET_FILTER_AFTER_JUDGE");
        continue;
      }
      side = p.side;
      mode = p.mode;
      const strategyId = p.strategyId;
      const strategyName = p.strategyName;
      const entryType = p.entryType;
      const zoneType = p.zoneType;
      const zoneTop = p.zoneTop;
      const zoneBottom = p.zoneBottom;
      // T-13 (FAS A, keputusan operator 4 Okt 2026): S-01 SHORT dikunci
      // (data 72 trade: WR 38,9% EV -0,170R). Guard kebijakan — bukan tuning.
      // 21 Okt 2026 (Phase 4c): saklar env dihapus, kunci jadi permanen.
      if (isStrategySideLocked(strategyId, side)) {
        rejectEntry("S03_SHORT_LOCKED");
        logger.info({ symbol: candidate.symbol, strategyId, side }, "ENTRY_SKIP: S03_SHORT_LOCKED");
        continue;
      }
      const symbolRulesRow = await db.symbol.findUnique({ where: { symbol: candidate.symbol } });
      const maxLeverage = symbolRulesRow?.maxLeverage ?? 25;
      const leverageUpdatedAt = symbolRulesRow?.maxLeverageUpdatedAt?.getTime() ?? Date.now();
      const minNotional = symbolRulesRow?.minNotional ?? 5;
      const tickSize = symbolRulesRow?.tickSize ?? 0.0001;
      const stepSize = symbolRulesRow?.stepSize ?? 0.001;
      if (false) {
        rejectEntry("LEVERAGE_NOT_FOUND");
        logger.info({ symbol: candidate.symbol }, "ENTRY_SKIP: LEVERAGE_NOT_FOUND");
        continue;
      }
      const targetRiskUsd = policy.targetRiskUsd;
      const riskPlanInput = {
        symbol: candidate.symbol, mode, strategyId, side, entryPrice, slPrice: p.slPrice,
        tp1Price: p.tp1Price, tp1ROverride: p.tp1ROverride, equityUsd, targetRiskUsd,
        // RR klasik: 1R loss = $1 (dan boleh $1 lebih sedikit sesuai stepSize lot),
        // profit SCALP 1.5R pada risiko $0.60 = $0.90+.
        riskBudgetMode: "GROSS" as const,
        allowStepOverhang: true,
        slippageBps: 0,
        leverageTarget: policy.leverage,
        marginMode: (env.MARGIN_MODE === "ISOLATED" ? "ISOLATED" : "CROSS") as "CROSS" | "ISOLATED",
        maxMarginUsd: maxMarginForMode(),
        marginCapPct: equityUsd < 180 ? 0.25 : 0.4,
        symbolRules: {
          symbol: candidate.symbol, minNotional,
          tickSize, stepSize,
          maxLeverage,
          leverageUpdatedAt,
          isBlacklisted: symbolRulesRow?.isBlacklisted ?? false,
        },
      };
      const finalPlan = calculateOrderPlan(riskPlanInput);
      if (!finalPlan.allowed) {
        rejectEntry("FINAL_RISK_PLAN_REJECTED", finalPlan.rejectReason ?? "UNKNOWN_RISK_REJECTION");
        logger.info({ symbol: candidate.symbol, reason: finalPlan.rejectReason ?? "UNKNOWN_RISK_REJECTION" }, "ENTRY_SKIP: final risk plan rejected");
        continue;
      }
      const { slPrice, tp1Price: tp1Final, qty, notionalUsd: notional, marginUsd, leverage } = finalPlan;
      const distPct = finalPlan.slDistancePct;

      // 27 Okt 2026 (permintaan operator): AI Council di FUNNEL ENTRY SCALP —
      // hanya kandidat yang SIAP dieksekusi yang di-vote 3 agen. Fail-closed:
      // veto/timeout = entry ditahan. Bukti di EventLog COUNCIL_DECISION.
      if (env.ENABLE_AI_COUNCIL) {
        const { runPreEntryCouncil } = await import("../agents/councilEngine.js");
        const councilGate = await runPreEntryCouncil({
          symbol: candidate.symbol, side, mode, strategyId,
          entryPrice, slPrice, tpPrice: tp1Final,
          regimeInfo: finalAnalysis.bias?.regime ?? "UNKNOWN",
          technicalScore: p.quality,
        });
        if (!councilGate.approved) {
          rejectEntry("COUNCIL_REJECTED", String(councilGate.decision.summaryNarrative ?? "").slice(0, 200));
          logger.info({ symbol: candidate.symbol, reason: councilGate.decision.summaryNarrative }, "ENTRY_SKIP: council REJECTED");
          continue;
        }
      }

      const riskRes = await defaultDecisionRiskLayer.runRiskOfficer({
        symbol: candidate.symbol,
        side,
        entryPrice,
        slPrice,
        equityUsd,
        targetRiskUsd,
        leverageTarget: leverage,
        maxLeverageSnapshot: maxLeverage,
        finalPlan,
        emptySlots: Math.max(0, this.maxPositions - (currentOpen + openedThisCycle)),
        maxPositions: this.maxPositions,
        // Outage: Wardha deterministik (semua hard gate angka tetap dicek TS,
        // hanya komentar LLM yang dilewati) agar entry tidak mati total saat 402.
        skipLlm: outageDeterministic,
      });

      if (!riskRes.approved) {
        rejectEntry("RISK_OFFICER_REJECTED", riskRes.reason);
        logger.info({ symbol: candidate.symbol, slPct: distPct, entryPrice, slPrice, equityUsd, targetRiskUsd, byLlm: riskRes.byLlm, reason: riskRes.reason }, "ENTRY_SKIP: risk officer REJECTED");
        continue;
      }

      let newPos;
      try {
        // T-01 (4 Okt 2026): snapshot atribut trigger & kondisi market — pencatatan
        // saja untuk analisis bucket (tools/analyze-entry-attrs.ts); bukan keputusan.
        const entryAttrs = buildEntryAttrs({
          strategyId, side, quality: p.quality,
          biasAligned: finalAnalysis.biasAligned ?? null,
          reasons: p.reasons, bars: finalBars,
        });
        const opened = await executePlannedEntry(riskPlanInput, {
          mode, source: "AI", strategyId, strategyName, entryType, zoneType, zoneTop, zoneBottom,
          entryAttrs,
          outlookText: `Setup ${strategyId} ${side} ${mode}`,
        });
        newPos = opened.position;
        // Big Brain B1 (14 Okt 2026): hubungkan keputusan judge dengan posisi
        // nyata -> JOIN kalibrasi DecisionLog↔Trade bisa jalan. Fail-open.
        await linkDecisionToPosition(judgeRes.decisionLogId ?? null, newPos.id);
      } catch (error) {
        rejectEntry("FINAL_ACCOUNT_OR_FILL_CHECK", (error as Error).message);
        logger.info({ symbol: candidate.symbol, reason: (error as Error).message }, "ENTRY_SKIP: final account/fill check");
        continue;
      }

      // SATU TRADE PER PAIR: tandai pair ini terpakai sampai trade-nya CLOSED.
      entryOncePerPair.mark(candidate.symbol);

      // KNN: simpan fitur entry (resolusi win/loss dicatat saat close di learning loop).
      try {
        if (pairMeta && Number.isFinite(pairMeta.vol24hUsd)) this.pendingKnn.set(newPos.id, {
          features: buildKnnFeatures({
            zoneScore: candidate.zoneScore,
            triggerScore: candidate.triggerScore,
            trendScore: candidate.trendScore,
            adx: candidate.chopAdx,
            volume24hUsd: pairMeta?.vol24hUsd ?? null, // 30 Sep 2026: volume pair nyata agar volRatio bermakna
          }),
          symbol: candidate.symbol.toUpperCase(),
          mode: "SCALP",
        });
      } catch {}

      this.stats.tradesOpened++;

      // ENTRY PERTAMA (perintah operator 30 Sep 2026): catat satu kali sebagai
      // bukti bot benar-benar mengisi slot, dengan baris log ringkas + dialog agen.
      // Spek `speak` di bawah ini tidak memanggil LLM selama slot belum penuh
      // (short-circuit), jadi tidak menambah beban kuota.
      if (!this.firstEntry) {
        this.firstEntry = { at: Date.now(), symbol: candidate.symbol, side, mode, strategyId };
        const filled = currentOpen + openedThisCycle + 1;
        logger.info(
          { symbol: candidate.symbol, side, mode, strategyId, entryPrice, score: candidate.score, filledSlots: filled, target: this.maxPositions },
          "FIRST_ENTRY_FILLED"
        );
        await this.speak(
          "trade-supervisor",
          `ENTRY PERTAMA terisi: ${candidate.symbol} ${side} ${mode} di $${entryPrice.toFixed(4)} via ${strategyId} (skor ${candidate.score}). Slot ${filled}/${this.maxPositions}.`,
          `Entry pertama berhasil: ${candidate.symbol} ${side} ${mode} via ${strategyId}. Slot ${filled}/${this.maxPositions}.`,
          { symbol: candidate.symbol, strategyId, firstEntry: true, filledSlots: filled },
          { throttleMs: 0 }
        );
      }

      // Suara asli Arka & Wardha dari panggilan LLM mereka (bukan template bot).
      await this.logAgentDialog(
        "setup-judge",
        judgeRes.dialog.text || `GO untuk ${candidate.symbol}: skor ${candidate.score}.`,
        { symbol: candidate.symbol, score: candidate.score, verdict: "GO", mode, byLlm: judgeRes.byLlm }
      );

      await this.logAgentDialog(
        "risk-officer",
        riskRes.dialog.text || `Setuju ${candidate.symbol}: margin $${marginUsd.toFixed(2)}, risiko $${targetRiskUsd.toFixed(2)}.`,
        { symbol: candidate.symbol, marginUsd, riskUsd: targetRiskUsd, mode, equityUsd, byLlm: riskRes.byLlm }
      );

      await this.speak(
        "trade-supervisor",
        `Posisi #${newPos.id} ${candidate.symbol} ${side} ${mode} terbuka di $${entryPrice.toFixed(4)}, margin $${marginUsd.toFixed(2)}. Slot terisi ${currentOpen + openedThisCycle + 1}/${this.maxPositions}.`,
        `Posisi #${newPos.id} (${candidate.symbol} ${side} ${mode}) aktif terbuka di $${entryPrice.toFixed(4)}. Supervisi berjalan; SL statis. Slot ${currentOpen + openedThisCycle + 1}/${this.maxPositions}.`,
        { positionId: newPos.id, symbol: candidate.symbol, entryPrice, mode, filledSlots: currentOpen + openedThisCycle + 1 }
      );

      // Slot terisi -> lanjut kandidat berikutnya selama masih ada slot & budget siklus.
      openedThisCycle++;
      this.lastOpenPositionsCount = liveOpen + 1;
      existingSymbols.add(candidate.symbol);
      usedMarginLive += marginUsd;
      continue;
      }
    } catch (err: any) {
      // Jangan telan error diam-diam: laporkan ke /api/bot/status.lastError.
      this.lastError = `FILL_SLOTS: ${err?.message || String(err)}`;
      logger.warn({ err: err?.message, stack: err?.stack?.slice(0, 400) }, "Gagal mengisi slot (fillSlotsOnce)");
    }
  }

  // Gate makro deterministik (FR-05/FR-06). Data hilang berarti tidak ada bukti
  // arah yang cukup untuk entry, termasuk saat slot kosong.
  /**
   * Pelajaran jurnal untuk dimakan Arka sebelum memutuskan: utamakan milik simbol
   * yang sama, bila kosong pakai pelajaran terbaru lintas pair. Format ringkas 1 baris.
   */
  private async getRecentLessons(symbol: string): Promise<string[]> {
    try {
      const rows = await prismaLearningRepo.findRecentLessons(symbol, 3);
      // 12 Okt 2026 (perintah operator "terapkan di setiap new trade agar bisa
      // continue learning looping"): lesson TIDAK hanya per-symbol. Loss terakhir
      // lintas symbol ikut dibawa ke judge entry baru — kasus CKB/JCT harus
      // jadi pelajaran juga untuk koin lain.
      const globalRows = await db.learningEntry.findMany({
        where: {
          tradeId: { not: null },
          outcome: { startsWith: "LOSS" },
          trade: { is: { symbol: { not: symbol.toUpperCase() } } },
        },
        include: { trade: { select: { symbol: true } } },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      const globalLessons = globalRows
        .map((r) => {
          const lesson = (r.lesson ?? "").trim();
          const core = lesson || r.narrative.trim().slice(0, 160);
          if (!core) return "";
          return `[GLOBAL/${r.trade?.symbol ?? "?"}/${r.causeCode}] ${core}`;
        })
        .filter(Boolean);
      return [...rows
        .map((r) => {
          const lesson = (r.lesson ?? "").trim();
          const core = lesson || r.narrative.trim().slice(0, 160);
          if (!core) return "";
          return `[${r.outcome}/${r.causeCode}] ${core}`;
        })
        .filter(Boolean), ...globalLessons];
    } catch {
      return [];
    }
  }

  /** Snapshot makro 1h (BTC/ETH/BTC.D) cache 60 dtk: 3 klines/menit, bukan 3/kandidat. */
  private macroSnapshotCache: { at: number; btcK: unknown; ethK: unknown; domK: unknown } | null = null;

  private async getMacroKlines(): Promise<{ btcK: unknown; ethK: unknown; domK: unknown }> {
    const nowMs = Date.now();
    if (this.macroSnapshotCache && nowMs - this.macroSnapshotCache.at < 60_000) {
      return this.macroSnapshotCache;
    }
    const [btcK, ethK, domK] = await Promise.all([
      binanceFuturesClient.fetchKlines("BTCUSDT", "1h", MACRO_KLINE_LIMIT),
      binanceFuturesClient.fetchKlines("ETHUSDT", "1h", MACRO_KLINE_LIMIT),
      binanceFuturesClient.fetchKlines("BTCDOMUSDT", "1h", MACRO_KLINE_LIMIT),
    ]);
    this.macroSnapshotCache = { at: nowMs, btcK, ethK, domK };
    return this.macroSnapshotCache;
  }

  private async checkMacroGate(symbol: string, side: "LONG" | "SHORT"): Promise<MacroGateCheck> {
    try {
      const { btcK, ethK, domK } = await this.getMacroKlines();
      const toBars = (k: unknown): Bar[] =>
        (Array.isArray(k) ? k : [])
          .map((b: any) => ({
            openTime: Number(b[0]),
            open: Number(b[1]),
            high: Number(b[2]),
            low: Number(b[3]),
            close: Number(b[4]),
            volume: Number(b[5]),
          }))
          .filter((b) => Number.isFinite(b.close) && b.close > 0);
      const snap = { btcBars1h: toBars(btcK), ethBars1h: toBars(ethK), btcdomBars1h: toBars(domK) };
      if (snap.btcBars1h.length < 2 || snap.ethBars1h.length < 2 ||
          (symbol.toUpperCase() !== "BTCUSDT" && snap.btcdomBars1h.length < 2)) {
        return { allowed: false, detail: "MACRO_DATA_INSUFFICIENT" };
      }
      const res = evaluateMacroGate(symbol, side, snap);
      if (!res.pass && symbol.toUpperCase() === "BTCUSDT") {
        return { allowed: false, detail: res.blockedReasons.join(" | ") };
      }
      // Matriks dominansi operator (BTC.D x BTC + konfirmasi ETH) untuk alt.
      // BTC sendiri dikecualikan dari blokir arah matriks.
      if (symbol.toUpperCase() !== "BTCUSDT" && snap.btcdomBars1h.length >= 2) {
        const matrix = evaluateAltMatrix(
          calculate1hChangePct(snap.btcdomBars1h),
          calculate1hChangePct(snap.btcBars1h),
          calculate1hChangePct(snap.ethBars1h)
        );
        const sideBlocked =
          (side === "LONG" && !matrix.allowLongAlt) || (side === "SHORT" && !matrix.allowShortAlt);
        const tag = `MATRIX_R${matrix.row}_${matrix.bias} (BTC.D ${matrix.note})`;
        // Matrix tercatat dalam observasi Vega tanpa memblokir setup trending alt.
        return {
          allowed: true,
          detail: `BTC ${res.btc.regime} ${res.btc.trendDirection} ADX ${res.btc.adx} + ${tag}`,
          observation: { btcTrend: `${res.btc.regime} ${res.btc.trendDirection}`,
            btcAdx: res.btc.adx, btc1hChgPct: res.btc.chg1hPct,
            eth1hChgPct: res.eth.chg1hPct, btcDomChg1hPct: res.btcDom.chg1hPct,
            matrix },
        };
      }
      const detail =
        `BTC ${res.btc.regime} ${res.btc.trendDirection} ADX ${res.btc.adx}, ` +
        `ETH ${res.eth.trendDirection}, BTC.D ${res.btcDom.chg1hPct}%`;
      return { allowed: true, detail };
    } catch {
      return { allowed: false, detail: "MACRO_FETCH_FAILED" };
    }
  }

  private async logAgentDialog(agentId: string, text: string, context?: Record<string, unknown>): Promise<void> {
    const agent = ALL_12_AGENTS[agentId];
    if (!agent) return;
    try {
      await db.eventLog.create({
        data: {
          type: "AGENT_DIALOG",
          severity: "info",
          payload: JSON.stringify({
            agentId: agent.id,
            name: agent.name,
            text,
            timestamp: new Date().toISOString(),
            context: context || {},
          }),
        },
      });
    } catch {}
  }

  // Bicara bebas Bahasa Indonesia: agen merangkai kalimatnya sendiri dari fakta
  // (singkat padat on-point, tanpa emoji). Fallback = teks template bila LLM gagal.
  // throttleMs mencegah agen yang sama mengulang tiap siklus.
  private async speak(
    agentId: string,
    facts: string,
    fallback: string,
    context?: Record<string, unknown>,
    opts?: { throttleMs?: number }
  ): Promise<void> {
    const agent = ALL_12_AGENTS[agentId];
    if (!agent) {
      await this.logAgentDialog(agentId, fallback, context);
      return;
    }
    const waitMs = opts?.throttleMs ?? 0;
    if (waitMs > 0) {
      const last = this.lastSpokeAt.get(agentId) ?? 0;
      if (Date.now() - last < waitMs) return;
      this.lastSpokeAt.set(agentId, Date.now());
    }
    let text = fallback;
    // Operational counts must remain exact; rewriting them with an LLM once
    // changed "20 empty" into "20 full" and delayed the entry loop.
    if (agentId === "scanner-supervisor" || agentId === "setup-judge" || agentId === "trade-supervisor" || this.lastOpenPositionsCount < this.maxPositions) {
      // The decision layer already logged Arka's exact verdict. A second
      // creative paraphrase once turned a GO into a visible NO-GO message.
      await this.logAgentDialog(agentId, agentId === "scanner-supervisor" ? facts : fallback,
        { ...context, byLlm: false });
      return;
    }
    try {
      // BAGIAN 3: agen pencerita (Kirana) & agen lain yang bicara lewat
      // speak() menerima blok mikrostruktur & order flow live (5 modul).
      // Fail-open: string kosong bila hub belum siap — perilaku tidak berubah.
      const micro = await buildMicrostructurePromptBlock("BTC");
      const res = await defaultLlmAdapter.callFast(
        `Fakta: ${facts}\n${micro ? `${micro}\n` : ""}Sampaikan dalam 1-2 kalimat Bahasa Indonesia. Singkat, padat, on-point, tanpa emoji.`,
        `Kamu ${agent.name}, ${agent.role} di tim trading Private Trade AI. Kepribadian: ${agent.personality}. Gaya bicaramu: ${agent.style}.`
      );
      if (res.content.trim()) text = res.content.trim();
    } catch {
      // Fallback template + tercatat di llmFallbackStats.
    }
    await this.logAgentDialog(agentId, text, context);
  }

}

export const autonomousTradingBot = new AutonomousTradingBot();
