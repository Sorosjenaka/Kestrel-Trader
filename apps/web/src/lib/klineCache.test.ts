// @vitest-environment node
// apps/web/src/lib/klineCache.test.ts
// Kontrak spec bagian G: fetch punya AbortController timeout 8 dtk dan
// inflight dibersihkan di finally — satu request gantung tidak boleh
// membuat semua retry berikut ikut menggantung selamanya.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchKlineRows, hasInflight } from "./klineCache.js";

describe("klineCache timeout & inflight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("abort 8s membersihkan inflight (request gantung tidak mengunci key)", async () => {
    // fetch yang TIDAK PERNAH selesai kecuali sinyal abort.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));

    const p = fetchKlineRows("BTCUSDT", "15m", 100);
    const guard = p.catch((e: Error) => e); // jangan biarkan unhandled rejection
    expect(hasInflight("BTCUSDT", "15m", 100)).toBe(true);

    await vi.advanceTimersByTimeAsync(8_000); // trigger abort

    const err = await guard;
    expect(err).toBeInstanceOf(Error);
    expect(hasInflight("BTCUSDT", "15m", 100)).toBe(false); // inflight bersih
  });

  it("inflight dibersihkan juga saat respons sukses maupun HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ klines: [[1, 1, 2, 0.5, 1.5, 10]] }), { status: 200 })));
    const rows = await fetchKlineRows("ETHUSDT", "1m", 50);
    expect(rows.length).toBe(1);
    expect(hasInflight("ETHUSDT", "1m", 50)).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchKlineRows("ETHUSDT", "5m", 50)).rejects.toThrow("HTTP 500");
    expect(hasInflight("ETHUSDT", "5m", 50)).toBe(false);
  });
});
