// apps/server/tests/orderExecutor.test.ts - Unit test Executor Idempoten + Verifikasi Fill (FR-22, NFR-02).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  generateClientOrderId,
  OrderExecutor,
  OrderExecRepo,
  OrderExecRow,
  ExchangeClient,
  OrderStatus,
  paperFillSlippageBps,
} from "../src/exec/orderExecutor.js";

class MemoryOrderExecRepo implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();

  async findByClientOrderId(clientOrderId: string): Promise<OrderExecRow | null> {
    return this.rows.get(clientOrderId) ?? null;
  }

  async create(order: OrderExecRow): Promise<OrderExecRow> {
    const copy = { ...order, id: this.rows.size + 1 };
    this.rows.set(order.clientOrderId, copy);
    return copy;
  }

  async updateStatus(
    clientOrderId: string,
    status: OrderStatus,
    fillPrice?: number,
    feeUsd?: number,
    filledAt?: Date,
    execution?: Partial<OrderExecRow>
  ): Promise<OrderExecRow> {
    const existing = this.rows.get(clientOrderId);
    if (!existing) throw new Error("Order not found");
    const updated: OrderExecRow = {
      ...existing,
      status,
      fillPrice: fillPrice !== undefined ? fillPrice : existing.fillPrice,
      feeUsd: feeUsd !== undefined ? feeUsd : existing.feeUsd,
      filledAt: filledAt !== undefined ? filledAt : existing.filledAt,
      ...(execution?.filledQty !== undefined ? { filledQty: execution.filledQty } : {}),
      ...(execution?.feeEstimated !== undefined ? { feeEstimated: execution.feeEstimated } : {}),
      ...(execution?.simulated !== undefined ? { simulated: execution.simulated } : {}),
    };
    this.rows.set(clientOrderId, updated);
    return updated;
  }

  size(): number {
    return this.rows.size;
  }
}

describe("FR-22 & NFR-02: Order Executor Idempoten & Verifikasi Fill", () => {
  it("generateClientOrderId menghasilkan ID unik <= 36 karakter alfanumerik", () => {
    const id1 = generateClientOrderId("BTCUSDT");
    const id2 = generateClientOrderId("BTCUSDT");

    expect(id1).toMatch(/^AT_BTCUSD_\d+_[A-Z0-9]+$/);
    expect(id1.length).toBeLessThanOrEqual(36);
    expect(id1).not.toBe(id2);
  });

  it("mengeksekusi order dalam mode SIMULATED saat DISARMED (ARM default OFF)", async () => {
    const repo = new MemoryOrderExecRepo();
    const executor = new OrderExecutor({
      repo,
      isArmed: () => false,
    });

    const res = await executor.executeOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      price: 60000,
      qty: 0.002,
    });

    expect(res.simulated).toBe(true);
    expect(res.status).toBe("FILLED");
    expect(res.fillPrice).toBe(60000);
    expect(res.filledQty).toBe(0.002);
    // Fee penuh (18 Okt 2026): LIMIT = maker 0,02% -> 0.002 * 60000 * 0.0002 = 0.024.
    expect(res.feeUsd).toBeCloseTo(0.024, 6);
    expect(res.feeEstimated).toBe(true);
    expect(res.isDuplicate).toBe(false);
  });

  it("menjaga sifat idempoten: panggilan berulang tidak menduplikasi order (FR-22)", async () => {
    const repo = new MemoryOrderExecRepo();
    let exchangeCalls = 0;
    const mockExchange: ExchangeClient = {
      async postOrder() {
        exchangeCalls++;
        return { orderId: "12345", status: "FILLED", avgPrice: 60000 };
      },
      async queryOrder() {
        return { orderId: "12345", status: "FILLED", avgPrice: 60000 };
      },
    };

    const executor = new OrderExecutor({
      repo,
      exchange: mockExchange,
      isArmed: () => true,
    });

    const fixedId = "AT_BTC_FIXED_IDEMPOTENT_1";
    const res1 = await executor.executeOrder({
      clientOrderId: fixedId,
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      price: 60000,
      qty: 0.002,
    });

    expect(res1.isDuplicate).toBe(false);
    expect(exchangeCalls).toBe(1);

    // Panggilan kedua dengan clientOrderId yang sama
    const res2 = await executor.executeOrder({
      clientOrderId: fixedId,
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      price: 60000,
      qty: 0.002,
    });

    expect(res2.isDuplicate).toBe(true);
    expect(res2.clientOrderId).toBe(fixedId);
    // Exchange TIDAK boleh dipanggil dua kali!
    expect(exchangeCalls).toBe(1);
  });

  it("verifikasi fill memantau status sampai FILLED (NFR-02 <= 2s)", async () => {
    const repo = new MemoryOrderExecRepo();
    let queryCount = 0;
    const mockExchange: ExchangeClient = {
      async postOrder() {
        return { orderId: "999", status: "NEW" };
      },
      async queryOrder() {
        queryCount++;
        if (queryCount >= 2) {
          return { orderId: "999", status: "FILLED", avgPrice: 60005 };
        }
        return { orderId: "999", status: "NEW" };
      },
    };

    const executor = new OrderExecutor({
      repo,
      exchange: mockExchange,
      isArmed: () => true,
    });

    const created = await executor.executeOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      price: 60000,
      qty: 0.002,
    });

    expect(created.status).toBe("NEW");

    // Lakukan verifikasi fill
    const verified = await executor.verifyFill("BTCUSDT", created.clientOrderId, 1000, 20);
    expect(verified.status).toBe("FILLED");
    expect(verified.fillPrice).toBe(60005);
    expect(queryCount).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/orders/execute menolak bypass unmanaged dan mengarahkan ke route posisi", async () => {
    const app = createApp();
    const res = await request(app).post("/api/orders/execute").set("x-api-token", "vitest-mutation-token")
      .send({
        symbol: "BTCUSDT",
        side: "BUY",
        price: 65000,
        qty: 0.001,
      })
      .expect(409);

    expect(res.body.error).toBe("UNMANAGED_ORDER_DISABLED");
  });
});

describe("Fix lanjutan #3177 (16 Okt 2026): paper LIMIT resting & fill retroaktif terverifikasi kline", () => {
  const OPEN_MS = 1700000000000;
  const LEVEL = 0.9602;

  function makeExecutor(
    verifier: (symbol: string, price: number, side: string, sinceMs: number) => Promise<boolean>
  ) {
    const repo = new MemoryOrderExecRepo();
    const executor = new OrderExecutor({
      repo,
      isArmed: () => false,
      paperTouchVerifier: verifier,
      now: () => OPEN_MS + 3_600_000,
    });
    return { repo, executor };
  }

  const exitReq = (touchSinceMs?: number) => ({
    clientOrderId: "PX_3177_TP1_0",
    symbol: "SUIUSDT",
    side: "BUY" as const,
    type: "LIMIT" as const,
    price: LEVEL,
    qty: 16.48,
    reduceOnly: true,
    positionId: 3177,
    ...(touchSinceMs !== undefined ? { touchSinceMs } : {}),
  });

  it("tanpa bukti sentuhan: order resting (NEW) — tidak pernah fabricate fill", async () => {
    const { repo, executor } = makeExecutor(async () => false);
    const r1 = await executor.executeOrder(exitReq(OPEN_MS));
    expect(r1.status).toBe("NEW");
    expect(r1.filledQty).toBe(0);
    const r2 = await executor.executeOrder(exitReq(OPEN_MS));
    expect(r2.status).toBe("NEW");
    expect(r2.filledQty).toBe(0);
    expect((await repo.findByClientOrderId("PX_3177_TP1_0"))?.status).toBe("NEW");
  });

  it("retry dengan bukti sentuhan sejak touchSinceMs: baris YANG SAMA dipromosikan FILLED di harga level", async () => {
    let touched = false;
    const seen: number[] = [];
    const { repo, executor } = makeExecutor(async (_s, _p, _side, sinceMs) => {
      seen.push(sinceMs);
      return touched;
    });
    const req = exitReq(OPEN_MS);
    expect((await executor.executeOrder(req)).status).toBe("NEW");
    touched = true; // kline 1m membuktikan level diperdagangkan sejak posisi dibuka
    const filled = await executor.executeOrder(req);
    expect(filled.status).toBe("FILLED");
    expect(filled.fillPrice).toBe(LEVEL);
    expect(filled.filledQty).toBe(16.48);
    expect(filled.isDuplicate).toBe(true);
    // Bukti dihitung sejak openedAt, bukan sejak order dibuat.
    expect(seen).toEqual([OPEN_MS, OPEN_MS]);
    expect(repo.size()).toBe(1); // dipromosikan, bukan order kedua
  });

  it("sentuhan historis sejak touchSinceMs saat order dibuat -> langsung FILLED di harga level", async () => {
    const { repo, executor } = makeExecutor(async () => true);
    const r = await executor.executeOrder(exitReq(OPEN_MS));
    expect(r.status).toBe("FILLED");
    expect(r.fillPrice).toBe(LEVEL);
    expect(r.filledQty).toBe(16.48);
    expect(repo.size()).toBe(1);
  });

  it("tanpa touchSinceMs: jendela bukti default = createdAt order (perilaku entry lama)", async () => {
    const seen: number[] = [];
    const { executor } = makeExecutor(async (_s, _p, _side, sinceMs) => {
      seen.push(sinceMs);
      return false;
    });
    await executor.executeOrder(exitReq());
    expect(seen).toEqual([OPEN_MS + 3_600_000]);
  });
});

describe("T0.2 (18 Okt 2026): slippage dinamis utk fill paper non-LIMIT", () => {
  const OPEN_MS = 1700000000000;
  // Estimator deterministik utk asersi: slip tetap 10 bps (0,10%).
  const fixed10bps = () => 10;

  function makeExecutor(estimator?: (input: { price: number; qty: number; side: "BUY" | "SELL"; type: string }) => number) {
    const repo = new MemoryOrderExecRepo();
    const executor = new OrderExecutor({
      repo,
      isArmed: () => false,
      now: () => OPEN_MS,
      paperAllowed: true,
      ...(estimator ? { slippageEstimator: estimator as never } : {}),
    });
    return { repo, executor };
  }

  it("paperFillSlippageBps menurun anggun tanpa ATR/volume (base 2bps x 1.02 = 2.04)", () => {
    expect(paperFillSlippageBps({ price: 100, qty: 1 })).toBeCloseTo(2.04, 2);
    // Notional mempengaruhi participation bila volume tersedia; tanpa volume tetap 0.1.
    expect(paperFillSlippageBps({ price: 60000, qty: 0.002, baseSlippageBps: 2 })).toBeCloseTo(2.04, 2);
  });

  it("MARKET BUY slip naik (adverse): fillPrice = price x (1 + bps/10000)", async () => {
    const { executor } = makeExecutor(fixed10bps);
    const res = await executor.executeOrder({
      clientOrderId: "SLIP_BUY", symbol: "BTCUSDT", side: "BUY", type: "MARKET",
      price: 100, qty: 1,
    });
    expect(res.status).toBe("FILLED");
    // BUY 100, slip 10bps = 0.10% -> 100.1
    expect(res.fillPrice).toBeCloseTo(100.1, 6);
    // Fee taker dihitung dari harga terslip: 100.1 * 0.0005 = 0.05005.
    expect(res.feeUsd).toBeCloseTo(100.1 * 0.0005, 6);
  });

  it("MARKET SELL slip turun (adverse): fillPrice = price x (1 - bps/10000)", async () => {
    const { executor } = makeExecutor(fixed10bps);
    const res = await executor.executeOrder({
      clientOrderId: "SLIP_SELL", symbol: "BTCUSDT", side: "SELL", type: "MARKET",
      price: 100, qty: 1, reduceOnly: true,
    });
    expect(res.status).toBe("FILLED");
    // SELL 100, slip 10bps -> 99.9
    expect(res.fillPrice).toBeCloseTo(99.9, 6);
    expect(res.feeUsd).toBeCloseTo(99.9 * 0.0005, 6);
  });

  it("LIMIT tidak slip (maker, fill di harga level) meski estimator aktif", async () => {
    const { executor } = makeExecutor(fixed10bps);
    const res = await executor.executeOrder({
      clientOrderId: "SLIP_LIMIT", symbol: "BTCUSDT", side: "BUY", type: "LIMIT",
      price: 100, qty: 1,
    });
    expect(res.status).toBe("FILLED");
    expect(res.fillPrice).toBe(100);
    // Fee maker di harga level: 100 * 0.0002 = 0.02.
    expect(res.feeUsd).toBeCloseTo(100 * 0.0002, 6);
  });

  it("STOP_MARKET / TAKE_PROFIT_MARKET ikut slip (taker, non-LIMIT)", async () => {
    const { executor } = makeExecutor(fixed10bps);
    const stop = await executor.executeOrder({
      clientOrderId: "SLIP_STOP", symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET",
      price: 100, qty: 1, reduceOnly: true,
    });
    expect(stop.fillPrice).toBeCloseTo(99.9, 6);
    const tp = await executor.executeOrder({
      clientOrderId: "SLIP_TP", symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET",
      price: 100, qty: 1, reduceOnly: true,
    });
    expect(tp.fillPrice).toBeCloseTo(99.9, 6);
  });

  it("tanpa estimator: semua fill paper tetap di req.price (kompatibilitas mundur)", async () => {
    const { executor } = makeExecutor();
    const res = await executor.executeOrder({
      clientOrderId: "SLIP_NONE", symbol: "BTCUSDT", side: "BUY", type: "MARKET",
      price: 100, qty: 1,
    });
    expect(res.fillPrice).toBe(100);
    expect(res.feeUsd).toBeCloseTo(100 * 0.0005, 6);
  });
});

