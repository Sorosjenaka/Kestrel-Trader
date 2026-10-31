// apps/server/tests/rswParity.test.ts — T0.5 (18 Okt 2026): parity port TS vs oracle Python.
//
// Fixture dibuat oleh research/rsw_parity_fixture.py pada bar 15m yang sama
// (data/swing-v16/bars-long-history/*-15m.csv). Port TS harus menghasilkan stream
// sinyal RSW-01/02/03 yang IDENTIK (jumlah, key, field numerik) dengan Python.
//
// Ini bukti parity T0.5 — tanpa lulus di sini, klaim "port selesai" tidak sah.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bar } from "../src/strategies/researchSwing/rswPrimitives.js";
import { aggregate, DAY, HOUR } from "../src/strategies/researchSwing/rswPrimitives.js";
import {
  parseAlgoModel,
  rswHistoricalAlgoSignals,
  rswHistoricalH4Signals,
} from "../src/strategies/researchSwing/rswSignals.js";

const ROOT = join(__dirname, "..", "..", "..");
const FIX_DIR = join(ROOT, "research", "data", "rsw-parity");
const BARS_DIR = join(ROOT, "data", "swing-v16", "bars-long-history");

function load15m(symbol: string): Bar[] {
  const path = join(BARS_DIR, `${symbol}-15m.csv`);
  const rows: Bar[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
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

function key(s: { time: number; symbol: string; strategyId: string }): string {
  return `${s.time}|${s.symbol}|${s.strategyId}`;
}

const seed = JSON.parse(readFileSync(join(ROOT, "research", "swing_paper_algo_seed.json"), "utf-8"));
const model = parseAlgoModel(seed);
const btcD1 = aggregate(load15m("BTCUSDT"), DAY);

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

function runTsSymbol(sym: string): RefSignal[] {
  const ex15 = load15m(sym);
  const h4 = aggregate(ex15, 4 * HOUR);
  const h1 = aggregate(ex15, HOUR);
  const h4s = rswHistoricalH4Signals(sym, h4, btcD1);
  const alg = rswHistoricalAlgoSignals(sym, h1, h4, model);
  return [...h4s, ...alg].map((s) => ({
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
  }));
}

const CASES = ["avax-h1h4d1", "sol-h1h4d1", "link-h1h4d1"];

/**
 * 24 Okt 2026 — timeout khusus file ini.
 *
 * Test ini mem-parsing CSV bar 15m multi-tahun (total folder 291 MB) jadi
 * objek JS, lalu menjalankan aggregate() + rswHistoricalH4Signals(). Di VPS
 * 1,9 GB yang swap-nya sudah terpakai 2,3 GB, durasi kasus BERAYAH dari
 * ~4,1 detik (baseline) sampai 10,3 detik (spike saat page cache ter-evict).
 * Timeout global 10 detik (vitest.config.ts) jadi pseudo-random: suite
 * gagal ~1 dari 9 kasus secara acak, BUKAN karena parity-nya salah —
 * asersi parity di bawah semuanya tetap sama persis.
 *
 * Verifikasi 24 Okt 2026: 3 ronde file ini DIJALANKAN SENDIRI (tanpa test
 * lain) -> 1 dari 9 kasus gagal dengan "Test timed out in 10000ms".
 * Jadi ini flake bawaan (load-dependent), bukan regresi logika.
 */
const PARITY_TIMEOUT_MS = 60_000;

describe("T0.5 parity: port RSW TS vs oracle Python (research/rsw_parity_fixture.py)", () => {
  for (const label of CASES) {
    it(`stream sinyal ${label} identik dengan Python`, { timeout: PARITY_TIMEOUT_MS }, () => {
      const fixturePath = join(FIX_DIR, `${label}.json`);
      expect(existsSync(fixturePath), `fixture hilang: ${fixturePath}`).toBe(true);
      const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
      const ref: RefSignal[] = fixture.signals;
      const symbols: string[] = fixture.meta.symbols;
      const ts = symbols.flatMap(runTsSymbol);
      ts.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol) || a.strategyId.localeCompare(b.strategyId));

      const refMap = new Map(ref.map((s) => [key(s), s] as const));
      const tsMap = new Map(ts.map((s) => [key(s), s] as const));

      // 1. jumlah harus persis sama (tanpa missing/extra)
      expect(ts.length, `jumlah sinyal ${label}`).toBe(ref.length);
      for (const k of refMap.keys()) expect(tsMap.has(k), `MISSING di TS: ${k}`).toBe(true);
      for (const k of tsMap.keys()) expect(refMap.has(k), `EXTRA di TS: ${k}`).toBe(true);

      // 2. field numerik harus match (rel tol 1e-9)
      for (const [k, r] of refMap) {
        const t = tsMap.get(k)!;
        expect(t.side, `side ${k}`).toBe(r.side);
        for (const f of ["entry", "sl", "close", "atr", "structuralSl"] as const) {
          expect(relClose(r[f], t[f]), `${f} ${k}: ref=${r[f]} ts=${t[f]}`).toBe(true);
        }
        if (r.priority !== null && t.priority !== null) {
          expect(relClose(r.priority, t.priority), `priority ${k}: ref=${r.priority} ts=${t.priority}`).toBe(true);
        }
      }
    });
  }

  it("fixture menjangkau > 500 sinyal agregat (bukti stream nyata, bukan 1-2 kasus)", () => {
    let total = 0;
    for (const label of CASES) {
      const fixture = JSON.parse(readFileSync(join(FIX_DIR, `${label}.json`), "utf-8"));
      total += fixture.signals.length;
    }
    expect(total).toBeGreaterThan(500);
  });
});
