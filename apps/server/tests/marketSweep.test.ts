// tests/marketSweep.test.ts — 15 Okt 2026
// LLM Market Sweep: fan-out paralel semua simbol, cache bar-1h, parse
// fail-closed, stage-2 konservatif, EventLog/laporan. Semua hermetik:
// adapter + db di-inject, tanpa HTTP/Binance nyata.
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  MarketSweep, buildSweepPrompt, parseSweepVerdict,
  type SweepSymbolVerdict,
} from "../src/agents/marketSweep.js";
import type { LlmResponse } from "../src/agents/llmAdapter.js";
import type { CandidateItem } from "../src/scanner/scannerPool.js";

const BAR_1H = Math.floor(Date.parse("2026-10-15T05:00:00Z") / 3_600_000) * 3_600_000;

function mkCandidate(symbol: string, mtfAnalyzedAt = BAR_1H + 120_000): CandidateItem {
  return {
    symbol, score: 7.5, mode: "SCALP", regime: "TREND_UP",
    zoneScore: 2, triggerScore: 3, trendScore: 2.5,
    gatesPass: {}, status: "READY",
    chop: 38, chopAdx: 27, biasTrend: "BULLISH", biasAdx: 30,
    strategyId: "S-03", entryType: "ZONE_TOUCH",
    plan: { side: "LONG", entryPrice: 100, slPrice: 97, tp1Price: 106 } as CandidateItem["plan"],
    tfSummary: "5m: naik; 15m: naik", mtfAnalyzed: true, mtfAnalyzedAt,
  } as unknown as CandidateItem;
}

function llmJson(obj: Record<string, unknown>): LlmResponse {
  return {
    content: JSON.stringify(obj), model: "mock",
    usage: { promptTokens: 700, completionTokens: 150, totalTokens: 850, estimatedCostUsd: 0.0001 },
    latencyMs: 5,
  };
}

function goodVerdict(symbol: string, verdict = "WATCH", confidence = 0.7): Record<string, unknown> {
  return { symbol, regime: "TREND_UP", bias: "BULLISH", momentum: "UP",
    riskNote: "ok", verdict, confidence, reason: "struktur naik" };
}

function mockDb() {
  const rows: Array<{ type: string; severity: string; payload: string }> = [];
  return {
    eventLog: {
      create: vi.fn(async (args: { data: { type: string; severity: string; payload: string } }) => {
        rows.push(args.data);
        return {};
      }),
    },
    rows,
  };
}

function mockAdapter(handler: (prompt: string, kind: "fast" | "reason") => Promise<LlmResponse>) {
  let inFlight = 0;
  let peak = 0;
  const fastCalls: string[] = [];
  const reasonCalls: string[] = [];
  return {
    inFlight: () => inFlight,
    peak: () => peak,
    fastCalls, reasonCalls,
    callFast: vi.fn(async (prompt: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      fastCalls.push(prompt);
      try { return await handler(prompt, "fast"); } finally { inFlight--; }
    }),
    callReason: vi.fn(async (prompt: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      reasonCalls.push(prompt);
      try { return await handler(prompt, "reason"); } finally { inFlight--; }
    }),
  };
}

describe("marketSweep — prompt & parse (pure)", () => {
  it("prompt memuat angka deterministik kandidat", () => {
    const p = buildSweepPrompt(mkCandidate("BTCUSDT"));
    expect(p).toContain("BTCUSDT");
    expect(p).toContain("7.5");
    expect(p).toContain("TREND_UP");
    expect(p).toContain("S-03");
  });

  it("parse fail-closed: enum salah / confidence di luar range / symbol beda = null", () => {
    expect(parseSweepVerdict("BTCUSDT", "bukan json")).toBeNull();
    expect(parseSweepVerdict("BTCUSDT", JSON.stringify(goodVerdict("BTCUSDT", "NGAWUR")))).toBeNull();
    expect(parseSweepVerdict("BTCUSDT", JSON.stringify(goodVerdict("ETHUSDT")))).toBeNull();
    const bad = goodVerdict("BTCUSDT"); bad.confidence = 2;
    expect(parseSweepVerdict("BTCUSDT", JSON.stringify(bad))).toBeNull();
    expect(parseSweepVerdict("BTCUSDT", JSON.stringify(goodVerdict("BTCUSDT")))).not.toBeNull();
  });
});

describe("marketSweep — fan-out, cache, stage-2", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fan-out: semua simbol dinilai sekali, laporan terisi", async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => mkCandidate(`SYM${i}USDT`));
    const adapter = mockAdapter(async (p) => llmJson(goodVerdict(p.split("\n")[0]!.split(": ")[1]!)));
    const dbs = mockDb();
    const sweep = new MarketSweep({ adapter, db: dbs as never, getCandidates: () => symbols, stage2: false });
    const report = await sweep.runSweep();
    expect(report).not.toBeNull();
    expect(report!.symbolsTotal).toBe(10);
    expect(report!.symbolsLlm).toBe(10);
    expect(adapter.fastCalls.length).toBe(10);
    expect(report!.estTokens).toBe(8500);
    expect(sweep.getLatestReport()?.sweepId).toBe(report!.sweepId);
  });

  it("cache bar-1h: sweep kedua skip semua; bar berganti = 1 call baru", async () => {
    const symbols = [mkCandidate("AAAUSDT"), mkCandidate("BBBUSDT")];
    const adapter = mockAdapter(async (p) => llmJson(goodVerdict(p.split("\n")[0]!.split(": ")[1]!)));
    const sweep = new MarketSweep({ adapter, db: mockDb() as never, getCandidates: () => symbols, stage2: false });
    await sweep.runSweep();
    expect(adapter.fastCalls.length).toBe(2);
    await sweep.runSweep(); // bar sama
    expect(adapter.fastCalls.length).toBe(2); // semua dari cache
    symbols[0] = mkCandidate("AAAUSDT", BAR_1H + 3_600_000 + 60_000); // bar baru
    await sweep.runSweep();
    expect(adapter.fastCalls.length).toBe(3);
  });

  it("JSON rusak = INVALID dihitung, tidak difabrikasi; error adapter = ERROR dihitung", async () => {
    const symbols = [mkCandidate("AAAUSDT"), mkCandidate("BBBUSDT"), mkCandidate("CCCUSDT")];
    const adapter = mockAdapter(async (p) => {
      const sym = p.split("\n")[0]!.split(": ")[1]!;
      if (sym === "AAAUSDT") return { ...llmJson({}), content: "rusak" };
      if (sym === "BBBUSDT") throw new Error("LLM_HTTP_500");
      return llmJson(goodVerdict(sym));
    });
    const sweep = new MarketSweep({ adapter, db: mockDb() as never, getCandidates: () => symbols, stage2: false });
    const report = await sweep.runSweep();
    expect(report!.symbolsSkippedInvalid).toBe(1);
    expect(report!.symbolsError).toBe(1);
    expect(report!.symbolsLlm).toBe(1);
    expect(report!.actionable.length + report!.watch.length).toBe(1);
  });

  it("stage-2: ACTIONABLE diverifikasi callReason; tidak setuju = WATCH; gagal parse = WATCH", async () => {
    const symbols = [mkCandidate("AAAUSDT"), mkCandidate("BBBUSDT")];
    const adapter = mockAdapter(async (p, kind) => {
      const sym = p.split("\n")[0]!.split(": ")[1]!;
      if (kind === "fast") return llmJson(goodVerdict(sym, "ACTIONABLE", 0.9));
      return llmJson(goodVerdict(sym, "WATCH", 0.4)); // stage-2 menolak
    });
    const sweep = new MarketSweep({ adapter, db: mockDb() as never, getCandidates: () => symbols, stage2: true });
    const report = await sweep.runSweep();
    expect(adapter.reasonCalls.length).toBe(2);
    expect(report!.actionable.length).toBe(0);
    expect(report!.watch.length).toBe(2);
    // stage-2 JSON rusak → WATCH juga (fail-closed)
    const adapter2 = mockAdapter(async (p, kind) => {
      const sym = p.split("\n")[0]!.split(": ")[1]!;
      if (kind === "fast") return llmJson(goodVerdict(sym, "ACTIONABLE", 0.9));
      return { ...llmJson({}), content: "```json\nbukan json\n```" };
    });
    const sweep2 = new MarketSweep({ adapter: adapter2, db: mockDb() as never, getCandidates: () => symbols, stage2: true });
    const report2 = await sweep2.runSweep();
    expect(report2!.actionable.length).toBe(0);
    expect(report2!.watch.length).toBe(2);
  });

  it("re-entrancy: sweep kedua saat jalan = null, tidak dobel", async () => {
    const symbols = Array.from({ length: 5 }, (_, i) => mkCandidate(`SYM${i}USDT`));
    const adapter = mockAdapter(async (p) => {
      await new Promise((r) => setTimeout(r, 30));
      return llmJson(goodVerdict(p.split("\n")[0]!.split(": ")[1]!));
    });
    const sweep = new MarketSweep({ adapter, db: mockDb() as never, getCandidates: () => symbols, stage2: false });
    const [a, b] = await Promise.all([sweep.runSweep(), sweep.runSweep()]);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(adapter.fastCalls.length).toBe(5);
  });

  it("persist: EventLog LLM_SWEEP 1/siklus + LLM_SWEEP_VERDICT per WATCH/ACTIONABLE", async () => {
    const symbols = [mkCandidate("AAAUSDT"), mkCandidate("BBBUSDT"), mkCandidate("CCCUSDT")];
    const adapter = mockAdapter(async (p) => {
      const sym = p.split("\n")[0]!.split(": ")[1]!;
      return llmJson(goodVerdict(sym, sym === "AAAUSDT" ? "ACTIONABLE" : "WATCH"));
    });
    const dbs = mockDb();
    const sweep = new MarketSweep({ adapter, db: dbs as never, getCandidates: () => symbols, stage2: false });
    await sweep.runSweep();
    const sweepRows = dbs.rows.filter((r) => r.type === "LLM_SWEEP");
    expect(sweepRows.length).toBe(1);
    const verdictRows = dbs.rows.filter((r) => r.type === "LLM_SWEEP_VERDICT");
    expect(verdictRows.length).toBe(3);
    // ACTIONABLE severity warn
    const actionable = JSON.parse(verdictRows.find((r) => JSON.parse(r.payload).symbol === "AAAUSDT")!.payload);
    expect(actionable.verdict).toBe("ACTIONABLE");
  });

  it("timeout slot: concurrency mengikuti limiter pemanggil (peak realistis, tidak serial)", async () => {
    const symbols = Array.from({ length: 8 }, (_, i) => mkCandidate(`P${i}USDT`));
    const adapter = mockAdapter(async (p) => {
      await new Promise((r) => setTimeout(r, 15));
      return llmJson(goodVerdict(p.split("\n")[0]!.split(": ")[1]!));
    });
    const sweep = new MarketSweep({ adapter, db: mockDb() as never, getCandidates: () => symbols, stage2: false });
    await sweep.runSweep();
    expect(adapter.peak()).toBeGreaterThan(1); // paralel, bukan serial
    expect(adapter.fastCalls.length).toBe(8);
  });
});
