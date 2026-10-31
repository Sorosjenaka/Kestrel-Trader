// apps/server/src/api/routes/analysis.ts - Endpoint analisis (read-only).
// 23 Okt 2026 (Tahap 4). TIDAK pernah mengirim order, TIDAK pernah menulis
// ke jalur trading. Hanya membaca data yang dikumpulkan layer analisis.

import { Router } from "express";
import { env } from "../../core/env.js";
import { AnalysisService } from "../../analysis/analysisService.js";
import { DATA_TTL_MS } from "../../analysis/contracts.js";
import type { PrismaClient } from "@prisma/client";

export interface AnalysisRouterDeps {
  db: PrismaClient;
  service: AnalysisService;
}

/**
 * GET /api/analysis/snapshot
 * Feature snapshot bersama + status data per feed. Read-only.
 */
export function buildAnalysisRouter(deps: AnalysisRouterDeps): Router {
  const router = Router();
  const { service } = deps;

  router.get("/api/analysis/snapshot", (_req, res) => {
    try {
      const snap = service.buildSnapshot();
      res.json({
        ...snap,
        ttlPolicy: DATA_TTL_MS,
        // Pengaruh ke trading: selalu terlihat dari API supaya tidak ada
        // Layer baru diam-diam memengaruhi entry.
        influenceTrading: env.ANALYTICS_INFLUENCE_TRADING,
        serviceStarted: service.isStarted(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** GET /api/analysis/status — status ringkas feed (UI badge). */
  router.get("/api/analysis/status", (_req, res) => {
    res.json({
      enabled: env.ANALYTICS_ENABLED,
      influenceTrading: env.ANALYTICS_INFLUENCE_TRADING,
      started: service.isStarted(),
      feeds: service.feedStatuses(),
      ttlPolicy: DATA_TTL_MS,
    });
  });

  return router;
}
