import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";
import { renderPrometheusMetrics } from "../src/analytics/prometheusMetrics.js";
import { buildAlertFeed, toAlertItem, type EventLogLike } from "../src/analytics/alertFeed.js";
import { signedSlippageBps, summarizeExecutionQuality, type FillRow } from "../src/analytics/executionQuality.js";

const now = new Date("2026-10-19T00:00:00.000Z");

function fill(over: Partial<FillRow> = {}): FillRow {
  return {
    id: 1,
    symbol: "BTCUSDT",
    type: "LIMIT",
    side: "BUY",
    price: 100,
    fillPrice: 100.1,
    qty: 1,
    feeUsd: 0.02,
    simulated: true,
    createdAt: now,
    filledAt: new Date(now.getTime() + 1200),
    ...over,
  };
}

describe("prometheusMetrics (T-15)", () => {
  it("merender metrik inti + label mode", () => {
    const text = renderPrometheusMetrics({
      executionMode: "PAPER",
      liveReady: false,
      armed: true,
      openPositions: 3,
      closedTradesToday: 2,
      pnlTodayUsd: -0.5,
      winRateTodayPct: 50,
      eventCountsBySeverity: { warn: 4, error: 1 },
      lastTradeAgeSeconds: 3600,
      uptimeSeconds: 123.9,
      dbSizeBytes: null,
    });
    expect(text).toContain("# TYPE artatrade_up gauge");
    expect(text).toContain("artatrade_up 1");
    expect(text).toContain('artatrade_execution_mode{mode="PAPER"} 1');
    expect(text).toContain("artatrade_live_ready 0");
    expect(text).toContain("artatrade_armed 1");
    expect(text).toContain("artatrade_open_positions 3");
    expect(text).toContain("artatrade_pnl_today_usd -0.5");
    expect(text).toContain("artatrade_winrate_today_pct 50");
    expect(text).toContain('artatrade_event_total{severity="error"} 1');
    expect(text).toContain('artatrade_event_total{severity="warn"} 4');
    expect(text).toContain("artatrade_process_uptime_seconds 124");
    expect(text).not.toContain("NaN");
  });

  it("menghilangkan metrik opsional yang tidak tersedia (bukan NaN)", () => {
    const text = renderPrometheusMetrics({
      executionMode: "LIVE", liveReady: false, armed: false,
      openPositions: 0, closedTradesToday: 0, pnlTodayUsd: 0,
      winRateTodayPct: null, eventCountsBySeverity: {},
      lastTradeAgeSeconds: null, uptimeSeconds: 1, dbSizeBytes: null,
    });
    expect(text).not.toContain("artatrade_winrate_today_pct");
    expect(text).not.toContain("artatrade_last_trade_age_seconds");
    expect(text).not.toContain("artatrade_db_size_bytes");
    expect(text).toContain("artatrade_live_ready 0");
  });

  it("meng-escape label yang mengandung kutip/backslash", () => {
    const text = renderPrometheusMetrics({
      executionMode: 'PAPER"x', liveReady: false, armed: false,
      openPositions: 0, closedTradesToday: 0, pnlTodayUsd: 0,
      winRateTodayPct: null, eventCountsBySeverity: {},
      lastTradeAgeSeconds: null, uptimeSeconds: 1, dbSizeBytes: null,
    });
    expect(text).toContain('mode="PAPER\\"x"');
  });
});

describe("alertFeed (T-16)", () => {
  const row = (over: Partial<EventLogLike> = {}): EventLogLike => ({
    id: 1, type: "RECURRING_MISTAKE", severity: "warn",
    payload: JSON.stringify({ message: "SL_TIGHT 3x dalam 20 trade" }),
    createdAt: now, ...over,
  });

  it("memfilter hanya severity alert dan mempertahankan urutan", () => {
    const rows = [
      row({ id: 1, severity: "warn" }),
      row({ id: 2, severity: "info" }),
      row({ id: 3, severity: "error" }),
      row({ id: 4, severity: "critical" }),
    ];
    expect(buildAlertFeed(rows, 10).map((a) => a.id)).toEqual([1, 3, 4]);
  });

  it("menghormati limit dan membatasi maksimum 100", () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ id: i + 1 }));
    expect(buildAlertFeed(rows, 5)).toHaveLength(5);
    expect(buildAlertFeed(rows, 999)).toHaveLength(100);
    expect(buildAlertFeed(rows, 0)).toHaveLength(1);
  });

  it("payload rusak tidak melempar dan pesan memakai tipe", () => {
    const item = toAlertItem(row({ payload: "{bukan json" }));
    expect(item.message).toBe("RECURRING_MISTAKE");
    expect(item.payload).toEqual({});
  });

  it("memakai reason/error bila message tidak ada dan memotong payload panjang", () => {
    const item = toAlertItem(row({ payload: JSON.stringify({ reason: "X".repeat(400) }) }));
    expect(item.message.startsWith("RECURRING_MISTAKE: X")).toBe(true);
    expect(String(item.payload.reason).length).toBeLessThanOrEqual(301);
  });
});

describe("executionQuality (T-12)", () => {
  it("slippage bertanda: BUY di atas harga = advers positif", () => {
    expect(signedSlippageBps({ price: 100, fillPrice: 100.1, side: "BUY" })).toBeCloseTo(10, 6);
  });

  it("slippage bertanda: SELL di bawah harga = advers positif", () => {
    expect(signedSlippageBps({ price: 100, fillPrice: 99.9, side: "SELL" })).toBeCloseTo(10, 6);
  });

  it("harga/fill invalid => null (tidak dikarang)", () => {
    expect(signedSlippageBps({ price: 0, fillPrice: 1, side: "BUY" })).toBeNull();
    expect(signedSlippageBps({ price: 100, fillPrice: null, side: "BUY" })).toBeNull();
    expect(signedSlippageBps({ price: 100, fillPrice: 100, side: "HOLD" })).toBeNull();
  });

  it("agregasi per venue+tipe: mean/median/p95 slippage, latensi, fee", () => {
    const rows = [
      fill({ id: 1, fillPrice: 100.0, filledAt: new Date(now.getTime() + 1000) }),
      fill({ id: 2, fillPrice: 100.1, filledAt: new Date(now.getTime() + 3000) }),
      fill({ id: 3, fillPrice: 100.2, filledAt: new Date(now.getTime() + 5000) }),
      fill({ id: 4, type: "MARKET", simulated: false, fillPrice: 100.05, feeUsd: 0.05 }),
    ];
    const buckets = summarizeExecutionQuality(rows);
    const paper = buckets.find((b) => b.venue === "PAPER" && b.type === "LIMIT")!;
    expect(paper.n).toBe(3);
    expect(paper.meanSlippageBps).toBeCloseTo(10, 6);
    expect(paper.medianSlippageBps).toBeCloseTo(10, 6);
    expect(paper.p95SlippageBps).toBeCloseTo(20, 6);
    expect(paper.meanLatencyMs).toBeCloseTo(3000, 6);
    expect(paper.sumFeeUsd).toBeCloseTo(0.06, 6);
    const live = buckets.find((b) => b.venue === "LIVE")!;
    expect(live.n).toBe(1);
    expect(live.meanSlippageBps).toBeCloseTo(5, 6);
  });
});

describe("route ops (T-15/T-16/T-12)", () => {
  it("GET /metrics mengembalikan text Prometheus", async () => {
    const app = createApp();
    const res = await request(app).get("/metrics").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# TYPE artatrade_up gauge");
    expect(res.text).toContain("artatrade_up 1");
  });

  it("GET /api/alerts mengembalikan hanya severity alert", async () => {
    await db.eventLog.create({
      data: { type: "TEST_ALERT_WARN", severity: "warn", payload: JSON.stringify({ message: "uji" }) },
    });
    await db.eventLog.create({
      data: { type: "TEST_ALERT_INFO", severity: "info", payload: "{}" },
    });
    const app = createApp();
    const res = await request(app).get("/api/alerts?limit=50").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.every((i: any) => ["warn", "error", "critical"].includes(i.severity))).toBe(true);
    expect(res.body.items.some((i: any) => i.type === "TEST_ALERT_WARN")).toBe(true);
    expect(res.body.items.some((i: any) => i.type === "TEST_ALERT_INFO")).toBe(false);
  });

  it("GET /api/execution-quality mengembalikan bucket dari fill", async () => {
    const clientOrderId = `TEST_EQ_${Date.now()}`;
    await db.orderExec.create({
      data: {
        clientOrderId, symbol: "BTCUSDT", type: "LIMIT", side: "BUY", price: 100,
        qty: 1, reduceOnly: false, status: "FILLED", fillPrice: 100.1, filledQty: 1,
        feeUsd: 0.02, simulated: true, createdAt: new Date(), filledAt: new Date(),
      },
    });
    const app = createApp();
    const res = await request(app).get("/api/execution-quality?days=7").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body.windowDays).toBe(7);
    expect(Array.isArray(res.body.buckets)).toBe(true);
    const paper = res.body.buckets.find((b: any) => b.venue === "PAPER" && b.type === "LIMIT");
    expect(paper).toBeTruthy();
    expect(paper.n).toBeGreaterThanOrEqual(1);
  });
});
