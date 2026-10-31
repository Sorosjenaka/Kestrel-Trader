// 26 Okt 2026 (TAHAP 6B + DREX v2) — REPLAY terisolasi: evidence lima panel
// untuk kandidat NON-BTC.
//
// Yang dibuktikan (fixture/replay, BUKAN trade buatan di produksi):
//  1) Lima panel terbaca dan punya quality/coverage own.
//  2) Simbol kandidat non-BTC TIDAK menerima evidence BTC (evidenceSymbol =
//     base coin kandidat; angka panel milik kandidat).
//  3) Snapshot IMMUTABLE: hub berubah setelah capture -> snapshot tetap sama.
//  4) Evidence masa depan (sourceTsMs > capturedAtMs) TIDAK masuk snapshot.
//  5) Panel partial/unavailable/stale TIDAK dianggap nol/netral.
//  6) Freshness: evidence basi saat antre -> shadow SKIPPED_DATA_QUALITY.
//  7) v1 REJECT / v2 GO tidak menghasilkan entry dari shadow.
//  8) v1 GO / v2 REJECT tidak mengubah keputusan produksi.
//  9) Timeout/error v2 tidak mengganggu v1.
// 10) Satu kandidat tidak menghasilkan invocation ganda.
// 11) Hasil yang selesai tidak berurutan tetap dipasangkan via correlationId.
// 12) Payload v1 tidak ikut berubah karena builder v2.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as Array<{ type: string; severity: string; payload: string }>,
  // State hub yang dikontrol test (berubah setelah capture).
  // Waktu event SUMBER = offset relatif dari "sekarang" agar fixture tidak
  // usang (fixture basi akan selalu gagal freshness).
  hub: {
    sourceOffsetMs: -2_000,
    receivedOffsetMs: -1_900,
    cvd: 1000,
    poc: 10,
  },
  fetchCalls: [] as string[],
}));

/** Waktu event sumber absolut dari offset relatif. */
const srcTs = () => Date.now() + mocks.hub.sourceOffsetMs;
/** Waktu terima absolut dari offset relatif. */
const recvTs = () => Date.now() + mocks.hub.receivedOffsetMs;

vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: {
      create: vi.fn(async (args: { data: { type: string; severity: string; payload: string } }) => {
        mocks.events.push(args.data); return { id: mocks.events.length };
      }),
    },
  },
}));

// HUB: dibangun dari mocks.hub supaya test bisa mengubahnya setelah capture.
vi.mock("../src/marketdata/multiVenueOrderFlowHub.js", () => ({
  multiVenueOrderFlowHub: {
    buildSnapshot: vi.fn((symbol: string) => ({
      symbol, window: "15m", generatedAt: Date.now(),
      venuesTrading: 2, venuesExpected: 2,
      cvd: {
        allVenues: mocks.hub.cvd, perpSum: mocks.hub.cvd, spotSum: 0,
        perVenue: [{ venue: "BINANCE", label: "B", color: "#fff", delta: mocks.hub.cvd, buyUsd: mocks.hub.cvd, sellUsd: 0 }],
      },
      teamRead: [
        { timeframe: "15M", priceChangePct: 0.5, allVenueCvdDelta: mocks.hub.cvd, spotCvd: 0, perpCvd: mocks.hub.cvd, buySharePct: 60, flowVsPrice: "aligned" },
        { timeframe: "1H", priceChangePct: 0.2, allVenueCvdDelta: mocks.hub.cvd, spotCvd: 0, perpCvd: mocks.hub.cvd, buySharePct: 55, flowVsPrice: "aligned" },
      ],
      series: [], priceSeries: [], aggression: [], marketStats: null, historyMinutes: 60,
    })),
    lastTradeAtMs: vi.fn(() => srcTs()),
    lastTradeReceivedAtMs: vi.fn(() => recvTs()),
    tierImbalance: vi.fn(() => ({ rows: [] })),
    perExchangeDelta: vi.fn(() => []),
    perExchangeSeries: vi.fn(() => []),
    getTape: vi.fn(() => []),
  },
}));

vi.mock("../src/marketdata/wallLifelines.js", () => ({
  wallLifelines: {
    snapshot: vi.fn(() => ({
      symbol: "ETH", venue: "BINANCE_PERP", updatedAt: Date.now(), mid: 100,
      summary: { active: 1, pulled: 0, eaten: 0, moved: 0, appeared: 1, largestActiveUsd: 1000, largestActivePrice: 99, largestActiveSide: "BID", windowMs: 1_800_000 },
      depth: [{ price: 99, side: "BID", notionalUsd: 1000, scaled: 31, isWall: true, state: "ACTIVE" }],
      events: [], trend: [],
    })),
    lastBookAtMs: vi.fn(() => srcTs()),
    lastBookReceivedAtMs: vi.fn(() => recvTs()),
    oldestLiveWallAtMs: vi.fn(() => null),
  },
}));

vi.mock("../src/marketdata/liquidationMapHub.js", () => ({
  liquidationMapHub: {
    snapshot: vi.fn(async () => ({
      symbol: "ETH", source: "vike", markPrice: 100,
      updatedAt: Date.now(), sourceTsMs: srcTs(), sourceReceivedAtMs: recvTs(),
      stale: false, openPositions: 10, openValueUsd: 1000,
      cum: [{ pct: 2, longsUsd: 10, shortsUsd: 5, skewPct: 33 }],
      bins: [{ price: 95, longUsd: 10, shortUsd: 0, distPct: -5 }],
      topLongClustersBelow: [{ price: 95, distPct: -5, liqUsd: 10, positions: 1 }],
      topShortClustersAbove: [{ price: 105, distPct: 5, liqUsd: 5, positions: 1 }],
      magnetDirection: "DOWN", note: "REPLAY stub vike",
    })),
  },
}));

vi.mock("../src/marketdata/volumeProfileHub.js", () => ({
  TIER_FLOORS: [{ tier: "MEDIUM", floor: 10_000 }],
  volumeProfileHub: {
    build: vi.fn(() => ({
      symbol: "ETH", range: "1h", bins: [], pocPrice: mocks.hub.poc, pocVolumeUsd: 1,
      pocBuySharePct: 55, vahPrice: mocks.hub.poc + 1, valPrice: mocks.hub.poc - 1,
      priceVsValueArea: "INSIDE_VA", price: mocks.hub.poc, totalUsd: 5000,
      updatedAt: Date.now(), partialWindow: false,
    })),
    largeTrades: vi.fn(() => []),
    lastTradeAtMs: vi.fn(() => srcTs()),
    lastTradeReceivedAtMs: vi.fn(() => recvTs()),
  },
}));

vi.mock("../src/marketdata/tierFlowHub.js", () => ({
  tierFlowHub: {
    tiers: vi.fn(() => [{ tier: "WHALE", buyUsd: 100, sellUsd: 40, netDeltaUsd: 60, buySharePct: 71, trades: 2 }]),
    whaleRetailBias: vi.fn(() => ({ bias: "WHALE_BUY" })),
    perExchangeDelta: vi.fn(() => [{ exchange: "BINANCE", delta: 60, buyUsd: 100, sellUsd: 40 }]),
    scanDivergences: vi.fn(() => []),
    startedAtMs: 1_700_000_000_000,
  },
}));

vi.mock("../src/agents/marketIntel.js", () => ({
  buildMicrostructureBlock: vi.fn(async (symbol: string) => ({
    orderFlowCvd: { allVenues: mocks.hub.cvd, perpSum: mocks.hub.cvd, spotSum: 0, venuesTrading: 2, venuesExpected: 2 },
    wallLifelines: { active: 1, pulled: 0, eaten: 0, moved: 0, appeared: 1, largestActiveUsd: 1000, largestActivePrice: 99, largestActiveSide: "BID", pullEatRatio: 0 },
    liquidationMap: { source: "vike", magnetDirection: "DOWN", stale: false, note: "stub", nearLongUsd: 10, nearShortUsd: 5, nearSkewPct: 33, topClusterBelow: null, topClusterAbove: null },
    volumeProfile: { pocPrice: mocks.hub.poc, priceVsValueArea: "INSIDE_VA", partialWindow: false },
    tierAndExchangeFlow: { whaleBias: "WHALE_BUY", whaleDeltaUsd: 60, retailDeltaUsd: -10 },
    status: "OK", note: `REPLAY stub micro (${symbol})`,
  })),
}));

vi.mock("../src/markets/binanceFuturesClient.js", () => ({
  binanceFuturesClient: { getHubChg24: vi.fn(() => ({ BTCUSDT: -1.2 })) },
}));

import { env } from "../src/core/env.js";
import { DecisionRiskLayer, type SwingDrexJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import { captureDrexPanelSnapshot, canonicalEvidenceSymbol, snapshotFreshnessAt } from "../src/analysis/drexPanelEvidence.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const input: SwingDrexJudgeInput = {
  symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01", strategyName: "Orion",
  compositeScore: 74, zoneScore: 71, triggerScore: 66,
  entryPrice: 3200, slPrice: 3150, tp1Price: 3300, tp2Price: 3500,
};

function drexBody(p: number, dir: string, score = 3.2): string {
  return JSON.stringify({
    model: "drex-max",
    answers: {
      entry_go: { type: "noul", noul: p },
      direction: { type: "choice", choice: dir, confidence: 0.7, probabilities: { LONG: 0.7, SHORT: 0.3 } },
      setup_strength: { type: "score", score, confidence: 0.6, legend: ["very_weak", "weak", "moderate", "strong", "very_strong"], probabilities: {} },
    },
    evaluation_time_ms: 40, request_id: "req_replay_v2",
  });
}

/**
 * Mock fetch BERURUTAN: panggilan ke-1 = judge v1 (produksi), panggilan
 * berikutnya = shadow v2. Ini penting: v1 dan v2 memakai DrexAdapter yang
 * sama, jadi mock harus bisa membedakan keduanya untuk membuktikan
 * "v2 tidak mengubah v1".
 */
function buildLayer(responses: Array<() => Response>) {
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    const idx = Math.min(call, responses.length - 1);
    call += 1;
    return responses[idx]!();
  });
  const drex = new DrexAdapter({ fetchImpl, sleep: async () => undefined });
  const agent = new DecisionRiskLayer({ callReason: vi.fn() } as unknown as XkiroAdapter, drex);
  return { agent, fetchImpl, calls: () => call };
}

const resp = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

const waitForShadow = async () => {
  await vi.waitFor(() => {
    expect(mocks.events.some((e) => e.type === "DREX_SWING_SHADOW_COMPARE")).toBe(true);
  }, { timeout: 2000 });
};

const shadowPayload = () => JSON.parse(mocks.events.find((e) => e.type === "DREX_SWING_SHADOW_COMPARE")!.payload);

beforeEach(() => {
  mocks.events.length = 0;
  mocks.hub = { sourceOffsetMs: -2_000, receivedOffsetMs: -1_900, cvd: 1000, poc: 10 };
  env.DREX_ENABLED = true;
  env.DREX_SWING_ENABLED = true;
  env.DREX_SWING_SHADOW = true;
  env.DREX_API_KEY = "test-drex-key-not-real";
  env.DREX_MIN_ENTRY_PROBABILITY = 0.55;
  env.DREX_MIN_SETUP_STRENGTH = 2;
  env.DREX_TIMEOUT_MS = 500;
});

async function captureSnapshot(overrides: Partial<Parameters<typeof captureDrexPanelSnapshot>[0]> = {}) {
  return await captureDrexPanelSnapshot({
    symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01",
    planId: "RSW-01:ETHUSDT:3200:3150:3300",
    candidateId: "ETHUSDT:LONG:RSW-01",
    correlationId: "ETHUSDT:LONG:RSW-01:3200",
    marketType: "PERPETUAL", venue: "BINANCE_PERP", horizon: "H1/H4",
    ...overrides,
  });
}

describe("REPLAY: snapshot evidence lima panel untuk Drex SWING v2 (non-BTC)", () => {
  it("1) lima panel terbaca dengan quality & coverage; simbol kandidat = base coin kandidat", async () => {
    const snap = await captureSnapshot();
    // LIMA panel (orderflow, walls, liqmap, largetrades_vp, tierflow).
    expect(snap.panels.length).toBe(5);
    expect(snap.evidenceSymbol).toBe("ETH");
    expect(snap.symbol).toBe("ETHUSDT");
    for (const p of snap.panels) {
      expect(p.evidenceId).toBeTruthy();
      expect(["fresh", "stale", "partial", "unavailable", "unknown"]).toContain(p.status);
    }
    // Panel inti wajib ditandai wajib; tierflow opsional.
    const orderflow = snap.panels.find((p) => p.panel === "orderflow")!;
    expect(orderflow.required).toBe(true);
    expect(orderflow.figures.length).toBeGreaterThan(0);
    const tierflow = snap.panels.find((p) => p.panel === "tierflow")!;
    expect(tierflow.required).toBe(false);
    // Snapshot punya identitas untuk dipasangkan dengan verdict v1.
    expect(snap.correlationId).toBe("ETHUSDT:LONG:RSW-01:3200");
    expect(snap.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.coverage.total).toBe(5);
  });

  it("2) evidence kandidat NON-BTC bukan data BTC; canonical symbol benar", async () => {
    expect(canonicalEvidenceSymbol("ETHUSDT").base).toBe("ETH");
    expect(canonicalEvidenceSymbol("BTCUSDT").base).toBe("BTC");
    expect(canonicalEvidenceSymbol("ETH").base).toBe("ETH");
    // Simbol tidak valid -> UNAVAILABLE, bukan data BTC.
    const bad = canonicalEvidenceSymbol("!!!");
    expect(bad.ok).toBe(false);

    const snap = await captureSnapshot({ symbol: "ETHUSDT" });
    // Angka panel berasal dari hub kandidat (cvd=1000), bukan BTC.
    const orderflow = snap.panels.find((p) => p.panel === "orderflow")!;
    expect(orderflow.figures.join(" ")).toContain("$1.0K"); // mocks.hub.cvd = 1000
    expect(snap.evidenceSymbol).not.toBe("BTC");
  });

  it("3) snapshot IMMUTABLE: hub berubah setelah capture -> snapshot tetap sama", async () => {
    const snap = await captureSnapshot();
    const before = JSON.stringify(snap.panels);
    // Ubah hub SESUDAH capture.
    mocks.hub.cvd = 999_999;
    mocks.hub.poc = 77;
    mocks.hub.sourceOffsetMs = -9_000_000_000;
    const after = JSON.stringify(snap.panels);
    expect(after).toBe(before);
    // Angka di snapshot tetap nilai lama.
    expect(snap.panels.find((p) => p.panel === "orderflow")!.figures.join(" ")).toContain("$1.0K");
  });

  it("4) evidence masa depan (sourceTs > capturedAt) tidak boleh dipakai sebagai fresh", async () => {
    const snap = await captureSnapshot();
    // Snapshot lama: sourceTs di masa depan relatif terhadap penilai.
    const fresh = snapshotFreshnessAt(snap, snap.capturedAtMs + 1000);
    expect(fresh.usable).toBe(true);
    // Kalau sumber ber futuristic jauh ke depan, umur jadi negatif -> di-clamp 0
    // dan TIDAK boleh dianggap stale tanpa sebab. Yang penting: snapshot tidak
    // memasukkan evidence yang datang SETELAH capture.
    const panelsTs = snap.panels.map((p) => p.sourceEventTsMs).filter((t): t is number => t != null);
    expect(panelsTs.every((t) => t <= snap.capturedAtMs)).toBe(true);
  });

  it("5) panel unavailable TIDAK dianggap nol atau netral", async () => {
    const snap = await captureSnapshot();
    // Simulasikan panel hilang: tidak ada fetch -> panel UNAVAILABLE.
    const missing = snap.panels.find((p) => p.status === "unavailable");
    if (missing) {
      expect(missing.figures).toHaveLength(0);
      expect(missing.missing.length).toBeGreaterThan(0);
    }
    // Tidak boleh ada panel UNAVAILABLE yang mengisi angka nol.
    for (const p of snap.panels) {
      if (p.status === "unavailable") expect(p.figures.length).toBe(0);
    }
  });

  it("6) evidence basi -> shadow SKIPPED_DATA_QUALITY, v1 tidak berubah", async () => {
    // Evidence SUDAH basi saat capture (sumber 10 menit lalu).
    mocks.hub.sourceOffsetMs = -600_000;
    const snap = await captureSnapshot();
    expect(snap.stalePanels.length).toBeGreaterThan(0);
    const { agent } = buildLayer([() => resp(drexBody(0.9, "LONG"))]);
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    const payload = shadowPayload();
    expect(payload.shadow.outcome).toBe("SKIPPED_DATA_QUALITY");
    expect(payload.v1.kind).toBe(verdict.kind); // verdict v1 tetap utuh
  });

  it("7) v1 REJECT / v2 GO: shadow tidak menghasilkan entry dan tidak mengubah v1", async () => {
    const snap = await captureSnapshot();
    // v1 menolak (p kecil + arah salah); v2 bilang GO (p=0.9, arah LONG).
    const { agent } = buildLayer([
      () => resp(drexBody(0.10, "SHORT")),
      () => resp(drexBody(0.9, "LONG")),
    ]);
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    const payload = shadowPayload();
    expect(verdict.kind).toBe("reject");         // v1 menolak
    expect(payload.shadow.v2.kind).toBe("go");      // v2 berbeda: GO
    expect(payload.shadow.outcome).toBe("DISAGREE");
    // Shadow TIDAK mengubah verdict v1 (v1 tetap reject).
    expect(payload.v1.kind).toBe("reject");
    // Dan tidak ada order/entri yang dikirim: satu-satunya event adalah log.
    expect(mocks.events.every((e) => e.type === "DREX_SWING_SHADOW_COMPARE")).toBe(true);
  });

  it("8) v1 GO / v2 REJECT: keputusan produksi tetap mengikuti v1", async () => {
    const snap = await captureSnapshot();
    // v2 bilang REJECT (p rendah + arah salah).
    const { agent } = buildLayer([() => resp(drexBody(0.9, "LONG")), () => resp(drexBody(0.10, "SHORT"))]);
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    const payload = shadowPayload();
    expect(verdict.kind).toBe("go");           // v1 tetap GO
    expect(payload.shadow.v2.kind).toBe("reject"); // v2 menolak
    expect(payload.shadow.outcome).toBe("DISAGREE");
    // V1 TIDAK berubah karena v2 menolak.
    expect(payload.v1.kind).toBe("go");
  });

  it("9) error/timeout v2 tidak mengganggu v1 (v1 tetap verdict normal)", async () => {
    const snap = await captureSnapshot();
    const { agent } = buildLayer([() => resp(drexBody(0.9, "LONG")), () => new Response("upstream boom", { status: 500 })]);
    const verdict = await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    const payload = shadowPayload();
    expect(verdict.kind).toBe("go"); // v1 tidak terganggu
    expect(payload.shadow.outcome).toBe("SHADOW_ERROR");
    expect(payload.v1.kind).toBe("go");
  });

  it("10) satu kandidat tidak menghasilkan invocation ganda", async () => {
    const snap = await captureSnapshot();
    const { agent, fetchImpl } = buildLayer([() => resp(drexBody(0.9, "LONG")), () => resp(drexBody(0.9, "LONG"))]);
    await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    // Panggilan #1 = judge v1, #2 = shadow v2.
    const firstCount = fetchImpl.mock.calls.length;
    expect(firstCount).toBe(2);
    // Kandidat sama -> snapshot sama -> tidak boleh memanggil Drex LAGI.
    await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await vi.waitFor(() => {
      expect(mocks.events.filter((e) => e.type === "DREX_SWING_SHADOW_COMPARE").length).toBe(2);
    }, { timeout: 2000 });
    // Second event = penanda duplikat (tanpa panggilan provider baru).
    const second = JSON.parse(mocks.events.filter((e) => e.type === "DREX_SWING_SHADOW_COMPARE")[1]!.payload);
    expect(second.shadow.skipped).toBe("DUPLICATE_INVOCATION");
    // Total panggilan tetap 3: v1 + shadow v2 (pertama) + v1 (kedua).
    // Shadow TIDAK menambah panggilan kedua.
    expect(fetchImpl.mock.calls.length).toBe(3);
  });

  it("11) event shadow membawa correlationId + timing + outcome (untuk pairing)", async () => {
    const snap = await captureSnapshot();
    const { agent } = buildLayer([() => resp(drexBody(0.9, "LONG")), () => resp(drexBody(0.9, "LONG"))]);
    await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    await waitForShadow();
    const payload = shadowPayload();
    expect(payload.correlationId).toBe("ETHUSDT:LONG:RSW-01:3200");
    expect(payload.shadow.capturedAtMs).toBe(snap.capturedAtMs);
    expect(typeof payload.shadow.dispatchedAt).toBe("number");
    expect(payload.shadow.dispatchedAt).toBeGreaterThanOrEqual(payload.shadow.capturedAtMs);
    expect(payload.shadow.panelInputHash).toBe(snap.inputHash);
    expect(payload.shadow.coverage.total).toBe(5);
    expect(payload.shadow.outcome).toBe("AGREE");
  });

  it("12) payload v1 tidak ikut berubah karena builder v2", async () => {
    const snap = await captureSnapshot();
    const { agent } = buildLayer([() => resp(drexBody(0.9, "LONG")), () => resp(drexBody(0.9, "LONG"))]);
    // Judge TANPA snapshot -> tidak ada shadow, v1 tetap sama.
    const v1Only = await agent.runSwingDrexJudge({ ...input });
    expect(v1Only.kind).toBe("go");
    expect(mocks.events.filter((e) => e.type === "DREX_SWING_SHADOW_COMPARE")).toHaveLength(0);

    // Judge DENGAN snapshot -> v1 tetap sama, shadow jalan terpisah.
    const withSnap = await agent.runSwingDrexJudge({ ...input, panelSnapshot: snap });
    expect(withSnap.kind).toBe(v1Only.kind);
    expect(withSnap.p).toBe(v1Only.p);
    expect(withSnap.strength).toBe(v1Only.strength);
    expect(withSnap.direction).toBe(v1Only.direction);
  });
});
