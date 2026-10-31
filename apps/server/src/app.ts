// Private Trade AI - Express app (NFR-04).
// Respons TIDAK PERNAH memuat nilai secret (FR-35: hanya status SET/MISSING).
import express from "express";
import researchSwingCatalog from "./strategies/researchSwingCatalog.json" with { type: "json" };
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { leverageWatcher } from "./universe/leverageWatcher.js";
import { scannerPool } from "./scanner/scannerPool.js";

import { backtestRepo, type BacktestRunOutput, STRATEGY_CATALOG, DEFAULT_FEE_STRUCTURE, type StrategyMode, type FeeStructure } from "./backtest/backtestEngine.js";
import { defaultMarketsService } from "./markets/marketsService.js";
import { binanceFuturesClient } from "./markets/binanceFuturesClient.js";
import { liquidationHub } from "./marketdata/liquidationHub.js";
import { gatherMarketContextSnapshot } from "./agents/marketIntel.js";
import { marketSweep } from "./agents/marketSweep.js";
import { gatherPositionOverlays } from "./exec/positionOverlay.js";
import { getTvSignal } from "./marketdata/tvSignal.js";
import { AUTO_STOP_GAP_BPS, calculateOrderPlan, checkMarginLevel, maxMarginForMode, resolveMarginPolicy, START_EQUITY_USD, SymbolRiskRules } from "./risk/riskEngine.js";
import { checkPairRedundancy, checkTradeVolume, getTradingStyle } from "./exec/slotFillPolicy.js";
import { checkAssetClass, isPerpListed, perpUniverseCount } from "./universe/assetClassGuard.js";
import { prismaUniverseRepo } from "./universe/universeManager.js";
import { defaultDailyRiskGuard, MAX_OPEN_POSITIONS } from "./risk/dailyGuard.js";
import { defaultOrderExecutor } from "./exec/orderExecutor.js";
import { executePlannedEntry } from "./exec/plannedEntry.js";
import { defaultPositionSupervisor, estimateCrossLiqPrice } from "./exec/positionSupervisor.js";
import { defaultPositionReconciler } from "./exec/reconciler.js";
import { SCALP_TIMEFRAMES, SWING_TIMEFRAMES } from "./config/timeframes.js";
import { SETUP_ENGINE } from "./config/setupEngine.js";
import { STRATEGY_NAMES, STRATEGY_SPECS, canonicalStrategyKey, strategyDisplayName } from "./strategies/strategyCatalog.js";
import { allowedStrategiesFor } from "./exec/slotFillPolicy.js";
import { runDisarmedCycle } from "./exec/disarmedCycle.js";
import { defaultLlmAdapter } from "./agents/llmAdapter.js";
import { defaultResearchLayer, RESEARCH_AGENTS } from "./agents/researchLayer.js";
import { defaultDecisionRiskLayer, DECISION_AGENTS } from "./agents/decisionRiskLayer.js";
import { defaultSupervisorWatchdogLayer, SUPERVISOR_WATCHDOG_AGENTS } from "./agents/supervisorWatchdogLayer.js";
import { defaultAgentManager, ALL_12_AGENTS } from "./agents/agentCatalog.js";
import { dedupeLearningEntries, defaultPostMortemEvaluator } from "./learning/postMortemEvaluator.js";
import { defaultStrategyTuner } from "./learning/strategyTuner.js";
import { logResearchFinding, listResearchFindings, decideResearchFinding, type ExperimentType, type FindingVerdict } from "./learning/researchFinding.js";
import { defaultSwingEvaluationLoop } from "./learning/swingEvalLoop.js";
import { SWING_EVAL_STRATEGIES, ARCHIVED_SWING_STRATEGIES, ARCHIVED_SWING_CANDIDATES, SWING_EVAL_AGENT_ROLES, buildSwingThesisCard, swingEvalIdentity } from "./learning/swingEvalRegistry.js";
import { generatePineScript, processTradingViewWebhook } from "./tv/tvBridge.js";
import { defaultTvMcpBridge } from "./tv/tvMcpBridge.js";
import { autonomousTradingBot } from "./exec/autonomousTradingBot.js";
import { db } from "./core/db.js";
import { afterPaperReset, getPaperResetAt, PAPER_RESET_KEY } from "./core/paperSession.js";
import { summarizePayoffTrades } from "./analytics/payoffDiagnostics.js";
import { buildDailySessions, buildPaperDailySnapshot } from "./analytics/paperDailySnapshot.js";
import { summarizeObservedProbability } from "./analytics/probabilityDiagnostics.js";
import { renderPrometheusMetrics } from "./analytics/prometheusMetrics.js";
import { buildAlertFeed } from "./analytics/alertFeed.js";
import { summarizeExecutionQuality, type FillRow } from "./analytics/executionQuality.js";
import { pruneDatabase, rotateLogFiles } from "./core/maintenance.js";
import type { HistoricalDataset } from "./backtest/historicalReplay.js";
import { env, keyStatus } from "./core/env.js";
import { logger } from "./core/logger.js";
import { buildLabRouter } from "./lab/labRoutes.js";
import { mutationAuthMiddleware } from "./api/authMutations.js";
import { buildEventsRouter } from "./api/routes/events.js";
import { buildHealthMetricsRouter } from "./api/routes/healthMetrics.js";
import { buildBotRouter } from "./api/routes/bot.js";
import { buildMarketsRouter } from "./api/routes/markets.js";
import { buildPositionsRouter } from "./api/routes/positions.js";
import { buildTradesRouter } from "./api/routes/trades.js";
import { buildAdminRouter } from "./api/routes/admin.js";
import { buildTvRouter } from "./api/routes/tv.js";
import { buildDashboardRouter } from "./api/routes/dashboard.js";
import { buildResearchRouter } from "./api/routes/research.js";
import { buildAgentsLlmRouter } from "./api/routes/agentsLlm.js";
import { buildLearningRouter } from "./api/routes/learning.js";
import { buildBacktestRouter } from "./api/routes/backtest.js";
import { liveReadyNow, LIVE_MODE } from "./exec/liveRuntime.js";
import { buildLiveMirrorReport } from "./exec/liveMirror.js";
import { buildLiveDashboardReport } from "./exec/liveDashboard.js";
import { buildLiveMeshReport } from "./exec/liveMesh.js";
import { buildAnalysisRouter } from "./api/routes/analysis.js";
import { buildMicrostructureRouter } from "./api/routes/microstructure.js";
import { buildPanelAiRouter } from "./api/routes/panelAi.js";
import { AnalysisService } from "./analysis/analysisService.js";

import { runWorkerTask } from "./backtest/runWorker.js";
import type { ValidationWorkerRequest } from "./backtest/validationWorker.js";
import { configuredTradingModes, resolveEntryMode } from "./api/tradingMode.js";
import { closePaperPositions, liveAccountMutationBlocked } from "./api/positionActions.js";

export const APP_VERSION = "0.1.3";

let clockDriftMs: number | null = null;

export function setClockDrift(ms: number | null): void {
  clockDriftMs = ms;
}

export async function measureClockDrift(timeoutMs = 8000): Promise<number | null> {
  const started = Date.now();
  // 28 Okt 2026 (audit "market tidak terbaca"): host bernomor fapi1/fapi2/fapi3
  // di-geo-block dari IP VPS ini (302 -> halaman HTML www.binance.com, bukan
  // JSON — probe curl: fapi 200, fapi1-3 302). Hanya fapi.binance.com yang
  // menjawab dari sini; sinkron jam ke host bernomor selalu gagal -> driftMs
  // null terus dan semua request signed tidak punya pagar koreksi jam.
  const url = "https://fapi.binance.com/fapi/v1/time";
  try {
    const ctrl = new AbortController();
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ctrl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      logger.warn({ status: r.status, url }, "sinkron jam Binance gagal (HTTP non-200; pool fallback resmi ada di FR-23)");
      return null;
    }
    const text = (await r.text()).slice(0, 200);
    let j: { serverTime?: unknown };
    try {
      j = JSON.parse(text) as { serverTime?: unknown };
    } catch {
      logger.warn({ url, preview: text.slice(0, 80) }, "sinkron jam Binance gagal (bukan JSON; dicegat jaringan?)");
      return null;
    }
    if (typeof j.serverTime !== "number") return null;
    return j.serverTime - started;
  } catch (e) {
    logger.warn({ err: (e as Error).message, url }, "sinkron jam Binance gagal (pool fallback resmi ada di FR-23)");
    return null;
  }
}

export function createApp() {
  const app = express();
  // TAHAP 1: req.ip harus IP asli klien (X-Forwarded-For dari nginx), bukan
  // 127.0.0.1 socket proxy — supaya bypass localhost auth tidak bisa dilewati
  // dari luar via nginx.
  app.set("trust proxy", ["127.0.0.1", "::1"]);
  // 15 Okt 2026 (Tahap 3 audit): 32mb terlalu longgar untuk endpoint publik —
  // dataset backtest praktis muat di 8mb; sisanya ditolak 413 sebelum diparse.
  app.use("/api/backtest/run", express.json({ limit: "8mb" }));
  app.use("/api/backtest/audit", express.json({ limit: "8mb" }));
  app.use("/api/parameters/audit", express.json({ limit: "32mb" }));
  // 14 Okt 2026 (laporan operator: Lab error saat paste kode Pine penuh) —
  // sumber Pine utuh bisa puluhan KB; 64kb default memicu PayloadTooLarge.
  app.use("/api/lab/run", express.json({ limit: "1mb" }));
  app.use("/api/lab/parse-pine", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "64kb" }));

  // 25 Okt 2026: CORS echo-back origin — sebelumnya fallback hardcoded
  // "http://localhost:4000" membuat akses dari IP publik (nginx reverse proxy)
  // selalu kena block browser (CORS mismatch -> React gagal mount ->
  // stuck "MEMUAT KONSOL…"). Keamanan mutasi tetap dijaga oleh x-api-token
  // middleware di bawah; nginx juga sudah memblokir route berbahaya dari publik.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-api-token");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── 15 Okt 2026 — TAHAP 1 rencana audit: AUTH TOKEN route mutasi ─────────
  // ── 25 Okt 2026 (FASE 1, perintah operator): ekstrak ke authMutations.ts ─
  // Perubahan kebijakan vs versi lama:
  //   1) token kosong = MUTASI DITOLAK (503), bukan middleware off (fail-open).
  //   2) loopback TIDAK lagi bypass — caller lokal wajib kirim x-api-token
  //      (kill-below-volume-floor.sh & tools sudah dilengkapi header dari .env).
  //   3) perbandingan token constant-time.
  // GET/HEAD/OPTIONS (health, dashboard read-only) tetap terbuka; POST
  // /api/tv/webhook tetap dikecualikan (auth sendiri via TV_WEBHOOK_SECRET).
  // Boot tidak pernah gagal karena token — supervisi posisi tidak terputus.
  app.use("/api/", mutationAuthMiddleware({ getToken: () => env.API_MUTATION_TOKEN }));

// Batch 1: Events & Alerts router (extracted from inline handlers).
  app.use(buildEventsRouter({ db, buildAlertFeed }));

  // Batch 2: Health & Metrics router (extracted from inline handlers).
  app.use(buildHealthMetricsRouter({
    db,
    appVersion: APP_VERSION,
    getClockDrift: () => clockDriftMs,
    keyStatus,
    dailyRiskGuard: defaultDailyRiskGuard,
    executionMode: env.BINANCE_EXECUTION_MODE,
    liveReadyNow,
    renderPrometheusMetrics,
    logger,
  }));

    // Batch 3: Bot Control router (extracted from inline handlers).
    app.use(buildBotRouter({ db, bot: autonomousTradingBot }));

    // 23 Okt 2026 (Tahap 4): Layer analisis data (observasi, influenceTrading OFF).
    // Feed trade hanya menyala bila ANALYTICS_ENABLED=true; default mati.
    const analysisService = new AnalysisService({
      symbol: env.ANALYTICS_SYMBOL,
      market: env.ANALYTICS_MARKET === "SPOT" ? "SPOT" : "PERP",
      venues: env.ANALYTICS_VENUES.split(",")
        .map((v) => v.trim().toUpperCase())
        .filter((v): v is "BINANCE" | "HYPERLIQUID" | "COINBASE" =>
          v === "BINANCE" || v === "HYPERLIQUID" || v === "COINBASE"),
      hyperliquidTestnet: env.ANALYTICS_HYPERLIQUID_TESTNET,
    });
    if (env.ANALYTICS_ENABLED) {
      analysisService.start();
      logger.info({ symbol: env.ANALYTICS_SYMBOL, market: env.ANALYTICS_MARKET, venues: env.ANALYTICS_VENUES },
        "ANALYTICS_FEEDS_STARTED: observasi saja, influenceTrading=false");
    }
    app.use(buildAnalysisRouter({ db, service: analysisService }));

  // Batch 4: Markets & Binance router (extracted from inline handlers).
  app.use(buildMarketsRouter({
    binance: binanceFuturesClient,
    marketsService: defaultMarketsService,
    scanner: scannerPool,
    liquidations: liquidationHub,
    gatherMarketContextSnapshot,
    gatherPositionOverlays,
    getTvSignal,
    isPerpListed,
    perpUniverseCount,
    checkAssetClass,
    prismaUniverseRepo,
    volumeMinUsd: env.VOLUME_MIN_USD,
  }));

  // Batch 5: Positions & Orders router (extracted from inline handlers).
  app.use(buildPositionsRouter({
    db,
    resolveEntryMode,
    calculateOrderPlan,
    maxMarginForMode,
    resolveMarginPolicy,
    checkPairRedundancy,
    checkTradeVolume,
    checkAssetClass,
    isPerpListed,
    executePlannedEntry,
    estimateCrossLiqPrice,
    buildLiveMirrorReport,
    buildLiveDashboardReport,
    buildLiveMeshReport,
    closePaperPositions,
    liveAccountMutationBlocked,
    getPaperResetAt,
    PAPER_RESET_KEY,
    START_EQUITY_USD,
    marginMode: env.MARGIN_MODE === "ISOLATED" ? "ISOLATED" : "CROSS",
    executionMode: env.BINANCE_EXECUTION_MODE,
    dailyRiskGuard: defaultDailyRiskGuard,
    binance: binanceFuturesClient,
    positionSupervisor: defaultPositionSupervisor,
    prismaUniverseRepo,
  }));

  app.use(buildTradesRouter({
    db,
    getPaperResetAt,
    afterPaperReset,
    summarizePayoffTrades,
    buildPaperDailySnapshot,
    buildDailySessions,
    canonicalStrategyKey,
    strategyDisplayName,
    STRATEGY_NAMES,
    allowedStrategiesFor,
    START_EQUITY_USD,
    positionReconciler: defaultPositionReconciler,
  }));

  // Batch 7: Admin router (guard, settings, universe, maintenance).
  app.use(buildAdminRouter({
    db,
    dailyRiskGuard: defaultDailyRiskGuard,
    bot: autonomousTradingBot,
    leverageWatcher,
    getTradingStyle,
    configuredTradingModes,
    closePaperPositions,
    liveAccountMutationBlocked,
    pruneDatabase,
    liveReadyNow,
    keyStatus,
    executionMode: env.BINANCE_EXECUTION_MODE,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    startingEquityUsd: START_EQUITY_USD,
    thresholds: {
      riskPerTradeUsd: Number(env.RISK_PER_TRADE_USD || 1.0),
      leverageTarget: Number(env.LEVERAGE_TARGET || 20),
      marginCapPct: Number(env.MARGIN_CAP_PCT || 40),
    },
  }));

  // Batch 7: TV Bridge router (pine helper, webhook, MCP).
  app.use(buildTvRouter({
    generatePineScript,
    processTradingViewWebhook,
    tvMcpBridge: defaultTvMcpBridge,
  }));

  // Batch 7: Dashboard router (execution-quality, overview, chart data).
  app.use(buildDashboardRouter({
    db, summarizeExecutionQuality, getPaperResetAt, afterPaperReset,
    dailyRiskGuard: defaultDailyRiskGuard, marketsService: defaultMarketsService,
    binance: binanceFuturesClient, llmAdapter: defaultLlmAdapter, START_EQUITY_USD,
  }));

  // Batch 7: Research router (sweep, findings, market-monitor, analyst, swing).
  app.use(buildResearchRouter({
    db, marketSweep, swingEvalLoop: defaultSwingEvaluationLoop,
    SWING_EVAL_STRATEGIES, ARCHIVED_SWING_STRATEGIES, ARCHIVED_SWING_CANDIDATES, SWING_EVAL_AGENT_ROLES,
    buildSwingThesisCard, swingEvalIdentity, listResearchFindings, logResearchFinding, decideResearchFinding,
    researchSwingCatalog,
  }));

  // Batch 7: Agents & LLM router (llm status/chat, agents feed/ask/eval).
  app.use(buildAgentsLlmRouter({
    db, llmAdapter: defaultLlmAdapter, agentManager: defaultAgentManager,
    researchLayer: defaultResearchLayer, decisionRiskLayer: defaultDecisionRiskLayer,
    supervisorWatchdogLayer: defaultSupervisorWatchdogLayer, allAgents: ALL_12_AGENTS,
    paperDeterministicEntry: env.PAPER_DETERMINISTIC_ENTRY && env.BINANCE_EXECUTION_MODE === "PAPER",
  }));

  // Batch 7: Learning & Parameters router (setup-engine, learning, parameters).
  app.use(buildLearningRouter({
    db, canonicalStrategyKey, summarizeObservedProbability, dedupeLearningEntries,
    swingEvalIdentity, postMortemEvaluator: defaultPostMortemEvaluator,
    strategyTuner: defaultStrategyTuner, STRATEGY_NAMES, STRATEGY_SPECS,
    SWING_EVAL_STRATEGIES, ARCHIVED_SWING_STRATEGIES, SCALP_TIMEFRAMES, SWING_TIMEFRAMES, SETUP_ENGINE,
  }));

  // Batch 7: Backtest & Validation router (audit, pipeline, catalog, run, validation).
  app.use(buildBacktestRouter({
    db, backtestRepo, runWorkerTask, runDisarmedCycle, logResearchFinding, logger,
    STRATEGY_CATALOG, DEFAULT_FEE_STRUCTURE,
  }));

  // CP-7/CP-9: Lab Eksperimen (riset-only, tidak menyentuh jalur trading)
  app.use("/api/lab", buildLabRouter());

  // 24 Okt 2026 — 5 modul mikrostruktur (order flow, wall lifelines,
  // liquidation map, large trades + volume profile, tier & flow).
  app.use(buildMicrostructureRouter());
  app.use(buildPanelAiRouter());

  return app;
}
