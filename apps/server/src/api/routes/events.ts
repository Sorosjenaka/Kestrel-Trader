// apps/server/src/api/routes/events.ts — Batch 1 extraction (T-16, NFR-12).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { EventLogLike, AlertItem } from "../../analytics/alertFeed.js";

export interface EventsRouterDeps {
  db: PrismaClient;
  buildAlertFeed: (rows: EventLogLike[], limit?: number) => AlertItem[];
}

export function buildEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const { db, buildAlertFeed } = deps;

  // T-16 (CP-5): feed alert kritis untuk dashboard (bukan Telegram).
  router.get("/api/alerts", async (req, res) => {
    try {
      const limitRaw = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 20;
      const rows = await db.eventLog.findMany({
        where: { severity: { in: ["warn", "error", "critical"] } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, type: true, severity: true, payload: true, createdAt: true },
      });
      const items = buildAlertFeed(rows, limit);
      res.json({ count: items.length, items });
    } catch (err) {
      res.status(500).json({ error: "gagal membaca alert", detail: (err as Error)?.message });
    }
  });

  router.get("/api/events", async (req, res) => {
    try {
      const { type, severity, limit = 50 } = req.query;
      const events = await db.eventLog.findMany({
        where: {
          ...(type ? { type: String(type) } : {}),
          ...(severity ? { severity: String(severity) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(limit) || 50, 200),
      });
      res.json({ events });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
