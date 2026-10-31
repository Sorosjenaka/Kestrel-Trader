import { describe, expect, it } from "vitest";
import {
  SCALP_STRATEGY_SPECS,
  allowedScalpStrategies,
  buildScalpStrategyPlans,
} from "../src/strategies/scalp/index.js";
import {
  SWING_STRATEGY_SPECS,
  allowedSwingStrategies,
  buildSwingStrategyPlans,
} from "../src/strategies/swing/index.js";
import { strategiesForMode } from "../src/strategies/strategyCatalog.js";

describe("Strategi Separation (Scalp vs Swing)", () => {
  it("memisahkan spesifikasi SCALP dan SWING secara eksplisit", () => {
    // 20 Okt 2026: S-03 Fibonacci + S-04 MRV dihapus -> SCALP tersisa
    // S-01 (hard-gated, hanya di katalog) + S-02 = 2 spec. Assertion TEPAT
    // (bukan >=) supaya penghapusan strategi berikutnya tidak diam-diam lolos.
    expect(SCALP_STRATEGY_SPECS.map((s) => s.id).sort()).toEqual(["S-01", "S-02"]);
    for (const spec of SCALP_STRATEGY_SPECS) {
      expect(spec.mode).toBe("SCALP");
    }

    // SWING: 20 Okt 2026 S-05 Polaris dihapus -> RSW-01/02/03 = 3 spec.
    expect(SWING_STRATEGY_SPECS.map((s) => s.id).sort()).toEqual(["RSW-01", "RSW-02", "RSW-03"]);
    for (const spec of SWING_STRATEGY_SPECS) {
      expect(spec.mode).toBe("SWING");
    }
  });

  it("strategiesForMode mengembalikan filter yang akurat", () => {
    const scalpList = strategiesForMode("SCALP");
    const swingList = strategiesForMode("SWING");

    expect(scalpList.every((s) => s.mode === "SCALP")).toBe(true);
    expect(swingList.every((s) => s.mode === "SWING")).toBe(true);
    expect(scalpList.some((s) => s.id === "S-02")).toBe(true);
    // 20 Okt 2026: S-05 Polaris dihapus dari katalog -> tidak ada di lane SWING.
    expect(swingList.some((s) => s.id === "S-05")).toBe(false);
    // 20 Okt 2026: S-03 Fibonacci dihapus dari katalog (operator).
    expect(swingList.some((s) => s.id === "S-03")).toBe(false);
  });

it("allowedStrategies mengembalikan allowlist deterministik", () => {
    const scalpAllowed = allowedScalpStrategies();
    expect(scalpAllowed).toContain("S-02");
    expect(scalpAllowed).not.toContain("S-01"); // S-01 hard-gated

    const swingAllowed = allowedSwingStrategies();
    // 20 Okt 2026: S-05 Polaris dihapus -> allowlist SWING hanya RSW-01/02/03.
    expect(swingAllowed).not.toContain("S-05");
    expect(swingAllowed).toContain("RSW-01");
    expect(swingAllowed).toContain("RSW-02");
    expect(swingAllowed).toContain("RSW-03");
    expect(swingAllowed).not.toContain("S-03"); // Fibonacci dihapus 20 Okt 2026
  });

  it("allowlist SWING memisahkan mode LIVE dan PAPER (regression D-1)", () => {
    // 20 Okt 2026 (D-1): operator ADOPT RSW-01/02/03 untuk LIVE dan PAPER.
    // env default = PAPER, jadi allowedSwingStrategies() harus return RSW set.
    const swingAllowed = allowedSwingStrategies();
    expect(swingAllowed).toEqual(expect.arrayContaining(["RSW-01", "RSW-02", "RSW-03"]));
    // S-05/S-03/S-04 TIDAK boleh masuk dari env manapun.
    expect(swingAllowed).not.toContain("S-05");
    expect(swingAllowed).not.toContain("S-03");
    expect(swingAllowed).not.toContain("S-04");
  });

  it("memilih lane aktif sesuai TRADING_STYLE yang dipilih operator", async () => {
    const { getTradingStyle, scalpLaneEnabled, swingLaneEnabled, setTradingStyleOverride } = await import("../src/exec/slotFillPolicy.js");

    try {
      setTradingStyleOverride("SCALP");
      expect(getTradingStyle()).toBe("SCALP");
      expect(scalpLaneEnabled()).toBe(true);
      expect(swingLaneEnabled()).toBe(false);

      setTradingStyleOverride("SWING");
      expect(getTradingStyle()).toBe("SWING");
      expect(scalpLaneEnabled()).toBe(false);
      expect(swingLaneEnabled()).toBe(true);

      setTradingStyleOverride("BOTH");
      expect(getTradingStyle()).toBe("BOTH");
      expect(scalpLaneEnabled()).toBe(true);
      expect(swingLaneEnabled()).toBe(true);
    } finally {
      setTradingStyleOverride(null);
    }
  });
});
