// apps/server/tools/scan-live-rsw.ts
// 23 Okt 2026 — SCAN MARKET REAL (live Binance Futures) untuk RSW-02 & RSW-03.
//
// Memakai KODE PRODUKSI, bukan reimplementasi:
//   - rswSignals.h4Signals()      -> sinyal H4 forward (RSW-01/02)
//   - rswSignals.algoSignals()    -> sinyal AlgoChief H1 (RSW-03)
//   - rswSignals.stop()            -> logika SL produksi (dipakai di dalam h4Signals)
//   - setupEngine.rrPolicyForMode -> policy RR23 produksi (tp1R)
//   - slotFillPolicy.checkTradeVolume -> gate likuiditas produksi
//   - assetClassGuard.checkAssetClass -> filter non-crypto produksi
//
// DATA: REST Binance Futures (/fapi/v1/ticker/24hr + /fapi/v1/klines).
// Bar TERAKHIR yang SUDAH CLOSE saja (anti-lookahead).
// Tidak menulis DB, tidak mengirim order, tidak mengubah state engine.
//
// Output: SL% per sinyal + statistik (min/p25/median/p75/max/mean) + rasio SL%/ATR%.

import { h4Signals, algoSignals } from "../src/strategies/researchSwing/rswSignals.js";
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
    if (now - time < intervalMs) continue; // buang bar berjalan
    const close = Number(get(4, "close"));
    if (!(close > 0)) continue;
    out.push({ time, open: Number(get(1, "open")), high: Number(get(2, "high")), low: Number(get(3, "low")), close, volume: Number(get(5, "volume")) });
  }
  return out;
}

/** Volume 24h REAL dari REST ticker (satu request untuk semua pair). */
async function fetchQuoteVolumes(): Promise<Map<string, number>> {
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`TICKER_HTTP_${res.status}`);
  const rows = (await res.json()) as Array<{ symbol: string; quoteVolume: string }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.symbol, Number(r.quoteVolume));
  return map;
}

interface Hit {
  symbol: string;
  strategyId: string;
  side: "LONG" | "SHORT";
  entry: number;
  sl: number;
  distance: number;
  slPct: number;
  tp1: number;
  rr: number;
  priority: number;
  vol24h: number;
  atr: number;
  atrPct: number;
  basis: string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function stats(label: string, hits: Hit[]): void {
  console.log(`\n${"=".repeat(78)}\n== ${label}: ${hits.length} sinyal LIVE`);
  if (!hits.length) {
    console.log("   (tidak ada sinyal pada bar terakhirClosed H4/H1 saat ini)");
    return;
  }
  const sl = hits.map((h) => h.slPct * 100).sort((a, b) => a - b);
  const at = hits.map((h) => h.atrPct * 100).sort((a, b) => a - b);
  const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
  console.log(`   SL%  min=${sl[0]!.toFixed(3)}  p25=${pct(sl, 0.25).toFixed(3)}  median=${pct(sl, 0.5).toFixed(3)}  p75=${pct(sl, 0.75).toFixed(3)}  max=${sl[sl.length - 1]!.toFixed(3)}  mean=${mean.toFixed(3)}`);
  console.log(`   ATR% min=${at[0]!.toFixed(3)}  median=${pct(at, 0.5).toFixed(3)}  max=${at[at.length - 1]!.toFixed(3)}`);
  console.log(`   RASIO SL%/ATR% : median=${(pct(sl, 0.5) / pct(at, 0.5)).toFixed(2)}x  min=${(sl[0]! / at[at.length - 1]!).toFixed(2)}x  max=${(sl[sl.length - 1]! / at[0]!).toFixed(2)}x`);
  console.log("   --- detail (urut SL% kecil -> besar) ---");
  for (const h of hits.sort((a, b) => a.slPct - b.slPct)) {
    console.log(
      `   ${h.symbol.padEnd(15)} ${h.side.padEnd(5)} entry=${h.entry.toPrecision(8).padStart(14)} sl=${h.sl.toPrecision(8).padStart(14)} ` +
      `SL%=${(h.slPct * 100).toFixed(3).padStart(6)} ATR%=${(h.atrPct * 100).toFixed(3).padStart(6)} tp1=${h.tp1.toPrecision(8)} RR=${h.rr} prio=${h.priority.toFixed(1)} vol24h=$${Math.round(h.vol24h).toLocaleString("en-US")} [${h.basis}]`,
    );
  }
}

async function main(): Promise<void> {
  const volFloor = checkTradeVolume(0).minVolumeUsd;
  console.log(`== SCAN LIVE REAL ${new Date().toISOString()}`);
  console.log(`== gate volume produksi (VOLUME_MIN_USD): $${volFloor.toLocaleString("en-US")}`);

  const vols = await fetchQuoteVolumes();
  console.log(`== REST ticker 24hr: ${vols.size} pair futures Binance`);

  // Filter: volume di atas floor + asset class CRYPTO (filter produksi).
  let blocked = 0;
  const liquid = [...vols.entries()]
    .filter(([, v]) => v > volFloor)
    .map(([symbol, v]) => ({ symbol, vol: v }))
    .filter(({ symbol }) => {
      const chk = checkAssetClass(symbol);
      if (chk.blocked) { blocked++; return false; }
      return true;
    })
    .sort((a, b) => b.vol - a.vol);
  console.log(`== lolos volume: ${liquid.length} | ditolak asset-class non-crypto: ${blocked}`);

  const btcD1 = await fetchClosed("BTCUSDT", "1d", 1000);
  const regime = dailyRegime(btcD1);
  console.log(`== BTC D1 bars=${btcD1.length} (gate BTC_D1_ALIGN) | RSW-03 butuh H1 >= 801 bar\n`);

  const hits: Record<string, Hit[]> = { "RSW-01": [], "RSW-02": [], "RSW-03": [] };
  const counter = { h4Short: 0, h4Long: 0, bosLong: 0, algoShort: 0 };
  let scanned = 0;
  const fail: string[] = [];

  const TARGET = Number(process.env.SCAN_LIMIT ?? 150);
  const targets = liquid.slice(0, TARGET);
  let done = 0;
  for (const { symbol, vol } of targets) {
    done++;
    if (done % 25 === 0) console.log(`   ...${done}/${targets.length} (${symbol})`);
    let h4: Bar[];
    try {
      h4 = await fetchClosed(symbol, "4h", 1000);
    } catch (e) {
      fail.push(`${symbol}:h4 ${(e as Error).message.slice(0, 30)}`);
      continue;
    }
    if (h4.length < 200) continue;
    scanned++;
    try {
      for (const s of h4Signals(symbol, h4, btcD1)) {
        const sign = s.side === "LONG" ? 1 : -1;
        const distance = Math.abs(s.entry - s.sl);
        const policy = rrPolicyForMode("SWING", s.strategyId);
        const bucket = hits[s.strategyId];
        if (!bucket) continue;
        bucket.push({
          symbol, strategyId: s.strategyId, side: s.side,
          entry: s.entry, sl: s.sl, distance,
          slPct: distance / s.entry,
          tp1: s.entry + sign * policy.tp1R * distance,
          rr: policy.tp1R,
          priority: s.priority ?? 0,
          vol24h: vol,
          atr: s.atr,
          atrPct: s.atr / s.entry,
          basis: s.side === "SHORT" ? "PHEN_SHORT" : "PHEN_LONG",
        });
        if (s.side === "SHORT") counter.h4Short++; else counter.h4Long++;
      }
      const h1 = await fetchClosed(symbol, "1h", 900);
      if (h1.length >= 801) {
        for (const a of algoSignals(symbol, h1, h4, RSW_ALGO_SEED)) {
          const distance = Math.abs(a.entry - a.sl);
          const policy = rrPolicyForMode("SWING", "RSW-03");
          hits["RSW-03"]!.push({
            symbol, strategyId: "RSW-03", side: a.side,
            entry: a.entry, sl: a.sl, distance,
            slPct: distance / a.entry,
            tp1: a.entry - (a.side === "LONG" ? 1 : -1) * policy.tp1R * distance,
            rr: policy.tp1R,
            priority: a.priority ?? 0,
            vol24h: vol,
            atr: a.atr,
            atrPct: a.atr / a.entry,
            basis: "ALGOCHIEF_H1",
          });
          counter.algoShort++;
        }
      }
    } catch (e) {
      fail.push(`${symbol}:${(e as Error).message.slice(0, 30)}`);
    }
  }

  console.log(`\n== selesai: ${scanned} simbol dianalisa (H4>=200), ${fail.length} error`);
  console.log(`== event pada bar terakhir: PHEN SHORT=${counter.h4Short} PHEN LONG=${counter.h4Long} AlgoChief=${counter.algoShort}`);
  if (fail.length) console.log(`== error: ${fail.slice(0, 6).join(", ")}`);

  stats("RSW-02 (Vega) - PHEN LONG profile + PHEN SHORT", hits["RSW-02"]!);
  stats("RSW-03 (Draco) - AlgoChief H1 + Ridge", hits["RSW-03"]!);
  stats("RSW-01 (Orion) - pembanding", hits["RSW-01"]!);
}

void main();
