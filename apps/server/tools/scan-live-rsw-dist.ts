// apps/server/tools/scan-live-rsw-dist.ts
// 23 Okt 2026 — DISTRIBUSI SL% RSW-02/RSW-03 dari data MARKET REAL yang baru
// ditarik (REST Binance Futures, bukan fixture lama, bukan data dummy).
//
// PERBEDAAN PENTING vs scan-live-rsw.ts:
//   - scan-live-rsw.ts  = entry DECISION live (hanya bar terakhir) -> ini yang
//                         dipakai engine produksi.
//   - file ini           = SEBARAN SL% pada seluruh bar dari data yang SAMA
//                         yang baru ditarik. Dipakai untuk mengukur "rata-rata
//                         persen SL" secara bermakna (1 sampel live terlalu kecil).
//                         Ini TIDAK mengubah keputusan entry.
//
// Memakai kode produksi: rswHistoricalH4Signals / rswHistoricalAlgoSignals /
// stop() / rrPolicyForMode / checkAssetClass.

import { rswHistoricalH4Signals, rswHistoricalAlgoSignals } from "../src/strategies/researchSwing/rswSignals.js";
import { dailyRegime, type Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { RSW_ALGO_SEED } from "../src/strategies/researchSwing/rswPlans.js";
import { rrPolicyForMode } from "../src/config/setupEngine.js";
import { checkTradeVolume } from "../src/exec/slotFillPolicy.js";
import { checkAssetClass } from "../src/universe/assetClassGuard.js";
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";

const HOUR = 3_600_000;
const FAPI = "https://fapi.binance.com";

async function fetchClosed(symbol: string, tf: string, limit: number): Promise<Bar[]> {
  const raw = await binanceFuturesClient.fetchKlines(symbol, tf, limit);
  const rows = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  const intervalMs = tf === "4h" ? 4 * HOUR : tf === "1h" ? HOUR : 86_400_000;
  const out: Bar[] = [];
  for (const r of rows as unknown[]) {
    const v = Array.isArray(r) ? r : (r as Record<string, unknown>);
    const get = (i: number, k: string) => (Array.isArray(v) ? v[i] : v[k]);
    const time = Number(get(0, "openTime"));
    if (!Number.isFinite(time) || time <= 0) continue;
    if (now - time < intervalMs) continue;
    const close = Number(get(4, "close"));
    if (!(close > 0)) continue;
    out.push({ time, open: Number(get(1, "open")), high: Number(get(2, "high")), low: Number(get(3, "low")), close, volume: Number(get(5, "volume")) });
  }
  return out;
}

async function fetchQuoteVolumes(): Promise<Map<string, number>> {
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`TICKER_HTTP_${res.status}`);
  const rows = (await res.json()) as Array<{ symbol: string; quoteVolume: string }>;
  return new Map(rows.map((r) => [r.symbol, Number(r.quoteVolume)]));
}

interface Row {
  strategyId: string;
  basis: string;
  slPct: number;
  atrPct: number;
  entry: number;
  sl: number;
  side: string;
  symbol: string;
  time: number;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function report(label: string, rows: Row[]): void {
  console.log(`\n${"=".repeat(80)}\n== ${label}: ${rows.length} sinyal`);
  if (!rows.length) { console.log("   (tidak ada sinyal)"); return; }
  const sl = rows.map((r) => r.slPct * 100).sort((a, b) => a - b);
  const at = rows.map((r) => r.atrPct * 100).sort((a, b) => a - b);
  const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / sl.length);
  console.log(`   SL%  min=${sl[0]!.toFixed(3)}  p10=${pct(sl, 0.1).toFixed(3)}  p25=${pct(sl, 0.25).toFixed(3)}  median=${pct(sl, 0.5).toFixed(3)}  p75=${pct(sl, 0.75).toFixed(3)}  p90=${pct(sl, 0.9).toFixed(3)}  max=${sl[sl.length - 1]!.toFixed(3)}`);
  console.log(`   SL%  MEAN=${mean.toFixed(3)}  SD=${sd.toFixed(3)}`);
  console.log(`   ATR% median=${pct(at, 0.5).toFixed(3)}  |  RASIO SL%/ATR% median=${(pct(sl, 0.5) / pct(at, 0.5)).toFixed(2)}x`);
  // Breakdown per basis
  const byBasis = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.strategyId}/${r.basis}/${r.side}`;
    if (!byBasis.has(k)) byBasis.set(k, []);
    byBasis.get(k)!.push(r);
  }
  console.log("   --- SL% per kombinasi strategi/basis/arah ---");
  for (const [k, v] of [...byBasis.entries()].sort()) {
    const s2 = v.map((r) => r.slPct * 100).sort((a, b) => a - b);
    console.log(`   ${k.padEnd(30)} n=${String(v.length).padStart(5)}  min=${s2[0]!.toFixed(3)}  median=${pct(s2, 0.5).toFixed(3)}  mean=${(s2.reduce((a, b) => a + b, 0) / s2.length).toFixed(3)}  max=${s2[s2.length - 1]!.toFixed(3)}`);
  }
}

async function main(): Promise<void> {
  const volFloor = checkTradeVolume(0).minVolumeUsd;
  const vols = await fetchQuoteVolumes();
  const liquid = [...vols.entries()]
    .filter(([, v]) => v > volFloor)
    .map(([symbol, v]) => ({ symbol, vol: v }))
    .filter(({ symbol }) => !checkAssetClass(symbol).blocked)
    .sort((a, b) => b.vol - a.vol);

  console.log(`== DATA REAL ditarik ${new Date().toISOString()}`);
  console.log(`== ${liquid.length} pair crypto lolos volume floor $${volFloor.toLocaleString("en-US")}`);

  const btcD1 = await fetchClosed("BTCUSDT", "1d", 1000);
  const regime = dailyRegime(btcD1);
  console.log(`== BTC D1 bars=${btcD1.length} regime=${regime.length}`);
  if (btcD1.length) {
    const last = btcD1[btcD1.length - 1]!;
    console.log(`== BTC D1 terakhir: ${new Date(last.time).toISOString()} close=${last.close}  (H4 terakhir BTC: ${new Date((await fetchClosed("BTCUSDT", "4h", 3))[2]!.time).toISOString()})`);
  }

  const rows: Row[] = [];
  let scanned = 0;
  let fail = 0;
  const TARGET = Number(process.env.SCAN_LIMIT ?? 150);
  const targets = liquid.slice(0, TARGET);
  let done = 0;

  for (const { symbol } of targets) {
    done++;
    if (done % 25 === 0) console.log(`   ...${done}/${targets.length} (${symbol})`);
    try {
      const h4 = await fetchClosed(symbol, "4h", 1000);
      if (h4.length < 200) continue;
      scanned++;
      for (const s of rswHistoricalH4Signals(symbol, h4, btcD1)) {
        const distance = Math.abs(s.entry - s.sl);
        rows.push({
          strategyId: s.strategyId,
          basis: s.side === "SHORT" ? "PHEN_SHORT" : "PHEN_LONG",
          slPct: distance / s.entry,
          atrPct: s.atr / s.entry,
          entry: s.entry, sl: s.sl, side: s.side, symbol, time: s.time,
        });
      }
      const h1 = await fetchClosed(symbol, "1h", 900);
      if (h1.length >= 801) {
        for (const a of rswHistoricalAlgoSignals(symbol, h1, h4, RSW_ALGO_SEED)) {
          const distance = Math.abs(a.entry - a.sl);
          rows.push({
            strategyId: "RSW-03",
            basis: "ALGOCHIEF_H1",
            slPct: distance / a.entry,
            atrPct: a.atr / a.entry,
            entry: a.entry, sl: a.sl, side: a.side, symbol, time: a.time,
          });
        }
      }
    } catch {
      fail++;
    }
  }

  console.log(`\n== selesai: ${scanned} simbol, ${fail} error, ${rows.length} sinyal total`);
  const r2 = rows.filter((r) => r.strategyId === "RSW-02");
  const r3 = rows.filter((r) => r.strategyId === "RSW-03");
  const r1 = rows.filter((r) => r.strategyId === "RSW-01");
  report("RSW-02 (Vega)", r2);
  report("RSW-03 (Draco)", r3);
  report("RSW-01 (Orion) pembanding", r1);

  // Sample terbaru per strategi (live-ish, 7 hari terakhir)
  const now = Date.now();
  console.log(`\n${"=".repeat(80)}\n== Sinyal 7 HARI TERAKHIR (data real, dari bar yang sudah close)`);
  for (const [name, rr] of [["RSW-02", r2], ["RSW-03", r3], ["RSW-01", r1]] as const) {
    const recent = rr.filter((r) => now - r.time < 7 * 24 * HOUR);
    if (!recent.length) { console.log(`   ${name}: 0 sinyal 7 hari terakhir`); continue; }
    const s2 = recent.map((r) => r.slPct * 100).sort((a, b) => a - b);
    console.log(`   ${name}: ${recent.length} sinyal | SL% median=${pct(s2, 0.5).toFixed(3)} mean=${(s2.reduce((a, b) => a + b, 0) / s2.length).toFixed(3)} min=${s2[0]!.toFixed(3)} max=${s2[s2.length - 1]!.toFixed(3)}`);
    for (const r of recent.sort((a, b) => b.time - a.time).slice(0, 4)) {
      console.log(`      ${new Date(r.time - (r.basis === "ALGOCHIEF_H1" ? HOUR : 4 * HOUR)).toISOString().slice(0, 16)} ${r.symbol.padEnd(14)} ${r.side.padEnd(5)} ${r.basis.padEnd(14)} SL%=${(r.slPct * 100).toFixed(3)}`);
    }
  }
}

void main();
