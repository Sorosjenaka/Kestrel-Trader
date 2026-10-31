// tests/livePositionWatcherFinalize.test.ts — 30 Okt 2026 (Tahap 0+1,
// rencana docs/plan-fix-watcher-2026-10-30.md, insiden #3239/#3240).
//
// Mengunci dua hal yang gagal pada insiden SL fill tidak teratribusi:
//  1. REGRESI UTAMA: posisi LIVE yang flat di exchange harus berakhir CLOSED
//     dengan akuntansi dari FILL ASLI (userTrades/income), bukan harga trigger.
//  2. ANTI-MENGGANTUNG (pola withTimeout mirrorInFlight f918498): call yang
//     tidak pernah settle TIDAK boleh meracuni `running` — tick berikutnya
//     tetap jalan dan posisi tetap berakhir CLOSED (self-healing).
//  3. Tahap 0: setiap jalur ter-log (masuk/defer+alasan/skip/error/hasil).
//
// Semua exchange & DB DI-MOCK — tidak ada order maupun tulisan DB nyata.
import { beforeEach, describe, expect, it, vi } from "vitest";

const exMock = vi.hoisted(() => ({
  positionRisk: [] as Array<{ symbol: string; positionAmt: string }>,
  userTrades: [] as unknown[],
  income: [] as unknown[],
  hangPositionRisk: false,
  hangUserTrades: false,
  failPositionRisk: null as Error | null,
}));

const dbMock = vi.hoisted(() => ({
  positions: [] as Record<string, unknown>[],
  updates: [] as { id: number; data: Record<string, unknown> }[],
  trades: [] as Record<string, unknown>[],
  events: [] as { data: Record<string, unknown> }[],
}));

const logMock = vi.hoisted(() => ({
  info: [] as Array<{ payload: Record<string, unknown>; msg: string }>,
  warn: [] as Array<{ payload: Record<string, unknown>; msg: string }>,
  error: [] as Array<{ payload: Record<string, unknown>; msg: string }>,
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
    async getPositionRiskAll() {
      if (exMock.hangPositionRisk) return new Promise<never>(() => { /* menggantung */ });
      if (exMock.failPositionRisk) throw exMock.failPositionRisk;
      return exMock.positionRisk;
    }
    async getUserTrades(_input: unknown) {
      if (exMock.hangUserTrades) return new Promise<never>(() => { /* menggantung */ });
      return exMock.userTrades;
    }
    async getIncome(_input: unknown) { return exMock.income; }
    async getOpenAlgoOrders() { return { orders: [] }; }
    async getPositionRisk(input?: { symbol?: string }) {
      return exMock.positionRisk.filter((p) => !input?.symbol || p.symbol === input.symbol);
    }
    async queryAlgo(clientAlgoId: string) {
      const e: Error & { code?: number } = new Error("Order does not exist");
      e.code = -2013;
      throw e;
    }
    async cancelAlgo(clientAlgoId: string) {
      const e: Error & { code?: number } = new Error("Order does not exist");
      e.code = -2013;
      throw e;
    }
  }
  return { BinanceUsdMClient: FakeBinanceUsdMClient };
});

vi.mock("../src/core/db.js", () => {
  const tx = {
    position: {
      findMany: async (_args?: unknown) => dbMock.positions,
      findUnique: async (args: { where: { id: number } }) =>
        dbMock.positions.find((p) => p.id === args.where.id) ?? null,
      update: async (args: { where: { id: number }; data: Record<string, unknown> }) => {
        dbMock.updates.push({ id: args.where.id, data: args.data });
        const row = dbMock.positions.find((p) => p.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row ?? {};
      },
    },
    trade: {
      findUnique: async (args: { where: { positionId: number } }) =>
        dbMock.trades.find((t) => t.positionId === args.where.positionId) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        dbMock.trades.push(args.data);
        return { id: dbMock.trades.length, ...args.data };
      },
    },
  };
  return {
    db: {
      position: tx.position,
      trade: tx.trade,
      eventLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          dbMock.events.push(args);
          return { id: dbMock.events.length };
        },
      },
      orderExec: { findFirst: async () => null },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

vi.mock("../src/core/logger.js", () => ({
  logger: {
    info: (payload: Record<string, unknown>, msg?: string) => logMock.info.push({ payload, msg: msg ?? "" }),
    warn: (payload: Record<string, unknown>, msg?: string) => logMock.warn.push({ payload, msg: msg ?? "" }),
    error: (payload: Record<string, unknown>, msg?: string) => logMock.error.push({ payload, msg: msg ?? "" }),
    debug: () => undefined,
  },
}));

vi.mock("../src/risk/dailyGuard.js", () => ({ defaultDailyRiskGuard: { isArmed: () => true } }));
vi.mock("../src/risk/lossCooldown.js", () => ({ lossCooldownGuard: { recordClose: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { getHubPrices: () => ({ map: {} }) } }));
vi.mock("../src/learning/directionBattleLearning.js", () => ({ updateClosedDirectionBattle: vi.fn(async () => undefined) }));

import { LivePositionWatcher } from "../src/exec/liveRuntime.js";

// ── Data skenario: replika kasus LITUSDT #3240 (SHORT, SL fill asli) ─────────
const T_OPEN = Date.parse("2026-10-28T16:22:00Z");
const T_CLOSE = Date.parse("2026-10-29T12:32:33Z");

function litPosition(): Record<string, unknown> {
  return {
    id: 3240, symbol: "LITUSDT", side: "SHORT", mode: "SWING", strategyId: "RSW-01",
    status: "OPEN", source: "LIVE_AI", qty: 6.5, originalQty: 6.5,
    entryPrice: 2.9336, slPrice: 3.0882, originalSlPrice: 3.0882, originalRiskUsd: 1.0049,
    openedAt: new Date(T_OPEN), mfePrice: null, maePrice: null,
    tp1Price: null, tp2Price: null, quantityStep: 0.1, riskBudgetUsd: null, entryAttrs: null,
  };
}

/** Fill asli userTrades: entry SELL + 2 fill penutup BUY (SL stop-market). */
function litUserTrades(): unknown[] {
  return [
    { id: 1, time: T_OPEN + 10_000, side: "SELL", price: 2.9336, qty: 6.5, realizedPnl: 0, commission: -0.00381368, commissionAsset: "USDT", orderId: 111 },
    { id: 2, time: T_CLOSE, side: "BUY", price: 3.0856, qty: 1.8, realizedPnl: -0.2736, commission: -0.00277704, commissionAsset: "USDT", orderId: 222 },
    { id: 3, time: T_CLOSE, side: "BUY", price: 3.0856, qty: 4.7, realizedPnl: -0.7144, commission: -0.00725116, commissionAsset: "USDT", orderId: 222 },
  ];
}

type Tickable = { tick(): Promise<void>; onTickError(err: unknown): void };
const asTickable = (w: LivePositionWatcher) => w as unknown as Tickable;

beforeEach(() => {
  exMock.positionRisk = [{ symbol: "LITUSDT", positionAmt: "0" }];
  exMock.userTrades = litUserTrades();
  exMock.income = [{ income: -0.005829, incomeType: "FUNDING_FEE", symbol: "LITUSDT" }];
  exMock.hangPositionRisk = false;
  exMock.hangUserTrades = false;
  exMock.failPositionRisk = null;
  dbMock.positions = [litPosition()];
  dbMock.updates = [];
  dbMock.trades = [];
  dbMock.events = [];
  logMock.info = [];
  logMock.warn = [];
  logMock.error = [];
});

describe("regresi utama: posisi LIVE flat di exchange berakhir CLOSED dengan fill asli", () => {
  it("menutup ledger dari userTrades/income asli: exitAvg = harga fill, PnL NET, quality VERIFIED", async () => {
    const watcher = new LivePositionWatcher({ snapshotTtlMs: 0 });
    await asTickable(watcher).tick();

    // 1) Posisi berakhir CLOSED dengan closeReason dari fill (loss -> SL).
    const close = dbMock.updates.find((u) => u.data.status === "CLOSED");
    expect(close).toBeDefined();
    expect(close!.data).toMatchObject({ status: "CLOSED", closeReason: "SL" });
    // NET = gross (-0.988) - fee (0.0100282+0.00381368=0.013842) + funding (-0.005829).
    expect(close!.data.pnlUsd as number).toBeCloseTo(-1.007671, 6);

    // 2) Trade dibuat dari FILL ASLI (bukan harga trigger SL 3.0882).
    expect(dbMock.trades).toHaveLength(1);
    const trade = dbMock.trades[0]!;
    expect(trade.exitAvg).toBe(3.0856);
    expect(trade.exitAvg).not.toBe(3.0882); // SL trigger TIDAK boleh jadi harga exit
    expect(trade.pnlUsd as number).toBeCloseTo(-1.007671, 6);
    expect(trade.feeUsd).toBeCloseTo(0.013842, 6);
    expect(trade.fundingUsd as number).toBeCloseTo(-0.005829, 6);
    expect(trade.accountingQuality).toBe("VERIFIED");
    expect(trade.source).toBe("LIVE_AI");

    // 3) Event akhir tercatat; TIDAK ada deferral.
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_POSITION_CLOSED");
    expect(dbMock.events.map((e) => e.data.type)).not.toContain("LIVE_EXIT_ACCOUNTING_DEFERRED");

    // 4) Tahap 0: jalur ter-log berurutan — masuk -> bukti -> hasil.
    const infoMsgs = logMock.info.map((l) => l.msg);
    expect(infoMsgs).toContain("LIVE_EXIT_FINALIZE_START");
    expect(infoMsgs).toContain("LIVE_EXIT_EVIDENCE");
    expect(infoMsgs).toContain("LIVE_POSITION_CLOSED");
    const evidence = logMock.info.find((l) => l.msg === "LIVE_EXIT_EVIDENCE")!;
    expect(evidence.payload).toMatchObject({ complete: true, attribution: "FULL", filledQty: 6.5, exitFillCount: 2 });
  });
});

describe("Tahap 1 — anti-menggantung: call tidak settle tidak meracuni watcher (self-healing)", () => {
  it("getPositionRiskAll menggantung: tick di-timeout + alarm, tick berikutnya tetap menutup posisi", async () => {
    const watcher = new LivePositionWatcher({ tickTimeoutMs: 40, snapshotTtlMs: 0 });
    exMock.hangPositionRisk = true;

    const startedAt = Date.now();
    await asTickable(watcher).tick(); // tidak boleh menggantung selamanya
    expect(Date.now() - startedAt).toBeLessThan(2000);

    // Alarm hang tercatat (sumber TICK_TIMEOUT), posisi BELUM tertutup.
    const hung = dbMock.events.find((e) => e.data.type === "LIVE_WATCHER_TICK_HUNG");
    expect(hung).toBeDefined();
    expect(JSON.parse(String(hung!.data.payload))).toMatchObject({ source: "TICK_TIMEOUT" });
    expect(dbMock.updates.find((u) => u.data.status === "CLOSED")).toBeUndefined();

    // Self-healing: `running` harus sudah dilepas — tick berikutnya jalan
    // penuh dan posisi berakhir CLOSED (pola fix mirrorInFlight f918498).
    exMock.hangPositionRisk = false;
    await asTickable(watcher).tick();
    expect(dbMock.updates.find((u) => u.data.status === "CLOSED")).toBeDefined();
  });

  it("getUserTrades menggantung di dalam finalize: tick di-timeout, tick berikutnya tetap menutup posisi", async () => {
    const watcher = new LivePositionWatcher({ tickTimeoutMs: 40, snapshotTtlMs: 0 });
    exMock.hangUserTrades = true;

    await asTickable(watcher).tick();
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_WATCHER_TICK_HUNG");
    expect(dbMock.updates.find((u) => u.data.status === "CLOSED")).toBeUndefined();

    exMock.hangUserTrades = false;
    await asTickable(watcher).tick();
    const close = dbMock.updates.find((u) => u.data.status === "CLOSED");
    expect(close).toBeDefined();
    expect(close!.data.closeReason).toBe("SL");
  });

  it("tick gagal biasa tetap DILEMPAR (klasifikasi onTickError tidak berubah), bukan dianggap hang", async () => {
    const watcher = new LivePositionWatcher({ tickTimeoutMs: 1000, snapshotTtlMs: 0 });
    exMock.failPositionRisk = Object.assign(new Error("Binance request failed (HTTP 500)"), { httpStatus: 500 });
    await expect(asTickable(watcher).tick()).rejects.toThrow("HTTP 500");
    expect(dbMock.events.map((e) => e.data.type)).not.toContain("LIVE_WATCHER_TICK_HUNG");
  });
});

describe("Tahap 0 — setiap jalur ter-log dengan alasan (tidak ada lagi yang senyap)", () => {
  it("bukti fill tidak lengkap: deferral dengan alasan spesifik, posisi TIDAK ditutup", async () => {
    const watcher = new LivePositionWatcher({ snapshotTtlMs: 0 });
    exMock.userTrades = []; // tidak ada fill teratribusi

    await asTickable(watcher).tick();

    expect(dbMock.updates.find((u) => u.data.status === "CLOSED")).toBeUndefined();
    expect(dbMock.trades).toHaveLength(0);
    const defer = logMock.warn.find((l) => l.msg === "LIVE_EXIT_ACCOUNTING_DEFERRED");
    expect(defer).toBeDefined();
    expect(defer!.payload).toMatchObject({ positionId: 3240, symbol: "LITUSDT", deferReason: "INCOMPLETE_FILLS", eventWritten: true });
    const ev = dbMock.events.find((e) => e.data.type === "LIVE_EXIT_ACCOUNTING_DEFERRED");
    expect(JSON.parse(String(ev!.data.payload))).toMatchObject({ deferReason: "INCOMPLETE_FILLS" });
  });

  it("error finalisasi: ter-log dengan identitas posisi + fase, lalu dilempar ulang", async () => {
    const watcher = new LivePositionWatcher({ snapshotTtlMs: 0 });
    // Paksa error di fase fetchEvidence; catch internal harus log + lempar ulang.
    vi.spyOn(watcher as never as { fetchExchangeExitEvidence: () => Promise<unknown> }, "fetchExchangeExitEvidence")
      .mockRejectedValue(new Error("simulasi koneksi putus"));
    const internals = watcher as unknown as { finalizeClosedPosition(p: unknown, m: number): Promise<string> };
    await expect(internals.finalizeClosedPosition(litPosition(), 0)).rejects.toThrow("simulasi koneksi putus");
    const errLog = logMock.warn.find((l) => l.msg === "LIVE_EXIT_FINALIZE_ERROR");
    expect(errLog).toBeDefined();
    expect(errLog!.payload).toMatchObject({ positionId: 3240, symbol: "LITUSDT", phase: "fetchEvidence" });
    expect(dbMock.events.map((e) => e.data.type)).toContain("LIVE_EXIT_FINALIZE_ERROR");
  });

  it("posisi sudah ditutup jalur lain: skip dengan alasan STATUS_*, bukan diam", async () => {
    const watcher = new LivePositionWatcher({ snapshotTtlMs: 0 });
    dbMock.positions = [litPosition()];
    dbMock.positions[0]!.status = "CLOSED"; // sudah berubah sejak findMany
    // findMany mengembalikan semua baris; findUnique juga — watcher harus skip.
    await asTickable(watcher).tick();
    const skip = logMock.info.find((l) => l.msg === "LIVE_WATCHER_POS_SKIP");
    expect(skip).toBeDefined();
    expect(skip!.payload.reason).toBe("STATUS_CLOSED");
    expect(dbMock.updates.find((u) => u.data.status === "CLOSED")).toBeUndefined();
  });

  it("backoff rate-limit aktif: skip ter-log dengan alasan RATE_LIMIT_BACKOFF_ACTIVE", async () => {
    const watcher = new LivePositionWatcher({ snapshotTtlMs: 0 });
    asTickable(watcher).onTickError(Object.assign(new Error("Binance request failed (HTTP 429, code -1003)"), { httpStatus: 429 }));
    await asTickable(watcher).tick();
    const skip = logMock.info.find((l) => l.msg === "LIVE_WATCHER_SKIP");
    expect(skip).toBeDefined();
    expect(skip!.payload).toMatchObject({ reason: "RATE_LIMIT_BACKOFF_ACTIVE" });
  });
});
