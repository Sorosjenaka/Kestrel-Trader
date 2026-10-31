// apps/server/tests/recoveryScenarios.test.ts - Uji Pemulihan Bencana & Gangguan (T-4.2, NFR-03, NFR-14).
import { describe, expect, it } from "vitest";
import { PositionReconciler, ReconcileExchangeClient, ReconcileRepo } from "../src/exec/reconciler.js";
import { WsMarkPriceManager } from "../src/marketdata/wsManager.js";
import { RestPool } from "../src/marketdata/restPool.js";
import { LeverageWatcher, LeverageRepo } from "../src/universe/leverageWatcher.js";
import { calculateOrderPlan } from "../src/risk/riskEngine.js";

describe("T-4.2: Uji Pemulihan Bencana & Pemulihan Keadaan Ekstrem", () => {
  it("Skenario 1 (Listrik Mati/Crash): Reconcile mendeteksi posisi tertutup offline & orphan exchange", async () => {
    const memoryDbPositions = [
      { id: 1, symbol: "BTCUSDT", side: "LONG", status: "OPEN" },
      { id: 2, symbol: "ETHUSDT", side: "LONG", status: "OPEN" },
    ];
    const exchangeOpenPositions = [
      { symbol: "BTCUSDT", positionAmt: 0.05, entryPrice: 50000, markPrice: 50500 },
      { symbol: "SOLUSDT", positionAmt: 10, entryPrice: 100, markPrice: 105 },
    ];

    const updatedDb: Array<{ id: number; data: any }> = [];
    const eventLogs: Array<{ type: string; payload: any }> = [];

    const mockRepo: ReconcileRepo = {
      async findOpenPositions() {
        return memoryDbPositions.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          side: p.side as "LONG" | "SHORT",
          entryPrice: 50000,
          currentQty: 0.05,
          slPrice: 49000,
          tp1Price: 52000,
          tp2Price: 55000,
          leverage: 20,
          status: p.status,
          initialQty: 0.05,
          mode: "SCALP",
          beMoved: false,
          tp1FilledAt: null,
          tp2FilledAt: null,
          openedAt: new Date(Date.now() - 3600_000),
          closedAt: null,
          closeReason: null,
          pnlUsd: null,
          pnlR: null,
          outlookText: "test",
          // Insiden GO LIVE 11 Okt: skenario crash-recovery ini memakai posisi LIVE asli;
          // reconcile exchange hanya menyentuh source LIVE_* (posisi simulasi = SIMULATED_KEPT).
          source: "LIVE_AI",
          createdAt: new Date(Date.now() - 3600_000),
        }));
      },
      async updatePosition(id, data) {
        updatedDb.push({ id, data });
      },
      async createTrade() {},
      async logEvent(type, severity, payload) {
        eventLogs.push({ type, payload });
      },
    };

    const mockExchange: ReconcileExchangeClient = {
      async getOpenPositions() {
        return exchangeOpenPositions;
      },
    };

    const reconciler = new PositionReconciler({
      repo: mockRepo,
      exchange: mockExchange,
    });

    const report = await reconciler.reconcile();

    expect(report.matchedCount).toBe(1);
    expect(report.deferredCount).toBe(1);
    expect(report.reconciledClosedCount).toBe(0);
    expect(report.orphanCount).toBe(1);
    expect(report.details.find((d) => d.symbol === "SOLUSDT")?.action).toBe("ORPHAN");
    expect(report.details.find((d) => d.symbol === "ETHUSDT")?.action).toBe("ACCOUNTING_DEFERRED");
    expect(eventLogs.some((e) => e.type === "RECONCILE_ACCOUNTING_DEFERRED")).toBe(true);
  });

  it("Skenario 2 (Internet Putus/WS Gap): Gap > 2 dtk memicu auto-resubscribe & transisi DEGRADED", () => {
    let resubscribeTriggered = false;

    const ws = new WsMarkPriceManager({
      hosts: ["fstream.test", "fstream1.test"],
      gapLimitMs: 2000,
      quarantineMs: 5000,
      makeSocket: () => ({
        on: () => {},
        close: () => {},
        send: () => {},
      }) as any,
      handlers: {
        resubscribe: () => {
          resubscribeTriggered = true;
        },
      },
    });

    (ws as any).socket = { close: () => {} };
    (ws as any).lastMsgAt = 1000;
    (ws as any).status = "CONNECTED";

    const gapDetected = ws.checkGap(3500);

    expect(gapDetected).toBe(true);
    expect(resubscribeTriggered).toBe(true);
    expect(ws.health().status).toBe("DEGRADED");
  });

  it("Skenario 3 (Host 418/429 Circuit Breaker): Failover instan & isolasi host terblokir", async () => {
    const events: Array<{ type: string; from: string | null; to: string }> = [];
    let h1Requests = 0;
    let h2Requests = 0;

    const pool = new RestPool({
      hosts: ["fapi1.bad", "fapi2.good"],
      sleep: async () => {},
      onEvent: (e) => {
        if (e.type === "HOST_SWITCH") events.push(e as any);
      },
      fetchImpl: (async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("fapi1.bad")) {
          h1Requests++;
          return new Response("IP banned", { status: 418 });
        }
        h2Requests++;
        return new Response(JSON.stringify({ status: "recovered" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const start = Date.now();
    const res = await pool.get<{ status: string }>("/fapi/v1/ping");
    const duration = Date.now() - start;

    expect(res.data.status).toBe("recovered");
    expect(res.host).toBe("fapi2.good");
    expect(h1Requests).toBe(1);
    expect(h2Requests).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(duration).toBeLessThanOrEqual(5000);
  });

  it("Skenario 4 (Leverage Berubah): Deteksi mutasi maxLev & penyesuaian plafon margin otomatis", async () => {
    const memorySymbols = [
      { symbol: "BTCUSDT", maxLeverage: 50, maxLeverageUpdatedAt: new Date(Date.now() - 3600_000) },
      { symbol: "ETHUSDT", maxLeverage: 50, maxLeverageUpdatedAt: new Date(Date.now() - 3600_000) },
    ];
    const recordedHistory: any[] = [];
    const diffEvents: any[] = [];

    const mockRepo: LeverageRepo = {
      async getSymbols() {
        return memorySymbols;
      },
      async updateSymbolLeverage(symbol, maxLeverage, updatedAt) {
        const s = memorySymbols.find((m) => m.symbol === symbol);
        if (s) {
          s.maxLeverage = maxLeverage;
          s.maxLeverageUpdatedAt = updatedAt;
        }
      },
      async touchSymbolLeverage() {},
      async recordHistory(item) {
        recordedHistory.push(item);
      },
      async getHistory() {
        return recordedHistory;
      },
    };

    const watcher = new LeverageWatcher({
      repo: mockRepo,
      onDiffDetected: (diff) => diffEvents.push(diff),
    });

    const res = await watcher.applySnapshot(
      [
        { symbol: "BTCUSDT", maxLeverage: 50 },
        { symbol: "ETHUSDT", maxLeverage: 10 },
      ],
      "signed-endpoint"
    );

    expect(res.updated).toBe(1);
    expect(res.diffs[0]).toEqual({ symbol: "ETHUSDT", old: 50, new: 10 });
    expect(recordedHistory.length).toBe(1);
    expect(recordedHistory[0].previousMaxLeverage).toBe(50);
    expect(recordedHistory[0].maxLeverage).toBe(10);

    const orderPlan = calculateOrderPlan({
      symbol: "ETHUSDT",
      entryPrice: 2000,
      slPrice: 1960,
      side: "LONG",
      equityUsd: 100,
      availableMarginUsd: 50,
      symbolRules: {
        symbol: "ETHUSDT",
        maxLeverage: 10,
        tickSize: 0.01,
        stepSize: 0.001,
        minNotional: 5,
        leverageUpdatedAt: Date.now(),
        leverageSnapshotAgeDays: 0,
      },
    });

    expect(orderPlan.allowed).toBe(true);
    expect(orderPlan.leverage).toBeLessThanOrEqual(10);
    expect(orderPlan.effectiveRiskUsd).toBeLessThanOrEqual(1.05);
  });
});
