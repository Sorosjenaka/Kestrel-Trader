// apps/server/src/api/routes/dashboard.ts — dashboard extraction (T-12/CP-4, FR-29 & US-09, FR-31 & US-08).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { FillRow } from "../../analytics/executionQuality.js";

type SummarizeExecutionQualityFn = typeof import("../../analytics/executionQuality.js").summarizeExecutionQuality;
type GetPaperResetAtFn = typeof import("../../core/paperSession.js").getPaperResetAt;
type AfterPaperResetFn = typeof import("../../core/paperSession.js").afterPaperReset;

interface GuardStatusLike {
  dailyPnlUsd: number;
  cumulativePnlUsd: number;
  drawdownUsd: number;
}

interface DailyRiskGuardLike {
  evaluateStatus(candidateSymbol?: string): Promise<GuardStatusLike>;
}

interface MarketsServiceLike {
  getTopMovers(opts: { limit: number; all: boolean }): { gainers: unknown[]; losers: unknown[] };
}

interface BinanceHubLike {
  getHubPrices(symbols: string[]): { map: Record<string, { m?: number; p?: number; c?: number; v?: number; h?: number; l?: number }> };
  /** 25 Okt 2026 (FASE 4): kline asli untuk /api/chart/data (bukan sintetis). */
  fetchKlines(symbol: string, interval?: string, limit?: number): Promise<unknown[]>;
}

interface LlmTrackerStateLike {
  provider: string;
  dailyCostUsd: number;
  monthlyBudgetUsd: number;
  monthlyUsedUsd: number;
  degradeThresholdPct: number;
  isDegraded: boolean;
  totalCalls: number;
  fallbackCalls: number;
}

interface LlmTrackerLike {
  getTrackerState(): LlmTrackerStateLike;
}

export interface DashboardRouterDeps {
  db: PrismaClient;
  summarizeExecutionQuality: SummarizeExecutionQualityFn;
  getPaperResetAt: GetPaperResetAtFn;
  afterPaperReset: AfterPaperResetFn;
  dailyRiskGuard: DailyRiskGuardLike;
  marketsService: MarketsServiceLike;
  binance: BinanceHubLike;
  llmAdapter: LlmTrackerLike;
  START_EQUITY_USD: number;
}

export function buildDashboardRouter(deps: DashboardRouterDeps): Router {
  const router = Router();
  const {
    db,
    summarizeExecutionQuality,
    getPaperResetAt,
    afterPaperReset,
    dailyRiskGuard,
    marketsService,
    binance,
    llmAdapter,
    START_EQUITY_USD,
  } = deps;

  // T-12 (CP-4): kualitas eksekusi — slippage realisasi vs harga order + latensi.
  router.get("/api/execution-quality", async (req, res) => {
    try {
      const daysRaw = Number(req.query.days ?? 7);
      const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.trunc(daysRaw))) : 7;
      const limitRaw = Number(req.query.limit ?? 2000);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10000, Math.trunc(limitRaw))) : 2000;
      const since = new Date(Date.now() - days * 24 * 60 * 60_000);
      const rows = await db.orderExec.findMany({
        where: { status: "FILLED", fillPrice: { not: null }, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true, symbol: true, type: true, side: true, price: true, fillPrice: true,
          qty: true, feeUsd: true, simulated: true, createdAt: true, filledAt: true,
        },
      });
      const buckets = summarizeExecutionQuality(rows as FillRow[]);
      res.json({ windowDays: days, n: rows.length, buckets });
    } catch (err) {
      res.status(500).json({ error: "gagal menghitung execution quality", detail: (err as Error)?.message });
    }
  });

  // FR-29 & US-09: Dashboard Overview (+ kurva equity & floating real-time)
  router.get("/api/overview", async (_req, res) => {
    try {
      const paperResetAt = await getPaperResetAt();
      const guardStatus = await dailyRiskGuard.evaluateStatus();
      const openPositions = await db.position.findMany({
        // T-5.16: DEMO (pipeline uji) tidak ditampilkan/dihitung di overview.
        where: { status: "OPEN", source: { not: "DEMO" } },
        orderBy: { openedAt: "desc" },
      });
      const topMovers = marketsService.getTopMovers({ limit: 5, all: false });

      const startingEquity = START_EQUITY_USD;
      // Equity = modal + PnL trade CLOSED + realized TP1 posisi OPEN.
      // Realized TP1 SUDAH masuk equity saat TP1 hit (bukan floating lagi).
      const openRealizedAgg = await db.position.aggregate({
        _sum: { realizedPnlUsd: true },
        where: { status: "OPEN", source: { not: "DEMO" } },
      });
      const openRealizedTotal = Number(openRealizedAgg._sum.realizedPnlUsd ?? 0);
      const currentEquity = Number((startingEquity + guardStatus.cumulativePnlUsd).toFixed(2));

      // Kurva pertumbuhan equity dari histori trade tertutup (pnlUsd sudah NET, termasuk fee).
      const closedTrades = await db.trade.findMany({
        where: { source: { not: "DEMO" }, ...afterPaperReset(paperResetAt) },
        orderBy: { createdAt: "asc" },
        select: { pnlUsd: true, feeUsd: true, createdAt: true },
        take: 500,
      });
      let runEq = startingEquity;
      const equityCurve: Array<{ t: string; equity: number }> = [
        { t: new Date(0).toISOString(), equity: startingEquity },
      ];
      for (const tr of closedTrades) {
        runEq = Number((runEq + tr.pnlUsd).toFixed(4));
        equityCurve.push({ t: tr.createdAt.toISOString(), equity: runEq });
      }

      // Floating real-time sisa posisi (qty sudah 35% pasca-TP1) via hub harga live.
      const hubSyms = openPositions.map((p) => p.symbol);
      const { map: hubMap } = binance.getHubPrices(hubSyms);
      const floatingPerPosition = openPositions.map((p) => {
        const live = hubMap[p.symbol]?.m ?? hubMap[p.symbol]?.p ?? 0;
        const mark = live > 0 ? live : p.entryPrice;
        const isL = p.side === "LONG";
        const pnl = Number(((isL ? mark - p.entryPrice : p.entryPrice - mark) * p.qty).toFixed(4));
        return { id: p.id, symbol: p.symbol, side: p.side, pnlUsd: pnl, live: live > 0 };
      });
      const floatingTotalUsd = Number(floatingPerPosition.reduce((a, f) => a + f.pnlUsd, 0).toFixed(4));

      res.json({
        equity: {
          startingUsd: startingEquity,
          currentUsd: currentEquity,
          // Profit TP1 yang sudah terkunci (realized, bukan floating).
          realizedOpenPnlUsd: openRealizedTotal,
          // Total equity live = equity guard + realized TP1 posisi OPEN.
          liveEquityUsd: Number((currentEquity + openRealizedTotal).toFixed(2)),
          dailyPnlUsd: guardStatus.dailyPnlUsd,
          cumulativePnlUsd: guardStatus.cumulativePnlUsd,
          drawdownUsd: guardStatus.drawdownUsd,
        },
        equityCurve,
        floating: {
          // Floating HANYA sisa 35% qty berjalan (profit TP1 tidak ikut sini).
          totalPnlUsd: floatingTotalUsd,
          positions: floatingPerPosition,
        },
        guard: guardStatus,
        positions: openPositions,
        llm: (() => {
          const status = llmAdapter.getTrackerState();
          return {
            provider: status.provider,
            dailyCostUsd: status.dailyCostUsd,
            monthlyBudgetUsd: status.monthlyBudgetUsd,
            monthlyUsedUsd: status.monthlyUsedUsd,
            degradeThresholdPct: status.degradeThresholdPct,
            degraded: status.isDegraded,
            successfulCalls: status.totalCalls,
            failedCalls: status.fallbackCalls,
          };
        })(),
        topMovers: {
          gainers: topMovers.gainers,
          losers: topMovers.losers,
        },
        refreshedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-31 & US-08: Positions & Chart Data
  router.get("/api/chart/data", async (req, res) => {
    try {
      const { symbol = "BTCUSDT", positionId } = req.query;
      let pos = null;
      if (positionId) {
        pos = await db.position.findUnique({
          where: { id: Number(positionId) },
          include: { orders: true, trade: true },
        });
      } else {
        pos = await db.position.findFirst({
          where: { symbol: String(symbol).toUpperCase(), status: "OPEN" },
          orderBy: { openedAt: "desc" },
          include: { orders: true, trade: true },
        });
      }

      const sym = pos ? pos.symbol : String(symbol).toUpperCase();
      // 25 Okt 2026 (FASE 4, perintah operator): kline ASLI Binance Futures —
      // TIDAK ADA lagi candle sintetis/Math.random di jalur production.
      // Sumber gagal = 503 KLINE_SOURCE_UNAVAILABLE (jelas), bukan angka buatan.
      // Param opsional: interval (default 1m), limit (default 30, maks 500),
      // market (futures default; "spot" memakai sumber yang sama utk saat ini
      // karena chart posisi selalu derivatif). Timestamp = asli dari bursa.
      const interval = String(req.query.interval ?? "1m").replace(/[^a-zA-Z0-9]/g, "") || "1m";
      const limitQ = Number.parseInt(String(req.query.limit ?? "30"), 10);
      const limit = Math.min(Math.max(Number.isFinite(limitQ) ? limitQ : 30, 1), 500);
      let raw: unknown[];
      try {
        raw = await binance.fetchKlines(sym, interval, limit);
      } catch (e) {
        res.status(503).json({
          error: "KLINE_SOURCE_UNAVAILABLE",
          detail: `sumber kline ${sym} ${interval} gagal: ${(e as Error).message.slice(0, 200)}`,
        });
        return;
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        res.status(503).json({
          error: "KLINE_SOURCE_UNAVAILABLE",
          detail: `respons kline ${sym} ${interval} kosong dari sumber`,
        });
        return;
      }
      const klines = raw.map((k) => {
        const row = k as unknown[];
        return {
          time: Math.floor(Number(row[0]) / 1000),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
        };
      });
      const currentPrice = klines[klines.length - 1]!.close;

      // Level (entry/SL/TP): dari posisi bila ada; bila tidak ada, ILUSTRATIF
      // dari harga asli terakhir dan DITANDAI apa adanya (bukan data tersembunyi).
      const slPrice = pos ? pos.slPrice : Number((currentPrice * 0.99).toFixed(8));
      const tp1Price = pos ? pos.tp1Price : Number((currentPrice * 1.01).toFixed(8));
      const tp2Price = pos ? pos.tp2Price : Number((currentPrice * 1.025).toFixed(8));
      const levelsSource = pos ? "POSITION" : "ILLUSTRATIVE_NO_POSITION";

      const outlook = pos?.outlookText || "Outlook belum tersedia: tidak ada posisi terpilih atau teks analisis untuk simbol ini.";

      const markers = pos
        ? [
            {
              time: Math.floor(pos.openedAt.getTime() / 1000),
              position: pos.side === "LONG" ? "belowBar" : "aboveBar",
              color: "#3B82F6",
              shape: pos.side === "LONG" ? "arrowUp" : "arrowDown",
              text: `ENTRY ${pos.side} @ ${pos.entryPrice}`,
            },
            ...(pos.tp1FilledAt
              ? [
                  {
                    time: Math.floor(pos.tp1FilledAt.getTime() / 1000),
                    position: "aboveBar",
                    color: "#10B981",
                    shape: "circle",
                    text: `TP HIT -> 100% posisi ditutup (single target)`,
                  },
                ]
              : []),
          ]
        : [];

      res.json({
        symbol: sym,
        position: pos,
        levels: {
          entry: pos ? pos.entryPrice : currentPrice,
          sl: slPrice,
          tp1: tp1Price,
          tp2: tp2Price,
        },
        // 25 Okt 2026 (FASE 4): sumber data ditandai eksplisit — level tanpa
        // posisi ILUSTRATIF (harga asli × persentase tetap), bukan data posisi.
        levelsSource,
        klineSource: `binance_futures:${interval}:${klines.length}`,
        currentPrice,
        outlook,
        klines,
        markers,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
