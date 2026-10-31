// apps/server/src/api/routes/microstructureCache.test.ts
// 24 Okt 2026 — test untuk cache snapshot mikrostruktur yang dipakai bersama.
//
// Kenapa ini penting: snapshot mikrostruktur (orderflow, tier-flow, volume
// profile, large trades, liq map) berat. Kalau tiap klien SSE menghitung
// sendiri, N tab browser = N hitung per tick. Cache + request coalescing
// membuat SATU hitung dipakai bersama.

import { describe, expect, it, beforeEach } from "vitest";
import { cached, clearMicrostructureCache, microstructureCacheSize } from "./microstructureCache.js";

describe("cached — cache TTL", () => {
  beforeEach(() => clearMicrostructureCache());

  it("menghitung ulang saat cache kosong", async () => {
    let calls = 0;
    const v = await cached("k", 1000, () => { calls++; return 42; });
    expect(v).toBe(42);
    expect(calls).toBe(1);
  });

  it("memakai nilai cache selama masih dalam TTL", async () => {
    let calls = 0;
    await cached("k", 1000, () => { calls++; return 1; });
    await cached("k", 1000, () => { calls++; return 2; });
    expect(calls).toBe(1);
  });

  it("menghitung ulang setelah TTL habis", async () => {
    let calls = 0;
    await cached("k", 10, () => { calls++; return calls; });
    await new Promise((r) => setTimeout(r, 30));
    await cached("k", 10, () => { calls++; return calls; });
    expect(calls).toBe(2);
  });

  it("key berbeda tidak saling Affect", async () => {
    let a = 0, b = 0;
    await cached("a", 1000, () => { a++; return "A"; });
    await cached("b", 1000, () => { b++; return "B"; });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

describe("cached — request coalescing", () => {
  beforeEach(() => clearMicrostructureCache());

  it("permintaan bersamaan dengan key sama = SATU perhitungan", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return "v";
    };
    const results = await Promise.all([
      cached("same", 1000, compute),
      cached("same", 1000, compute),
      cached("same", 1000, compute),
    ]);
    expect(calls).toBe(1);
    expect(results).toEqual(["v", "v", "v"]);
  });

  it("perhitungan yang gagal TIDAK mengunci key selamanya", async () => {
    let calls = 0;
    await expect(cached("err", 1000, () => { calls++; throw new Error("boom"); })).rejects.toThrow("boom");
    // Percobaan berikutnya harus boleh menghitung ulang.
    const v = await cached("err", 1000, () => { calls++; return "ok"; });
    expect(v).toBe("ok");
    expect(calls).toBe(2);
  });

  it("nilai async dipakai apa adanya", async () => {
    const v = await cached("async", 1000, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { n: 7 };
    });
    expect(v).toEqual({ n: 7 });
  });
});

describe("cached — utilitas", () => {
  beforeEach(() => clearMicrostructureCache());

  it("microstructureCacheSize menghitung entri", async () => {
    expect(microstructureCacheSize()).toBe(0);
    await cached("a", 1000, () => 1);
    await cached("b", 1000, () => 2);
    expect(microstructureCacheSize()).toBe(2);
  });

  it("clearMicrostructureCache mengosongkan cache", async () => {
    await cached("a", 1000, () => 1);
    clearMicrostructureCache();
    expect(microstructureCacheSize()).toBe(0);
  });
});
