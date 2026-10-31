import { describe, expect, it } from "vitest";
import { buildDailyReport, reportFileName } from "../src/agents/reportWriter";

describe("reportWriter", () => {
  const report = buildDailyReport({
    stats: [{ strategyId: "S-04", trades: 7, wins: 1, winRatePct: 25, evUsd: -0.35, profitFactor: 0.25, avgWinUsd: 1.6, avgLossUsd: -1 }],
    alerts: [{ code: "WINRATE_DROP", message: "S-04: WR 25.0% < 35% pada 20 trade hari ini", strategyId: "S-04" }],
    appliedParams: [{ param: "pullBiasThreshold", strategyId: "S-04", value: 1.6, version: "v-test" }],
    now: "2026-10-03T13:45:00.000Z",
  });

  it("memuat tanggal", () => {
    expect(report).toContain("Laporan Harian ArtaTrade 2026-10-03");
  });

  it("memuat tabel statistik", () => {
    expect(report).toContain("| S-04 | 7 | 25.0% | -0.3500 | 0.25 |");
  });

  it("memuat baris TOTAL gabungan", () => {
    expect(report).toContain("| TOTAL | 7 | 14.3% |");
  });

  it("memuat daftar alert", () => {
    expect(report).toContain("[WINRATE_DROP]");
  });

  it("memuat parameter aktif", () => {
    expect(report).toContain("pullBiasThreshold = 1.6");
  });

  it("tanpa alert tetap valid", () => {
    const empty = buildDailyReport({ stats: [], alerts: [], appliedParams: [], now: "2026-10-03T00:00:00.000Z" });
    expect(empty).toContain("(tidak ada alert)");
    expect(empty).toContain("(tidak ada)");
  });

  it("nama file laporan per hari", () => {
    expect(reportFileName("2026-10-03T13:45:00.000Z")).toBe("report-2026-10-03.md");
  });
});
