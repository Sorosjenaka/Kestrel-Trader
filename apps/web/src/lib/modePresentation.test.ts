import { describe, expect, it } from "vitest";
import { enabledTradingModes, historyUrl, resolveTradingMode } from "./modePresentation";

describe("mode presentation contracts", () => {
  it("requests the full selected-mode cohort before the history display cap", () => {
    expect(historyUrl("SWING")).toBe("/api/trades?mode=SWING");
    expect(historyUrl("SCALP")).toBe("/api/trades?mode=SCALP");
    expect(historyUrl("ALL")).toBe("/api/trades?mode=ALL");
    expect(historyUrl("invalid&includeDemo=1")).toBe("/api/trades?mode=ALL");
  });
  it("only enables modes explicitly reported by the server", () => {
    expect(enabledTradingModes(null)).toEqual([]);
    expect(enabledTradingModes({ scalp: "true", swing: false })).toEqual([]);
    expect(enabledTradingModes({ scalp: true, swing: false })).toEqual(["SCALP"]);
    expect(enabledTradingModes({ scalp: false, swing: true })).toEqual(["SWING"]);
    expect(enabledTradingModes({ scalp: true, swing: true })).toEqual(["SCALP", "SWING"]);
  });
  it("preserves a valid preference and replaces a disabled or invalid preference", () => {
    expect(resolveTradingMode("SWING", ["SCALP", "SWING"])).toBe("SWING");
    expect(resolveTradingMode("SWING", ["SCALP"])).toBe("SCALP");
    expect(resolveTradingMode("SCALP", ["SWING"])).toBe("SWING");
    expect(resolveTradingMode("bad", ["SWING"])).toBe("SWING");
    expect(resolveTradingMode("SWING", [])).toBeNull();
  });
});
