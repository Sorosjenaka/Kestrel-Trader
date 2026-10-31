// apps/server/tests/marketsService.test.ts - Unit test Top 20 Gainer/Loser (FR-30, NFR-06, US-09).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { MarketsService, DEFAULT_MIN_VOLUME_USD } from "../src/markets/marketsService.js";
import { createApp } from "../src/app.js";

describe("FR-30 & US-09: Markets & Top 20 Mover Engine", () => {
  it("mengembalikan default 20 gainers dan 20 losers dengan volume strict > $7M", () => {
    const service = new MarketsService();
    const result = service.getTopMovers();

    expect(result.gainers.length).toBeLessThanOrEqual(20);
    expect(result.losers.length).toBeLessThanOrEqual(20);
    expect(result.gainers.length).toBe(20);
    expect(result.losers.length).toBe(20);

    // Verifikasi semua item memenuhi volume strict-greater saat all=false
    for (const g of result.gainers) {
      expect(g.volume24hUsd).toBeGreaterThan(DEFAULT_MIN_VOLUME_USD);
    }
    for (const l of result.losers) {
      expect(l.volume24hUsd).toBeGreaterThan(DEFAULT_MIN_VOLUME_USD);
    }

    // Verifikasi urutan gainers (descending)
    for (let i = 0; i < result.gainers.length - 1; i++) {
      expect(result.gainers[i].chg24hPct).toBeGreaterThanOrEqual(result.gainers[i + 1].chg24hPct);
    }

    // Verifikasi urutan losers (ascending)
    for (let i = 0; i < result.losers.length - 1; i++) {
      expect(result.losers[i].chg24hPct).toBeLessThanOrEqual(result.losers[i + 1].chg24hPct);
    }
  });

  it("menyertakan koin volume <= $7M jika toggle all=true", () => {
    const service = new MarketsService();
    const defaultRes = service.getTopMovers({ all: false });
    const allRes = service.getTopMovers({ all: true });

    expect(allRes.filteredUniverse).toBeGreaterThan(defaultRes.filteredUniverse);

    const hasLowVol = allRes.gainers.some((g) => g.volume24hUsd <= DEFAULT_MIN_VOLUME_USD);
    expect(hasLowVol).toBe(true);
  });

  it("volume tepat $7M ditolak, sedangkan $7M+1 eligible", () => {
    const service = new MarketsService({
      minVolumeUsd: 7_000_000,
      initialTickers: [
        { symbol: "BOUNDARYUSDT", lastPrice: 1, priceChangePercent: 2, quoteVolume: 7_000_000 },
        { symbol: "ABOVEUSDT", lastPrice: 1, priceChangePercent: 3, quoteVolume: 7_000_001 },
      ],
    });
    expect(service.getTicker("BOUNDARYUSDT")?.eligible).toBe(false);
    expect(service.getTicker("ABOVEUSDT")?.eligible).toBe(true);
    expect(service.getTopMovers().gainers.map((item) => item.symbol)).toEqual(["ABOVEUSDT"]);
  });

  it("menghormati kustom limit pemotongan data", () => {
    const service = new MarketsService();
    const result = service.getTopMovers({ limit: 5 });

    expect(result.gainers.length).toBe(5);
    expect(result.losers.length).toBe(5);
    expect(result.limit).toBe(5);
  });

  it("memvalidasi kesegaran data ticker <= 60 detik (FR-30, NFR-06)", () => {
    const service = new MarketsService();
    expect(service.isFresh(60_000)).toBe(true);

    const now = Date.now();
    expect(service.isFresh(60_000, now + 30_000)).toBe(true);
    expect(service.isFresh(60_000, now + 65_000)).toBe(false);
  });
});

describe("REST Endpoints Markets (Schema.md 2.1)", () => {
  const app = createApp();

  it("GET /api/markets/top mengembalikan struktur TopMover 20 gainers & losers", async () => {
    const res = await request(app).get("/api/markets/top").set("x-api-token", "vitest-mutation-token");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("gainers");
    expect(res.body).toHaveProperty("losers");
    expect(res.body).toHaveProperty("refreshedAt");
    expect(res.body.gainers.length).toBe(20);
    expect(res.body.losers.length).toBe(20);

    const first = res.body.gainers[0];
    expect(first).toHaveProperty("symbol");
    expect(first).toHaveProperty("price");
    expect(first).toHaveProperty("chg24hPct");
    expect(first).toHaveProperty("volume24hUsd");
    expect(first).toHaveProperty("regime");
    expect(first).toHaveProperty("eligible");
  });

  it("GET /api/markets/top?limit=10&all=true mengembalikan batas 10", async () => {
    const res = await request(app).get("/api/markets/top?limit=10&all=true").set("x-api-token", "vitest-mutation-token");
    expect(res.status).toBe(200);
    expect(res.body.gainers.length).toBe(10);
    expect(res.body.losers.length).toBe(10);
    expect(res.body.all).toBe(true);
  });
});
