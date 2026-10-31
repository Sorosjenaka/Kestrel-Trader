// tests/decisionLog.test.ts — Big Brain Tahap B1 (14 Okt 2026)
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  updated: [] as { id: number; data: Record<string, unknown> }[],
  failCreate: false,
}));

vi.mock("../src/core/db.js", () => ({
  db: {
    decisionLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (dbMock.failCreate) throw new Error("simulated db down");
        dbMock.created.push(args.data);
        return { id: dbMock.created.length };
      },
      update: async (args: { where: { id: number }; data: Record<string, unknown> }) => {
        dbMock.updated.push({ id: args.where.id, data: args.data });
        return { id: args.where.id };
      },
    },
  },
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { logDecision, linkDecisionToPosition } from "../src/learning/decisionLog.js";

describe("decisionLog (Big Brain B1)", () => {
  beforeEach(() => {
    dbMock.created = [];
    dbMock.updated = [];
    dbMock.failCreate = false;
  });

  it("menulis baris lengkap: GO dengan semua fitur terisi", async () => {
    const id = await logDecision({
      symbol: "BTCUSDT", side: "LONG", mode: "SCALP", strategyId: "S-02",
      decision: "GO", knnProb: 0.68, knnN: 32, drexProb: 0.72, drexStrength: 3,
      compositeScore: 78, trendScore: 71, regime: "TRENDING", er: 0.41,
      choppiness: 51.2, adx: 24.8, atrPct: 0.42, pocDistanceBins: 1.6,
      macroAllowed: true, cooldownAgeMs: 7_200_000,
    });
    expect(id).toBe(1);
    expect(dbMock.created[0]).toMatchObject({
      symbol: "BTCUSDT", decision: "GO", knnProb: 0.68, er: 0.41, macroAllowed: true,
    });
  });

  it("NO-GO juga di-log (data negatif untuk kalibrasi), rejectReason tersimpan", async () => {
    await logDecision({
      symbol: "GTCUSDT", side: "SHORT", mode: "SCALP", decision: "NO_GO",
      rejectReason: "ENTRY_PROB 0.48<0.55",
    });
    expect(dbMock.created[0]).toMatchObject({ decision: "NO_GO", rejectReason: "ENTRY_PROB 0.48<0.55" });
  });

  it("nilai non-finite -> null (tanpa fabrikasi), bukan NaN masuk DB", async () => {
    await logDecision({
      symbol: "XUSDT", side: "LONG", mode: "SCALP", decision: "SKIPPED",
      knnProb: NaN, er: Number("abc" as unknown as number), atrPct: Infinity,
    });
    const row = dbMock.created[0]!;
    expect(row.knnProb).toBeNull();
    expect(row.er).toBeNull();
    expect(row.atrPct).toBeNull();
  });

  it("fail-open: DB down -> return null, TIDAK melempar (keputusan trading jalan terus)", async () => {
    dbMock.failCreate = true;
    const id = await logDecision({ symbol: "XUSDT", side: "LONG", mode: "SCALP", decision: "GO" });
    expect(id).toBeNull();
  });

  it("linkDecisionToPosition meng-update positionId; id null -> no-op", async () => {
    await linkDecisionToPosition(null, 999);
    expect(dbMock.updated).toHaveLength(0);
    await linkDecisionToPosition(1, 42);
    expect(dbMock.updated).toEqual([{ id: 1, data: { positionId: 42 } }]);
  });
});
