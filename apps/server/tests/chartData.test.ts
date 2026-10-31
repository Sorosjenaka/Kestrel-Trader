// apps/server/tests/chartData.test.ts - Uji endpoint chart data & 4 garis level (FR-31, US-08).
// 25 Okt 2026 (FASE 4): kline ASLI (fetchKlines) — di test di-stub deterministik;
// jalur kegagalan sumber wajib 503 KLINE_SOURCE_UNAVAILABLE, bukan candle buatan.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";

function fixtureKlines(n = 30): number[][] {
  // Bentuk array Binance asli: [openTimeMs, open, high, low, close, ...]
  const out: number[][] = [];
  const t0 = Date.UTC(2026, 9, 25, 10, 0, 0);
  let price = 64000;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = 64000 + i * 10; // monotonik deterministik
    out.push([t0 + i * 60000, o, Math.max(o, c) + 5, Math.min(o, c) - 5, c, 1]);
    price = c;
  }
  return out;
}

describe("FR-31 & US-08: Chart Data & Level Lines", () => {
  // Pastikan tidak ada posisi tersisa dari test lain agar endpoint memakai jalur
  // fallback ilustratif (tanpa posisi), bukan data DB yang bisa stale/duplikat.
  beforeEach(async () => {
    await db.position.deleteMany({});
  });
  afterEach(async () => {
    await db.position.deleteMany({});
    vi.restoreAllMocks();
  });

  it("GET /api/chart/data mengembalikan 4 level (entry, sl, tp1, tp2), klines, dan outlook Bahasa Indonesia", async () => {
    vi.spyOn(binanceFuturesClient, "fetchKlines").mockResolvedValue(fixtureKlines(30) as never);
    const app = createApp();
    const start = Date.now();
    const res = await request(app).get("/api/chart/data?symbol=BTCUSDT").set("x-api-token", "vitest-mutation-token").expect(200);
    const duration = Date.now() - start;

    // AC-08: Tampil <= 2 detik
    expect(duration).toBeLessThanOrEqual(2000);

    expect(res.body.symbol).toBe("BTCUSDT");
    expect(res.body.levels).toBeDefined();
    expect(typeof res.body.levels.entry).toBe("number");
    expect(typeof res.body.levels.sl).toBe("number");
    expect(typeof res.body.levels.tp1).toBe("number");
    expect(typeof res.body.levels.tp2).toBe("number");

    // Tanpa posisi: level ILUSTRATIF dan DITANDAI (bukan disamarkan).
    expect(res.body.levelsSource).toBe("ILLUSTRATIVE_NO_POSITION");
    expect(res.body.klineSource).toContain("binance_futures");

    // Validasi hirarki level untuk LONG default
    expect(res.body.levels.tp2).toBeGreaterThan(res.body.levels.tp1);
    expect(res.body.levels.tp1).toBeGreaterThan(res.body.levels.entry);
    expect(res.body.levels.entry).toBeGreaterThan(res.body.levels.sl);

    // Candlesticks: 30 bar dari sumber, harga sesuai fixture (bukan random)
    expect(Array.isArray(res.body.klines)).toBe(true);
    expect(res.body.klines.length).toBe(30);
    expect(res.body.klines[29].close).toBe(64000 + 29 * 10);
    expect(res.body.currentPrice).toBe(64000 + 29 * 10);
    // timestamp asli bursa (openTime / 1000)
    expect(res.body.klines[0].time).toBe(Math.floor(Date.UTC(2026, 9, 25, 10, 0, 0) / 1000));

    // Outlook Bahasa Indonesia
    expect(typeof res.body.outlook).toBe("string");
    expect(res.body.outlook.length).toBeGreaterThan(10);
  });

  it("sumber kline gagal -> 503 KLINE_SOURCE_UNAVAILABLE (bukan angka buatan)", async () => {
    vi.spyOn(binanceFuturesClient, "fetchKlines").mockRejectedValue(new Error("network down") as never);
    const app = createApp();
    const res = await request(app).get("/api/chart/data?symbol=BTCUSDT").set("x-api-token", "vitest-mutation-token").expect(503);
    expect(res.body.error).toBe("KLINE_SOURCE_UNAVAILABLE");
    expect(res.body.klines).toBeUndefined();
    expect(res.body.currentPrice).toBeUndefined();
  });

  it("sumber kline kosong -> 503, jangan mengarang candle", async () => {
    vi.spyOn(binanceFuturesClient, "fetchKlines").mockResolvedValue([] as never);
    const app = createApp();
    const res = await request(app).get("/api/chart/data?symbol=BTCUSDT").set("x-api-token", "vitest-mutation-token").expect(503);
    expect(res.body.error).toBe("KLINE_SOURCE_UNAVAILABLE");
  });
});
