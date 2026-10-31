// 26 Okt 2026 (TAHAP 6B) — REPLAY runtime: deadline antrean + preflight freshness
// pada LLM adapter, dibuktikan di isolate (tidak bergantung kondisi pasar).
//
// Menguji LANGSUNG httpClient (bukan defaultLlmAdapter) supaya tidak menyentuh
// DB. Pola mengikuti tests/llmQueueTimeoutRegression.test.ts: env diset SEBELUM
// import modul, fetch di-stub via vi.stubGlobal.
//
// Yang dibuktikan:
//  1) Deadline antrean: request yang menunggu slot lebih lama dari batas
//     dibatalkan LOKAL (LlmLocalAbort "QUEUE_DEADLINE_EXCEEDED") — request
//     TIDAK pernah dikirim ke provider.
//  2) Preflight freshness: evidence basi saat antre -> dibatalkan LOKAL
//     (LlmEvidenceStaleError) — provider tidak dipanggil.
//  3) queueWaitMs dan providerMs terpisah pada hasil sukses.
import { describe, expect, it, vi } from "vitest";

const started: string[] = [];
const pending: Array<{ resolve: (r: Response) => void }> = [];

function okBody(): string {
  return JSON.stringify({
    id: "x", model: "m", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

async function loadAdapter(max: number, reserve: number) {
  process.env.LLM_MAX_CONCURRENCY = String(max);
  process.env.LLM_CRITICAL_RESERVE = String(reserve);
  process.env.XKIRO_API_KEY = "test-key-not-real";
  vi.stubGlobal("fetch", vi.fn((url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const tag = String(JSON.parse(init?.body ?? "{}")?.messages?.[0]?.content ?? "?");
    started.push(tag);
    if (tag === "fast") return Promise.resolve(new Response(okBody(), { status: 200 }));
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve });
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }));
  vi.resetModules();
  return await import("../src/agents/llmAdapter.js");
}

const settle = (ms = 8) => new Promise((r) => setTimeout(r, ms));

describe("REPLAY runtime TAHAP 6B: deadline antrean + preflight freshness", () => {
  it("1) deadline antrean: dibatalkan lokal, provider TIDAK dipanggil", async () => {
    started.length = 0; pending.length = 0;
    const { defaultHttpClient, LlmLocalAbort } = await loadAdapter(1, 0);
    const call = (tag: string, opts: Record<string, unknown>) =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "m",
        { maxTokens: 10, queuePriority: "low", fairnessKey: tag, ...opts } as never);

    // Panggil #1: isi satu-satunya slot dan TAHAN (tidak selesai).
    const held = call("held", {}).catch((e) => e);
    await settle();
    expect(started).toEqual(["held"]);

    // Panggil #2: masuk antrean, deadline 150ms -> harus batal lokal.
    const t0 = Date.now();
    const err = await call("queued", { queueDeadlineMs: 150 }).catch((e) => e);
    const elapsed = Date.now() - t0;

    expect(err).toBeInstanceOf(LlmLocalAbort);
    expect(String((err as Error).message)).toContain("QUEUE_DEADLINE_EXCEEDED");
    // Batal +- deadline, bukan menunggu provider.
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(1500);
    // Provider TIDAK dipanggil untuk request yang dibatalkan.
    expect(started).toEqual(["held"]);

    // Lepaskan slot tertahan supaya test tidak menggantung.
    for (const p of pending) p.resolve(new Response(okBody(), { status: 200 }));
    await held;
  });

  it("2) preflight freshness: evidence basi -> batal lokal, provider TIDAK dipanggil", async () => {
    started.length = 0; pending.length = 0;
    const { defaultHttpClient, LlmEvidenceStaleError } = await loadAdapter(2, 0);
    const err = await defaultHttpClient.chat([{ role: "user", content: "stale" }], "m", {
      maxTokens: 10, queuePriority: "low", fairnessKey: "stale",
      preflight: () => { throw new LlmEvidenceStaleError("EVIDENCE_STALE"); },
    } as never).catch((e) => e);

    expect(err).toBeInstanceOf(LlmEvidenceStaleError);
    // Provider TIDAK dipanggil: request batal sebelum dikirim.
    expect(started).toEqual([]);
  });

  it("3) sukses: queueWaitMs dan providerMs terpisah, provider dipanggil sekali", async () => {
    started.length = 0; pending.length = 0;
    const { defaultHttpClient } = await loadAdapter(2, 0);
    const res = await defaultHttpClient.chat([{ role: "user", content: "fast" }], "m", {
      maxTokens: 10, queuePriority: "low", fairnessKey: "fast",
    } as never);

    expect(started).toEqual(["fast"]);
    // Metrik terpisah: keduanya terisi, dan latency total >= providerMs.
    expect(res.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(res.providerMs).toBeGreaterThanOrEqual(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(res.providerMs);
    expect(res.usage?.totalTokens).toBe(7);
  });
});
