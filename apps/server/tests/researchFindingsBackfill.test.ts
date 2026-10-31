// 16 Okt 2026 — Item 4: ingestion ResearchFinding (backfill 5 temuan riset).
// Payload divalidasi terhadap kontrak logResearchFinding; script TIDAK BOLEH
// memanggil decideResearchFinding (vonis = keputusan operator, tetap PENDING).
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  failCreate: false,
  existing: [] as { id: number; title: string; operatorDecision: string }[],
}));

vi.mock("../src/core/db.js", () => ({
  db: {
    researchFinding: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (dbMock.failCreate) throw new Error("simulated db down");
        dbMock.created.push(args.data);
        return { id: dbMock.created.length };
      },
      findMany: async () => dbMock.existing,
    },
  },
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { FINDINGS_2026_10_16, backfillResearchFindings } from "../tools/backfill-research-findings.js";

const VALID_TYPES = ["BACKTEST", "OOS_VALIDATION", "EVENT_REPLAY", "LOOKAHEAD_AUDIT"];
const VALID_VERDICTS = ["SUPPORTIVE", "REFUTED", "INCONCLUSIVE"];

describe("FINDINGS_2026_10_16 — payload sesuai kontrak", () => {
  it("5 temuan, judul unik, enum valid", () => {
    expect(FINDINGS_2026_10_16).toHaveLength(5);
    const titles = FINDINGS_2026_10_16.map(f => f.title);
    expect(new Set(titles).size).toBe(5);
    for (const f of FINDINGS_2026_10_16) {
      expect(f.title.trim().length).toBeGreaterThan(0);
      expect(f.hypothesis.trim().length).toBeGreaterThan(0);
      expect(VALID_TYPES).toContain(f.experimentType);
      expect(VALID_VERDICTS).toContain(f.verdict);
      expect(f.conclusion.trim().length).toBeGreaterThan(0);
      expect(f.runRefs.length).toBeGreaterThan(0);
    }
  });

  it("cover 3 NO_EDGE/REFUTED + 1 grid REFUTED + 1 live INCONCLUSIVE", () => {
    const verdicts = FINDINGS_2026_10_16.map(f => f.verdict);
    expect(verdicts.filter(v => v === "REFUTED")).toHaveLength(4);
    expect(verdicts.filter(v => v === "INCONCLUSIVE")).toHaveLength(1);
    expect(FINDINGS_2026_10_16.some(f => f.title.includes("S-05"))).toBe(true);
    expect(FINDINGS_2026_10_16.some(f => f.title.includes("S-03"))).toBe(true);
    expect(FINDINGS_2026_10_16.some(f => f.title.includes("Live edge"))).toBe(true);
  });

  it("angka bukti persis dari laporan riset 16 Okt", () => {
    const s05 = FINDINGS_2026_10_16.find(f => f.title.startsWith("S-05"))!;
    expect(s05.metrics.oosPf).toBe(0.869);
    expect(s05.metrics.oosTrades).toBe(10501);
    const s03 = FINDINGS_2026_10_16.find(f => f.title.startsWith("S-03"))!;
    expect(s03.metrics.oosPf).toBe(0.871);
    const regime = FINDINGS_2026_10_16.find(f => f.title.includes("Filter regime"))!;
    expect(regime.metrics.configsBetterOn).toBe(2);
    const variant = FINDINGS_2026_10_16.find(f => f.title.includes("Varian detektor"))!;
    expect(variant.metrics.configsAboveBaseline).toBe(0);
    const live = FINDINGS_2026_10_16.find(f => f.title.includes("Live edge"))!;
    expect(live.metrics.netPnlUsd).toBeCloseTo(-4.12, 2);
  });
});

describe("backfillResearchFindings", () => {
  beforeEach(() => {
    dbMock.created = [];
    dbMock.failCreate = false;
    dbMock.existing = [];
  });

  it("dry-run tidak menulis apa pun", async () => {
    const { inserted } = await backfillResearchFindings(true);
    expect(inserted).toHaveLength(5);
    expect(dbMock.created).toHaveLength(0);
  });

  it("menulis 5 baris lewat logResearchFinding (fail-open path)", async () => {
    const { inserted, skipped } = await backfillResearchFindings(false);
    expect(inserted).toHaveLength(5);
    expect(skipped).toHaveLength(0);
    expect(dbMock.created).toHaveLength(5);
    for (const row of dbMock.created) {
      expect(VALID_TYPES).toContain(row.experimentType);
      expect(VALID_VERDICTS).toContain(row.verdict);
    }
  });

  it("idempoten: judul yang sudah ada di-skip", async () => {
    dbMock.existing = [{ id: 1, title: FINDINGS_2026_10_16[0]!.title, operatorDecision: "PENDING" }];
    const { inserted, skipped } = await backfillResearchFindings(false);
    expect(inserted).toHaveLength(4);
    expect(skipped).toEqual([FINDINGS_2026_10_16[0]!.title]);
    expect(dbMock.created).toHaveLength(4);
  });

  it("fail-open: db down -> tidak throw, semua masuk skipped", async () => {
    dbMock.failCreate = true;
    const { inserted, skipped } = await backfillResearchFindings(false);
    expect(inserted).toHaveLength(0);
    expect(skipped).toHaveLength(5);
  });
});
