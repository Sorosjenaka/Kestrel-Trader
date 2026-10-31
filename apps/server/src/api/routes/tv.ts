// apps/server/src/api/routes/tv.ts — Batch 7 extraction (FR-36, FR-37, FR-38).
import { Router } from "express";

type GeneratePineScriptFn = typeof import("../../tv/tvBridge.js").generatePineScript;
type ProcessTradingViewWebhookFn = typeof import("../../tv/tvBridge.js").processTradingViewWebhook;

interface TvMcpBridgeLike {
  getStatus(): unknown;
  setEnabled(enabled: boolean): Promise<unknown>;
  syncWatchlist(symbols: unknown[]): Promise<unknown>;
  createOrUpdate4LevelAlerts(opts: { symbol: string; levels: unknown }): Promise<unknown>;
}

export interface TvRouterDeps {
  generatePineScript: GeneratePineScriptFn;
  processTradingViewWebhook: ProcessTradingViewWebhookFn;
  tvMcpBridge: TvMcpBridgeLike;
}

export function buildTvRouter(deps: TvRouterDeps): Router {
  const router = Router();
  const { generatePineScript, processTradingViewWebhook, tvMcpBridge } = deps;

  // FR-36, FR-38: Webhook Receiver TV & Pine Helper Generator
  router.post("/api/tv/pine", (req, res) => {
    try {
      const {
        symbol = "BTCUSDT",
        side = "LONG",
        entryPrice = 60000,
        slPrice = 59400,
        tp1Price = 60720,
        title,
      } = req.body ?? {};

      const script = generatePineScript({
        symbol: String(symbol).toUpperCase(),
        side: side === "SHORT" ? "SHORT" : "LONG",
        entryPrice: Number(entryPrice),
        slPrice: Number(slPrice),
        tp1Price: Number(tp1Price),
        title,
      });

      res.json({
        symbol,
        side,
        levels: { entryPrice, slPrice, tp1Price },
        script,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/tv/webhook", async (req, res) => {
    try {
      const headerToken = req.headers["x-tv-token"] as string | undefined;
      const result = await processTradingViewWebhook(req.body, headerToken);
      if (!result.success) {
        return res.status(401).json(result);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-37: TV Bridge MCP OAuth (Standby OFF)
  router.get("/api/tv/mcp/status", (_req, res) => {
    try {
      const status = tvMcpBridge.getStatus();
      res.json({ status });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/tv/mcp/toggle", async (req, res) => {
    try {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled boolean is required" });
      }
      const status = await tvMcpBridge.setEnabled(enabled);
      res.json({ ok: true, status });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/tv/mcp/sync-watchlist", async (req, res) => {
    try {
      const { symbols = [] } = req.body ?? {};
      const result = await tvMcpBridge.syncWatchlist(symbols);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/tv/mcp/alerts", async (req, res) => {
    try {
      const { symbol, levels } = req.body ?? {};
      if (!symbol || !levels) {
        return res.status(400).json({ error: "symbol and levels are required" });
      }
      const result = await tvMcpBridge.createOrUpdate4LevelAlerts({ symbol, levels });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
