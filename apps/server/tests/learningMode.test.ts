import { describe, expect, it } from "vitest";
import { learningModeOf, resolvedEntrySnapshot, swingCooldownDeadline } from "../src/learning/learningContext.js";
describe("learning provenance and cooldown timing", () => {
  it("requires the real position, symbol and mode; never fabricates missing entry features", () => {
    const map = new Map([[7, { symbol: "BTCUSDT", mode: "SWING" as const, features: [60, 70, 80, 25, 2] }]]);
    expect(resolvedEntrySnapshot(map, { positionId: 7, symbol: "BTCUSDT", mode: "SWING" })?.mode).toBe("SWING");
    expect(resolvedEntrySnapshot(map, { positionId: 8, symbol: "BTCUSDT", mode: "SWING" })).toBeNull();
    expect(resolvedEntrySnapshot(map, { positionId: 7, symbol: "BTCUSDT", mode: "SCALP" })).toBeNull();
    expect(resolvedEntrySnapshot(map, { positionId: 7, symbol: "ETHUSDT", mode: "SWING" })).toBeNull();
    expect(learningModeOf("unknown")).toBeNull();
  });
  it("does not slide the 24h deadline forward each scan", () => {
    const closed = new Date("2026-10-10T10:00:00Z"), hour = 3_600_000;
    expect(swingCooldownDeadline(closed, closed.getTime() + hour)).toBe(closed.getTime() + 24 * hour);
    expect(swingCooldownDeadline(closed, closed.getTime() + 23 * hour)).toBe(closed.getTime() + 24 * hour);
    expect(swingCooldownDeadline(closed, closed.getTime() + 24 * hour)).toBeNull();
    expect(swingCooldownDeadline(new Date("invalid"), Date.now())).toBeNull();
  });
});
