// apps/server/tests/drexVision.test.ts - Drex vision (24 Okt 2026):
// (a) payload request berisi `images` saat flag ON,
// (b) TIDAK ada `images` saat flag OFF (default produksi),
// (c) cache render dipakai ulang untuk (symbol,timeframe,lastBarTime) yang sama,
// (d) renderer PNG pure-Node menghasilkan PNG valid.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/core/env.js";
import { DrexAdapter, type DrexQuestions } from "../src/agents/drexAdapter.js";
import { prepareDrexVisionImage, drexVisionEnabled } from "../src/agents/drexVision.js";
import { drexChartCache, drexChartCacheKey, renderChartPng, type DrexChartBar } from "../src/agents/drexChart.js";

const FAKE_KEY = "test-drex-key-not-real";
const QUESTIONS: DrexQuestions = {
  entry_go: { type: "noul", instructions: "Should this setup be executed?", criteria: { true: "edge", false: "no edge" } },
  direction: { type: "choice", instructions: "Which direction?", criteria: { LONG: "up", SHORT: "down" } },
  setup_strength: { type: "score", instructions: "How strong?", criteria: ["very_weak", "weak", "moderate", "strong", "very_strong"] },
};

const OK_BODY = JSON.stringify({
  model: "drex-max",
  answers: {
    entry_go: { type: "noul", noul: 0.63 },
    direction: { type: "choice", choice: "LONG", confidence: 0.71 },
    setup_strength: { type: "score", score: 3.2, confidence: 0.66 },
  },
  usage: { input_tokens: 127, image_tokens: 266 },
  request_id: "req_vision_1",
});

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function adapterWith(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return { adapter: new DrexAdapter({ fetchImpl, sleep: async () => undefined }), calls, fetchImpl };
}

function bars(n: number, base = 100): DrexChartBar[] {
  const out: DrexChartBar[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = open + (i % 3 === 0 ? 1.5 : -0.8);
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    out.push({ openTime: 1_760_000_000_000 + i * 3_600_000, open, high, low, close, volume: 100 });
    p = close;
  }
  return out;
}

beforeEach(() => {
  env.DREX_ENABLED = true;
  env.DREX_API_KEY = FAKE_KEY;
  env.DREX_BASE_URL = "https://drex.nace.ai";
  env.DREX_MODEL = "drex-max";
  env.DREX_TIMEOUT_MS = 500;
  env.DREX_VISION_ENABLED = false;
  env.DREX_VISION_MAX_BARS = 120;
  env.DREX_VISION_TIMEFRAME = "1h";
  drexChartCache.reset();
});

describe("renderer chart PNG (pure-Node)", () => {
  it("menghasilkan PNG valid (signature + IHDR) dari bar OHLC", () => {
    const png = renderChartPng(bars(60), { symbol: "BTCUSDT", timeframe: "1h", maxBars: 60 });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(20)).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(500);
  });

  it("gagal fail-closed bila data bar tidak cukup", () => {
    expect(() => renderChartPng([], { symbol: "X", timeframe: "1h" })).toThrow();
    expect(() => renderChartPng(bars(1), { symbol: "X", timeframe: "1h" })).toThrow();
  });
});

describe("Drex vision — gate flag", () => {
  it("flag OFF (default) -> TIDAK ada field images di request body", async () => {
    env.DREX_VISION_ENABLED = false;
    const { adapter, calls } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const res = await adapter.evaluate({ symbol: "BTCUSDT" }, QUESTIONS, { images: ["AAAA"] });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toBeUndefined();
    expect(Object.keys(body)).not.toContain("images");
  });

  it("flag OFF -> prepareDrexVisionImage tidak menghasilkan gambar", () => {
    env.DREX_VISION_ENABLED = false;
    expect(drexVisionEnabled()).toBe(false);
    const r = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: bars(60) });
    expect(r.image).toBeNull();
    expect(r.reason).toBe("DREX_VISION_DISABLED");
  });

  it("flag ON -> payload request berisi field images berisi base64 PNG", async () => {
    env.DREX_VISION_ENABLED = true;
    const { adapter, calls } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const vision = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: bars(60) });
    expect(vision.image).toBeTruthy();
    const res = await adapter.evaluate({ symbol: "BTCUSDT" }, QUESTIONS, { images: [vision.image!] });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images).toHaveLength(1);
    expect(typeof body.images[0]).toBe("string");
    // Isinya harus PNG base64 yang bisa didekode jadi PNG.
    const decoded = Buffer.from(body.images[0], "base64");
    expect(decoded.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(decoded.length).toBeGreaterThan(500);
  });

  it("flag ON tapi model bukan drex-max -> gambar TIDAK dikirim (drex-v1.5 tolak 422)", async () => {
    env.DREX_VISION_ENABLED = true;
    env.DREX_MODEL = "drex-v1.5";
    const { adapter, calls } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const vision = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: bars(60) });
    await adapter.evaluate({ symbol: "BTCUSDT" }, QUESTIONS, { images: [vision.image!] });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toBeUndefined();
  });

  it("body melebihi 1 MiB -> gambar dibuang, request tetap terkirim (fail-open)", async () => {
    env.DREX_VISION_ENABLED = true;
    const { adapter, calls } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const huge = "A".repeat(1024 * 1024 + 100);
    const res = await adapter.evaluate({ symbol: "BTCUSDT" }, QUESTIONS, { images: [huge] });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toBeUndefined();
    expect(body.state).toEqual({ symbol: "BTCUSDT" });
  });
});

describe("Drex vision — cache render", () => {
  it("render kedua untuk bar yang sama memakai cache (tidak render ulang)", () => {
    env.DREX_VISION_ENABLED = true;
    const series = bars(60);
    const first = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: series });
    expect(first.image).toBeTruthy();
    expect(first.cached).toBe(false);
    const second = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: series });
    expect(second.image).toBe(first.image);
    expect(second.cached).toBe(true);
    const stats = drexChartCache.stats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it("bar baru (lastBarTime berbeda) -> render ulang, bukan cache lama", () => {
    env.DREX_VISION_ENABLED = true;
    const series = bars(60);
    const a = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: series });
    const next = [...series.slice(1), { ...series[series.length - 1]!, openTime: series[series.length - 1]!.openTime + 3_600_000 }];
    const b = prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: next });
    expect(b.cached).toBe(false);
    expect(b.image).not.toBe(a.image);
  });

  it("kunci cache membedakan simbol dan timeframe", () => {
    const k1 = drexChartCacheKey("btcusdt", "1h", 1000);
    const k2 = drexChartCacheKey("BTCUSDT", "4h", 1000);
    const k3 = drexChartCacheKey("BTCUSDT", "1h", 2000);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toBe("BTCUSDT|1h|1000");
  });

  it("flag OFF -> tidak ada render sama sekali (cache tetap kosong)", () => {
    env.DREX_VISION_ENABLED = false;
    prepareDrexVisionImage({ symbol: "BTCUSDT", timeframe: "1h", bars: bars(60) });
    expect(drexChartCache.stats().size).toBe(0);
  });
});
