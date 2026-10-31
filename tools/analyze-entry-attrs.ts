// tools/analyze-entry-attrs.ts — T-02 (4 Okt 2026, FAS C).
// Analisis bucket atribut entry -> WR & avgR per bucket (R & % saja, tanpa nominal uang).
// Sumber data:
//   1. entryAttrs TERSIMPAN (trade baru sejak T-01 live) — atribut trigger penuh.
//   2. --backfill: trade lama tanpa entryAttrs -> rekonstruksi volumeRatio & atrRegime
//      dari klines 5m Binance pada bar entry (ditandai RECONSTRUCTED; atribut trigger
//      yang butuh konteks setup TIDAK bisa direkonstruksi dan dibiarkan null).
// Sekaligus T-14: tabel EV per simbol + daftar flag simbol bermasalah (pelaporan saja).
// Pemakaian: npx tsx tools/analyze-entry-attrs.ts [--backfill]
import { db } from "../apps/server/src/core/db.js";
import { parseEntryAttrs, computeVolumeRatio, computeAtrRegime, type EntryAttrs, type AttrBar } from "../apps/server/src/exec/entryAttrs.js";

interface TradeLite {
  positionId: number; symbol: string; side: string; strategyId: string | null;
  rMultiple: number; win: boolean; holdMinutes: number;
  openedAt: number; entryAttrs: EntryAttrs | null; reconstructed: boolean;
}

interface BucketRow { label: string; n: number; wr: number; ev: number; }

const bucketDefs: Record<string, (a: EntryAttrs) => string | null> = {
  displacementAtr: (a) => a.displacementAtr == null ? null : a.displacementAtr < 0.25 ? "<0.25" : a.displacementAtr < 0.5 ? "0.25-0.5" : ">=0.5",
  sweepDepthAtr: (a) => a.sweepDepthAtr == null ? null : a.sweepDepthAtr < 0.2 ? "<0.2" : a.sweepDepthAtr < 0.5 ? "0.2-0.5" : ">=0.5",
  biasAligned: (a) => a.biasAligned == null ? null : String(a.biasAligned),
  quality: (a) => a.quality == null ? null : a.quality < 45 ? "<45" : a.quality < 60 ? "45-60" : ">=60",
  volumeRatio: (a) => a.volumeRatio == null ? null : a.volumeRatio < 1 ? "<1 (sepi)" : a.volumeRatio < 1.5 ? "1-1.5" : a.volumeRatio < 2 ? "1.5-2" : ">=2",
  atrRegime: (a) => a.atrRegime == null ? null : a.atrRegime < 0.8 ? "<0.8 (tenang)" : a.atrRegime < 1.2 ? "0.8-1.2" : ">=1.2 (panas)",
};

function loadTrades(): Promise<TradeLite[]> {
  return db.trade.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      positionId: true, symbol: true, side: true, strategyId: true,
      rMultiple: true, win: true, holdMinutes: true, entryAttrs: true,
      position: { select: { openedAt: true } },
    },
  }).then((rows) => rows.map((r) => ({
    positionId: r.positionId, symbol: r.symbol, side: r.side, strategyId: r.strategyId,
    rMultiple: r.rMultiple, win: r.win, holdMinutes: r.holdMinutes,
    openedAt: r.position.openedAt.getTime(),
    entryAttrs: parseEntryAttrs(r.entryAttrs),
    reconstructed: false,
  })));
}

function stat(items: TradeLite[]): BucketRow | null {
  if (items.length === 0) return null;
  const wins = items.filter((t) => t.win).length;
  return {
    label: "", n: items.length,
    wr: Number(((wins / items.length) * 100).toFixed(1)),
    ev: Number((items.reduce((s, t) => s + t.rMultiple, 0) / items.length).toFixed(3)),
  };
}

function printBuckets(title: string, trades: TradeLite[], key: (a: EntryAttrs) => string | null): void {
  const groups = new Map<string, TradeLite[]>();
  let missing = 0;
  for (const t of trades) {
    const a = t.entryAttrs;
    const k = a ? key(a) : null;
    if (k == null) { missing++; continue; }
    const list = groups.get(k) ?? [];
    list.push(t);
    groups.set(k, list);
  }
  if (groups.size === 0) return;
  console.log(`\n== ${title} ==`);
  for (const [k, list] of [...groups.entries()].sort()) {
    const s = stat(list)!;
    console.log(`  ${k.padEnd(14)} n=${String(s.n).padStart(4)} WR=${String(s.wr).padStart(5)}% EV=${s.ev >= 0 ? "+" : ""}${s.ev}R`);
  }
  if (missing > 0) console.log(`  (tanpa nilai atribut: ${missing} trade)`);
}

function symbolReport(trades: TradeLite[]): void {
  const bySym = new Map<string, TradeLite[]>();
  for (const t of trades) {
    const list = bySym.get(t.symbol) ?? [];
    list.push(t);
    bySym.set(t.symbol, list);
  }
  const rows = [...bySym.entries()]
    .map(([sym, list]) => ({ sym, ...stat(list)! }))
    .filter((r) => r.n >= 3)
    .sort((a, b) => a.ev - b.ev);
  console.log("\n== T-14: EV per simbol (n >= 3), terburuk di atas ==");
  for (const r of rows) {
    const flag = r.n >= 5 && r.ev < 0 ? "  <-- FLAG review" : "";
    console.log(`  ${r.sym.padEnd(22)} n=${String(r.n).padStart(3)} WR=${String(r.wr).padStart(5)}% EV=${r.ev >= 0 ? "+" : ""}${r.ev}R${flag}`);
  }
}

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<AttrBar[]> {
  const out: AttrBar[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cur}&endTime=${endMs}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const data = await res.json() as number[][];
    if (data.length === 0) break;
    for (const k of data) out.push({ high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) });
    cur = Number(data[data.length - 1]![6]) + 1;
    if (data.length < 1500) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  return out;
}

/** Rekonstruksi volumeRatio/atrRegime per trade dari klines 5m di sekitar bar entry. */
async function backfill(trades: TradeLite[]): Promise<void> {
  const need = trades.filter((t) => t.entryAttrs == null);
  const bySym = new Map<string, TradeLite[]>();
  for (const t of need) {
    const list = bySym.get(t.symbol) ?? [];
    list.push(t);
    bySym.set(t.symbol, list);
  }
  console.log(`\nbackfill: ${need.length} trade tanpa entryAttrs, ${bySym.size} simbol (klines 5m) ...`);
  let done = 0;
  for (const [sym, list] of [...bySym.entries()].sort()) {
    const minT = Math.min(...list.map((t) => t.openedAt)) - 86_400_000;
    const maxT = Math.max(...list.map((t) => t.openedAt)) + 3_600_000;
    let bars: AttrBar[];
    try {
      bars = await fetchKlines(sym, minT, maxT);
    } catch (e) {
      console.log(`  MISS ${sym}: ${(e as Error).message}`);
      continue;
    }
    // Navigasi kasar: bar entry = bar 5m yang memuat openedAt (aproksimasi, ditandai).
    const n = bars.length;
    for (const t of list) {
      const approxIdx = Math.max(0, Math.min(n - 1, Math.round(((t.openedAt - minT) / 300_000)) - 1));
      const win = bars.slice(Math.max(0, approxIdx - 64), approxIdx + 1);
      t.entryAttrs = {
        v: 1, strategyId: t.strategyId, side: t.side, quality: null,
        sweepDepthAtr: null, displacementAtr: null, killzone: null, biasAligned: null,
        volumeRatio: computeVolumeRatio(win), atrRegime: computeAtrRegime(win),
        reasons: [], recordedAt: "RECONSTRUCTED",
      };
      t.reconstructed = true;
    }
    done += list.length;
    if ((done % 50) === 0) console.log(`  ... ${done}/${need.length}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function main(): Promise<void> {
  const trades = await loadTrades();
  console.log(`trade total: ${trades.length} | dengan entryAttrs tercatat: ${trades.filter((t) => t.entryAttrs).length}`);
  const rec = trades.filter((t) => t.entryAttrs && !t.reconstructed);
  if (rec.length > 0) {
    console.log(`\n######## BAGIAN 1: entryAttrs TERSIMPAN (live, n=${rec.length}) ########`);
    for (const [name, fn] of Object.entries(bucketDefs)) printBuckets(name, rec, fn);
  }
  if (process.argv.includes("--backfill")) {
    await backfill(trades);
    const bf = trades.filter((t) => t.reconstructed);
    console.log(`\n######## BAGIAN 2: RECONSTRUCTED dari klines (n=${bf.length}, aproksimasi bar entry) ########`);
    for (const name of ["volumeRatio", "atrRegime"]) printBuckets(`${name} [RECONSTRUCTED]`, bf, bucketDefs[name]!);
  }
  console.log(`\n######## BAGIAN 3: T-14 simbol ########`);
  symbolReport(trades);
  const rows = trades.map((t) => ({
    symbol: t.symbol, side: t.side, strategyId: t.strategyId, rMultiple: t.rMultiple,
    win: t.win, holdMinutes: t.holdMinutes, openedAt: t.openedAt,
    source: t.reconstructed ? "RECONSTRUCTED" : t.entryAttrs ? "RECORDED" : "NONE",
    volumeRatio: t.entryAttrs?.volumeRatio ?? null, atrRegime: t.entryAttrs?.atrRegime ?? null,
    displacementAtr: t.entryAttrs?.displacementAtr ?? null, sweepDepthAtr: t.entryAttrs?.sweepDepthAtr ?? null,
    biasAligned: t.entryAttrs?.biasAligned ?? null, quality: t.entryAttrs?.quality ?? null,
  }));
  const outPath = "/tmp/kestrel-scratch/entry_attrs_analysis.json";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`\nrows -> ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
