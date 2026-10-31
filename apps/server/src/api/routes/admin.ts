// apps/server/src/api/routes/admin.ts — Batch 7 extraction (FR-20, FR-21, FR-33, FR-35, T-4.4).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

type GetTradingStyleFn = typeof import("../../exec/slotFillPolicy.js").getTradingStyle;
type ConfiguredTradingModesFn = typeof import("../tradingMode.js").configuredTradingModes;
type ClosePaperPositionsFn = typeof import("../positionActions.js").closePaperPositions;
type LiveAccountMutationBlockedFn = typeof import("../positionActions.js").liveAccountMutationBlocked;
type PruneDatabaseFn = typeof import("../../core/maintenance.js").pruneDatabase;

interface DailyRiskGuardLike {
  evaluateStatus(candidateSymbol?: string): Promise<unknown>;
  setArmed(armed: boolean, reason?: string): Promise<void>;
  isArmed(): boolean;
}

interface BotStopper {
  // 23 Okt 2026 (F-C): async — menunggu langkah in-flight selesai.
  stop(opts?: { timeoutMs?: number }): Promise<{ waitedMs: number; inFlightTimedOut: boolean }>;
}

interface LeverageWatcherLike {
  getView(symbol?: string): Promise<unknown>;
}

export interface AdminRouterDeps {
  db: PrismaClient;
  dailyRiskGuard: DailyRiskGuardLike;
  bot: BotStopper;
  leverageWatcher: LeverageWatcherLike;
  getTradingStyle: GetTradingStyleFn;
  configuredTradingModes: ConfiguredTradingModesFn;
  closePaperPositions: ClosePaperPositionsFn;
  liveAccountMutationBlocked: LiveAccountMutationBlockedFn;
  pruneDatabase: PruneDatabaseFn;
  liveReadyNow: () => boolean;
  keyStatus: () => Record<string, string>;
  executionMode: string;
  maxOpenPositions: number;
  startingEquityUsd: number;
  thresholds: {
    riskPerTradeUsd: number;
    leverageTarget: number;
    marginCapPct: number;
  };
}

export function buildAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const {
    db,
    dailyRiskGuard,
    bot,
    leverageWatcher,
    getTradingStyle,
    configuredTradingModes,
    closePaperPositions,
    liveAccountMutationBlocked,
    pruneDatabase,
    liveReadyNow,
    keyStatus,
    executionMode,
    maxOpenPositions,
    startingEquityUsd,
    thresholds,
  } = deps;

  // FR-20, FR-21: Daily Guard & Position Limits
  router.get("/api/guard/status", async (req, res) => {
    try {
      const sym = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
      const status = await dailyRiskGuard.evaluateStatus(sym);
      res.json({ status });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/guard/arm", async (req, res) => {
    try {
      const { armed, reason = "MANUAL_TOGGLE" } = req.body;
      if (typeof armed !== "boolean") {
        return res.status(400).json({ error: "armed boolean is required" });
      }
      // 27 Okt 2026 (perintah operator): hard block ARM-in-LIVE DIHAPUS.
      // ARM kini behave sama di PAPER dan LIVE — tidak ada lagi 403 "ARM
      // tidak tersedia di mode LIVE" dan tidak ada escape hatch yang perlu
      // di-set. Otoritas ARM tetap milik operator (toggle manual / DB).
      await dailyRiskGuard.setArmed(armed, reason);
      res.json({ ok: true, armed: dailyRiskGuard.isArmed() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-35 & US-15 & NFR-08: Settings & Security
  router.get("/api/settings", async (_req, res) => {
    try {
      const tradingStyle = getTradingStyle();
      const modes = configuredTradingModes(tradingStyle);

      const blacklistedRows = await db.symbol.findMany({
        where: { isBlacklisted: true },
        select: { symbol: true, blacklistReason: true },
      });

      res.json({
        arm: dailyRiskGuard.isArmed(),
        executionMode,
        liveReady: liveReadyNow(),
        keys: keyStatus(),
        modes,
        tradingStyle,
        blacklistManual: blacklistedRows,
        thresholds: {
          riskPerTradeUsd: thresholds.riskPerTradeUsd,
          leverageTarget: thresholds.leverageTarget,
          marginCapPct: thresholds.marginCapPct,
          // 29 Sep 2026 — perintah operator: guard DRAWDOWN dan guard RUGI HARIAN
          // keduanya dihapus. 0 = tanpa batas; nilai di bawah mencerminkan guard
          // yang sebenarnya berjalan di dailyGuard.ts.
          dailyStopUsd: 0,
          autoDisarmDdUsd: 0,
          dailyGuardEnabled: false,
          drawdownGuardEnabled: false,
          maxOpenPositions,
          /** PAPER-only contract; LIVE path is unchanged. */
          swingPaperMaxOpenPositions: 3,
          swingPaperMaxNetLossesPerDay: 6,
          swingPaperRiskBudgetUsd: 1,
          swingPaperFeeAllowanceUsd: 0.2,
          swingPaperStartingEquityUsd: 200,
          retiredSwingStrategyIds: ["S-03"],
          startingEquityUsd,
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/api/settings", async (req, res) => {
    try {
      const { arm, modes } = req.body ?? {};
      if (modes !== undefined) {
        return res.status(409).json({ error: "TRADING_MODE_REQUIRES_RESTART", modes: configuredTradingModes(), tradingStyle: getTradingStyle() });
      }
      if (typeof arm === "boolean") {
        await dailyRiskGuard.setArmed(arm, "SETTINGS_API_UPDATE");
      }
      res.json({ ok: true, updated: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/settings/blacklist", async (req, res) => {
    try {
      const { symbol, reason = "MANUAL_BLACKLIST" } = req.body ?? {};
      if (!symbol) return res.status(400).json({ error: "symbol is required" });
      const sym = String(symbol).toUpperCase();

      await db.symbol.upsert({
        where: { symbol: sym },
        update: { isBlacklisted: true, blacklistReason: reason },
        create: {
          symbol: sym,
          baseAsset: sym.replace("USDT", ""),
          isBlacklisted: true,
          blacklistReason: reason,
        },
      });

      await db.eventLog.create({
        data: {
          type: "BLACKLIST_ADD",
          severity: "info",
          payload: JSON.stringify({ symbol: sym, reason }),
        },
      });

      res.json({ ok: true, symbol: sym, blacklisted: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/api/settings/blacklist/:symbol", async (req, res) => {
    try {
      const sym = req.params.symbol.toUpperCase();
      await db.symbol.updateMany({
        where: { symbol: sym },
        data: { isBlacklisted: false, blacklistReason: null },
      });

      await db.eventLog.create({
        data: {
          type: "BLACKLIST_REMOVE",
          severity: "info",
          payload: JSON.stringify({ symbol: sym }),
        },
      });

      res.json({ ok: true, symbol: sym, blacklisted: false });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/settings/kill", async (_req, res) => {
    try {
      if (liveAccountMutationBlocked()) return res.status(403).json({ ok: false, error: "LIVE_ACCOUNT_MUTATIONS_BLOCKED" });
      // 23 Okt 2026 (F-C): await stop() dulu — kill switch harus berhenti
      // SEBELUM posisi ditutup, dan langkah in-flight tidak boleh membuka
      // posisi baru di tengah proses kill.
      const stopped = await bot.stop();
      await dailyRiskGuard.setArmed(false, "EMERGENCY_GLOBAL_KILL");
      const result = await closePaperPositions();
      await db.eventLog.create({ data: { type: "KILL", severity: result.ok ? "warn" : "error",
        payload: JSON.stringify({ action: "GLOBAL_KILL_SWITCH", ...result, botStop: stopped }) } });
      res.status(result.ok ? 200 : 409).json({ ...result, armed: false, botStop: stopped,
        message: result.ok ? "Penutupan PAPER terkonfirmasi; bot berhenti." : "Penutupan PAPER belum selesai; periksa sisa posisi dan kegagalan." });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/universe/leverage", async (req, res) => {
    try {
      const sym = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
      const data = await leverageWatcher.getView(sym);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-33 & US-14: Universe Audit & Table View
  router.get("/api/universe/audit", async (req, res) => {
    try {
      const { search } = req.query;
      const symbols = await db.symbol.findMany({
        where: search
          ? { symbol: { contains: String(search).toUpperCase() } }
          : undefined,
        orderBy: { symbol: "asc" },
        take: 100,
      });

      const totalSymbols = await db.symbol.count();
      const blacklistedCount = await db.symbol.count({ where: { isBlacklisted: true } });
      const eligibleCount = await db.symbol.count({ where: { eligible: true } });

      res.json({
        totalSymbols,
        cryptoPerpsCount: totalSymbols,
        eligibleCount,
        nonCryptoFiltered: 204,
        manualBlacklistCount: blacklistedCount,
        symbols,
        refreshedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // T-4.4, NFR-07: Rotasi Log & Retensi Database
  router.post("/api/maintenance/prune", async (req, res) => {
    try {
      const {
        eventLogRetentionDays = 90,
        setupCandidateRetentionDays = 30,
        leverageHistoryRetentionDays = 90,
        vacuumDb = true,
      } = req.body ?? {};

      const result = await pruneDatabase({
        eventLogRetentionDays: Number(eventLogRetentionDays),
        setupCandidateRetentionDays: Number(setupCandidateRetentionDays),
        leverageHistoryRetentionDays: Number(leverageHistoryRetentionDays),
        vacuumDb: Boolean(vacuumDb),
      });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/maintenance/status", async (_req, res) => {
    try {
      const eventLogCount = await db.eventLog.count();
      const setupCandidateCount = await db.setupCandidate.count();
      const leverageHistoryCount = await db.leverageHistory.count();
      const positionCount = await db.position.count();
      const tradeCount = await db.trade.count();

      res.json({
        tables: {
          eventLog: eventLogCount,
          setupCandidate: setupCandidateCount,
          leverageHistory: leverageHistoryCount,
          position: positionCount,
          trade: tradeCount,
        },
        retentionPolicy: {
          eventLogDays: 90,
          setupCandidateDays: 30,
          leverageHistoryDays: 90,
          targetDbMaxGb: 2.0,
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
