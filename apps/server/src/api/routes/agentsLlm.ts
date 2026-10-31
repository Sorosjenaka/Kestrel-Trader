// apps/server/src/api/routes/agentsLlm.ts — Batch 7 extraction (FR-26, US-05, US-06, US-10, US-13, NFR-05).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

interface LlmAdapterLike {
  getTrackerState(): {
    provider: string;
    dailyCostUsd: number;
    monthlyUsedUsd: number;
    monthlyBudgetUsd: number;
    isDegraded: boolean;
  };
  callFast(prompt: string, systemPrompt?: string): Promise<unknown>;
  callReason(prompt: string, systemPrompt?: string): Promise<unknown>;
}

interface AgentManagerLike {
  getAgentsList(): unknown;
  askAgent(agentId: string, question: string, context?: unknown): Promise<unknown>;
}

interface ResearchLayerLike {
  runMacroScout(input: unknown): Promise<unknown>;
  runUniverseCurator(input: unknown): Promise<unknown>;
  runRegimeAnalyst(input: unknown): Promise<unknown>;
  runScannerSupervisor(input: unknown): Promise<unknown>;
}

interface DecisionRiskLayerLike {
  runSetupJudge(input: unknown): Promise<unknown>;
  runRiskOfficer(input: unknown): Promise<unknown>;
}

interface SupervisorWatchdogLayerLike {
  runTradeSupervisor(input: unknown): Promise<unknown>;
  runWatchdog(input: unknown): Promise<unknown>;
}

export interface AgentsLlmRouterDeps {
  db: PrismaClient;
  llmAdapter: LlmAdapterLike;
  agentManager: AgentManagerLike;
  researchLayer: ResearchLayerLike;
  decisionRiskLayer: DecisionRiskLayerLike;
  supervisorWatchdogLayer: SupervisorWatchdogLayerLike;
  allAgents: Record<string, unknown>;
  paperDeterministicEntry: boolean;
}

export function buildAgentsLlmRouter(deps: AgentsLlmRouterDeps): Router {
  const router = Router();
  const {
    db,
    llmAdapter,
    agentManager,
    researchLayer,
    decisionRiskLayer,
    supervisorWatchdogLayer,
    allAgents,
    paperDeterministicEntry,
  } = deps;

  // FR-26 & NFR-05: LLM Adapter & Cost Tracker
  router.get("/api/llm/status", (_req, res) => {
    try {
      const status = llmAdapter.getTrackerState();
      res.json({ status });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/llm/chat", async (req, res) => {
    try {
      const { prompt, systemPrompt, kind = "fast" } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: "prompt is required" });

      const result = kind === "reason"
        ? await llmAdapter.callReason(String(prompt), systemPrompt)
        : await llmAdapter.callFast(String(prompt), systemPrompt);

      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-26, US-05, US-10: Research Agents Feed & Evaluation
  router.get("/api/agents/feed", async (req, res) => {
    try {
      const { limit = 20 } = req.query;
      const rows = await db.eventLog.findMany({
        where: { type: "AGENT_DIALOG" },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(limit) || 20, 100),
      });

      const messages = rows.map((r) => {
        try {
          return JSON.parse(r.payload);
        } catch {
          return { text: r.payload, timestamp: r.createdAt.toISOString() };
        }
      });

      res.json({
        messages,
        agents: Object.values(allAgents),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/agents", (_req, res) => {
    try {
      const agents = agentManager.getAgentsList();
      const costStatus = llmAdapter.getTrackerState();
      res.json({
        agents,
        cost: {
          dailyCostUsd: costStatus.dailyCostUsd,
          monthlyUsedUsd: costStatus.monthlyUsedUsd,
          monthlyBudgetUsd: costStatus.monthlyBudgetUsd,
          isDegraded: costStatus.isDegraded,
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/agents/ask", async (req, res) => {
    try {
      const { agentId, question, context } = req.body ?? {};
      if (!agentId || !question) {
        return res.status(400).json({ error: "agentId and question are required" });
      }

      const result = await agentManager.askAgent(String(agentId), String(question), context);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/agents/research/evaluate", async (req, res) => {
    try {
      const { btcTrend = "UP", btcAdx = 28, btc1hChgPct = 0.5, symbol = "BTCUSDT" } = req.body ?? {};

      const macro = await researchLayer.runMacroScout({
        btcTrend,
        btcAdx: Number(btcAdx),
        btc1hChgPct: Number(btc1hChgPct),
        ethTrend: "UP",
        eth1hChgPct: 0.4,
        btcDomChg1hPct: 0.1,
      });

      const universe = await researchLayer.runUniverseCurator({
        totalSymbols: 526,
        cryptoPerpsCount: 526,
        nonCryptoFiltered: 204,
        manualBlacklistCount: 0,
      });

      const regime = await researchLayer.runRegimeAnalyst({
        symbol,
        regime: "TRENDING",
        chopIndex: 42,
        adx: 28,
        shieldActive: false,
      });

      const scanner = await researchLayer.runScannerSupervisor({
        activeWorkers: 50,
        totalPairsScanned: 526,
        candidatesPassed: 3,
        topSymbol: symbol,
        topScore: 84,
      });

      res.json({
        evaluations: { macro, universe, regime, scanner },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-26, US-06: Decision & Risk Agents Evaluation
  router.post("/api/agents/decision/evaluate", async (req, res) => {
    try {
      const {
        symbol = "BTCUSDT",
        side = "LONG",
        mode = "SCALP",
        entryPrice = 60000,
        slPrice = 59400,
        equityUsd = 100,
        zoneScore = 80,
        triggerScore = 75,
        knnProb = 0.65,
        compositeScore = 78,
        regime = "TRENDING",
      } = req.body ?? {};

      const judge = await decisionRiskLayer.runSetupJudge({
        symbol,
        side,
        mode,
        zoneScore: Number(zoneScore),
        triggerScore: Number(triggerScore),
        knnProb: knnProb !== null ? Number(knnProb) : null,
        compositeScore: Number(compositeScore),
        regime,
        paperDeterministicEntry,
      });

      const risk = await decisionRiskLayer.runRiskOfficer({
        symbol,
        side,
        entryPrice: Number(entryPrice),
        slPrice: Number(slPrice),
        equityUsd: Number(equityUsd),
      });

      res.json({
        evaluations: { judge, risk },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-26, US-13: Supervisor & Watchdog Agents Evaluation
  router.post("/api/agents/supervisor/evaluate", async (req, res) => {
    try {
      const {
        positionId = 1,
        symbol = "BTCUSDT",
        side = "LONG",
        event = "TP1_HIT",
        price = 60600,
        entryPrice = 60000,
        context = "HEALTH_OK",
        activeHost = "fapi1.binance.com",
        failsCount = 0,
      } = req.body ?? {};

      const supervisor = await supervisorWatchdogLayer.runTradeSupervisor({
        positionId: Number(positionId),
        symbol,
        side,
        event,
        price: Number(price),
        entryPrice: Number(entryPrice),
      });

      const watchdog = await supervisorWatchdogLayer.runWatchdog({
        context,
        activeHost,
        failsCount: Number(failsCount),
      });

      res.json({
        evaluations: { supervisor, watchdog },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
