// apps/server/tests/swingRswDataWiring.test.ts — T0.6 (19 Okt 2026)
//
// Wiring data RSW ke funnel SWING (CP-1/T-01..T-03):
//  - T-01: loader loadSwingRswContext memasok h4Bars (1000 fetch -> 999 bar
//    tertutup), h1BarsLong (900), btcDailyBars (250) dengan cache + anti-
//    lookahead (bar berjalan dipotong) + shaping fetch hemat rate limit.
//  - T-02: TANPA data = fail-closed (buildRswPlans kosong, tidak pernah fire
//    palsu); DENGAN data produksi = RSW-01/02/03 bisa fire natural (dibuktikan
//    lewat sinyal fixture parity yang direproduksi dari window produksi).
//  - T-03: regresi parity — fixture research/data/rsw-parity dipakai sebagai
//    oracle; sinyal harus identik (entry/sl) lewat jalur loader -> buildRswPlans.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSwingRswContext } from "../src/strategies/modeContext.js";
import { buildRswPlans } from "../src/strategies/researchSwing/rswPlans.js";
import type { StrategyContext } from "../src/strategies/setupStrategies.js";
import type { Bar } from "../src/universe/eligibility.js";
import { aggregate, DAY, HOUR, type Bar as RswBar } from "../src/strategies/researchSwing/rswPrimitives.js";

const ROOT = join(__dirname, "..", "..", "..");
const BARS_DIR = join(ROOT, "data", "swing-v16", "bars-long-history");
const FIXTURE = join(ROOT, "research", "data", "rsw-parity", "avax-h1h4d1.json");

type Fetcher = (symbol: string, interval: string, limit: number) => Promise<unknown[]>;
type Row = Array<number | string>;

const relClose = (a: number, b: number, tol = 1e-9): boolean =>
  a === b || Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12) < tol;

const rowsOf = (bars: RswBar[], stepMs: number, runOpenTime?: number): Row[] => {
  const rows: Row[] = bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume, b.time + stepMs - 1]);
  if (runOpenTime !== undefined) rows.push([runOpenTime, 0, 0, 0, 0, 0, runOpenTime + stepMs - 1]);
  return rows;
};

const ctxOf = (loaded: { h4Bars?: Bar[]; h1BarsLong?: Bar[]; btcDailyBars?: Bar[] },
  h1Bars: Bar[], price: number): StrategyContext => ({
    analysis: { symbol: "AVAXUSDT" },
    price,
    mode: "SWING",
    swing: { h1Bars, ...loaded },
  } as unknown as StrategyContext);

// ─────────────────────────────────────────────────────────────────────────────
describe("T0.6 loader loadSwingRswContext — shaping, anti-lookahead, fail-closed", () => {
  // now harus monoton naik di seluruh file test (cache loader memakai expiry
  // absolut) dan LEBIH KECIL dari semua fixture time (min ~1,653e12) supaya
  // cache tidak bocor ke describe integrasi yang memakai now = T+1.
  let nowTick = 1_600_000_000_000;
  const nextNow = () => (nowTick += 1_000_000); // > cache TTL (60s/600s) antar-test

  const synthetic = (intervalMs: number, now: number, closed = 5): Row[] => {
    const rows: Row[] = [];
    for (let i = closed; i >= 1; i--) rows.push([now - (i + 1) * intervalMs, 1, 2, 0.5, 1.5, 10, now - i * intervalMs - 1]);
    rows.push([now - 60_000, 1, 2, 0.5, 1.5, 10, now - 60_000 + intervalMs - 1]); // bar berjalan
    return rows;
  };

  it("tanpa RSW di allowlist: nol fetch, return undefined (hemat rate limit)", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (s, i, l) => { calls.push(`${s}:${i}:${l}`); return []; };
    const res = await loadSwingRswContext("WIRE-1", ["S-03", "S-05"], fetcher, nextNow());
    expect(res).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("shaping fetch sesuai allowlist: RSW-02 hanya H4; RSW-01 H4+BTC D1; RSW-03 H4+H1-900", async () => {
    const calls: string[][] = [];
    const fetcher: Fetcher = async (s, i, l) => {
      calls.push([s, i, String(l)]);
      const ms = i === "4h" ? 4 * HOUR : i === "1h" ? HOUR : DAY;
      return synthetic(ms, nowTick);
    };
    const r2 = await loadSwingRswContext("WIRE-2", ["RSW-02"], fetcher, nextNow());
    expect(calls).toEqual([["WIRE-2", "4h", "1000"]]);
    expect(r2?.h4Bars?.length).toBe(5);
    expect(r2?.h1BarsLong).toBeUndefined();
    expect(r2?.btcDailyBars).toBeUndefined();

    calls.length = 0;
    const r1 = await loadSwingRswContext("WIRE-3", ["RSW-01"], fetcher, nextNow());
    expect(calls).toEqual([["WIRE-3", "4h", "1000"], ["BTCUSDT", "1d", "1000"]]);
    expect(r1?.h4Bars?.length).toBe(5);
    expect(r1?.btcDailyBars?.length).toBe(5);
    expect(r1?.h1BarsLong).toBeUndefined();

    calls.length = 0;
    const r3 = await loadSwingRswContext("WIRE-4", ["RSW-03"], fetcher, nextNow());
    expect(calls).toEqual([["WIRE-4", "4h", "1000"], ["WIRE-4", "1h", "900"]]);
    expect(r3?.h4Bars?.length).toBe(5);
    expect(r3?.h1BarsLong?.length).toBe(5);
    expect(r3?.btcDailyBars).toBeUndefined();
  });

  it("anti-lookahead: bar berjalan dibuang di semua timeframe (h4/h1/d1)", async () => {
    const now = nextNow();
    const fetcher: Fetcher = async (_s, i) =>
      synthetic(i === "4h" ? 4 * HOUR : i === "1h" ? HOUR : DAY, now);
    const res = await loadSwingRswContext("WIRE-5", ["RSW-01", "RSW-02", "RSW-03"], fetcher, now);
    expect(res?.h4Bars).toHaveLength(5);
    expect(res?.h1BarsLong).toHaveLength(5);
    expect(res?.btcDailyBars).toHaveLength(5);
    // bar terakhir yang tersisa = bar TERTUTUP (openTime <= now - interval)
    const lastH4 = res!.h4Bars!.at(-1)!;
    expect(now - lastH4.openTime).toBeGreaterThanOrEqual(4 * HOUR);
  });

  it("konversi object {openTime,...} setara array Binance mentah", async () => {
    const now = nextNow();
    const asArray: Row[] = synthetic(4 * HOUR, now, 3);
    const asObject = asArray.map((r) => ({ openTime: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    const fArr: Fetcher = async () => asArray;
    const fObj: Fetcher = async () => asObject;
    const a = await loadSwingRswContext("WIRE-6", ["RSW-02"], fArr, now);
    const b = await loadSwingRswContext("WIRE-7", ["RSW-02"], fObj, now);
    expect(b?.h4Bars).toEqual(a?.h4Bars);
  });

  it("fail-closed: fetch throw -> field kosong, tidak throw, buildRswPlans tetap kosong", async () => {
    const now = nextNow();
    const fetcher: Fetcher = async () => { throw new Error("REST cooldown"); };
    const res = await loadSwingRswContext("WIRE-8", ["RSW-01", "RSW-02", "RSW-03"], fetcher, now);
    expect(res?.h4Bars ?? []).toEqual([]);
    const plans = buildRswPlans(ctxOf(res ?? {}, [], 100), ["RSW-01", "RSW-02", "RSW-03"]);
    expect(plans).toEqual([]);
  });

  it("fail-closed: h4Bars < 200 -> buildRswPlans kosong (tidak pernah fire palsu)", () => {
    const short: Bar[] = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1_800_000_000_000 + i * 4 * HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    }));
    const plans = buildRswPlans(ctxOf({ h4Bars: short, h1BarsLong: short, btcDailyBars: short }, short, 1.5),
      ["RSW-01", "RSW-02", "RSW-03"]);
    expect(plans).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integrasi (T-02 + T-03): data 15m NYATA (fixture parity) -> window PRODUKSI
// -> loader -> buildRswPlans -> plan matched dengan entry/sl IDENTIK fixture.
// Ini buktiu "RSW bisa fire natural dengan data produksi" — bukan sinyal karangan.
describe("T0.6 firing produksi: window produksi lewat loader -> RSW fire identik fixture", () => {
  const fixtureExists = existsSync(FIXTURE) && existsSync(join(BARS_DIR, "AVAXUSDT-15m.csv"));
  const fixture = fixtureExists ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : { signals: [] };
  const sigs: Array<{ symbol: string; time: number; side: string; strategyId: string; entry: number; sl: number }> = fixture.signals;

  function load15m(symbol: string): RswBar[] {
    const rows: RswBar[] = [];
    for (const line of readFileSync(join(BARS_DIR, `${symbol}-15m.csv`), "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const p = t.split(",");
      rows.push({ time: Number(p[0]), open: Number(p[1]), high: Number(p[2]), low: Number(p[3]), close: Number(p[4]), volume: Number(p[5]) });
    }
    return rows;
  }

  const series = fixtureExists ? (() => {
    const ex15 = load15m("AVAXUSDT");
    return {
      h4: aggregate(ex15, 4 * HOUR),
      h1: aggregate(ex15, HOUR),
      d1: aggregate(load15m("BTCUSDT"), DAY),
    };
  })() : null;

  async function fireThroughLoader(sig: { time: number; strategyId: string; entry: number; sl: number }) {
    const { h4, h1, d1 } = series!;
    const T = sig.time;
    // window produksi persis seperti yang diminta loader: H4 1000, H1 900, D1 1000.
    // (D1 >= ~500 hari: EMA200 regime BTC harus hangat — suplai 250 hari membuat
    // gate BTC_D1_ALIGN kaki BOS_LONG meleset dari oracle, terbukti lewat probe.)
    const win4 = h4.filter((b) => b.time < T).slice(-1000);
    const win1 = h1.filter((b) => b.time < T).slice(-900);
    const winD1 = d1.filter((b) => b.time + DAY <= T).slice(-1000);
    const fetcher: Fetcher = async (_s, interval) => {
      if (interval === "4h") return rowsOf(win4, 4 * HOUR, T); // + bar berjalan (harus dibuang)
      if (interval === "1h") return rowsOf(win1, HOUR, T);
      return rowsOf(winD1, DAY, T);
    };
    const loaded = await loadSwingRswContext("AVAXUSDT", ["RSW-01", "RSW-02", "RSW-03"], fetcher, T + 1);
    // bar berjalan harus sudah terbuang: bar terakhir = bar sinyal
    expect(loaded!.h4Bars!.at(-1)!.openTime).toBeLessThan(T);
    return buildRswPlans(ctxOf(loaded!, [], sig.entry), ["RSW-01", "RSW-02", "RSW-03"]);
  }

  const pick = (sid: string) => {
    const arr = sigs.filter((s) => s.strategyId === sid);
    return [arr[0], arr[Math.floor(arr.length / 2)], arr[arr.length - 1]].filter(Boolean);
  };
  // Urut naik per waktu: now = T+1 harus monoton supaya cache loader
  // (expiry absolut) tidak mengembalikan window era lain.
  const cases = [...pick("RSW-01"), ...pick("RSW-02"), ...pick("RSW-03")]
    .sort((a, b) => a.time - b.time);

  it("fixture parity tersedia (data 15m + oracle Python)", () => {
    expect(fixtureExists, "data/swing-v16/bars-long-history + research/data/rsw-parity harus ada").toBe(true);
    // 24 Okt 2026 — FIX ownership RSW-02: kaki SHORT PHEN sekarang hanya
    // dimiliki RSW-01, jadi jumlah sinyal fixture turun (AVAX 529 -> 422).
    // Yang dijaga di sini adalah KECUKUPAN DATA per kaki strategi, bukan
    // jumlah baris mentah: setiap kaki yang dipakai tes harus punya >= 3
    // sinyal supaya 3 titik (awal/tengah/akhir) benar-benar terambil.
    expect(sigs.length).toBeGreaterThan(400);
    const bySided = new Map<string, number>();
    for (const s of sigs) {
      const k = `${s.strategyId}|${s.side}`;
      bySided.set(k, (bySided.get(k) ?? 0) + 1);
    }
    for (const [k, n] of bySided) {
      expect(n, `kaki ${k} harus punya minimal 3 sinyal`).toBeGreaterThanOrEqual(3);
    }
    // Tidak boleh ada lagi pasangan SHORT identik milik RSW-01 + RSW-02
    // (regresi shadowing).
    const shortByKey = new Map<string, Set<string>>();
    for (const s of sigs) {
      if (s.side !== "SHORT") continue;
      const k = `${s.symbol}|${s.time}`;
      const set = shortByKey.get(k) ?? new Set<string>();
      set.add(s.strategyId);
      shortByKey.set(k, set);
    }
    for (const [k, ids] of shortByKey) {
      expect(
        ids.has("RSW-02") && ids.has("RSW-01"),
        `kaki SHORT ${k} masih dimiliki RSW-01 DAN RSW-02 (duplikat)`
      ).toBe(false);
    }
    expect(cases.length).toBe(9);
  });

  for (const sig of cases) {
    it(`RSW fire natural: ${sig.strategyId} ${sig.side} @${sig.time} (window produksi)`, async () => {
      const plans = await fireThroughLoader(sig);
      const hit = plans.find((p) => p.strategyId === sig.strategyId && p.matched);
      expect(hit, `plan ${sig.strategyId}@${sig.time} tidak muncul lewat jalur produksi`).toBeTruthy();
      expect(relClose(hit!.entryPrice, sig.entry), `entry ${sig.strategyId}@${sig.time}`).toBe(true);
      expect(relClose(hit!.slPrice, sig.sl), `sl ${sig.strategyId}@${sig.time}`).toBe(true);
    });
  }
});
