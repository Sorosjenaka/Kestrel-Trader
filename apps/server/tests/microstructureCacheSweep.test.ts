// 25 Okt 2026 (FASE 5) — regression test TTL/prune cache mikrostruktur:
// store TIDAK boleh tumbuh tanpa batas (dulu: permanen per key klien), dan
// sweep tidak menghapus entri yang masih hidup (history tidak disimpan di sini).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cached, clearMicrostructureCache, microstructureCacheSize } from "../src/api/routes/microstructureCache.js";

describe("microstructureCache — TTL & batas ukuran", () => {
  beforeEach(() => {
    clearMicrostructureCache();
  });
  afterEach(() => {
    clearMicrostructureCache();
    vi.useRealTimers();
  });

  it("lebih dari MAX_ENTRIES key -> ukuran dibatasi (buang yang paling tua)", async () => {
    for (let i = 0; i < 250; i++) {
      await cached(`orderflow:SYM${i}:15m`, 60_000, () => ({ i }));
    }
    expect(microstructureCacheSize()).toBeLessThanOrEqual(200);
    // entri paling awal dibuang, yang terbaru tetap ada
    expect(microstructureCacheSize()).toBeGreaterThanOrEqual(50);
  });

  it("entri basi >60 dtk ikut ter-sweep saat tulis baru; entri muda tidak", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    await cached("key-tua", 999_999, () => 1);
    await cached("key-muda", 999_999, () => 2);
    vi.advanceTimersByTime(30_000); // 30 dtk: keduanya masih di bawah MAX_AGE
    await cached("key-3", 60_000, () => 3);
    expect(microstructureCacheSize()).toBe(3);
    vi.advanceTimersByTime(31_000); // total 61 dtk: key-tua & key-muda lewat MAX_AGE
    await cached("key-4", 60_000, () => 4);
    // key-tua & key-muda (61 dtk) tersapu; key-3 (31 dtk) & key-4 masih hidup
    expect(microstructureCacheSize()).toBe(2);
  });

  it("coalescing tetap bekerja: dua pemanggilan bersamaan = satu compute", async () => {
    let calls = 0;
    const compute = () => {
      calls += 1;
      return new Promise<number>((r) => setTimeout(() => r(42), 5));
    };
    const [a, b] = await Promise.all([cached("k", 1_000, compute), cached("k", 1_000, compute)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });
});
