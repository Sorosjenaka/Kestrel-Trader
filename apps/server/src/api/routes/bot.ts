// apps/server/src/api/routes/bot.ts — Batch 3 extraction (FR-26, FR-30, FR-32).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { executionScopedOpenWhere } from "../../risk/positionScope.js";

export interface BotControlHandle {
  getStatus(openCount: number): unknown;
  isBotRunning(): boolean;
  start(intervalMs?: number): void;
  // 23 Okt 2026 (F-C): stop() async — menunggu langkah in-flight selesai agar
  // tidak ada order yang lolos setelah perintah berhenti.
  stop(opts?: { timeoutMs?: number }): Promise<{ waitedMs: number; inFlightTimedOut: boolean }>;
  step(): Promise<void>;
  runNow(focusSymbol?: string): Promise<Record<string, unknown>>;
}

export interface BotRouterDeps {
  db: PrismaClient;
  bot: BotControlHandle;
}

export function buildBotRouter(deps: BotRouterDeps): Router {
  const router = Router();
  const { db, bot } = deps;

  // Autonomous Bot & 12 AI Agent Trading Control Endpoints
  router.get("/api/bot/status", async (_req, res) => {
    try {
      const openCount = await db.position.count({ where: executionScopedOpenWhere() });
      const status = bot.getStatus(openCount);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/bot/start", async (_req, res) => {
    try {
      bot.start();
      res.json({ ok: true, isRunning: bot.isBotRunning() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/bot/stop", async (_req, res) => {
    try {
      // 23 Okt 2026 (F-C): await stop() agar langkah in-flight selesai dulu.
      const stopped = await bot.stop();
      res.json({ ok: true, isRunning: bot.isBotRunning(), ...stopped });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/bot/trigger-step", async (_req, res) => {
    try {
      await bot.step();
      const openCount = await db.position.count({ where: executionScopedOpenWhere() });
      const status = bot.getStatus(openCount);
      res.json({ ok: true, status });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Tombol terminal "JALANKAN BOT (PAIR)": nyalakan ulang sistem bila mati/berhenti
  // lalu paksa SATU siklus penuh segera (supervisi + scan + entry). Pair fokus dinilai
  // pertama tetapi tetap wajib lolos semua gate (volume > VOLUME_MIN_USD, harga live, strategi).
  router.post("/api/bot/run", async (req, res) => {
    try {
      const symbol = typeof req.body?.symbol === "string" ? String(req.body.symbol).toUpperCase() : undefined;
      const result = await bot.runNow(symbol);
      const openCount = await db.position.count({ where: executionScopedOpenWhere() });
      const status = bot.getStatus(openCount);
      res.json({ ok: true, ...result, status });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
