// apps/server/tests/slTpMenu.test.ts
// Menu SL/TP deterministik (Opsi 2 Hybrid): LLM memilih ID varian, kode memegang
// seluruh angka. Uji: menu deterministik, fail-safe default, dan jalur risk engine.
import { describe, expect, it } from "vitest";
import {
  buildSlTpMenu,
  applySlTpChoice,
  validatePlan,
  type StrategyPlan,
  type Side,
} from "../src/strategies/setupStrategies.js";
import { SETUP_ENGINE } from "../src/config/setupEngine.js";
import { calculateOrderPlan, type SymbolRiskRules } from "../src/risk/riskEngine.js";

const rules: SymbolRiskRules = {
  symbol: "BTCUSDT",
  minNotional: 5,
  tickSize: 0.1,
  stepSize: 0.001,
  maxLeverage: 50,
  leverageUpdatedAt: Date.now(),
  isBlacklisted: false,
};

function mkPlan(
  side: Side,
  entry: number,
  sl: number,
  tp1R = SETUP_ENGINE.rrByMode.SCALP.tp1R,
  slAtrPct: number | null = 0.005
): StrategyPlan {
  const dir = side === "LONG" ? 1 : -1;
  const r = Math.abs(entry - sl);
  const tp1 = Number((entry + dir * tp1R * r).toFixed(8));
  return {
    strategyId: "S-04",
    strategyName: "Liquidity Sniper",
    mode: "SCALP",
    matched: true,
    side,
    entryType: "MARKET_PULLBACK",
    entryPrice: entry,
    slPrice: sl,
    tp1Price: tp1,
    slPct: Number((r / entry).toFixed(6)),
    slAtrPct,
    rDistance: r,
    rr1: tp1R,
    quality: 70,
    zoneType: "OB",
    zoneTop: entry + 1,
    zoneBottom: entry - 1,
    zoneScore: 60,
    slBasis: "ZONE_INVALIDATION",
    tpBasis: "RR",
    reasons: [],
    tfSummary: "test",
  };
}

describe("Menu SL/TP deterministik (Opsi 2 Hybrid)", () => {
  it("menu TP[0] wajib sama dengan tp1R klasik policy (single source of truth)", () => {
    expect(SETUP_ENGINE.slTpMenu.tpR[0]).toBe(SETUP_ENGINE.rrByMode.SCALP.tp1R);
    expect(SETUP_ENGINE.slTpMenu.tpR.every((r) => r >= SETUP_ENGINE.minRr1)).toBe(true);
  });

  it("mengembalikan null bila SL struktural tidak valid (tidak ada menu bagi plan rusak)", () => {
    expect(buildSlTpMenu(100, "LONG", { slPrice: 101, slAtrPct: 0.005 }, "SCALP")).toBeNull();
    expect(buildSlTpMenu(0, "LONG", { slPrice: 98, slAtrPct: 0.005 }, "SCALP")).toBeNull();
  });

  it("menu LONG: SL A struktural, SL B lebih jauh (buffer ATR), TP A (1.7R tunggal)", () => {
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 98.5, slAtrPct: 0.005 }, "SCALP")!;
    expect(menu.sl[0]).toMatchObject({ id: "A", slPrice: 98.5 });
    expect(menu.sl.map((v) => v.id)).toContain("B");
    expect(menu.sl[1]!.slPrice).toBeLessThan(98.5); // LONG: buffer ke luar = lebih rendah
    expect(menu.tp.map((v) => v.id)).toEqual(["A"]);
    expect(menu.tp.map((v) => v.r)).toEqual([1.7]);
    expect({ sl: menu.defaultSlId, tp: menu.defaultTpId }).toEqual({ sl: "A", tp: "A" });
  });

  it("menu SHORT simetris (buffer ATR menaikkan harga SL)", () => {
    const menu = buildSlTpMenu(100, "SHORT", { slPrice: 101.5, slAtrPct: 0.005 }, "SCALP")!;
    expect(menu.sl[0]!.slPrice).toBe(101.5);
    expect(menu.sl[1]!.slPrice).toBeGreaterThan(101.5);
  });

  it("varian SL B dibuang bila buffer menembus batas band (tidak ada menu di luar policy)", () => {
    // SL 2.4% + buffer 0.46*1% = 2.86% > band.max 2.5% -> clampSlToBand INVALID.
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 97.6, slAtrPct: 0.01 }, "SCALP")!;
    expect(menu.sl.map((v) => v.id)).toEqual(["A"]);
  });

  it("pilihan valid (B/A): angka dihitung kode, override R = 1.7, satu target", () => {
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 98.5, slAtrPct: 0.005 }, "SCALP")!;
    const res = applySlTpChoice(mkPlan("LONG", 100, 98.5), menu, "B", "A");
    expect(res).toMatchObject({ fellBack: false, slId: "B", tpId: "A" });
    expect(res.plan.tp1ROverride).toBe(1.7);
    expect(res.plan.matched).toBe(true);
    expect(res.plan.reasons).toContain("MENU_SL_B");
    expect(res.plan.reasons).toContain("MENU_TP_A");
    expect(res.plan.reasons).not.toContain("MENU_FALLBACK_DEFAULT");
    expect(res.plan.slPrice).toBeCloseTo(98.27, 8); // 98.5 - 0.46*0.005*100
    expect(res.plan.tp1Price).toBeCloseTo(100 + 1.7 * 1.73, 8);
  });

  it("ID di luar menu -> default A/A + MENU_FALLBACK_DEFAULT (fail-safe, bukan entry paksa)", () => {
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 98.5, slAtrPct: 0.005 }, "SCALP")!;
    const res = applySlTpChoice(mkPlan("LONG", 100, 98.5), menu, "Z", null);
    expect(res).toMatchObject({ fellBack: true, slId: "A", tpId: "A" });
    expect(res.plan.slPrice).toBe(98.5);
    expect(res.plan.tp1ROverride).toBe(1.7);
    expect(res.plan.reasons).toContain("MENU_FALLBACK_DEFAULT");
    expect(res.plan.matched).toBe(true);
  });

  it("satu pilihan tidak valid -> SEMUA default A/A (strict fail-safe, respons parsial tidak dipercaya)", () => {
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 98.5, slAtrPct: 0.005 }, "SCALP")!;
    // SL "A" valid, TP "Z" di luar menu -> keduanya jatuh ke default A/A.
    const res = applySlTpChoice(mkPlan("LONG", 100, 98.5), menu, "A", "Z");
    expect(res).toMatchObject({ fellBack: true, slId: "A", tpId: "A" });
    expect(res.plan.tp1ROverride).toBe(1.7);
    expect(res.plan.slPrice).toBe(98.5);
    expect(res.plan.reasons).toContain("MENU_FALLBACK_DEFAULT");
    // Kebalikannya: SL "Z" invalid walau TP "C" valid -> tetap A/A.
    const res2 = applySlTpChoice(mkPlan("LONG", 100, 98.5), menu, "Z", "C");
    expect(res2).toMatchObject({ fellBack: true, slId: "A", tpId: "A" });
    expect(res2.plan.tp1ROverride).toBe(1.7);
  });

  it("varian B tidak ada di menu fresh -> fallback ke A (menu vs plan tidak sinkron)", () => {
    const menu = buildSlTpMenu(100, "LONG", { slPrice: 97.6, slAtrPct: 0.01 }, "SCALP")!;
    const res = applySlTpChoice(mkPlan("LONG", 100, 97.6), menu, "B", "A");
    expect(res).toMatchObject({ fellBack: true, slId: "A" });
    expect(res.plan.reasons).toContain("MENU_FALLBACK_DEFAULT");
  });

  it("menu tidak tersedia -> plan tidak diubah sama sekali (mode deterministik/outage)", () => {
    const base = mkPlan("LONG", 100, 98.5);
    const res = applySlTpChoice(base, null, "B", "C");
    expect(res.fellBack).toBe(true);
    expect(res.plan.tp1ROverride).toBeUndefined();
    expect(res.plan.slPrice).toBe(base.slPrice);
    expect(res.plan.tp1Price).toBe(base.tp1Price);
  });

  it("tanpa override, gate RR2 single-target MENERIMA 1.7R (RR klasik 1:1.7)", () => {
    const v = validatePlan(mkPlan("LONG", 100, 98.5, 1.7), 100);
    expect(v.matched).toBe(true);
    expect(v.reasons).not.toContain("RR2_TOO_LOW");
    expect(v.reasons).not.toContain("RR2_TOO_HIGH");
  });

  it("risk engine menerima override R menu (1.7R) tanpa INVALID_TP_GEOMETRY", () => {
    const tp = 100 + 1.7 * 1.5;
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      mode: "SCALP",
      strategyId: "S-04",
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tp1Price: tp,
      tp1ROverride: 1.7,
      equityUsd: 200,
      targetRiskUsd: 1,
      symbolRules: rules,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.tp2Price).toBe(plan.tp1Price);
    expect(plan.rejectReason).toBeNull();
  });

  it("default (tanpa override) = 1.7R di risk engine (RR klasik 1:1.7)", () => {
    const plan = calculateOrderPlan({
      symbol: "BTCUSDT",
      mode: "SCALP",
      strategyId: "S-04",
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      equityUsd: 200,
      targetRiskUsd: 1,
      symbolRules: rules,
    });
    expect(plan.allowed).toBe(true);
    // RR klasik 1.7 * 1.5 = 2.55 -> grid tick 0.1 -> 102.6
    expect(plan.tp1Price).toBeCloseTo(100 + 1.7 * 1.5, 0);
    expect(plan.tp2Price).toBe(plan.tp1Price);
  });
});