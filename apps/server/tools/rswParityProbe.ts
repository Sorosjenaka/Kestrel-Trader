// apps/server/tools/rswParityProbe.ts — T0.5 parity probe (18 Okt 2026).
//
// Bandingkan output port TS (rswSignals) dengan oracle Python
// (research/data/rsw-parity/<label>.json). Fixture dibuat oleh
// research/rsw_parity_fixture.py pada bar 15m yang sama.
//
//   npx tsx tools/rswParityProbe.ts                    # label default avax-h1h4d1
//   npx tsx tools/rswParityProbe.ts --label avax-h1h4d1
//
// Exit code 0 = parity lulus; 1 = ada selisih (rinci dicetak).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { aggregate, DAY, HOUR, STEP } from "../src/strategies/researchSwing/rswPrimitives.js";
import {
  parseAlgoModel,
  rswHistoricalAlgoSignals,
  rswHistoricalH4Signals,
} from "../src/strategies/researchSwing/rswSignals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..", "..");

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1] : undefined;
}
const label = argValue("--label") ?? "avax-h1h4d1";

function load15m(symbol: string): Bar[] {
  const path = join(ROOT, "data", "swing-v16", "bars-long-history", `${symbol}-15m.csv`);
  const text = readFileSync(path, "utf-8");
  const rows: Bar[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(",");
    rows.push({
      time: Number(p[0]),
      open: Number(p[1]),
      high: Number(p[2]),
      low: Number(p[3]),
      close: Number(p[4]),
      volume: Number(p[5]),
    });
  }
  return rows;
}

function relClose(a: number, b: number, tol = 1e-9): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  const m = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return d / m < tol;
}

interface RefSignal {
  symbol: string;
  time: number;
  side: string;
  strategyId: string;
  entry: number;
  sl: number;
  close: number;
  atr: number;
  structuralSl: number;
  priority: number | null;
}

function key(s: { time: number; symbol: string; strategyId: string }): string {
  return `${s.time}|${s.symbol}|${s.strategyId}`;
}

function main() {
  const fixturePath = join(ROOT, "research", "data", "rsw-parity", `${label}.json`);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const ref: RefSignal[] = fixture.signals;
  const symbols: string[] = fixture.meta.symbols;
  console.log(`label     : ${label}`);
  console.log(`ref sigs  : ${ref.length}`);
  console.log(`symbols   : ${symbols.join(",")}`);

  const seedPath = join(ROOT, "research", "swing_paper_algo_seed.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf-8"));
  const model = parseAlgoModel(seed);

  const btc15 = load15m("BTCUSDT");
  const btcD1 = aggregate(btc15, DAY);
  console.log(`btcD1     : ${btcD1.length} (ref ${fixture.meta.barMeta.btcD1Count})`);

  const tsSigs: RefSignal[] = [];
  for (const sym of symbols) {
    const ex15 = load15m(sym);
    const h4 = aggregate(ex15, 4 * HOUR);
    const h1 = aggregate(ex15, HOUR);
    const meta = fixture.meta.barMeta[sym];
    console.log(`  ${sym}: h4=${h4.length}(ref ${meta.h4Count}) h1=${h1.length}(ref ${meta.h1Count})`);
    const h4s = rswHistoricalH4Signals(sym, h4, btcD1);
    const alg = rswHistoricalAlgoSignals(sym, h1, h4, model);
    for (const s of [...h4s, ...alg]) {
      tsSigs.push({
        symbol: s.symbol,
        time: s.time,
        side: s.side,
        strategyId: s.strategyId,
        entry: s.entry,
        sl: s.sl,
        close: s.close,
        atr: s.atr,
        structuralSl: s.structuralSl,
        priority: (s as { priority: number }).priority,
      });
    }
  }
  tsSigs.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol) || a.strategyId.localeCompare(b.strategyId));
  console.log(`ts sigs   : ${tsSigs.length}`);

  const refMap = new Map<string, RefSignal>();
  for (const s of ref) refMap.set(key(s), s);
  const tsMap = new Map<string, RefSignal>();
  for (const s of tsSigs) tsMap.set(key(s), s);

  const missing: string[] = [];
  const extra: string[] = [];
  const fieldDiffs: string[] = [];
  for (const [k, r] of refMap) {
    const t = tsMap.get(k);
    if (!t) {
      missing.push(k);
      continue;
    }
    for (const f of ["entry", "sl", "close", "atr", "structuralSl"] as const) {
      if (!relClose(r[f], t[f])) fieldDiffs.push(`${k} ${f}: ref=${r[f]} ts=${t[f]}`);
    }
    if (r.priority !== null && t.priority !== null && !relClose(r.priority, t.priority)) {
      fieldDiffs.push(`${k} priority: ref=${r.priority} ts=${t.priority}`);
    }
    if (r.side !== t.side) fieldDiffs.push(`${k} side: ref=${r.side} ts=${t.side}`);
  }
  for (const k of tsMap.keys()) if (!refMap.has(k)) extra.push(k);

  console.log(`\n=== HASIL PARITY ===`);
  console.log(`missing (ada di Python, hilang di TS) : ${missing.length}`);
  console.log(`extra   (ada di TS, hilang di Python) : ${extra.length}`);
  console.log(`field diffs                           : ${fieldDiffs.length}`);
  for (const m of missing.slice(0, 20)) console.log(`  MISSING ${m}`);
  for (const m of extra.slice(0, 20)) console.log(`  EXTRA   ${m}`);
  for (const m of fieldDiffs.slice(0, 40)) console.log(`  DIFF    ${m}`);

  const pass = missing.length === 0 && extra.length === 0 && fieldDiffs.length === 0;
  console.log(`\nPARITY: ${pass ? "PASS" : "FAIL"}`);
  process.exitCode = pass ? 0 : 1;
}

main();
