// apps/server/src/api/routes/panelAi.ts — 26 Okt 2026 (TAHAP 4D)
// Read model + SSE hasil analisis AI lima panel mikrostruktur.
//   GET /api/panel-ai/:symbol        — baris terbaru per panel + gabungan
//   GET /api/panel-ai/:symbol/stream — SSE (read model ringan, bukan hitung ulang)
import { Router } from "express";
import { readPanelAiLatest, maybeTriggerPanelAnalysis } from "../../analysis/panelInsights.js";
import { cached } from "./microstructureCache.js";

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export function buildPanelAiRouter(): Router {
  const router = Router();

  const produce = (symbol: string) => cached(`panel-ai:${symbol}`, 2000, () => readPanelAiLatest(symbol));

  router.get("/api/panel-ai/:symbol", async (req, res) => {
    const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    try {
      res.json(await produce(symbol));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/panel-ai/:symbol/stream", (req, res) => {
    const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let active = true;
    const push = () => {
      if (!active) return;
      void produce(symbol)
        .then((data) => { try { res.write(`data: ${JSON.stringify({ type: "panel-ai", data, status: "OK" })}\n\n`); } catch { /* gone */ } })
        .catch((err) => { try { res.write(`data: ${JSON.stringify({ type: "panel-ai", error: (err as Error).message, status: "ERROR" })}\n\n`); } catch { /* gone */ } });
    };
    push();
    const timer = setInterval(push, 10_000); // read model: jarang berubah
    req.on("close", () => { active = false; clearInterval(timer); });
  });

  // Trigger manual (uji/offline) — dedup+budget tetap berlaku di dalam modul.
  router.post("/api/panel-ai/:symbol/trigger", (req, res) => {
    const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) { res.status(400).json({ error: "SYMBOL_INVALID" }); return; }
    const force = String(req.query.force ?? "") === "1";
    maybeTriggerPanelAnalysis(symbol, { force });
    res.json({ ok: true, queued: true, symbol, force });
  });

  return router;
}