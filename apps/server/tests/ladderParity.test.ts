// 16 Okt 2026 — Paritas TS <-> Python untuk exit ladder 40/30/BE/TPmax.
// Fixture ladder_parity.json digenerasi oracle `research/momentum_zone.py
// _ladder_exit` (subcommand `ladder-parity`) — SAMA sumber dengan riset V10 —
// lalu dibandingkan dengan `simulateLadderExit` field-per-field (frac, price,
// kind) + exitBar. Fee sengaja TIDAK dibandingkan (riset memakai semua-maker,
// model live/replay: TP maker, SL/BE/DATA_END taker). Kasus gap & DATA_END
// dikecualikan dari fixture (divergensi terdokumentasi, diuji ladderExit.test.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simulateLadderExit } from "../src/backtest/historicalReplay.js";
import { ladderExitLabel } from "../src/backtest/historicalReplay.js";

const FIXTURES = join(__dirname, "fixtures", "swing");

interface ParityLeg { frac: number; price: number; kind: string }
interface ParityCase {
  name: string; side: "LONG" | "SHORT";
  entry: number; sl: number; tp1: number; tp2: number; tpMax: number;
  entryIndex: number; intervalMs: number;
  bars: { openTime: number; open: number; high: number; low: number; close: number; volume: number }[];
  legs: ParityLeg[]; exitBar: number; exitReason: string;
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, "ladder_parity.json"), "utf8")) as {
  schemaVersion: number; cases: ParityCase[];
};

describe("Paritas ladder TS<->Python (ladder_parity.json)", () => {
  it("fixture valid & mencakup semua label berantai", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(11);
    const labels = new Set(fixture.cases.map(c => c.exitReason));
    for (const expected of ["SL", "TP1+SL", "TP1+TP2+BE", "TP1+TP2+TPMAX"]) {
      expect(labels.has(expected)).toBe(true);
    }
  });

  for (const c of fixture.cases) {
    it(`${c.name}: legs field-per-field + exitBar + label`, () => {
      const outOfSampleTo = c.bars[c.bars.length - 1]!.openTime + c.intervalMs;
      const r = simulateLadderExit(c.bars, c.entryIndex, {
        side: c.side, entry: c.entry, sl: c.sl, tp1: c.tp1, tp2: c.tp2, tpMax: c.tpMax,
        slippageBps: 0, outOfSampleTo, intervalMs: c.intervalMs,
      });
      expect(r.legs).toHaveLength(c.legs.length);
      for (let i = 0; i < c.legs.length; i++) {
        const py = c.legs[i]!;
        const ts = r.legs[i]!;
        expect(ts.kind, `${c.name} leg ${i} kind`).toBe(py.kind);
        expect(ts.frac, `${c.name} leg ${i} frac`).toBeCloseTo(py.frac, 12);
        expect(ts.price, `${c.name} leg ${i} price`).toBeCloseTo(py.price, 10);
      }
      expect(r.exitBar, `${c.name} exitBar`).toBe(c.exitBar);
      // jumlah frac konservasi = 1
      expect(r.legs.reduce((n, l) => n + l.frac, 0)).toBeCloseTo(1, 12);
      // label agregat dari legs TS = label hasil normalisasi Python
      expect(ladderExitLabel(r.legs)).toBe(c.exitReason);
    });
  }
});
