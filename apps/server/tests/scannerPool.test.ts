import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";
import {
  calculatePercentile,
  CandidateItem,
  ScannerPool,
} from "../src/scanner/scannerPool.js";

describe("T-1.6 Scanner Pool & NFR-01 Metrik Siklus", () => {
  afterAll(async () => {
    await db.setupCandidate.deleteMany({
      where: { symbol: { startsWith: "TEST_" } },
    });
  });

  describe("calculatePercentile", () => {
    it("menangani array kosong dan array satu elemen", () => {
      expect(calculatePercentile([], 95)).toBe(0);
      expect(calculatePercentile([42], 95)).toBe(42);
      expect(calculatePercentile([42], 50)).toBe(42);
    });

    it("menghitung p50, p90, dan p95 dengan benar pada distribusi berurutan", () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(calculatePercentile(values, 50)).toBe(50);
      expect(calculatePercentile(values, 90)).toBe(90);
      expect(calculatePercentile(values, 95)).toBe(95);
      expect(calculatePercentile(values, 99)).toBe(99);
    });
  });

  describe("FR-07 Concurrency Worker Pool 50", () => {
    it("membatasi worker aktif tidak pernah melampaui concurrency 50", async () => {
      let maxObservedActive = 0;
      let activeCount = 0;

      const pool = new ScannerPool({ concurrency: 50 });
      const items = Array.from({ length: 120 }, (_, i) => `SYM_${i}`);

      const results = await pool.runPool(items, async (sym) => {
        activeCount++;
        if (activeCount > maxObservedActive) {
          maxObservedActive = activeCount;
        }
        await new Promise((r) => setTimeout(r, 5));
        activeCount--;
        return { sym, done: true };
      });

      expect(results.length).toBe(120);
      expect(maxObservedActive).toBeLessThanOrEqual(50);
      expect(pool.getPeakWorkers()).toBeLessThanOrEqual(50);
      expect(pool.getActiveWorkers()).toBe(0);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("memproses 526 pairs universe penuh dengan concurrency 50 (FR-07)", async () => {
      const pool = new ScannerPool({ concurrency: 50 });
      const universe526 = Array.from({ length: 526 }, (_, i) => `PAIR_${i}USDT`);

      const res = await pool.scanCycle(universe526, "SCALP", async (sym) => {
        return {
          symbol: sym,
          score: 85,
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 80,
          triggerScore: 90,
          trendScore: 85,
          knnProb: 0.72,
          knnN: 60,
          gatesPass: { volume: true, chopAdx: true, macro: true, btcDom: true, leverage: true, minNotional: true },
          status: "WAIT",
        };
      });

      expect(res.results.length).toBe(526);
      expect(res.candidates.length).toBe(526);
      expect(pool.getPeakWorkers()).toBe(50);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(res.p95SymbolMs).toBeGreaterThanOrEqual(0);
    });

    it("mengisolasi error tiap item tanpa menghentikan pemrosesan universe", async () => {
      const pool = new ScannerPool({ concurrency: 10 });
      const items = ["BTCUSDT", "FAIL_1", "ETHUSDT", "FAIL_2", "SOLUSDT"];

      const res = await pool.scanCycle(items, "SCALP", async (sym) => {
        if (sym.startsWith("FAIL_")) {
          throw new Error(`Connection timeout for ${sym}`);
        }
        return {
          symbol: sym,
          score: 75,
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 70,
          triggerScore: 75,
          trendScore: 80,
          knnProb: null,
          knnN: null,
          gatesPass: { volume: true },
          status: "WAIT",
        };
      });

      expect(res.results.length).toBe(5);
      const failed = res.results.filter((r) => !r.success);
      const succeeded = res.results.filter((r) => r.success);
      expect(failed.length).toBe(2);
      expect(succeeded.length).toBe(3);
      expect(res.candidates.length).toBe(3);
      expect(failed[0]!.error).toContain("Connection timeout for FAIL_1");
    });
    it("mencegah overlapping scan cycle berjalan bersamaan", async () => {
      const pool = new ScannerPool({ concurrency: 2 });
      const items = ["BTCUSDT", "ETHUSDT"];

      let resolveSlowWorker!: () => void;
      const slowPromise = new Promise<void>((r) => {
        resolveSlowWorker = r;
      });

      const firstCyclePromise = pool.scanCycle(items, "SCALP", async () => {
        await slowPromise;
        return null;
      });

      await expect(pool.scanCycle(items, "SCALP")).rejects.toThrow(
        "SCAN_CYCLE_ALREADY_RUNNING"
      );

      resolveSlowWorker();
      await firstCyclePromise;
    });
  });

  describe("NFR-01 Target Latensi Siklus Scan p95 <= 90 detik & Riwayat 20 Siklus", () => {
    it("menyimpan rolling buffer riwayat 20 siklus terakhir", async () => {
      let mockTime = 1000000;
      const pool = new ScannerPool({
        concurrency: 5,
        historyLimit: 20,
        now: () => mockTime,
      });

      for (let c = 1; c <= 25; c++) {
        mockTime += 1000;
        await pool.scanCycle(["BTCUSDT", "ETHUSDT"], "SCALP", async () => {
          mockTime += 10;
          return null;
        });
      }

      const history = pool.getHistory();
      expect(history.length).toBe(20);
      expect(history[0]!.cycleId).toBe(6);
      expect(history[19]!.cycleId).toBe(25);
    });

    it("mengevaluasi kepatuhan NFR-01 (<= 90 dtk untuk universe penuh, <= 45 dtk untuk subset <= 150)", () => {
      const pool = new ScannerPool();

      // Kasus 1: Durasi p95 = 40.000 ms (40 dtk) -> patuh NFR-01
      (pool as any).cycleHistory = [
        { cycleId: 1, durationMs: 35000 },
        { cycleId: 2, durationMs: 40000 },
      ];
      (pool as any).lastPairCount = 526;
      expect(pool.getP95CycleMs()).toBe(40000);
      expect(pool.isNfr01Compliant()).toBe(true);

      // Kasus 2: Durasi p95 = 95.000 ms (95 dtk) -> melanggar target 90 dtk
      (pool as any).cycleHistory = [
        { cycleId: 1, durationMs: 80000 },
        { cycleId: 2, durationMs: 95000 },
      ];
      expect(pool.getP95CycleMs()).toBe(95000);
      expect(pool.isNfr01Compliant()).toBe(false);

      // Kasus 3: Subset 100 pair, target <= 45 dtk
      (pool as any).lastPairCount = 100;
      (pool as any).cycleHistory = [
        { cycleId: 1, durationMs: 46000 },
      ];
      expect(pool.isNfr01Compliant()).toBe(false);
    });
  });

  describe("SetupCandidate Persistensi DB & API /api/markets/scan", () => {
    it("menyimpan kandidat ke database SetupCandidate SQLite", async () => {
      const pool = new ScannerPool();
      const mockCandidates: CandidateItem[] = [
        {
          symbol: "TEST_BTCUSDT",
          score: 92,
          mode: "SCALP",
          regime: "TRENDING",
          zoneScore: 90,
          triggerScore: 95,
          trendScore: 90,
          knnProb: 0.81,
          knnN: 55,
          gatesPass: { volume: true, chopAdx: true, macro: true, btcDom: true, leverage: true, minNotional: true },
          status: "WAIT",
          rejectReason: null,
        },
      ];

      const inserted = await pool.persistCandidates(mockCandidates);
      expect(inserted).toBe(1);

      const row = await db.setupCandidate.findFirst({
        where: { symbol: "TEST_BTCUSDT" },
      });
      expect(row).not.toBeNull();
      expect(row?.score).toBe(92);
      expect(row?.regime).toBe("TRENDING");
      expect(row?.knnProb).toBeCloseTo(0.81);
    });

    it("GET /api/markets/scan mengembalikan view sesuai Schema.md (FR-07, FR-13)", async () => {
      const app = createApp();
      const res = await request(app).get("/api/markets/scan").set("x-api-token", "vitest-mutation-token").expect(200);

      expect(res.body).toHaveProperty("candidates");
      expect(res.body).toHaveProperty("scan");
      expect(Array.isArray(res.body.candidates)).toBe(true);
      expect(res.body.scan).toHaveProperty("cycleMs");
      expect(res.body.scan).toHaveProperty("pairs");
      expect(res.body.scan).toHaveProperty("concurrency");
      expect(res.body.scan).toHaveProperty("p95CycleMs");
      expect(res.body.scan).toHaveProperty("nfr01Compliant");
      expect(res.body.scan.concurrency).toBe(50);
    });

    it("scheduler start dan stop bekerja dengan benar", () => {
      const pool = new ScannerPool({ scalpIntervalSec: 60 });
      expect(pool.isSchedulerRunning()).toBe(false);

      pool.startScheduler("SCALP", async () => ["BTCUSDT"]);
      expect(pool.isSchedulerRunning()).toBe(true);

      pool.stopScheduler();
      expect(pool.isSchedulerRunning()).toBe(false);
    });

  });
});
