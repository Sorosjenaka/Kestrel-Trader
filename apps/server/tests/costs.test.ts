import { describe, expect, it } from "vitest";
import {
  FEE_RATE,
  MAKER_RATE,
  TAKER_RATE,
  netOfFee,
  grossOfFee,
  estimateTradeFeeUsd,
} from "../src/config/costs";

describe("costs", () => {
  it("rate Binance USDⓈ-M Futures (Regular, USDT) — maker 0.02% / taker 0.05%", () => {
    // Sumber: binance.com/en/fee/futureFee, tabel "Regular User" kolom USDT (8 Okt 2026).
    expect(MAKER_RATE).toBe(0.0002);
    expect(TAKER_RATE).toBe(0.0005);
  });

  it("FEE_RATE = taker (konservatif, semua sisi dianggap taker)", () => {
    expect(FEE_RATE).toBe(TAKER_RATE);
    expect(FEE_RATE).toBe(0.0005);
  });

  it("netOfFee/grossOfFee memakai FEE_RATE dengan pembulatan 4 desimal", () => {
    expect(netOfFee(1.2345)).toBe(1.2339);
    expect(grossOfFee(1.2345)).toBe(1.2351);
  });

  it("pembulatan eksplisit 4 desimal (Rules Bagian 2)", () => {
    expect(netOfFee(1.23456789)).toBe(1.234);
  });

  it("estimateTradeFeeUsd: entry taker, exit TP maker / SL taker, dari notional", () => {
    expect(estimateTradeFeeUsd({ entryAvg: 100, exitAvg: 101.6, qty: 10, exitIsMaker: true }))
      .toBeCloseTo(0.7032, 4);
    expect(estimateTradeFeeUsd({ entryAvg: 100, exitAvg: 98.4, qty: 10, exitIsMaker: false }))
      .toBeCloseTo(0.992, 4);
  });

  it("estimateTradeFeeUsd menolak input non-finit/negatif (tidak mengarang fee)", () => {
    expect(estimateTradeFeeUsd({ entryAvg: NaN, exitAvg: 100, qty: 10, exitIsMaker: false })).toBe(0);
    expect(estimateTradeFeeUsd({ entryAvg: 100, exitAvg: 100, qty: -1, exitIsMaker: false })).toBe(0);
  });
});
