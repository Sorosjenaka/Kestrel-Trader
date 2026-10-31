// apps/server/tests/disarmedCycle.test.ts - Uji E2E DISARMED: sinyal -> sizing -> rencana order -> jurnal (US-01, US-02, NFR-09).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { runDisarmedCycle } from "../src/exec/disarmedCycle.js";

describe("T-2.9 & Fase 2 DoD: Uji End-to-End DISARMED", () => {
  it("US-01 & NFR-09: Satu siklus penuh Super Scalp berjalan dengan ARM OFF (0 order terkirim; jurnal lengkap)", async () => {
    const result = await runDisarmedCycle({
      symbol: "BTCUSDT",
      side: "LONG",
      mode: "SCALP",
      entryPrice: 62000,
      slPrice: 61380, // -1%
      // TP1/TP2 mengikuti RR mode dari policy aktif.
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe("SCALP");
    expect(result.symbol).toBe("BTCUSDT");

    // Verifikasi setiap langkah dalam pipeline
    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toContain("SIGNAL_GENERATION");
    expect(stepNames).toContain("RISK_SIZING");
    expect(stepNames).toContain("DAILY_GUARD");
    expect(stepNames).toContain("ORDER_EXECUTION_DISARMED");
    expect(stepNames).toContain("POSITION_OPENED");
    expect(stepNames).toContain("SUPERVISOR_TP1");
    expect(stepNames).toContain("TRADE_JOURNALED");
    expect(stepNames).toContain("RECONCILE_RESTART_AUDIT");

    // Bukti order eksekusi adalah SIMULATED (0 order riil terkirim ke Binance)
    const execStep = result.steps.find((s) => s.name === "ORDER_EXECUTION_DISARMED");
    expect(execStep?.data.simulated).toBe(true);
    expect(execStep?.data.status).toBe("FILLED");

    // Bukti jurnal tersimpan
    expect(result.finalTrade).toBeDefined();
    expect(result.finalTrade?.win).toBe(true);
    expect(result.finalTrade?.rMultiple).toBeGreaterThan(0);

    // Bukti reconciler restart sukses tanpa orphan
    expect(result.reconcileSummary?.orphanCount).toBe(0);
  });

  it("US-02: Siklus SCALP kedua (ETHUSDT) dengan target TP policy aktif tereksekusi dengan sukses", async () => {
    const result = await runDisarmedCycle({
      symbol: "ETHUSDT",
      side: "LONG",
      mode: "SCALP",
      entryPrice: 3200,
      slPrice: 3168, // -1%
      // TP tunggal mengikuti RR SCALP dari policy aktif.
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe("SCALP");
    expect(result.finalTrade).toBeDefined();
    expect(result.finalTrade?.rMultiple).toBeGreaterThan(1.0);
  });

  it("API POST /api/pipeline/run-disarmed mengembalikan trace lengkap", async () => {
    const app = createApp();
    const res = await request(app).post("/api/pipeline/run-disarmed").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "SOLUSDT",
        side: "LONG",
        mode: "SCALP",
        entryPrice: 150,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.cycleId).toBeDefined();
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThanOrEqual(8);
  });
});
