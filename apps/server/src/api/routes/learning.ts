// apps/server/src/api/routes/learning.ts — Batch 7 extraction (FR-27, FR-28, FR-34, US-11, US-12).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

type CanonicalStrategyKeyFn = typeof import("../../strategies/strategyCatalog.js").canonicalStrategyKey;
type SummarizeObservedProbabilityFn = typeof import("../../analytics/probabilityDiagnostics.js").summarizeObservedProbability;
type DedupeLearningEntriesFn = typeof import("../../learning/postMortemEvaluator.js").dedupeLearningEntries;
type SwingEvalIdentityFn = typeof import("../../learning/swingEvalRegistry.js").swingEvalIdentity;

interface PostMortemEvaluatorLike {
  evaluateLossTrade(tradeId: number): Promise<unknown>;
}

interface StrategyTunerLike {
  proposeTuning(body: unknown): Promise<unknown>;
  auditAndGateVersion(version: string, opts: { strategyId?: string; dataset?: any; maxDrawdownUsd?: number }): Promise<unknown>;
}

export interface LearningRouterDeps {
  db: PrismaClient;
  canonicalStrategyKey: CanonicalStrategyKeyFn;
  summarizeObservedProbability: SummarizeObservedProbabilityFn;
  dedupeLearningEntries: DedupeLearningEntriesFn;
  swingEvalIdentity: SwingEvalIdentityFn;
  postMortemEvaluator: PostMortemEvaluatorLike;
  strategyTuner: StrategyTunerLike;
  STRATEGY_NAMES: Record<string, string>;
  STRATEGY_SPECS: ReadonlyArray<any>;
  SWING_EVAL_STRATEGIES: ReadonlyArray<{ strategyId: string; displayName: string }>;
  ARCHIVED_SWING_STRATEGIES: ReadonlyArray<unknown>;
  SCALP_TIMEFRAMES: { summary: string; description: string; specs: unknown; macroIntervals: unknown };
  SWING_TIMEFRAMES: { summary: string; description: string; specs: unknown; macroIntervals: unknown };
  SETUP_ENGINE: Record<string, unknown>;
}

export function buildLearningRouter(deps: LearningRouterDeps): Router {
  const router = Router();
  const {
    db,
    canonicalStrategyKey,
    summarizeObservedProbability,
    dedupeLearningEntries,
    swingEvalIdentity,
    postMortemEvaluator,
    strategyTuner,
    STRATEGY_NAMES,
    STRATEGY_SPECS,
    SWING_EVAL_STRATEGIES,
    ARCHIVED_SWING_STRATEGIES,
    SCALP_TIMEFRAMES,
    SWING_TIMEFRAMES,
    SETUP_ENGINE,
  } = deps;

  // FR-27, FR-34, US-11: Post-Mortem Evaluator & Learning Journal
  // Katalog mesin setup (timeframe per mode, strategi aktif S-01, S-02, RSW-01..03, konfigurasi SL/TP).
  router.get("/api/setup-engine", async (_req, res) => {
    try {
      const recent = await db.setupCandidate.findMany({
        where: { strategyId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      // 6 Okt 2026 (renumber 3 strategi): agregat per strategi memakai kunci
      // kanonik era-aware — trade eks S-03/S-04 tidak salah kelompok setelah
      // nomor dipakai ulang (S-03 kini Fibonacci, S-04 tidak ada). Era dinilai
      // dari waktu BUKA posisi, bukan waktu tutup trade.
      const countRows = await db.trade.findMany({
        select: { strategyId: true, createdAt: true, pnlUsd: true, position: { select: { openedAt: true } } },
      });
      const countMap = new Map<string, { trades: number; net: number }>();
      for (const row of countRows) {
        const key = row.strategyId ? canonicalStrategyKey(row.strategyId, row.position?.openedAt ?? row.createdAt) : "S-00";
        const cur = countMap.get(key) ?? { trades: 0, net: 0 };
        cur.trades += 1;
        cur.net += row.pnlUsd ?? 0;
        countMap.set(key, cur);
      }
      const statsByStrategy = [...countMap.entries()]
        .map(([key, v]) => ({
          strategyId: key,
          strategyName: key === "S-00" ? "Tanpa Jejak Strategi"
            : key === "S-99" ? "Strategi arsip (nonaktif)"
              // 21 Okt 2026 (Phase 2): pakai swingEvalIdentity (aktif + arsip) supaya
              // trade lama S-05 tetap tampil sebagai "Polaris" setelah dipindahkan ke arsip.
              : (swingEvalIdentity(key)?.displayName ?? STRATEGY_NAMES[key] ?? key),
          trades: v.trades,
          netPnlUsd: Number(v.net.toFixed(4)),
        }))
        .sort((a, b) => b.trades - a.trades);
      res.json({
        timeframes: {
          SCALP: { summary: SCALP_TIMEFRAMES.summary, description: SCALP_TIMEFRAMES.description, specs: SCALP_TIMEFRAMES.specs, macro: SCALP_TIMEFRAMES.macroIntervals },
          SWING: { summary: SWING_TIMEFRAMES.summary, description: SWING_TIMEFRAMES.description, specs: SWING_TIMEFRAMES.specs, macro: SWING_TIMEFRAMES.macroIntervals },
        },
        strategies: STRATEGY_SPECS
          // 20 Okt 2026: S-03 Fibonacci dihapus dari katalog -> filter
          // "kecuali S-03 di lane SWING" tidak lagi perlu.
          .map((s) => {
            const display = SWING_EVAL_STRATEGIES.find((x) => x.strategyId === s.id)?.displayName;
            return display ? { ...s, name: display } : s;
          }),
        archivedSwingStrategies: ARCHIVED_SWING_STRATEGIES,
        fallbackStrategy: { id: "S-00", name: "Tanpa Jejak Strategi (%)", note: "Bucket analitik display-only untuk trade tanpa jejak strategi — BUKAN strategi trading. Sejak 6 Okt 2026 tidak ada entry tanpa match strategi aktif (requireStrictPlan)." },
        config: SETUP_ENGINE,
        statsByStrategy,
        recentPlans: recent.map((c) => ({
          symbol: c.symbol,
          createdAt: c.createdAt,
          strategyId: c.strategyId,
          strategyName: c.strategyName,
          entryType: c.entryType,
          entryPrice: c.entryPrice,
          slPrice: c.slPrice,
          tp1Price: c.tp1Price,
          zoneType: c.zoneType,
          zoneTop: c.zoneTop,
          zoneBottom: c.zoneBottom,
          tfSummary: c.tfSummary,
          planQuality: c.planQuality,
          planNotes: c.planNotes,
          score: c.score,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/learning/probability", async (_req, res) => {
    try {
      // The learning cohort deliberately spans dashboard resets.
      const rows = await db.trade.findMany({
        where: { source: "PAPER_AI", accountingQuality: "SIMULATED" },
        select: { mode: true, pnlUsd: true },
      });
      res.json({
        provenance: "PAPER_AI / SIMULATED / CLOSED; fee estimated, funding unverified",
        method: "Observed net-win frequency and Wilson 95% interval; no predictive calibration",
        all: summarizeObservedProbability(rows),
        // 30 Sep 2026 — refactor SCALP-only: irisan lane SCALP (trade historis
        // baris lama tetap ikut dihitung di "all").
        scalp: summarizeObservedProbability(rows.filter((r) => r.mode === "SCALP")),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/learning", async (req, res) => {
    try {
      const { causeCode, outcome, limit, offset } = req.query;
      const where = {
        ...(causeCode ? { causeCode: String(causeCode) } : {}),
        ...(outcome ? { outcome: String(outcome) } : {}),
      };
      // 25 Okt 2026 (BUG FIX): route ini sebelumnya mengembalikan SEMUA
      // learning entry + relasi trade tanpa batas — 64 MB JSON / 8 dtk pada
      // database produksi, yang membuat halaman Learning lambat dan berisiko
      // OOM di browser. Sekarang paginasi: limit default 200 (maks 1000),
      // offset default 0. Field `total` untuk pager UI.
      const lim = Math.min(Math.max(Number.parseInt(String(limit ?? "200"), 10) || 200, 1), 1000);
      const off = Math.max(Number.parseInt(String(offset ?? "0"), 10) || 0, 0);
      const [total, learnings] = await Promise.all([
        db.learningEntry.count({ where }),
        db.learningEntry.findMany({
          where,
          include: { trade: true },
          orderBy: { createdAt: "desc" },
          take: lim,
          skip: off,
        }),
      ]);
      res.json({ learnings: dedupeLearningEntries(learnings), total, limit: lim, offset: off });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/learning/:id", async (req, res) => {
    try {
      const entry = await db.learningEntry.findUnique({
        where: { id: Number(req.params.id) },
        include: { trade: true },
      });
      if (!entry) return res.status(404).json({ error: "Learning entry not found" });
      res.json({ entry });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/learning/evaluate/:tradeId", async (req, res) => {
    try {
      const tradeId = Number(req.params.tradeId);
      const entry = await postMortemEvaluator.evaluateLossTrade(tradeId);
      res.json({ entry });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-28, US-11, US-12: Strategy Tuner & Parameter Versioning
  router.get("/api/parameters", async (_req, res) => {
    try {
      const versions = await db.parameterVersion.findMany({
        orderBy: { createdAt: "desc" },
      });
      const active = versions.find((v) => v.status === "ACTIVE") ?? null;
      res.json({ versions, active });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/parameters/propose", async (req, res) => {
    try {
      const result = await strategyTuner.proposeTuning(req.body);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/parameters/audit", async (req, res) => {
    try {
      const { version, strategyId = "S-01", dataset, maxDrawdownUsd } = req.body ?? {};
      if (!version) return res.status(400).json({ error: "version is required" });

      const result = await strategyTuner.auditAndGateVersion(String(version), {
        strategyId,
        dataset,
        maxDrawdownUsd: Number.isFinite(Number(maxDrawdownUsd)) && Number(maxDrawdownUsd) > 0 ? Number(maxDrawdownUsd) : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
