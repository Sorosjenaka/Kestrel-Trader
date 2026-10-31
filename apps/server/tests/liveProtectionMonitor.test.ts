// tests/liveProtectionMonitor.test.ts — A2 (30 Okt 2026, rencana
// docs/plan-fix-watcher-2026-10-30.md Tahap 2).
//
// Mengunci: posisi LIVE OPEN tanpa SL aktif di exchange -> alarm EventLog
// CRITICAL (masuk alert feed); SLA_/SL_/manual STOP = terlindungi (diam);
// TAKE_PROFIT BUKAN SL; grace period masa pasang; dedup anti-spam;
// disiplin 429 (mundur tapi tetap jalan) dan 418 (STOP + alarm).
// Semua exchange & DB DI-MOCK — tidak ada order maupun tulisan DB nyata.
import { beforeEach, describe, expect, it, vi } from "vitest";

const exMock = vi.hoisted(() => ({
  algos: [] as unknown[],
  openOrders: [] as unknown[],
  positionRisk: [] as Array<{ symbol: string; positionAmt: string }>,
  failWith: null as Error | null,
  algoCalls: 0,
}));

const dbMock = vi.hoisted(() => ({
  positions: [] as Record<string, unknown>[],
  events: [] as { data: Record<string, unknown> }[],
}));

vi.mock("../src/core/env.js", () => ({
  env: {
    BINANCE_EXECUTION_MODE: "LIVE",
    BINANCE_API_KEY: "test-key", BINANCE_API_SECRET: "test-secret",
    PAPER_TOUCH_VERIFY: false,
  },
}));

vi.mock("../src/exec/binanceUsdMClient.js", () => {
  class FakeBinanceUsdMClient {
    constructor(_opts: unknown) { /* kunci tidak pernah dipakai/di-log */ }
    async getOpenAlgoOrders() {
      exMock.algoCalls += 1;
      if (exMock.failWith) throw exMock.failWith;
      return exMock.algos;
    }
    async getOpenOrders(_symbol?: string) {
      if (exMock.failWith) throw exMock.failWith;
      return exMock.openOrders;
    }
    async getPositionRiskAll() {
      if (exMock.failWith) throw exMock.failWith;
      return exMock.positionRisk;
    }
    async getUserTrades() { return []; }
    async getIncome() { return []; }
    async queryAlgo() { const e: Error & { code?: number } = new Error("Order does not exist"); e.code = -2013; throw e; }
    async cancelAlgo() { const e: Error & { code?: number } = new Error("Order does not exist"); e.code = -2013; throw e; }
  }
  return { BinanceUsdMClient: FakeBinanceUsdMClient };
});

vi.mock("../src/core/db.js", () => ({
  db: {
    position: {
      // Filter seperti Prisma: status + source.startsWith (inti test PAPER).
      findMany: async (args?: { where?: { status?: string; source?: { startsWith?: string } } }) => {
        const w = args?.where ?? {};
        return dbMock.positions.filter((p) =>
          (!w.status || p.status === w.status) &&
          (!w.source?.startsWith || String(p.source ?? "").startsWith(w.source.startsWith)));
      },
      findUnique: async () => null,
      update: async () => ({}),
    },
    trade: { findUnique: async () => null, create: async () => ({}) },
    eventLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        dbMock.events.push(args);
        return { id: dbMock.events.length };
      },
    },
    orderExec: { findFirst: async () => null },
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb({}),
  },
}));

vi.mock("../src/core/logger.js", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock("../src/risk/dailyGuard.js", () => ({ defaultDailyRiskGuard: { isArmed: () => false } }));
vi.mock("../src/risk/lossCooldown.js", () => ({ lossCooldownGuard: { recordClose: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { getHubPrices: () => ({ map: {} }) } }));
vi.mock("../src/learning/directionBattleLearning.js", () => ({ updateClosedDirectionBattle: vi.fn(async () => undefined) }));

import { LiveProtectionMonitor, findDivergences, hasStopProtection, isStopProtection, toProtectionOrderRow } from "../src/exec/liveProtectionMonitor.js";

const T0 = Date.parse("2026-10-30T12:00:00Z");
let clock = T0;

function livePosition(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 3240, symbol: "LITUSDT", side: "SHORT", status: "OPEN", source: "LIVE_AI",
    openedAt: new Date(T0 - 10 * 60_000), // 10 menit lalu — di luar grace
    ...overrides,
  };
}

function makeMonitor(opts?: { noSlGraceMs?: number; alarmDedupMs?: number; divergenceGraceMs?: number; checkUnavailableMs?: number }) {
  return new LiveProtectionMonitor({
    now: () => clock,
    noSlGraceMs: opts?.noSlGraceMs ?? 120_000,
    alarmDedupMs: opts?.alarmDedupMs ?? 3_600_000,
    divergenceGraceMs: opts?.divergenceGraceMs ?? 5 * 60_000,
    checkUnavailableMs: opts?.checkUnavailableMs ?? 10 * 60_000,
    snapshotTtlMs: 0, // cache dimatikan: test memutasi mock exchange di tengah test
    intervalMs: 60_000,
  });
}

type ErrorCapable = { onCheckError(err: unknown): void };
const asErrors = (m: LiveProtectionMonitor) => m as unknown as ErrorCapable;

beforeEach(() => {
  clock = T0;
  exMock.algos = [];
  exMock.openOrders = [];
  exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "6.5" }]; // cocok dengan posisi DB default
  exMock.failWith = null;
  exMock.algoCalls = 0;
  dbMock.positions = [livePosition()];
  dbMock.events = [];
});

describe("A2 — posisi LIVE tanpa SL aktif di exchange harus ber-ALARM CRITICAL", () => {
  it("tanpa order sama sekali: LIVE_NO_SL_ALARM severity critical", async () => {
    await makeMonitor().runCheck();
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_NO_SL_ALARM");
    expect(ev).toBeDefined();
    expect(ev!.data.severity).toBe("critical"); // masuk alert feed (/api/alerts)
    const payload = JSON.parse(String(ev!.data.payload));
    expect(payload).toMatchObject({ positionId: 3240, symbol: "LITUSDT", side: "SHORT" });
    expect(payload.message).toContain("tanpa SL");
  });

  it("hanya TAKE_PROFIT (TPA_/TPB_): tetap alarm — TP bukan SL", async () => {
    exMock.algos = [
      { symbol: "LITUSDT", clientAlgoId: "TPA_AT_LITUSD_1793087803414_X", orderType: "TAKE_PROFIT", side: "BUY", closePosition: false, reduceOnly: true },
      { symbol: "LITUSDT", clientAlgoId: "TPB_AT_LITUSD_1793087803414_X", orderType: "TAKE_PROFIT", side: "BUY", closePosition: false, reduceOnly: true },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_NO_SL_ALARM");
  });

  it("SLA_ (preEntryBracket) pada simbol yang sama: diam, tidak ada alarm", async () => {
    exMock.algos = [
      { symbol: "LITUSDT", clientAlgoId: "SLA_AT_LITUSD_1793087803414_X", orderType: "STOP_MARKET", side: "BUY", closePosition: true, reduceOnly: true },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events).toHaveLength(0);
  });

  it("SL_ (ensureCloseAllStop): diam, tidak ada alarm", async () => {
    exMock.algos = [
      { symbol: "LITUSDT", clientAlgoId: "SL_AT_TEST_LITUSDT_SHORT", orderType: "STOP_MARKET", side: "BUY", closePosition: true, reduceOnly: false },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events).toHaveLength(0);
  });

  it("STOP_MARKET manual di openOrders biasa (sisi menutup): juga dihitung proteksi", async () => {
    exMock.openOrders = [
      { symbol: "LITUSDT", clientOrderId: "MANUAL_STOP_1", type: "STOP_MARKET", side: "BUY", reduceOnly: true, stopPrice: "3.0882" },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events).toHaveLength(0);
  });

  it("STOP dengan sisi yang SALAH (SELL stop untuk posisi SHORT): bukan proteksi -> alarm", async () => {
    exMock.algos = [
      { symbol: "LITUSDT", clientAlgoId: "SLA_ENTRY_SOMEWHERE", orderType: "STOP_MARKET", side: "SELL", closePosition: false, reduceOnly: true },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_NO_SL_ALARM");
  });

  it("SL pada simbol LAIN tidak melindungi posisi ini", async () => {
    exMock.algos = [
      { symbol: "BTCUSDT", clientAlgoId: "SLA_OTHER", orderType: "STOP_MARKET", side: "BUY", closePosition: true, reduceOnly: true },
    ];
    await makeMonitor().runCheck();
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_NO_SL_ALARM");
  });

  it("grace period: posisi < 2 menit belum di-alarm (SL masih dalam masa pasang)", async () => {
    dbMock.positions = [livePosition({ openedAt: new Date(T0 - 60_000) })];
    await makeMonitor().runCheck();
    expect(dbMock.events).toHaveLength(0);
  });

  it("dedup: pemeriksaan berulang tidak men-spam alarm (maks 1x/jam per posisi)", async () => {
    const m = makeMonitor();
    await m.runCheck();
    await m.runCheck();
    clock += 10 * 60_000; // 10 menit kemudian — masih di dalam jendela dedup 1 jam
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_NO_SL_ALARM")).toHaveLength(1);
    clock += 61 * 60_000; // lewat 1 jam -> boleh alarm lagi
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_NO_SL_ALARM")).toHaveLength(2);
  });

  it("posisi PAPER tidak diperiksa (query hanya source LIVE_*)", async () => {
    dbMock.positions = [
      livePosition({ id: 999, symbol: "PAPERUSDT", source: "PAPER_AI" }),
      livePosition({ id: 998, symbol: "DEMOSDT", source: "DEMO_X" }),
    ];
    await makeMonitor().runCheck();
    // PAPER_AI/DEMO terfilter query -> tidak ada alarm untuk keduanya.
    expect(dbMock.events).toHaveLength(0);
  });
});

describe("disiplin rate-limit monitor (alarm tetap jalan saat backoff 429)", () => {
  it("429: mundur eksponensial tapi monitor TIDAK berhenti — cek berikutnya jalan setelah jeda", async () => {
    const m = makeMonitor();
    exMock.failWith = Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 });
    await expect(m.runCheck()).rejects.toThrow("429");
    asErrors(m).onCheckError(Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 }));

    // Selama jeda: tidak ada panggilan baru (jangan menambah beban IP).
    const callsBefore = exMock.algoCalls;
    await m.runCheck();
    expect(exMock.algoCalls).toBe(callsBefore);

    // Setelah jeda lewat: cek jalan lagi dan alarm tetap dievaluasi.
    clock += 31_000;
    exMock.failWith = null;
    await m.runCheck();
    expect(exMock.algoCalls).toBeGreaterThan(callsBefore);
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_NO_SL_ALARM");
  });

  it("418: STOP total + CRITICAL (aturan IP shared: STOP saat 418)", async () => {
    const m = makeMonitor();
    asErrors(m).onCheckError(Object.assign(new Error("Binance request failed (HTTP 418, code -1003)"), { httpStatus: 418 }));
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_PROTECTION_CHECK_STOPPED_418");
    expect(ev).toBeDefined();
    expect(ev!.data.severity).toBe("critical");
  });
});

describe("A3 — alarm selisih DB vs exchange > 5 menit (dua arah, tetap jalan saat backoff 429)", () => {
  it("arah DB_OPEN_EXCHANGE_FLAT: < 5 menit belum alarm, lewat 5 menit -> CRITICAL (kasus #3239/#3240)", async () => {
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }]; // exchange flat, DB masih OPEN
    const m = makeMonitor();
    await m.runCheck();
    clock += 4 * 60_000;
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(0);
    clock += 61_000; // total > 5 menit
    await m.runCheck();
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M");
    expect(ev).toBeDefined();
    expect(ev!.data.severity).toBe("critical");
    const payload = JSON.parse(String(ev!.data.payload));
    expect(payload).toMatchObject({ direction: "DB_OPEN_EXCHANGE_FLAT", positionId: 3240, symbol: "LITUSDT" });
    expect(payload.persistMs).toBeGreaterThan(5 * 60_000);
  });

  it("arah EXCHANGE_OPEN_DB_MISSING: exposure exchange tanpa baris ledger LIVE -> CRITICAL", async () => {
    dbMock.positions = [];
    exMock.positionRisk = [{ symbol: "XRPUSDT", positionAmt: "-120" }];
    const m = makeMonitor();
    await m.runCheck();
    clock += 5 * 60_000 + 1000;
    await m.runCheck();
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M");
    expect(ev).toBeDefined();
    expect(JSON.parse(String(ev!.data.payload))).toMatchObject({ direction: "EXCHANGE_OPEN_DB_MISSING", symbol: "XRPUSDT" });
  });

  it("resolusi mereset state: insiden baru berikutnya ber-ALARM lagi dengan grace baru", async () => {
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }];
    const m = makeMonitor();
    await m.runCheck();
    clock += 6 * 60_000;
    await m.runCheck(); // alarm #1
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(1);
    // Sehat lagi -> state reset (termasuk dedup).
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "6.5" }];
    await m.runCheck();
    // Divergen LAGI (insiden baru) -> butuh grace baru.
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }];
    await m.runCheck();
    clock += 2 * 60_000;
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(1); // masih grace
    clock += 4 * 60_000;
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(2);
  });

  it("dedup: alarm per kunci maks 1x/jam walau divergen terus", async () => {
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }];
    const m = makeMonitor();
    await m.runCheck();
    clock += 6 * 60_000;
    await m.runCheck(); // alarm #1
    clock += 10 * 60_000;
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(1);
    clock += 61 * 60_000;
    await m.runCheck();
    expect(dbMock.events.filter((e) => e.data.type === "LIVE_DIVERGENCE_GT_5M")).toHaveLength(2);
  });

  it("tetap jalan saat backoff 429: evaluasi divergensi terus berjalan setelah episode rate-limit", async () => {
    exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }];
    const m = makeMonitor();
    exMock.failWith = Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 });
    await expect(m.runCheck()).rejects.toThrow("429");
    asErrors(m).onCheckError(Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 }));
    clock += 31_000; // jeda lewat
    exMock.failWith = null;
    await m.runCheck(); // divergensi mulai tercatat
    clock += 5 * 60_000 + 1000;
    await m.runCheck();
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_DIVERGENCE_GT_5M");
  });

  it("cek berlarut gagal > 10 menit: alarm ketidakpastian (keheningan != sehat)", async () => {
    const m = makeMonitor();
    exMock.failWith = Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 });
    await expect(m.runCheck()).rejects.toThrow("429");
    asErrors(m).onCheckError(Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 }));
    clock += 11 * 60_000;
    await m.runCheck().catch(() => undefined); // evaluasi ketersediaan tetap jalan walau cek gagal
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_PROTECTION_CHECK_UNAVAILABLE");
    expect(ev).toBeDefined();
    expect(ev!.data.severity).toBe("critical");
    expect(JSON.parse(String(ev!.data.payload)).message).toContain("TIDAK TERVERIFIKASI");
  });

  it("helper findDivergences: dua arah; flat = 0/absen; simbol cocok dua-duanya = sehat", () => {
    const rows = findDivergences({
      dbPositions: [{ id: 1, symbol: "AUSDT" }, { id: 2, symbol: "BUSDT" }],
      exchangePositions: [
        { symbol: "AUSDT", positionAmt: "0" },   // flat eksplisit -> divergen arah DB
        { symbol: "CUSDT", positionAmt: "5" },   // tanpa DB -> divergen arah EXCHANGE
        // BUSDT tidak punya baris exchange SAMA SEKALI = flat = juga divergen.
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual(expect.objectContaining({ key: "DB:1", direction: "DB_OPEN_EXCHANGE_FLAT", symbol: "AUSDT" }));
    expect(rows).toContainEqual(expect.objectContaining({ key: "DB:2", direction: "DB_OPEN_EXCHANGE_FLAT", symbol: "BUSDT" }));
    expect(rows).toContainEqual(expect.objectContaining({ key: "EX:CUSDT", direction: "EXCHANGE_OPEN_DB_MISSING" }));
    // Sehat: DB OPEN + exchange open pada simbol yang sama.
    expect(findDivergences({
      dbPositions: [{ id: 3, symbol: "DUSDT" }],
      exchangePositions: [{ symbol: "DUSDT", positionAmt: "-2.5" }],
    })).toHaveLength(0);
  });
});

describe("helper murni (normalisasi + deteksi proteksi)", () => {
  it("toProtectionOrderRow menormalkan shape algo (orderType/clientAlgoId) dan openOrders (type/clientOrderId)", () => {
    expect(toProtectionOrderRow({ symbol: "X", clientAlgoId: "SLA_1", orderType: "stop_market", side: "BUY" }))
      .toMatchObject({ symbol: "X", clientAlgoId: "SLA_1", orderType: "STOP_MARKET", side: "BUY" });
    expect(toProtectionOrderRow({ symbol: "X", clientOrderId: "m1", type: "STOP", side: "SELL" }))
      .toMatchObject({ clientAlgoId: "m1", orderType: "STOP" });
    expect(toProtectionOrderRow(null)).toBeNull();
    expect(toProtectionOrderRow({ clientAlgoId: "x" })).toBeNull(); // tanpa symbol
  });

  it("isStopProtection: SLA_/SL_/STOP* dengan sisi menutup; TAKE_PROFIT dan sisi salah ditolak", () => {
    const row = (over: Partial<Parameters<typeof isStopProtection>[0]> & Record<string, unknown>) =>
      toProtectionOrderRow({ symbol: "LITUSDT", side: "BUY", orderType: "STOP_MARKET", ...over })!;
    expect(isStopProtection(row({ clientAlgoId: "SLA_X" }), "SHORT")).toBe(true);
    expect(isStopProtection(row({ clientAlgoId: "SL_Y", orderType: "TAKE_PROFIT" }), "SHORT")).toBe(true);
    expect(isStopProtection(row({ clientAlgoId: "TPA_Z", orderType: "TAKE_PROFIT" }), "SHORT")).toBe(false);
    expect(isStopProtection(row({ clientAlgoId: "m", orderType: "STOP_MARKET" }), "SHORT")).toBe(true);
    expect(isStopProtection(row({ clientAlgoId: "m", orderType: "STOP_MARKET", side: "SELL" }), "SHORT")).toBe(false);
    expect(hasStopProtection({ symbol: "LITUSDT", side: "SHORT", rows: [row({ clientAlgoId: "TPA_Z", orderType: "TAKE_PROFIT" })] })).toBe(false);
    expect(hasStopProtection({ symbol: "LITUSDT", side: "SHORT", rows: [row({ clientAlgoId: "SLA_X" })] })).toBe(true);
  });
});
