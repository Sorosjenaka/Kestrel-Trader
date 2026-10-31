// tests/signedSnapshotCache.test.ts — A4 (30 Okt 2026, audit
// docs/audit-badai-429-2026-10-30.md).
//
// Mengunci perilaku cache snapshot signed (pengurang panggilan redundan
// watcher/mirror/monitor): dedup TTL, in-flight sharing, gagal/timeout TIDAK
// di-cache (self-healing), ttlMs<=0 = panggil langsung, isolasi per klien.
import { describe, expect, it } from "vitest";
import { cachedOpenAlgoOrders, cachedOpenOrders, cachedPositionRiskAll } from "../src/exec/signedSnapshotCache.js";

function fakeClient() {
  const calls = { risk: 0, algos: 0, orders: 0 };
  const client = {
    calls,
    riskResult: [{ symbol: "AUSDT", positionAmt: "1" }] as unknown[],
    algosResult: [{ clientAlgoId: "SLA_X" }] as unknown[],
    ordersResult: [{ clientOrderId: "m1" }] as unknown[],
    hangRisk: false,
    failRisk: false,
    async getPositionRiskAll() {
      calls.risk += 1;
      if (this.hangRisk) return new Promise<never>(() => { /* menggantung */ });
      if (this.failRisk) throw new Error("simulasi 500");
      return this.riskResult;
    },
    async getOpenAlgoOrders() { calls.algos += 1; return this.algosResult; },
    async getOpenOrders(_symbol?: string) { calls.orders += 1; return this.ordersResult; },
  };
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("signedSnapshotCache — dedup TTL + in-flight sharing", () => {
  it("panggilan berulang dalam TTL berbagi SATU fetch; lewat TTL fetch ulang", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 200, timeoutMs: 1000 };
    await cachedPositionRiskAll(c, opts);
    await cachedPositionRiskAll(c, opts);
    await cachedPositionRiskAll(c, opts);
    expect(c.calls.risk).toBe(1); // 3 konsumen, 1 panggilan
    await sleep(220);
    await cachedPositionRiskAll(c, opts);
    expect(c.calls.risk).toBe(2); // TTL lewat -> fetch ulang
  });

  it("konsumen berbeda (watcher/mirror/monitor) berbagi cache yang sama per klien", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 500, timeoutMs: 1000 };
    const [a, b] = await Promise.all([
      cachedPositionRiskAll(c, opts),
      cachedPositionRiskAll(c, opts),
    ]);
    expect(c.calls.risk).toBe(1); // in-flight sharing saat paralel
    expect(a).toEqual(c.riskResult);
    expect(b).toEqual(c.riskResult);
  });

  it("endpoint berbeda tidak saling berbagi (positionRisk vs openAlgo vs openOrders)", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 500, timeoutMs: 1000 };
    await cachedPositionRiskAll(c, opts);
    await cachedOpenAlgoOrders(c, opts);
    await cachedOpenOrders(c, opts);
    expect(c.calls).toMatchObject({ risk: 1, algos: 1, orders: 1 });
  });

  it("gagal TIDAK di-cache: panggilan berikutnya fetch segar (self-healing)", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 5000, timeoutMs: 1000 };
    c.failRisk = true;
    await expect(cachedPositionRiskAll(c, opts)).rejects.toThrow("simulasi 500");
    c.failRisk = false;
    await expect(cachedPositionRiskAll(c, opts)).resolves.toEqual(c.riskResult);
    expect(c.calls.risk).toBe(2);
  });

  it("fetch menggantung: di-timeout, slot dibebaskan, fetch berikutnya segar (pola mirrorInFlight)", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 5000, timeoutMs: 50 };
    c.hangRisk = true;
    const started = Date.now();
    await expect(cachedPositionRiskAll(c, opts)).rejects.toThrow(/signedSnapshot:positionRisk: timeout/);
    expect(Date.now() - started).toBeLessThan(1000);
    c.hangRisk = false;
    await expect(cachedPositionRiskAll(c, opts)).resolves.toEqual(c.riskResult);
    expect(c.calls.risk).toBe(2); // slot lama tidak teracuni permanen
  });

  it("ttlMs <= 0 = cache mati: selalu panggil langsung", async () => {
    const c = fakeClient();
    await cachedPositionRiskAll(c, { ttlMs: 0 });
    await cachedPositionRiskAll(c, { ttlMs: 0 });
    expect(c.calls.risk).toBe(2);
  });

  it("isolasi per klien: klien B tidak membaca cache klien A", async () => {
    const a = fakeClient();
    const b = fakeClient();
    const opts = { ttlMs: 5000, timeoutMs: 1000 };
    await cachedPositionRiskAll(a, opts);
    await cachedPositionRiskAll(b, opts);
    expect(a.calls.risk).toBe(1);
    expect(b.calls.risk).toBe(1);
  });

  it("nilai cache dipakai ulang persis (tidak berubah/terbuang)", async () => {
    const c = fakeClient();
    const opts = { ttlMs: 5000, timeoutMs: 1000 };
    const first = await cachedOpenAlgoOrders(c, opts);
    c.algosResult = [{ clientAlgoId: "SLA_BARU" }]; // sumber berubah di luar
    const second = await cachedOpenAlgoOrders(c, opts);
    expect(second).toEqual(first); // masih snapshot cache
    expect(c.calls.algos).toBe(1);
  });
});
