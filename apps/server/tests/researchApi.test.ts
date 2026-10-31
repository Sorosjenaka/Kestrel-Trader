// tests/researchApi.test.ts — Big Brain 15 Okt 2026: API jurnal temuan riset
// + monitor riset. Menyentuh test DB (bukan DB live) via globalSetup.
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";

const app = createApp();

const createdIds: number[] = [];

afterAll(async () => {
  // Rapikan test DB: hapus temuan yang dibuat suite ini.
  for (const id of createdIds) {
    try {
      await db.researchFinding.delete({ where: { id } });
    } catch {
      /* test DB boleh gagal rapi */
    }
  }
  await db.$disconnect();
});

describe("POST/GET /api/research/findings", () => {
  it("membuat temuan valid dan mengembalikan id", async () => {
    const r = await request(app).post("/api/research/findings").set("x-api-token", "vitest-mutation-token")
      .send({
        title: "Audit S-03 SWING (test)",
        hypothesis: "S-03 bebas look-ahead dan bertahan OOS",
        experimentType: "OOS_VALIDATION",
        verdict: "SUPPORTIVE",
        conclusion: "uji api",
        runRefs: [{ kind: "OOS_VALIDATION", label: "test" }],
        metrics: { lookAheadPassed: true },
      })
      .expect(200);
    expect(typeof r.body.id).toBe("number");
    createdIds.push(r.body.id);
  });

  it("menolak temuan tidak valid dengan 400 dan pesan eksplisit", async () => {
    const r = await request(app).post("/api/research/findings").set("x-api-token", "vitest-mutation-token")
      .send({ title: "", hypothesis: "", experimentType: "SALAH", verdict: "SALAH" })
      .expect(400);
    expect(r.body.error).toBeTruthy();
  });

  it("GET mengembalikan temuan yang baru dibuat dengan decision default PENDING", async () => {
    const create = await request(app).post("/api/research/findings").set("x-api-token", "vitest-mutation-token")
      .send({
        title: "Cek daftar (test)",
        hypothesis: "h",
        experimentType: "BACKTEST",
        verdict: "INCONCLUSIVE",
      })
      .expect(200);
    createdIds.push(create.body.id);
    const list = await request(app).get("/api/research/findings").set("x-api-token", "vitest-mutation-token").expect(200);
    const found = list.body.findings.find((f: { id: number }) => f.id === create.body.id);
    expect(found).toBeTruthy();
    expect(found.operatorDecision).toBe("PENDING");
    expect(found.runRefs).toEqual([]);
    expect(found.metrics).toEqual({});
  });

  it("keputusan operator: ADOPTED sah, nilai asing ditolak 400, dobel keputusan ditolak 409", async () => {
    const create = await request(app).post("/api/research/findings").set("x-api-token", "vitest-mutation-token")
      .send({ title: "Keputusan (test)", hypothesis: "h", experimentType: "LOOKAHEAD_AUDIT", verdict: "SUPPORTIVE" })
      .expect(200);
    const id = create.body.id;
    createdIds.push(id);

    await request(app).post(`/api/research/findings/${id}/decision`).set("x-api-token", "vitest-mutation-token")
      .send({ decision: "MUNGKIN" })
      .expect(400);
    await request(app).post(`/api/research/findings/${id}/decision`).set("x-api-token", "vitest-mutation-token")
      .send({ decision: "ADOPTED" })
      .expect(200)
      .then((r) => expect(r.body.operatorDecision).toBe("ADOPTED"));
    await request(app).post(`/api/research/findings/${id}/decision`).set("x-api-token", "vitest-mutation-token")
      .send({ decision: "REJECTED" })
      .expect(409);
  });

  it("id tak dikenal → 409, id non-angka → 400", async () => {
    await request(app).post("/api/research/findings/999999/decision").set("x-api-token", "vitest-mutation-token").send({ decision: "REJECTED" }).expect(409);
    await request(app).post("/api/research/findings/bukan-angka/decision").set("x-api-token", "vitest-mutation-token").send({ decision: "REJECTED" }).expect(400);
  });
});

describe("GET /api/research/market-monitor", () => {
  it("mengembalikan struktur monitor lengkap (DB-backed, tanpa fabrikasi)", async () => {
    const r = await request(app).get("/api/research/market-monitor").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(r.body.generatedAt).toBeTruthy();
    expect(r.body.windowHours).toBe(24);
    expect(Array.isArray(r.body.recentEvents)).toBe(true);
    expect(r.body.recentEvents.length).toBeLessThanOrEqual(50);
    expect(typeof r.body.decisions24h.total).toBe("number");
    expect(typeof r.body.decisions24h.aggregate).toBe("object");
    expect(typeof r.body.swingSignals24h.total).toBe("number");
    expect(typeof r.body.openPositions).toBe("number");
    expect(Array.isArray(r.body.researchFindings)).toBe(true);
  });
});

describe("POST /api/backtest/audit", () => {
  it("menolak body tanpa dataset (400)", async () => {
    await request(app).post("/api/backtest/audit").set("x-api-token", "vitest-mutation-token").send({}).expect(400);
  });

  it("dataset tidak valid → audit jujur GAGAL dan tetap mencatat temuan REFUTED", async () => {
    // Dataset kosong-bar: validator historis akan menolak → verdict REFUTED/INCONCLUSIVE.
    const r = await request(app).post("/api/backtest/audit").set("x-api-token", "vitest-mutation-token")
      .send({ dataset: { schemaVersion: 1 }, strategyId: "S-03", mode: "SCALP" })
      .expect(200);
    expect(["REFUTED", "INCONCLUSIVE"]).toContain(r.body.verdict);
    expect(typeof r.body.findingId).toBe("number");
    createdIds.push(r.body.findingId);
    const reasons = r.body.lookAhead?.reasons ?? [];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("dataset valid lengkap → struktur laporan audit lengkap", async () => {
    const start = Date.UTC(2025, 0, 1);
    const bars = [];
    for (let i = 0; i < 24 * 60; i++) {
      const t = start + i * 60000;
      const open = 100 + (i / 60) * 0.5 + Math.sin(i / 7) * 0.8;
      bars.push({ openTime: t, open, high: open + 0.6, low: open - 0.6, close: open + 0.1, volume: 100 });
    }
    const dataset = {
      schemaVersion: 1,
      source: "api-test fixture (not market evidence)",
      downloadedAt: start + 48 * 3600000,
      symbol: "BTCUSDT",
      intervalMs: 60000,
      bars,
      funding: [],
      fundingCoverage: { from: start, to: start + 24 * 3600000 },
      rules: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, maxLeverage: 25 },
      outOfSampleFrom: start + 2 * 3600000,
      outOfSampleTo: start + 24 * 3600000,
      trainingEndedAt: start + 3600000,
      embargoMs: 60000,
      universeSelection: "api-test fixture",
    };
    const r = await request(app).post("/api/backtest/audit").set("x-api-token", "vitest-mutation-token")
      .send({ dataset, strategyId: "S-03", mode: "SCALP" })
      .expect(200);
    expect(r.body.lookAhead).toHaveProperty("passed");
    expect(r.body.lookAhead).toHaveProperty("differences");
    expect(r.body.outOfSample).toHaveProperty("status");
    if (r.body.outOfSample.inSample !== null) {
      expect(typeof r.body.outOfSample.inSample.tradeCount).toBe("number");
    }
    expect(r.body.eventReplay).toHaveProperty("events");
    expect(r.body.eventReplay.events.length).toBeGreaterThanOrEqual(5);
    expect(r.body.verdict).toBeTruthy();
    createdIds.push(r.body.findingId);
    // 21 Okt 2026 (Phase 7): timeout eksplisit 60s. Default suite 10s terlalu
    // ketat untuk komputasi CPU-bound ini (1440 bar -> audit + OOS + event
    // replay) di host 2-core yang juga menjalankan artatrade.service +
    // worker paper Polaris. Test ini TIDAK flaky secara logika — ia hanya
    // kehabisan wall-clock saat CPU direbut proses live bot.
  }, 60_000);
});
