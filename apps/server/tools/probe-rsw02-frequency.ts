// apps/server/tools/probe-rsw02-frequency.ts
// 23 Okt 2026 — DIAGNOSIS READ-ONLY: mengapa RSW-02 jarang dapat trade.
//
// Memakai FUNGSI PRODUKSI (rswSignals.generateH4 / stop / allow) untuk
// mengukur funnel H4 per simbol:
//
//   PHEN_FADE_LIMIT SHORT  -> stop()            -> PLAN RSW-01 + RSW-02
//   PHEN_FADE_LIMIT LONG   -> stop(structural)  -> allow(PROFILE_CONTEXT)
//                                                  -> PLAN RSW-02
//   BOS_LIMIT_RETEST LONG  -> stop()            -> allow(BTC_D1_ALIGN)
//                                                  -> PLAN RSW-01
//
// Output: berapa event per keluarga per H4-bar, dan berapa yang jadi plan.
// Tidak menulis DB, tidak mengirim order, tidak menyentuh engine.

import { generateH4, stop, allow } from "../src/strategies/researchSwing/rswSignals.js";
import { dailyRegime, type Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";

const HOUR = 3_600_000;

async function fetchClosedBars(symbol: string, tf: string, limit: number): Promise<Bar[]> {
  const raw = await binanceFuturesClient.fetchKlines(symbol, tf, limit);
  const rows = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  const intervalMs = tf === "4h" ? 4 * HOUR : tf === "1h" ? HOUR : 86_400_000;
  const out: Bar[] = [];
  for (const r of rows as unknown[]) {
    const v = Array.isArray(r) ? r : (r as Record<string, unknown>);
    const get = (i: number, k: string) => (Array.isArray(v) ? v[i] : v[k]);
    const openTime = Number(get(0, "openTime"));
    if (!Number.isFinite(openTime) || openTime <= 0) continue;
    if (now - openTime < intervalMs) continue; // buang bar berjalan
    const close = Number(get(4, "close"));
    if (!(close > 0)) continue;
    out.push({
      time: openTime,
      open: Number(get(1, "open")),
      high: Number(get(2, "high")),
      low: Number(get(3, "low")),
      close,
      volume: Number(get(5, "volume")),
    });
  }
  return out;
}

type Stat = {
  symbol: string;
  h4bars: number;
  btcBars: number;
  phenEvents: number;
  phenLong: number;
  phenShort: number;
  phenShortStopOk: number;   // -> jadi plan RSW-01 & RSW-02 (keduanya!)
  phenLongStopOk: number;
  phenLongProfileOk: number; // -> jadi plan RSW-02
  bosEvents: number;
  bosLongStopOk: number;
  bosLongBtcOk: number;      // -> jadi plan RSW-01
};

async function main(): Promise<void> {
  const symbols = process.argv.slice(2);
  if (symbols.length === 0) {
    console.error("pemakaian: tsx tools/probe-rsw02-frequency.ts BTCUSDT ETHUSDT ...");
    process.exit(2);
  }
  const btcDaily = await fetchClosedBars("BTCUSDT", "1d", 1000);
  const regime = dailyRegime(btcDaily);
  const stats: Stat[] = [];

  for (const symbol of symbols) {
    const h4 = await fetchClosedBars(symbol, "4h", 1000);
    const s: Stat = {
      symbol, h4bars: h4.length, btcBars: btcDaily.length,
      phenEvents: 0, phenLong: 0, phenShort: 0,
      phenShortStopOk: 0, phenLongStopOk: 0, phenLongProfileOk: 0,
      bosEvents: 0, bosLongStopOk: 0, bosLongBtcOk: 0,
    };
    if (h4.length < 200) { stats.push(s); continue; }
    const gen = generateH4(symbol, h4, regime, {});
    for (const raw of gen.PHEN_FADE_LIMIT) {
      s.phenEvents++;
      if (raw.side === "LONG") {
        s.phenLong++;
        const r = stop(raw, true);
        if (r) {
          s.phenLongStopOk++;
          if (allow({ ...raw, strategyId: "PHEN_FADE_LIMIT" }, "PROFILE_CONTEXT")) s.phenLongProfileOk++;
        }
      } else {
        s.phenShort++;
        if (stop(raw)) s.phenShortStopOk++;
      }
    }
    for (const raw of gen.BOS_LIMIT_RETEST) {
      s.bosEvents++;
      if (raw.side === "LONG") {
        const r = stop(raw);
        if (r) { s.bosLongStopOk++; if (allow(r, "BTC_D1_ALIGN")) s.bosLongBtcOk++; }
      }
    }
    stats.push(s);
  }

  const head = ["symbol", "h4", "PHEN", "PHEN_L", "PHEN_L_stop", "PHEN_L_prof", "PHEN_S", "PHEN_S_stop", "BOS", "BOS_stop", "BOS_btc"];
  const rows = stats.map((s) => [s.symbol, s.h4bars, s.phenEvents, s.phenLong, s.phenLongStopOk, s.phenLongProfileOk, s.phenShort, s.phenShortStopOk, s.bosEvents, s.bosLongStopOk, s.bosLongBtcOk]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  console.log(head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i]!)).join("  "));
  const tot = stats.reduce((a, s) => ({
    phen: a.phen + s.phenEvents, pl: a.pl + s.phenLong, pls: a.pls + s.phenLongStopOk,
    plp: a.plp + s.phenLongProfileOk, ps: a.ps + s.phenShort, pss: a.pss + s.phenShortStopOk,
    bos: a.bos + s.bosEvents, bosb: a.bosb + s.bosLongBtcOk,
  }), { phen: 0, pl: 0, pls: 0, plp: 0, ps: 0, pss: 0, bos: 0, bosb: 0 });
  console.log("");
  console.log(`TOTAL: PHEN=${tot.phen} (LONG=${tot.pl} -> stop ${tot.pls} -> profile ${tot.plp} | SHORT=${tot.ps} -> stop ${tot.pss}) BOS=${tot.bos} -> btc_align ${tot.bosb}`);
  console.log(`PLAN RSW-02 (PHEN LONG lolos profile): ${tot.plp}`);
  console.log(`PLAN RSW-02 + RSW-01 (PHEN SHORT lolos stop): ${tot.pss}  <-- dua plan, satu sinyal`);
}

void main();
