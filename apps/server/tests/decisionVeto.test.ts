import { describe, expect, it, beforeEach } from "vitest";
import { decisionVeto, VETO_TTL_MS } from "../src/agents/decisionVeto";

describe("decisionVeto", () => {
  beforeEach(() => decisionVeto.clear());

  it("mencatat NO-GO dan memblokir plan yang sama", () => {
    decisionVeto.recordNoGo("BTCUSDT:S-04:LONG", "Skor rendah", 1_000_000);
    expect(decisionVeto.isBlocked("BTCUSDT:S-04:LONG", 1_000_000)).toBe(true);
  });

  it("setelah masa berlaku habis, tidak lagi memblokir", () => {
    decisionVeto.recordNoGo("BTCUSDT:S-04:LONG", "Skor rendah", 1_000_000);
    expect(decisionVeto.isBlocked("BTCUSDT:S-04:LONG", 1_000_000 + VETO_TTL_MS + 1)).toBe(false);
  });

  it("plan berbeda tidak ikut terblokir", () => {
    decisionVeto.recordNoGo("BTCUSDT:S-04:LONG", "x", 1_000_000);
    expect(decisionVeto.isBlocked("ETHUSDT:S-04:LONG", 1_000_000)).toBe(false);
    expect(decisionVeto.isBlocked("BTCUSDT:S-03:LONG", 1_000_000)).toBe(false);
    expect(decisionVeto.isBlocked("BTCUSDT:S-04:SHORT", 1_000_000)).toBe(false);
  });

  it("alasan penolakan tersimpan untuk ditampilkan", () => {
    decisionVeto.recordNoGo("BTCUSDT:S-04:LONG", "Skor rendah", 1_000_000);
    expect(decisionVeto.reasonFor("BTCUSDT:S-04:LONG")).toBe("Skor rendah");
    expect(decisionVeto.reasonFor("ETHUSDT:S-04:LONG")).toBeNull();
  });

  it("bentuk key deterministik dari kandidat", () => {
    expect(decisionVeto.keyOf({ symbol: "BTCUSDT", strategyId: "S-04", side: "LONG" })).toBe("BTCUSDT:S-04:LONG");
    expect(decisionVeto.keyOf({ symbol: "BTCUSDT", strategyId: "S-04", side: "long" })).toBe("BTCUSDT:S-04:LONG");
  });

  it("clear menghapus seluruh veto", () => {
    decisionVeto.recordNoGo("BTCUSDT:S-04:LONG", "x", 1_000_000);
    decisionVeto.clear();
    expect(decisionVeto.isBlocked("BTCUSDT:S-04:LONG", 1_000_000)).toBe(false);
  });
});
