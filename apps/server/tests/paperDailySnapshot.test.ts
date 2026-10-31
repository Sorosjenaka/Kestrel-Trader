import { describe, expect, it } from "vitest";
import { buildPaperDailySnapshot, type PaperClosedTrade } from "../src/analytics/paperDailySnapshot.js";

const trade = (when: string, pnlUsd: number, mode: string): PaperClosedTrade => ({
  createdAt: new Date(when), pnlUsd, mode, rMultiple: pnlUsd,
});

describe("PAPER daily reporting at 07:00 Asia/Jakarta", () => {
  it("memisahkan trade tepat pada cutover ke sesi sekarang tanpa menghitungnya dua kali", () => {
    const snapshot = buildPaperDailySnapshot([
      trade("2026-09-27T23:00:00Z", 2, "SCALP"),
      trade("2026-09-28T23:59:59.999Z", -1, "SCALP"),
      trade("2026-09-29T00:00:00.000Z", 0.5, "SCALP"),
      trade("2026-09-29T00:10:00Z", -0.25, "SCALP"),
    ], new Date("2026-09-29T00:30:00Z"));
    expect(snapshot.timeZone).toBe("Asia/Jakarta");
    expect(snapshot.cutoverAtUtc).toBe("2026-09-29T00:00:00.000Z");
    expect(snapshot.previous.labelWib).toBe("2026-09-28");
    expect(snapshot.previous.tradeCount).toBe(1);
    expect(snapshot.previous.netPnlUsd).toBe(-1);
    expect(snapshot.current.labelWib).toBe("2026-09-29");
    expect(snapshot.current.tradeCount).toBe(2);
    expect(snapshot.current.netPnlUsd).toBe(0.25);
    expect(snapshot.current.byMode.SCALP.trades).toBe(2);
    expect(snapshot.current.byMode.SCALP.netPnlUsd).toBe(0.25);
    expect(snapshot.cutoverSnapshot.closedPaperNetPnlUsdBeforeCutover).toBe(1);
  });

  it("sebelum 07.00 WIB masih memakai sesi hari sebelumnya dan reset tidak mencampur arsip", () => {
    const rows = [trade("2026-09-28T00:01:00Z", 4, "SCALP"), trade("2026-09-28T23:00:00Z", -0.5, "SCALP")];
    const beforeSeven = buildPaperDailySnapshot(rows, new Date("2026-09-28T23:59:00Z"));
    expect(beforeSeven.current.labelWib).toBe("2026-09-28");
    expect(beforeSeven.current.tradeCount).toBe(2);
    const afterReset = buildPaperDailySnapshot(rows, new Date("2026-09-29T00:01:00Z"), new Date("2026-09-28T12:00:00Z"));
    expect(afterReset.previous.tradeCount).toBe(1);
    expect(afterReset.cutoverSnapshot.closedPaperNetPnlUsdBeforeCutover).toBe(-0.5);
  });
});
