// apps/server/tests/swingUsableGateRswReachability.test.ts
// 20 Okt 2026 (AU1-01, BLOCKER) — REGRESI gate `usable` lane SWING.
//
// BLOKIRAN YANG DIUJI:
//   Gate `usable` (MtfAnalysis.usable) di lane SWING awalnya = "ada sinyal
//   breakout S-05 pada bar 1h tertutup terakhir". Di funnel SWING
//   (autonomousTradingBot.fillSwingSlotsOnce) gate itu dipakai sebagai
//   pre-filter SEBELUM selectBestPlan() -> buildRswPlans() dipanggil.
//   Akibatnya RSW-01/02/03 praktis tidak pernah fire (92,6% window hilang) --
//   persis kebalikan dari perintah operator ("RSW tetap aktif di lane SWING").
//
// KONTRAK YANG DIUJI (3 bagian):
//   1. PARITAS: usable = kelengkapan data (snapshot tersedia + harga > 0),
//      sama seperti composeMtfAnalysis() di jalur replay/backtest.
//   2. FAIL-CLOSED S-05: tanpa sinyal S-05, plan S-05 TIDAK match dan
//      reasons memuat "SWING_NO_SIGNAL_ON_LAST_CLOSED_H1".
//   3. FAIL-CLOSED RSW: RSW hanya fire bila trigger H4/H1-nya benar-benar
//      ada (h4Bars >= 200 / h1BarsLong >= 801). Data kurang -> plan kosong.
//
// Test ini adalah "blind spot" yang AU1 tunjuk: tidak ada test yang
// membuktikan RSW tetap terjangkau setelah gate diperbaiki. Semua test
// sebelumnya hanya menguji S-05.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeSwingTimeframe, klinesToBars, type KlineFetcher } from "../src/engines/multiTimeframeAnalyzer.js";
import { evaluateSwingBreakout, buildStrategyPlans, type StrategyContext } from "../src/strategies/setupStrategies.js";
import { buildRswPlans } from "../src/strategies/researchSwing/rswPlans.js";
import type { Bar } from "../src/universe/eligibility.js";
import type { Bar as RswBar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { aggregate, DAY, HOUR } from "../src/strategies/researchSwing/rswPrimitives.js";

const ROOT = join(__dirname, "..", "..", "..");
const BARS_DIR = join(ROOT, "data", "swing-v16", "bars-long-history");
const FIXTURE = join(ROOT, "research", "data", "rsw-parity", "avax-h1h4d1.json");
const SWING_FIXTURE = join(ROOT, "apps", "server", "tests", "fixtures", "swing");

// ─────────────────────────────────────────────────────────────────────────────
// Bagian 1+2: gate usable (kelengkapan data) + S-05 tetap fail-closed.
// ─────────────────────────────────────────────────────────────────────────────
describe("AU1-01 — gate usable lane SWING = kelengkapan data; S-05 tetap fail-closed", () => {
  function loadSwingBars(sym: string): Bar[] {
    const text = readFileSync(join(SWING_FIXTURE, `${sym}-1h.csv`), "utf8");
    const bars: Bar[] = [];
    for (const row of text.split(/\r?\n/)) {
      if (!row) continue;
      const cells = row.split(",");
      const t = Number(cells[0]);
      if (!Number.isFinite(t) || t < 1.5e12) continue;
      const open = Number(cells[1]);
      const high = Number(cells[2]);
      const low = Number(cells[3]);
      const close = Number(cells[4]);
      const volume = Number(cells[5]);
      if (![open, high, low, close, volume].every(Number.isFinite)) continue;
      bars.push({ openTime: t, open, high, low, close, volume });
    }
    return bars;
  }

  function stubFetcher(bars: Bar[]): KlineFetcher {
    return async () => bars.map((b) => [b.openTime, b.open, b.high, b.low, b.close, b.volume]);
  }

  it("data cukup tanpa sinyal S-05 -> usable=true (RSW jadi bisa dievaluasi), tapi plan S-05 TIDAK match", async () => {
    const bars = loadSwingBars("BTCUSDT");
    // 20 Okt 2026 (BUG-5): Skor kini deterministik dari snapshot, bukan 0/75
    // berdasarkan sinyal S-05. Cari slice yang usable dengan skor > 0 sebagai
    // bukti bahwa RSW-01/02/03 bisa dievaluasi tanpa sinyal S-05.
    let found: { slice: Bar[]; now: number } | null = null;
    for (let end = 200; end < Math.min(bars.length, 600); end++) {
      const slice = bars.slice(0, end + 1);
      const now = slice[slice.length - 1]!.openTime + 2 * 3_600_000;
      const a = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(slice), { now, skipCache: true });
      if (a.usable && a.compositeScore > 0) { found = { slice, now }; break; }
    }
    expect(found).not.toBeNull();
    if (!found) return;

    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(found.slice), { now: found.now, skipCache: true });
    // KONTRAK 1 (paritas): usable = kelengkapan data, bukan sinyal S-05.
    expect(analysis.usable).toBe(true);
    expect(analysis.reason).toBeNull();
    // 20 Okt 2026 (BUG-5): Skor deterministik dari snapshot (trend/zone/trigger),
    // tidak lagi 0 hanya karena tidak ada sinyal S-05.
    expect(analysis.compositeScore).toBeGreaterThan(0);
    expect(analysis.triggerScore).toBeGreaterThan(0);

    // KONTRAK 2 (S-05 retired 20 Okt 2026): plan S-05 TIDAK ADA lagi di
    // jalur entry — S-05 dihapus dari katalog aktif (operator: "polaris hapus
    // juga"). Fail-closed: STRATEGY_RETIRED, tanpa crash, tanpa level karangan.
    const ctx = {
      analysis,
      price: analysis.price,
      mode: "SWING",
      swing: { h1Bars: analysis.trigger.barsData as unknown as Bar[] },
    } as unknown as StrategyContext;
    const plan = evaluateSwingBreakout(ctx);
    expect(plan.matched).toBe(false);
    expect(plan.reasons).toEqual(["STRATEGY_RETIRED"]);
    expect(plan.entryPrice).toBe(0);
    expect(plan.slPrice).toBe(0);
  });

  it("data di bawah warmup -> usable=false (fail-closed, tidak ada data means tidak ada analisis)", async () => {
    const bars = loadSwingBars("BTCUSDT").slice(0, 50);
    const now = bars[bars.length - 1]!.openTime + 2 * 3_600_000;
    const analysis = await analyzeSwingTimeframe("TESTUSDT", stubFetcher(bars), { now, skipCache: true });
    expect(analysis.usable).toBe(false);
    expect(analysis.reason).toBe("INSUFFICIENT_KLINES:1h");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian 3: RSW-01/02/03 TETAP terjangkau (blind spot AU1-01) + fail-closed.
// memakai fixture parity yang sama dengan tests/swingRswDataWiring.test.ts
// (data 15m NYATA -> window produksi -> loader -> buildRswPlans).
// ─────────────────────────────────────────────────────────────────────────────
describe("AU1-01 — RSW-01/02/03 tetap terjangkau lewat gate usable yang diperbaiki", () => {
  const fixtureExists = existsSync(FIXTURE) && existsSync(join(BARS_DIR, "AVAXUSDT-15m.csv"));
  const fixture = fixtureExists ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : { signals: [] };
  const sigs: Array<{ symbol: string; time: number; side: string; strategyId: string; entry: number; sl: number }> = fixture.signals;

  function load15m(symbol: string): RswBar[] {
    const rows: RswBar[] = [];
    for (const line of readFileSync(join(BARS_DIR, `${symbol}-15m.csv`), "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const p = t.split(",");
      rows.push({
        time: Number(p[0]), open: Number(p[1]), high: Number(p[2]),
        low: Number(p[3]), close: Number(p[4]), volume: Number(p[5]),
      });
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

  type Fetcher = (symbol: string, interval: string, limit: number) => Promise<unknown[]>;
  const rowsOf = (bars: RswBar[], stepMs: number, runOpenTime?: number) => {
    const rows = bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume, b.time + stepMs - 1]);
    if (runOpenTime !== undefined) rows.push([runOpenTime, 0, 0, 0, 0, 0, runOpenTime + stepMs - 1]);
    return rows;
  };

  const ctxOf = (loaded: { h4Bars?: Bar[]; h1BarsLong?: Bar[]; btcDailyBars?: Bar[] }, h1Bars: Bar[], price: number): StrategyContext => ({
    analysis: { symbol: "AVAXUSDT" },
    price,
    mode: "SWING",
    swing: { h1Bars, ...loaded },
  } as unknown as StrategyContext);

  async function plansAt(sig: { time: number; entry: number }, loaderSymbol: string) {
    const { h4, h1, d1 } = series!;
    const T = sig.time;
    const win4 = h4.filter((b) => b.time < T).slice(-1000);
    const win1 = h1.filter((b) => b.time < T).slice(-900);
    const winD1 = d1.filter((b) => b.time + DAY <= T).slice(-1000);
    const fetcher: Fetcher = async (_s, interval) => {
      if (interval === "4h") return rowsOf(win4, 4 * HOUR, T);
      if (interval === "1h") return rowsOf(win1, HOUR, T);
      return rowsOf(winD1, DAY, T);
    };
    const { loadSwingRswContext } = await import("../src/strategies/modeContext.js");
    // Symbol loader UNIK per kasus: cache loader memakai expiry absolut
    // (60 dtk) dan key symbol, jadi memakai simbol sama dengan `now` yang
    // tidak monoton akan mengembalikan window kasus sebelumnya (cache bleed)
    // dan membuat plan yang dicari tidak ketemu.
    const loaded = await loadSwingRswContext(loaderSymbol, ["RSW-01", "RSW-02", "RSW-03"], fetcher, T + 1);
    // Bar berjalan harus sudah terbuang: bar terakhir = bar sinyal.
    expect(loaded!.h4Bars!.at(-1)!.openTime).toBeLessThan(T);
    return buildRswPlans(ctxOf(loaded!, [], sig.entry), ["RSW-01", "RSW-02", "RSW-03"]);
  }

  it("fixture parity tersedia (data 15m produksi + oracle Python)", () => {
    expect(fixtureExists).toBe(true);
    expect(sigs.length).toBeGreaterThan(0);
  });

  it("RSW plan TERBENTUK dari trigger H4/H1 asli (bukan sinyal karangan) — RSW reachable", async () => {
    if (!fixtureExists) return;
    // Ambil sinyal nyata per strategi RSW dari oracle Python. Dipilih signal
    // PERTAMA (bukan terakhir): signal terakhir bisa berada di luar window data
    // 15m yang tersedia (loader hanya menyuplai H4 1000 + H1 900 bar).
    for (const sid of ["RSW-01", "RSW-02", "RSW-03"]) {
      const sig = sigs.filter((s) => s.strategyId === sid).at(0);
      if (!sig) continue;
      const plans = await plansAt(sig, `AU1-01-${sid}`);
      const hit = plans.find((p) => p.strategyId === sid && p.matched);
      // Bukti reachability: plan strategi tsb terbentuk dari data produksi.
      expect(hit, `tidak ada plan ${sid} dari trigger asli`).toBeDefined();
      // Entry/SL identik oracle -> bukan sinyal karangan.
      expect(Math.abs(hit!.entryPrice - sig.entry)).toBeLessThan(1e-6);
      expect(Math.abs(hit!.slPrice - sig.sl)).toBeLessThan(1e-6);
    }
  }, 120_000);

  it("FAIL-CLOSED RSW: h4Bars < 200 -> tidak ada plan RSW sama sekali", () => {
    const short: Bar[] = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1_800_000_000_000 + i * 4 * HOUR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    }));
    const plans = buildRswPlans(ctxOf({ h4Bars: short, h1BarsLong: short, btcDailyBars: short }, short, 1.5),
      ["RSW-01", "RSW-02", "RSW-03"]);
    expect(plans).toEqual([]);
  });

  it("buildStrategyPlans lane SWING menyertakan plan RSW (bukan hanya placeholder) saat allowlist penuh", () => {
    // Bukti reachability di level perencana: plan RSW harus muncul di kumpulan
    // plan lane SWING (sebelum fix, funnel skip SEBELUM selectBestPlan sehingga
    // jalur ini tidak pernah dievaluasi untuk simbol tanpa sinyal S-05).
    const dummyAnalysis = {
      symbol: "AVAXUSDT", mode: "SWING", side: "LONG", usable: true, reason: null,
      price: 100, zoneScore: 0, triggerScore: 0, trendScore: 0, compositeScore: 0,
      biasAligned: true, tfSummary: "test",
      trigger: { barsData: [] }, structure: { barsData: [] }, bias: { barsData: [] },
      timeframes: [], confirm: null, confirmAligned: true, bestZone: null, zoneAnalysis: null,
      atrTrigger: null, atrStructure: null, analyzedAt: 0,
    } as unknown as StrategyContext["analysis"];
    const ctx = {
      analysis: dummyAnalysis, price: 100, mode: "SWING",
      swing: { h1Bars: [] },
    } as unknown as StrategyContext;
    // 20 Okt 2026: S-05 Polaris dihapus -> allowlist lane SWING hanya RSW-01/02/03.
    const plans = buildStrategyPlans(ctx, Date.now(), ["RSW-01", "RSW-02", "RSW-03"]);
    const ids = plans.map((p) => p.strategyId);
    // Semua strategi allowlist harus diwakili di kumpulan plan.
    for (const id of ["RSW-01", "RSW-02", "RSW-03"]) {
      expect(ids, `plan ${id} tidak ada di lane SWING`).toContain(id);
    }
    // Tidak ada yang match tanpa trigger (data kosong) -> tetap fail-closed.
    expect(plans.every((p) => p.matched === false)).toBe(true);
    // S-03/S-04/S-05 tidak boleh muncul sebagai entry source di lane SWING.
    expect(ids).not.toContain("S-03");
    expect(ids).not.toContain("S-04");
    expect(ids).not.toContain("S-05");
    // PERINTAH OPERATOR 20 Okt 2026: strategi SCALP (S-01/S-02) TIDAK BOLEH
    // masuk lane SWING. Placeholder diagnostik boleh muncul (matched=false,
    // reasons MODE_NOT_SWING) tapi TIDAK PERNAH boleh jadi entry source.
    for (const p of plans) {
      if (p.strategyId === "S-01" || p.strategyId === "S-02") {
        expect(p.matched, `${p.strategyId} match di lane SWING`).toBe(false);
        // Placeholder lintas-mode: matched=false + reason MODE_NOT_<lane
        // tempat strategi itu tinggal> (S-01/S-02 -> MODE_NOT_SCALP).
        expect(p.reasons).toContain("MODE_NOT_SCALP");
      }
    }
  });
});
