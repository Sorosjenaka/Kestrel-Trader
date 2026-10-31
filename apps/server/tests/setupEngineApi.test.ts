// apps/server/tests/setupEngineApi.test.ts - Uji endpoint katalog mesin setup (T-5.15).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("GET /api/setup-engine (T-5.15)", () => {
  it("melaporkan peta timeframe tunggal SCALP: 1m/3m/5m/15m + makro 1h", async () => {
    const app = createApp();
    const res = await request(app).get("/api/setup-engine").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(Object.keys(res.body.timeframes)).toEqual(["SCALP", "SWING"]);
    expect(res.body.timeframes.SWING.specs.every((s: any) => s.interval === "1h")).toBe(true);
    const scalpSpecs = res.body.timeframes.SCALP.specs.map((s: any) => `${s.role}:${s.interval}`);
    expect(scalpSpecs).toEqual(["TRIGGER:1m", "CONFIRM:3m", "STRUCTURE:5m", "BIAS:15m"]);
    expect(res.body.timeframes.SCALP.macro).toEqual(["1h"]);
    expect(res.body.timeframes.SCALP.summary).toContain("SCALP: 1m");
  });

  it("mengekspos 3 strategi aktif + bucket S-00/S-99 + konfigurasi band/RR (tanpa trailing)", async () => {
    const app = createApp();
    const res = await request(app).get("/api/setup-engine").set("x-api-token", "vitest-mutation-token").expect(200);

    const ids = res.body.strategies.map((s: any) => s.id);
    // 20 Okt 2026 (perintah operator): S-03 Fibonacci + S-04 MRV DIHAPUS dari
    // katalog aktif -> tersisa 6: S-01, S-02 (SCALP) + S-05, RSW-01/02/03.
    // Katalog API WAJIB mencerminkan katalog eksekusi (tidak boleh strategy
    // yang tidak bisa entry tetap tampil di API).
    // 20 Okt 2026: S-03 Fibonacci + S-04 MRV + S-05 Polaris DIHAPUS dari
    // katalog aktif -> tersisa 5: S-01, S-02 (SCALP) + RSW-01/02/03 (SWING).
    expect([...new Set(ids)]).toEqual(["S-01", "S-02", "RSW-01", "RSW-02", "RSW-03"]);
    expect(res.body.strategies.filter((s: any) => s.id === "S-03")).toEqual([]);
    expect(res.body.strategies.filter((s: any) => s.id === "S-04")).toEqual([]);
    expect(res.body.strategies.filter((s: any) => s.id === "S-05")).toEqual([]);
    // S-03 tetap tercatat sebagai arsip SWING (metadata lifecycle, bukan
    // entry source) — history tidak hilang.
    expect(res.body.archivedSwingStrategies.map((s: any) => s.strategyId)).toContain("S-03");
    expect(res.body.fallbackStrategy.id).toBe("S-00");

    // SCALP-only: tepat satu band & satu set RR di konfigurasi publik.
    expect(Object.keys(res.body.config.slBand)).toEqual(["SCALP"]);
    expect(res.body.config.slBand.SCALP.max).toBeCloseTo(0.025, 6);
    expect(res.body.config.slBufferAtr).toEqual({ SCALP: 0.46 });
    expect(res.body.config.minSlAtr).toEqual({ SCALP: 0.805 });
    // Menu SL/TP Hybrid (Opsi 2): kandidat R pra-hitung yang boleh dipilih LLM.
    expect(res.body.config.slTpMenu.tpR).toEqual([1.7]);
    // Override per-strategi: 20 Okt 2026 override "S-03" (Fib) dan "S-04"
    // (MRV) DIHAPUS — tidak ada lagi strategi itu, jadi tidak boleh ada
    // overridenya (override yatim = aturan mati yang bisa revived diam-diam).
    expect(res.body.config.strategyGateOverrides["S-03"]).toBeUndefined();
    expect(res.body.config.strategyGateOverrides["S-04"]).toBeUndefined();
    // Override per-strategi: 20 Okt 2026 S-03/S-04/S-05 SEMUA DIHAPUS
    // (strateginya mati -> override yatim = aturan mati yang bisa revived).
    // Band SL SWING kini hidup independen di SETUP_ENGINE.SWING_SL_BAND_MAX.
    expect(res.body.config.strategyGateOverrides["S-05"]).toBeUndefined();
    // 27 Okt 2026 (operator: "Max SL% 2.5% 20% terlalu lebar, ambil dari data
    // lowest SL 3 strategi swing"): cap SWING diturunkan 20% -> 6%. Angka 6%
    // = batas terukur trio RSW di master_v2 (max SL 5,9967%-5,9984% dari
    // 20.014 sinyal) DAN batas keras mesin strategi (rswSignals.ts cap 6%).
    // Arsip S-05 (non-entry, replay historis) punya band TERPISAH karena
    // geometri SL-nya (garis berlawanan x2) jauh lebih lebar.
    expect(res.body.config.SWING_SL_BAND_MAX).toBe(0.06);
    expect(res.body.config.SWING_ARCHIVE_SL_BAND_MAX).toBe(0.2);
    expect(res.body.config.trailing).toBeUndefined();
    expect(Array.isArray(res.body.recentPlans)).toBe(true);
    expect(Array.isArray(res.body.statsByStrategy)).toBe(true);
  });

  it("melaporkan TP1 SCALP tunggal RR klasik 1.7R", async () => {
    const app = createApp();
    const res = await request(app).get("/api/setup-engine").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(res.body.config.rrByMode.SCALP.tp1R).toBe(1.7);
  });
});
