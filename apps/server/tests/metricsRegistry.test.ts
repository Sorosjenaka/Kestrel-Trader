import { describe, expect, it } from "vitest";
import { evaluateThresholds, MetricAlertLog, type MetricSnapshot } from "../src/analytics/metricsRegistry";

const base: MetricSnapshot = {
  strategyId: "S-04", tradesToday: 10, winsToday: 5, pnlTodayUsd: 1.2,
  losingStreak: 1, drawdownUsd: 2, winRatePct: 50,
};

describe("metricsRegistry", () => {
  it("kondisi sehat -> tidak ada alert", () => {
    expect(evaluateThresholds(base)).toHaveLength(0);
  });

  it("losing streak panjang -> alert", () => {
    expect(evaluateThresholds({ ...base, losingStreak: 5 })[0]?.code).toBe("LOSING_STREAK");
  });

  it("drawdown harian melewati ambang -> alert", () => {
    expect(evaluateThresholds({ ...base, drawdownUsd: 9 })[0]?.code).toBe("DAILY_DRAWDOWN");
  });

  it("WR anjlok dengan sampel cukup -> alert", () => {
    expect(evaluateThresholds({ ...base, tradesToday: 20, winsToday: 5, winRatePct: 25 })[0]?.code).toBe("WINRATE_DROP");
  });

  it("sampel kecil tidak memicu alert WR", () => {
    expect(evaluateThresholds({ ...base, tradesToday: 3, winRatePct: 10 }).some((a) => a.code === "WINRATE_DROP")).toBe(false);
  });

  it("satu kode tidak berulang dalam hari yang sama, tapi boleh lagi besok", () => {
    const log = new MetricAlertLog();
    expect(log.shouldEmit("LOSING_STREAK", "S-04", "2026-10-03")).toBe(true);
    expect(log.shouldEmit("LOSING_STREAK", "S-04", "2026-10-03")).toBe(false);
    expect(log.shouldEmit("DAILY_DRAWDOWN", "S-04", "2026-10-03")).toBe(true);
    expect(log.shouldEmit("LOSING_STREAK", "S-04", "2026-10-04")).toBe(true);
    expect(log.shouldEmit("LOSING_STREAK", "S-03", "2026-10-04")).toBe(true);
  });
});
