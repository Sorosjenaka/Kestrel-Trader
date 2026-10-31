// tests/researchFinding.test.ts — Big Brain 15 Okt 2026: jurnal temuan riset.
// Pola sama dengan decisionLog.test.ts: db mock, fail-open, validasi enum.
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  rows: new Map<number, Record<string, unknown>>(),
  updated: [] as { id: number; data: Record<string, unknown> }[],
  failCreate: false,
  nextId: 1,
}));

vi.mock("../src/core/db.js", () => ({
  db: {
    researchFinding: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (dbMock.failCreate) throw new Error("simulated db down");
        dbMock.created.push(args.data);
        const id = dbMock.nextId++;
        const row = { id, operatorDecision: "PENDING", decidedAt: null, ...args.data };
        dbMock.rows.set(id, row);
        return row;
      },
      findMany: async (args: { orderBy: Record<string, string>; take: number }) => {
        return [...dbMock.rows.values()]
          .sort((a, b) => (b.id as number) - (a.id as number))
          .slice(0, args.take);
      },
      findUnique: async (args: { where: { id: number } }) => dbMock.rows.get(args.where.id) ?? null,
      update: async (args: { where: { id: number }; data: Record<string, unknown> }) => {
        const row = dbMock.rows.get(args.where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, args.data);
        dbMock.updated.push(args);
        return row;
      },
    },
  },
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  logResearchFinding,
  listResearchFindings,
  decideResearchFinding,
} from "../src/learning/researchFinding.js";

describe("researchFinding (Big Brain — jurnal temuan riset)", () => {
  beforeEach(() => {
    dbMock.created = [];
    dbMock.rows.clear();
    dbMock.updated = [];
    dbMock.failCreate = false;
    dbMock.nextId = 1;
  });

  it("menulis temuan lengkap dengan runRefs & metrics terserialisasi JSON", async () => {
    const id = await logResearchFinding({
      title: "Audit S-03 SWING",
      hypothesis: "S-03 bebas look-ahead dan bertahan OOS",
      experimentType: "OOS_VALIDATION",
      verdict: "SUPPORTIVE",
      conclusion: "lookahead PASS, OOS CONSISTENT",
      runRefs: [{ kind: "OOS_VALIDATION", label: "S-03-SWING-audit", id: 12, hash: "abc" }],
      metrics: { lookAheadPassed: true, oosEvRDelta: 0.02 },
    });
    expect(id).toBe(1);
    expect(dbMock.created[0]).toMatchObject({
      title: "Audit S-03 SWING",
      experimentType: "OOS_VALIDATION",
      verdict: "SUPPORTIVE",
    });
    expect(JSON.parse(dbMock.created[0]!.runRefs as string)).toHaveLength(1);
    expect(JSON.parse(dbMock.created[0]!.metrics as string)).toMatchObject({ lookAheadPassed: true });
  });

  it("menolak input tidak valid: enum salah atau field kosong — tanpa tulis DB", async () => {
    expect(await logResearchFinding({ title: "", hypothesis: "x", experimentType: "BACKTEST", verdict: "SUPPORTIVE" })).toBeNull();
    expect(await logResearchFinding({ title: "x", hypothesis: "", experimentType: "BACKTEST", verdict: "SUPPORTIVE" })).toBeNull();
    expect(await logResearchFinding({ title: "x", hypothesis: "y", experimentType: "BUKAN_ENUM" as never, verdict: "SUPPORTIVE" })).toBeNull();
    expect(await logResearchFinding({ title: "x", hypothesis: "y", experimentType: "BACKTEST", verdict: "PASTI_PROFIT" as never })).toBeNull();
    expect(dbMock.created).toHaveLength(0);
  });

  it("fail-open: DB down → null, tidak lempar error", async () => {
    dbMock.failCreate = true;
    const id = await logResearchFinding({
      title: "x", hypothesis: "y", experimentType: "EVENT_REPLAY", verdict: "REFUTED",
    });
    expect(id).toBeNull();
  });

  it("listResearchFindings mengembalikan JSON ter-parse & urut terbaru", async () => {
    await logResearchFinding({ title: "pertama", hypothesis: "h1", experimentType: "BACKTEST", verdict: "REFUTED" });
    await logResearchFinding({ title: "kedua", hypothesis: "h2", experimentType: "OOS_VALIDATION", verdict: "SUPPORTIVE" });
    const list = await listResearchFindings(10);
    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe("kedua");
    expect(list[0]!.operatorDecision).toBe("PENDING");
    expect(Array.isArray(list[0]!.runRefs)).toBe(true);
    expect(typeof list[0]!.metrics).toBe("object");
  });

  it("decideResearchFinding: hanya PENDING yang boleh diputuskan, hanya ADOPTED/REJECTED", async () => {
    const id = (await logResearchFinding({
      title: "x", hypothesis: "y", experimentType: "LOOKAHEAD_AUDIT", verdict: "INCONCLUSIVE",
    }))!;
    expect(await decideResearchFinding(id, "ADOPTED")).toBe(true);
    expect(dbMock.updated[0]!.data).toMatchObject({ operatorDecision: "ADOPTED" });
    expect(dbMock.updated[0]!.data.decidedAt).toBeInstanceOf(Date);
    // Sudah final → tolak
    expect(await decideResearchFinding(id, "REJECTED")).toBe(false);
    // id tak dikenal
    expect(await decideResearchFinding(999, "REJECTED")).toBe(false);
    // input bodoh
    expect(await decideResearchFinding(id, "PENDING" as never)).toBe(false);
  });

  it("operatorDecision default PENDING — LLM tidak bisa meng-ADOPT saat create", async () => {
    await logResearchFinding({ title: "x", hypothesis: "y", experimentType: "BACKTEST", verdict: "SUPPORTIVE" });
    // Tidak ada jalur create yang menerima operatorDecision dari input.
    expect(dbMock.created[0]!.operatorDecision).toBeUndefined();
    expect(dbMock.rows.get(1)!.operatorDecision).toBe("PENDING");
  });
});
