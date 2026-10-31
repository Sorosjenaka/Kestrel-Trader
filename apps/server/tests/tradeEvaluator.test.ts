// apps/server/tests/tradeEvaluator.test.ts
// Agen Mira (trade-evaluator) — pemecahan beban Market Analyst (27 Okt 2026):
// prompt builder + fallback deterministik + gerbang interval/cap + bukti
// AGENT_DIALOG milik agen di EventLog.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
    },
  },
}));

// Jangan menulis file nyata ke repo saat test siklus.
vi.mock("node:fs", () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    appendFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
  },
}));

import {
  buildTradeEvalPrompt,
  tradeEvalFallbackSummary,
  runTradeEvaluatorCycle,
  type TradeEvalSnapshot,
} from "../src/agents/tradeEvaluator.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
import { db } from "../src/core/db.js";

const T0 = new Date("2026-10-27T08:00:00.000Z");

const emptySnap: TradeEvalSnapshot = {
  dayKey: "2026-10-27",
  recentTrades: [],
};

const fullSnap: TradeEvalSnapshot = {
  dayKey: "2026-10-27",
  recentTrades: [
    { symbol: "SOLUSDT", pnlUsd: 1.2, rMultiple: 1.67, strategyId: "S-03", closeReason: "TP1", createdAt: T0 },
    { symbol: "XRPUSDT", pnlUsd: -1, rMultiple: -1, strategyId: "S-05", closeReason: "SL", createdAt: T0 },
  ],
  openPositions: [
    { symbol: "BTCUSDT", side: "LONG", strategyId: "S-05", entryPrice: 65000, openedAt: T0 },
  ],
  briefExcerpt: "Ringkasan harian deterministik.",
};

function okAdapter(text: string): XkiroAdapter {
  return { callReason: vi.fn(async () => ({ content: text })) } as unknown as XkiroAdapter;
}

describe("Trade Evaluator (Mira) — buildTradeEvalPrompt", () => {
  it("memuat blok yang dipindah dari analyst: trade terakhir + brief harian", () => {
    const p = buildTradeEvalPrompt(fullSnap);
    expect(p).toContain("15 trade terakhir");
    expect(p).toContain("$1.20 (1.67R");
    expect(p).toContain("exit: TP1");
    expect(p).toContain("Ringkasan brief harian");
    expect(p).toContain("Ringkasan harian deterministik.");
    expect(p).toContain("BTCUSDT LONG S-05 entry 65000");
  });

  it("snapshot kosong tetap prompt valid dengan penanda eksplisit", () => {
    const p = buildTradeEvalPrompt(emptySnap);
    expect(p).toContain("belum ada trade selesai");
    expect(p).toContain("tidak ada posisi open");
    expect(p).toContain("brief hari ini belum tersedia");
  });
});

describe("Trade Evaluator (Mira) — fallback deterministik", () => {
  it("merangkum angka menang/kalah tanpa LLM", () => {
    const f = tradeEvalFallbackSummary(fullSnap);
    expect(f).toContain("2 trade terakhir");
    expect(f).toContain("1 profit, 1 loss");
    expect(f).toContain("$0.20");
  });

  it("snapshot kosong tidak melempar error", () => {
    expect(tradeEvalFallbackSummary(emptySnap)).toContain("0 trade terakhir");
  });
});

describe("Trade Evaluator (Mira) — runTradeEvaluatorCycle", () => {
  it("menulis LLM_TRADE_EVAL + AGENT_DIALOG milik agen saat LLM sukses", async () => {
    const createMock = db.eventLog.create as ReturnType<typeof vi.fn>;
    createMock.mockClear();

    const res = await runTradeEvaluatorCycle("2026-10-27", fullSnap, okAdapter("Evaluasi trade berbasis angka."));
    expect(res.ran).toBe(true);
    expect(res.byLlm).toBe(true);
    expect(res.path).toContain("trade-eval-2026-10-27.md");

    const rows = createMock.mock.calls.map((c: unknown[]) => (c[0] as { data: { type: string; payload: string } }).data);
    const evalRow = rows.find((r) => r.type === "LLM_TRADE_EVAL");
    expect(evalRow).toBeDefined();
    expect(JSON.parse(evalRow!.payload).byLlm).toBe(true);

    const dialogRow = rows.find((r) => r.type === "AGENT_DIALOG");
    expect(dialogRow).toBeDefined();
    const dialog = JSON.parse(dialogRow!.payload) as { agentId: string; name: string; context: { kind: string } };
    expect(dialog.agentId).toBe("trade-evaluator");
    expect(dialog.name).toBe("Mira");
    expect(dialog.context.kind).toBe("trade_eval");
  });

  it("fallback jujur saat LLM gagal (byLlm=false, teks deterministik)", async () => {
    const failing = { callReason: vi.fn(async () => { throw new Error("LLM_TIMEOUT"); }) } as unknown as XkiroAdapter;
    const res = await runTradeEvaluatorCycle("2026-10-27", fullSnap, failing);
    expect(res.ran).toBe(true);
    expect(res.byLlm).toBe(false);
  });

  it("menghormati cap harian LLM_TRADE_EVAL_MAX_DAILY_CALLS", async () => {
    const countMock = db.eventLog.count as ReturnType<typeof vi.fn>;
    countMock.mockResolvedValueOnce(99);
    const res = await runTradeEvaluatorCycle("2026-10-27", fullSnap, okAdapter("x"));
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("DAILY_CAP");
  });

  it("menghormati interval minimum antar evaluasi", async () => {
    const findFirstMock = db.eventLog.findFirst as ReturnType<typeof vi.fn>;
    findFirstMock.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 60_000) });
    const res = await runTradeEvaluatorCycle("2026-10-27", fullSnap, okAdapter("x"));
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("INTERVAL");
  });
});
