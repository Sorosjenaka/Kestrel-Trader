/**
 * Test Suite: Backtest Engine Fee-Aware & Strategy Gate (FR-14, NFR-09, US-12, PRD 5.1).
 */
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  STRATEGY_CATALOG,
  simulateTrade,
  calculateMetrics,
  calculateRDistribution,
  evaluateBacktestGate,
  generateSyntheticTrades,
  runStrategyBacktest,
  backtestRepo,
} from "../src/backtest/backtestEngine.js";

import { MAKER_RATE, TAKER_RATE } from "../src/config/costs.js";

describe("FR-14 & US-12: Backtest Engine Fee-Aware & Strategy Gate S-01/S-02/S-03", () => {
  beforeEach(() => {
    backtestRepo.clear();
  });

  describe("Katalog Strategi (PRD Bagian 5.1)", () => {
    it("memuat 7 entri: S-01/S-02/S-04/S-05 + RSW-01/02/03 (S-03 dihapus 20 Okt 2026)", () => {
      const ids = Object.keys(STRATEGY_CATALOG);
      // 20 Okt 2026 (perintah operator "untuk yang fibo tolong hapus itu"):
      // S-03 Fibonacci DIHAPUS TOTAL dari katalog backtest. S-04 tetap ada
      // sebagai ARSIP-REPLAY (defaultActive=false) — bukan entry source aktif.
      expect(ids).toEqual(["S-01", "S-02", "S-04", "S-05", "RSW-01", "RSW-02", "RSW-03"]);
      // S-03 benar-benar tidak ada (bukan cuma disembunyikan).
      expect(ids).not.toContain("S-03");
      expect(STRATEGY_CATALOG["S-03"]).toBeUndefined();
    });

    it("mengonfigurasi mode dan approval sesuai spesifikasi", () => {
      expect(STRATEGY_CATALOG["S-01"]!.mode).toBe("SCALP");
      expect(STRATEGY_CATALOG["S-02"]!.mode).toBe("SCALP");
      // S-04 = arsip-replay: TIDAK boleh jadi entry source aktif.
      expect(STRATEGY_CATALOG["S-04"]!.mode).toBe("SCALP");
      expect(STRATEGY_CATALOG["S-04"]!.defaultActive).toBe(false);
      expect(STRATEGY_CATALOG["S-04"]!.requiresOperatorApproval).toBe(true);
      expect(STRATEGY_CATALOG["S-04"]!.description).toMatch(/ARSIP-REPLAY/i);

      expect(STRATEGY_CATALOG["S-01"]!.requiresOperatorApproval).toBe(false);
      expect(STRATEGY_CATALOG["S-02"]!.requiresOperatorApproval).toBe(false);
      // 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05
      // jadi arsip-replay: TIDAK boleh jadi entry source aktif, tapi tetap
      // bisa direplay historis (operator akan meracik backtest).
      expect(STRATEGY_CATALOG["S-05"]!.mode).toBe("SWING");
      expect(STRATEGY_CATALOG["S-05"]!.defaultActive).toBe(false);
      expect(STRATEGY_CATALOG["S-05"]!.requiresOperatorApproval).toBe(true);
      expect(STRATEGY_CATALOG["S-05"]!.description).toMatch(/ARSIP-REPLAY/i);
      for (const id of ["RSW-01", "RSW-02", "RSW-03"]) {
        expect(STRATEGY_CATALOG[id]!.mode).toBe("SWING");
      }
    });
  });

  describe("Fee-Aware Trade Simulation (FR-14, Rules.md Bagian 4)", () => {
    it("menghitung notional dan fee maker untuk single TP (+1R) scalp", () => {
      const trade = simulateTrade({
        symbol: "BTCUSDT",
        direction: "LONG",
        entryPrice: 100,
        slPrice: 99,
        tp1Price: 101,
        tp2Price: 102,
        entryAt: new Date("2026-01-01T00:00:00Z"),
        mode: "SCALP",
        outcomeReason: "TP1",
      });

      expect(trade.effectiveNotional).toBe(100);
      expect(trade.effectiveRiskUsd).toBe(1);
      // Single target: 100% keluar di TP1, jadi gross R = rr1 (bukan 0.65/0.35).
      expect(trade.grossR).toBe(1);
      expect(trade.grossPnlUsd).toBe(1);
      expect(trade.isWin).toBe(true);
      // T-18: fee mengikuti costs.ts (FEE_RATE=0 saat ini) — bukan literal 0.0002.
      // Entry maker + exit maker pada notional 100/101.
      expect(trade.feesUsd).toBeCloseTo(100 * MAKER_RATE + 101 * MAKER_RATE, 6);
      expect(trade.netPnlUsd).toBeCloseTo(trade.grossPnlUsd - trade.feesUsd, 4);
      expect(trade.netR).toBeCloseTo(trade.netPnlUsd / 1.0, 4);
    });

    it("mengabaikan TP2 struktural: exit penuh di TP1 (single target)", () => {
      const trade = simulateTrade({
        symbol: "ETHUSDT",
        direction: "LONG",
        entryPrice: 100,
        slPrice: 99,
        tp1Price: 101,
        tp2Price: 103, // +3R struktural -> diabaikan karena single target
        entryAt: new Date("2026-01-01T00:00:00Z"),
        mode: "SCALP",
        outcomeReason: "TP1",
      });

      expect(trade.grossR).toBe(1);
      expect(trade.grossPnlUsd).toBe(1);
      expect(trade.isWin).toBe(true);
      expect(trade.netPnlUsd).toBeLessThanOrEqual(1); // FEE_RATE=0 -> net == gross
    });

    it("menghitung Stop Loss (SL) dengan taker fee 0.05%", () => {
      const trade = simulateTrade({
        symbol: "SOLUSDT",
        direction: "LONG",
        entryPrice: 100,
        slPrice: 99,
        tp1Price: 101,
        tp2Price: 102,
        entryAt: new Date("2026-01-01T00:00:00Z"),
        mode: "SCALP",
        outcomeReason: "SL",
      });

      expect(trade.grossR).toBe(-1.0);
      expect(trade.grossPnlUsd).toBe(-1.0);
      expect(trade.isWin).toBe(false);
      expect(trade.netPnlUsd).toBeLessThanOrEqual(-1.0); // FEE_RATE=0 -> net == gross
      // Entry maker + exit taker pada notional 100/99.
      expect(trade.feesUsd).toBeCloseTo(100 * MAKER_RATE + 99 * TAKER_RATE, 6);
    });

    it("membatasi notional jika margin melebihi 40% equity", () => {
      const trade = simulateTrade({
        symbol: "BTCUSDT",
        direction: "LONG",
        entryPrice: 100,
        slPrice: 99.9,
        tp1Price: 100.1,
        tp2Price: 100.2,
        entryAt: new Date("2026-01-01T00:00:00Z"),
        mode: "SCALP",
        outcomeReason: "SL",
        equityUsd: 50,
      });

      expect(trade.effectiveNotional).toBeLessThanOrEqual(500.01);
      expect(trade.effectiveRiskUsd).toBeLessThanOrEqual(0.51);
    });
  });

  describe("Distribusi R & Max Drawdown", () => {
    it("generator fixture mengikuti RR TP1 policy mode terbaru", () => {
      const scalp = generateSyntheticTrades("S-01", "SCALP", 1, 100)[0]!;

      expect(scalp.exitReason).toBe("TP1");
      // 11 Okt 2026: TP SCALP = 1.7R pada risiko $1.00 (maks $1.2) / target $1.70.
      expect(scalp.grossR).toBeCloseTo(1.7, 4);
    });

    it("mengelompokkan netR ke dalam 6 bucket distribusi R", () => {
      const trades = generateSyntheticTrades("S-01", "SCALP", 50, 60.0);
      const dist = calculateRDistribution(trades);

      expect(dist.length).toBe(6);
      const totalCount = dist.reduce((acc, d) => acc + d.count, 0);
      expect(totalCount).toBe(50);
      const totalPct = dist.reduce((acc, d) => acc + d.pct, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    });

    it("menghitung metrik agregat dan max drawdown", () => {
      const trades = generateSyntheticTrades("S-01", "SCALP", 100, 65.0);
      const metrics = calculateMetrics(trades);

      expect(metrics.sampleCount).toBe(100);
      expect(metrics.winrate).toBeGreaterThan(50);
      expect(metrics.maxDdUsd).toBeGreaterThanOrEqual(0);
      expect(metrics.totalFeesUsd).toBeGreaterThanOrEqual(0); // T-18: FEE_RATE=0 -> 0 diizinkan
      expect(metrics.totalNetPnlUsd).toBeCloseTo(
        metrics.totalGrossPnlUsd - metrics.totalFeesUsd,
        2
      );
    });
  });

  describe("Gate Backtest FR-14 / AC-12 (Winrate >= 60%, EV bersih-fee > 0, Samples >= 1.000)", () => {
    it("menolak strategi jika sampel < 500", () => {
      const metrics = {
        sampleCount: 499,
        winCount: 349,
        lossCount: 150,
        winrate: 70.0,
        evUsd: 0.35,
        evR: 0.35,
        maxDdUsd: 5.0,
        totalGrossPnlUsd: 180,
        totalFeesUsd: 5,
        totalFundingUsd: 0,
        totalNetPnlUsd: 175,
      };

      const gate = evaluateBacktestGate(metrics);
      expect(gate.gatePassed).toBe(false);
      expect(gate.failedGateReasons).toContain("SAMPLES_LT_500");
    });

    it("menolak strategi jika winrate < 60%", () => {
      const metrics = {
        sampleCount: 1000,
        winCount: 550,
        lossCount: 450,
        winrate: 55.0,
        evUsd: 0.05,
        evR: 0.05,
        maxDdUsd: 10.0,
        totalGrossPnlUsd: 80,
        totalFeesUsd: 30,
        totalFundingUsd: 0,
        totalNetPnlUsd: 50,
      };

      const gate = evaluateBacktestGate(metrics);
      expect(gate.gatePassed).toBe(false);
      expect(gate.failedGateReasons).toContain("WINRATE_LT_60_PCT");
    });

    it("menolak strategi jika EV bersih-fee <= 0", () => {
      const metrics = {
        sampleCount: 1000,
        winCount: 610,
        lossCount: 390,
        winrate: 61.0,
        evUsd: -0.02,
        evR: -0.02,
        maxDdUsd: 25.0,
        totalGrossPnlUsd: 10,
        totalFeesUsd: 30,
        totalFundingUsd: 0,
        totalNetPnlUsd: -20,
      };

      const gate = evaluateBacktestGate(metrics);
      expect(gate.gatePassed).toBe(false);
      expect(gate.failedGateReasons).toContain("EV_NET_FEE_LE_0");
    });

    it("meloloskan strategi jika memenuhi semua kriteria gate", () => {
      const metrics = {
        sampleCount: 1000,
        winCount: 650,
        lossCount: 350,
        winrate: 65.0,
        evUsd: 0.25,
        evR: 0.25,
        maxDdUsd: 4.5,
        totalGrossPnlUsd: 280,
        totalFeesUsd: 30,
        totalFundingUsd: 0,
        totalNetPnlUsd: 250,
      };

      const gate = evaluateBacktestGate(metrics);
      expect(gate.gatePassed).toBe(true);
      expect(gate.failedGateReasons.length).toBe(0);
    });

    it("menjalankan simulasi 1.000 sampel penuh untuk S-01", () => {
      const res = runStrategyBacktest({
        strategyId: "S-01",
        sampleCount: 1000,
        targetWinrate: 65.0,
      });

      expect(res.strategyId).toBe("S-01");
      expect(res.metrics.sampleCount).toBe(0);
      expect(res.failedGateReasons).toContain("INSUFFICIENT_DATA");
      expect(res.gatePassed).toBe(false);
      expect(res.status).toBe("FAILED");
    });
  });

  describe("REST Endpoints (Schema.md 2.1)", () => {
    it("GET /api/backtest/catalog mengembalikan 7 entri (S-03 dihapus 20 Okt 2026)", async () => {
      const app = createApp();
      const res = await request(app).get("/api/backtest/catalog").set("x-api-token", "vitest-mutation-token").expect(200);

      expect(res.body.strategies.length).toBe(7);
      const ids = res.body.strategies.map((s: any) => s.id);
      expect(ids).toContain("S-01");
      expect(ids).toContain("S-02");
      // S-04 tetap ada sebagai arsip-replay, tapi tidak defaultActive.
      expect(ids).toContain("S-04");
      expect(res.body.strategies.find((s: any) => s.id === "S-04").defaultActive).toBe(false);
      // S-03 dihapus total -> tidak boleh muncul di endpoint katalog.
      expect(ids).not.toContain("S-03");
      expect(ids).toContain("S-05");
      expect(ids).toContain("RSW-01");
      expect(ids).toContain("RSW-02");
      expect(ids).toContain("RSW-03");
    });

    it("POST /api/backtest/run dengan S-03 (dihapus) -> 400 Bad Request (tidak ada entry source)", async () => {
      const app = createApp();
      // 20 Okt 2026: S-03 dihapus dari katalog -> endpoint WAJIB menolak
      // dengan 400, bukan diam-diam menjalankan strategi lain.
      const res = await request(app).post("/api/backtest/run").set("x-api-token", "vitest-mutation-token")
        .send({ strategyId: "S-03", sampleCount: 1000, targetWinrate: 63.0 })
        .expect(400);
      expect(String(res.body?.error ?? "")).toMatch(/S-03|unknown/i);
    });

    it("POST /api/backtest/run menjalankan backtest dan menyimpan ke repository", async () => {
      const app = createApp();
      // Pakai S-05 (entry source aktif lane SWING) — S-03 sudah dihapus.
      const res = await request(app).post("/api/backtest/run").set("x-api-token", "vitest-mutation-token")
        .send({
          strategyId: "S-05",
          sampleCount: 1000,
          targetWinrate: 63.0,
        })
        .expect(200);

      expect(res.body.runId).toBeDefined();
      expect(res.body.strategyId).toBe("S-05");
      expect(res.body.metrics.sampleCount).toBe(0);
      expect(res.body.status).toBe("FAILED");
      expect(res.body.gatePassed).toBe(false);

      const listRes = await request(app).get("/api/backtest/runs").set("x-api-token", "vitest-mutation-token").expect(200);
      expect(listRes.body.runs.length).toBe(1);
      expect(listRes.body.runs[0].strategyId).toBe("S-05");

      const detailRes = await request(app).get(`/api/backtest/runs/${res.body.runId}`).set("x-api-token", "vitest-mutation-token").expect(200);
      expect(detailRes.body.id).toBe(res.body.runId);
      expect(detailRes.body.distributionR.length).toBe(6);
      expect(detailRes.body.tradeSample.length).toBe(0);
    });

    it("POST /api/backtest/run menandai FAILED bila winrate tidak lolos gate", async () => {
      const app = createApp();
      const res = await request(app).post("/api/backtest/run").set("x-api-token", "vitest-mutation-token")
        .send({
          strategyId: "S-02",
          sampleCount: 1000,
          targetWinrate: 45.0,
        })
        .expect(200);

      expect(res.body.status).toBe("FAILED");
      expect(res.body.gatePassed).toBe(false);
      expect(res.body.failedGateReasons).toContain("WINRATE_LT_60_PCT");
    });
  });
});
