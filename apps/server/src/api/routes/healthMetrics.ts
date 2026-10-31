// apps/server/src/api/routes/healthMetrics.ts — Batch 2 extraction (NFR-04, T-15).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { MetricsSnapshot } from "../../analytics/prometheusMetrics.js";
import type { Logger } from "pino";

export interface HealthMetricsRouterDeps {
  db: PrismaClient;
  appVersion: string;
  getClockDrift: () => number | null;
  keyStatus: () => Record<string, string>;
  dailyRiskGuard: { isArmed(): boolean };
  executionMode: string;
  liveReadyNow: () => boolean;
  renderPrometheusMetrics: (s: MetricsSnapshot) => string;
  logger: Logger;
}

export function buildHealthMetricsRouter(deps: HealthMetricsRouterDeps): Router {
  const router = Router();
  const {
    db,
    appVersion,
    getClockDrift,
    keyStatus,
    dailyRiskGuard,
    executionMode,
    liveReadyNow,
    renderPrometheusMetrics,
    logger,
  } = deps;

  router.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: "TERMINAL",
      version: appVersion,
      clock: { utc: new Date().toISOString(), driftMs: getClockDrift() },
      keys: keyStatus(),
      arm: dailyRiskGuard.isArmed(),
      executionMode,
      liveReady: liveReadyNow(),
    });
  });

  // T-15 (CP-5, 19 Okt 2026): /metrics Prometheus — read-only, tanpa token.
  // Sengaja tidak diproksi nginx publik; scrape dari localhost/VPS.
  router.get("/metrics", async (_req, res) => {
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const [openPositions, todayAgg, eventGroups, lastTrade] = await Promise.all([
        db.position.count({ where: { status: "OPEN" } }),
        db.trade.aggregate({
          where: { createdAt: { gte: dayStart } },
          _count: { _all: true },
          _sum: { pnlUsd: true },
        }),
        db.eventLog.groupBy({ by: ["severity"], _count: { _all: true } }),
        db.trade.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      ]);
      const closedTradesToday = todayAgg._count._all;
      const wins = closedTradesToday > 0
        ? await db.trade.count({ where: { createdAt: { gte: dayStart }, win: true } })
        : 0;
      const eventCountsBySeverity: Record<string, number> = {};
      for (const g of eventGroups) eventCountsBySeverity[g.severity] = g._count._all;
      const body = renderPrometheusMetrics({
        executionMode,
        liveReady: liveReadyNow(),
        armed: dailyRiskGuard.isArmed(),
        openPositions,
        closedTradesToday,
        pnlTodayUsd: todayAgg._sum.pnlUsd ?? 0,
        winRateTodayPct: closedTradesToday > 0 ? (wins / closedTradesToday) * 100 : null,
        eventCountsBySeverity,
        lastTradeAgeSeconds: lastTrade ? (Date.now() - lastTrade.createdAt.getTime()) / 1000 : null,
        uptimeSeconds: process.uptime(),
        dbSizeBytes: null,
      });
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.status(200).send(body);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "METRICS_RENDER_FAILED");
      res.status(500).send("# metrics unavailable\nalartatrade_up 0\n");
    }
  });

  return router;
}
