// Uji failover DeepSeek (Lighthouse) untuk XkiroAdapter — plan 28 Okt 2026, langkah 4.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/core/env.js";
import {
  XkiroAdapter,
  LlmCallError,
  LlmClient,
  LlmCallOptions,
  LlmLocalAbort,
  LlmMessage,
  LlmResponse,
  deepseekHttpClient,
} from "../src/agents/llmAdapter.js";

const okResponse = (model: string): LlmResponse => ({
  content: `ok-${model}`,
  model,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.000001 },
  latencyMs: 1,
});

const fakeClient = (impl: () => Promise<LlmResponse>): LlmClient & { calls: number } => {
  const c = {
    calls: 0,
    async chat() {
      c.calls += 1;
      return impl();
    },
  };
  return c;
};

const okFetch = () => new Response(JSON.stringify({
  choices: [{ message: { content: "ds-ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}), { status: 200 });

describe("DeepSeek failover (Xkiro primer)", () => {
  let saved: { keys: string[]; enabled: boolean };

  beforeEach(() => {
    saved = { keys: env.DEEPSEEK_API_KEYS, enabled: env.DEEPSEEK_FAILOVER_ENABLED };
    env.DEEPSEEK_API_KEYS = ["key-a", "key-b", "key-c", "key-d"];
    env.DEEPSEEK_FAILOVER_ENABLED = true;
  });

  afterEach(() => {
    env.DEEPSEEK_API_KEYS = saved.keys;
    env.DEEPSEEK_FAILOVER_ENABLED = saved.enabled;
    vi.restoreAllMocks();
  });

  it("1. Xkiro 503 -> failover DeepSeek sukses, model = DeepSeek", async () => {
    const xkiro = fakeClient(async () => {
      throw new LlmCallError({ code: "LLM_HTTP_503", httpStatus: 503 });
    });
    const ds = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const adapter = new XkiroAdapter({ client: xkiro, deepseekClient: ds, monthlyBudgetUsd: 0 });
    const res = await adapter.callFast("prompt");
    expect(ds.calls).toBe(1);
    expect(res.model).toBe(env.DEEPSEEK_MODEL);
    expect(res.content).toBe(`ok-${env.DEEPSEEK_MODEL}`);
  });

  it("2. Xkiro sukses -> DeepSeek TIDAK dipanggil", async () => {
    const xkiro = fakeClient(async () => okResponse("xiaomi/mimo-v2.6-flash"));
    const ds = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const adapter = new XkiroAdapter({ client: xkiro, deepseekClient: ds, monthlyBudgetUsd: 0 });
    const res = await adapter.callFast("prompt");
    expect(ds.calls).toBe(0);
    expect(res.model).toBe("xiaomi/mimo-v2.6-flash");
  });

  it("3. Xkiro dan DeepSeek gagal -> error terakhir diteruskan, legacyCode tetap", async () => {
    const xkiro = fakeClient(async () => {
      throw new LlmCallError({ code: "LLM_HTTP_503", httpStatus: 503 });
    });
    const ds = fakeClient(async () => {
      throw new LlmCallError({ code: "LLM_TIMEOUT", detail: "TIMEOUT" });
    });
    const adapter = new XkiroAdapter({ client: xkiro, deepseekClient: ds, monthlyBudgetUsd: 0 });
    const err = await adapter.callFast("prompt").catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).legacyCode).toBe("LLM_TIMEOUT");
    expect((err as Error).message).toContain("LLM_RESPONSE_UNAVAILABLE");
    expect(ds.calls).toBe(1);
  });

  it("4. Rotasi key: 4 key dipakai bergantian lalu kembali ke awal", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      seen.push(auth.Authorization);
      return okFetch();
    });
    for (let i = 0; i < 5; i++) {
      await deepseekHttpClient.chat([{ role: "user", content: "hi" } as LlmMessage], env.DEEPSEEK_MODEL, { maxTokens: 20 });
    }
    expect(seen.map((s) => s.replace("Bearer ", ""))).toEqual(["key-a", "key-b", "key-c", "key-d", "key-a"]);
  });

  it("5. budgetGuard melempar -> failover tidak terjadi dan DeepSeek tidak dipanggil", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okFetch());
    const guard = vi.fn(() => { throw new LlmLocalAbort("BUDGET_EXHAUSTED", "LLM_BUDGET_EXHAUSTED"); });
    await expect(deepseekHttpClient.chat(
      [{ role: "user", content: "hi" } as LlmMessage],
      env.DEEPSEEK_MODEL,
      { maxTokens: 20, budgetGuard: guard } as LlmCallOptions,
    )).rejects.toBeInstanceOf(LlmLocalAbort);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("6. DEEPSEEK_FAILOVER_ENABLED=false / semua key kosong -> mati total", async () => {
    const xkiroErr = () => fakeClient(async () => {
      throw new LlmCallError({ code: "LLM_HTTP_503", httpStatus: 503 });
    });

    env.DEEPSEEK_FAILOVER_ENABLED = false;
    const ds1 = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const a1 = new XkiroAdapter({ client: xkiroErr(), deepseekClient: ds1, monthlyBudgetUsd: 0 });
    await expect(a1.callFast("p")).rejects.toThrow("LLM_RESPONSE_UNAVAILABLE: LLM_HTTP_503");
    expect(ds1.calls).toBe(0);

    env.DEEPSEEK_FAILOVER_ENABLED = true;
    env.DEEPSEEK_API_KEYS = [];
    const ds2 = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const a2 = new XkiroAdapter({ client: xkiroErr(), deepseekClient: ds2, monthlyBudgetUsd: 0 });
    await expect(a2.callFast("p")).rejects.toThrow("LLM_RESPONSE_UNAVAILABLE: LLM_HTTP_503");
    expect(ds2.calls).toBe(0);
  });

  it("8. getTrackerState melaporkan statistik failover DeepSeek", async () => {
    const xkiro = fakeClient(async () => {
      throw new LlmCallError({ code: "LLM_HTTP_503", httpStatus: 503 });
    });
    const ds = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const adapter = new XkiroAdapter({ client: xkiro, deepseekClient: ds, monthlyBudgetUsd: 0 });
    await adapter.callFast("p");
    const status = adapter.getTrackerState().deepseek;
    expect(status.enabled).toBe(true);
    expect(status.keysConfigured).toBe(4);
    expect(status.failoverCalls).toBeGreaterThan(0);
    expect(status.lastFailoverAt).toBeGreaterThan(0);
  });

  it("7. LlmLocalAbort tidak pernah di-failover", async () => {
    const xkiro = fakeClient(async () => {
      throw new LlmLocalAbort("EVIDENCE_STALE", "LLM_EVIDENCE_STALE");
    });
    const ds = fakeClient(async () => okResponse(env.DEEPSEEK_MODEL));
    const adapter = new XkiroAdapter({ client: xkiro, deepseekClient: ds, monthlyBudgetUsd: 0 });
    await expect(adapter.callFast("p")).rejects.toBeInstanceOf(LlmLocalAbort);
    expect(ds.calls).toBe(0);
  });
});
