// 26 Okt 2026 (TAHAP 6) — prioritas antrean LLM pada jalur provider yang benar
// (defaultHttpClient.chat + acquireLlmSlot): call narasi (queuePriority "low",
// mis. panel AI) mengalah bila ada call normal (supervisi posisi / judge) yang
// menunggu. Supervisi tidak boleh tertunda oleh narasi.
import { describe, expect, it, vi, afterEach } from "vitest";

type Pending = { tag: string; resolve: (r: Response) => void };
const started: string[] = [];
const pending: Pending[] = [];

function okBody(model: string): string {
  return JSON.stringify({
    id: "x", model, choices: [{ message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

afterEach(() => {
  started.length = 0; pending.length = 0;
  vi.unstubAllGlobals();
  delete process.env.LLM_MAX_CONCURRENCY;
});

async function loadAdapter() {
  process.env.LLM_MAX_CONCURRENCY = "1";
  process.env.XKIRO_API_KEY = "test-key-not-real";
  vi.stubGlobal("fetch", vi.fn((url: unknown, init?: { body?: string }) => {
    const tag = String(JSON.parse(init?.body ?? "{}")?.messages?.[0]?.content ?? "?");
    started.push(tag);
    return new Promise<Response>((resolve) => {
      pending.push({ tag, resolve: (r) => resolve(r) });
    });
  }));
  return await import("../src/agents/llmAdapter.js");
}

describe("antrean LLM berprioritas (supervisi > narasi)", () => {
  it("call low mengalah bila ada call normal yang mengantre; setelah itu tetap jalan", async () => {
    const { defaultHttpClient } = await loadAdapter();
    const call = (tag: string, low = false) =>
      defaultHttpClient.chat([{ role: "user", content: tag }], "xiaomi/mimo-v2.6-flash",
        { maxTokens: 10, queuePriority: low ? "low" : "normal" });

    const p1 = call("p1");
    await new Promise((r) => setTimeout(r, 5));
    const p2 = call("p2");
    const p3 = call("p3", true); // narasi
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(["p1"]); // slot tunggal: p2 & p3 masih antre

    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(["p1", "p2"]); // p2 (normal) menang atas p3 (low)

    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(["p1", "p2", "p3"]); // low tetap dapat giliran (tanpa starvation)

    pending.shift()!.resolve(new Response(okBody("m"), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await Promise.all([p1, p2, p3]);
    expect(res.every((r) => r.content === "ok")).toBe(true);
  });

  it("tanpa pesaing, call low langsung jalan", async () => {
    const { defaultHttpClient } = await loadAdapter();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(okBody("m"),
      { status: 200, headers: { "content-type": "application/json" } })));
    const res = await defaultHttpClient.chat([{ role: "user", content: "x" }], "xiaomi/mimo-v2.6-flash",
      { maxTokens: 10, queuePriority: "low" });
    expect(res.content).toBe("ok");
  });
});
