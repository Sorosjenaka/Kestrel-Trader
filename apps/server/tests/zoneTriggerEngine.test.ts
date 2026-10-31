import { describe, it, expect } from "vitest";
import { Bar } from "../src/universe/eligibility.js";
import {
  detectFairValueGaps,
  detectOrderBlocks,
  detectSupplyDemandZones,
  scoreZone,
  evaluateSqueezeTrigger,
  analyzePairZonesAndTrigger,
  DetectedZone,
} from "../src/engines/zoneTriggerEngine.js";

function makeSyntheticBars(
  count: number,
  startPrice = 100,
  step = 0.5,
  noise = 0.1
): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  const baseTime = 1700000000000;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step + (i % 2 === 0 ? noise : -noise);
    const high = Math.max(open, close) + noise * 1.5;
    const low = Math.min(open, close) - noise * 1.5;
    const volume = 1000 + i * 50;

    bars.push({
      openTime: baseTime + i * 60000,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume,
    });

    price = close;
  }
  return bars;
}

describe("Engine Zona SMC/SnD (FR-09) & Trigger Squeeze (FR-10)", () => {
  describe("FR-09: Deteksi Fair Value Gap (FVG)", () => {
    it("mendeteksi Bullish FVG ketika bar 3 low > bar 1 high", () => {
      const bars: Bar[] = [
        { openTime: 1, open: 100, high: 102, low: 99, close: 101, volume: 100 },
        { openTime: 2, open: 101, high: 108, low: 101, close: 107, volume: 500 },
        { openTime: 3, open: 107, high: 110, low: 104, close: 109, volume: 200 },
      ];

      const fvgs = detectFairValueGaps(bars);
      expect(fvgs.length).toBe(1);
      expect(fvgs[0]!.side).toBe("BULLISH");
      expect(fvgs[0]!.bottom).toBe(102);
      expect(fvgs[0]!.top).toBe(104);
    });

    it("mendeteksi Bearish FVG ketika bar 3 high < bar 1 low", () => {
      const bars: Bar[] = [
        { openTime: 1, open: 100, high: 101, low: 98, close: 99, volume: 100 },
        { openTime: 2, open: 99, high: 99, low: 90, close: 91, volume: 500 },
        { openTime: 3, open: 91, high: 95, low: 89, close: 93, volume: 200 },
      ];

      const fvgs = detectFairValueGaps(bars);
      expect(fvgs.length).toBe(1);
      expect(fvgs[0]!.side).toBe("BEARISH");
      expect(fvgs[0]!.top).toBe(98);
      expect(fvgs[0]!.bottom).toBe(95);
    });
  });

  describe("FR-09: Deteksi Order Block (OB) & SnD", () => {
    it("mendeteksi Bullish Order Block sebelum ekspansi bullish kuat", () => {
      const bars: Bar[] = [
        { openTime: 1, open: 100, high: 101, low: 99, close: 100, volume: 100 },
        { openTime: 2, open: 100, high: 100.5, low: 98, close: 98.5, volume: 150 },
        { openTime: 3, open: 98.5, high: 105, low: 98.5, close: 104.5, volume: 800 },
        { openTime: 4, open: 104.5, high: 106, low: 104, close: 105.5, volume: 200 },
        { openTime: 5, open: 105.5, high: 107, low: 105, close: 106.5, volume: 200 },
      ];

      const obs = detectOrderBlocks(bars, 1.5);
      expect(obs.length).toBeGreaterThanOrEqual(1);
      const bullOb = obs.find((o) => o.side === "BULLISH");
      expect(bullOb).toBeDefined();
      expect(bullOb?.top).toBe(100);
      expect(bullOb?.bottom).toBe(98);
    });

    it("mendeteksi Supply & Demand zones", () => {
      const bars: Bar[] = [
        { openTime: 1, open: 100, high: 101, low: 99, close: 100, volume: 100 },
        { openTime: 2, open: 100.1, high: 100.3, low: 99.8, close: 100.2, volume: 100 },
        { openTime: 3, open: 100.2, high: 106, low: 100.2, close: 105.8, volume: 900 },
        { openTime: 4, open: 105.8, high: 107, low: 105.5, close: 106.5, volume: 200 },
        { openTime: 5, open: 106.5, high: 108, low: 106, close: 107.5, volume: 200 },
      ];

      const snds = detectSupplyDemandZones(bars, 1.0);
      expect(snds.length).toBeGreaterThanOrEqual(1);
      const demand = snds.find((s) => s.side === "BULLISH");
      expect(demand).toBeDefined();
    });
  });

  describe("FR-09: Skoring 5 Faktor & Aturan Usable (skor >= 50)", () => {
    it("zona dengan skor >= 50 berstatus usable: true", () => {
      const bars = makeSyntheticBars(30, 100, 1.0, 0.1);
      const testZone: DetectedZone = {
        id: "test_high_score",
        type: "OB",
        side: "BULLISH",
        top: 102,
        bottom: 100,
        mid: 101,
        barIndex: 5,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      };

      const scored = scoreZone(testZone, bars, 1.0, "BULLISH");
      expect(scored.score).toBeGreaterThanOrEqual(50);
      expect(scored.usable).toBe(true);
    });

    it("zona usang / melawan tren dengan skor < 50 ditolak (usable: false)", () => {
      const bars = makeSyntheticBars(30, 100, 1.0, 0.1);
      const testZone: DetectedZone = {
        id: "test_low_score",
        type: "SUPPLY",
        side: "BEARISH",
        top: 108,
        bottom: 106,
        mid: 107,
        barIndex: 2,
        score: 0,
        usable: false,
        factors: { impulse: 0, freshness: 0, structureBreak: 0, fvgConfluence: 0, trendAlign: 0 },
      };

      const scored = scoreZone(testZone, bars, 1.0, "BULLISH");
      expect(scored.score).toBeLessThan(50);
      expect(scored.usable).toBe(false); // FR-09: skor < 50 TIDAK dipakai sebagai dasar entry
    });
  });

  describe("FR-10: Trigger Engine Squeeze Release (BB di dalam KC)", () => {
    it("mendeteksi status kompresi saat Bollinger Bands di dalam Keltner Channels", () => {
      const bars: Bar[] = [];
      for (let i = 0; i < 30; i++) {
        bars.push({
          openTime: 1700000000000 + i * 60000,
          open: 100,
          high: 100.1,
          low: 99.9,
          close: 100.05,
          volume: 500,
        });
      }

      const res = evaluateSqueezeTrigger(bars);
      expect(res.squeezeOn).toBe(true);
      expect(res.bbUpper).toBeLessThan(res.kcUpper);
      expect(res.bbLower).toBeGreaterThan(res.kcLower);
    });

    it("mendeteksi Squeeze Release saat volatilitas meledak keluar dari saluran", () => {
      const bars: Bar[] = [];
      for (let i = 0; i < 25; i++) {
        bars.push({
          openTime: 1700000000000 + i * 60000,
          open: 100,
          high: 100.08,
          low: 99.92,
          close: 100.01,
          volume: 500,
        });
      }
      bars.push({
        openTime: 1700000000000 + 25 * 60000,
        open: 100.01,
        high: 105.0,
        low: 100.0,
        close: 104.8,
        volume: 5000,
      });

      const res = evaluateSqueezeTrigger(bars);
      expect(res.squeezeRelease).toBe(true);
      expect(res.direction).toBe("LONG");
      expect(res.expectedDistanceAtr).toBeGreaterThan(0);
      expect(res.expectedTargetPrice).toBeGreaterThan(104.8);
      expect(res.triggerScore).toBeGreaterThanOrEqual(75);
    });
  });

  describe("analyzePairZonesAndTrigger (Integrasi FR-09 & FR-10)", () => {
    it("menghasilkan struktur hasil lengkap dengan usableZones dan trigger", () => {
      const bars = makeSyntheticBars(40, 100, 0.5, 0.2);
      const res = analyzePairZonesAndTrigger("BTCUSDT", bars, { trendDirection: "BULLISH" });

      expect(res.symbol).toBe("BTCUSDT");
      expect(Array.isArray(res.allZones)).toBe(true);
      expect(Array.isArray(res.usableZones)).toBe(true);
      expect(res.trigger).toHaveProperty("squeezeOn");
      expect(res.trigger).toHaveProperty("triggerScore");
    });
  });

});
