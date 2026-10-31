// 26 Okt 2026 (TAHAP 6B) — kapasitas LLM: jalur KRITIS (judge/supervisi) punya
// slot CADANGAN, sehingga panel AI yang lambat (priority "low") tidak pernah
// menahan judge.
//
// KONTRAK YANG DIUJI (bukan implementasi):
//  1) Semua kelas NON-KRITIS (normal + low) menghormati slot cadangan:
//     non-kritis maksimal (max - reserve) slot bersamaan.
//  2) Kelas "critical" (judge/supervisi) boleh memakai SEMUA slot, termasuk
//     slot cadangan -> tidak pernah tertahan oleh narasi.
//  3) Fairness antar-simbol: satu simbol (BTC) tidak mengambil giliran
//     berturut-turut di kelas yang sama sehingga menyisakan simbol lain.
//  4) Slot TIDAK bocor dan TIDAK dilepas dua kali pada timeout/abort/error.
//  5) Antrean dan durasi provider dihitung TERPISAH (queueWaitMs vs providerMs).
//
// Uji memakai defaultHttpClient sungguhan dengan fetch di-stub (stub menghormati
// AbortSignal supaya timeout benar-benar terjadi), jadi antrean, slot, dan abort
// benar-benar dijalankan.
import { describe, expect, it, vi, afterEach } from "vitest";

type Pending = { tag: string; resolve: (r: Response) => void; fail: (e: Error) => void };
const started: string[] = [];
const pending: Pending[] = [];

function okBody(model: string): string {
  return JSON.stringify({
    id: "x", model, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

afterEach(() => {
  // Lepaskan semua request yang masih menggantung supaya slot tidak bocor
  // ke test berikutnya.
  for (const p of pending.splice(0)) {
    try { p.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } })); }
    catch { /* sudah selesai */ }
  }
  started.length = 0;
  vi.unstubAllGlobals();
  delete process.env.LLM_MAX_CONCURRENCY;
  delete process.env.LLM_CRITICAL_RESERVE;
});

async function loadAdapter(max: number, reserve: number) {
  process.env.LLM_MAX_CONCURRENCY = String(max);
  process.env.LLM_CRITICAL_RESERVE = String(reserve);
  process.env.XKIRO_API_KEY = "test-key-not-real";
  vi.stubGlobal("fetch", vi.fn((url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const tag = String(JSON.parse(init?.body ?? "{}")?.messages?.[0]?.content ?? "?");
    started.push(tag);
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = { tag, resolve: (r) => resolve(r), fail: reject };
      pending.push(entry);
      // Hormati AbortSignal: stub fetch harus menolak saat controller di-abort,
      // supaya timeout provider benar-benar teruji.
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }));
  return await import("../src/agents/llmAdapter.js");
}

const settle = (ms = 8) => new Promise((r) => setTimeout(r, ms));

describe("TAHAP 6B kapasitas LLM — kontrak slot cadangan", () => {
  it("1) non-kritis (normal DAN low) menghormati slot cadangan; 2) critical mendapat kapasitas cadangan", async () => {
    // 3 slot total, 1 cadangan -> non-kritis maksimal 2 bersamaan.
    const { defaultHttpClient } = await loadAdapter(3, 1);
    const call = (tag: string, cls: "critical" | "normal" | "low") =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "xiaomi/mimo-v2.6-flash",
        { maxTokens: 10, queuePriority: cls, fairnessKey: tag });

    const n1 = call("n1", "normal");
    await settle();
    const n2 = call("n2", "low");
    await settle();
    expect(started).toEqual(["n1", "n2"]);

    // Non-kritis ketiga harus MENUNGGU walau slot total masih ada.
    const n3 = call("n3", "normal");
    await settle();
    expect(started).toEqual(["n1", "n2"]);

    // Judge KRITIS harus jalan sekarang (memakai slot cadangan).
    const judge = call("judge", "critical");
    await settle();
    expect(started).toEqual(["n1", "n2", "judge"]);

    // Selesaikan n1 -> n3 (non-kritis) mendapat giliran: tidak ada slot hilang.
    pending.find((p) => p.tag === "n1")!.resolve(
      new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    expect(started).toEqual(["n1", "n2", "judge", "n3"]);

    for (const tag of ["n2", "judge", "n3"]) {
      pending.find((p) => p.tag === tag)!.resolve(
        new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    }
    const res = await Promise.all([n1, n2, n3, judge]);
    expect(res.every((r) => r.content === "ok")).toBe(true);
  });

  it("3) fairness antar-simbol: BTC tidak mengambil giliran berturut-turut", async () => {
    // 2 slot total, 1 cadangan -> hanya 1 slot narasi (low) bersamaan.
    const { defaultHttpClient } = await loadAdapter(2, 1);
    const call = (tag: string, key: string) =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "xiaomi/mimo-v2.6-flash",
        { maxTokens: 10, queuePriority: "low", fairnessKey: key });

    const p1 = call("BTC-1", "panel:BTC");
    await settle();
    const btc2 = call("BTC-2", "panel:BTC");
    const eth = call("ETH-1", "panel:ETH");
    await settle();
    expect(started).toEqual(["BTC-1"]);

    // Lepaskan slot: giliran berikutnya harus milik ETH (kunci berbeda),
    // bukan BTC-2 yang lebih dulu antre.
    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    expect(started).toEqual(["BTC-1", "ETH-1"]);

    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    expect(started).toEqual(["BTC-1", "ETH-1", "BTC-2"]);

    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await Promise.all([p1, btc2, eth]);
    expect(res.every((r) => r.content === "ok")).toBe(true);
  });

  it("4) timeout dan error melepas slot TEPAT SEKALI (tidak bocor, tidak lepas dua kali)", async () => {
    // 2 slot total, 1 cadangan -> kapasitas non-kritis = 1.
    const { defaultHttpClient } = await loadAdapter(2, 1);
    const call = (tag: string, cls: "critical" | "normal" | "low") =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "xiaomi/mimo-v2.6-flash",
        { maxTokens: 10, queuePriority: cls, fairnessKey: tag, timeoutMs: 60 });

    const t1 = call("t1", "normal");
    // Handler harus terpasang SEBELUM promise ditolak — kalau attaching
    // terlambat, Node mencatat unhandled rejection (false positive).
    const t1Rejected = expect(t1).rejects.toThrow(/LLM_RESPONSE_UNAVAILABLE/);
    await settle();
    expect(started).toEqual(["t1"]);

    // T1 gagal lewat network error -> harus melepas 1 slot.
    pending.find((p) => p.tag === "t1")!.fail(new Error("boom"));
    await settle(20);
    await t1Rejected;

    // T2 timeout (AbortController) -> juga melepas slot.
    const t2 = call("t2", "normal");
    const t2Rejected = expect(t2).rejects.toThrow(/LLM_RESPONSE_UNAVAILABLE/);
    await settle();
    expect(started).toEqual(["t1", "t2"]);
    await t2Rejected;

    // Setelah 2 kegagalan, kapasitas non-kritis harus penuh lagi: call baru
    // harus langsung jalan (bila slot bocor, call ini akan MENUNGGU).
    const r1 = call("r1", "normal");
    await settle();
    expect(started).toContain("r1");

    // Dan hanya 1 yang boleh jalan bersamaan (kapasitas non-kritis = 1).
    const r2 = call("r2", "normal");
    await settle();
    expect(started.filter((t) => t === "r2")).toEqual([]);

    for (const tag of ["r1", "r2"]) {
      const p = pending.find((x) => x.tag === tag);
      if (p) p.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    }
    await settle();
    for (const tag of ["r1", "r2"]) {
      const p = pending.find((x) => x.tag === tag);
      if (p) p.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    }
    const res = await Promise.all([r1, r2]);
    expect(res.every((r) => r.content === "ok")).toBe(true);
  });

  it("5) queueWaitMs (antrean) dan providerMs (provider) dihitung terpisah", async () => {
    const { defaultHttpClient } = await loadAdapter(1, 0);
    const call = (tag: string) =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "xiaomi/mimo-v2.6-flash",
        { maxTokens: 10, queuePriority: "normal", fairnessKey: tag });

    const p1 = call("p1");
    await settle();
    const p2 = call("p2"); // harus menunggu slot
    await settle(120);
    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    const [r1, r2] = await Promise.all([p1, p2]);

    // p1 tidak menunggu -> queueWaitMs kecil; p2 menunggu -> queueWaitMs besar.
    expect(typeof r1.queueWaitMs).toBe("number");
    expect(typeof r1.providerMs).toBe("number");
    expect(r2.queueWaitMs).toBeGreaterThan(r1.queueWaitMs!);
    // Provider time tidak boleh ikut membesar karena antrean.
    expect(r2.providerMs!).toBeLessThan(1000);
    // attempts dan finishReason tersedia untuk diagnosis.
    expect(r1.attempts).toBe(1);
    expect(r1.finishReason).toBe("stop");
  });
});
