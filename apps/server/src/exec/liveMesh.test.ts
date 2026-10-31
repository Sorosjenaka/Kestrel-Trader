// Unit test status watchdog Live Mesh (STALE dua arah).
// npx vitest run src/exec/liveMesh.test.ts
import { describe, expect, it } from "vitest";
import { assessWatchdogState, WATCHDOG_STATE_STALE_MS } from "./liveMesh.js";

const stateWith = (symbols: string[], phase = "MONITORING") => ({
  schema: 2,
  symbols: Object.fromEntries(
    symbols.map((s) => [s, { phase, updatedAt: "2026-10-30T09:00:00+00:00" }]),
  ),
});

describe("assessWatchdogState — status kartu watchdog Live", () => {
  it("posisi OPEN normal yang terlacak watchdog = OK (bukan STALE)", () => {
    const r = assessWatchdogState({
      state: stateWith(["BTCUSDT"]),
      openDbSymbols: ["BTCUSDT"],
      exchangeOnlySymbols: [],
      stateAgeMs: 2_000,
    });
    expect(r.status).toBe("OK");
    expect(r.expectedSymbols).toEqual(["BTCUSDT"]);
    expect(r.note).toContain("DB OPEN + exchange-only");
  });

  it("posisi ada tapi TIDAK ada di state watchdog = STALE (tidak dijaga)", () => {
    const r = assessWatchdogState({
      state: stateWith([]),
      openDbSymbols: ["ETHUSDT"],
      exchangeOnlySymbols: [],
      stateAgeMs: 2_000,
    });
    expect(r.status).toBe("STALE");
    expect(r.note).toContain("ETHUSDT");
    expect(r.note).toContain("tidak dijaga");
  });

  it("0 posisi = OK", () => {
    const r = assessWatchdogState({
      state: stateWith([]),
      openDbSymbols: [],
      exchangeOnlySymbols: [],
      stateAgeMs: 1_000,
    });
    expect(r.status).toBe("OK");
    expect(r.symbols).toEqual([]);
    expect(r.expectedSymbols).toEqual([]);
  });

  it("state masih menyimpan simbol tanpa posisi = STALE (regresi state basi)", () => {
    const r = assessWatchdogState({
      state: stateWith(["SKYUSDT"]),
      openDbSymbols: [],
      exchangeOnlySymbols: [],
      stateAgeMs: 2_000,
    });
    expect(r.status).toBe("STALE");
    expect(r.note).toContain("SKYUSDT");
  });

  it("posisi exchange-only yang terlacak watchdog = OK", () => {
    const r = assessWatchdogState({
      state: stateWith(["LITUSDT"]),
      openDbSymbols: [],
      exchangeOnlySymbols: ["LITUSDT"],
      stateAgeMs: 2_000,
    });
    expect(r.status).toBe("OK");
  });

  it("heartbeat basi (state file tidak diperbarui) = STALE", () => {
    const r = assessWatchdogState({
      state: stateWith([]),
      openDbSymbols: [],
      exchangeOnlySymbols: [],
      stateAgeMs: WATCHDOG_STATE_STALE_MS + 1,
    });
    expect(r.status).toBe("STALE");
    expect(r.note).toContain("heartbeat basi");
  });

  it("state tidak terbaca = UNAVAILABLE", () => {
    const r = assessWatchdogState({
      state: null,
      openDbSymbols: ["BTCUSDT"],
      exchangeOnlySymbols: [],
    });
    expect(r.status).toBe("UNAVAILABLE");
  });
});
