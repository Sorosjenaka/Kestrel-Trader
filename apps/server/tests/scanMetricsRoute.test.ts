// apps/server/tests/scanMetricsRoute.test.ts
// 24 Okt 2026 (BUG FIX kolom kosong di Live Market Scanner: KNN / ER / OI% / BETA).
//
// Test level ROUTE: membuktikan response /api/markets/scan benar-benar
// MEMBAWA field metrik yang dipakai UI. Ini menutup celah "server menghitung
// tapi route tidak mengirim" dan "field dikirim tapi named beda di web".
//
// Yang diuji:
//  1) route meneruskan KNN / ER / OI / BETA + status/reason ke JSON,
//  2) status METRIK ikut terkirim (UI butuh alasan saat nilai null),
//  3) nilai 0 yang SAH (knnProb=0 -> "0% win rate") tidak disamarkan jadi null.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { buildMarketsRouter } from "../src/api/routes/markets.js";
import { ScannerPool, type CandidateItem } from "../src/scanner/scannerPool.js";

function makeCandidate(over: Partial<CandidateItem> = {}): CandidateItem {
  return {
    symbol: "TESTUSDT",
    score: 72,
    mode: "SCALP",
    regime: "TRENDING",
    zoneScore: 80,
    triggerScore: 70,
    trendScore: 65,
    knnProb: 0.6,
    knnN: 60,
    knnLabel: "KNN_POOL_READY",
    gatesPass: { volumeGate: true, regimeGate: true, trendGate: true, scoreGate: true, planGate: true, chopGate: true, volatilityGate: true },
    status: "READY",
    er: 0.42,
    erStatus: "OK",
    pocDistanceBins: -1.2,
    oiChangePct: 1.25,
    oiStatus: "OK",
    oiReason: "OI_HIST_OK",
    betaBtc: 1.15,
    betaStatus: "OK",
    betaReason: "BETA_OK",
    mtfAnalyzed: true,
    mtfAnalyzedAt: Date.now(),
    ...over,
  };
}

/** Router minimal: dependency scanner di-stub dengan pool lokal. */
function buildApp(scanner: ScannerPool) {
  const app = express();
  app.use(buildMarketsRouter({
    binance: {} as any,
    marketsService: {} as any,
    scanner: scanner as any,
    liquidations: {} as any,
    gatherMarketContextSnapshot: async () => ({}),
    gatherPositionOverlays: async () => ({}),
    getTvSignal: async () => ({}),
    isPerpListed: () => true,
    perpUniverseCount: () => 0,
    checkAssetClass: () => ({ blocked: false, reason: null }),
    prismaUniverseRepo: { getManualBlacklist: async () => [] },
    volumeMinUsd: 0,
  }));
  return app;
}

describe("GET /api/markets/scan — kolom metrik KNN/ER/OI/BETA", () => {
  let scanner: ScannerPool;

  beforeEach(() => {
    scanner = new ScannerPool();
  });
  afterEach(() => {
    scanner.stopScheduler();
  });

  it("meneruskan KNN, ER, OI%, BETA beserta statusnya ke JSON", async () => {
    scanner.mergeCandidates([makeCandidate()]);
    const res = await request(buildApp(scanner)).get("/api/markets/scan").expect(200);

    expect(Array.isArray(res.body.candidates)).toBe(true);
    const c = res.body.candidates[0];
    expect(c.symbol).toBe("TESTUSDT");
    // Nilai metrik
    expect(c.knnProb).toBe(0.6);
    expect(c.knnN).toBe(60);
    expect(c.er).toBe(0.42);
    expect(c.oiChangePct).toBe(1.25);
    expect(c.betaBtc).toBe(1.15);
    // Status + alasan (UI butuh ini untuk "n/a (alasan)")
    expect(c.oiStatus).toBe("OK");
    expect(c.betaStatus).toBe("OK");
    expect(c.erStatus).toBe("OK");
    expect(c.knnLabel).toBe("KNN_POOL_READY");
  });

  it("metrik tak tersedia tetap punya key + status (bukan key hilang / null tanpa alasan)", async () => {
    scanner.mergeCandidates([makeCandidate({
      oiChangePct: null,
      oiStatus: "FETCH_FAILED",
      oiReason: "OI_FETCH_HTTP_404",
      betaBtc: null,
      betaStatus: "INSUFFICIENT_SAMPLES",
      betaReason: "BETA_SYM_BARS_40_LT_51",
    })]);
    const res = await request(buildApp(scanner)).get("/api/markets/scan").expect(200);

    const c = res.body.candidates[0];
    // key HARUS ada (UI accessing c.oiChangePct tidak crash)
    expect(c).toHaveProperty("oiChangePct");
    expect(c).toHaveProperty("betaBtc");
    expect(c.oiChangePct).toBeNull();
    expect(c.oiStatus).toBe("FETCH_FAILED");
    expect(c.oiReason).toBe("OI_FETCH_HTTP_404");
    expect(c.betaStatus).toBe("INSUFFICIENT_SAMPLES");
    expect(c.betaReason).toBe("BETA_SYM_BARS_40_LT_51");
  });

  it("knnProb = 0 yang SAH diteruskan sebagai 0 (bukan null) —UI harus menampilkan 0%", async () => {
    // 0% win-rate dari 5 analog itu angka valid, bukan "tidak ada data".
    scanner.mergeCandidates([makeCandidate({ knnProb: 0, knnN: 60, knnLabel: "KNN_POOL_READY" })]);
    const res = await request(buildApp(scanner)).get("/api/markets/scan").expect(200);
    const c = res.body.candidates[0];
    expect(c.knnProb).toBe(0);
    expect(c.knnProb).not.toBeNull();
  });

  it("knn tanpa bukti: knnProb null + knnLabel menjelaskan kurangnya sampel", async () => {
    scanner.mergeCandidates([makeCandidate({ knnProb: null, knnN: 12, knnLabel: "KNN_POOL_12_LT_50" })]);
    const res = await request(buildApp(scanner)).get("/api/markets/scan").expect(200);
    const c = res.body.candidates[0];
    expect(c.knnProb).toBeNull();
    expect(c.knnN).toBe(12);
    expect(c.knnLabel).toContain("LT_50");
  });
});
