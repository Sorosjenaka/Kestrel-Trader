import { describe, expect, it } from "vitest";
import {
  classifyTrade,
  classifyVenue,
  compareByStrategy,
  comparePaperLive,
  evidenceRows,
  summarize,
  toFindingVerdict,
  type ClassifiedTrade,
  type ClosedTradeLite,
  type OrderLite,
} from "../src/analytics/paperLiveEv";

function trade(over: Partial<ClosedTradeLite> = {}): ClosedTradeLite {
  return {
    id: 1,
    symbol: "BTCUSDT",
    mode: "SWING",
    side: "LONG",
    strategyId: "S-03",
    source: "PAPER_AI",
    accountingQuality: "SIMULATED",
    pnlUsd: 0.5,
    feeUsd: 0.08,
    fundingUsd: 0,
    riskUsd: 1,
    riskBudgetUsd: 1,
    rMultiple: 0.5,
    win: true,
    createdAt: 1_700_000_000_000,
    orders: [{ simulated: true, binanceOrderId: "SIM_X" }],
    ...over,
  };
}

function classified(over: Partial<ClosedTradeLite> = {}): ClassifiedTrade {
  return classifyTrade(trade(over));
}

/** n baris dengan NET R tertentu, feeCovered default true. */
function series(n: number, netR: number, over: Partial<ClosedTradeLite> = {}): ClassifiedTrade[] {
  return Array.from({ length: n }, (_, i) =>
    classified({
      id: i + 1,
      pnlUsd: netR,
      riskBudgetUsd: 1,
      riskUsd: 1,
      feeUsd: 0.05,
      win: netR > 0,
      ...over,
    }),
  );
}

describe("classifyVenue — bukti OrderExec, bukan label", () => {
  it("semua order simulated => PAPER", () => {
    const row = trade({ orders: [{ simulated: true, binanceOrderId: "SIM_A" }, { simulated: true, binanceOrderId: null }] });
    expect(classifyVenue(row)).toBe("PAPER");
  });

  it("ada order simulated=false => LIVE", () => {
    const row = trade({ orders: [{ simulated: true, binanceOrderId: "SIM_A" }, { simulated: false, binanceOrderId: "123" }] });
    expect(classifyVenue(row)).toBe("LIVE");
  });

  it("binanceOrderId nyata walau flag simulated salah => LIVE (fail-safe)", () => {
    const row = trade({ orders: [{ simulated: true, binanceOrderId: "987654321" }] });
    expect(classifyVenue(row)).toBe("LIVE");
  });

  it("tanpa order: accountingQuality SIMULATED => PAPER", () => {
    expect(classifyVenue(trade({ orders: [] }))).toBe("PAPER");
  });

  it("tanpa order: source LIVE_AI => LIVE", () => {
    expect(classifyVenue(trade({ orders: [], source: "LIVE_AI", accountingQuality: "ESTIMATED" }))).toBe("LIVE");
  });

  it("tanpa order dan tanpa bukti => UNKNOWN (tidak ditebak)", () => {
    expect(classifyVenue(trade({ orders: [], source: null, accountingQuality: "LEGACY" }))).toBe("UNKNOWN");
  });
});

describe("classifyTrade — NET R & fee coverage", () => {
  it("memakai riskBudgetUsd sebagai denominator (bukan riskUsd)", () => {
    const c = classifyTrade(trade({ pnlUsd: 0.6, riskBudgetUsd: 2, riskUsd: 1 }));
    expect(c.netR).toBeCloseTo(0.3, 12);
  });

  it("fallback riskUsd bila riskBudgetUsd null", () => {
    const c = classifyTrade(trade({ pnlUsd: 0.6, riskBudgetUsd: null, riskUsd: 1.5 }));
    expect(c.netR).toBeCloseTo(0.4, 12);
  });

  it("riskBudgetUsd 0 dianggap tidak valid -> fallback riskUsd", () => {
    const c = classifyTrade(trade({ pnlUsd: 0.6, riskBudgetUsd: 0, riskUsd: 0.75 }));
    expect(c.netR).toBeCloseTo(0.8, 12);
  });

  it("denominator tidak valid => netR null (tidak dibagi nol)", () => {
    expect(classifyTrade(trade({ riskBudgetUsd: 0, riskUsd: 0 })).netR).toBeNull();
  });

  it("fee nol => feeCovered false (NET overstated, bukan bukti)", () => {
    const c = classifyTrade(trade({ feeUsd: 0 }));
    expect(c.feeCovered).toBe(false);
  });

  it("fee > 0 => feeCovered true", () => {
    expect(classifyTrade(trade({ feeUsd: 0.03 })).feeCovered).toBe(true);
  });

  it("DEMO dan MANUAL ditandai exclusion", () => {
    expect(classifyTrade(trade({ source: "DEMO" })).exclusion).toBe("DEMO");
    expect(classifyTrade(trade({ source: "MANUAL" })).exclusion).toBe("MANUAL");
    expect(classifyTrade(trade({ source: "PAPER_AI" })).exclusion).toBeNull();
  });
});

describe("summarize", () => {
  it("mean/median/WR dari NET R", () => {
    const rows = [
      classified({ id: 1, pnlUsd: 1, win: true }),
      classified({ id: 2, pnlUsd: -1, win: false }),
      classified({ id: 3, pnlUsd: 0.5, win: true }),
    ];
    const s = summarize(rows);
    expect(s.n).toBe(3);
    expect(s.meanNetR).toBeCloseTo(1 / 6, 12);
    expect(s.medianNetR).toBeCloseTo(0.5, 12);
    expect(s.wrPct).toBeCloseTo((2 / 3) * 100, 12);
    expect(s.nFeeCovered).toBe(3);
  });

  it("baris tanpa NET R dihitung nMissingNetR, tidak masuk mean", () => {
    const rows = [classified({ id: 1 }), classifyTrade(trade({ id: 2, riskBudgetUsd: 0, riskUsd: 0 }))];
    const s = summarize(rows);
    expect(s.n).toBe(2);
    expect(s.nMissingNetR).toBe(1);
    expect(s.meanNetR).toBeCloseTo(0.5, 12);
  });

  it("sum fee & funding dilaporkan terpisah (funding paper tidak dimodelkan)", () => {
    const rows = [classified({ id: 1, feeUsd: 0.02, fundingUsd: 0 }), classified({ id: 2, feeUsd: 0.03, fundingUsd: -0.01 })];
    const s = summarize(rows);
    expect(s.sumFeeUsd).toBeCloseTo(0.05, 12);
    expect(s.sumFundingUsd).toBeCloseTo(-0.01, 12);
  });
});

describe("evidenceRows — filter bukti", () => {
  it("hanya venue cocok, bukan DEMO/MANUAL, fee tercatat", () => {
    const rows = [
      classified({ id: 1 }),
      classified({ id: 2, feeUsd: 0 }),
      classified({ id: 3, source: "DEMO" }),
      classified({ id: 4, source: "MANUAL" }),
      classifyTrade(trade({ id: 5, orders: [{ simulated: false, binanceOrderId: "42" }], source: "LIVE_AI", accountingQuality: "ESTIMATED" })),
    ];
    expect(evidenceRows(rows, "PAPER").map((r) => r.id)).toEqual([1]);
    expect(evidenceRows(rows, "LIVE").map((r) => r.id)).toEqual([5]);
  });
});

describe("comparePaperLive — verdict fidelity", () => {
  it("sampel di bawah lantai => INCONCLUSIVE + alasan eksplisit", () => {
    const rows = [...series(4, 0.2), ...series(0, 0)];
    const res = comparePaperLive(rows, { minSamples: 500 });
    expect(res.verdict).toBe("INCONCLUSIVE");
    expect(res.reasons.join(" ")).toContain("SAMPLE_FLOOR_PAPER");
    expect(res.reasons.join(" ")).toContain("SAMPLE_FLOOR_LIVE");
  });

  it("500 vs 500 dengan selisih kecil => WITHIN_TOLERANCE", () => {
    const paper = series(500, 0.05);
    const live = series(500, 0.049).map((r) => ({ ...r, venue: "LIVE" as const }));
    const res = comparePaperLive([...paper, ...live], { minSamples: 500, toleranceR: 0.1 });
    expect(res.paper.n).toBe(500);
    expect(res.live.n).toBe(500);
    expect(res.verdict).toBe("WITHIN_TOLERANCE");
  });

  it("selisih besar dan signifikan => DEVIATION", () => {
    const paper = series(500, 0.5);
    const live = series(500, -0.5).map((r) => ({ ...r, venue: "LIVE" as const }));
    const res = comparePaperLive([...paper, ...live], { minSamples: 500, toleranceR: 0.1 });
    expect(res.deltaR).toBeCloseTo(1, 12);
    expect(res.verdict).toBe("DEVIATION");
  });

  it("selisih > toleransi tapi CI melintasi ambang => INCONCLUSIVE (bukan dipaksa lolos/gagal)", () => {
    // se besar: nilai berselang-seling ekstrem.
    const paper = Array.from({ length: 500 }, (_, i) =>
      classified({ id: i + 1, pnlUsd: i % 2 === 0 ? 3 : -3, riskBudgetUsd: 1, feeUsd: 0.05, win: i % 2 === 0 }));
    const live = Array.from({ length: 500 }, (_, i) =>
      classified({ id: 1000 + i, pnlUsd: i % 2 === 0 ? 2.8 : -3.2, riskBudgetUsd: 1, feeUsd: 0.05, win: i % 2 === 0 }));
    const res = comparePaperLive([...paper, ...live.map((r) => ({ ...r, venue: "LIVE" as const }))], { minSamples: 500 });
    expect(Math.abs(res.deltaR ?? 0)).toBeGreaterThan(0.1);
    expect(res.verdict).toBe("INCONCLUSIVE");
    expect(res.reasons).toContain("CI95_MELINTASI_TOLERANSI");
  });

  it("satu venue kosong => INCONCLUSIVE, delta null", () => {
    const res = comparePaperLive(series(600, 0.2), { minSamples: 500 });
    expect(res.deltaR).toBeNull();
    expect(res.verdict).toBe("INCONCLUSIVE");
    expect(res.reasons.join(" ")).toContain("DELTA_TIDAK_TERHITUNG");
  });

  it("asRecorded tetap melaporkan trade fee-0 (diagnostik, bukan bukti)", () => {
    const rows = [...series(2, 0.2), ...series(3, 0.2, { feeUsd: 0 })];
    const res = comparePaperLive(rows, { minSamples: 1 });
    expect(res.paper.n).toBe(2);
    expect(res.paperAsRecorded.n).toBe(5);
    expect(res.paperAsRecorded.nFeeCovered).toBe(2);
  });

  it("toleransi dan lantai sampel dilaporkan apa adanya", () => {
    const res = comparePaperLive([], { toleranceR: 0.25, minSamples: 42 });
    expect(res.toleranceR).toBe(0.25);
    expect(res.minSamples).toBe(42);
    expect(res.verdict).toBe("INCONCLUSIVE");
  });
});

describe("compareByStrategy", () => {
  it("memisahkan EV per strategi dan menghitung delta hanya bila dua venue ada", () => {
    const paper = series(2, 0.3, { strategyId: "S-03" });
    const live = series(2, 0.1, { strategyId: "S-03" }).map((r) => ({ ...r, venue: "LIVE" as const }));
    const other = series(1, 0.9, { strategyId: "RSW-01" });
    const rows = [...paper, ...live, ...other];
    const out = compareByStrategy(rows);
    const s03 = out.find((s) => s.strategyId === "S-03")!;
    expect(s03.paper.n).toBe(2);
    expect(s03.live.n).toBe(2);
    expect(s03.deltaR).toBeCloseTo(0.2, 12);
    const rsw = out.find((s) => s.strategyId === "RSW-01")!;
    expect(rsw.live.n).toBe(0);
    expect(rsw.deltaR).toBeNull();
  });

  it("DEMO/MANUAL tidak masuk breakdown", () => {
    const rows = [classified({ id: 1, source: "DEMO" }), classified({ id: 2, source: "MANUAL" })];
    expect(compareByStrategy(rows)).toEqual([]);
  });
});

describe("toFindingVerdict", () => {
  it("WITHIN_TOLERANCE => SUPPORTIVE, DEVIATION => REFUTED, INCONCLUSIVE => INCONCLUSIVE", () => {
    expect(toFindingVerdict("WITHIN_TOLERANCE")).toBe("SUPPORTIVE");
    expect(toFindingVerdict("DEVIATION")).toBe("REFUTED");
    expect(toFindingVerdict("INCONCLUSIVE")).toBe("INCONCLUSIVE");
  });
});
