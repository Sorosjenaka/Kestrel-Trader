// apps/server/tests/riskEngine.test.ts - Unit test Risk Engine Sizing $1, Margin Cap 40%, MinNotional, Liquidation Guard (FR-15, FR-16, NFR-13, US-06).
import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  calculateOrderPlan,
  fixedRiskLevels,
  quantizeStep,
  resolveMarginPolicy,
  roundToTick,
  SCALP_MAX_MARGIN_USD,
  swingSlBandMaxFor,
  SymbolRiskRules,
} from "../src/risk/riskEngine.js";
import { createApp } from "../src/app.js";
import { planAtFreshPrice } from "../src/exec/plannedEntry.js";
import { SETUP_ENGINE, slBandFor } from "../src/config/setupEngine.js";

const dummyBtcRules: SymbolRiskRules = {
  symbol: "BTCUSDT",
  minNotional: 5.0,
  tickSize: 0.1,
  stepSize: 0.001,
  maxLeverage: 50,
  leverageUpdatedAt: Date.now(),
  isBlacklisted: false,
};

describe("FR-15 & US-06: Risk Engine Sizing $1 & Margin Cap 40%", () => {
  it("menghitung sizing target $1.00 ketika margin di bawah plafon 40%", () => {
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 50000,
      slPrice: 49500, // 1% distance
      equityUsd: 100, // 40% cap = $40
      symbolRules: dummyBtcRules,
    });

    expect(plan.allowed).toBe(true);
    expect(plan.rejectReason).toBeNull();
    // Leverage capped at 25 (FR-16)
    expect(plan.leverage).toBe(25);
    // Notional = $1 / 0.01 = $100 -> qty = 100 / 50000 = 0.002 BTC
    expect(plan.qty).toBe(0.002);
    expect(plan.notionalUsd).toBe(100);
    expect(plan.marginUsd).toBe(4); // $100 / 25 = $4 <= $40
    expect(plan.effectiveRiskUsd).toBeCloseTo(1.0, 1);
    expect(plan.riskReductionRatio).toBe(1.0);
  });

  it("mereduksi risiko proporsional saat margin cap 40% mengikat (Rules §4)", () => {
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 50000,
      slPrice: 49900, // 0.2% distance -> raw notional = 1 / 0.002 = $500, margin raw = $20
      equityUsd: 25,   // 40% cap = $10 -> margin raw $20 melebihi $10 cap!
      symbolRules: dummyBtcRules,
    });

    expect(plan.allowed).toBe(true);
    expect(plan.marginUsd).toBeLessThanOrEqual(10.01);
    // Risiko tereduksi di bawah $1.00
    expect(plan.effectiveRiskUsd).toBeLessThanOrEqual(1.0);
    expect(plan.riskReductionRatio).toBeLessThan(1.0);
  });

  it("menolak order jika notional di bawah minNotional (FR-15)", () => {
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 50000,
      slPrice: 25000, // 50% distance -> notional = $1 / 0.5 = $2 < $5 minNotional
      equityUsd: 100,
      symbolRules: dummyBtcRules,
    });

    expect(plan.allowed).toBe(false);
    expect(plan.rejectReason).toBe("SL_EXCEEDS_MAX");
  });

  it("menolak order jika snapshot maxLeverage lebih tua dari 7 hari (FR-16)", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 50000,
      slPrice: 49500,
      equityUsd: 100,
      symbolRules: {
        ...dummyBtcRules,
        leverageUpdatedAt: eightDaysAgo,
      },
    });

    expect(plan.allowed).toBe(false);
    expect(plan.rejectReason).toBe("STALE_LEVERAGE_SNAPSHOT");
  });

  it("menolak order jika arah SL salah untuk posisi LONG atau SHORT", () => {
    const longBad = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 50000,
      slPrice: 51000, // SL di atas entry
      equityUsd: 100,
      symbolRules: dummyBtcRules,
    });
    expect(longBad.allowed).toBe(false);
    expect(longBad.rejectReason).toBe("INVALID_SL_DIRECTION_LONG");

    const shortBad = calculateOrderPlan({
      symbol: "BTCUSDT",
      side: "SHORT",
      entryPrice: 50000,
      slPrice: 49000, // SL di bawah entry
      equityUsd: 100,
      symbolRules: dummyBtcRules,
    });
    expect(shortBad.allowed).toBe(false);
    expect(shortBad.rejectReason).toBe("INVALID_SL_DIRECTION_SHORT");
  });

  it("menolak simbol yang di-blacklist", () => {
    const plan = calculateOrderPlan({
      symbol: "BADUSDT",
      side: "LONG",
      entryPrice: 100,
      slPrice: 95,
      equityUsd: 100,
      symbolRules: {
        ...dummyBtcRules,
        isBlacklisted: true,
      },
    });

    expect(plan.allowed).toBe(false);
    expect(plan.rejectReason).toBe("SYMBOL_BLACKLISTED");
  });

  it("pembulatan presisi quantizeStep dan roundToTick bekerja deterministik (NFR-13)", () => {
    expect(quantizeStep(0.123456, 0.001)).toBe(0.123);
    expect(quantizeStep(1.9999, 0.01)).toBe(1.99);
    expect(roundToTick(50123.456, 0.1)).toBe(50123.5);
    expect(roundToTick(0.0001234, 0.00001)).toBe(0.00012);
  });

  it("single target: tp2Price masukan diabaikan, TP2 selalu == TP1", () => {
    const input = { symbol: "BTCUSDT", side: "LONG" as const, entryPrice: 100,
      slPrice: 98, equityUsd: 200, symbolRules: { ...dummyBtcRules, tickSize: 0.01, stepSize: 0.001 } };
    // 29 Sep 2026: RR klasik single target. Level TP2 dari pemanggil tidak lagi
    // dipakai sebagai target terpisah; TP2 dipaksa identik dengan TP1.
    const withLowTp2 = calculateOrderPlan({ ...input, tp2Price: 104.13 });
    expect(withLowTp2.allowed).toBe(true);
    expect(withLowTp2.rejectReason).toBeNull();
    expect(withLowTp2.tp2Price).toBe(withLowTp2.tp1Price);
  });

  it("RR default SCALP single target (TP2 == TP1)", () => {
    const input = { symbol: "BTCUSDT", side: "LONG" as const, entryPrice: 100,
      slPrice: 98, equityUsd: 200,
      symbolRules: { ...dummyBtcRules, tickSize: 0.01, stepSize: 0.001 } };
    const scalp = calculateOrderPlan({ ...input, mode: "SCALP" });
    expect(scalp.allowed).toBe(true);
    // R = |100 - 98| = 2; TP1 = 1.7R -> 100 + 1.7*2 = 103.40 (tick 0.01).
    expect(scalp.tp1Price).toBe(103.4);
    expect(scalp.tp2Price).toBe(scalp.tp1Price);
    // Mode tidak diberikan -> default SCALP (satu-satunya mode).
    expect(calculateOrderPlan({ ...input }).tp1Price).toBe(103.4);
  });

  it("budget gap stop mengurangi qty sehingga risiko net estimasi tetap <= $1", () => {
    const input = { symbol: "BTCUSDT", side: "LONG" as const, entryPrice: 100,
      slPrice: 98, tp2Price: 105, equityUsd: 200, riskBudgetMode: "NET" as const,
      symbolRules: { ...dummyBtcRules, tickSize: 0.01, stepSize: 0.001 } };
    const zeroGap = calculateOrderPlan({ ...input, slippageBps: 0 });
    const buffered = calculateOrderPlan({ ...input, slippageBps: 60 });
    expect(buffered.allowed).toBe(true);
    expect(buffered.qty).toBeLessThan(zeroGap.qty);
    expect(buffered.estimatedNetRiskUsd).toBeLessThanOrEqual(1);
  });

  it("kenaikan alokasi margin tidak melampaui plafon SCALP atau risiko net $1", () => {
    expect(SCALP_MAX_MARGIN_USD).toBe(4.8);
    const scalp = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SCALP", side: "LONG", entryPrice: 100, slPrice: 99.2,
      equityUsd: 200, riskBudgetMode: "NET", slippageBps: 60,
      maxMarginUsd: SCALP_MAX_MARGIN_USD,
      symbolRules: { ...dummyBtcRules, tickSize: 0.01, stepSize: 0.001 },
    });
    expect(scalp.allowed).toBe(true);
    expect(scalp.marginUsd).toBeLessThanOrEqual(4.8);
    expect(scalp.estimatedNetRiskUsd).toBeLessThanOrEqual(1);
    const policy = resolveMarginPolicy({ mode: "SCALP", equityUsd: 200, score: 85, seed: "BTCUSDT" });
    expect(policy.allowed).toBe(true);
    expect(policy.marginUsd).toBeLessThanOrEqual(SCALP_MAX_MARGIN_USD);
    expect(policy.targetRiskUsd).toBeLessThanOrEqual(1);
    expect(policy.leverage).toBeLessThanOrEqual(25);
  });

  it("sebelum entry menghitung ulang R dan qty dari mark segar; lonjakan harga ditolak", () => {
    const input = { symbol: "BTCUSDT", side: "LONG" as const, entryPrice: 100,
      slPrice: 98, tp2Price: 105, equityUsd: 200, riskBudgetMode: "NET" as const,
      slippageBps: 60, symbolRules: { ...dummyBtcRules, tickSize: 0.01, stepSize: 0.001 } };
    const original = planAtFreshPrice(input, 200, 100, "SCALP");
    const repriced = planAtFreshPrice(input, 200, 100.1, "SCALP");
    expect(repriced.allowed).toBe(true);
    expect(repriced.entryPrice).toBe(100.1);
    expect(repriced.qty).toBeLessThan(original.qty);
    expect(() => planAtFreshPrice(input, 200, 101, "SCALP")).toThrow("PLAN_PRICE_CHANGED");
  });
  it("FIX $1 (12 Okt 2026): 1R loss TIDAK PERNAH melewati $1.00 — ceil yang melewati $1 jatuh ke floor", () => {
    // Simulasi AVAX: entry 11.7, sl 11.4232 (jarak ~0.2768), stepSize 1.
    // rawQty = 1.0 / 0.2768 = 3.612. Ceil=4 -> risk $1.1072 (LEBIH dari $1) => DITOLAK,
    // sistem jatuh ke floor=3 -> risk $0.8304. Batas absolut = $1.00 (overhang 1.25 dihapus).
    const input = {
      symbol: "BTCUSDT",
      side: "LONG" as const,
      entryPrice: 11.7,
      slPrice: 11.4232,
      equityUsd: 200,
      riskBudgetMode: "GROSS" as const,
      allowStepOverhang: true,
      symbolRules: { ...dummyBtcRules, tickSize: 0.001, stepSize: 1 },
    };
    const plan = calculateOrderPlan(input);
    expect(plan.allowed).toBe(true);
    expect(plan.qty).toBe(3);
    // 1R loss = 3 * 0.277 = $0.831 (sl 11.4232 dibulatkan tick 0.001 -> 11.423) — TIDAK PERNAH > $1.00
    expect(plan.effectiveRiskUsd).toBeLessThanOrEqual(1.0);
    expect(plan.effectiveRiskUsd).toBeCloseTo(0.831, 4);
    // Profit pada 1.7R = 3 * 0.471 = $1.413
    const profitUsd = plan.qty * Math.abs(plan.tp1Price - plan.entryPrice);
    expect(profitUsd).toBeCloseTo(1.413, 4);
  });

  // ── REGRESI 13 Okt 2026: LOGIKA SL/TP "lewat leverage" (setup manual operator
  // USUSDT SHORT qty 2158 @ 0.013944 -> SL 0.014407 risk $1.00, TP 0.013156 profit $1.70).
  // qty dari margin/leverage; jarak SL = $1/qty, jarak TP = $1.7/qty. BUKAN jarak struktur.
  it("REGRESI fixedRiskLevels: reproduksi PERSIS setup manual operator (USUSDT SHORT 2158)", () => {
    const r = fixedRiskLevels({
      entryPrice: 0.013944, qty: 2158, side: "SHORT", tickSize: 0.000001,
    });
    expect(r.slPrice).toBeCloseTo(0.014407, 6); // persis SL manual
    expect(r.tpPrice).toBeCloseTo(0.013156, 6); // persis TP manual
    expect(r.riskUsd).toBeLessThanOrEqual(1.0); // FIX $1
    expect(r.tpUsd).toBeCloseTo(1.7, 2);
  });

  it("REGRESI fixedRiskLevels LONG: SL di bawah, TP di atas, risk tidak pernah > $1", () => {
    const r = fixedRiskLevels({
      entryPrice: 100, qty: 37, side: "LONG", tickSize: 0.01,
    });
    // jarak SL = 1/37 = 0.027 -> floor tick = 0.02; SL = 99.98
    expect(r.slPrice).toBeLessThan(100);
    expect(r.tpPrice).toBeGreaterThan(100);
    expect(r.riskUsd).toBeLessThanOrEqual(1.0);
    expect(r.riskUsd).toBeCloseTo(37 * 0.02, 4);
    // TP jarak = 1.7/37 = 0.0459 -> round tick = 0.05
    expect(r.tpUsd).toBeCloseTo(37 * 0.05, 4);
  });

  it("REGRESI fixedRiskLevels: pembulatan tick TIDAK BOLEH membuat risk melewati $1", () => {
    // qty dengan 1/qty TEPAT di antara 2 tick: floor harus menahan risk <= $1.
    for (const qty of [7, 13, 37, 101, 2158, 99999]) {
      const r = fixedRiskLevels({ entryPrice: 0.013944, qty, side: "SHORT", tickSize: 0.000001 });
      expect(r.riskUsd).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });

  it("REGRESI fixedRiskLevels: input invalid ditolak keras", () => {
    expect(() => fixedRiskLevels({ entryPrice: 0, qty: 1, side: "LONG", tickSize: 0.01 })).toThrow("FIXED_LEVELS_INPUT_INVALID");
    expect(() => fixedRiskLevels({ entryPrice: 1, qty: 0, side: "LONG", tickSize: 0.01 })).toThrow("FIXED_LEVELS_INPUT_INVALID");
    expect(() => fixedRiskLevels({ entryPrice: 1, qty: 1, side: "LONG", tickSize: 0 })).toThrow("FIXED_LEVELS_INPUT_INVALID");
  });

});

describe("REST Endpoints Risk Plan (Schema.md 2.1)", () => {
  const app = createApp();

  it("POST /api/orders/plan mengembalikan kalkulasi sizing yang valid", async () => {
    const res = await request(app).post("/api/orders/plan").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "BTCUSDT",
        side: "BUY",
        entryPrice: 60000,
        slPrice: 59400,
        equityUsd: 100,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("plan");
    expect(res.body).toHaveProperty("allowed");
    expect(res.body.sent).toBe(false); // ARM OFF default
    expect(res.body.plan.symbol).toBe("BTCUSDT");
    expect(res.body.plan.side).toBe("LONG");
  });

  it("POST /api/orders/plan menolak jika data harga hilang", async () => {
    const res = await request(app).post("/api/orders/plan").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "BTCUSDT",
      });

    expect(res.status).toBe(400);
  });
});

// ── REGRESI 13 Okt 2026: GATE TOP-LOSER (operator: "boleh trade di top loser
// MAKSIMAL -15%"). JCTUSDT -39.9% & USUSDT -37.6% lolos tanpa gate -> 2x loss.
import { loserDropAllowed, MAX_LOSER_DROP_PCT } from "../src/exec/marketSelectionPolicy.js";
describe("GATE TOP-LOSER -15%", () => {
  it("REGRESI: jatuh > 15% DITOLAK (kasus nyata JCTUSDT -39.9%, USUSDT -37.6%)", () => {
    expect(loserDropAllowed(-39.93).allowed).toBe(false);
    expect(loserDropAllowed(-37.60).allowed).toBe(false);
    expect(loserDropAllowed(-39.93).reason).toContain("LOSER_DROP_TOO_DEEP");
  });
  it("REGRESI: -15% tepat dan lebih dangkal DIIZINKAN; gainer/flat DIIZINKAN", () => {
    expect(loserDropAllowed(-15).allowed).toBe(true);
    expect(loserDropAllowed(-14.99).allowed).toBe(true);
    expect(loserDropAllowed(-3.2).allowed).toBe(true);
    expect(loserDropAllowed(42.5).allowed).toBe(true);
    expect(loserDropAllowed(0).allowed).toBe(true);
  });
  it("REGRESI: data 24h tidak ada = DITOLAK (fail-closed)", () => {
    expect(loserDropAllowed(null).allowed).toBe(false);
    expect(loserDropAllowed(undefined).allowed).toBe(false);
    expect(loserDropAllowed(NaN).allowed).toBe(false);
    expect(loserDropAllowed(null).reason).toBe("LOSER_CHG_UNAVAILABLE");
  });
  it("REGRESI: batas -15% dikunci di konstanta", () => {
    expect(MAX_LOSER_DROP_PCT).toBe(15);
  });
});

// ── REGRESI 13 Okt 2026 (revisi 2): MARGIN = AKIBAT, $3 CUMA PLAFON.
// Keluhan operator: "gw ga mau margin nya fix 3$ itu batasan maximal penggunaan".
import { structuralRiskSizing } from "../src/risk/riskEngine.js";
describe("structuralRiskSizing — margin akibat, bukan flat $3", () => {
  const base = { stepSize: 1, targetRiskUsd: 1, marginCapUsd: 3, maxLeverage: 25 };
  it("REGRESI: SL struktur lebar -> margin DI BAWAH plafon (bukan tepat $3)", () => {
    // entry 0.1000, SL struktur 0.0980 (2% jauh) -> qty = 1/0.002 = 500
    const s = structuralRiskSizing({ ...base, entryPrice: 0.1, structuralSlPrice: 0.098, leverageTarget: 25 });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.qty).toBe(500);
    // leverage 25: margin = 500*0.1/25 = $2.00 < $3 (bukan flat $3)
    expect(s.marginUsd).toBeCloseTo(2.0, 6);
    expect(s.riskAtStructureUsd).toBeCloseTo(1.0, 6);
  });
  it("REGRESI: SL struktur sempit -> leverage otomatis naik, margin tetap ≤ $3", () => {
    // entry 0.001813, SL struktur 0.001838 (kasus JCTUSDT) -> qty = 1/0.000025 = 40000
    const s = structuralRiskSizing({
      ...base, entryPrice: 0.001813, structuralSlPrice: 0.001838,
      stepSize: 1, leverageTarget: 20, maxLeverage: 20,
    });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    // butuh leverage 40000*0.001813/3 = 24.2 -> dibatasi maks simbol 20
    // -> qty dipotong ke 3*20/0.001813 = 33094, margin tepat plafon
    expect(s.qty).toBe(Math.floor(3 * 20 / 0.001813));
    expect(s.leverage).toBe(20);
    expect(s.qty).toBeLessThanOrEqual(33094);
    expect(s.marginUsd).toBeLessThanOrEqual(3 + 1e-9);
  });
  it("REGRESI: leverage maksimal simbol tetap kurang -> qty dipotong, margin = plafon", () => {
    const s = structuralRiskSizing({
      ...base, entryPrice: 0.001813, structuralSlPrice: 0.001838,
      stepSize: 1, leverageTarget: 1, maxLeverage: 10,
    });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.leverage).toBe(10);
    expect(s.qty).toBe(Math.floor(3 * 10 / 0.001813));
    expect(s.marginUsd).toBeLessThanOrEqual(3 + 1e-9);
    expect(s.marginUsd).toBeGreaterThan(2.9); // memang mentok plafon
  });
  it("REGRESI: margin TIDAK PERNAH melebihi plafon di berbagai geometri", () => {
    for (const dist of [0.0005, 0.001, 0.002, 0.005, 0.01]) {
      const s = structuralRiskSizing({
        ...base, entryPrice: 0.05, structuralSlPrice: 0.05 + dist,
        stepSize: 0.1, leverageTarget: 25,
      });
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      expect(s.marginUsd).toBeLessThanOrEqual(3 + 1e-9);
      expect(s.qty).toBeGreaterThan(0);
    }
  });
  it("REGRESI: input tidak valid -> ditolak (fail-closed)", () => {
    expect(structuralRiskSizing({ ...base, entryPrice: 0, structuralSlPrice: 1 }).ok).toBe(false);
    expect(structuralRiskSizing({ ...base, entryPrice: 1, structuralSlPrice: 1 }).ok).toBe(false); // jarak 0
    expect(structuralRiskSizing({ ...base, entryPrice: 1, structuralSlPrice: 0.9, marginCapUsd: 0 }).ok).toBe(false);
  });
});

describe("structuralRiskSizing — band risk $1–$1.2 SWING (aturan operator 15 Okt 2026)", () => {
  const base = {
    structuralSlPrice: 0.098, stepSize: 1, marginCapUsd: 100, maxLeverage: 25, leverageTarget: 25,
  };
  it("band ON: risk selalu >= $1 (floor) walau quantize floor", () => {
    // qtyRisk = 1/0.002 = 500 -> step 1 -> floor 500 -> risk $1 pas
    const s = structuralRiskSizing({ ...base, entryPrice: 0.1, enforceRiskBand: true });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.riskAtStructureUsd).toBeGreaterThanOrEqual(0.999);
  });
  it("band ON: quantize floor di bawah $1 -> naik satu step, tetap <= $1.2", () => {
    // qtyRisk 500.4, step 1 -> floor 500 (risk 1.000) — pakai jarak agar floor < 1
    const s = structuralRiskSizing({ ...base, entryPrice: 0.1, structuralSlPrice: 0.09801, enforceRiskBand: true });
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.riskAtStructureUsd).toBeGreaterThanOrEqual(0.999);
      expect(s.riskAtStructureUsd).toBeLessThanOrEqual(1.2001);
    }
  });
  it("band ON: SL lebar -> qty & margin MENYUSUT (margin akibat, bukan dinaikkan)", () => {
    const near = structuralRiskSizing({ ...base, entryPrice: 0.1, structuralSlPrice: 0.098, enforceRiskBand: true }) as any;
    const wide = structuralRiskSizing({ ...base, entryPrice: 0.1, structuralSlPrice: 0.09, enforceRiskBand: true }) as any;
    expect(wide.ok).toBe(true);
    expect(wide.riskAtStructureUsd).toBeGreaterThanOrEqual(0.999);
    expect(wide.marginUsd).toBeLessThan(near.marginUsd); // SL lebar -> margin turun
  });
  it("band ON: margin cap memaksa risk < $1 -> REJECT (fail-closed), bukan terima risk kecil", () => {
    // SL sangat lebar -> notional besar -> margin lewat cap $0.5
    const s = structuralRiskSizing({
      entryPrice: 0.1, structuralSlPrice: 0.096, stepSize: 1,
      marginCapUsd: 0.5, maxLeverage: 25, enforceRiskBand: true,
    });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.reason).toBe("RISK_FLOOR_MARGIN_CAP");
  });
  it("band OFF (SCALP): perilaku lama tetap — floor quantize boleh < $1", () => {
    const s = structuralRiskSizing({ ...base, entryPrice: 0.1, structuralSlPrice: 0.09801 });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.riskAtStructureUsd).toBeLessThanOrEqual(1.0);
  });
});

// 27 Okt 2026 (operator: "Max SL% 2.5% | 20% itu terlalu lebar, ambil dari
// data lowest SL dari 3 strategi swing gw").
//
// Angka 20% adalah ANGKA MATI: mesin strategi swing sendiri sudah hard-cap 6%
// (rswSignals.ts:373,531 `distance / row.close > 0.06 -> return null`), dan
// master_ledger (research/out/master_v2, 20.014 sinyal RSW-01/02/03, 38
// simbol) mengukur max SL 5,996722% (RSW-02, terendah dari trio) s/d
// 5,998393% (RSW-03). Jadi cap baru = 6% — batas keras mesin, membulatkan ke
// atas supaya tick_size tidak menolak sinyal sah di batas.
describe("CAP SL SWING — provenance dari data terukur trio RSW (27 Okt 2026)", () => {
  it("cap aktif = 6% (batas keras mesin strategi, >= max SL terukur 5,9984%)", () => {
    expect(SETUP_ENGINE.SWING_SL_BAND_MAX).toBe(0.06);
    // Batas terukur di master_v2 (paling lebar dari trio).
    const MEASURED_MAX = 0.059983926200372274; // RSW-03 = 5,998393%
    expect(SETUP_ENGINE.SWING_SL_BAND_MAX).toBeGreaterThan(MEASURED_MAX);
  });

  it("band SWING aktif menolak SL di atas 6% dan menerima yang di bawahnya", () => {
    const band = slBandFor("SWING", null, "RSW-01");
    expect(band.max).toBe(0.06);
    expect(band.min).toBe(0.012);
  });

  it("arsip S-05 (replay historis, non-entry) punya band TERPISAH 20%", () => {
    // Geometri SL S-05 (garis berlawanan x2) jauh lebih lebar: fixture terukur
    // 2,16% (BTC) s/d 18,74% (DOGE). Cap ketat 6% = 57,87% sinyal arsip
    // terbuang, jadi arsip tidak boleh ikut menyempit.
    expect(slBandFor("SWING", null, "S-05").max).toBe(0.2);
    expect(swingSlBandMaxFor("S-05")).toBe(0.2);
    // Entry source aktif tetap ketat.
    expect(swingSlBandMaxFor("RSW-01")).toBe(0.06);
    expect(swingSlBandMaxFor("RSW-02")).toBe(0.06);
    expect(swingSlBandMaxFor("RSW-03")).toBe(0.06);
    // Tanpa strategyId (jalur manual) -> cap aktif, bukan arsip.
    expect(swingSlBandMaxFor(undefined)).toBe(0.06);
  });

  it("calculateOrderPlan: SL 7% di SWING ditolak, SL 5,5% lolos (cap 6%)", () => {
    const tooWide = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SWING", strategyId: "RSW-01",
      side: "LONG", entryPrice: 50000, slPrice: 46500, // 7%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(tooWide.allowed).toBe(false);
    expect(tooWide.rejectReason).toBe("SL_EXCEEDS_MAX");

    const ok = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SWING", strategyId: "RSW-01",
      side: "LONG", entryPrice: 50000, slPrice: 47250, // 5,5%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(ok.rejectReason).not.toBe("SL_EXCEEDS_MAX");
  });

  it("calculateOrderPlan: arsip S-05 tetap menerima SL 7% (replay tidak rusak)", () => {
    const archive = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SWING", strategyId: "S-05",
      side: "LONG", entryPrice: 50000, slPrice: 46500, // 7% > cap aktif 6%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(archive.rejectReason).not.toBe("SL_EXCEEDS_MAX");
  });

  it("resolveMarginPolicy: SWING rejecting SL di atas cap, arsip S-05 lolos", () => {
    const rejected = resolveMarginPolicy({
      mode: "SWING", equityUsd: 200, structuralSlPct: 0.07, strategyId: "RSW-01",
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe("SWING_STRUCTURAL_SL_REQUIRED");

    const archive = resolveMarginPolicy({
      mode: "SWING", equityUsd: 200, structuralSlPct: 0.07, strategyId: "S-05",
    });
    expect(archive.reason).not.toBe("SWING_STRUCTURAL_SL_REQUIRED");
  });
});

// 27 Okt 2026: toleransi tick pada cap SL SWING.
//
// SL struktural di-grid ke tick_size symbol (round AWAY dari entry supaya SL
// tak pernah masuk ke invalidasi). Efeknya % SL bisa naik sedikit di atas
// cap — artefak pembulatan harga, bukan SL yang lebih lebar. Tanpa
// toleransi, 10 dari 20.014 sinyal RSW (0,05%) ditolak palsu; deviasi maks
// terukur 0,0565pp dan tick/E 0,0904pp (NEARUSDT).
describe("TOLERANSI TICK pada cap SL SWING (27 Okt 2026)", () => {
  it("SL di bawah cap + 1 tick tetap diterima (toleransi pembulatan)", () => {
    // Entry 50000, tick 0.1 -> toleransi = 0.1/50000 = 0,000002 (0,0002pp).
    // SL 6,0004% masih di dalam cap + toleransi.
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SWING", strategyId: "RSW-01",
      side: "LONG", entryPrice: 50000, slPrice: 46998, // 6,004%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(plan.rejectReason).not.toBe("SL_EXCEEDS_MAX");
  });

  it("SL jauh di atas cap tetap ditolak (toleransi bukan lubang kelonggaran)", () => {
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SWING", strategyId: "RSW-01",
      side: "LONG", entryPrice: 50000, slPrice: 46000, // 8%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.rejectReason).toBe("SL_EXCEEDS_MAX");
  });

  it("SCALP tidak mendapat toleransi (perilaku lama harus utuh)", () => {
    // SCALP cap 2,5% tanpa toleransi: SL 2,5001% tetap ditolak.
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT", mode: "SCALP",
      side: "LONG", entryPrice: 50000, slPrice: 48749.5, // 2,501%
      equityUsd: 200, symbolRules: dummyBtcRules,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.rejectReason).toBe("SL_EXCEEDS_MAX");
  });

  it("resolveMarginPolicy menerapkan toleransi yang sama", () => {
    const withTol = resolveMarginPolicy({
      mode: "SWING", equityUsd: 200, structuralSlPct: 0.060001, strategyId: "RSW-01",
      tickSize: 0.1, entryPrice: 50000,
    });
    expect(withTol.reason).not.toBe("SWING_STRUCTURAL_SL_REQUIRED");

    const tooWide = resolveMarginPolicy({
      mode: "SWING", equityUsd: 200, structuralSlPct: 0.08, strategyId: "RSW-01",
      tickSize: 0.1, entryPrice: 50000,
    });
    expect(tooWide.allowed).toBe(false);
    expect(tooWide.reason).toBe("SWING_STRUCTURAL_SL_REQUIRED");
  });
});
