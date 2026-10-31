// tests/paperPositionsFlag.test.ts — C2 (30 Okt 2026, perintah operator).
//
// Mengunci: flag PAPER_POSITIONS_ENABLED (default FALSE) memblokir pembuatan
// posisi PAPER BARU di funnel tunggal executePlannedEntry — SEBELUM ada side
// effect (order/posisi/DB). Kode paper tidak dihapus; flag TRUE membuka lagi.
// Jalur LIVE tidak terpengaruh (gate hanya untuk !LIVE_MODE).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  liveExecutor: { executeOrder: vi.fn(), cancelEntry: vi.fn() },
  eventCreate: vi.fn(async () => ({})),
  paperEnabled: { value: false }, // mutable: dibaca saat gate dievaluasi
}));

vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: mocks.eventCreate }, position: { create: vi.fn() } } }));
vi.mock("../src/core/env.js", () => ({
  env: {
    BINANCE_EXECUTION_MODE: "PAPER",
    PAPER_TOUCH_VERIFY: false,
    get PAPER_POSITIONS_ENABLED() { return mocks.paperEnabled.value; },
  },
}));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { fetchKlines: vi.fn(async () => []) } }));
vi.mock("../src/risk/dailyGuard.js", () => ({ MAX_OPEN_POSITIONS: 20, defaultDailyRiskGuard: { evaluateStatus: mocks.guard, isArmed: () => false } }));
vi.mock("../src/exec/liveRuntime.js", () => ({
  LIVE_MODE: false, // mesin paper — target gate C2
  liveExchange: undefined,
  activeOrderExecutor: mocks.liveExecutor, flattenLiveSymbol: vi.fn(), checkLiveEntryGate: vi.fn(),
  livePositionWatcher: {}, prepareLiveSymbol: vi.fn(),
}));
vi.mock("../src/learning/playbookRules.js", () => ({ prismaPlaybookRuleStore: {},
  autoRollbackRuleIfNeeded: vi.fn(), recordApprovedRuleOutcomeForTrade: vi.fn(async () => undefined),
  interceptApprovedPlaybookRules: vi.fn(), recordApprovedRuleApplication: vi.fn() }));

import { executePlannedEntry } from "../src/exec/plannedEntry.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paperEnabled.value = false;
});

describe("C2 — flag PAPER_POSITIONS_ENABLED memblokir posisi paper baru", () => {
  it("flag false (default): tolak PAPER_POSITIONS_DISABLED sebelum ada side effect", async () => {
    mocks.paperEnabled.value = false;
    await expect(executePlannedEntry({} as never, { mode: "SWING", source: "AI" }))
      .rejects.toThrow("PAPER_POSITIONS_DISABLED");
    // Tidak ada side effect: guard belum sempat dievaluasi, order tidak dikirim,
    // tidak ada tulisan EventLog/posisi.
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.liveExecutor.executeOrder).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("flag true: gate terbuka — eksekusi lanjut melewati gate (berhenti di gate berikutnya, ARM)", async () => {
    mocks.paperEnabled.value = true;
    mocks.guard.mockResolvedValueOnce({ armed: false }); // gate ARM sesudah gate C2
    await expect(executePlannedEntry({} as never, { mode: "SWING", source: "AI" }))
      .rejects.toThrow("ARM_REQUIRED"); // gate lain, BUKAN PAPER_POSITIONS_DISABLED
    expect(mocks.guard).toHaveBeenCalled(); // bukti flow melewati gate C2
  });

  it("SCALP juga terblokir saat flag false (semua mode paper)", async () => {
    mocks.paperEnabled.value = false;
    await expect(executePlannedEntry({} as never, { mode: "SCALP", source: "MANUAL" }))
      .rejects.toThrow("PAPER_POSITIONS_DISABLED");
    expect(mocks.liveExecutor.executeOrder).not.toHaveBeenCalled();
  });
});
