import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
import { buildTradeForensicBundle, type ForensicBar } from "../src/learning/tradeForensics.js";
import { renderTradeCaseStudy } from "../src/learning/caseStudy.js";
import { computeProcessReportCard, renderProcessReportCard } from "../src/agents/reportWriter.js";
import { vwapSession } from "../src/engines/indicatorLibrary.js";
import { parseDerivedTrigger, evaluateRuleFriction, frictionScore, type PlaybookRuleRow } from "../src/learning/playbookRules.js";
import type { TradeForEvaluation } from "../src/learning/postMortemEvaluator.js";

const minute = 60_000;
const start = Date.UTC(2026, 9, 9, 0, 10); // setelah midnight UTC agar VWAP punya jendela
// 12 bar: bar 2 = swing low 95, bar 4 = swing high 105 (pivot terkonfirmasi strength 2).
// 12 bar memastikan seed EMA(9) lengkap sebelum bar entry (index 9).
const bars: ForensicBar[] = Array.from({ length: 12 }, (_, i) => ({
  openTime: start + i * minute,
  open: 100,
  high: i === 4 ? 105 : 103,
  low: i === 2 ? 95 : 97,
  close: 101,
  volume: 10,
}));
// Entry di bar 9, close di bar 10 -> bar 0..8 sudah tutup sebelum entry.
const trade: TradeForEvaluation = {
  id: 7, positionId: 7, symbol: "SOLUSDT", mode: "SCALP", side: "LONG", riskUsd: 1,
  entryAvg: 100, exitAvg: 99, rMultiple: -1, pnlUsd: -1, feeUsd: 0.05, holdMinutes: 2,
  win: false, closeReason: "SL", source: "PAPER_AI", accountingQuality: "SIMULATED",
  fundingVerified: false, excursionsVerified: false,
  openedAt: new Date(start + 9 * minute + 30_000), closedAt: new Date(start + 10 * minute + 30_000),
  createdAt: new Date(start + 10 * minute + 30_000), plannedSlPrice: 95, plannedTp1Price: 105,
  maePrice: 97, mfePrice: 105,
};
const symbols = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "BTCDOMUSDT"];
const bundle = buildTradeForensicBundle({
  trade, interval: "1m",
  barsBySymbol: Object.fromEntries(symbols.map((s) => [s, bars])),
  fetchedAt: new Date(start),
});

describe("SMB T-07 forensik diperkaya", () => {
  it("annotatedTimeline berisi 4 titik kunci dengan EMA9 & VWAP tersitasi", () => {
    expect(bundle.annotatedTimeline.map((p) => p.label)).toEqual(["ENTRY", "MAE", "MFE", "EXIT"]);
    for (const p of bundle.annotatedTimeline) {
      expect(p.status).toBe("OBSERVED");
      expect(bundle.facts.some((f) => f.id === p.evidenceId)).toBe(true);
    }
    const entry = bundle.annotatedTimeline[0]!;
    expect(entry.openTime).toBe(start + 9 * minute);
    expect(entry.close).toBe(101);
    expect(typeof entry.ema9).toBe("number");
    expect(entry.distEma9Pct).not.toBeNull();
    expect(entry.distVwapPct).not.toBeNull();
  });

  it("level S/R pra-entry dihitung hanya dari bar tertutup sebelum entry", () => {
    const sup = bundle.facts.find((f) => f.id === "context.nearest_support_pre_entry");
    const res = bundle.facts.find((f) => f.id === "context.nearest_resistance_pre_entry");
    expect(sup).toMatchObject({ value: 95, status: "DERIVED" });
    expect(res).toMatchObject({ value: 105, status: "DERIVED" });
  });

  it("bar MAE/MFE dilokalisasi ke bar ekstrem terdekat (long: low untuk MAE)", () => {
    const mae = bundle.annotatedTimeline[1]!;
    const mfe = bundle.annotatedTimeline[2]!;
    expect(mae.status).toBe("OBSERVED");
    // Fix audit 13 Okt 2026 (commit 92712d6): MAE/MFE hanya dicari di bar SELAMA
    // posisi hidup [openedAt, closedAt). Ekstrem pra-entry (bar 4 = high 105)
    // TIDAK boleh terpilih — anomali timestamp MFE < ENTRY sudah dibereskan.
    // Bar live = bar 9 & 10 (high 103 semua) -> ekstrem terdekat ke 105 = bar 9.
    expect(mfe.openTime).toBe(start + 9 * minute);
    expect(mfe.openTime).toBeGreaterThanOrEqual(bundle.annotatedTimeline[0]!.openTime!);
  });

  it("vwapSession anchor UTC: bar sebelum midnight tidak ikut", () => {
    const crossMidnight: ForensicBar[] = [
      { openTime: Date.UTC(2026, 9, 8, 23, 59), open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: Date.UTC(2026, 9, 9, 0, 1), open: 20, high: 20, low: 20, close: 20, volume: 100 },
    ];
    const v = vwapSession(crossMidnight, Date.UTC(2026, 9, 9, 0, 1));
    expect(v).toBe(20); // bar 10 (kemarin) tidak ikut
  });

  it("bundle tanpa bar -> timeline kosong, tidak mengarang angka", () => {
    const empty = buildTradeForensicBundle({ trade, interval: "1m", barsBySymbol: {}, fetchedAt: new Date(start) });
    expect(empty.annotatedTimeline).toHaveLength(0);
    expect(empty.source).toBe("UNAVAILABLE");
  });
});

describe("SMB T-08 render studi kasus", () => {
  it("markdown memuat identitas, timeline, coverage, dan batasan", () => {
    const md = renderTradeCaseStudy({
      id: 7, symbol: "SOLUSDT", side: "LONG", mode: "SCALP", strategyId: "S-01",
      entryAvg: 100, exitAvg: 99, pnlUsd: -1, rMultiple: -1, feeUsd: 0.05,
      holdMinutes: 2, closeReason: "SL", plannedSlPrice: 95, plannedTp1Price: 105,
      executionMistake: "MISTAKE_STOP_PLACEMENT", causeCode: "LOSS_SL",
    }, bundle);
    expect(md).toContain("STUDI KASUS TEKNIS — Trade #7 SOLUSDT");
    expect(md).toContain("ENTRY t=");
    expect(md).toContain("EMA9=");
    expect(md).toContain("VWAP(UTC)=");
    expect(md).toMatch(/SOLUSDT: \d+\/\d+ bar \(lengkap\)/);
    expect(md).toContain("Support pivot terdekat");
    expect(md).toContain("executionMistake=MISTAKE_STOP_PLACEMENT");
    expect(md).toContain("Batasan:");
  });
});

describe("SMB T-02 report card proses", () => {
  const card = computeProcessReportCard({
    trades: [
      { tradeId: 1, symbol: "AUSDT", executionMistake: "MISTAKE_SIZING", isExecutionMistake: true, closeReason: "SL", riskUsd: 1.5, plannedSlPrice: 95, executedSlPrice: 95 },
      { tradeId: 2, symbol: "BUSDT", executionMistake: "MISTAKE_NONE", isExecutionMistake: false, closeReason: "TP1", riskUsd: 1, plannedSlPrice: 95, executedSlPrice: 95 },
      { tradeId: 3, symbol: "CUSDT", executionMistake: "MISTAKE_NONE", isExecutionMistake: false, closeReason: "KILL", riskUsd: 1, plannedSlPrice: 95, executedSlPrice: 95 },
    ],
    frictionEventsToday: 2,
  });

  it("menghitung kesalahan, kepatuhan SL, sizing, exit non-baku", () => {
    expect(card.total).toBe(3);
    expect(card.mistakes).toBe(1);
    expect(card.byType).toEqual([{ code: "MISTAKE_SIZING", count: 1 }]);
    expect(card.slChecked).toBe(3);
    expect(card.slCompliant).toBe(3);
    expect(card.sizingOverTolerance).toBe(1); // riskUsd 1.5 vs baseline 1
    expect(card.nonStandardExits).toBe(1);   // KILL
    expect(card.frictionEventsToday).toBe(2);
    expect(card.disciplineScorePct).toBeCloseTo(66.7, 1);
    expect(card.verdict).toBe("EVALUASI");
  });

  it("render memuat judul section dan skor", () => {
    const md = renderProcessReportCard(card, ["- [APPROVED] contoh aturan (applied 1, violated 2, friction 66.7%)"]);
    expect(md).toContain("## PROCESS & EXECUTION REPORT CARD (SMB)");
    expect(md).toContain("66.7% — EVALUASI");
    expect(md).toContain("MISTAKE_SIZING: 1");
    expect(md).toContain("contoh aturan");
  });

  it("tanpa trade = skor penuh BERSIH (bukan divide-by-zero)", () => {
    const empty = computeProcessReportCard({ trades: [] });
    expect(empty.disciplineScorePct).toBe(100);
    expect(empty.verdict).toBe("BERSIH");
  });
});

describe("SMB T-05/T-06 playbook & friction (fungsi murni)", () => {
  const rule = (trigger: string): PlaybookRuleRow => ({
    id: "r1", ruleText: "x", triggerCondition: trigger, actionStatement: "y",
    source: "DERIVED", status: "APPROVED", appliedCount: 1, violatedCount: 3,
    createdAt: new Date(), updatedAt: new Date(),
  });

  it("parseDerivedTrigger menerima JSON valid, menolak lainnya", () => {
    expect(parseDerivedTrigger(JSON.stringify({ kind: "RECURRING_MISTAKE", executionMistake: "MISTAKE_SIZING" })))
      .toEqual({ kind: "RECURRING_MISTAKE", executionMistake: "MISTAKE_SIZING" });
    expect(parseDerivedTrigger("teks bebas manual")).toBeNull();
    expect(parseDerivedTrigger("{")).toBeNull();
  });

  it("friction: kesalahan sama dengan trigger = VIOLATED, bersih = APPLIED, teks bebas = NOT_APPLICABLE", () => {
    const derived = rule(JSON.stringify({ kind: "RECURRING_MISTAKE", executionMistake: "MISTAKE_SIZING" }));
    expect(evaluateRuleFriction(derived, "MISTAKE_SIZING")).toBe("VIOLATED");
    expect(evaluateRuleFriction(derived, "MISTAKE_NONE")).toBe("APPLIED");
    expect(evaluateRuleFriction(rule("jangan entry saat funding tinggi"), "MISTAKE_SIZING")).toBe("NOT_APPLICABLE");
  });

  it("frictionScore = violated / (applied+violated)", () => {
    expect(frictionScore(1, 3)).toBeCloseTo(0.75, 5);
    expect(frictionScore(0, 0)).toBe(0);
  });
});