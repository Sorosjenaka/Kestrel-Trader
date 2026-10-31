// 26 Okt 2026 (TAHAP 6B) — REGRESSION: "combined" kehabisan waktu AKIBAT ANTREAN.
//
// REPRODUKSI MASALAH ASLI (26 Okt 2026, runtime produksi):
//   journal:  PANEL_AI_LLM_SUCCESS orderflow latencyMs=294005 (4,9 menit)
//             PANEL_AI_FALLBACK   combined  err=LLM_TIMEOUT
//   Penyebab: timer timeout provider dinyalakan SEBELUM slot antrean diperoleh,
//   dan "latency" yang diukur mencakup antrean. Batch 5 panel + combined
//   berjalan SEKUENSIAL pada 1 slot -> request terakhir (combined, prompt
//   terbesar) harus menunggu 4-5 menit, lalu kehabisan waktu.
//
// PERBAIKAN YANG DIUJI (bukan "tambah token" / "tambah timeout"):
//   A) Timeout provider dihitung DARI request dikirim (providerStart), bukan
//      dari saat masuk antrean. Antrean tidak lagi memakan deadline.
//   B) queueWaitMs (antrean) dan providerMs (provider) dihitung TERPISAH.
//   C) Deadline antrean tersendiri: menunggu lebih lama dari batas -> request
//      dibatalkan (LlmLocalAbort), bukan dipaksa berjalan lalu timeout.
//
// Uji memakai defaultHttpClient sungguhan dengan fetch di-stub.
import { describe, expect, it, vi, afterEach } from "vitest";

const started: string[] = [];
const pending: Array<{ resolve: (r: Response) => void }> = [];

function okBody(): string {
  return JSON.stringify({
    id: "x", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

afterEach(() => {
  for (const p of pending.splice(0)) {
    try { p.resolve(new Response(okBody(), { status: 200, headers: { "content-type": "application/json" } })); }
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
      pending.push({ resolve });
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

describe("REGRESSION TAHAP 6B: timeout akibat antrean tidak lagi menimpa combined", () => {
  it("A/B) request yang menunggu antrean lebih lama dari timeout provider TETAP berhasil", async () => {
    // 1 slot total: request kedua HARUS menunggu.
    const { defaultHttpClient } = await loadAdapter(1, 0);
    const call = (tag: string, timeoutMs: number) =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "m",
        { maxTokens: 10, queuePriority: "normal", fairnessKey: tag, timeoutMs });

    // first: timeout panjang, mengisi satu-satunya slot.
    const first = call("first", 5_000);
    await settle();
    expect(started).toEqual(["first"]);

    // second: timeout provider KECIL (120ms) tapi harus menunggu >=250ms di
    // antrean. Pada implementasi lama, timer dimulai saat masuk antrean ->
    // second PASTI LLM_TIMEOUT sebelum sempat dikirim.
    const second = call("second", 120);
    const secondOk = second.catch((e) => e);
    await settle(250);
    expect(started).toEqual(["first"]); // masih antre — slot belum lepas

    // Lepaskan slot -> second dikirim dan timer provider mulai saat itu.
    pending[0]!.resolve(new Response(okBody(), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    expect(started).toEqual(["first", "second"]);

    pending[1]!.resolve(new Response(okBody(), { status: 200, headers: { "content-type": "application/json" } }));
    await settle();
    const r1 = await first;
    const r2 = await secondOk;

    // Bukti perbaikan: TIDAK LLM_TIMEOUT meski antrean >> timeout provider.
    expect(r2.content).toBe("ok");
    expect(r1.content).toBe("ok");

    // B) Metrik terpisah: antrean r2 besar, durasi provider r2 kecil.
    expect(r2.queueWaitMs!).toBeGreaterThan(200);
    expect(r2.providerMs!).toBeLessThan(120);
    expect(r1.queueWaitMs!).toBeLessThan(50);
  });

  it("C) deadline antrean: menunggu terlalu lama dibatalkan, request TIDAK dikirim", async () => {
    const { defaultHttpClient } = await loadAdapter(1, 0);
    // Deadline antrean = 80ms. Request kedua menunggu > deadline -> batal.
    const first = defaultHttpClient.chat([{ role: "user", content: "first" }], "m",
      { maxTokens: 10, queuePriority: "normal", fairnessKey: "first", timeoutMs: 5_000, queueDeadlineMs: 80 });
    await settle();
    const second = defaultHttpClient.chat([{ role: "user", content: "second" }], "m",
      { maxTokens: 10, queuePriority: "normal", fairnessKey: "second", timeoutMs: 5_000, queueDeadlineMs: 80 });
    const rejected = second.catch((e) => e);

    await settle(200);
    const err = await rejected;
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/QUEUE_DEADLINE_EXCEEDED/);
    // Request yang batal TIDAK boleh dikirim ke provider.
    expect(started).toEqual(["first"]);

    pending[0]!.resolve(new Response(okBody(), { status: 200, headers: { "content-type": "application/json" } }));
    await first;
  });
});
