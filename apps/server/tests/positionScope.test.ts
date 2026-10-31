// apps/server/tests/positionScope.test.ts
// Regresi insiden go-live 27 Okt 2026: posisi PAPER_AI (simulasi) yang masih
// OPEN di DB memblokir SELURUH entry live. Funnel SWING menghitung slot dengan
// `source: { not: "DEMO" }` -> 11 posisi simulasi >= cap LIVE 3 -> funnel
// memblokir dirinya sendiri 100% (350x SWING_GATE: PAPER_GLOBAL_SLOT_CAP) ->
// 0 order live selama 2 jam, padahal 0 posisi LIVE ada di exchange.
//
// Modul yang diuji: src/risk/positionScope.ts (murni, tanpa I/O).
import { afterEach, describe, expect, it } from "vitest";
import {
  anyOpenSymbolWhere,
  executionScopedOpenWhere,
  isLiveExecution,
  swingSlotCap,
} from "../src/risk/positionScope.js";

const ORIGINAL_MODE = process.env.BINANCE_EXECUTION_MODE;

function setMode(mode: "PAPER" | "LIVE"): void {
  process.env.BINANCE_EXECUTION_MODE = mode;
}

describe("positionScope — scope posisi per mode eksekusi", () => {
  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.BINANCE_EXECUTION_MODE;
    else process.env.BINANCE_EXECUTION_MODE = ORIGINAL_MODE;
  });

  it("LIVE: hanya posisi LIVE_* yang dihitung (posisi simulasi TIDAK makan slot)", () => {
    setMode("LIVE");
    expect(isLiveExecution()).toBe(true);
    const where = executionScopedOpenWhere();
    expect(where.status).toBe("OPEN");
    expect(where.source).toEqual({ startsWith: "LIVE_" });
  });

  it("PAPER: semua posisi non-DEMO dihitung (DEMO = pipeline uji)", () => {
    setMode("PAPER");
    expect(isLiveExecution()).toBe(false);
    const where = executionScopedOpenWhere();
    expect(where.status).toBe("OPEN");
    expect(where.source).toEqual({ not: "DEMO" });
  });

  it("filter lane diteruskan (SWING/SCALP)", () => {
    setMode("LIVE");
    expect(executionScopedOpenWhere("SWING").mode).toBe("SWING");
    expect(executionScopedOpenWhere("SCALP").mode).toBe("SCALP");
    expect(executionScopedOpenWhere().mode).toBeUndefined();
  });

  it("kunci anti double-exit: cek simbol OPEN apa pun sumbernya (paper + live)", () => {
    const where = anyOpenSymbolWhere("BTCUSDT");
    expect(where).toEqual({ status: "OPEN", symbol: "BTCUSDT" });
  });

  it("cap slot LIVE = min(SWING_MAX_POSITIONS, LIVE_MAX_OPEN_POSITIONS)", () => {
    expect(swingSlotCap({
      isLive: true, swingMaxPositions: 20, liveMaxOpenPositions: 3, paperMaxPositions: 20,
    })).toBe(3);
    // Env produksi: SWING_MAX_POSITIONS=20, LIVE_MAX_OPEN_POSITIONS=3.
    expect(swingSlotCap({
      isLive: true, swingMaxPositions: 2, liveMaxOpenPositions: 3, paperMaxPositions: 20,
    })).toBe(2);
  });

  it("cap slot PAPER = min(MAX_OPEN_POSITIONS, SWING_MAX_POSITIONS)", () => {
    expect(swingSlotCap({
      isLive: false, swingMaxPositions: 20, liveMaxOpenPositions: 3, paperMaxPositions: 20,
    })).toBe(20);
  });

  it("cap minimal 1 posisi (tidak pernah 0 atau negatif)", () => {
    expect(swingSlotCap({
      isLive: true, swingMaxPositions: 0, liveMaxOpenPositions: 0, paperMaxPositions: 20,
    })).toBe(1);
    expect(swingSlotCap({
      isLive: false, swingMaxPositions: -5, liveMaxOpenPositions: 3, paperMaxPositions: 0,
    })).toBe(1);
  });
});
