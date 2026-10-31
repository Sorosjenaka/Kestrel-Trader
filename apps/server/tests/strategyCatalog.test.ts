// apps/server/tests/strategyCatalog.test.ts
// T-09 — Nama strategi era-aware (anti salah label riwayat):
//   - Nomor S-05 DIPAKAI ULANG 13 Okt 2026 (dulu era 2 "HA Smooth Scalper",
//     kini "Swing Breakout Pattern"). Trade lama wajib tetap tampil dengan
//     nama era-nya; trade baru (>= SWING_CUTOFF_MS) memakai nama baru.
//   - canonicalStrategyKey: S-05 pra-cutover = "S-99" (arsip), pasca = "S-05".
//   - Nama S-01..S-04 (post-renumber 6 Okt) tidak berubah.
import { describe, expect, it } from "vitest";
import {
  strategyDisplayName,
  canonicalStrategyKey,
  SWING_CUTOFF_MS,
  RENUMBER_CUTOFF_MS,
} from "../src/strategies/strategyCatalog.js";

const BEFORE_SWING = SWING_CUTOFF_MS - 60_000; // 13 Okt 2026, sebelum cutover
const AFTER_SWING = SWING_CUTOFF_MS + 60_000; // 13 Okt 2026, sesudah cutover

describe("T-09 — label strategi era-aware (S-05 dipakai ulang 13 Okt 2026)", () => {
  it("S-05 sebelum SWING_CUTOFF_MS = 'HA Smooth Scalper' (era 2, arsip)", () => {
    expect(strategyDisplayName("S-05", new Date(BEFORE_SWING))).toBe("HA Smooth Scalper");
    expect(canonicalStrategyKey("S-05", new Date(BEFORE_SWING))).toBe("S-99");
  });

  it("20 Okt 2026: S-05 sesudah SWING_CUTOFF_MS = 'Swing Breakout Pattern' (arsip, bukan entry source)", () => {
    expect(strategyDisplayName("S-05", new Date(AFTER_SWING))).toBe("Swing Breakout Pattern");
    // 20 Okt 2026: S-05 dihapus dari katalog aktif -> kunci kanonik era-4
    // ikut ke bucket arsip "S-99" (tidak ada strategi hidup untuk ID itu).
    expect(canonicalStrategyKey("S-05", new Date(AFTER_SWING))).toBe("S-99");
  });

  it("S-05 tanpa timestamp = nama operator terakhir (Polaris); trade tanpa openedAt tidak salah label", () => {
    // Nama operator 19 Okt 2026; ID tetap S-05.
    expect(strategyDisplayName("S-05", null)).toBe("Polaris");
    expect(strategyDisplayName("RSW-01", null)).toBe("Orion");
    expect(strategyDisplayName("RSW-02", null)).toBe("Vega");
    expect(strategyDisplayName("RSW-03", null)).toBe("Draco");
  });

  it("cutover setelah renumber 6 Okt (urutan era konsisten)", () => {
    expect(SWING_CUTOFF_MS).toBeGreaterThan(RENUMBER_CUTOFF_MS);
  });

  it("S-01/S-02 tetap; S-03/S-04 (dihapus 20 Okt) label historis utuh + kunci kanonik S-99", () => {
    const t = new Date(AFTER_SWING);
    // S-01/S-02 MASIH hidup -> label + kunci kanonik tidak berubah.
    expect(strategyDisplayName("S-01", t)).toBe("Liquidity Sweep Reclaim");
    expect(strategyDisplayName("S-02", t)).toBe("Liquidity Sniper");
    expect(canonicalStrategyKey("S-01", t)).toBe("S-01");
    expect(canonicalStrategyKey("S-02", t)).toBe("S-02");
    // S-03 Fibonacci + S-04 MRV DIHAPUS dari katalog aktif 20 Okt 2026.
    // Display WAJIB persis nama historis (invariant AGENT.md "label history
    // 100% benar") — TIDAK boleh diberi suffix "(retired ...)" karena itu
    // mengubah catatan label trade lama.
    expect(strategyDisplayName("S-03", t)).toBe("Fibonacci Zone 0.5-0.618");
    expect(strategyDisplayName("S-04", t)).toBe("Mean-Reversion Stretch + Trend Gate");
    // Kunci kanonik (agregasi statistik): tidak ada strategi hidup untuk
    // S-03/S-04 -> keduanya masuk bucket arsip "S-99", BUKAN ikut teragregasi
    // ke ID lain (mis. S-01) yang akan merusak statistik strategi aktif.
    expect(canonicalStrategyKey("S-03", t)).toBe("S-99");
    expect(canonicalStrategyKey("S-04", t)).toBe("S-99");
  });
});
