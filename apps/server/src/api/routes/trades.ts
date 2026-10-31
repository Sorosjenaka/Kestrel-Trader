// apps/server/src/api/routes/trades.ts — Batch 6 extraction (US-13, NFR-12, T-5.16).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

type SummarizePayoffTradesFn = typeof import("../../analytics/payoffDiagnostics.js").summarizePayoffTrades;
type BuildPaperDailySnapshotFn = typeof import("../../analytics/paperDailySnapshot.js").buildPaperDailySnapshot;
type BuildDailySessionsFn = typeof import("../../analytics/paperDailySnapshot.js").buildDailySessions;
type CanonicalStrategyKeyFn = typeof import("../../strategies/strategyCatalog.js").canonicalStrategyKey;
type StrategyDisplayNameFn = typeof import("../../strategies/strategyCatalog.js").strategyDisplayName;
type AllowedStrategiesForFn = typeof import("../../exec/slotFillPolicy.js").allowedStrategiesFor;
type AfterPaperResetFn = typeof import("../../core/paperSession.js").afterPaperReset;
type GetPaperResetAtFn = typeof import("../../core/paperSession.js").getPaperResetAt;

export interface TradesRouterDeps {
  db: PrismaClient;
  getPaperResetAt: GetPaperResetAtFn;
  afterPaperReset: AfterPaperResetFn;
  summarizePayoffTrades: SummarizePayoffTradesFn;
  buildPaperDailySnapshot: BuildPaperDailySnapshotFn;
  buildDailySessions: BuildDailySessionsFn;
  canonicalStrategyKey: CanonicalStrategyKeyFn;
  strategyDisplayName: StrategyDisplayNameFn;
  STRATEGY_NAMES: Record<string, string>;
  allowedStrategiesFor: AllowedStrategiesForFn;
  START_EQUITY_USD: number;
  positionReconciler: { reconcile(): Promise<unknown> };
}

export function buildTradesRouter(deps: TradesRouterDeps): Router {
  const router = Router();
  const {
    db,
    getPaperResetAt,
    afterPaperReset,
    summarizePayoffTrades,
    buildPaperDailySnapshot,
    buildDailySessions,
    canonicalStrategyKey,
    strategyDisplayName,
    STRATEGY_NAMES,
    allowedStrategiesFor,
    START_EQUITY_USD,
    positionReconciler,
  } = deps;

  const handleGetTrades = async (req: any, res: any, modeOverride?: string) => {
    try {
      const paperResetAt = await getPaperResetAt();
      const includeDemo = String(req.query.includeDemo ?? "") === "1";
      const reqMode = String(modeOverride ?? req.query.mode ?? "ALL").toUpperCase();
      const modeFilter = (reqMode === "SCALP" || reqMode === "SWING") ? { mode: reqMode } : {};
      const latestTrades = await db.trade.findMany({
        // T-5.16: data DEMO (pipeline uji) TIDAK pernah masuk history operator.
        where: { ...(includeDemo ? {} : { source: { not: "DEMO" } }), ...modeFilter, ...afterPaperReset(paperResetAt) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { position: { include: { orders: { orderBy: { id: "asc" } } } } },
        take: 200,
      });
      const oldestVisible = latestTrades[latestTrades.length - 1];
      const precedingPnl = oldestVisible ? await db.trade.aggregate({
        _sum: { pnlUsd: true },
        _count: { id: true },
        where: {
          ...(includeDemo ? {} : { source: { not: "DEMO" } }), ...modeFilter, ...afterPaperReset(paperResetAt),
          OR: [{ createdAt: { lt: oldestVisible.createdAt } }, { createdAt: oldestVisible.createdAt, id: { lt: oldestVisible.id } }],
        },
      }) : null;
      const rawTrades = [...latestTrades].reverse();
      const demoExcludedCount = await db.trade.count({ where: { source: "DEMO" } });
      // Full PAPER cohort, independent of the 200-row history display cap and
      // legacy LIVE_AI accounting. Otherwise the visible WR/RR can mix sources.
      const paperRows = await db.trade.findMany({
        where: { source: "PAPER_AI", accountingQuality: "SIMULATED", ...modeFilter, ...afterPaperReset(paperResetAt) },
        select: { pnlUsd: true, rMultiple: true, feeUsd: true, position: { select: { closeReason: true } } },
      });
      const paperPayoff = summarizePayoffTrades(paperRows.map((t) => ({
        pnlUsd: t.pnlUsd, rMultiple: t.rMultiple, feeUsd: t.feeUsd,
        closeReason: t.position?.closeReason ?? null,
      })));
      const paperDayRows = await db.trade.findMany({
        where: { source: { in: ["PAPER_AI", "PAPER_MANUAL"] }, accountingQuality: "SIMULATED", ...afterPaperReset(paperResetAt) },
        select: { createdAt: true, pnlUsd: true, rMultiple: true, mode: true },
      });
      const dailySnapshot = buildPaperDailySnapshot(paperDayRows, new Date(), paperResetAt);
      // Tabel "riwayat semua sesi" (sejak periode PAPER $200): satu baris per
      // sesi 07:00 WIB, dihitung deterministik dari cohort yang SAMA dengan
      // snapshot harian — bukan dari jendela 200 baris tampilan.
      const dailySessions = buildDailySessions(paperDayRows, { startingEquityUsd: START_EQUITY_USD, since: paperResetAt });

      // AUDIT 6 Okt 2026 (opsi 1, perintah operator): statistik agregat dihitung
      // dari SELURUH cohort trade pasca-reset — BUKAN dari 200 baris jendela
      // tampilan. Tanpa ini "total trade" & "profit" dashboard menyempit ke 200
      // trade terakhir sementara equity memakai seluruh data (mismatch yang
      // dilaporkan operator). Tabel tetap 200 terakhir dengan label jujur.
      const fullCohort = await db.trade.findMany({
        where: { ...(includeDemo ? {} : { source: { not: "DEMO" } }), ...modeFilter, ...afterPaperReset(paperResetAt) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { pnlUsd: true, rMultiple: true, win: true, strategyId: true, createdAt: true, mode: true,
          position: { select: { openedAt: true } } },
      });
      let fcGrossProfit = 0, fcGrossLoss = 0, fcWinCount = 0, fcRSum = 0;
      let fcEquity = START_EQUITY_USD, fcPeak = START_EQUITY_USD, fcMaxDd = 0;
      const fcStrategy: Record<string, { trades: number; wins: number; pnl: number }> = {};
      for (const t of fullCohort) {
        if (t.pnlUsd >= 0) fcGrossProfit += t.pnlUsd; else fcGrossLoss += -t.pnlUsd;
        if (t.win) fcWinCount++;
        fcRSum += t.rMultiple;
        fcEquity += t.pnlUsd;
        fcPeak = Math.max(fcPeak, fcEquity);
        fcMaxDd = Math.max(fcMaxDd, fcPeak - fcEquity);
        // Kunci kanonik era-aware (renumber 6 Okt 2026): trade eks S-03/S-04
        // masuk kelompok strategi barunya; era dinilai dari waktu BUKA posisi.
        const key = t.strategyId && t.strategyId !== "S-N/A"
          ? canonicalStrategyKey(t.strategyId, t.position?.openedAt ?? t.createdAt)
          : "S-00";
        const b = (fcStrategy[key] = fcStrategy[key] ?? { trades: 0, wins: 0, pnl: 0 });
        b.trades++; if (t.win) b.wins++; b.pnl += t.pnlUsd;
      }
      const fcTotal = fullCohort.length;

      // SCALP-only (30 Sep 2026): daftar strategi aktif mengikuti allowlist
      // tunggal (env SCALP_STRATEGY_IDS) supaya analytics tidak pernah
      // menampilkan strategi yang tidak dievaluasi lagi.
      // 6 Okt 2026 (renumber 3 strategi): bucket agregasi memakai kunci KANONIK
      // (canonicalStrategyKey) — trade era lama (eks S-03/S-04) terhitung pada
      // strategi barunya, tidak terpecah per nomor.
      // 16 Okt 2026 (audit panel "STRATEGY PERFORMANCE BREAKDOWN"): kartu S-05
      // hilang dari breakdown karena kunci agregasi hanya memakai allowlist
      // SCALP — padahal lane aktif kini SWING. Kunci = UNION SCALP + SWING
      // supaya strategi lane SWING tampil di dashboard; kartu lane mati
      // (S-02 dst) tetap ada untuk audit riwayat.
      // 21 Okt 2026: allowlist SWING = RSW-01/02/03 (S-05 Polaris diarsipkan
      // 21 Okt 2026). Trade lama S-05 tetap masuk lewat bucket arsip "S-99"
      // lewat canonicalStrategyKey — tidak hilang dari histori.
      const ACTIVE_STRATS = [...new Set([...allowedStrategiesFor("SCALP"), ...allowedStrategiesFor("SWING")])];
      const STRAT_KEYS = ["S-00", "S-99", ...ACTIVE_STRATS];
      const STRAT_NAMES: Record<string, string> = {
        "S-00": "Tanpa Jejak Strategi (%)",
        "S-99": "Strategi arsip (nonaktif) (%)",
        ...Object.fromEntries(ACTIVE_STRATS.map((id) => [id, STRATEGY_NAMES[id] ?? id])),
      };

      let runningEquity = Number((START_EQUITY_USD + Number(precedingPnl?._sum.pnlUsd ?? 0)).toFixed(4));
      let peakEquity = runningEquity;
      let maxDrawdownUsd = 0;
      let grossProfit = 0;
      let grossLoss = 0;
      let winCount = 0;

      const equityCurve: Array<{ tradeId: number; time: string; equity: number; pnl: number }> = [
        { tradeId: 0, time: (precedingPnl?._count.id ?? 0) > 0 ? "Prior closed trades" : "Initial", equity: runningEquity, pnl: 0 },
      ];

      const trades = rawTrades.map((t, idx) => {
        // Trade tanpa jejak strategi masuk bucket display-only S-00 (BUKAN strategi).
        // ID mentah tetap ditampilkan apa adanya (fakta history); agregasi memakai
        // kunci kanonik era-aware supaya renumber 6 Okt 2026 tidak memecah statistik.
        // Pemetaan era memakai waktu BUKA posisi (bukan Trade.createdAt yang = waktu
        // TUTUP): posisi yang dibuka dengan nomor lama harus tetap berlabel lama
        // walau ditutup setelah deploy.
        const rawStratId = t.strategyId && t.strategyId !== "S-N/A" ? t.strategyId : null;
        const tradeAt = t.position?.openedAt ?? t.createdAt;
        const stratId = rawStratId ? canonicalStrategyKey(rawStratId, tradeAt) : "S-00";
        // RR klasik (29 Sep 2026): label tunggal "TP" — bukan "TP1"/"TP2"
        // (internal CloseReason supervisor tetap "TP1" demi order phase
        // accounting; API menormalisasi ke "TP" untuk tampilan dashboard).
        const rawReason = t.position?.closeReason || (t.win ? "TP1" : "SL");
        const exitReason = rawReason === "TP1" || rawReason === "TP2" ? "TP" : rawReason;
        const pos = t.position;
        const orders = (pos?.orders ?? []).map((o) => ({
          clientOrderId: o.clientOrderId,
          exchangeOrderId: o.binanceOrderId,
          side: o.side,
          type: o.type,
          qty: o.qty,
          requestPrice: o.price,
          fillPrice: o.fillPrice,
          reduceOnly: o.reduceOnly,
          feeUsd: o.feeUsd,
          status: o.status,
          createdAt: o.createdAt,
          filledAt: o.filledAt,
          // PAPER = eksekusi simulasi (executor tanpa exchange client) / EXCHANGE = order bursa nyata
          fillMode: (o.binanceOrderId ?? "").startsWith("SIM_") ? "PAPER" : "EXCHANGE",
        }));
        const entryFills = orders.filter((o) => !o.reduceOnly);
        const exitFills = orders.filter((o) => o.reduceOnly);
        const weighted = (fills: typeof orders) => {
          const qtySum = fills.reduce((a, f) => a + (f.qty || 0), 0);
          if (!qtySum) return null;
          return Number(
            (fills.reduce((a, f) => a + (f.fillPrice ?? f.requestPrice ?? 0) * (f.qty || 0), 0) / qtySum).toFixed(8)
          );
        };
        const entryAvgFromFills = weighted(entryFills);
        const exitAvgFromFills = weighted(exitFills);
        const entryFeeTotal = Number(entryFills.reduce((a, f) => a + (f.feeUsd || 0), 0).toFixed(4));
        const exitFeeTotal = Number(exitFills.reduce((a, f) => a + (f.feeUsd || 0), 0).toFixed(4));
        const tp1Fill = exitFills.find((f) => pos?.tp1FilledAt && Math.abs((f.filledAt?.getTime() ?? 0) - pos.tp1FilledAt.getTime()) < 5000);

        // pnlUsd di DB sudah NET (gross - fee). feeUsd hanya info, JANGAN dikurangi lagi.
        runningEquity = Number((runningEquity + t.pnlUsd).toFixed(4));
        if (runningEquity > peakEquity) peakEquity = runningEquity;
        const dd = peakEquity - runningEquity;
        if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;

        if (t.pnlUsd > 0) {
          grossProfit += t.pnlUsd;
          winCount++;
        } else {
          grossLoss += Math.abs(t.pnlUsd);
        }

        equityCurve.push({
          tradeId: t.id,
          time: t.createdAt.toISOString(),
          equity: runningEquity,
          pnl: t.pnlUsd,
        });

        return {
          ...t,
          strategyId: rawStratId ?? "S-00",
          strategyKey: stratId,
          strategyName: rawStratId
            ? strategyDisplayName(rawStratId, tradeAt, t.position?.strategyName)
            : "Tanpa Jejak Strategi",
          exitReason,
          cumEquity: runningEquity,
          // T-5.16: provenance + rincian harga entry & exit (setiap fill)
          source: t.source ?? "LIVE_AI",
          fillMode: orders.length && orders.every((o) => o.fillMode === "PAPER") ? "PAPER" : orders.length ? "EXCHANGE" : "PAPER",
          entryDetail: {
            avgPrice: entryAvgFromFills ?? pos?.entryPrice ?? t.entryAvg,
            recordedPrice: pos?.entryPrice ?? t.entryAvg,
            qty: pos ? pos.qty : null,
            notional: pos?.notional ?? null,
            leverage: pos?.leverage ?? null,
            marginUsd: pos?.marginUsd ?? null,
            openedAt: pos?.openedAt ?? t.createdAt,
            slPrice: pos?.slPrice ?? null,
            tp1Price: pos?.tp1Price ?? null,
            tp2Price: pos?.tp2Price ?? null,
            slPct: pos ? Number((Math.abs(pos.entryPrice - pos.slPrice) / pos.entryPrice).toFixed(6)) : null,
            entryType: pos?.entryType ?? null,
            zoneType: pos?.zoneType ?? null,
            zoneTop: pos?.zoneTop ?? null,
            zoneBottom: pos?.zoneBottom ?? null,
            feeUsd: entryFeeTotal,
            fills: entryFills,
          },
          exitDetail: {
            avgPrice: exitAvgFromFills ?? t.exitAvg,
            recordedAvg: t.exitAvg,
            lastFillPrice: exitFills.length ? exitFills[exitFills.length - 1].fillPrice : t.exitAvg,
            reason: exitReason,
            closedAt: pos?.closedAt ?? t.createdAt,
            holdMinutes: t.holdMinutes,
            remainingQty: pos?.qty ?? null,
            feeUsd: exitFeeTotal,
            tp1: {
              price: pos?.tp1FillPrice ?? null,
              filledAt: pos?.tp1FilledAt ?? null,
              qty: tp1Fill?.qty ?? null,
              feeUsd: tp1Fill?.feeUsd ?? null,
              realizedPnlUsd: pos?.realizedPnlUsd ?? null,
            },
            finalSlPrice: pos?.slPrice ?? null,
            fills: exitFills,
          },
          fees: {
            entryUsd: entryFeeTotal,
            exitUsd: exitFeeTotal,
            totalUsd: Number((entryFeeTotal + exitFeeTotal).toFixed(4)),
            recordedUsd: t.feeUsd,
          },
          risk: { riskUsd: t.riskUsd, rMultiple: t.rMultiple, mfeR: t.mfeR, maeR: t.maeR },
          // Opsi (b) 29 Sep 2026: R ternormalisasi ke budget NET ($1 dsb).
          // rMultiple lama tetap GROSS price risk (audit); ini yang sebanding dengan dollar.
          riskBudgetUsd: t.riskBudgetUsd ?? null,
          rMultipleBudget: t.riskBudgetUsd && t.riskBudgetUsd > 0
            ? Number((t.pnlUsd / t.riskBudgetUsd).toFixed(4))
            : null,
          fills: orders,
        };
      });

      // Statistik agregat = SELURUH cohort (audit 6 Okt 2026), bukan jendela tampilan.
      const totalTrades = fcTotal;
      const winRatePct = totalTrades > 0 ? Number(((fcWinCount / totalTrades) * 100).toFixed(1)) : 0;
      const profitFactor = fcGrossLoss > 0 ? Number((fcGrossProfit / fcGrossLoss).toFixed(2)) : fcGrossProfit > 0 ? 99 : 1.0;
      const netPnlUsd = Number((fcGrossProfit - fcGrossLoss).toFixed(4));
      const avgR = totalTrades > 0 ? Number((fcRSum / totalTrades).toFixed(2)) : 0;

      // Strategy breakdown (SELURUH cohort; pembulatan sekali di akhir supaya
      // jumlah kartu presisi — audit 6 Okt 2026 menemukan selisih 4 sen akibat
      // pembulatan per-langkah).
      // PERINTAH OPERATOR 6 Okt 2026: bucket display-only (S-00 tanpa jejak,
      // S-99 arsip) TIDAK dikirim bila kosong — kartu kosong tidak boleh tampil
      // di dashboard (sekalian mengalahkan bundle lama yang masih di cache
      // browser: tidak ada baris = tidak ada yang bisa dirender).
      const strategyStats: Record<string, { id: string; name: string; trades: number; wins: number; pnl: number; winRate: number }> = {};
      STRAT_KEYS.forEach((k) => {
        const b = fcStrategy[k];
        if ((k === "S-00" || k === "S-99") && !(b && b.trades > 0)) return;
        strategyStats[k] = {
          id: k, name: STRAT_NAMES[k],
          trades: b?.trades ?? 0, wins: b?.wins ?? 0,
          pnl: Number((b?.pnl ?? 0).toFixed(2)),
          winRate: b && b.trades > 0 ? Number(((b.wins / b.trades) * 100).toFixed(1)) : 0,
        };
      });

      const analytics = {
        totalTrades,
        // Jendela tampilan tabel (200 baris terakhir) vs seluruh cohort — audit
        // 6 Okt 2026: label harus jujur supaya jumlah baris tidak dikira total.
        visibleTrades: trades.length,
        winCount: fcWinCount,
        lossCount: totalTrades - fcWinCount,
        winRatePct,
        netPnlUsd,
        profitFactor,
        maxDrawdownUsd: Number(fcMaxDd.toFixed(2)),
        startingEquityUsd: START_EQUITY_USD,
        currentEquityUsd: runningEquity,
        avgR,
        paperPayoff,
        dataProvenance: {
          includeDemo,
          demoExcludedCount,
          note: "Data DEMO (pipeline uji POST /api/pipeline/run-disarmed) tidak pernah dihitung di history/analytics.",
        },
        strategyStats: Object.values(strategyStats),
        mode: reqMode,
        byMode: await (async () => {
          const allCohort = (reqMode === "SCALP" || reqMode === "SWING")
            ? await db.trade.findMany({
                where: { ...(includeDemo ? {} : { source: { not: "DEMO" } }), ...afterPaperReset(paperResetAt) },
                select: { pnlUsd: true, rMultiple: true, win: true, strategyId: true, mode: true },
              })
            : fullCohort;

          const calcMode = (modeName: string) => {
            const subset = allCohort.filter((t) => t.mode === modeName);
            let gp = 0, gl = 0, wc = 0, rTot = 0;
            for (const t of subset) {
              if (t.pnlUsd >= 0) gp += t.pnlUsd; else gl += -t.pnlUsd;
              if (t.win) wc++;
              rTot += t.rMultiple;
            }
            const cnt = subset.length;
            return {
              totalTrades: cnt,
              winCount: wc,
              lossCount: cnt - wc,
              winRatePct: cnt > 0 ? Number(((wc / cnt) * 100).toFixed(1)) : 0,
              netPnlUsd: Number((gp - gl).toFixed(2)),
              profitFactor: gl > 0 ? Number((gp / gl).toFixed(2)) : gp > 0 ? 99 : 1.0,
              avgR: cnt > 0 ? Number((rTot / cnt).toFixed(2)) : 0,
            };
          };

          return {
            SCALP: calcMode("SCALP"),
            SWING: calcMode("SWING"),
          };
        })(),
      };

      res.json({
        trades: [...trades].reverse(), // latest first
        analytics,
        equityCurve,
        dailySnapshot,
        dailySessions,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  };

  router.get("/api/trades", (req, res) => handleGetTrades(req, res));
  router.get("/api/trades/scalp", (req, res) => handleGetTrades(req, res, "SCALP"));
  router.get("/api/trades/swing", (req, res) => handleGetTrades(req, res, "SWING"));

  // NFR-04, NFR-12, US-13: Reconcile & EventLog
  router.post("/api/reconcile", async (_req, res) => {
    try {
      const report = await positionReconciler.reconcile();
      res.json({ report });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
