// apps/server/tests/tradeHistory.test.ts - Uji endpoint Trade History & Strategy Analytics.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";
import { allowedStrategiesFor } from "../src/exec/slotFillPolicy.js";

describe("Trade History & Strategy Analytics (S-00..S-05)", () => {
  it("GET /api/trades mengembalikan trades terurut, analytics, dan equityCurve", async () => {
    const app = createApp();
    const res = await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(Array.isArray(res.body.trades)).toBe(true);
    expect(res.body.analytics).toBeDefined();
    expect(typeof res.body.analytics.totalTrades).toBe("number");
    expect(typeof res.body.analytics.winRatePct).toBe("number");
    expect(typeof res.body.analytics.profitFactor).toBe("number");
    expect(typeof res.body.analytics.netPnlUsd).toBe("number");
    expect(typeof res.body.analytics.startingEquityUsd).toBe("number");
    expect(typeof res.body.analytics.currentEquityUsd).toBe("number");
    expect(Array.isArray(res.body.analytics.strategyStats)).toBe(true);

    // Verifikasi katalog strategi (renumber 6 Okt 2026): strategi aktif SCALP
    // selalu tampil; bucket display-only (S-00 tanpa jejak, S-99 arsip) HANYA
    // dikirim bila berisi trade — kartu kosong tidak boleh tampil di dashboard
    // (perintah operator 6 Okt 2026).
    const activeStrategyIds = allowedStrategiesFor("SCALP");
    expect(activeStrategyIds.length).toBeGreaterThan(0);
    const stats = res.body.analytics.strategyStats as Array<{ id: string; trades: number }>;
    const stratIds = stats.map((s) => s.id);
    for (const id of activeStrategyIds) expect(stratIds).toContain(id);
    // 16 Okt 2026 (fix panel breakdown): lane SWING (S-05 + S-03) juga wajib
    // punya kartu — sebelumnya hanya allowlist SCALP yang jadi kunci agregasi
    // sehingga S-05 (strategi AKTIF) tidak tampil di dashboard.
    for (const id of allowedStrategiesFor("SWING")) expect(stratIds).toContain(id);
    for (const s of stats) {
      if (s.id === "S-00" || s.id === "S-99") expect(s.trades).toBeGreaterThan(0);
    }
    // Invarian: jumlah trade di kartu = jumlah trade yang dianalisis
    // (tidak ada trade yang hilang dari tampilan kartu).
    expect(stats.reduce((a, s) => a + s.trades, 0)).toBe(res.body.analytics.totalTrades);
    expect(stratIds).not.toContain("S-N/A");

    // T-5.16: provenance data — DEMO dikecualikan dari history & analytics
    expect(res.body.analytics.dataProvenance).toBeDefined();
    expect(res.body.analytics.dataProvenance.includeDemo).toBe(false);
    expect(typeof res.body.analytics.dataProvenance.demoExcludedCount).toBe("number");

    // Verifikasi kurva ekuitas
    expect(Array.isArray(res.body.equityCurve)).toBe(true);
    if (res.body.equityCurve.length > 0) {
      expect(res.body.equityCurve[0].equity).toBe(200.0);
    }
  });

  it("T-5.16: rincian harga ENTRY & EXIT per fill + DEMO disembunyikan dari history", async () => {
    const db = new PrismaClient();
    const stamp = Date.now();
    const symLive = `ZZDETAIL${stamp % 100000}USDT`;
    const symDemo = `ZZDEMO${stamp % 100000}USDT`;
    const base = {
      mode: "SCALP",
      side: "LONG",
      entryPrice: 100,
      qty: 0.35,
      notional: 100 * 0.35,
      leverage: 25,
      marginUsd: 1.4,
      slPrice: 99,
      tp1Price: 101,
      tp2Price: 102,
      beMoved: true,
      tp1FilledAt: new Date(),
      tp2FilledAt: null,
      realizedPnlUsd: 0.64,
      tp1FillPrice: 101,
      status: "CLOSED",
      closedAt: new Date(),
      closeReason: "TP1",
      pnlUsd: 1.2,
      pnlR: 1.2,
      outlookText: "uji detail entry/exit",
      strategyId: "S-02",
      strategyName: "Zona Rejection Scalp",
      entryType: "LIMIT_ZONE",
      zoneType: "DEMAND",
      zoneTop: 101,
      zoneBottom: 99.5,
    };
    try {
      const posLive = await db.position.create({ data: { ...base, symbol: symLive, source: "LIVE_AI" } });
      await db.orderExec.createMany({
        data: [
          { positionId: posLive.id, clientOrderId: `T_${stamp}_ENTRY`, binanceOrderId: `SIM_${stamp}`, symbol: symLive, type: "MARKET", side: "BUY", price: 100, qty: 0.35, reduceOnly: false, status: "FILLED", fillPrice: 100, feeUsd: 0.007, createdAt: new Date(), filledAt: new Date() },
          { positionId: posLive.id, clientOrderId: `T_${stamp}_TP1`, binanceOrderId: `SIM_${stamp + 1}`, symbol: symLive, type: "LIMIT", side: "SELL", price: 101, qty: 0.2275, reduceOnly: true, status: "FILLED", fillPrice: 101, feeUsd: 0.0115, createdAt: new Date(), filledAt: base.tp1FilledAt },
          { positionId: posLive.id, clientOrderId: `T_${stamp}_TP2`, binanceOrderId: `SIM_${stamp + 2}`, symbol: symLive, type: "LIMIT", side: "SELL", price: 102, qty: 0.1225, reduceOnly: true, status: "FILLED", fillPrice: 102, feeUsd: 0.0063, createdAt: new Date(), filledAt: new Date() },
        ],
      });
      await db.trade.create({
        data: { positionId: posLive.id, symbol: symLive, mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 101.5, rMultiple: 1.5, pnlUsd: 1.2, feeUsd: 0.025, win: true, mfeR: 2, maeR: 0, holdMinutes: 30, createdAt: new Date(), strategyId: "S-02", zoneType: "DEMAND", source: "LIVE_AI" },
      });

      const posDemo = await db.position.create({ data: { ...base, symbol: symDemo, source: "DEMO", outlookText: "[DEMO pipeline uji] uji" } });
      await db.trade.create({
        data: { positionId: posDemo.id, symbol: symDemo, mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 102, rMultiple: 2, pnlUsd: 2, feeUsd: 0.02, win: true, mfeR: 2, maeR: 0, holdMinutes: 5, createdAt: new Date(), source: "DEMO" },
      });

      const app = createApp();
      const res = await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200);

      // Data DEMO TIDAK boleh muncul di history
      expect(res.body.trades.some((t: any) => t.symbol === symDemo)).toBe(false);
      expect(res.body.analytics.dataProvenance.demoExcludedCount).toBeGreaterThanOrEqual(1);

      const mine = res.body.trades.find((t: any) => t.symbol === symLive);
      expect(mine).toBeDefined();
      expect(mine.source).toBe("LIVE_AI");
      expect(mine.strategyId).toBe("S-02");
      expect(mine.fillMode).toBe("PAPER"); // executor simulasi -> SIM_*
      // Detail ENTRY: level + fill
      expect(mine.entryDetail.slPrice).toBe(99);
      expect(mine.entryDetail.tp1Price).toBe(101);
      expect(mine.entryDetail.tp2Price).toBe(102);
      expect(mine.entryDetail.entryType).toBe("LIMIT_ZONE");
      expect(mine.entryDetail.zoneType).toBe("DEMAND");
      expect(mine.entryDetail.avgPrice).toBe(100);
      expect(mine.entryDetail.fills).toHaveLength(1);
      expect(mine.entryDetail.fills[0].fillMode).toBe("PAPER");
      // Detail EXIT: 2 fill (TP1 partial + TP2) + harga & alasan
      // RR klasik (29 Sep 2026): label exitReason dinormalisasi "TP" (bukan "TP2").
      expect(mine.exitDetail.fills).toHaveLength(2);
      expect(mine.exitReason).toBe("TP");
      expect(mine.exitDetail.reason).toBe("TP");
      expect(mine.exitDetail.tp1.price).toBe(101);
      expect(mine.exitDetail.tp1.realizedPnlUsd).toBeCloseTo(0.64, 4);
      // 30 Sep 2026: field beMoved dihapus dari exitDetail (SL-ke-BE dihilangkan).
      expect(mine.exitDetail.beMoved).toBeUndefined();
      expect(mine.fees.totalUsd).toBeCloseTo(0.0248, 3);

      // Bersihkan data uji supaya DB test tetap bersih
      await db.orderExec.deleteMany({ where: { positionId: { in: [posLive.id, posDemo.id] } } });
      await db.trade.deleteMany({ where: { positionId: { in: [posLive.id, posDemo.id] } } });
      await db.position.deleteMany({ where: { id: { in: [posLive.id, posDemo.id] } } });
    } finally {
      await db.$disconnect();
    }
  });

  it("POST /api/trades/purge menghapus CLOSED non-strategi, mempertahankan strategi+learnings", async () => {
    const db = new PrismaClient();
    const stamp = Date.now() % 1000000;
    const symKill = `ZZPURGEK${stamp}USDT`.slice(0, 20);
    const symSl = `ZZPURGES${stamp}USDT`.slice(0, 20);
    const basePos = {
      mode: "SCALP",
      side: "LONG",
      entryPrice: 100,
      qty: 0.35,
      notional: 35,
      leverage: 25,
      marginUsd: 1.4,
      slPrice: 99,
      tp1Price: 101,
      tp2Price: 102,
      beMoved: false,
      status: "CLOSED",
      openedAt: new Date(),
      closedAt: new Date(),
      pnlUsd: -1,
      pnlR: -1,
      outlookText: "uji purge",
      strategyId: "S-01",
      source: "LIVE_AI",
    };
    try {
      const posKill = await db.position.create({ data: { ...basePos, symbol: symKill, closeReason: "KILL" } });
      const tradeKill = await db.trade.create({
        data: { positionId: posKill.id, symbol: symKill, mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 100, rMultiple: -0.06, pnlUsd: -0.06, feeUsd: 0.02, win: false, mfeR: 0, maeR: 0.06, holdMinutes: 5, createdAt: new Date(), strategyId: "S-01", source: "LIVE_AI" },
      });
      const learn = await db.learningEntry.create({
        data: { tradeId: tradeKill.id, causeCode: "OTHER", outcome: "LOSS", narrative: "uji purge", lesson: null, agentId: "post-mortem", proposal: null, createdAt: new Date() },
      });
      const posSl = await db.position.create({ data: { ...basePos, symbol: symSl, closeReason: "SL" } });
      await db.trade.create({
        data: { positionId: posSl.id, symbol: symSl, mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 99, rMultiple: -1, pnlUsd: -1, feeUsd: 0.02, win: false, mfeR: 0, maeR: 1, holdMinutes: 10, createdAt: new Date(), strategyId: "S-01", source: "LIVE_AI" },
      });

      const app = createApp();
      const res = await request(app).post("/api/trades/purge").set("x-api-token", "vitest-mutation-token").send({}).expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tradesDeleted).toBeGreaterThanOrEqual(1);
      expect(res.body.positionsDeleted).toBeGreaterThanOrEqual(1);

      // KILL hilang, SL tetap
      expect(await db.trade.findUnique({ where: { id: tradeKill.id } })).toBeNull();
      const slStill = await db.trade.findFirst({ where: { positionId: posSl.id } });
      expect(slStill).not.toBeNull();

      // Learning dipertahankan (yatim, tradeId null)
      const learnKept = await db.learningEntry.findUnique({ where: { id: learn.id } });
      expect(learnKept).not.toBeNull();
      expect(learnKept!.tradeId).toBeNull();

      // Bersihkan sisa uji
      await db.learningEntry.deleteMany({ where: { id: learn.id } });
      await db.trade.deleteMany({ where: { positionId: posSl.id } });
      await db.position.deleteMany({ where: { id: { in: [posKill.id, posSl.id] } } });
    } finally {
      await db.$disconnect();
    }
  });
});
