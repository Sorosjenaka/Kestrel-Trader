// apps/server/tests/marginSafety.test.ts - Logic anti-liquidation:
// margin-level akun (70% block / 50% warn) + monitor liq-gap supervisor + fallback LLM tercatat.
import { describe, expect, it } from "vitest";
import {
  checkMarginLevel,
  MARGIN_LEVEL_BLOCK_PCT,
  MARGIN_LEVEL_WARN_PCT,
} from "../src/risk/riskEngine.js";
import {
  PositionSupervisor,
  PositionRepo,
  PositionRow,
  TradeRow,
  estimateLiquidationPrice,
} from "../src/exec/positionSupervisor.js";
import { OrderExecutor, OrderExecRepo, OrderExecRow, OrderStatus } from "../src/exec/orderExecutor.js";
import { llmFallbackStats } from "../src/agents/llmAdapter.js";
import { evaluateAltMatrix } from "../src/engines/macroGate.js";

class MemoryPositionRepo implements PositionRepo {
  private positions = new Map<number, PositionRow>();
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
    return { ...data, id: 1 };
  }
  async logEvent(action: string, symbol: string, payload: Record<string, unknown>): Promise<void> {
    this.loggedEvents.push({ action, symbol, payload });
  }
}

class DummyOrderRepo implements OrderExecRepo {
  private rows = new Map<string, OrderExecRow>();
  async findByClientOrderId(id: string) { return this.rows.get(id) ?? null; }
  async create(row: OrderExecRow) { this.rows.set(row.clientOrderId, row); return row; }
  async updateStatus(id: string, status: OrderStatus, fillPrice?: number, feeUsd?: number, filledAt?: Date) {
    const r = this.rows.get(id)!;
    const upd = { ...r, status, fillPrice: fillPrice ?? r.fillPrice, feeUsd: feeUsd ?? r.feeUsd, filledAt };
    this.rows.set(id, upd);
    return upd;
  }
}

describe("Anti-liquidation: margin-level akun", () => {
  it("mengizinkan entry saat margin terpakai < 50% equity", () => {
    const r = checkMarginLevel(20, 8);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(false);
    expect(r.usedPct).toBeCloseTo(0.4, 4);
  });

  it("memberi warn saat >= 50% tapi tetap mengizinkan", () => {
    expect(MARGIN_LEVEL_WARN_PCT).toBe(0.5);
    const r = checkMarginLevel(20, 11);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(true);
  });

  it("memblokir entry baru saat >= 70% equity (MARGIN_LEVEL_GUARD)", () => {
    expect(MARGIN_LEVEL_BLOCK_PCT).toBe(0.7);
    const r = checkMarginLevel(20, 14.5);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("MARGIN_LEVEL_GUARD");
  });

  it("memblokir saat equity nol", () => {
    const r = checkMarginLevel(0, 0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("MARGIN_LEVEL_NO_EQUITY");
  });
});

describe("Anti-liquidation: estimasi harga liquidation", () => {
  it("LONG: liq di bawah entry; SHORT: liq di atas entry", () => {
    const liqLong = estimateLiquidationPrice(60000, 25, "LONG");
    expect(liqLong).toBeLessThan(60000);
    expect(liqLong).toBeCloseTo(60000 * (1 - 1 / 25) / (1 - 0.01), 2);
    const liqShort = estimateLiquidationPrice(60000, 25, "SHORT");
    expect(liqShort).toBeGreaterThan(60000);
  });
});

describe("Anti-liquidation: liq-gap monitor supervisor", () => {
  const dummyExecutor = new OrderExecutor({ repo: new DummyOrderRepo(), isArmed: () => false });

  it("harga menembus liq LONG -> tutup darurat LIQ_GAP + event tercatat", async () => {
    const repo = new MemoryPositionRepo();
    const supervisor = new PositionSupervisor({
      repo, executor: dummyExecutor, now: () => 1700000000000, marginMode: "ISOLATED",
      // A production exchange adapter must provide the authoritative liquidation
      // boundary; the supervisor never promotes a local approximation to truth.
      liquidationPriceProvider: async (position) => estimateLiquidationPrice(position.entryPrice, position.leverage, position.side),
    });
    const pos = await repo.createPosition({
      symbol: "BTCUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 60000,
      qty: 0.002,
      notional: 120,
      leverage: 25,
      marginUsd: 4.8,
      slPrice: 59400,
      tp1Price: 60600,
      tp2Price: 61200,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(1700000000000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "test",
    });

    // liq LONG 25x = 60000*(1-0.04+0.01) = 58200; tick jauh di bawahnya (gap melewati SL).
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 58000 });
    expect(evals).toHaveLength(1);
    expect(evals[0].action).toBe("SL");
    expect(evals[0].reason).toContain("LIQ_GAP");

    const closed = await repo.findById(pos.id);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closeReason).toBe("LIQ_GAP");
    expect(repo.loggedEvents.some((e) => e.action === "LIQ_GAP_EXIT")).toBe(true);
  });

  it("harga normal di atas liq -> liq-gap TIDAK terpicu (SL biasa yang bekerja)", async () => {
    const repo = new MemoryPositionRepo();
    const supervisor = new PositionSupervisor({
      repo, executor: dummyExecutor, now: () => 1700000000000, marginMode: "ISOLATED",
      liquidationPriceProvider: async (position) => estimateLiquidationPrice(position.entryPrice, position.leverage, position.side),
    });
    await repo.createPosition({
      symbol: "BTCUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 60000,
      qty: 0.002,
      notional: 120,
      leverage: 25,
      marginUsd: 4.8,
      slPrice: 59400,
      tp1Price: 60600,
      tp2Price: 61200,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(1700000000000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "test",
    });

    // 59300 < SL 59400 tapi > liq 58200 -> SL biasa, bukan LIQ_GAP.
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 59300 });
    expect(evals[0].action).toBe("SL");
    expect(evals[0].reason).not.toContain("LIQ_GAP");
    expect(repo.loggedEvents.some((e) => e.action === "LIQ_GAP_EXIT")).toBe(false);
  });

  it("CROSS: ekuitas menahan semua posisi — gap yang sama TIDAK memicu LIQ_GAP", async () => {
    const repo = new MemoryPositionRepo();
    const supervisor = new PositionSupervisor({ repo, executor: dummyExecutor, now: () => 1700000000000, marginMode: "CROSS" });
    await repo.createPosition({
      symbol: "BTCUSDT",
      mode: "SCALP",
      side: "LONG",
      entryPrice: 60000,
      qty: 0.002,
      notional: 120,
      leverage: 25,
      marginUsd: 4.8,
      slPrice: 59400,
      tp1Price: 60600,
      tp2Price: 61200,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(1700000000000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "test",
    });

    // Di bawah SL (59400) tapi jauh di atas liq CROSS (~akun $200 menahan $120 nosional).
    const evals = await supervisor.evaluatePriceTick({ symbol: "BTCUSDT", markPrice: 59300 });
    expect(evals[0].action).toBe("SL");
    expect(evals[0].reason).not.toContain("LIQ_GAP");
  });
});

describe("Matriks enam kondisi operator (BTC.D x BTC; ETH hanya konteks)", () => {
  it("R1 dom↑+btc↑ = DECREASE: LONG alt diblokir, SHORT lolos", () => {
    const r = evaluateAltMatrix(0.3, 0.8, 0.5);
    expect(r.row).toBe(1);
    expect(r.bias).toBe("DECREASE");
    expect(r.allowLongAlt).toBe(false);
    expect(r.allowShortAlt).toBe(true);
  });

  it("R2 dom↑+btc↓+eth↓ = DUMP: hanya SHORT", () => {
    const r = evaluateAltMatrix(0.4, -1.2, -0.9);
    expect(r.row).toBe(2);
    expect(r.bias).toBe("DUMP");
    expect(r.allowLongAlt).toBe(false);
    expect(r.allowShortAlt).toBe(true);
  });

  it("R2 tanpa konfirmasi ETH tetap DUMP sesuai diagram, dengan divergensi tercatat", () => {
    const r = evaluateAltMatrix(0.4, -1.2, 0.6);
    expect(r.bias).toBe("DUMP");
    expect(r.allowLongAlt).toBe(false);
    expect(r.allowShortAlt).toBe(true);
    expect(r.ethConfirmed).toBe(false);
  });

  it("R3 dom↑+btc~ = STABLE", () => {
    const r = evaluateAltMatrix(0.3, 0.05, 0.0);
    expect(r.row).toBe(3);
    expect(r.bias).toBe("STABLE");
  });

  it("R4 dom↓+btc↑+eth↑ = PUMP: hanya LONG", () => {
    const r = evaluateAltMatrix(-0.3, 1.1, 0.8);
    expect(r.row).toBe(4);
    expect(r.bias).toBe("PUMP");
    expect(r.allowLongAlt).toBe(true);
    expect(r.allowShortAlt).toBe(false);
  });

  it("R4 tanpa konfirmasi ETH tetap PUMP sesuai diagram, dengan divergensi tercatat", () => {
    const r = evaluateAltMatrix(-0.3, 1.1, -0.5);
    expect(r.bias).toBe("PUMP");
    expect(r.allowShortAlt).toBe(false);
    expect(r.ethConfirmed).toBe(false);
  });

  it("R5 dom↓+btc↓ = STABLE", () => {
    const r = evaluateAltMatrix(-0.4, -0.9, -0.7);
    expect(r.row).toBe(5);
    expect(r.bias).toBe("STABLE");
  });

  it("R6 dom↓+btc~ = INCREASE: hanya LONG", () => {
    const r = evaluateAltMatrix(-0.2, 0.05, 0.1);
    expect(r.row).toBe(6);
    expect(r.bias).toBe("INCREASE");
    expect(r.allowLongAlt).toBe(true);
    expect(r.allowShortAlt).toBe(false);
  });
});

describe("Observabilitas fallback LLM", () => {
  it("stats fallback tersedia dan berbentuk angka", () => {
    expect(typeof llmFallbackStats.count).toBe("number");
    expect(typeof llmFallbackStats.lastAt).toBe("number");
  });
});
