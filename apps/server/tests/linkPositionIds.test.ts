// tests/linkPositionIds.test.ts — T0.3 (18 Okt 2026): pemetaan positionId.
import { describe, expect, it } from "vitest";
import {
  matchToPosition,
  planLinks,
  toEpochMs,
  type LinkableLogRow,
  type LinkablePositionRow,
} from "../src/learning/linkPositionIds.js";

const T0 = 1792025125662; // openedAt AVAX#3176 (epoch ms)

function log(over: Partial<LinkableLogRow> = {}): LinkableLogRow {
  return {
    id: 1, symbol: "AVAXUSDT", side: "SHORT", strategyId: "S-03",
    entryPrice: 9.935, createdAtMs: T0 + 6, positionId: null, ...over,
  };
}
function pos(over: Partial<LinkablePositionRow> = {}): LinkablePositionRow {
  return {
    id: 3176, symbol: "AVAXUSDT", side: "SHORT", strategyId: "S-03",
    entryPrice: 9.935, openedAtMs: T0, ...over,
  };
}

describe("matchToPosition (T0.3)", () => {
  it("kecocokan tunggal & eksplisit -> MATCHED", () => {
    expect(matchToPosition(log(), [pos()])).toEqual({ kind: "MATCHED", positionId: 3176 });
  });

  it("sudah ditautkan -> ALREADY_LINKED (tidak pernah menimpa)", () => {
    expect(matchToPosition(log({ positionId: 999 }), [pos()])).toEqual({ kind: "UNLINKED", reason: "ALREADY_LINKED" });
  });

  it("tanpa kandidat -> NO_CANDIDATE (biarkan NULL, jangan mengarang)", () => {
    expect(matchToPosition(log({ symbol: "ETHUSDT" }), [pos()])).toEqual({ kind: "UNLINKED", reason: "NO_CANDIDATE" });
  });

  it("lebih dari satu kandidat -> AMBIGUOUS (biarkan NULL)", () => {
    const p2 = pos({ id: 4000, openedAtMs: T0 + 10 });
    expect(matchToPosition(log(), [pos(), p2])).toEqual({ kind: "UNLINKED", reason: "AMBIGUOUS" });
  });

  it("strategyId harus persis, termasuk null<->null", () => {
    // Baris log tanpa strategyId tidak boleh menaut ke posisi S-03.
    expect(matchToPosition(log({ strategyId: null }), [pos()])).toEqual({ kind: "UNLINKED", reason: "NO_CANDIDATE" });
    // Dua-duanya null -> boleh cocok.
    expect(matchToPosition(log({ strategyId: null }), [pos({ strategyId: null })])).toEqual({ kind: "MATCHED", positionId: 3176 });
  });

  it("side & symbol dibandingkan case-insensitive", () => {
    expect(matchToPosition(log({ symbol: "avaxusdt", side: "short" }), [pos()])).toEqual({ kind: "MATCHED", positionId: 3176 });
  });

  it("harga: menampung pembulatan Position, menolak yang jauh", () => {
    // Position entryPrice dibulatkan 4 dp -> 0.8297 vs log 0.82974149 masih dekat.
    expect(matchToPosition(
      log({ symbol: "ASRUSDT", side: "LONG", strategyId: "S-05", entryPrice: 0.82974149 }),
      [pos({ symbol: "ASRUSDT", side: "LONG", strategyId: "S-05", entryPrice: 0.8297 })]
    )).toEqual({ kind: "MATCHED", positionId: 3176 });
    // Harga berbeda 2% -> di luar toleransi 0,1% -> NO_CANDIDATE.
    expect(matchToPosition(log({ entryPrice: 10.2 }), [pos()])).toEqual({ kind: "UNLINKED", reason: "NO_CANDIDATE" });
  });

  it("baris tanpa harga (DecisionLog) tidak memakai harga sbg pemisah", () => {
    expect(matchToPosition(log({ entryPrice: null }), [pos({ entryPrice: 123 })])).toEqual({ kind: "MATCHED", positionId: 3176 });
  });

  it("jendela waktu: di dalam -> cocok, di luar -> NO_CANDIDATE", () => {
    expect(matchToPosition(log({ createdAtMs: T0 + 60_000 }), [pos()])).toEqual({ kind: "MATCHED", positionId: 3176 });
    expect(matchToPosition(log({ createdAtMs: T0 + 200_000 }), [pos()])).toEqual({ kind: "UNLINKED", reason: "NO_CANDIDATE" });
  });
});

describe("planLinks (T0.3)", () => {
  it("setiap Position diklaim maksimal satu kali", () => {
    const rows = [log({ id: 1 }), log({ id: 2 })];
    const plan = planLinks(rows, [pos()]);
    expect(plan.updates).toEqual([{ logId: 1, positionId: 3176 }]);
    expect(plan.unlinked).toEqual([{ logId: 2, reason: "NO_CANDIDATE" }]);
  });

  it("mencampur MATCHED dan UNLINKED tanpa mengarang", () => {
    const rows = [log({ id: 1 }), log({ id: 2, symbol: "ETHUSDT" })];
    const plan = planLinks(rows, [pos()]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.unlinked).toEqual([{ logId: 2, reason: "NO_CANDIDATE" }]);
  });
});

describe("toEpochMs (T0.3)", () => {
  it("Date / number / ISO string -> epoch ms; tak terbaca -> NaN", () => {
    const d = new Date(T0);
    expect(toEpochMs(d)).toBe(T0);
    expect(toEpochMs(T0)).toBe(T0);
    expect(toEpochMs(d.toISOString())).toBe(T0);
    expect(toEpochMs(null)).toBeNaN();
    expect(toEpochMs(undefined)).toBeNaN();
    expect(toEpochMs("bukan-tanggal")).toBeNaN();
  });
});
