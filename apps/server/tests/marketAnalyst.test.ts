// apps/server/tests/marketAnalyst.test.ts
// LLM Market Analyst (14 Okt 2026): prompt builder + fallback deterministik
// murni-fungsi; snapshot gabungan; cap harian logika data.
import { describe, expect, it } from "vitest";
import {
  buildAnalystPrompt,
  analystFallbackSummary,
  type AnalystSnapshot,
} from "../src/agents/marketAnalyst.js";

const T0 = new Date("2026-10-14T08:00:00.000Z");

const emptySnap: AnalystSnapshot = {
  dayKey: "2026-10-14",
  swingSignals: [],
  openPositions: [],
  recentTrades: [],
  briefExcerpt: "",
};

const fullSnap: AnalystSnapshot = {
  dayKey: "2026-10-14",
  swingSignals: [
    { decision: "ENTRY_OPENED", strategyId: "S-05", symbol: "BTCUSDT", createdAt: T0 },
    { decision: "SKIP_ENTRY_GAP", strategyId: "S-03", symbol: "ETHUSDT", createdAt: T0 },
  ],
  openPositions: [
    { symbol: "BTCUSDT", side: "LONG", strategyId: "S-05", entryPrice: 65000, openedAt: T0 },
  ],
  recentTrades: [
    { symbol: "SOLUSDT", pnlUsd: 1.2, rMultiple: 1.67, strategyId: "S-03", closeReason: "TP1", createdAt: T0 },
    { symbol: "XRPUSDT", pnlUsd: -1, rMultiple: -1, strategyId: "S-05", closeReason: "SL", createdAt: T0 },
  ],
  briefExcerpt: "Ringkasan harian deterministik.",
};

describe("Market Analyst — buildAnalystPrompt", () => {
  it("menyertakan blok pasar & sinyal saat ada (evaluasi trade pindah ke agen Mira)", () => {
    const p = buildAnalystPrompt(fullSnap);
    expect(p).toContain("BTCUSDT S-05 ENTRY_OPENED");
    expect(p).toContain("ETHUSDT S-03 SKIP_ENTRY_GAP");
    expect(p).toContain("BTCUSDT LONG S-05 entry 65000");
    // 27 Okt 2026: bagian trade & brief TIDAK lagi di prompt analyst.
    expect(p).not.toContain("15 trade terakhir");
    expect(p).not.toContain("Ringkasan brief harian");
    expect(p).not.toContain("exit: TP1");
  });

  it("fail-open ramah: snapshot kosong tetap prompt valid dengan penanda eksplisit", () => {
    const p = buildAnalystPrompt(emptySnap);
    expect(p).toContain("tidak ada sinyal swing");
    expect(p).toContain("tidak ada posisi open");
  });

  it("menampilkan total sinyal 24 jam saat baris dibatasi", () => {
    const p = buildAnalystPrompt({ ...fullSnap, swingSignalsTotal: 87 });
    expect(p).toContain("menampilkan 2 terbaru dari 87 sinyal 24 jam");
  });
});

describe("Market Analyst — fallback deterministik (byLlm=false jujur)", () => {
  it("merangkum angka tanpa LLM", () => {
    const f = analystFallbackSummary(fullSnap);
    expect(f).toContain("1 entry swing");
    expect(f).toContain("$0.20"); // 1.2 - 1
    expect(f).toContain("LLM tidak tersedia");
  });

  it("snapshot kosong tidak melempar error", () => {
    expect(analystFallbackSummary(emptySnap)).toContain("0 entry");
  });
});
