// apps/server/tests/eligibility.test.ts - uji OFFLINE Filter Volume & Anti-Sideway (FR-03, FR-04, US-04).
import { describe, expect, it } from "vitest";
import {
  calculateAdx,
  calculateChoppiness,
  calculateTrueRange,
  evaluateEligibility,
  type Bar,
  type EligibilityDbAdapter,
  type EligibilityInput,
  REASON_ADX_LOW,
  REASON_BLACKLISTED,
  REASON_CHOP_HIGH,
  REASON_INSUFFICIENT_KLINES,
  REASON_VOLUME_LOW,
} from "../src/universe/eligibility.js";

function makeTrendingBars(count: number, startPrice = 100, step = 2): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + step;
    const high = close + 0.5;
    const low = open - 0.5;
    bars.push({
      openTime: i * 60_000,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
    price = close;
  }
  return bars;
}

function makeChoppyBars(count: number, center = 100): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const isEven = i % 2 === 0;
    const open = isEven ? center - 1 : center + 1;
    const close = isEven ? center + 1 : center - 1;
    const high = center + 2;
    const low = center - 2;
    bars.push({
      openTime: i * 60_000,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
  }
  return bars;
}

function makeFlatBars(count: number, price = 100): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: i * 60_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }));
}

describe("calculateTrueRange", () => {
  it("tanpa prevClose memakai high - low", () => {
    expect(calculateTrueRange(110, 100)).toBe(10);
  });

  it("gap up: high - prevClose lebih besar dari high - low", () => {
    expect(calculateTrueRange(120, 115, 100)).toBe(20);
  });

  it("gap down: prevClose - low lebih besar dari high - low", () => {
    expect(calculateTrueRange(95, 90, 105)).toBe(15);
  });
});

describe("calculateChoppiness (FR-04)", () => {
  it("kurang dari 14 bar mengembalikan null", () => {
    const bars = makeTrendingBars(10);
    expect(calculateChoppiness(bars, 14)).toBeNull();
  });

  it("flatline range nol menghasilkan CHOP 100 (maksimal sideway)", () => {
    const bars = makeFlatBars(20);
    expect(calculateChoppiness(bars, 14)).toBe(100);
  });

  it("tren kuat searah menghasilkan CHOP rendah (< 38.2, lolos < 58.3)", () => {
    const bars = makeTrendingBars(20, 100, 5);
    const chop = calculateChoppiness(bars, 14);
    expect(chop).not.toBeNull();
    expect(chop!).toBeLessThan(58.3);
  });

  it("osilasi ketat / choppy bolak-balik menghasilkan CHOP tinggi (>= 58.3)", () => {
    const bars = makeChoppyBars(20, 100);
    const chop = calculateChoppiness(bars, 14);
    expect(chop).not.toBeNull();
    expect(chop!).toBeGreaterThanOrEqual(58.3);
  });
});

describe("calculateAdx (FR-04)", () => {
  it("kurang dari 28 bar mengembalikan null", () => {
    const bars = makeTrendingBars(20);
    expect(calculateAdx(bars, 14)).toBeNull();
  });

  it("tren naik kuat (40 bar) menghasilkan ADX >= 20 dan plusDi > minusDi", () => {
    const bars = makeTrendingBars(40, 100, 3);
    const res = calculateAdx(bars, 14);
    expect(res).not.toBeNull();
    expect(res!.adx).toBeGreaterThanOrEqual(20);
    expect(res!.plusDi).toBeGreaterThan(res!.minusDi);
  });

  it("osilasi choppy bolak-balik menghasilkan ADX rendah (< 20)", () => {
    const bars = makeChoppyBars(40, 100);
    const res = calculateAdx(bars, 14);
    expect(res).not.toBeNull();
    expect(res!.adx).toBeLessThan(20);
  });
});

describe("evaluateEligibility (FR-03, FR-04, US-04)", () => {
  it("pair volume $20jt + tren kuat -> eligible = true", () => {
    const trending = makeTrendingBars(40, 100, 4);
    const input: EligibilityInput = {
      symbol: "BTCUSDT",
      volume24hUsd: 25_000_000,
      klines: trending,
    };
    const res = evaluateEligibility(input, { minVolume24hUsd: 7_000_000 });
    expect(res.eligible).toBe(true);
    expect(res.reasons).toEqual([]);
    expect(res.primaryReason).toBeNull();
    expect(res.metrics.volume24hUsd).toBe(25_000_000);
    expect(res.metrics.choppiness).not.toBeNull();
    expect(res.metrics.choppiness!).toBeLessThan(58.3);
    expect(res.metrics.adx).not.toBeNull();
    expect(res.metrics.adx!).toBeGreaterThanOrEqual(20);
  });

  it("FR-03: volume <= $7jt ditolak dengan VOLUME_BELOW_MIN", () => {
    const trending = makeTrendingBars(40, 100, 4);
    const input: EligibilityInput = {
      symbol: "LOWVOLUSDT",
      volume24hUsd: 7_000_000,
      klines: trending,
    };
    const res = evaluateEligibility(input, { minVolume24hUsd: 7_000_000 });
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain(REASON_VOLUME_LOW);
    expect(res.primaryReason).toBe(REASON_VOLUME_LOW);
  });

  it("volume futures $7jt+1 lolos bila struktur trend memenuhi syarat", () => {
    const res = evaluateEligibility({
      symbol: "JUSTABOVEUSDT",
      volume24hUsd: 7_000_001,
      klines: makeTrendingBars(40, 100, 4),
    }, { minVolume24hUsd: 7_000_000 });
    expect(res.eligible).toBe(true);
  });

  it("FR-04: Choppiness >= 58.3 dan ADX < 20 ditolak dengan CHOP_HIGH + ADX_LOW", () => {
    const choppy = makeChoppyBars(40, 100);
    const input: EligibilityInput = {
      symbol: "CHOPUSDT",
      volume24hUsd: 30_000_000,
      klines: choppy,
    };
    const res = evaluateEligibility(input);
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain(REASON_CHOP_HIGH);
    expect(res.reasons).toContain(REASON_ADX_LOW);
  });

  it("Golden Rule 8: blacklist mengalahkan filter kelayakan (alasan BLACKLISTED pertama)", () => {
    const trending = makeTrendingBars(40, 100, 4);
    const input: EligibilityInput = {
      symbol: "BADUSDT",
      volume24hUsd: 50_000_000,
      klines: trending,
      isBlacklisted: true,
    };
    const res = evaluateEligibility(input);
    expect(res.eligible).toBe(false);
    expect(res.reasons[0]).toBe(REASON_BLACKLISTED);
    expect(res.primaryReason).toBe(REASON_BLACKLISTED);
  });

  it("klines kurang dari 28 bar ditolak dengan INSUFFICIENT_KLINES", () => {
    const shortBars = makeTrendingBars(15);
    const input: EligibilityInput = {
      symbol: "NEWUSDT",
      volume24hUsd: 20_000_000,
      klines: shortBars,
    };
    const res = evaluateEligibility(input);
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain(REASON_INSUFFICIENT_KLINES);
    expect(res.metrics.choppiness).not.toBeNull(); // 15 >= 14 bar period
    expect(res.metrics.adx).toBeNull(); // 15 < 28 bar
  });

  it("adapter DB mock menerima update simbol sesuai skema", async () => {
    const calls: { symbol: string; volume: number; eligible: boolean; reason: string | null }[] = [];
    const mockAdapter: EligibilityDbAdapter = {
      async updateSymbolEligibility(symbol, volume24hUsd, eligible, eligibleReason) {
        calls.push({ symbol, volume: volume24hUsd, eligible, reason: eligibleReason });
      },
    };
    const input: EligibilityInput = {
      symbol: "ETHUSDT",
      volume24hUsd: 7_000_000,
      klines: makeTrendingBars(40),
    };
    const res = evaluateEligibility(input);
    await mockAdapter.updateSymbolEligibility(res.symbol, res.metrics.volume24hUsd, res.eligible, res.primaryReason);
    expect(calls.length).toBe(1);
    expect(calls[0].symbol).toBe("ETHUSDT");
    expect(calls[0].eligible).toBe(false);
    expect(calls[0].reason).toBe(REASON_VOLUME_LOW);
  });
});
