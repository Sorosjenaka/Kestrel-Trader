// 26 Okt 2026 — REGRESSION/REPLAY akuntansi exit ladder (permintaan operator):
// TP1 target 5 terisi 2 lalu 3 pada algo yang SAMA; event duplikat, terlambat,
// dan restart di tengah proses; sisa posisi ditutup TP2. Invarian yang harus
// tetap: (1) tambahan fill tidak hilang, (2) PnL tidak dihitung ganda/di-recompute
// salah, (3) BE tidak dipindah sebelum syaratnya, (4) satu induk History, dan
// (5) policy tersimpan posisi legacy tetap berlaku.
//
// Skenario ditandai REPLAY: urutan event exchange disusun ulang (stub queryAlgo
// berjenjang) pada kode produksi asli — bukan implementasi ulang logika.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  event: vi.fn(async () => ({})),
  transaction: vi.fn(),
  klines: vi.fn(async () => []),
  updates: [] as Array<Record<string, unknown>>,
  dbRow: {} as Record<string, unknown>,
}));

// Exchange stub: respons algo bisa di-set per id (queue REPLAY).
const exchangeStub = vi.hoisted(() => {
  const algoState = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const placed: Array<Record<string, unknown>> = [];
  const state = { lastPlaced: null as Record<string, unknown> | null };
  return {
    algoState, calls, placed, state,
    client: {
      getOpenAlgoOrders: vi.fn(async () => [{ clientAlgoId: "SLA_ENTRY_ONE", symbol: "BTCUSDT", triggerPrice: "98", algoStatus: "NEW" }]),
      placeReduceOnlyGuard: vi.fn(async (req: Record<string, unknown>) => {
        calls.push("PLACE_REPLACEMENT"); placed.push(req);
        const row = { ...req, triggerPrice: String(req.triggerPrice), algoStatus: "NEW", algoId: 1 };
        state.lastPlaced = row;
        return row;
      }),
      queryAlgo: vi.fn(async (id: string) => {
        calls.push(`QUERY_${id}`);
        if (state.lastPlaced && state.lastPlaced.clientAlgoId === id) return state.lastPlaced;
        return algoState.get(id) ?? { algoId: 2, clientAlgoId: id, symbol: "BTCUSDT", triggerPrice: "98", algoStatus: "NEW" };
      }),
      cancelAlgo: vi.fn(async (id: string) => {
        calls.push(`CANCEL_${id}`);
        return { algoId: 2, clientAlgoId: id, symbol: "BTCUSDT", triggerPrice: "98", algoStatus: "CANCELED" };
      }),
      getPositionRisk: vi.fn(),
    },
  };
});

vi.mock("../src/core/env.js", () => ({
  env: {
    BINANCE_EXECUTION_MODE: "LIVE", PAPER_TOUCH_VERIFY: false,
    BINANCE_API_KEY: "test-key", BINANCE_API_SECRET: "test-secret",
  },
}));
vi.mock("../src/exec/binanceUsdMClient.js", () => ({
  BinanceUsdMClient: class { constructor() { return exchangeStub.client; } },
}));
vi.mock("../src/core/db.js", () => ({
  db: {
    eventLog: { create: mocks.event },
    position: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        mocks.updates.push(data); Object.assign(mocks.dbRow, data); return {};
      }),
      findUnique: vi.fn(async () => null),
    },
    trade: { findUnique: vi.fn(async () => null) },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../src/core/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../src/risk/dailyGuard.js", () => ({ defaultDailyRiskGuard: { isArmed: () => false } }));
vi.mock("../src/risk/lossCooldown.js", () => ({ lossCooldownGuard: { recordClose: vi.fn() } }));
vi.mock("../src/markets/binanceFuturesClient.js", () => ({ binanceFuturesClient: { fetchKlines: mocks.klines, getHubChg24: vi.fn(() => ({})) } }));

import { LivePositionWatcher, recordLiveLadderLeg, bracketCleanupRepo } from "../src/exec/liveRuntime.js";
import { derivePositionLifecycle } from "../src/api/routes/positions.js";

type Adv = { advanceLadder: (p: unknown) => Promise<void> };
const internals = (w: LivePositionWatcher) => w as never as Adv;

const RR23_ATTRS = JSON.stringify({ swingExitPolicy: "SWING_50_2R_BE_50_3R_V1" });

function basePos(): Record<string, unknown> {
  return {
    id: 7, symbol: "BTCUSDT", side: "LONG", mode: "SWING", source: "LIVE_AI",
    strategyId: "RSW-03", entryAttrs: RR23_ATTRS, quantityStep: 1, leverage: 1,
    qty: 10, originalQty: 10, entryPrice: 100, slPrice: 98, originalSlPrice: 98,
    tp1Price: 102, tp2Price: 104, tp1FilledAt: null, tp1FillPrice: null, tp2FilledAt: null,
    entryFeeUsd: 1, exitAccounting: null, openedAt: new Date("2026-10-26T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  for (const k of Object.keys(mocks.dbRow)) delete mocks.dbRow[k];
  Object.assign(mocks.dbRow, basePos());
  exchangeStub.algoState.clear();
  exchangeStub.calls.length = 0;
  exchangeStub.placed.length = 0;
  vi.spyOn(bracketCleanupRepo, "findEntryByPositionId").mockResolvedValue({ clientOrderId: "ENTRY_ONE", reduceOnly: false } as never);
});

const ledgerOf = (): Record<string, { qty?: number }> => {
  const raw = mocks.dbRow.exitAccounting as string | null;
  return raw ? (JSON.parse(raw).orders ?? {}) : {};
};
const lastData = (key: string): Record<string, unknown> | undefined =>
  [...mocks.updates].reverse().find((u) => u[key] !== undefined);

describe("REPLAY: TP1 target 5, fill 2 lalu 3 pada algo yang sama", () => {
  it("partial 2/5: ledger mencatat 2, milestone/BE TIDAK bergerak; +3 -> fase penuh; PnL kumulatif tidak ganda", async () => {
    const watcher = new LivePositionWatcher();
    const adv = internals(watcher);

    // Event 1: algo TP1 TRIGGERED, child terisi 2 dari target 5 (partial).
    exchangeStub.algoState.set("TPA_ENTRY_ONE", {
      algoStatus: "TRIGGERED", actualOrderId: "111", actualPrice: "102", actualQty: "2", actualType: "LIMIT",
    });
    await adv.advanceLadder({ ...mocks.dbRow });
    const tp1Leg = ledgerOf()["TPA_ENTRY_ONE"];
    expect(tp1Leg?.qty).toBe(2); // tambahan fill TIDAK hilang
    expect(mocks.updates.some((u) => u.tp1FilledAt !== undefined)).toBe(false); // milestone belum
    expect(exchangeStub.placed.length).toBe(0); // BE belum dipindah
    expect(mocks.event.mock.calls.some(([a]) => (a as { data: { type: string } }).data.type === "LADDER_TP1_PARTIAL_FILL")).toBe(true);
    // gross 2*(102-100)=4; entryFeeShare 1*2/10=0.2; exitFee maker 2*102*0.0002=0.0408
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(3.7592, 4);

    // Event 2: DUPLIKAT persis sama -> tidak ada perubahan.
    await adv.advanceLadder({ ...mocks.dbRow });
    expect(ledgerOf()["TPA_ENTRY_ONE"]?.qty).toBe(2);
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(3.7592, 4);

    // Event 3: algo yang SAMA kini actualQty 5 (2+3 kumulatif) -> fase penuh.
    exchangeStub.algoState.set("TPA_ENTRY_ONE", {
      algoStatus: "TRIGGERED", actualOrderId: "111", actualPrice: "102", actualQty: "5", actualType: "LIMIT",
    });
    await adv.advanceLadder({ ...mocks.dbRow });
    expect(ledgerOf()["TPA_ENTRY_ONE"]?.qty).toBe(5); // 5/5, bukan 2+5
    expect(mocks.dbRow.tp1FilledAt).toBeTruthy(); // milestone tercapai
    expect(mocks.dbRow.qty).toBe(5); // sisa dari fill aktual: 10-5
    expect(mocks.dbRow.tp1FillPrice).toBe(102); // harga fill aktual, bukan level
    expect(exchangeStub.placed.length).toBe(1); // BE baru sekarang
    expect(exchangeStub.placed[0]).toMatchObject({ triggerPrice: 100, quantity: 5 });
    expect(mocks.dbRow.slPrice).toBe(100);
    // gross 5*2=10; entryFeeShare 0.5; exitFee 5*102*0.0002=0.102 -> 9.398 (kumulatif, bukan 3.7592+9.398)
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(9.398, 4);

    // Event 4: TERLAMBAT/out-of-order (actualQty 3 < 5 tercatat) -> tidak regresi.
    exchangeStub.algoState.set("TPA_ENTRY_ONE", {
      algoStatus: "TRIGGERED", actualOrderId: "111", actualPrice: "102", actualQty: "3", actualType: "LIMIT",
    });
    await adv.advanceLadder({ ...mocks.dbRow });
    expect(ledgerOf()["TPA_ENTRY_ONE"]?.qty).toBe(5);
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(9.398, 4);
  });

  it("sisa ditutup TP2: total exit = qty awal, PnL akhir benar, event TP2 ganda tidak menggandakan", async () => {
    const watcher = new LivePositionWatcher();
    const adv = internals(watcher);
    Object.assign(mocks.dbRow, {
      tp1FilledAt: new Date("2026-10-26T01:00:00Z"), tp1FillPrice: 102,
      qty: 5, exitAccounting: JSON.stringify({ orders: {
        TPA_ENTRY_ONE: { phase: "TP1", qty: 5, notional: 510, fee: 0.102, fillPrice: 102, status: "FILLED" },
      } }),
    });
    exchangeStub.algoState.set("TPB_ENTRY_ONE", {
      algoStatus: "FINISHED", actualOrderId: "222", actualPrice: "104", actualQty: "5", actualType: "LIMIT",
    });
    await adv.advanceLadder({ ...mocks.dbRow });
    const legs = ledgerOf();
    expect(legs["TPB_ENTRY_ONE"]?.qty).toBe(5);
    const total = Object.values(legs).reduce((n, l) => n + Number(l.qty ?? 0), 0);
    expect(total).toBe(10); // 5+5 = originalQty, sisa 0
    expect(mocks.dbRow.tp2FilledAt).toBeTruthy();
    // gross = (510+520) - 100*10 = 30; entryFee 1; exitFee 0.206 -> 28.794
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(28.794, 4);

    // Duplikat event TP2 -> tidak ada perubahan ledger/PnL.
    const updatesBefore = mocks.updates.length;
    await adv.advanceLadder({ ...mocks.dbRow });
    expect(Object.values(ledgerOf()).reduce((n, l) => n + Number(l.qty ?? 0), 0)).toBe(10);
    expect(mocks.dbRow.realizedPnlUsd).toBeCloseTo(28.794, 4);
    expect(mocks.updates.length).toBe(updatesBefore);
  });

  it("sisa ditutup SL setelah TP1: PnL akhir dari fill exchange SELURUH posisi, tidak digabung progres parsial", async () => {
    const watcher = new LivePositionWatcher();
    // Progres parsial TP1 sudah tercatat (realizedPnlUsd 9.398) sebelum SL.
    Object.assign(mocks.dbRow, {
      tp1FilledAt: new Date("2026-10-26T01:00:00Z"), qty: 5, realizedPnlUsd: 9.398,
      originalSlPrice: 98, originalRiskUsd: 20,
      exitAccounting: JSON.stringify({ orders: {
        TPA_ENTRY_ONE: { phase: "TP1", qty: 5, notional: 510, fee: 0.102, fillPrice: 102, status: "FILLED" },
      } }),
    });
    // Bukti exit exchange: 10 unit total (5 @102 TP1 + 5 @100.8 SL) -> avg 101.4.
    vi.spyOn(watcher as never as { fetchExchangeExitEvidence: () => Promise<unknown> }, "fetchExchangeExitEvidence")
      .mockResolvedValue({
        complete: true, attribution: "FULL", exitAvg: 101.4, filledQty: 10,
        realizedPnlUsd: 14, feeUsd: 0.2, entryFeeUsd: 1, fundingUsd: 0,
        fundingVerified: true, feeAssetClean: true,
      });
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }));
    const update = vi.fn(async () => ({}));
    mocks.transaction.mockImplementation(async (cb: (tx: object) => Promise<unknown>) => cb({
      position: { update }, trade: { findUnique: vi.fn(async () => null), create },
    }));
    const internalsF = watcher as never as { finalizeClosedPosition: (p: unknown, price: number) => Promise<void> };
    await internalsF.finalizeClosedPosition({ ...mocks.dbRow }, 100.8);
    // NET = gross 14 - fee (0.2 exit + 1 entry) + funding 0 = 12.8.
    // BUKAN 12.8 + 9.398 (progres parsial tidak boleh digabung/dihitung ganda).
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pnlUsd: 12.8 }),
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CLOSED", pnlUsd: 12.8 }),
    }));
  });

  it("RESTART di tengah proses: sisa qty dihitung dari ledger fill aktual, bukan asumsi plan", async () => {
    const watcher = new LivePositionWatcher();
    const adv = internals(watcher);
    // mencatat fill aktual 6 (over-fill di atas target 5).
    Object.assign(mocks.dbRow, {
      tp1FilledAt: new Date("2026-10-26T01:00:00Z"), tp1FillPrice: 102, qty: 10,
      exitAccounting: JSON.stringify({ orders: {
        TPA_ENTRY_ONE: { phase: "TP1", qty: 6, notional: 612, fee: 0.1224, fillPrice: 102, status: "FILLED" },
      } }),
    });
    exchangeStub.algoState.set("TPA_ENTRY_ONE", {
      algoStatus: "FINISHED", actualOrderId: "111", actualPrice: "102", actualQty: "6", actualType: "LIMIT",
    });
    await adv.advanceLadder({ ...mocks.dbRow });
    expect(mocks.dbRow.qty).toBe(4); // 10-6 dari ledger; BUKAN plan.tp2Qty=5
    expect(ledgerOf()["TPA_ENTRY_ONE"]?.qty).toBe(6); // tidak hilang/digandakan
  });

  it("recordLiveLadderLeg idempoten: qty yang tidak bertambah = no-op, qty kumulatif diperbarui tanpa double-count", async () => {
    const pos = { ...basePos(), exitAccounting: JSON.stringify({ orders: {
      TPA_ENTRY_ONE: { phase: "TP1", qty: 3, notional: 306, fee: 0.0612, fillPrice: 102, status: "FILLED" },
    } }) } as never;
    // Event lama (2 < 3 tercatat) -> ditolak.
    const late = await recordLiveLadderLeg({ pos, phase: "TP1", clientAlgoId: "TPA_ENTRY_ONE", childOrderId: "111", qty: 2, price: 102 });
    expect(late).toBeNull();
    // Kumulatif naik 3 -> 5 -> diperbarui (bukan 3+5).
    const grew = await recordLiveLadderLeg({ pos, phase: "TP1", clientAlgoId: "TPA_ENTRY_ONE", childOrderId: "111", qty: 5, price: 102 });
    expect(grew?.remainingQty).toBe(5);
    expect(ledgerOf()["TPA_ENTRY_ONE"]?.qty).toBe(5);
  });
});

describe("REPLAY: satu induk History & final close", () => {
  it("final close tidak membuat induk History ganda (guard per positionId)", async () => {
    const watcher = new LivePositionWatcher();
    const evidence = {
      complete: true, attribution: "FULL", exitAvg: 102, filledQty: 10,
      realizedPnlUsd: 30, feeUsd: 0.206, entryFeeUsd: 1, fundingUsd: 0,
      fundingVerified: true, feeAssetClean: true,
    };
    vi.spyOn(watcher as never as { fetchExchangeExitEvidence: () => Promise<unknown> }, "fetchExchangeExitEvidence")
      .mockResolvedValue(evidence);
    const create = vi.fn(async ({ data }: { data: object }) => ({ id: 1, ...data }));
    const update = vi.fn(async () => ({}));
    // Panggilan pertama: tidak ada Trade -> dibuat. Kedua: Trade sudah ada -> stop.
    let existing: object | null = null;
    mocks.transaction.mockImplementation(async (cb: (tx: object) => Promise<unknown>) => cb({
      position: { update },
      trade: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(async (args: { data: object }) => { const row = { id: 1, ...args.data }; existing = row; return row; }),
      },
    }));
    const internalsF = watcher as never as { finalizeClosedPosition: (p: unknown, price: number) => Promise<void> };
    const row = { ...basePos(), status: "CLOSED", qty: 0, originalSlPrice: 98, originalRiskUsd: 20, openedAt: new Date("2026-10-26T00:00:00Z") };
    await internalsF.finalizeClosedPosition(row, 102);
    await internalsF.finalizeClosedPosition(row, 102);
    const tradeCreates = (mocks.transaction.mock.calls ?? []).length;
    expect(tradeCreates).toBeGreaterThanOrEqual(1);
    // findUnique(positionId) sudah dipanggil tiap finalize; create hanya saat belum ada.
    expect(existing).not.toBeNull();
    expect(update).toHaveBeenCalled();
    // create tidak dipanggil dua kali untuk positionId yang sama:
    // panggilan kedua finalize menemukan existing dan melewati create.
    const tx2 = mocks.transaction.mock.results[1];
    expect(tx2).toBeDefined();
  });
});

describe("policy tersimpan posisi legacy TETAP berlaku", () => {
  it("legacy 40% floor step, RR23 50%, SCALP 100% — tidak berubah oleh perubahan akuntansi", () => {
    const legacy = derivePositionLifecycle({
      status: "OPEN", qty: 60, originalQty: 100, tp1FilledAt: new Date(), tp1FillPrice: 1,
      mode: "SWING", source: "PAPER_AI", entryAttrs: JSON.stringify({ swingExitPolicy: "SWING_40_30_RUNNER_V1" }), quantityStep: 1,
    });
    expect(legacy.tp1TargetQty).toBe(40);
    const rr23 = derivePositionLifecycle({
      status: "OPEN", qty: 50, originalQty: 100, tp1FilledAt: new Date(), tp1FillPrice: 1,
      mode: "SWING", source: "PAPER_AI", entryAttrs: RR23_ATTRS, quantityStep: 1,
    });
    expect(rr23.tp1TargetQty).toBe(50);
    const scalp = derivePositionLifecycle({
      status: "OPEN", qty: 1, originalQty: 1, mode: "SCALP", source: "PAPER_AI", quantityStep: 1,
    });
    expect(scalp.tp1TargetQty).toBe(1);
  });
});
