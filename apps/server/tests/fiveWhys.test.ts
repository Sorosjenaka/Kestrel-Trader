import { describe, expect, it, vi } from "vitest";
import { runFiveWhysDiagnosis, FIVE_WHYS_LAYER_FOCUS, FIVE_WHYS_LIMITS } from "../src/learning/fiveWhys.js";
import { buildTradeForensicBundle, type ForensicBar } from "../src/learning/tradeForensics.js";
import type { TradeForEvaluation } from "../src/learning/postMortemEvaluator.js";

const minute = 60_000;
const start = Date.UTC(2026, 9, 9);
const bars: ForensicBar[] = Array.from({ length: 9 }, (_, i) => ({
  openTime: start + i * minute, open: 100, high: 102, low: 98, close: 100, volume: 10,
}));
const trade: TradeForEvaluation = {
  id: 42, positionId: 42, symbol: "SOLUSDT", mode: "SCALP", side: "LONG", riskUsd: 1,
  entryAvg: 100, exitAvg: 99, rMultiple: -1, pnlUsd: -1, feeUsd: 0.05, holdMinutes: 2,
  win: false, closeReason: "SL", source: "PAPER_AI", accountingQuality: "SIMULATED",
  fundingVerified: false, excursionsVerified: false,
  openedAt: new Date(start + 30_000), closedAt: new Date(start + 150_000),
  createdAt: new Date(start + 150_000), plannedSlPrice: 95, plannedTp1Price: 105,
};
const forensic = buildTradeForensicBundle({
  trade, interval: "1m",
  barsBySymbol: { SOLUSDT: bars, BTCUSDT: bars, ETHUSDT: bars, BTCDOMUSDT: bars },
  fetchedAt: new Date(start),
});

function adapter(answer: string, refs: string[]) {
  return {
    callReason: vi.fn(async () => ({ content: JSON.stringify({ answer, evidenceRefs: refs }), model: "test/reason" })),
    callFast: vi.fn(async () => ({ content: "", model: "test/fast" })),
  };
}

describe("SMB T-04 diagnosis 5 Whys", () => {
  it("5 lapis lengkap, semua HYPOTHESIS dengan sitasi evidence valid", async () => {
    const a = adapter("Harga turun setelah entry; kemungkinan area entry tidak terkonfirmasi bukti yang ada.", ["trade.pnl_usd"]);
    const res = await runFiveWhysDiagnosis({
      adapter: a as never, trade, forensic, executionMistake: "MISTAKE_STOP_PLACEMENT",
    });
    expect(res.layers).toHaveLength(FIVE_WHYS_LIMITS.MAX_LAYERS);
    expect(res.terminated).toBe("COMPLETE");
    expect(res.status).toBe("HYPOTHESIS");
    expect(res.layers.map((l) => l.focus)).toEqual([...FIVE_WHYS_LAYER_FOCUS]);
    for (const l of res.layers) {
      expect(l.status).toBe("HYPOTHESIS");
      expect(l.evidenceRefs).toContain("trade.pnl_usd");
    }
    expect(a.callReason).toHaveBeenCalledTimes(5);
  });

  it("jawaban tanpa sitasi valid = lapisan UNKNOWN", async () => {
    const a = adapter("Jawaban tanpa bukti yang sah untuk lapisan ini, sekadar opini naratif.", ["bukti.karangan"]);
    const res = await runFiveWhysDiagnosis({ adapter: a as never, trade, forensic, executionMistake: "MISTAKE_SIZING" });
    expect(res.layers[0]!.status).toBe("UNKNOWN");
    expect(res.layers[0]!.evidenceRefs).toHaveLength(0);
  });

  it("2 UNKNOWN beruntun = terminasi paksa NON_CONVERGENT", async () => {
    const a = {
      callReason: vi.fn(async () => ({ content: "bukan json sama sekali", model: "test/reason" })),
      callFast: vi.fn(),
    };
    const res = await runFiveWhysDiagnosis({ adapter: a as never, trade, forensic, executionMistake: "MISTAKE_LATE" });
    expect(res.terminated).toBe("NON_CONVERGENT");
    expect(res.layers).toHaveLength(FIVE_WHYS_LIMITS.MAX_CONSECUTIVE_UNKNOWN);
    expect(res.layers.every((l) => l.status === "UNKNOWN")).toBe(true);
  });

  it("LLM gagal tidak melempar — lapisan dicatat dengan failureCode", async () => {
    const a = {
      callReason: vi.fn(async () => { throw new Error("LLM_TIMEOUT"); }),
      callFast: vi.fn(),
    };
    const res = await runFiveWhysDiagnosis({ adapter: a as never, trade, forensic, executionMistake: "MISTAKE_REVENGE" });
    expect(res.layers[0]!.failureCode).toBe("LLM_TIMEOUT");
    expect(res.terminated).toBe("NON_CONVERGENT");
  });

  it("maxLayers dibatasi <= 5", async () => {
    const a = adapter("Hipotesis dengan bukti yang cukup untuk lapisan ini, ditulis spesifik.", ["trade.pnl_usd"]);
    const res = await runFiveWhysDiagnosis({ adapter: a as never, trade, forensic, executionMistake: "MISTAKE_NONE", maxLayers: 99 });
    expect(res.layers.length).toBeLessThanOrEqual(5);
  });
});