// apps/server/tests/swingBreakoutEngine.test.ts
// T-04 — PARITAS TS vs PYTHON (bukti 1:1, bukan mirip-mirip):
// mesin port (swingBreakoutEngine.ts) dijalankan pada bar 1h mentah yang sama
// (fixtures/swing/<SYM>-1h.csv, Apr-Okt 2026) dengan mesin riset v2_breakout.py;
// semua sinyal (index bar, arah, entry, SL, TP1/TP2/TPmax ladder) wajib cocok
// dengan dump referensi signals_parity.json yang dihasilkan Python.
// Level ladder pada dump memakai konvensi V10: R = 2x jarak entry->garis
// berlawanan; TP1 = R*5/3, TP2 = R*10/3, TPmax = R*5.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runSwingBreakoutSignals } from "../src/strategies/swingBreakoutEngine.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/swing/", import.meta.url));
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"] as const;
const APR_1_MS = Date.parse("2026-04-01T00:00:00Z");

interface RawBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function loadBars(sym: string): RawBar[] {
  const text = readFileSync(join(FIXTURES, `${sym}-1h.csv`), "utf8");
  const bars: RawBar[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row) continue;
    const cells = row.split(",");
    const t = Number(cells[0]);
    // guard identik engine.py: baris non-data (header) dilewati
    if (!Number.isFinite(t) || t < 1.5e12) continue;
    const open = Number(cells[1]);
    const high = Number(cells[2]);
    const low = Number(cells[3]);
    const close = Number(cells[4]);
    const volume = Number(cells[5]);
    if (![open, high, low, close, volume].every(Number.isFinite)) continue;
    bars.push({ openTime: t, open, high, low, close, volume });
  }
  // potong ke window riset (1 Apr 2026, sama seperti run_v8/riset)
  return bars.filter((b) => b.openTime >= APR_1_MS);
}

interface PySignal {
  i: number;
  t: number;
  dir: number;
  entry: number;
  opp: number;
  sl: number;
  tp1: number;
  tp2: number;
  tpmax: number;
}

function loadPythonSignals(): Record<string, PySignal[]> {
  return JSON.parse(readFileSync(join(FIXTURES, "signals_parity.json"), "utf8"));
}

const closeTo = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("S-05 Swing Breakout Engine — paritas TS vs Python (v2_breakout.py)", () => {
  const pySignals = loadPythonSignals();

  for (const sym of SYMS) {
    it(`${sym}: sinyal TS identik Python (index, arah, entry, SL, TP1/TP2/TPmax)`, () => {
      const bars = loadBars(sym);
      // 1h bars Apr 1 - 13 Okt 2026 ~ 4695 bar (window riset utuh)
      expect(bars.length).toBeGreaterThan(4000);
      const tsSignals = runSwingBreakoutSignals(bars as never);
      const py = pySignals[sym]!;

      // jumlah sinyal WAJIB sama persis (tidak boleh ada sinyal ekstra/hilang)
      expect(tsSignals.length).toBe(py.length);

      for (let k = 0; k < py.length; k++) {
        const p = py[k]!;
        const s = tsSignals[k]!;
        expect(s.index, `signal #${k} index`).toBe(p.i);
        expect(s.time, `signal #${k} time`).toBe(p.t);
        expect(s.side, `signal #${k} side`).toBe(p.dir > 0 ? "LONG" : "SHORT");
        expect(closeTo(s.entry, p.entry), `signal #${k} entry ${s.entry} vs ${p.entry}`).toBe(true);
        expect(closeTo(s.opposite, p.opp), `signal #${k} opposite`).toBe(true);
        expect(closeTo(s.sl, p.sl), `signal #${k} SL`).toBe(true);
        expect(closeTo(s.tp1, p.tp1), `signal #${k} TP1`).toBe(true);
        expect(closeTo(s.tp2, p.tp2), `signal #${k} TP2`).toBe(true);
        expect(closeTo(s.tpMax, p.tpmax), `signal #${k} TPmax`).toBe(true);
      }
    });
  }

  it("invarian ladder: TP1 40% / TP2 30% / TPmax sisa, R = 2x jarak garis", () => {
    const bars = loadBars("BTCUSDT");
    const sigs = runSwingBreakoutSignals(bars as never);
    expect(sigs.length).toBeGreaterThan(50);
    for (const s of sigs) {
      const dirn = s.side === "LONG" ? 1 : -1;
      const r = 2 * Math.abs(s.entry - s.opposite);
      expect(closeTo(s.rDistance, r)).toBe(true);
      expect(closeTo(s.sl, s.entry - dirn * r)).toBe(true);
      expect(closeTo(s.tp1, s.entry + dirn * r * (5 / 3))).toBe(true);
      expect(closeTo(s.tp2, s.entry + dirn * r * (10 / 3))).toBe(true);
      expect(closeTo(s.tpMax, s.entry + dirn * r * 5)).toBe(true);
      // geometri: LONG sl<entry<tp1<tp2<tpmax, SHORT cermin
      if (s.side === "LONG") {
        expect(s.sl).toBeLessThan(s.entry);
        expect(s.tp1).toBeGreaterThan(s.entry);
        expect(s.tp2).toBeGreaterThan(s.tp1);
        expect(s.tpMax).toBeGreaterThan(s.tp2);
      } else {
        expect(s.sl).toBeGreaterThan(s.entry);
        expect(s.tp1).toBeLessThan(s.entry);
        expect(s.tp2).toBeLessThan(s.tp1);
        expect(s.tpMax).toBeLessThan(s.tp2);
      }
    }
  });
});
