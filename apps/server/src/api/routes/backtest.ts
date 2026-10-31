// apps/server/src/api/routes/backtest.ts — Batch 7 extraction (FR-14, US-12, T-2.9).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { BacktestRunOutput, StrategyMode, FeeStructure } from "../../backtest/backtestEngine.js";
import type { HistoricalDataset } from "../../backtest/historicalReplay.js";
import type { ValidationWorkerRequest } from "../../backtest/validationWorker.js";
import type { FindingVerdict } from "../../learning/researchFinding.js";

type RunWorkerTaskFn = typeof import("../../backtest/runWorker.js").runWorkerTask;
type RunDisarmedCycleFn = typeof import("../../exec/disarmedCycle.js").runDisarmedCycle;
type LogResearchFindingFn = typeof import("../../learning/researchFinding.js").logResearchFinding;

interface BacktestRepoLike {
  saveRun(output: BacktestRunOutput, db: PrismaClient): Promise<number>;
  getAllRuns(): ReadonlyArray<any>;
  loadFromDb(db: PrismaClient): Promise<void>;
  getRun(id: number): any;
}

interface LoggerLike {
  error(obj: unknown, msg: string): void;
}

export interface BacktestRouterDeps {
  db: PrismaClient;
  backtestRepo: BacktestRepoLike;
  runWorkerTask: RunWorkerTaskFn;
  runDisarmedCycle: RunDisarmedCycleFn;
  logResearchFinding: LogResearchFindingFn;
  logger: LoggerLike;
  STRATEGY_CATALOG: Record<string, unknown>;
  DEFAULT_FEE_STRUCTURE: FeeStructure;
}

export function buildBacktestRouter(deps: BacktestRouterDeps): Router {
  const router = Router();
  const {
    db,
    backtestRepo,
    runWorkerTask,
    runDisarmedCycle,
    logResearchFinding,
    logger,
    STRATEGY_CATALOG,
    DEFAULT_FEE_STRUCTURE,
  } = deps;

  // ── Audit & Pipeline ────────────────────────────────────────────────────────

  // Audit deterministik (look-ahead, OOS, event replay) yang menulis ResearchFinding
  // (verdict terderivasi, keputusan ADOPT/REJECT tetap milik operator).
  router.post("/api/backtest/audit", async (req, res) => {
    try {
      const { dataset, strategyId = "S-01", mode, slippageBps, tp1ROverride } = req.body ?? {};
      if (!dataset || typeof dataset !== "object") {
        res.status(400).json({ error: "dataset (HistoricalDataset v1) wajib" });
        return;
      }
      const asMode: StrategyMode = mode === "SWING" ? "SWING" : "SCALP";
      const fees: FeeStructure = DEFAULT_FEE_STRUCTURE;
      const opts = {
        slippageBps: typeof slippageBps === "number" ? slippageBps : 5,
        initialEquityUsd: 200,
        targetRiskUsd: 1,
        tp1ROverride: typeof tp1ROverride === "number" ? tp1ROverride : undefined,
      };

      // Worker URL: ../../backtest/ (path disesuaikan karena file ini di api/routes/).
      const validate = (validationType: ValidationWorkerRequest["validationType"]) =>
        runWorkerTask<{ output: unknown }>(new URL("../../backtest/validationWorker.js", import.meta.url),
          { validationType, dataset, strategyId, mode: asMode, fees, options: opts } satisfies ValidationWorkerRequest)
          .then(result => result.output);
      const [lookAhead, oos, events] = await Promise.all([
        validate("lookahead").catch(e => ({ passed: false, reasons: [(e as Error).message] })),
        validate("oos").catch(e => ({ status: "OOS_FAILED", reasons: [(e as Error).message] })),
        validate("events").catch(e => ({ replayErrors: [(e as Error).message] })),
      ]);

      // Verdict terderivasi deterministik dari hasil audit — bukan opini.
      const laPassed = (lookAhead as { passed?: boolean }).passed === true;
      const oosStatus = (oos as { status?: string }).status;
      const verdict: FindingVerdict =
        !laPassed ? "REFUTED"
        : oosStatus === "CONSISTENT" ? "SUPPORTIVE"
        : oosStatus === "DEGRADED" || oosStatus === "OOS_FAILED" ? "REFUTED"
        : "INCONCLUSIVE";

      const findingId = await logResearchFinding({
        title: `Audit ${strategyId} ${asMode} — lookahead:${laPassed ? "PASS" : "FAIL"} OOS:${oosStatus ?? "?"}`,
        hypothesis: `Strategi ${strategyId} (${asMode}) bebas look-ahead bias dan edge-nya bertahan out-of-sample.`,
        experimentType: "OOS_VALIDATION",
        verdict,
        conclusion:
          `Look-ahead audit: ${laPassed ? "LULUS (masa depan tidak mengubah masa lalu)" : "GAGAL — keputusan masa lalu berubah saat data masa depan dimanipulasi"}. ` +
          `OOS: ${oosStatus ?? "?"} (ΔWR ${(oos as { winrateDeltaPct?: number }).winrateDeltaPct ?? "?"}pp, ΔevR ${(oos as { evRDelta?: number }).evRDelta ?? "?"}). ` +
          `Event replay: ${(events as { coveredCount?: number }).coveredCount ?? 0} jendela shock tercakup.`,
        runRefs: [{ kind: "OOS_VALIDATION" as const, label: `${strategyId}-${asMode}-audit` }],
        metrics: {
          lookAheadPassed: laPassed,
          lookAheadDifferences: (lookAhead as { differences?: unknown[] }).differences?.length ?? null,
          oosStatus: oosStatus ?? null,
          oosWinrateDeltaPct: (oos as { winrateDeltaPct?: number }).winrateDeltaPct ?? null,
          oosEvRDelta: (oos as { evRDelta?: number }).evRDelta ?? null,
          eventsCovered: (events as { coveredCount?: number }).coveredCount ?? null,
          eventsNotCovered: ((events as { notCoveredKeys?: string[] }).notCoveredKeys ?? []).join(","),
        },
      });

      res.json({ findingId, verdict, lookAhead, outOfSample: oos, eventReplay: events });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // T-2.9: E2E Pipeline DISARMED (US-01, US-02, NFR-09)
  router.post("/api/pipeline/run-disarmed", async (req, res) => {
    try {
      const result = await runDisarmedCycle(req.body);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Backtest Engine ─────────────────────────────────────────────────────────

  // FR-14 & US-12: Backtest Engine
  router.get("/api/backtest/catalog", (_req, res) => {
    res.json({ strategies: Object.values(STRATEGY_CATALOG) });
  });

  router.post("/api/backtest/run", async (req, res) => {
    try {
      const {
        strategyId = "S-01",
        mode,
        paramsVersion,
        sampleCount,
        fromDate,
        toDate,
        targetWinrate,
        minWinrate,
        minSamples, dataset, maxDrawdownUsd, slippageBps,
      } = req.body ?? {};

      const options = {
        strategyId,
        mode,
        paramsVersion,
        sampleCount: typeof sampleCount === "number" ? sampleCount : 500,
        dataset, maxDrawdownUsd, slippageBps,
        fromDate: fromDate ? new Date(fromDate) : undefined,
        toDate: toDate ? new Date(toDate) : undefined,
        targetWinrate: typeof targetWinrate === "number" ? targetWinrate : undefined,
        minWinrate: Math.max(60, Number(minWinrate) || 60),
        minSamples: Math.max(500, Number(minSamples) || 500),
      };
      // 15 Okt 2026 (Tahap 3 audit): replay berat jalan di WORKER thread — main
      // thread tidak pernah diblokir, supervisor tick tetap jalan. Timeout
      // fail-closed 5 menit; tidak ada hasil fabrikasi saat timeout.
      const { output } = await runWorkerTask<{ output: BacktestRunOutput }>(
        new URL("../../backtest/backtestWorker.js", import.meta.url), { options }, 300_000,
      );

      const runId = await backtestRepo.saveRun(output, db);
      res.json({
        runId,
        strategyId: output.strategyId,
        strategyName: output.strategyName,
        mode: output.mode,
        status: output.status,
        gatePassed: output.gatePassed,
        failedGateReasons: output.failedGateReasons,
        metrics: output.metrics,
        provenance: output.provenance,
        diagnostics: output.diagnostics,
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/api/backtest/runs", async (_req, res) => {
    try {
      if (backtestRepo.getAllRuns().length === 0) {
        await backtestRepo.loadFromDb(db);
      }
      const runs = backtestRepo.getAllRuns().map((r) => ({
        id: r.id,
        strategyId: r.strategyId,
        strategyName: r.strategyName,
        mode: r.mode,
        paramsVersion: r.paramsVersion,
        fromDate: r.fromDate,
        toDate: r.toDate,
        metrics: r.metrics,
        gatePassed: r.gatePassed,
        status: r.status,
        failedGateReasons: r.failedGateReasons,
      }));
      res.json({ runs });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/backtest/runs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "id tidak valid" });
        return;
      }
      let run = backtestRepo.getRun(id);
      if (!run) {
        await backtestRepo.loadFromDb(db);
        run = backtestRepo.getRun(id);
      }
      if (!run) {
        res.status(404).json({ error: "Run tidak ditemukan" });
        return;
      }
      let tradeSample = (run.trades as unknown[])?.slice(0, 50) ?? [];
      if (tradeSample.length === 0 && db?.backtestTrade) {
        const dbTrades = await db.backtestTrade.findMany({
          where: { runId: id },
          take: 50,
          orderBy: { id: "asc" },
        });
        if (dbTrades.length > 0) {
          tradeSample = dbTrades.map((t: any) => ({
            symbol: t.symbol,
            direction: t.direction,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            entryAt: t.entryAt,
            exitAt: t.exitAt,
            exitReason: t.exitReason,
            slPct: 0.01,
            effectiveNotional: 100,
            effectiveRiskUsd: 1,
            grossR: t.rMultiple,
            grossPnlUsd: t.grossPnl,
            feesUsd: t.feesUsd,
            netPnlUsd: t.netPnl,
            netR: t.rMultiple,
            isWin: t.netPnl > 0,
          }));
        }
      }
      res.json({
        id: run.id,
        strategyId: run.strategyId,
        strategyName: run.strategyName,
        mode: run.mode,
        paramsVersion: run.paramsVersion,
        fromDate: run.fromDate,
        toDate: run.toDate,
        metrics: run.metrics,
        distributionR: run.distributionR,
        gatePassed: run.gatePassed,
        status: run.status,
        failedGateReasons: run.failedGateReasons,
        tradeSample,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Scientific Validation Engine Endpoints
  router.post("/api/validation/run", async (req, res) => {
    try {
      const { strategyId, validationType, dataset, mode = "SCALP" } = req.body ?? {};

      if (!strategyId || !validationType) {
        res.status(400).json({ error: "strategyId and validationType are required" });
        return;
      }

      let ds: HistoricalDataset | undefined = dataset;

      // If no dataset provided in body, attempt to load from recent successful backtest run or fail gracefully
      if (!ds) {
         // For MVP, we require explicit dataset injection for rigorous statistical validation.
         // In production, this could fetch from a dedicated DatasetStore service.
         res.status(400).json({
           error: "HistoricalDataset is required for scientific validation. Please provide it in the request body.",
           hint: "Use GET /api/backtest/datasets/{symbol} or upload via CLI tools first."
         });
         return;
      }

      const fees = DEFAULT_FEE_STRUCTURE; // Import or define locally
      const kind = String(validationType).toLowerCase();
      if (kind !== "cpcv" && kind !== "sensitivity" && kind !== "stress") {
        return res.status(400).json({ error: "UNSUPPORTED_VALIDATION_TYPE" });
      }
      const { output: result } = await runWorkerTask<{ output: unknown }>(
        new URL("../../backtest/validationWorker.js", import.meta.url),
        { validationType: kind, dataset: ds, strategyId, mode: mode as StrategyMode, fees } satisfies ValidationWorkerRequest,
      );

      res.json({ success: true, data: result });
    } catch (e) {
      logger.error({ err: e }, "Validation Run Failed");
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
