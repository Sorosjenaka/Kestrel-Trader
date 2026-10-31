// apps/server/tests/reconciler.test.ts - Reconcile posisi saat boot + EventLog lengkap (NFR-04, NFR-12, US-13).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  PositionReconciler,
  ReconcileRepo,
  ReconcileExchangeClient,
  ExchangePositionSnapshot,
} from "../src/exec/reconciler.js";
import { PositionRow, TradeRow } from "../src/exec/positionSupervisor.js";

class MemoryReconcileRepo implements ReconcileRepo {
  public positions = new Map<number, PositionRow>();
  public trades: TradeRow[] = [];
  public loggedEvents: Array<{ type: string; severity: string; payload: Record<string, unknown> }> = [];

  async findOpenPositions(): Promise<PositionRow[]> {
    return Array.from(this.positions.values()).filter((p) => p.status === "OPEN");
  }

  async updatePosition(id: number, data: Partial<PositionRow>): Promise<void> {
    const p = this.positions.get(id);
    if (p) {
      this.positions.set(id, { ...p, ...data });
    }
  }

  async createTrade(trade: TradeRow): Promise<void> {
    this.trades.push(trade);
  }

  async logEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void> {
    this.loggedEvents.push({ type, severity, payload });
  }
}

describe("NFR-04, NFR-12, US-13: Position Reconciler & EventLog", () => {
  it("posisi yang cocok antara DB dan exchange ditandai MATCHED", async () => {
    const repo = new MemoryReconcileRepo();
    repo.positions.set(1, {
      id: 1,
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
      openedAt: new Date(),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
      source: "LIVE_AI",
    });

    const mockExchange: ReconcileExchangeClient = {
      async getOpenPositions(): Promise<ExchangePositionSnapshot[]> {
        return [
          { symbol: "BTCUSDT", positionAmt: 0.002, entryPrice: 60000, markPrice: 60200 },
        ];
      },
    };

    const reconciler = new PositionReconciler({ repo, exchange: mockExchange });
    const report = await reconciler.reconcile();

    expect(report.matchedCount).toBe(1);
    expect(report.reconciledClosedCount).toBe(0);
    expect(report.orphanCount).toBe(0);

    const pos = repo.positions.get(1);
    expect(pos?.status).toBe("OPEN");
  });

  it("posisi flat setelah offline menunggu bukti exit tanpa Trade harga SL karangan", async () => {
    const repo = new MemoryReconcileRepo();
    repo.positions.set(2, {
      id: 2,
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
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
      source: "LIVE_AI",
    });

    const mockExchange: ReconcileExchangeClient = {
      async getOpenPositions(): Promise<ExchangePositionSnapshot[]> {
        return [];
      },
    };

    const reconciler = new PositionReconciler({ repo, exchange: mockExchange });
    const report = await reconciler.reconcile();

    expect(report.reconciledClosedCount).toBe(0);
    expect(report.deferredCount).toBe(1);
    expect(report.matchedCount).toBe(0);

    const pos = repo.positions.get(2);
    expect(pos?.status).toBe("OPEN");
    expect(pos?.closeReason).toBeNull();
    expect(repo.trades).toHaveLength(0);

    const event = repo.loggedEvents.find((e) => e.type === "RECONCILE_ACCOUNTING_DEFERRED");
    expect(event).toBeDefined();
    expect(event?.severity).toBe("warn");
  });
  it("posisi aktif di exchange tanpa catatan di DB terdeteksi sebagai ORPHAN", async () => {
    const repo = new MemoryReconcileRepo();
    const mockExchange: ReconcileExchangeClient = {
      async getOpenPositions(): Promise<ExchangePositionSnapshot[]> {
        return [
          { symbol: "SOLUSDT", positionAmt: 1.5, entryPrice: 150, markPrice: 152 },
        ];
      },
    };

    const reconciler = new PositionReconciler({ repo, exchange: mockExchange });
    const report = await reconciler.reconcile();

    expect(report.orphanCount).toBe(1);
    const orphanEvent = repo.loggedEvents.find((e) => e.type === "ORPHAN_POSITION_DETECTED");
    expect(orphanEvent).toBeDefined();
    expect(orphanEvent?.severity).toBe("error");
  });

  it("mode offline tanpa exchange mempertahankan posisi simulasi (SIMULATED_KEPT)", async () => {
    const repo = new MemoryReconcileRepo();
    repo.positions.set(3, {
      id: 3,
      symbol: "BNBUSDT",
      mode: "SCALP",
      side: "BUY",
      entryPrice: 500,
      qty: 0.2,
      notional: 100,
      leverage: 20,
      marginUsd: 5,
      slPrice: 495,
      tp1Price: 505,
      tp2Price: 510,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
    });

    const reconciler = new PositionReconciler({ repo });
    const report = await reconciler.reconcile();

    expect(report.matchedCount).toBe(1);
    expect(report.details[0].action).toBe("SIMULATED_KEPT");
    expect(repo.positions.get(3)?.status).toBe("OPEN");
  });

  it("insiden GO LIVE 11 Okt: posisi PAPER TIDAK ditutup oleh reconcile exchange (SIMULATED_KEPT, tanpa trade palsu)", async () => {
    const repo = new MemoryReconcileRepo();
    repo.positions.set(4, {
      id: 4,
      symbol: "SANDUSDT",
      mode: "SCALP",
      side: "SHORT",
      entryPrice: 0.0685,
      qty: 624,
      notional: 42.7,
      leverage: 25,
      marginUsd: 1.7,
      slPrice: 0.07011,
      tp1Price: 0.0661,
      tp2Price: 0.0661,
      beMoved: false,
      tp1FilledAt: null,
      tp2FilledAt: null,
      status: "OPEN",
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      closeReason: null,
      pnlUsd: null,
      pnlR: null,
      outlookText: "",
      source: "PAPER_AI",
    });

    const mockExchange: ReconcileExchangeClient = {
      async getOpenPositions(): Promise<ExchangePositionSnapshot[]> {
        return []; // akun exchange flat — posisi PAPER memang tidak pernah ada di sana
      },
    };

    const reconciler = new PositionReconciler({ repo, exchange: mockExchange });
    const report = await reconciler.reconcile();

    expect(report.reconciledClosedCount).toBe(0);
    expect(report.details.find((d) => d.symbol === "SANDUSDT")?.action).toBe("SIMULATED_KEPT");
    const pos = repo.positions.get(4);
    expect(pos?.status).toBe("OPEN");
    expect(pos?.closeReason).toBeNull();
    expect(repo.trades).toHaveLength(0); // tidak boleh ada trade LOSS palsu
  });

  it("API POST /api/reconcile dan GET /api/events mengembalikan laporan audit terstruktur (NFR-12)", async () => {
    const app = createApp();

    const recRes = await request(app).post("/api/reconcile").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(recRes.body.report).toBeDefined();
    expect(typeof recRes.body.report.timestamp).toBe("string");

    const eventsRes = await request(app).get("/api/events?limit=10").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(eventsRes.body.events).toBeDefined();
    expect(Array.isArray(eventsRes.body.events)).toBe(true);
    expect(eventsRes.body.events.length).toBeGreaterThan(0);
  });
});

