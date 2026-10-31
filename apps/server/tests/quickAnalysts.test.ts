// apps/server/tests/quickAnalysts.test.ts
// Analisis cepat paralel (Sari/Tala/Giri) — prompt builder per analis, fallback
// deterministik, dan orkestrasi paralel dengan AGENT_DIALOG per agen.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: { create: vi.fn(async () => undefined) },
  },
}));

import {
  buildMarketContextPrompt,
  buildSignalPrompt,
  buildFunnelPrompt,
  quickFallback,
  runQuickAnalysisTriplet,
  type QuickAnalysisInput,
} from "../src/agents/quickAnalysts.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
import { db } from "../src/core/db.js";

const T0 = new Date("2026-10-27T08:00:00.000Z");

const input: QuickAnalysisInput = {
  dayKey: "2026-10-27",
  swingSignals: [
    { decision: "ENTRY_OPENED", strategyId: "S-05", symbol: "BTCUSDT", createdAt: T0 },
    { decision: "SKIP_ENTRY_GAP", strategyId: "S-03", symbol: "ETHUSDT", createdAt: T0 },
  ],
  swingSignalsTotal: 87,
  openPositions: [{ symbol: "BTCUSDT", side: "LONG", strategyId: "S-05", entryPrice: 65000, openedAt: T0 }],
  recentTrades: [{ symbol: "SOLUSDT", pnlUsd: 1.2, rMultiple: 1.67, strategyId: "S-03", closeReason: "TP1", createdAt: T0 }],
};

describe("quickAnalysts — prompt builder per analis (kecil, terpisah)", () => {
  it("market-context memuat market intelligence + mikrostruktur", () => {
    const p = buildMarketContextPrompt(input);
    expect(p).toContain("RINGKASAN PASAR");
    expect(p).toContain("mikrostruktur tidak tersedia"); // marketIntel absen
  });

  it("signal-analyst memuat baris sinyal + distribusi keputusan + total", () => {
    const p = buildSignalPrompt(input);
    expect(p).toContain("BTCUSDT S-05 ENTRY_OPENED");
    expect(p).toContain("total 87");
    expect(p).toContain("ENTRY_OPENED");
  });

  it("funnel-analyst memuat posisi + ringkasan funnel", () => {
    const p = buildFunnelPrompt(input);
    expect(p).toContain("BTCUSDT LONG S-05 entry 65000");
    expect(p).toContain("KUALITAS FUNNEL");
    expect(p).toContain("$1.20");
  });
});

describe("quickAnalysts — fallback deterministik", () => {
  it("setiap analis punya fallback jujur", () => {
    expect(quickFallback("market-context", input)).toContain("LLM tidak tersedia");
    expect(quickFallback("signal-analyst", input)).toContain("87 sinyal");
    expect(quickFallback("funnel-analyst", input)).toContain("1 posisi open");
  });
});

describe("quickAnalysts — runQuickAnalysisTriplet", () => {
  it("tiga analis berjalan dan menulis AGENT_DIALOG masing-masing + event gabungan", async () => {
    const createMock = db.eventLog.create as ReturnType<typeof vi.fn>;
    createMock.mockClear();
    const adapter = { callFast: vi.fn(async () => ({ content: "Konteks pasar ringkas berbasis angka." })) } as unknown as XkiroAdapter;

    const res = await runQuickAnalysisTriplet(input, adapter);
    expect(res.sections).toHaveLength(3);
    expect(res.allByLlm).toBe(true);
    expect(adapter.callFast).toHaveBeenCalledTimes(3);

    const rows = createMock.mock.calls.map((c: unknown[]) => (c[0] as { data: { type: string; payload: string } }).data);
    const dialogs = rows.filter((r) => r.type === "AGENT_DIALOG").map((r) => JSON.parse(r.payload).agentId);
    expect(dialogs.sort()).toEqual(["funnel-analyst", "market-context", "signal-analyst"]);
    expect(rows.some((r) => r.type === "LLM_QUICK_ANALYSIS")).toBe(true);
  });

  it("satu analis gagal tidak menggugurkan yang lain (fail-open per analis)", async () => {
    let calls = 0;
    const adapter = {
      callFast: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("LLM_TIMEOUT");
        return { content: "Hasil analisis." };
      }),
    } as unknown as XkiroAdapter;

    const res = await runQuickAnalysisTriplet(input, adapter);
    expect(res.allByLlm).toBe(false);
    const failed = res.sections.filter((s) => !s.byLlm);
    expect(failed).toHaveLength(1);
    expect(failed[0].text).toContain("Fallback");
    expect(res.sections.filter((s) => s.byLlm)).toHaveLength(2);
  });
});
