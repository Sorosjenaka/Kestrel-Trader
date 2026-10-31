// apps/server/tests/rsw02Shadowing.test.ts
// 24 Okt 2026 — REGRESI: RSW-02 tidak boleh punya plan DUPLIKAT dari sinyal
// PHEN_FADE_LIMIT SHORT yang sama dengan RSW-01.
//
// BUG ASLI (23 Okt 2026): h4Signals() (rswSignals.ts) mendorong SATU sinyal
// PHEN_FADE_LIMIT SHORT menjadi DUA plan identik: RSW-01 dan RSW-02.
// Keduanya punya entry/sl/priority sama -> planFromSignal() menghasilkan quality
// sama -> sort `b.quality - a.quality` tidak membedakannya ->
// selectBestPlan() mengambil `all.find(p => p.matched)` = plan PERTAMA.
// Karena h4Signals push RSW-01 DULUAN, RSW-01 selalu menang tie-break ->
// RSW-02 structurally shadowed untuk SETIAP sinyal SHORT (0% peluang entry).
//
// BUKTI (master_v2 43.901 baris + probe offline 38 simbol):
//   - 3.955 pasangan SHORT, entry+sl IDENTIK, 0 sinyal eksklusif RSW-02
//   - RSW-01 SHORT executed=201 PF=1.352 sumR=+43.14
//   - RSW-02 SHORT executed=0 (DUP_SYMBOL 2.299 / SLOT 1.656)
//   - probe: shortSignalRows=7.916 uniqueShortKeys=3.958 duplicationRatio=2.0
//
// FIX (24 Okt 2026): kaki SHORT PHEN_FADE_LIMIT dimiliki RSW-01 SAJA.
//
// Test memakai DATA NYATA (fixture H4 Binance Futures BTCUSDT 999 bar) dan
// CUT INDEX yang sudah dibuktikan memunculkan event PHEN_FADE_LIMIT, supaya
// test tidak vacuous. Fixture: fixtures/swing/h4_btc_999.json
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRswPlans } from "../src/strategies/researchSwing/rswPlans.js";
import { selectBestPlan } from "../src/strategies/setupStrategies.js";
import type { StrategyContext } from "../src/strategies/setupStrategies.js";
import type { Bar } from "../src/universe/eligibility.js";

const FIXTURE_PATHS = [
  resolve(process.cwd(), "fixtures/swing/h4_btc_999.json"),
  resolve(process.cwd(), "../../fixtures/swing/h4_btc_999.json"),
];

function loadFixture(): { h4: Bar[]; btcDaily: Bar[] } | null {
  for (const f of FIXTURE_PATHS) {
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, "utf8")) as { h4: Bar[]; btcDaily?: Bar[] };
    if (Array.isArray(raw.h4) && raw.h4.length >= 200) {
      return { h4: raw.h4, btcDaily: raw.btcDaily ?? [] };
    }
  }
  return null;
}

function ctxWith(h4: Bar[], btcDaily: Bar[]): StrategyContext {
  return {
    analysis: { symbol: "BTCUSDT", side: "SHORT", price: 100, usable: true } as never,
    price: 100,
    mode: "SWING",
    swing: { h1Bars: [], h4Bars: h4, btcDailyBars: btcDaily },
  } as unknown as StrategyContext;
}

// Cut index yang terbukti memunculkan PHEN_FADE_LIMIT SHORT di bar terakhir
// (hasil probe tools/probe-rsw02-frequency.ts + generateH4 scan).
const SHORT_CUTS = [848, 901, 936, 949];

const fx = loadFixture();

describe.skipIf(!fx)("RSW-02 vs RSW-01 — kepemilikan plan (fixture H4 BTCUSDT nyata)", () => {
  it("fixture H4 memuat cukup bar dan BTC D1 (data-sufficiency)", () => {
    expect(fx!.h4.length).toBeGreaterThanOrEqual(200);
    expect(fx!.btcDaily.length).toBeGreaterThanOrEqual(200);
  });

  for (const cut of SHORT_CUTS) {
    it(`cut=${cut}: sinyal SHORT PHEN menghasilkan plan RSW-01, BUKAN plan RSW-02 duplikat`, () => {
      const ctx = ctxWith(fx!.h4.slice(0, cut + 1), fx!.btcDaily);
      const plans = buildRswPlans(ctx, ["RSW-01", "RSW-02"]);
      const rsw01 = plans.find((p) => p.strategyId === "RSW-01" && p.matched);
      expect(rsw01, "RSW-01 plan matched harus ada (kaki SHORT PHEN miliknya)").toBeDefined();

      // FIX: tidak boleh ada plan RSW-02 yang meniru sinyal SHORT yang sama.
      const rsw02 = plans.find((p) => p.strategyId === "RSW-02" && p.matched);
      if (rsw02) {
        // Kalau RSW-02 muncul, itu harus kaki LONG (PHEN Profile / BOS),
        // yang arahnya berlawanan — bukan duplikat SHORT.
        expect(
          rsw02.side,
          `RSW-02 tidak boleh meniru sinyal SHORT yang sama (entry=${rsw02.entryPrice} sl=${rsw02.slPrice})`
        ).not.toBe("SHORT");
        expect(rsw02.entryPrice).not.toBe(rsw01!.entryPrice);
        expect(rsw02.slPrice).not.toBe(rsw01!.slPrice);
      }
    });

    it(`cut=${cut}: TIDAK ada dua plan dengan entry+sl identik dari sinyal yang sama`, () => {
      const ctx = ctxWith(fx!.h4.slice(0, cut + 1), fx!.btcDaily);
      const plans = buildRswPlans(ctx, ["RSW-01", "RSW-02"]).filter((p) => p.matched);
      const seen = new Map<string, string>();
      for (const p of plans) {
        const key = `${p.side}|${p.entryPrice}|${p.slPrice}|${p.tp1Price}`;
        const prev = seen.get(key);
        expect(prev, `plan ${p.strategyId} duplikat identik dengan ${prev}`).toBeUndefined();
        seen.set(key, p.strategyId);
      }
    });

    it(`cut=${cut}: selectBestPlan tidak memilih plan duplikat`, async () => {
      const ctx = ctxWith(fx!.h4.slice(0, cut + 1), fx!.btcDaily);
      const sel = await selectBestPlan(ctx, Date.now(), ["RSW-01", "RSW-02"]);
      expect(sel.plan, "harus ada plan terpilih").not.toBeNull();
      const matched = sel.all.filter((p) => p.matched);
      const key = (s: string) => `${s}|${sel.plan!.entryPrice}|${sel.plan!.slPrice}|${sel.plan!.tp1Price}`;
      const twins = matched.filter((p) => key(`${p.side}`) === key(`${sel.plan!.side}`));
      expect(twins.length, "hanya boleh 1 plan untuk kombinasi side+entry+sl+tp1").toBe(1);
    });
  }

  it("kaki LONG tetap milik pemiliknya: RSW-01 (BOS D1) dan RSW-02 (PHEN Profile)", () => {
    // Di fixture, ada cut dengan sinyal LONG. RSW-02 LONG (PHEN Profile
    // Context) dan RSW-01 LONG (BOS_LIMIT_RETEST + BTC_D1_ALIGN) tidak boleh
    // saling menimpa entry.
    const allPlans = SHORT_CUTS.map((cut) =>
      buildRswPlans(ctxWith(fx!.h4.slice(0, cut + 1), fx!.btcDaily), ["RSW-01", "RSW-02"])
    );
    const longs = allPlans
      .flat()
      .filter((p) => p.matched && p.side === "LONG")
      .map((p) => `${p.strategyId}|${p.entryPrice}|${p.slPrice}`);
    const dupLong = longs.filter((k, i) => longs.indexOf(k) !== i);
    expect(dupLong.length, `plan LONG identik antar strategi: ${dupLong.join(", ")}`).toBe(0);
  });
});
