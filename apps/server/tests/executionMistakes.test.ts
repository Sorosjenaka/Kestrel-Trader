import { describe, expect, it, vi } from "vitest";
import {
  detectExecutionMistake,
  detectRecurringMistakes,
  isExecutionMistakeCode,
  MISTAKE_THRESHOLDS,
  TARGET_RISK_BASELINE_USD,
} from "../src/learning/executionMistakes.js";

const base = {
  riskUsd: 1,
  targetRiskUsd: TARGET_RISK_BASELINE_USD,
  closeReason: "SL",
  entryAvg: 100,
  exitAvg: 99,
  plannedSlPrice: 99,
  executedSlPrice: 99,
  plannedTp1Price: 101.5,
  side: "LONG",
  priorSymbolTrades: [] as Array<{ closedAt: Date | null; closeReason: string | null; win: boolean; openedAt: Date | null }>,
  openedAt: new Date("2026-10-09T01:00:00Z"),
};

it("accepts confirmed versioned BE but still rejects unauthorized or non-entry stop changes", () => {
  expect(detectExecutionMistake({...base,executedSlPrice:100,exitAvg:101,authorizedBreakeven:true}).mistake).toBe("MISTAKE_NONE");
  expect(detectExecutionMistake({...base,executedSlPrice:100,exitAvg:101}).mistake).toBe("MISTAKE_STOP_PLACEMENT");
  expect(detectExecutionMistake({...base,executedSlPrice:101,authorizedBreakeven:true}).mistake).toBe("MISTAKE_STOP_PLACEMENT");
});

describe("SMB T-01 taksonomi kesalahan eksekusi", () => {
  it("allowlist menolak kode di luar enum", () => {
    expect(isExecutionMistakeCode("MISTAKE_SIZING")).toBe(true);
    expect(isExecutionMistakeCode("MISTAKE_HARAPAN")).toBe(false);
    expect(isExecutionMistakeCode(123)).toBe(false);
  });

  it("trade bersih (SL rencana, sizing baseline, exit baku) = MISTAKE_NONE", () => {
    const r = detectExecutionMistake(base);
    expect(r.mistake).toBe("MISTAKE_NONE");
    expect(r.isMistake).toBe(false);
    expect(r.notes.join(" ")).toContain("MISTAKE_NONE");
  });

  it("exit di luar aturan baku (KILL) = MISTAKE_EARLY_EXIT", () => {
    const r = detectExecutionMistake({ ...base, closeReason: "KILL" });
    expect(r.mistake).toBe("MISTAKE_EARLY_EXIT");
    expect(r.isMistake).toBe(true);
  });

  it("SL eksekusi digeser dari rencana = MISTAKE_STOP_PLACEMENT", () => {
    const r = detectExecutionMistake({ ...base, executedSlPrice: 98 });
    expect(r.mistake).toBe("MISTAKE_STOP_PLACEMENT");
  });

  it("pergeseran SL kecil masih toleransi", () => {
    const moved = 99 * (1 + MISTAKE_THRESHOLDS.SL_MOVE_TOL / 2);
    const r = detectExecutionMistake({ ...base, executedSlPrice: moved });
    expect(r.mistake).not.toBe("MISTAKE_STOP_PLACEMENT");
  });

  it("deviasi sizing dari baseline $1 = MISTAKE_SIZING", () => {
    const r = detectExecutionMistake({ ...base, riskUsd: 1.5 });
    expect(r.mistake).toBe("MISTAKE_SIZING");
  });

  it("fill exit meleset dari level rencana = MISTAKE_PLAN_DEVIATION + planDeviationRatio terukur", () => {
    // SL rencana 99 (jarak R = 1), exit tercatat 97.5 -> deviasi 1.5R > tol 0.02
    const r = detectExecutionMistake({ ...base, exitAvg: 97.5 });
    expect(r.mistake).toBe("MISTAKE_PLAN_DEVIATION");
    expect(r.planDeviationRatio).toBeCloseTo(1.5, 5);
  });

  it("re-entry cepat setelah SL rugi pada simbol sama = MISTAKE_REVENGE", () => {
    const r = detectExecutionMistake({
      ...base,
      priorSymbolTrades: [
        { closedAt: new Date("2026-10-09T00:58:00Z"), closeReason: "SL", win: false, openedAt: new Date("2026-10-09T00:50:00Z") },
      ],
    });
    expect(r.mistake).toBe("MISTAKE_REVENGE");
  });

  it("re-entry setelah jendela revenge = bukan revenge", () => {
    const r = detectExecutionMistake({
      ...base,
      priorSymbolTrades: [
        { closedAt: new Date("2026-10-09T00:30:00Z"), closeReason: "SL", win: false, openedAt: new Date("2026-10-09T00:10:00Z") },
      ],
    });
    expect(r.mistake).not.toBe("MISTAKE_REVENGE");
  });

  it("SL tidak tercatat = SL check SKIP, tidak memvonis kesalahan", () => {
    const r = detectExecutionMistake({ ...base, plannedSlPrice: null, executedSlPrice: null });
    expect(r.mistake).toBe("MISTAKE_NONE");
    expect(r.notes.join(" ")).toContain("SL check SKIP");
  });
});

describe("SMB T-03 deteksi kesalahan berulang", () => {
  it(">= ambang (3) dalam jendela 20 -> finding", () => {
    const codes = ["MISTAKE_SIZING", "MISTAKE_NONE", "MISTAKE_SIZING", "MISTAKE_STOP_PLACEMENT", "MISTAKE_SIZING"];
    const findings = detectRecurringMistakes(codes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ mistake: "MISTAKE_SIZING", occurrences: 3 });
  });

  it("di bawah ambang -> kosong; MISTAKE_NONE diabaikan", () => {
    const codes = ["MISTAKE_NONE", "MISTAKE_SIZING", "MISTAKE_SIZING"];
    expect(detectRecurringMistakes(codes)).toHaveLength(0);
  });

  it("jendela memotong daftar lebih panjang dari windowTrades", () => {
    const codes = Array.from({ length: 5 }, () => "MISTAKE_LATE");
    const findings = detectRecurringMistakes(codes, 2, 3);
    expect(findings).toHaveLength(0); // hanya 2 kode dalam jendela
  });

  it("kode invalid/legacy diabaikan", () => {
    const codes = ["APA_AJA", null, undefined, "MISTAKE_REVENGE", "MISTAKE_REVENGE", "MISTAKE_REVENGE"];
    const findings = detectRecurringMistakes(codes);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.mistake).toBe("MISTAKE_REVENGE");
  });
});
