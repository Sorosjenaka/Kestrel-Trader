// apps/server/tools/scan-live-rsw-cache.ts
// 23 Okt 2026 — SCAN MARKET REAL (live) dengan pacing aman + cache disk.
//
// CARA KERJA (penting, experiential):
//   - Volume 24h  : dari HUB ENGINE (/api/prices/live) = data WS live, 0 request.
//   - Klines       : REST Binance, PACING 1.5 dtk/request, cache disk 15 menit.
//   - Kalau Binance membalas 418/429 (IP ban), scanner BERHENTI (bukan retry
//     agresif — retry memperpanjang ban dan starvation bisa melumpuhkan engine
//     produksi karena IP-nya sama).
//   - Semua analisis memakai KODE PRODUKSI.
//
// PERINGATAN: IP ini dipakai bersama engine produksi. REST Binance punya
// batas weight (2400/menit) dan saling-ban. JANGAN dijalankan paralel dengan
// banyak scanner.
//
// Output: SL% per sinyal + statistik (min/p25/median/p75/max/RATA-RATA).

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { h4Signals, algoSignals, rswHistoricalH4Signals, rswHistoricalAlgoSignals } from "../src/strategies/researchSwing/rswSignals.js";
import { dailyRegime, type Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { RSW_ALGO_SEED } from "../src/strategies/researchSwing/rswPlans.js";
import { rrPolicyForMode } from "../src/config/setupEngine.js";
import { checkTradeVolume } from "../src/exec/slotFillPolicy.js";
import { checkAssetClass } from "../src/universe/assetClassGuard.js";

const HOUR = 3_600_000;
const CACHE_DIR = "/opt/kestrel/.cache/rsw-scan";
const CACHE_TTL_MS = 15 * 60_000;
const ENGINE = "http://127.0.0.1:8787";
const FAPI = "https://fapi.binance.com";
const PACING_MS = 6000; // 6 dtk/request: ~100 weight/menit. IP ini dipakai bersama
// engine produksi — pacing longgar mencegah ban yang juga melumpuhkan engine.
// (Ticker 24h weight 40; klines weight 5-10. Batas Binance 2400 weight/menit.)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class BannedError extends Error {
  constructor() { super("BINANCE_BAN"); }
}

interface Hit {
  symbol: string;
  strategyId: string;
  basis: string;
  side: string;
  entry: number;
  sl: number;
  slPct: number;
  atr: number;
  atrPct: number;
  distance: number;
  tp1: number;
  rr: number;
  priority: number;
  vol24h: number;
  time: number;
}

async function fetchClosed(symbol: string, tf: string, limit: number): Promise<Bar[]> {
  const key = join(CACHE_DIR, `${symbol}_${tf}_${limit}.json`);
  const intervalMs = tf === "4h" ? 4 * HOUR : tf === "1h" ? HOUR : 86_400_000;

  if (existsSync(key)) {
    try {
      if (Date.now() - statSync(key).mtimeMs < CACHE_TTL_MS) {
        const cached = JSON.parse(readFileSync(key, "utf8")) as Bar[];
        return cached.filter((b) => Date.now() - b.time >= intervalMs);
      }
    } catch { /* cache rusak -> fetch ulang */ }
  }

  await sleep(PACING_MS);
  const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`, {
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 418 || res.status === 429) throw new BannedError();
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const rows = (await res.json()) as unknown[][];
  const out: Bar[] = [];
  for (const r of rows) {
    const t = Number(r[0]);
    if (!Number.isFinite(t) || t <= 0) continue;
    const c = Number(r[4]);
    if (!(c > 0)) continue;
    out.push({ time: t, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: c, volume: Number(r[5]) });
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(key, JSON.stringify(out));
  } catch { /* cache tulis gagal -> tidak fatal */ }
  return out.filter((b) => Date.now() - b.time >= intervalMs);
}

async function hubVolumes(): Promise<Map<string, number>> {
  const res = await fetch(`${ENGINE}/api/prices/live`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HUB_HTTP_${res.status}`);
  const body = (await res.json()) as { prices?: Record<string, { v?: number }> };
  const map = new Map<string, number>();
  for (const [sym, v] of Object.entries(body.prices ?? {})) map.set(sym, Number(v?.v ?? 0));
  return map;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function report(label: string, rows: Hit[]): void {
  console.log(`\n${"=".repeat(84)}\n== ${label}: ${rows.length} sinyal`);
  if (!rows.length) { console.log("   (tidak ada sinyal)"); return; }
  const sl = rows.map((r) => r.slPct * 100).sort((a, b) => a - b);
  const at = rows.map((r) => r.atrPct * 100).sort((a, b) => a - b);
  const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / sl.length);
  console.log(`   SL%  min=${sl[0]!.toFixed(3)}  p10=${pct(sl, 0.1).toFixed(3)}  p25=${pct(sl, 0.25).toFixed(3)}  median=${pct(sl, 0.5).toFixed(3)}  p75=${pct(sl, 0.75).toFixed(3)}  p90=${pct(sl, 0.9).toFixed(3)}  max=${sl[sl.length - 1]!.toFixed(3)}`);
  console.log(`   SL%  RATA-RATA = ${mean.toFixed(3)}%   (SD ${sd.toFixed(3)})`);
  console.log(`   ATR% median=${pct(at, 0.5).toFixed(3)}  |  RASIO SL%/ATR% median=${(pct(sl, 0.5) / pct(at, 0.5)).toFixed(2)}x`);
  const byBasis = new Map<string, Hit[]>();
  for (const r of rows) {
    const k = `${r.basis}/${r.side}`;
    if (!byBasis.has(k)) byBasis.set(k, []);
    byBasis.get(k)!.push(r);
  }
  console.log("   --- SL% per basis/arah ---");
  for (const [k, v] of [...byBasis.entries()].sort()) {
    const s2 = v.map((r) => r.slPct * 100).sort((a, b) => a - b);
    const m2 = s2.reduce((a, b) => a + b, 0) / s2.length;
    console.log(`   ${k.padEnd(26)} n=${String(v.length).padStart(5)}  min=${s2[0]!.toFixed(3)}  median=${pct(s2, 0.5).toFixed(3)}  RATA-RATA=${m2.toFixed(3)}  max=${s2[s2.length - 1]!.toFixed(3)}`);
  }
  console.log("   --- 5 sinyal terbaru ---");
  for (const r of [...rows].sort((a, b) => b.time - a.time).slice(0, 5)) {
    console.log(`      ${new Date(r.time - (r.basis === "ALGOCHIEF_H1" ? HOUR : 4 * HOUR)).toISOString().slice(0, 16)} ${r.symbol.padEnd(14)} ${r.side.padEnd(5)} ${r.basis.padEnd(14)} entry=${r.entry.toPrecision(8).padStart(13)} sl=${r.sl.toPrecision(8).padStart(13)} SL%=${(r.slPct * 100).toFixed(3)}`);
  }
}

async function main(): Promise<void> {
  const volFloor = checkTradeVolume(0).minVolumeUsd;
  const vols = await hubVolumes();
  console.log(`== SCAN LIVE REAL ${new Date().toISOString()}`);
  console.log(`== volume dari hub engine (WS): ${vols.size} pair | floor $${volFloor.toLocaleString("en-US")}`);

  const liquid = [...vols.entries()]
    .filter(([, v]) => v > volFloor)
    .map(([symbol, v]) => ({ symbol, vol: v }))
    .filter(({ symbol }) => !checkAssetClass(symbol).blocked)
    .sort((a, b) => b.vol - a.vol);
  console.log(`== lolos volume + crypto: ${liquid.length} pair`);

  const btcD1 = await fetchClosed("BTCUSDT", "1d", 1000);
  const regime = dailyRegime(btcD1);
  console.log(`== BTC D1 bars=${btcD1.length} regime=${regime.length}`);

  const live: Record<string, Hit[]> = { "RSW-01": [], "RSW-02": [], "RSW-03": [] };
  const dist: Record<string, Hit[]> = { "RSW-01": [], "RSW-02": [], "RSW-03": [] };
  const c = { phenShort: 0, phenLong: 0, algo: 0, scanned: 0, fail: 0, banned: false };
  const TARGET = Number(process.env.SCAN_LIMIT ?? 150);
  const targets = liquid.slice(0, TARGET);
  let done = 0;

  for (const { symbol, vol } of targets) {
    done++;
    if (done % 20 === 0) console.log(`   ...${done}/${targets.length} (${symbol})`);
    let h4: Bar[];
    try {
      h4 = await fetchClosed(symbol, "4h", 1000);
    } catch (e) {
      if (e instanceof BannedError) {
        c.banned = true;
        console.log(`\n!! Binance memblokir IP saat ${symbol} (scan dihentikan, cache dipertahankan)`);
        break;
      }
      c.fail++;
      continue;
    }
    if (h4.length < 200) continue;
    c.scanned++;

    for (const s of h4Signals(symbol, h4, btcD1)) {
      const sign = s.side === "LONG" ? 1 : -1;
      const distance = Math.abs(s.entry - s.sl);
      const policy = rrPolicyForMode("SWING", s.strategyId);
      const bucket = live[s.strategyId];
      if (!bucket) continue;
      bucket.push({
        symbol, strategyId: s.strategyId, basis: s.side === "SHORT" ? "PHEN_SHORT" : "PHEN_LONG",
        side: s.side, entry: s.entry, sl: s.sl, distance,
        slPct: distance / s.entry, atr: s.atr, atrPct: s.atr / s.entry,
        tp1: s.entry + sign * policy.tp1R * distance, rr: policy.tp1R,
        priority: s.priority ?? 0, vol24h: vol, time: s.time,
      });
      if (s.side === "SHORT") c.phenShort++; else c.phenLong++;
    }
    for (const s of rswHistoricalH4Signals(symbol, h4, btcD1)) {
      const distance = Math.abs(s.entry - s.sl);
      dist[s.strategyId]?.push({
        symbol, strategyId: s.strategyId, basis: s.side === "SHORT" ? "PHEN_SHORT" : "PHEN_LONG",
        side: s.side, entry: s.entry, sl: s.sl, distance,
        slPct: distance / s.entry, atr: s.atr, atrPct: s.atr / s.entry,
        tp1: 0, rr: 0, priority: s.priority ?? 0, vol24h: vol, time: s.time,
      });
    }
    try {
      const h1 = await fetchClosed(symbol, "1h", 900);
      if (h1.length >= 801) {
        for (const a of algoSignals(symbol, h1, h4, RSW_ALGO_SEED)) {
          const distance = Math.abs(a.entry - a.sl);
          const policy = rrPolicyForMode("SWING", "RSW-03");
          live["RSW-03"]!.push({
            symbol, strategyId: "RSW-03", basis: "ALGOCHIEF_H1", side: a.side,
            entry: a.entry, sl: a.sl, distance,
            slPct: distance / a.entry, atr: a.atr, atrPct: a.atr / a.entry,
            tp1: a.entry - (a.side === "LONG" ? 1 : -1) * policy.tp1R * distance,
            rr: policy.tp1R, priority: a.priority ?? 0, vol24h: vol, time: a.time,
          });
          c.algo++;
        }
        for (const a of rswHistoricalAlgoSignals(symbol, h1, h4, RSW_ALGO_SEED)) {
          const distance = Math.abs(a.entry - a.sl);
          dist["RSW-03"]!.push({
            symbol, strategyId: "RSW-03", basis: "ALGOCHIEF_H1", side: a.side,
            entry: a.entry, sl: a.sl, distance,
            slPct: distance / a.entry, atr: a.atr, atrPct: a.atr / a.entry,
            tp1: 0, rr: 0, priority: a.priority ?? 0, vol24h: vol, time: a.time,
          });
        }
      }
    } catch (e) {
      if (e instanceof BannedError) { c.banned = true; console.log(`\n!! Binance memblokir IP saat ${symbol}`); break; }
    }
  }

  console.log(`\n== selesai: ${c.scanned} simbol | PHEN SHORT=${c.phenShort} PHEN LONG=${c.phenLong} AlgoChief=${c.algo} | fail=${c.fail} banned=${c.banned}`);

  console.log(`\n\n########## BAGIAN 1: SINYAL LIVE (bar terakhir = keputusan entry produksi) ##########`);
  report("RSW-02 (Vega) LIVE", live["RSW-02"]!);
  report("RSW-03 (Draco) LIVE", live["RSW-03"]!);
  report("RSW-01 (Orion) LIVE", live["RSW-01"]!);

  console.log(`\n\n########## BAGIAN 2: SEBARAN SL% (data real yang sama, semua bar) ##########`);
  report("RSW-02 (Vega) SEBARAN", dist["RSW-02"]!);
  report("RSW-03 (Draco) SEBARAN", dist["RSW-03"]!);
  report("RSW-01 (Orion) SEBARAN", dist["RSW-01"]!);

  const now = Date.now();
  console.log(`\n\n########## BAGIAN 3: SINYAL 7 HARI TERAKHIR ##########`);
  for (const [name, rr] of [["RSW-02", dist["RSW-02"]!], ["RSW-03", dist["RSW-03"]!], ["RSW-01", dist["RSW-01"]!]] as const) {
    const recent = rr.filter((r) => now - r.time < 7 * 24 * HOUR);
    if (!recent.length) { console.log(`   ${name}: 0 sinyal`); continue; }
    const s2 = recent.map((r) => r.slPct * 100).sort((a, b) => a - b);
    const m2 = s2.reduce((a, b) => a + b, 0) / s2.length;
    console.log(`   ${name}: ${recent.length} sinyal | SL% RATA-RATA=${m2.toFixed(3)} median=${pct(s2, 0.5).toFixed(3)} min=${s2[0]!.toFixed(3)} max=${s2[s2.length - 1]!.toFixed(3)}`);
    for (const r of recent.sort((a, b) => b.time - a.time).slice(0, 6)) {
      console.log(`      ${new Date(r.time - (r.basis === "ALGOCHIEF_H1" ? HOUR : 4 * HOUR)).toISOString().slice(0, 16)} ${r.symbol.padEnd(14)} ${r.side.padEnd(5)} ${r.basis.padEnd(14)} SL%=${(r.slPct * 100).toFixed(3)}`);
    }
  }
}

void main();
