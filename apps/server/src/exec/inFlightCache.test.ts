// apps/server/src/exec/inFlightCache.test.ts
// 30 Okt 2026 — regresi untuk fix /api/live/dashboard hang.
// npx vitest run src/exec/inFlightCache.test.ts
//
// Membuktikan 2 hal yang dulu rusak pada getMirrorCached():
//  1. Promise yang TIDAK PERNAH settle (menggantung) tidak lagi menggantungkan
//     caller selamanya -> di-timeout, caller settle (reject).
//  2. Slot in-flight TIDAK teracuni permanen -> setelah gagal/timeout, request
//     berikutnya menjalankan fetch segar, bukan mengembalikan promise buntu.
import { describe, expect, it } from "vitest";
import { createInFlightCache, withTimeout } from "./inFlightCache.js";

const never = () => new Promise<never>(() => { /* tidak pernah settle */ });

describe("withTimeout", () => {
  it("melewatkan nilai bila promise selesai sebelum timeout", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "t")).resolves.toBe(42);
  });

  it("reject saat promise melewati timeout (yang dulu menggantung)", async () => {
    const start = Date.now();
    await expect(withTimeout(never(), 50, "hang")).rejects.toThrow(/hang: timeout 50ms/);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("meneruskan reject asli bila promise gagal", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "t")).rejects.toThrow("boom");
  });
});

describe("createInFlightCache — anti-racun permanen", () => {
  it("timeout tidak menggantungkan caller dan membebaskan slot (fetch segar dipanggil lagi)", async () => {
    let calls = 0;
    const get = createInFlightCache(() => { calls += 1; return never(); }, {
      ttlMs: 10_000, timeoutMs: 40, label: "mirror",
    });

    // Panggilan pertama: menggantung -> di-timeout, settle dengan reject.
    await expect(get()).rejects.toThrow(/mirror: timeout/);
    // Slot harus sudah bebas: panggilan berikutnya menjalankan fetch baru.
    await expect(get()).rejects.toThrow(/mirror: timeout/);
    expect(calls).toBe(2); // bukan 1 (kalau 1 = slot teracuni, fetch kedua tak jalan)
  });

  it("berbagi in-flight: dua caller paralel memakai satu fetch yang sama", async () => {
    let calls = 0;
    const get = createInFlightCache(() => { calls += 1; return Promise.resolve("ok"); }, {
      ttlMs: 10_000, timeoutMs: 1000, label: "m",
    });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(calls).toBe(1); // sharing, bukan dua fetch
  });

  it("cache TTL: setelah sukses, panggilan berikutnya tidak fetch ulang selama masih segar", async () => {
    let calls = 0;
    const get = createInFlightCache(() => { calls += 1; return Promise.resolve("v"); }, {
      ttlMs: 10_000, timeoutMs: 1000, label: "m",
    });
    await get();
    await get();
    expect(calls).toBe(1);
  });

  it("gagal TIDAK disimpan ke cache -> panggilan berikutnya fetch ulang", async () => {
    let calls = 0;
    const get = createInFlightCache(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("first fail")) : Promise.resolve("recovered");
    }, { ttlMs: 10_000, timeoutMs: 1000, label: "m" });

    await expect(get()).rejects.toThrow("first fail");
    await expect(get()).resolves.toBe("recovered"); // hasil gagal tidak di-cache
    expect(calls).toBe(2);
  });
});
