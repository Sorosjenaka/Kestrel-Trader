// apps/server/src/api/routes/research.ts — extracted from app.ts (research & swing-eval routes).
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

type ListResearchFindingsFn = typeof import("../../learning/researchFinding.js").listResearchFindings;
type LogResearchFindingFn = typeof import("../../learning/researchFinding.js").logResearchFinding;
type DecideResearchFindingFn = typeof import("../../learning/researchFinding.js").decideResearchFinding;
type BuildSwingThesisCardFn = typeof import("../../learning/swingEvalRegistry.js").buildSwingThesisCard;
type SwingEvalIdentityFn = typeof import("../../learning/swingEvalRegistry.js").swingEvalIdentity;
type ExperimentType = import("../../learning/researchFinding.js").ExperimentType;
type FindingVerdict = import("../../learning/researchFinding.js").FindingVerdict;

interface MarketSweepLike {
  getLatestReport(): unknown;
}

interface SwingEvalLoopLike {
  status(): {
    runs: Array<{ state: string }>;
  };
}

export interface ResearchRouterDeps {
  db: PrismaClient;
  marketSweep: MarketSweepLike;
  swingEvalLoop: SwingEvalLoopLike;
  SWING_EVAL_STRATEGIES: ReadonlyArray<{ strategyId: string; displayName: string }>;
  ARCHIVED_SWING_STRATEGIES: ReadonlyArray<unknown>;
  ARCHIVED_SWING_CANDIDATES: ReadonlyArray<unknown>;
  SWING_EVAL_AGENT_ROLES: ReadonlyArray<unknown>;
  buildSwingThesisCard: BuildSwingThesisCardFn;
  swingEvalIdentity: SwingEvalIdentityFn;
  listResearchFindings: ListResearchFindingsFn;
  logResearchFinding: LogResearchFindingFn;
  decideResearchFinding: DecideResearchFindingFn;
  researchSwingCatalog: unknown;
}

export function buildResearchRouter(deps: ResearchRouterDeps): Router {
  const router = Router();
  const {
    db,
    marketSweep,
    swingEvalLoop,
    SWING_EVAL_STRATEGIES,
    ARCHIVED_SWING_STRATEGIES,
    ARCHIVED_SWING_CANDIDATES,
    SWING_EVAL_AGENT_ROLES,
    buildSwingThesisCard,
    listResearchFindings,
    logResearchFinding,
    decideResearchFinding,
    researchSwingCatalog,
  } = deps;

  // LLM Market Sweep (15 Okt): hasil riset multi-paralel semua simbol (read-only).
  router.get("/api/research/sweep", (_req, res) => {
    try {
      const r = marketSweep.getLatestReport();
      res.json(r ?? { status: "no_sweep_yet" });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  router.get("/api/research/sweep/history", async (req, res) => {
    try {
      const limit = Math.min(50, Number(req.query.limit) || 10);
      const rows = await db.eventLog.findMany({
        where: { type: "LLM_SWEEP" }, orderBy: { createdAt: "desc" as const }, take: limit,
      });
      res.json({ sweeps: rows });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Swing Evaluation Loop (three active non-Fibonacci subjects) ──────────
  // Read-only status. The loop itself is scheduler-driven; there is no public
  // endpoint to force LLM/backtest/paper work.
  router.get("/api/swing-eval-loop/status", (_req, res) => {
    try {
      const status = swingEvalLoop.status();
      const paperWorkers = Object.fromEntries(SWING_EVAL_STRATEGIES.map((subject) => {
        try {
          const file = path.join(process.cwd(), "data", "swing-paper-runtime", `forward-wallet-${subject.strategyId}.json`);
          const wallet = JSON.parse(fs.readFileSync(file, "utf8")) as { initialBalance?: number; cash?: number; closed?: unknown[]; createdAt?: number };
          return [subject.strategyId, { mode: "ISOLATED_PAPER_ONLY", isolated: true, initialBalanceUsd: wallet.initialBalance ?? null, cashUsd: wallet.cash ?? null, closedCount: Array.isArray(wallet.closed) ? wallet.closed.length : 0, createdAt: wallet.createdAt ?? null }];
        } catch { return [subject.strategyId, { mode: "ISOLATED_PAPER_ONLY", isolated: true, state: "STATE_UNAVAILABLE" }]; }
      }));
      res.json({
        schemaVersion: 1,
        subjects: SWING_EVAL_STRATEGIES,
        paperWorkers,
        thesisCards: SWING_EVAL_STRATEGIES.map((s) => buildSwingThesisCard(s.strategyId)).filter(Boolean),
        archivedStrategies: ARCHIVED_SWING_STRATEGIES,
        agentRoles: SWING_EVAL_AGENT_ROLES,
        archivedCandidates: ARCHIVED_SWING_CANDIDATES,
        loop: status,
        counts: {
          active: status.runs.filter((r) => ["EVALUATION_QUEUED", "EVALUATING", "FEEDBACK_VALIDATED", "EXPERIMENT_PROPOSED", "EXPERIMENT_VALIDATED", "BACKTEST_QUEUED", "BACKTEST_RUNNING", "BACKTEST_COMPLETED", "OOS_GATE", "PAPER_QUEUED", "PAPER_RUNNING", "REVIEW_DUE", "RETRY_PENDING"].includes(r.state)).length,
          terminal: status.runs.filter((r) => ["NO_CHANGE", "REJECTED", "INSUFFICIENT_DATA", "NEEDS_OPERATOR", "FAILED", "ARCHIVED"].includes(r.state)).length,
          total: status.runs.length,
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 15 Okt 2026 — Big Brain: jurnal temuan riset (findings/verdict) ──────
  // Satu baris per eksperimen: hipotesis + referensi bukti + verdict +
  // keputusan operator. Tujuannya: riset tidak boleh jadi "klaim tanpa
  // bukti angka" (pelajaran 15 BacktestRun FAILED NO_DATA).
  router.get("/api/research/findings", async (req, res) => {
    try {
      const limit = Math.min(200, Number(req.query.limit) || 50);
      const findings = await listResearchFindings(limit);
      res.json({ findings });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/research/findings", async (req, res) => {
    try {
      const { title, hypothesis, experimentType, verdict, conclusion, runRefs, metrics } = req.body ?? {};
      const id = await logResearchFinding({
        title: typeof title === "string" ? title : "",
        hypothesis: typeof hypothesis === "string" ? hypothesis : "",
        experimentType: experimentType as ExperimentType,
        verdict: verdict as FindingVerdict,
        conclusion: typeof conclusion === "string" ? conclusion : undefined,
        runRefs: Array.isArray(runRefs) ? runRefs : undefined,
        metrics: metrics && typeof metrics === "object" ? metrics : undefined,
      });
      if (id === null) {
        res.status(400).json({ error: "Temuan tidak valid (title/hypothesis/experimentType/verdict wajib benar)" });
        return;
      }
      res.json({ id });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Keputusan operator atas temuan — LLM tidak berhak meng-ADOPT sendiri.
  router.post("/api/research/findings/:id/decision", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "id tidak valid" });
        return;
      }
      const { decision } = req.body ?? {};
      if (decision !== "ADOPTED" && decision !== "REJECTED") {
        res.status(400).json({ error: "decision wajib ADOPTED atau REJECTED" });
        return;
      }
      const ok = await decideResearchFinding(id, decision);
      if (!ok) {
        res.status(409).json({ error: "Temuan tidak ditemukan atau keputusannya sudah final" });
        return;
      }
      res.json({ id, operatorDecision: decision });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── 15 Okt 2026 — Big Brain: monitor riset (semua DB-backed, tanpa fabrikasi)
  // Ringkasan satu layar: event terbaru, agregat keputusan 24 jam, funnel
  // sinyal swing 24 jam, posisi open, dan temuan riset terbaru.
  router.get("/api/research/market-monitor", async (_req, res) => {
    try {
      const since24h = new Date(Date.now() - 24 * 3600 * 1000);
      const [events, decisionRows, swingRows, openPositions, findings] = await Promise.all([
        db.eventLog.findMany({ orderBy: { id: "desc" }, take: 50 }),
        db.decisionLog.findMany({
          where: { createdAt: { gte: since24h } },
          select: { decision: true, strategyId: true, symbol: true },
        }),
        db.swingSignalLog.findMany({
          where: { createdAt: { gte: since24h } },
          select: { decision: true, strategyId: true, symbol: true },
        }),
        db.position.count({ where: { status: "OPEN" } }),
        listResearchFindings(10),
      ]);

      const decisionAggregate: Record<string, number> = {};
      for (const r of decisionRows) decisionAggregate[r.decision] = (decisionAggregate[r.decision] ?? 0) + 1;
      const decisionByStrategy: Record<string, { total: number; go: number }> = {};
      for (const r of decisionRows) {
        const key = r.strategyId ?? "(tanpa)";
        decisionByStrategy[key] ??= { total: 0, go: 0 };
        decisionByStrategy[key]!.total++;
        if (r.decision === "GO") decisionByStrategy[key]!.go++;
      }
      const swingAggregate: Record<string, number> = {};
      for (const r of swingRows) swingAggregate[r.decision] = (swingAggregate[r.decision] ?? 0) + 1;

      res.json({
        generatedAt: new Date().toISOString(),
        windowHours: 24,
        recentEvents: events.map((e) => ({ id: e.id, type: e.type, severity: e.severity, createdAt: e.createdAt, payload: e.payload?.slice(0, 200) })),
        decisions24h: {
          total: decisionRows.length,
          aggregate: decisionAggregate,
          byStrategy: decisionByStrategy,
        },
        swingSignals24h: { total: swingRows.length, aggregate: swingAggregate },
        openPositions,
        researchFindings: findings.map((f) => ({ id: f.id, title: f.title, verdict: f.verdict, operatorDecision: f.operatorDecision })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // LLM Market Analyst (14 Okt 2026): laporan analisis data/research/analyst-<day>.md
  router.get("/api/research/analyst", async (req, res) => {
    try {
      const dir = path.join(process.cwd(), "data", "research");
      let files: string[] = [];
      try {
        files = (await fsPromises.readdir(dir)).filter((f) => f.startsWith("analyst-") && f.endsWith(".md")).sort().reverse();
      } catch {}
      const day = typeof req.query.day === "string" ? req.query.day : null;
      if (day) {
        const safe = day.replace(/[^0-9-]/g, "");
        const content = await fsPromises.readFile(path.join(dir, `analyst-${safe}.md`), "utf8").catch(() => null);
        if (content === null) return res.status(404).json({ error: "not found" });
        return res.json({ day: safe, content });
      }
      const list: Array<{ day: string; size: number; updatedAt: string }> = [];
      for (const f of files.slice(0, 30)) {
        const st = await fsPromises.stat(path.join(dir, f)).catch(() => null);
        if (st) list.push({ day: f.replace(/^analyst-|\.md$/g, ""), size: st.size, updatedAt: st.mtime.toISOString() });
      }
      res.json({ days: list });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Memori sinyal SWING (SwingSignalLog) — bahan riset analyst + transparsI operator.
  router.get("/api/swing/signals", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const signals = await db.swingSignalLog.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      res.json({ signals });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Separate registry: research candidates are never executable/live catalog entries.
  router.get("/api/research/swing-strategies", (_req, res) => {
    res.json(researchSwingCatalog);
  });

  router.get("/api/research/swing-paper/status", async (_req, res) => {
    try {
      const response = await fetch("http://127.0.0.1:8791/status", { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error("ISOLATED_PAPER_WORKER_UNAVAILABLE");
      res.setHeader("Cache-Control", "no-store");
      res.json(await response.json());
    } catch {
      res.status(503).json({ mode: "ISOLATED_PAPER_ONLY", running: false, liveEnabled: false,
        error: "Worker PAPER riset belum tersedia; jalankan npm run paper:swing:research pada host ini." });
    }
  });

  return router;
}
