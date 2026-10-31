// apps/server/tests/positionSupervisor.test.ts - Unit test Supervisor single-target TP (100%), SL statis, funding-aware.
// Perintah operator 30 Sep 2026: TP2, BE (SL-ke-BE), dan TIMEOUT dihapus total dari produksi.
// Test untuk mekanisme tersebut ikut dihapus; yang tersisa hanya TP1, SL, dan FUNDING.
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  PositionSupervisor,
  PositionRepo,
  PositionRow,
  TradeRow,
  createKlineSlGapVerifier,
  type SlGapVerifier,
} from "../src/exec/positionSupervisor.js";
import { OrderExecutor, OrderExecRepo, OrderExecRow, OrderStatus } from "../src/exec/orderExecutor.js";
import { binanceFuturesClient } from "../src/markets/binanceFuturesClient.js";
import { withSwingRr23Attrs } from "../src/strategies/swing/researchExitPolicy.js";
import { estimateFillFeeUsd } from "../src/config/costs.js";

class MemoryPositionRepo implements PositionRepo {
  private positions = new Map<number, PositionRow>();
  private trades = new Map<number, TradeRow>();
  private nextPosId = 1;
  public loggedEvents: Array<{ action: string; symbol: string; payload: Record<string, unknown> }> = [];

  async findOpenPositions(symbol?: string): Promise<PositionRow[]> {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "OPEN" && (!symbol || p.symbol === symbol)
    );
  }

  async findById(id: number): Promise<PositionRow | null> {
    return this.positions.get(id) ?? null;
  }

  async createPosition(data: Omit<PositionRow, "id">): Promise<PositionRow> {
    const pos: PositionRow = { ...data, id: this.nextPosId++ };
    this.positions.set(pos.id, pos);
    return pos;
  }

  async updatePosition(id: number, data: Partial<PositionRow>): Promise<PositionRow> {
    const existing = this.positions.get(id);
    if (!existing) throw new Error("Position not found");
    const updated = { ...existing, ...data };
    this.positions.set(id, updated);
    return updated;
  }

  async createTrade(data: TradeRow): Promise<TradeRow> {
    const trade = { ...data, id: this.trades.size + 1 };
    this.trades.set(trade.positionId, trade);
    return trade;
  }

  async closePositionWithTrade(positionId: number, patch: Partial<PositionRow>, trade: TradeRow): Promise<TradeRow> {
    await this.updatePosition(positionId, patch);
    return this.createTrade(trade);
  }

  async logEvent(action: string, symbol: string, payload: Record<string, unknown>): Promise<void> {
    this.loggedEvents.push({ action, symbol, payload });
  }

  getTrade(positionId: number): TradeRow | undefined {
    return this.trades.get(positionId);
  }
}

class DummyOrderRepo implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, row); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date, execution?: Partial<OrderExecRow>) {
    const r = this.rows.get(id)!;
    const upd = { ...r, status, fillPrice: fillPrice ?? r.fillPrice, feeUsd: feeUsd ?? r.feeUsd, filledAt,
      ...(execution?.filledQty !== undefined ? { filledQty: execution.filledQty } : {}),
      ...(execution?.feeEstimated !== undefined ? { feeEstimated: execution.feeEstimated } : {}),
      ...(execution?.simulated !== undefined ? { simulated: execution.simulated } : {}) };
    this.rows.set(id, upd);
    return upd;
  }
}

describe("versioned PAPER SWING RR23", () => {
  it("RR23: odd qty sends the entire rounded remainder to final 3R (no stranded residual)", async () => {
    const repo = new MemoryPositionRepo();
    const executor = new OrderExecutor({ repo: new DummyOrderRepo(), isArmed: () => false });
    let now = 1_700_000_000_000;
    const supervisor = new PositionSupervisor({ repo, executor, now: () => now, fundingExitEnabled: false });
    const p = await repo.createPosition({ symbol:"BTCUSDT",mode:"SWING",side:"LONG",source:"PAPER_AI",
      entryAttrs:withSwingRr23Attrs(), entryPrice:100,qty:5,originalQty:5,notional:500,leverage:25,marginUsd:20,
      slPrice:90,tp1Price:120,tp2Price:130,originalSlPrice:90,originalRiskUsd:50,quantityStep:1,
      tp1FilledAt:null,tp2FilledAt:null,status:"OPEN",openedAt:new Date(now),closedAt:null,
      closeReason:null,pnlUsd:null,pnlR:null,outlookText:"" } as Parameters<PositionRepo["createPosition"]>[0]);
    now += 1000;
    await supervisor.evaluatePriceTick({symbol:"BTCUSDT",markPrice:120,timestamp:now});
    const afterTp1 = await repo.findById(p.id);
    expect(afterTp1?.qty).toBeCloseTo(3, 6); // 50% floor = 2; remainder stays for final leg
    now += 1000;
    await supervisor.evaluatePriceTick({symbol:"BTCUSDT",markPrice:130,timestamp:now});
    const closed = await repo.findById(p.id);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closeReason).toBe("TP2");
    // 2 lots at TP1 120 + 3 lots at final 130 -> volume-weighted exit 126.
    expect(repo.getTrade(p.id)?.exitAvg).toBeCloseTo(126, 8);
  });

  for (const side of ["LONG", "SHORT"] as const) {
    for (const terminal of ["BE", "TP2"] as const) {
      it(`${side}: fills half at 2R, moves stop to entry, closes runner at ${terminal}`, async () => {
        const repo = new MemoryPositionRepo();
        const executor = new OrderExecutor({ repo: new DummyOrderRepo(), isArmed: () => false });
        let now = 1_700_000_000_000;
        const supervisor = new PositionSupervisor({ repo, executor, now: () => now, fundingExitEnabled: false });
        const hook = vi.fn(); supervisor.setBeMoveHook(hook);
        const sign = side === "LONG" ? 1 : -1;
        const p = await repo.createPosition({ symbol:"BTCUSDT",mode:"SWING",side,source:"PAPER_AI",
          entryAttrs:withSwingRr23Attrs(), entryPrice:100,qty:1,originalQty:1,notional:100,leverage:25,marginUsd:4,
          slPrice:100-sign,tp1Price:100+2*sign,tp2Price:100+3*sign,originalSlPrice:100-sign,originalRiskUsd:1,
          quantityStep:.001,tp1FilledAt:null,tp2FilledAt:null,status:"OPEN",openedAt:new Date(now),closedAt:null,
          closeReason:null,pnlUsd:null,pnlR:null,outlookText:"" } as Parameters<PositionRepo["createPosition"]>[0]);
        now += 1000;
        await supervisor.evaluatePriceTick({symbol:"BTCUSDT",markPrice:100+2*sign,timestamp:now});
        const after = await repo.findById(p.id);
        expect(after?.qty).toBeCloseTo(.5);
        expect(after?.slPrice).toBe(100);
        expect(after?.status).toBe("OPEN");
        expect(hook).not.toHaveBeenCalled(); // This new paper policy cannot invoke exchange replacement.
        now += 1000;
        await supervisor.evaluatePriceTick({symbol:"BTCUSDT",markPrice:terminal === "BE" ? 100 : 100+3*sign,timestamp:now});
        expect((await repo.findById(p.id))?.status).toBe("CLOSED");
        const rrTrade = repo.getTrade(p.id);
        // RR23 v2 (riset 1:3): rMultiple = GROSS price-distance R (1R di BE / 2.5R di TP2) — makna ladder.
        expect(rrTrade?.rMultiple).toBeCloseTo(terminal === "BE" ? 1 : 2.5);
        // pnlUsd = NET (fee penuh dibakar). GROSS = pnlUsd + feeUsd - fundingUsd (rekonstruksi, tanpa double-deduction).
        expect((rrTrade?.pnlUsd ?? 0) + (rrTrade?.feeUsd ?? 0) - (rrTrade?.fundingUsd ?? 0)).toBeCloseTo(terminal === "BE" ? 1 : 2.5);
      });
    }
  }
});

describe("FR-17, FR-18, FR-19: Position Supervisor", () => {
  const dummyExecutor = new OrderExecutor({
    repo: new DummyOrderRepo(),
    isArmed: () => false,
  });

  it("FR-17: TP1 tercapai -> tutup 100% posisi (single target)", async () => {
    const repo = new MemoryPositionRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({
      repo,
      executor: dummyExecutor,
      now: () => mockTime,
    });

    const pos = await repo.createPosition({
      symbol: "BTCUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 60000,
      qty: 0.002,
      notional: 120,
      leverage: 20,
      marginUsd: 6,
      slPrice: 59400,
      tp1Price: 60600,
      tp2Price: 61200,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "Bullish scalp",
    });

    mockTime += 30000;
    const evals = await supervisor.evaluatePriceTick({
      symbol: "BTCUSDT",
      markPrice: 60605,
      timestamp: mockTime,
    });

    expect(evals).toHaveLength(1);
    expect(evals[0].action).toBe("TP1");

    const updatedPos = await repo.findById(pos.id);
    // Single target (29 Sep 2026): TP1 menutup 100%, tidak ada runner / SL->BE.
    expect(updatedPos?.status).toBe("CLOSED");
    expect(updatedPos?.closeReason).toBe("TP1");
    const trade = repo.getTrade(pos.id);
    expect(trade?.win).toBe(true);
  });

  it("SL langsung menyentuh sebelum TP1 -> tutup 100% posisi dan catat loss (-1R)", async () => {
    const repo = new MemoryPositionRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({
      repo,
      executor: dummyExecutor,
      now: () => mockTime,
    });

    const pos = await repo.createPosition({
      symbol: "ETHUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 3000,
      qty: 0.033,
      notional: 100,
      leverage: 20,
      marginUsd: 5,
      slPrice: 2970,
      tp1Price: 3030,
      tp2Price: 3060,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    const evals = await supervisor.evaluatePriceTick({
      symbol: "ETHUSDT",
      markPrice: 2965,
      timestamp: mockTime,
    });

    expect(evals).toHaveLength(1);
    expect(evals[0].action).toBe("SL");

    const closedPos = await repo.findById(pos.id);
    expect(closedPos?.status).toBe("CLOSED");
    expect(closedPos?.closeReason).toBe("SL");
    expect(closedPos?.pnlUsd).toBeLessThan(0);

    const trade = repo.getTrade(pos.id);
    expect(trade?.win).toBe(false);
    expect(trade?.rMultiple).toBeLessThan(0);
    // SL-fill policy (30 Sep 2026): fill DI HARGA SL (2970) — bukan di harga
    // pasar 2965. Loss terkunci ~-1R , tidak melebar karena keterlambatan sampling.
    expect(trade?.exitAvg).toBeCloseTo(2970, 8);
    expect(trade?.rMultiple).toBeGreaterThan(-1.25);
  });

  it("SL sudah 1.41R melewati level (kasus MOVR #1304) -> tetap fill di harga SL, loss ~-1R", async () => {
    const repo = new MemoryPositionRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });

    const pos = await repo.createPosition({
      symbol: "MOVRUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 1.96273389,
      qty: 32.2,
      notional: 63.2,
      leverage: 25,
      marginUsd: 2.53,
      slPrice: 1.9164,
      tp1Price: 2.0632,
      tp1FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    // Dulu ter-fill di 1.85091378 (-2.4R). Sekarang harga 1.41R melewati SL masih < ambang gap 2R.
    const evals = await supervisor.evaluatePriceTick({ symbol: "MOVRUSDT", markPrice: 1.85091378, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(1.9164, 8);
    expect(trade?.rMultiple).toBeGreaterThan(-1.15);
    expect(trade?.rMultiple).toBeLessThan(0);
  });

  it("SL SHORT sudah 0.67R melewati level (kasus KSM #1302) -> tetap fill di harga SL", async () => {
    const repo = new MemoryPositionRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });

    const pos = await repo.createPosition({
      symbol: "KSMUSDT",
      mode: "SCALP",
      side: "SHORT",
      entryPrice: 5.219,
      qty: 15.2,
      notional: 79.33,
      leverage: 25,
      marginUsd: 3.17,
      slPrice: 5.285,
      tp1Price: 5.075,
      tp1FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    // Dulu ter-fill di 5.329 (-1.75R). Sekarang 0.67R overrun -> fill di SL.
    const evals = await supervisor.evaluatePriceTick({ symbol: "KSMUSDT", markPrice: 5.329, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(5.285, 8);
    expect(trade?.rMultiple).toBeGreaterThan(-1.25);
    expect(trade?.rMultiple).toBeLessThan(0);
  });

  it("Fakeout/gap luar biasa (> SL_GAP_OVERRUN_R di luar SL) -> fill di harga pasar + event SL_GAP_FILL", async () => {
    const repo = new MemoryPositionRepo();
    // openedAt +1ms vs fixture ETH lain: id order keluar unik (basis id di-truncate 25 char,
    // qty tak selalu masuk basis — identitas harus dibedakan lewat id/waktu/symbol).
    let mockTime = 1700000000001;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });

    const pos = await repo.createPosition({
      symbol: "ETHUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 3000,
      qty: 0.05,
      notional: 150,
      leverage: 20,
      marginUsd: 7.5,
      slPrice: 2970,
      tp1Price: 3030,
      tp1FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    // Gap4R di bawah SL (setara flash crash) — satu-satunya pengecualian yang diizinkan operator.
    const evals = await supervisor.evaluatePriceTick({ symbol: "ETHUSDT", markPrice: 2880, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(2880, 8);
    expect(trade?.rMultiple).toBeLessThan(-3.5);
    expect(repo.loggedEvents.some((e) => e.action === "SL_GAP_FILL" && e.symbol === "ETHUSDT")).toBe(true);
  });

  // ── Fix 9 Okt 2026 (kasus JCTUSDT #2760): overrun besar WAJIB diverifikasi
  // kline — gap observasi supervisor (level SL diperdagangkan) fill di harga SL,
  // hanya gap pasar sungguhan (bar terbuka melewati SL) yang fill di harga gap.
  const overrunPos = async (repo: MemoryPositionRepo, mockTime: number) =>
    repo.createPosition({
      symbol: "JCTUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 0.002589,
      qty: 23256,
      notional: 60.2,
      leverage: 20,
      marginUsd: 3.01,
      slPrice: 0.002546,
      tp1Price: 0.002654,
      tp1FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

  it("Fix 9 Okt: overrun 5.81R tapi kline menunjukkan SL DIPERDAGANGKAN -> gap observasi, fill DI HARGA SL (-1R)", async () => {
    const repo = new MemoryPositionRepo();
    let mockTime = 1791505125000;
    const verifier: SlGapVerifier = async () => ({ kind: "SL_FILL" });
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime, gapVerifier: verifier });
    const pos = await overrunPos(repo, mockTime);

    // Harga pasar 0.00229628 = overrun 5.81R di luar SL (replika kasus JCTUSDT).
    const evals = await supervisor.evaluatePriceTick({ symbol: "JCTUSDT", markPrice: 0.00229628, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(0.002546, 8);
    expect(trade?.rMultiple).toBeGreaterThan(-1.01);
    expect(trade?.rMultiple).toBeLessThan(-0.99);
    // Fee penuh: pnlUsd = NET. GROSS = -1R (fill di harga SL) = pnlUsd + feeUsd - fundingUsd.
    expect((trade?.pnlUsd ?? 0) + (trade?.feeUsd ?? 0) - (trade?.fundingUsd ?? 0)).toBeCloseTo(-1, 2);
    // Audit: gap observasi tercatat, BUKAN SL_GAP_FILL (gap pasar).
    expect(repo.loggedEvents.some((e) => e.action === "SL_OBSERVATION_GAP_FILL" && e.symbol === "JCTUSDT")).toBe(true);
    expect(repo.loggedEvents.some((e) => e.action === "SL_GAP_FILL")).toBe(false);
  });

  it("Fix 9 Okt: gap pasar SUNGGUHAN (verifier TRUE_GAP) -> fill di harga gap open + event SL_GAP_FILL", async () => {
    const repo = new MemoryPositionRepo();
    // mockTime unik: dummyExecutor (beserta DummyOrderRepo) DIBAGI antar-test di
    // describe ini; basis clientOrderId memakai id+waktu+symbol+side+entry+qty,
    // sehingga fixture identik dengan waktu sama akan menabrak order test lain
    // dan fill lama ter-daur ulang (preseden fixture ETHUSDT +1ms).
    let mockTime = 1791505126000;
    const verifier: SlGapVerifier = async () => ({ kind: "TRUE_GAP", gapOpenPrice: 0.0024 });
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime, gapVerifier: verifier });
    const pos = await overrunPos(repo, mockTime);

    const evals = await supervisor.evaluatePriceTick({ symbol: "JCTUSDT", markPrice: 0.00229628, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(0.0024, 8);
    expect(repo.loggedEvents.some((e) => e.action === "SL_GAP_FILL" && e.symbol === "JCTUSDT")).toBe(true);
  });

  it("Fix 9 Okt: verifier UNKNOWN (kline tak tersedia) -> fail-closed fill DI HARGA SL", async () => {
    const repo = new MemoryPositionRepo();
    // mockTime unik (lihat catatan fixture TRUE_GAP: order id tidak boleh tabrakan).
    let mockTime = 1791505127000;
    const verifier: SlGapVerifier = async () => ({ kind: "UNKNOWN" });
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime, gapVerifier: verifier });
    const pos = await overrunPos(repo, mockTime);

    const evals = await supervisor.evaluatePriceTick({ symbol: "JCTUSDT", markPrice: 0.00229628, timestamp: mockTime });
    expect(evals[0].action).toBe("SL");

    const trade = repo.getTrade(pos.id);
    expect(trade?.exitAvg).toBeCloseTo(0.002546, 8);
    expect(repo.loggedEvents.some((e) => e.action === "SL_GAP_FILL")).toBe(false);
  });

  it("Fix 9 Okt: createKlineSlGapVerifier membedakan bar open-di-dalam-range vs gap open", async () => {
    const longCase = createKlineSlGapVerifier(async () => [
      // Bar 1: SL 0.002546 berada DI DALAM range bar (open >= SL, low <= SL)
      // -> level SL diperdagangkan -> SL_FILL (gap observasi).
      [1, 0.00258, 0.0026, 0.00242, 0.00245, 1000],
      [2, 0.00245, 0.0025, 0.00217, 0.0023, 9999],
    ]);
    expect(await longCase("JCTUSDT", "LONG", 0.002546, 0)).toEqual({ kind: "SL_FILL" });

    const gapCase = createKlineSlGapVerifier(async () => [
      // Bar pertama yang melewati SL TERBUKA sudah di bawah SL -> gap sungguhan
      // -> TRUE_GAP di harga open bar itu.
      [1, 0.0024, 0.00245, 0.00217, 0.0023, 9999],
    ]);
    expect(await gapCase("JCTUSDT", "LONG", 0.002546, 0)).toEqual({ kind: "TRUE_GAP", gapOpenPrice: 0.0024 });

    const shortCase = createKlineSlGapVerifier(async () => [
      // SHORT: high bar menembus SL di atas sementara open masih di bawahnya -> SL_FILL.
      [1, 5.2, 5.35, 5.18, 5.3, 1000],
    ]);
    expect(await shortCase("KSMUSDT", "SHORT", 5.285, 0)).toEqual({ kind: "SL_FILL" });

    const emptyCase = createKlineSlGapVerifier(async () => []);
    expect(await emptyCase("JCTUSDT", "LONG", 0.002546, 0)).toEqual({ kind: "UNKNOWN" });

    const failCase = createKlineSlGapVerifier(async () => { throw new Error("rest down"); });
    expect(await failCase("JCTUSDT", "LONG", 0.002546, 0)).toEqual({ kind: "UNKNOWN" });
  });

  it("FR-19: Posisi dengan adverse funding rate dalam 10 menit -> auto-close FUNDING", async () => {
    const repo = new MemoryPositionRepo();
    const mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({
      repo,
      executor: dummyExecutor,
      now: () => mockTime,
    });

    const pos = await repo.createPosition({
      symbol: "SOLUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 150,
      qty: 0.6,
      notional: 90,
      leverage: 20,
      marginUsd: 4.5,
      slPrice: 147,
      tp1Price: 153,
      tp2Price: 159,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(mockTime - 3600000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    const evals = await supervisor.evaluateFunding(
      {
        symbol: "SOLUSDT",
        fundingRate: 0.0005,
        nextFundingTime: mockTime + 8 * 60 * 1000,
      },
      151.5
    );

    expect(evals).toHaveLength(1);
    expect(evals[0].action).toBe("FUNDING");

    const closedPos = await repo.findById(pos.id);
    expect(closedPos?.status).toBe("CLOSED");
    expect(closedPos?.closeReason).toBe("FUNDING");
  });

  it("GET /api/positions dan GET /api/trades merespons JSON dengan benar", async () => {
    const app = createApp();
    const posRes = await request(app).get("/api/positions").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(Array.isArray(posRes.body.positions)).toBe(true);

    const tradesRes = await request(app).get("/api/trades").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(Array.isArray(tradesRes.body.trades)).toBe(true);
  });
});

// 30 Sep 2026: exit TP2/BE/TIMEOUT dihapus total dari produksi.
// Trade hanya boleh tutup via TP (single target 100%), SL, FUNDING, atau KILL manual.
// ── 15 Okt 2026 — LADDER TP SWING (perintah operator: "40/30/BE sisanya TP max") ──
// SWING: TP1 (LIMIT, 40%) -> TP2 (LIMIT, 30%, lalu SL pindah BE) -> sisa 30%
// jalan ke TPmax. SCALP: tetap single-target walau tp2Price terisi.
describe("Ladder TP SWING 40/30/BE/TPmax (15 Okt 2026)", () => {
  const dummyExecutor = new OrderExecutor({ repo: new DummyOrderRepo(), isArmed: () => false });
  function makeLadderRepo() { return new MemoryPositionRepo(); }

  it("TP1 menutup 40% (qty 1 -> 0.6), posisi tetap OPEN", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    // LONG entry 100, SL 90 (R=10): TP1 = 116.6667, TP2 = 133.3333, TPmax = 150
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SWING", side: "LONG",
      entryPrice: 100, qty: 1, notional: 100, leverage: 5, marginUsd: 20,
      slPrice: 90, tp1Price: 100 + (10 * 5) / 3, tp2Price: 100 + (10 * 10) / 3,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
      originalSlPrice: 90, originalRiskUsd: 10, quantityStep: 0.0001,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    mockTime += 30_000;
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 117, timestamp: mockTime });
    expect(evals[0]!.action).toBe("TP1");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("OPEN");
    expect(after?.qty).toBeCloseTo(0.6, 6);
    expect(after?.tp1FilledAt).not.toBeNull();
    // Fee penuh: realizedPnlUsd (interim) = NET = gross - fee TP1 (LIMIT maker).
    const gross40 = 0.4 * (116.66666666666667 - 100);
    const tp1Fee40 = estimateFillFeeUsd({ qty: 0.4, price: 116.66666666666667, isMaker: true });
    expect(after?.realizedPnlUsd).toBeCloseTo(gross40 - tp1Fee40, 4);
  });

  it("TP2 menutup 30% lalu SL pindah ke BE (entry); sisa 0.3", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SWING", side: "LONG",
      entryPrice: 100, qty: 1, notional: 100, leverage: 5, marginUsd: 20,
      slPrice: 90, tp1Price: 100 + (10 * 5) / 3, tp2Price: 100 + (10 * 10) / 3,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
      originalSlPrice: 90, originalRiskUsd: 10, quantityStep: 0.0001,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 117, timestamp: mockTime });
    mockTime += 30_000;
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 134, timestamp: mockTime });
    expect(evals[0]!.action).toBe("TP2");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("OPEN");
    expect(after?.qty).toBeCloseTo(0.3, 6);
    expect(after?.slPrice).toBe(100); // BE
    const beEvent = repo.loggedEvents.find((e) => e.action === "SL_MOVED_BE");
    expect(beEvent).toBeDefined();
  });

  it("beMoveHook memakai sisa qty setelah TP2; kegagalan mempertahankan SL DB lama", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    const seen: number[] = [];
    supervisor.setBeMoveHook(async (pos) => {
      seen.push(pos.id);
      expect(pos.qty).toBeCloseTo(0.3, 6);
      if (seen.length === 1) throw new Error("SIMULATED_LIVE_FAIL"); // panggilan pertama gagal
    });
    const mk = () => ({
      symbol: "BTCUSDT", mode: "SWING", side: "LONG",
      entryPrice: 100, qty: 1, notional: 100, leverage: 5, marginUsd: 20,
      slPrice: 90, tp1Price: 100 + (10 * 5) / 3, tp2Price: 100 + (10 * 10) / 3,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
      originalSlPrice: 90, originalRiskUsd: 10, quantityStep: 0.0001,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    // Posisi A: hook gagal -> TP2 tetap sukses, event SL_MOVED_BE_LIVE_FAILED.
    const a = await repo.createPosition(mk());
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 117, timestamp: mockTime });
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 134, timestamp: mockTime });
    const afterA = await repo.findById(a.id);
    expect(afterA?.qty).toBeCloseTo(0.3, 6);
    expect(afterA?.slPrice).toBe(90); // tidak mengklaim BE yang gagal di exchange
    expect(repo.loggedEvents.some((e) => e.action === "SL_MOVED_BE_LIVE_FAILED")).toBe(true);
    expect(seen.length).toBe(1);
  });

  it("Sisa 30% tutup penuh di TPmax dengan closeReason TPMAX", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SWING", side: "LONG",
      entryPrice: 100, qty: 1, notional: 100, leverage: 5, marginUsd: 20,
      slPrice: 90, tp1Price: 100 + (10 * 5) / 3, tp2Price: 100 + (10 * 10) / 3,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
      originalSlPrice: 90, originalRiskUsd: 10, quantityStep: 0.0001,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 117, timestamp: mockTime });
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 134, timestamp: mockTime });
    mockTime += 30_000;
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 151, timestamp: mockTime });
    expect(evals[0]!.action).toBe("TPMAX");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("TPMAX");
    const trade = repo.getTrade(pos.id);
    expect(trade).toBeDefined();
    expect(trade?.win).toBe(true);
  });

  it("Setelah BE, retrace ke entry menutup sisa via SL (tanpa rugi tambahan)", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SWING", side: "LONG",
      entryPrice: 100, qty: 1, notional: 100, leverage: 5, marginUsd: 20,
      slPrice: 90, tp1Price: 100 + (10 * 5) / 3, tp2Price: 100 + (10 * 10) / 3,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", originalQty: 1,
      originalSlPrice: 90, originalRiskUsd: 10, quantityStep: 0.0001,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 117, timestamp: mockTime });
    mockTime += 30_000;
    await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 134, timestamp: mockTime });
    mockTime += 30_000;
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 99.9, timestamp: mockTime });
    expect(evals[0]!.action).toBe("SL");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("SL");
    expect(after?.slPrice).toBe(100); // fill BE
    const trade = repo.getTrade(pos.id);
    // 40%@+16.67 + 30%@+33.33 - 30%@-0.01... total tetap profit
    expect(trade?.win).toBe(true);
  });

  it("SCALP tetap single-target walau tp2Price != tp1Price (regresi)", async () => {
    const repo = makeLadderRepo();
    let mockTime = 1700000000000;
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => mockTime });
    const pos = await repo.createPosition({
      symbol: "BTCUSDT", mode: "SCALP", side: "LONG",
      entryPrice: 60000, qty: 0.002, notional: 120, leverage: 20, marginUsd: 6,
      slPrice: 59400, tp1Price: 60600, tp2Price: 61200,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "",
    });
    mockTime += 30_000;
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 60605, timestamp: mockTime });
    expect(evals[0]!.action).toBe("TP1");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("TP1");
  });
});

describe("Fix lanjutan #3177 (16 Okt 2026): TP paper tersentuh sebelum order exit dibuat tetap close 40%", () => {
  const OPEN_MS = 1700000000000;

  async function makePaperLadder(verifierTouched: boolean, seenSince: number[]) {
    const repo = new MemoryPositionRepo();
    const executor = new OrderExecutor({
      repo: new DummyOrderRepo(),
      isArmed: () => false,
      paperTouchVerifier: async (_s, _p, _side, sinceMs) => {
        seenSince.push(sinceMs);
        return verifierTouched;
      },
    });
    let mockTime = OPEN_MS;
    const supervisor = new PositionSupervisor({ repo, executor, now: () => mockTime });
    // Kline 1m membuktikan level TP1 benar-benar diperdagangkan (wick intrabar).
    vi.spyOn(binanceFuturesClient, "fetchKlines").mockResolvedValue([
      [mockTime, "0.97", "0.965", "0.9583", "0.961", "0", 0, 0, 0, "0", "0", "0"],
    ] as never);
    const pos = await repo.createPosition({
      symbol: "SUIUSDT", mode: "SWING", side: "SHORT",
      entryPrice: 1.0016, qty: 41.2, notional: 41.27, leverage: 25, marginUsd: 1.65,
      slPrice: 1.0259, tp1Price: 0.9602, tp2Price: 0.9206,
      tp1FilledAt: null, tp2FilledAt: null, status: "OPEN",
      openedAt: new Date(mockTime), closedAt: null, closeReason: null,
      pnlUsd: null, pnlR: null, outlookText: "", source: "PAPER_AI",
      originalQty: 41.2, originalSlPrice: 1.0259, originalRiskUsd: 41.2 * 0.0243, quantityStep: 0.1,
    } as unknown as Parameters<PositionRepo["createPosition"]>[0]);
    return { repo, supervisor, pos, advance: (ms: number) => (mockTime += ms) };
  }

  it("bukti sentuhan sejak openedAt -> TP1 LIMIT terisi di harga level, sisa 60% tetap OPEN", async () => {
    const seenSince: number[] = [];
    const { repo, supervisor, pos, advance } = await makePaperLadder(true, seenSince);
    advance(30_000);
    const evals = await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9602, timestamp: OPEN_MS + 30_000 });
    expect(evals[0]!.action).toBe("TP1");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("OPEN");
    expect(after?.qty).toBeCloseTo(24.8, 6); // 41.2 - 16.4 (40% floor ke step 0.1)
    expect(after?.tp1FilledAt).not.toBeNull();
    expect(after?.tp1FillPrice).toBeCloseTo(0.9602, 6);
    // Bukti sentuhan dihitung sejak posisi dibuka, bukan sejak order dibuat.
    expect(seenSince[0]).toBe(OPEN_MS);
    vi.restoreAllMocks();
  });

  it("tanpa bukti sentuhan: fail-closed — TP1 tidak diisi, qty tidak berubah", async () => {
    const seenSince: number[] = [];
    const { repo, supervisor, pos, advance } = await makePaperLadder(false, seenSince);
    advance(30_000);
    const evals = await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9602, timestamp: OPEN_MS + 30_000 });
    expect(evals[0]!.action).toBe("NONE");
    const after = await repo.findById(pos.id);
    expect(after?.qty).toBeCloseTo(41.2, 6);
    expect(after?.tp1FilledAt).toBeNull();
    vi.restoreAllMocks();
  });

  it("fix pembulatan: tick ulang di TP1 setelah fase penuh TIDAK menutup runner (qty tetap 60%)", async () => {
    const seenSince: number[] = [];
    const { repo, supervisor, pos, advance } = await makePaperLadder(true, seenSince);
    advance(30_000);
    await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9602, timestamp: OPEN_MS + 30_000 });
    expect((await repo.findById(pos.id))?.qty).toBeCloseTo(24.8, 6);
    // Tick kedua di level yang sama: target fase 16.4 (floor) SUDAH penuh —
    // residu 0.08 dari 16.48 tidak boleh didegradasi jadi full-close.
    advance(5_000);
    const evals2 = await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9602, timestamp: OPEN_MS + 35_000 });
    expect(evals2[0]!.action).toBe("NONE");
    const after = await repo.findById(pos.id);
    expect(after?.status).toBe("OPEN");
    expect(after?.qty).toBeCloseTo(24.8, 6);
    vi.restoreAllMocks();
  });

  it("ladder penuh 40/30/30: TP1 -> TP2 (+SL ke BE) -> TPmax menutup sisa", async () => {
    const seenSince: number[] = [];
    const { repo, supervisor, pos, advance } = await makePaperLadder(true, seenSince);
    advance(30_000);
    await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9602, timestamp: OPEN_MS + 30_000 });
    let after = await repo.findById(pos.id);
    expect(after?.qty).toBeCloseTo(24.8, 6); // 40% di TP1

    advance(5_000);
    const evals2 = await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.9206, timestamp: OPEN_MS + 35_000 });
    expect(evals2[0]!.action).toBe("TP2");
    after = await repo.findById(pos.id);
    expect(after?.qty).toBeCloseTo(12.5, 6); // 30% di TP2
    expect(after?.slPrice).toBeCloseTo(1.0016, 6); // SL -> BE

    advance(5_000);
    const evals3 = await supervisor.evaluatePriceTick({ symbol: "SUIUSDT", markPrice: 0.877, timestamp: OPEN_MS + 40_000 });
    expect(evals3[0]!.action).toBe("TPMAX");
    after = await repo.findById(pos.id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.closeReason).toBe("TPMAX");
    // (1.0016-0.9602)*16.4 + (1.0016-0.9206)*12.3 + (1.0016-0.8774)*12.5
    // = 0.67896 + 0.99630 + 1.55250
    // Fee penuh: realizedPnlUsd = NET; GROSS 40/30/30 = 3.22776 direkonstruksi via feeUsd.
    const ladderTrade = repo.getTrade(pos.id);
    expect((ladderTrade?.pnlUsd ?? 0) + (ladderTrade?.feeUsd ?? 0) - (ladderTrade?.fundingUsd ?? 0)).toBeCloseTo(3.22776, 4);
    vi.restoreAllMocks();
  });
});
