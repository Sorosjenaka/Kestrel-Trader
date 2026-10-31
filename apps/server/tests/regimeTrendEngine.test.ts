import { describe, expect, it } from "vitest";
import {
  analyzePairRegimeTrend,
  calculateAtr,
  calculateAtrSeries,
  calculateZeroLagTrend,
  classifyRegimeSmoothed,
  classifySingleBarRegime,
  evaluateVolatilityShield,
  SHIELD_REASON_ATR_SPIKE,
  SHIELD_REASON_SPREAD_HIGH,
} from "../src/engines/regimeTrendEngine.js";
import { Bar } from "../src/universe/eligibility.js";

function makeSyntheticBars(
  count: number,
  basePrice = 100,
  step = 0.5,
  noise = 0.2
): Bar[] {
  const bars: Bar[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    price += step;
    bars.push({
      openTime: 1700000000000 + i * 60000,
      open: price - noise / 2,
      high: price + noise,
      low: price - noise,
      close: price + noise / 2,
      volume: 1000,
    });
  }
  return bars;
}

describe("T-1.7 Engine Regime, Trend & Volatility Shield (FR-08, FR-11)", () => {
  describe("Kalkulasi ATR Series & Indikator", () => {
    it("mengembalikan deret kosong dan null bila data kline kurang dari period+1", () => {
      const bars = makeSyntheticBars(10);
      expect(calculateAtrSeries(bars, 14)).toEqual([]);
      expect(calculateAtr(bars, 14)).toBeNull();
    });

    it("menghitung deret ATR dengan Wilder's smoothing untuk data memadai", () => {
      const bars = makeSyntheticBars(40, 100, 0, 1.0); // range = 2.0
      const series = calculateAtrSeries(bars, 14);
      expect(series.length).toBe(40 - 14);
      const lastAtr = calculateAtr(bars, 14);
      expect(lastAtr).toBeGreaterThan(0);
      expect(lastAtr).toBeCloseTo(2.0, 1);
    });
  });

  describe("FR-11: Volatility Shield (ATR Spike > 2.0x & Spread > 0.15%)", () => {
    it("tidak aktif pada volatilitas dan spread normal", () => {
      // 90 bar dengan range seragam 1.0
      const bars = makeSyntheticBars(90, 100, 0, 0.5);
      const shield = evaluateVolatilityShield(bars, 0.0005); // spread 0.05%
      expect(shield.active).toBe(false);
      expect(shield.blockNewSignals).toBe(false);
      expect(shield.reasons).toEqual([]);
      expect(shield.atrRatio).toBeCloseTo(1.0, 1);
    });

    it("aktif memblokir sinyal saat lonjakan ATR > 2.0x", () => {
      // 80 bar baseline range 0.5, lalu 5 bar lonjakan tajam range 3.0
      const baseline = makeSyntheticBars(80, 100, 0, 0.25);
      const spike = makeSyntheticBars(5, 100, 2.0, 3.0);
      const bars = [...baseline, ...spike];

      const shield = evaluateVolatilityShield(bars, 0.0005);
      expect(shield.active).toBe(true);
      expect(shield.blockNewSignals).toBe(true);
      expect(shield.reasons).toContain(SHIELD_REASON_ATR_SPIKE);
      expect(shield.atrRatio).toBeGreaterThan(2.0);
    });

    it("aktif saat spread melebihi batas 0.15% (0.0015)", () => {
      const bars = makeSyntheticBars(90, 100, 0, 0.5);
      const shield = evaluateVolatilityShield(bars, 0.002); // spread 0.20%
      expect(shield.active).toBe(true);
      expect(shield.blockNewSignals).toBe(true);
      expect(shield.reasons).toContain(SHIELD_REASON_SPREAD_HIGH);
    });

    it("merekam kedua alasan saat lonjakan ATR dan pelebaran spread terjadi bersamaan", () => {
      const baseline = makeSyntheticBars(80, 100, 0, 0.25);
      const spike = makeSyntheticBars(5, 100, 2.0, 3.0);
      const bars = [...baseline, ...spike];

      const shield = evaluateVolatilityShield(bars, 0.0025);
      expect(shield.active).toBe(true);
      expect(shield.reasons).toContain(SHIELD_REASON_ATR_SPIKE);
      expect(shield.reasons).toContain(SHIELD_REASON_SPREAD_HIGH);
    });
  });

  describe("FR-08: Regime Engine dengan Smoothing Mayoritas 5 Bar", () => {
    it("mengembalikan UNCERTAIN bila data bar kurang dari 28", () => {
      const bars = makeSyntheticBars(20);
      const res = classifyRegimeSmoothed(bars);
      expect(res.regime).toBe("UNCERTAIN");
      expect(res.confidence).toBe(1.0);
    });

    it("mengklasifikasi TRENDING pada pergerakan terarah konsisten", () => {
      // 50 bar tren naik terarah kuat: step 1.0, noise kecil 0.05
      const bars = makeSyntheticBars(50, 100, 1.0, 0.05);
      const res = classifyRegimeSmoothed(bars);
      expect(res.regime).toBe("TRENDING");
      expect(res.voteCounts.TRENDING).toBeGreaterThanOrEqual(3);
    });

    it("mengklasifikasi RANGING pada pergerakan oscillating / flat", () => {
      // Bar mendatar tanpa kenaikan netto (step 0, noise kecil)
      const bars: Bar[] = [];
      for (let i = 0; i < 45; i++) {
        const offset = (i % 2 === 0 ? 0.2 : -0.2);
        bars.push({
          openTime: 1700000000000 + i * 60000,
          open: 100 + offset,
          high: 100.5,
          low: 99.5,
          close: 100 - offset,
          volume: 1000,
        });
      }
      const res = classifyRegimeSmoothed(bars);
      expect(res.regime).toBe("RANGING");
      expect(res.voteCounts.RANGING).toBeGreaterThanOrEqual(3);
    });

    it("mengklasifikasi VOLATILE ketika terjadi lonjakan tajam ATR", () => {
      const baseline = makeSyntheticBars(80, 100, 0, 0.25);
      const spike = makeSyntheticBars(10, 100, 2.0, 3.5);
      const bars = [...baseline, ...spike];

      const res = classifyRegimeSmoothed(bars);
      expect(res.regime).toBe("VOLATILE");
    });

    it("smoothing mayoritas 5 bar meredam 1-2 bar noise acak", () => {
      // 50 bar tren naik kuat
      const bars = makeSyntheticBars(50, 100, 1.0, 0.05);
      const smoothed = classifyRegimeSmoothed(bars);

      // Meskipun ada variasi suara, mayoritas tetap menentukan hasil akhir
      expect(smoothed.rawRegimes.length).toBe(5);
      expect(smoothed.voteCounts[smoothed.regime]).toBeGreaterThanOrEqual(3);
    });
  });

  describe("FR-11: Zero-Lag Trend Engine & Flip Hanya di Luar Shield", () => {
    it("menghasilkan ZLEMA dan shield envelope yang valid", () => {
      const bars = makeSyntheticBars(50, 100, 0.5, 0.2);
      const trend = calculateZeroLagTrend(bars);

      expect(trend.zlema).toBeGreaterThan(0);
      expect(trend.upperShield).toBeGreaterThan(trend.zlema);
      expect(trend.lowerShield).toBeLessThan(trend.zlema);
      expect(trend.trendScore).toBeGreaterThanOrEqual(0);
      expect(trend.trendScore).toBeLessThanOrEqual(100);
    });

    it("arah BULLISH bertahan dan TIDAK flip ketika close masih di dalam shield", () => {
      const bars = makeSyntheticBars(40, 100, 0.5, 0.2);
      const currentTrend = calculateZeroLagTrend(bars, { previousDirection: "BULLISH" });
      const lastBar = bars[bars.length - 1]!;

      // Modifikasi close bar terakhir agar berada tepat di antara lowerShield dan upperShield
      lastBar.close = currentTrend.zlema;

      const testInside = calculateZeroLagTrend(bars, { previousDirection: "BULLISH" });
      expect(testInside.direction).toBe("BULLISH"); // Mempertahankan arah sebelumnya
      expect(testInside.isFlip).toBe(false); // TIDAK flip di dalam shield
    });

    it("flip ke BEARISH hanya ketika close menembus di bawah lowerShield", () => {
      const bars = makeSyntheticBars(40, 100, 0.5, 0.2);
      const initial = calculateZeroLagTrend(bars, { previousDirection: "BULLISH" });

      // Turunkan close menembus di bawah lowerShield
      const lastBar = bars[bars.length - 1]!;
      lastBar.close = initial.lowerShield - 1.0;

      const flipped = calculateZeroLagTrend(bars, { previousDirection: "BULLISH" });
      expect(flipped.direction).toBe("BEARISH");
      expect(flipped.isFlip).toBe(true);
    });

    it("flip ke BULLISH hanya ketika close menembus di atas upperShield", () => {
      const bars = makeSyntheticBars(40, 100, -0.5, 0.2); // tren turun
      const initial = calculateZeroLagTrend(bars, { previousDirection: "BEARISH" });

      // Naikkan close menembus di atas upperShield
      const lastBar = bars[bars.length - 1]!;
      lastBar.close = initial.upperShield + 1.0;

      const flipped = calculateZeroLagTrend(bars, { previousDirection: "BEARISH" });
      expect(flipped.direction).toBe("BULLISH");
      expect(flipped.isFlip).toBe(true);
    });
  });

  describe("analyzePairRegimeTrend (Analisis Komprehensif FR-08 & FR-11)", () => {
    it("menghasilkan struktur analisis pair lengkap", () => {
      const bars = makeSyntheticBars(50, 100, 0.8, 0.1);
      const res = analyzePairRegimeTrend("BTCUSDT", bars, 0.0004);

      expect(res.symbol).toBe("BTCUSDT");
      expect(["TRENDING", "RANGING", "VOLATILE", "UNCERTAIN"]).toContain(res.regime);
      expect(res.regimeClassification).toHaveProperty("confidence");
      expect(res.trend).toHaveProperty("zlema");
      expect(res.volatilityShield).toHaveProperty("active");
    });
  });

});
