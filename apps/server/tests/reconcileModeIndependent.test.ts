// apps/server/tests/reconcileModeIndependent.test.ts - 25 Okt 2026 (G4):
// Sumber exchange reconciler TIDAK boleh di-gate LIVE_MODE — branch ORPHAN
// harus jalan juga saat PAPER supaya posisi live tanpa baris DB
// (GTC/WLD/BOME/MOODENG) terdeteksi di EventLog, bukan diam-diam diabaikan.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PositionReconciler,
  type ReconcileExchangeClient,
  type ReconcileRepo,
} from "../src/exec/reconciler.js";
import type { PositionRow } from "../src/exec/positionSupervisor.js";

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");

describe("G4 — gate LIVE_MODE pada sumber reconciler dihapus", () => {
  it("liveRuntime: exchangeReconcileSource tidak lagi = LIVE_MODE && liveExchange", () => {
    const src = read("../src/exec/liveRuntime.ts");
    expect(src).not.toContain("export const exchangeReconcileSource = LIVE_MODE");
    expect(src).toContain("reconcileClient");
  });

  it("index.ts: boot reconcile tanpa syarat LIVE_MODE", () => {
    const src = read("../src/index.ts");
    expect(src).not.toContain("if (LIVE_MODE && exchangeReconcileSource)");
    expect(src).toContain("if (exchangeReconcileSource)");
  });
});

function mockRepo(rows: Array<Partial<PositionRow>>, events?: string[]): ReconcileRepo {
  return {
    async findOpenPositions() {
      return rows as unknown as PositionRow[];
    },
    async updatePosition() {},
    async createTrade() {},
    async logEvent(type: string) {
      events?.push(type);
    },
  };
}

describe("G4 — branch ORPHAN hidup dengan exchange source (mode-independent)", () => {
  it("posisi exchange tanpa baris DB → ORPHAN; posisi PAPER → SIMULATED_KEPT", async () => {
    const events: string[] = [];
    const repo: ReconcileRepo = mockRepo(
      [{ id: 1, symbol: "AAAUSDT", source: "PAPER_AI", status: "OPEN" }],
      events,
    );
    const exchange: ReconcileExchangeClient = {
      async getOpenPositions() {
        return [
          { symbol: "GTCUSDT", positionAmt: 10, entryPrice: 1, markPrice: 1.1 },
          { symbol: "WLDUSDT", positionAmt: -5, entryPrice: 2, markPrice: 1.9 },
        ];
      },
    };
    const report = await new PositionReconciler({
      repo,
      exchange,
      now: () => new Date("2026-10-25T00:00:00Z"),
    }).reconcile();

    expect(report.orphanCount).toBe(2);
    expect(report.matchedCount).toBe(0);
    expect(report.dbOpenCount).toBe(1);
    expect(report.exchangeOpenCount).toBe(2);
    const orphans = report.details.filter((d) => d.action === "ORPHAN").map((d) => d.symbol).sort();
    expect(orphans).toEqual(["GTCUSDT", "WLDUSDT"]);
    expect(report.details.some((d) => d.symbol === "AAAUSDT" && d.action === "SIMULATED_KEPT")).toBe(true);
    expect(events).toContain("ORPHAN_POSITION_DETECTED");
    expect(events).toContain("BOOT_RECONCILE");
  });

  it("fetch exchange gagal = fail-closed (throw, bukan dianggap flat)", async () => {
    const repo = mockRepo([]);
    const exchange: ReconcileExchangeClient = {
      async getOpenPositions(): Promise<never> {
        throw new Error("network down");
      },
    };
    await expect(
      new PositionReconciler({ repo, exchange }).reconcile(),
    ).rejects.toThrow("RECONCILE_EXCHANGE_SNAPSHOT_UNAVAILABLE");
  });

  it("tanpa exchange source = tetap jalan offline (SIMULATED_KEPT)", async () => {
    const repo = mockRepo([{ id: 7, symbol: "AAAUSDT", source: "PAPER_AI", status: "OPEN" }]);
    const report = await new PositionReconciler({ repo }).reconcile();
    expect(report.orphanCount).toBe(0);
    expect(report.details[0]?.action).toBe("SIMULATED_KEPT");
  });
});
