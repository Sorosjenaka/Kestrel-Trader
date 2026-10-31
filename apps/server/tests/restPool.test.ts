// apps/server/tests/restPool.test.ts - uji offline RestPool (FR-23, NFR-03).
// fetch & sleep disuntik: TIDAK ada panggilan jaringan live dalam test ini.
import { describe, expect, it } from "vitest";
import { PoolError, RestPool } from "../src/marketdata/restPool.js";

const okJson = (obj: unknown): Response => new Response(JSON.stringify(obj), { status: 200 });
const html = (): Response => new Response("<!DOCTYPE html><html><body>BLOCKED</body></html>", { status: 200 });
const status = (code: number): Response => new Response("err", { status: code });
const noSleep = async (): Promise<void> => undefined;

describe("RestPool (FR-23, NFR-03)", () => {
  it("host sehat: sukses percobaan pertama", async () => {
    const fetchImpl = (async () => okJson({ serverTime: 123 })) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1", "h2"], fetchImpl, sleep: noSleep });
    const r = await pool.get<{ serverTime: number }>("/fapi/v1/time");
    expect(r.data.serverTime).toBe(123);
    expect(r.host).toBe("h1");
    expect(r.attempts).toBe(1);
  });

  it("failover: h1 gagal jaringan -> h2 sukses + event HOST_SWITCH", async () => {
    const events: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("h1")) throw new Error("ECONNRESET");
      return okJson({ ok: 1 });
    }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1", "h2"], fetchImpl, sleep: noSleep, onEvent: (e) => events.push(e.type) });
    const r = await pool.get("/fapi/v1/time");
    expect(r.host).toBe("h2");
    expect(r.attempts).toBe(2);
    expect(events).toContain("HOST_SWITCH");
  });

  it("circuit breaker: 5 gagal berturut -> host dibuka & dilewati 30 dtk", async () => {
    let h1Calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("h1")) { h1Calls += 1; throw new Error("down"); }
      return okJson({ ok: 1 });
    }) as unknown as typeof fetch;
    let clock = 1_000_000;
    const events: string[] = [];
    const pool = new RestPool({
      hosts: ["h1", "h2"],
      fetchImpl,
      sleep: noSleep,
      now: () => clock,
      failThreshold: 5,
      cooldownMs: 30_000,
      onEvent: (e) => events.push(e.type),
    });
    for (let i = 0; i < 5; i++) await pool.get("/x"); // h1 dipanggil tiap siklus round-robin & selalu gagal
    const h1After5 = h1Calls;
    const snap = pool.snapshot().find((s) => s.host === "h1")!;
    expect(snap.consecutiveFails).toBeGreaterThanOrEqual(5);
    expect(snap.open).toBe(true);
    expect(snap.openUntil - clock).toBe(30_000);
    expect(events).toContain("CIRCUIT_OPEN");
    for (let i = 0; i < 3; i++) await pool.get("/x");
    expect(h1Calls).toBe(h1After5); // tidak ada panggilan tambahan ke host yang terbuka
    clock += 30_001;
    await pool.get("/x"); // setelah cooldown h1 boleh dicoba lagi
    expect(h1Calls).toBe(h1After5 + 1);
  });

  it("retry 3x memakai backoff 250/500/2000 lalu PoolError attempts=4", async () => {
    const sleeps: number[] = [];
    const fetchImpl = (async () => { throw new Error("all down"); }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1"], fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    let caught: PoolError | null = null;
    try { await pool.get("/x"); } catch (e) { caught = e as PoolError; }
    expect(caught).toBeInstanceOf(PoolError);
    expect(caught!.attempts).toBe(4);
    expect(sleeps).toEqual([250, 500, 2000]);
  });

  it("400 (client error) TIDAK di-retry", async () => {    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return status(400); }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1"], fetchImpl, sleep: noSleep });
    let caught: PoolError | null = null;
    try { await pool.get("/x"); } catch (e) { caught = e as PoolError; }
    expect(caught).toBeInstanceOf(PoolError);
    expect(calls).toBe(1);
    expect(caught!.lastStatus).toBe(400);
  });

  it("429 dianggap retryable dan failover ke host berikut", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("h1")) return status(429);
      return okJson({ ok: 1 });
    }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1", "h2"], fetchImpl, sleep: noSleep });
    const r = await pool.get("/x");
    expect(r.host).toBe("h2");
    expect(r.attempts).toBe(2);
  });

  it("2xx non-JSON (halaman blokir) dihitung gagal -> host berikut dipakai", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("h1")) return html();
      return okJson({ ok: 1 });
    }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1", "h2"], fetchImpl, sleep: noSleep });
    const r = await pool.get("/x");
    expect(r.host).toBe("h2");
    expect(r.attempts).toBe(2);
  });

  it("time-sync: offset = serverTime - mid; nowWithOffset memakai offset", async () => {
    const fetchImpl = (async () => okJson({ serverTime: 5000 })) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["h1"], fetchImpl, sleep: noSleep, now: () => 1000 });
    const offset = await pool.measureTimeOffset();
    expect(offset).toBe(4000);
    expect(pool.timeOffsetMs).toBe(4000);
    expect(pool.nowWithOffset()).toBe(5000);
  });

  it("host WAF (202-kosong) tidak membakar retry: tiap percobaan host BERBEDA", async () => {    const called: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = ["w1", "w2", "w3", "ok"].find((h) => url.includes(h)) ?? "?";
      called.push(host);
      if (host === "ok") return okJson({ fine: true });
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    const pool = new RestPool({ hosts: ["w1", "w2", "w3", "ok"], fetchImpl, sleep: noSleep });
    const r = await pool.get("/fapi/v1/klines");
    expect(r.host).toBe("ok");
    expect(r.attempts).toBe(4);
    // 4 percobaan = 4 host berbeda (tanpa pengulangan host mati)
    expect(new Set(called).size).toBe(4);
    expect(called[3]).toBe("ok");
  });

  it("timeoutMs per-request menimpa default pool (klines lambat tidak digagalkan prematur)", async () => {
    let calls = 0;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(okJson({ klines: true })), 80);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    // Default pool 30ms -> gagal (abort); override 500ms -> sukses.
    const pool = new RestPool({ hosts: ["h1"], fetchImpl, sleep: noSleep, timeoutMs: 30 });
    await expect(pool.get("/fapi/v1/klines")).rejects.toBeInstanceOf(PoolError);
    const r = await pool.get<{ klines: boolean }>("/fapi/v1/klines", undefined, 500);
    expect(r.data.klines).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});