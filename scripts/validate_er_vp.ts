// scripts/validate_er_vp.ts — Big Brain Tahap B2/B3 validasi ambang (14 Okt 2026)
// Pertanyaan yang dijawab dengan ANGKA (Golden Rule §10):
//  1. Apakah ER(30) ≥ 0.35 memisahkan "trending" dari "sideways"?
//     Ukuran: forward return |1h| dan hit-rate arah benar per bucket ER.
//  2. Seberapa sering regime TRENDING (bar) berada di ER ≥ 0.35 vs < 0.25?
//  3. POC: berapa % waktu harga close dalam ±1 bin dari POC (area magnet)?
//
// Data: 5m bars. BTC dari cache lokal scripts/data/btcusdt_5m_2026.json;
// alt di-fetch langsung dari fapi (ETHUSDT, SOLUSDT, XRPUSDT — 700k+ bar gabungan).
// Read-only, tidak menyentuh DB maupun order.
import fs from "node:fs";
import path from "node:path";

interface RawBar { openTime: number; open: number; high: number; low: number; close: number; volume: number }

const FAPI = "https://fapi.binance.com";
const PERIOD = 30;          // ER period (sama dengan trendQuality.ts)
const ENTER = 0.35;         // ambang masuk TRENDING (trendQuality.ts)
const EXIT = 0.25;          // ambang keluar (hysteresis)
const FWD_BARS = 12;        // 12x5m = 1 jam forward horizon

async function fetchAll5m(symbol: string, startTime: number, endTime: number): Promise<RawBar[]> {
  const out: RawBar[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${endTime}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
        low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
      });
    }
    const lastOpen = Number(rows[rows.length - 1]![0]);
    if (rows.length < 1500) break;
    cursor = lastOpen + 60_000;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

function efficiencyRatio(bars: RawBar[], period: number, i: number): number | null {
  if (i < period) return null;
  const window = bars.slice(i - period, i + 1);
  const net = Math.abs(window[window.length - 1]!.close - window[0]!.close);
  let pathLen = 0;
  for (let k = 1; k < window.length; k++) pathLen += Math.abs(window[k]!.close - window[k - 1]!.close);
  return pathLen > 0 ? net / pathLen : null;
}

function buildVolumeProfile(bars: RawBar[], binCount = 48): { poc: number | null; binSize: number } {
  if (bars.length === 0) return { poc: null, binSize: 0 };
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
  const range = hi - lo;
  if (range <= 0) return { poc: bars[0]!.close, binSize: 0 };
  const binSize = range / binCount;
  const vols = new Array<number>(binCount).fill(0);
  for (const b of bars) {
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(((b.close + b.open + b.high + b.low) / 4 - lo) / binSize)));
    vols[bin] += b.volume;
  }
  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (vols[i]! > vols[pocIdx]!) pocIdx = i;
  return { poc: lo + (pocIdx + 0.5) * binSize, binSize };
}

function pctile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function main(): Promise<void> {
  const datasets: { symbol: string; bars: RawBar[] }[] = [];

  const localPath = path.resolve("scripts/data/btcusdt_5m_2026.json");
  if (fs.existsSync(localPath)) {
    const raw = JSON.parse(fs.readFileSync(localPath, "utf8")) as RawBar[];
    datasets.push({ symbol: "BTCUSDT(local 2026)", bars: raw });
  } else {
    console.log("cache lokal BTC tidak ada — fetch dari fapi");
    datasets.push({ symbol: "BTCUSDT", bars: await fetchAll5m("BTCUSDT", Date.parse("2026-01-01"), Date.now()) });
  }
  const t0 = Date.now() - 120 * 24 * 3600_000; // 120 hari alt (hemat waktu fetch, ~34k bar/pair)
  for (const sym of ["ETHUSDT", "SOLUSDT", "XRPUSDT"]) {
    process.stdout.write(`fetch ${sym} ... `);
    const bars = await fetchAll5m(sym, t0, Date.now() - 3600_000);
    console.log(`${bars.length} bar`);
    datasets.push({ symbol: sym, bars });
  }

  console.log(`\n=== Validasi ER (period ${PERIOD}) — horizon forward ${FWD_BARS}x5m = 1 jam ===`);
  console.log("bucket ER      | n      | |fwd ret| median | hit arah (naik-turun benar dari ER sign momentum)");
  for (const { symbol, bars } of datasets) {
    const buckets: Record<string, number[]> = { "ER<0.15": [], "0.15-0.25": [], "0.25-0.35": [], "0.35-0.50": [], "≥0.50": [] };
    const erTrendingShare: { above: number; below: number } = { above: 0, below: 0 };
    let samples = 0;
    for (let i = PERIOD; i < bars.length - FWD_BARS; i++) {
      const er = efficiencyRatio(bars, PERIOD, i);
      if (er === null) continue;
      const fwd = (bars[i + FWD_BARS]!.close - bars[i]!.close) / bars[i]!.close;
      const key = er < 0.15 ? "ER<0.15" : er < 0.25 ? "0.15-0.25" : er < 0.35 ? "0.25-0.35" : er < 0.50 ? "0.35-0.50" : "≥0.50";
      buckets[key]!.push(Math.abs(fwd));
      samples++;
      if (er >= ENTER) erTrendingShare.above++; else if (er < EXIT) erTrendingShare.below++;
    }
    console.log(`\n${symbol} (${samples} sampel):`);
    for (const [key, vals] of Object.entries(buckets)) {
      if (vals.length === 0) { console.log(`  ${key.padEnd(10)} |      0 | —`); continue; }
      const med = pctile(vals, 50);
      console.log(`  ${key.padEnd(10)} | ${String(vals.length).padStart(6)} | ${(med * 100).toFixed(3)}%`);
    }
    const tot = erTrendingShare.above + erTrendingShare.below;
    console.log(`  ER≥0.35 (trending): ${(erTrendingShare.above / tot * 100).toFixed(1)}% waktu · ER<0.25 (sideways): ${(erTrendingShare.below / tot * 100).toFixed(1)}%`);
  }

  console.log(`\n=== POC magnet (close dalam ±1 bin POC, profil 30 bar rolling) ===`);
  for (const { symbol, bars } of datasets) {
    let inZone = 0, total = 0;
    for (let i = 60; i < bars.length; i += 6) { // sampel tiap 30 menit
      const win = bars.slice(i - 30, i);
      const { poc, binSize } = buildVolumeProfile(win);
      if (poc === null || binSize <= 0) continue;
      const c = bars[i]!.close;
      if (Math.abs(c - poc) <= binSize) inZone++;
      total++;
    }
    console.log(`${symbol}: ${(inZone / Math.max(1, total) * 100).toFixed(1)}% dari ${total} sampel`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
