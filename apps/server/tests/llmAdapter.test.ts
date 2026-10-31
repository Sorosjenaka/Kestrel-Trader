// apps/server/tests/llmAdapter.test.ts - Uji Xkiro LLM adapter + tracker biaya + degradasi (FR-26, NFR-05).
import { describe, expect, it, vi } from "vitest";
import { env } from "../src/core/env.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  XkiroAdapter,
  LlmCallError,
  LlmClient,
  LlmMessage,
  LlmCallOptions,
  LlmResponse,
  cleanJsonText,
  defaultHttpClient,
  normalizeXkiroModelId,
} from "../src/agents/llmAdapter.js";

class MockLlmClient implements LlmClient {
  public lastModel = "";
  public lastMaxTokens = 0;
  public mockResponseContent = "Mock LLM output";

  async chat(messages: LlmMessage[], model: string, options?: LlmCallOptions): Promise<LlmResponse> {
    this.lastModel = model;
    this.lastMaxTokens = options?.maxTokens ?? 400;

    return {
      content: this.mockResponseContent,
      model,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.000045,
      },
      latencyMs: 120,
    };
  }
}

describe("FR-26 & NFR-05: LLM Adapter & Cost Tracker", () => {
  it.each(["network", "empty", "truncated"])("menolak %s tanpa template AI atau biaya fiktif", async (failure) => {
    const oldKey = env.XKIRO_API_KEY;
    env.XKIRO_API_KEY = "test-key";
    // 28 Okt 2026: mock harus mengembalikan Response BARU per panggilan —
    // body Response hanya bisa dibaca sekali, dan adapter kini punya satu
    // retry isi untuk kosong/terpotong (Response yang sama akan membuat
    // r.json() retry melempar "Body is unusable", bukan skenario yang diuji).
    const fetchMock = vi.spyOn(globalThis, "fetch");
    if (failure === "network") fetchMock.mockRejectedValue(new Error("offline"));
    else fetchMock.mockImplementation(async () => new Response(JSON.stringify({ choices: [{
      message: { content: failure === "empty" ? "" : "unfinished analysis" },
      finish_reason: failure === "truncated" ? "length" : "stop",
    }] }), { status: 200 }));
    const adapter = new XkiroAdapter({ client: defaultHttpClient, monthlyBudgetUsd: 0 });
    try {
      await expect(adapter.callFast("Data makro")).rejects.toThrow("LLM_RESPONSE_UNAVAILABLE");
      expect(adapter.getTrackerState().totalCalls).toBe(0);
      expect(adapter.getTrackerState().dailyCostUsd).toBe(0);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
    }
  });

  it("retry isi kosong/terpotong: TEPAT sekali dengan budget lebih besar + nonce baru (cache-buster)", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const bodies: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      if (bodies.length === 1) {
        // Panggilan pertama: terpotong (finish length, content kosong) —
        // meniru reasoning yang menghabiskan max_tokens.
        return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"side":"LONG"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200 });
    });
    const guards: number[] = [];
    try {
      const res = await defaultHttpClient.chat([{ role: "user", content: "tes" }], "xiaomi/mimo-v2.6-flash", {
        maxTokens: 700,
        reasoningEffort: "high",
        budgetGuard: (attempt: number) => { guards.push(attempt); },
      });
      expect(res.content).toBe('{"side":"LONG"}');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Retry = attempt sungguhan: budgetGuard dipanggil untuk keduanya.
      expect(guards).toEqual([0, 1]);
      const first = JSON.parse(bodies[0]!);
      const retry = JSON.parse(bodies[1]!);
      // Budget output retry lebih besar, effort diturunkan, dan body berbeda
      // (nonce `user` baru) supaya tidak kena cache body-identik upstream.
      expect(retry.max_tokens).toBeGreaterThan(first.max_tokens);
      expect(first.reasoning_effort).toBe("high");
      expect(retry.reasoning_effort).toBe("low");
      expect(retry.user).toBeTruthy();
      expect(retry.user).not.toBe(first.user);
      expect(res.usage.totalTokens).toBe(30);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });

  it("retry isi TIDAK berlaku untuk kegagalan HTTP — 402 tetap satu request", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 402 }));
    try {
      await expect(defaultHttpClient.chat([{ role: "user", content: "ping" }], "xiaomi/mimo-v2.6-flash")).rejects.toThrow("LLM_HTTP_402");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });
  it("cleanJsonText membersihkan pagar kode markdown ```json ... ```", () => {
    const raw = "```json\n{\n  \"verdict\": \"BUY\",\n  \"confidence\": 85\n}\n```";
    const cleaned = cleanJsonText(raw);
    expect(cleaned).toBe('{\n  "verdict": "BUY",\n  "confidence": 85\n}');
    expect(JSON.parse(cleaned).verdict).toBe("BUY");
  });

  it("memakai Xkiro dengan model vendor/model tanpa header sesi provider khusus", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Analisis uji" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }), { status: 200 }));
    try {
      const adapter = new XkiroAdapter({ client: defaultHttpClient, monthlyBudgetUsd: 0 });
      const result = await adapter.callReason("Evaluasi trade", "Anda evaluator");
      expect(result.content).toBe("Analisis uji");
      expect(adapter.getTrackerState().provider).toBe("XKIRO");
      expect(adapter.getTrackerState().modelReason).toBe(normalizeXkiroModelId(env.XKIRO_MODEL_REASON));
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.xkiro.test/v1/chat/completions");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-xkiro-key");
      expect(Object.keys(headers).some((name) => name.toLowerCase().includes("session"))).toBe(false);
      const requestBody = JSON.parse(String((init as RequestInit).body));
      expect(requestBody.model).toBe(normalizeXkiroModelId(env.XKIRO_MODEL_REASON));
      expect(requestBody.reasoning_effort).toBe(env.XKIRO_REASONING_EFFORT);
      expect(result.reasoningEffortRequested).toBe(env.XKIRO_REASONING_EFFORT);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });

  it("normalisasi alias model Mimo ke ID vendor penuh", () => {
    expect(normalizeXkiroModelId("mimo-v2.6-flash")).toBe("xiaomi/mimo-v2.6-flash");
    expect(normalizeXkiroModelId("mimo-v2.6-pro")).toBe("xiaomi/mimo-v2.6-pro");
    expect(normalizeXkiroModelId("xiaomi/mimo-v2.6-pro")).toBe("xiaomi/mimo-v2.6-pro");
    expect(() => normalizeXkiroModelId("unknown-model")).toThrow("XKIRO_MODEL_ID_REQUIRES_VENDOR_PREFIX");
  });

  it("Xkiro mencoba ulang 503 sekali dengan body identik, tetapi 402 langsung gagal", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { status: 200 }));
    try {
      const response = await defaultHttpClient.chat([{ role: "user", content: "ping" }], "xiaomi/mimo-v2.6-pro", { reasoningEffort: "high" });
      expect(response.content).toBe("OK");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe((fetchMock.mock.calls[1][1] as RequestInit).body);
      fetchMock.mockClear().mockResolvedValue(new Response("", { status: 402 }));
      await expect(defaultHttpClient.chat([{ role: "user", content: "ping" }], "xiaomi/mimo-v2.6-pro")).rejects.toThrow("LLM_HTTP_402");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });

  it("Xkiro hanya memakai fallback yang dikonfigurasi dan tidak mencoba route tambahan :free", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 402 }));
    try {
      const adapter = new XkiroAdapter({ client: defaultHttpClient, monthlyBudgetUsd: 0 });
      await expect(adapter.callReason("Uji fallback aman")).rejects.toThrow("LLM_HTTP_402");
      // Jumlah panggilan = primary + fallback terkonfigurasi (bukan hardcode 3:
      // 6 Okt 2026 DeepSeek dihapus, fallback kini bisa kosong).
      expect(fetchMock).toHaveBeenCalledTimes(1 + env.XKIRO_MODEL_REASON_FALLBACKS.length);
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
      expect(bodies.map((body) => body.model)).toEqual([
        normalizeXkiroModelId(env.XKIRO_MODEL_REASON),
        ...env.XKIRO_MODEL_REASON_FALLBACKS.map(normalizeXkiroModelId),
      ]);
      expect(bodies.every((body) => !body.model.includes(":free"))).toBe(true);
      expect(bodies.every((body) => body.reasoning_effort === env.XKIRO_REASONING_EFFORT)).toBe(true);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });

  it("Xkiro memulihkan 403 transien dengan retry dan tidak memakai route :free", async () => {
    const oldKey = env.XKIRO_API_KEY;
    const oldBase = env.XKIRO_BASE_URL;
    env.XKIRO_API_KEY = "test-xkiro-key";
    env.XKIRO_BASE_URL = "https://api.xkiro.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Analisis uji" }, finish_reason: "stop" }],
      }), { status: 200 }));
    try {
      const res = await defaultHttpClient.chat([{ role: "user", content: "ping" }], "xiaomi/mimo-v2.6-pro", { reasoningEffort: "high" });
      expect(res.content).toBe("Analisis uji");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 403 persisten (mis. key salah) tetap gagal sebagai LLM_HTTP_403 setelah
      // budget retry habis, dan TIDAK pernah beralih ke route :free.
      fetchMock.mockClear().mockResolvedValue(new Response("", { status: 403 }));
      await expect(defaultHttpClient.chat([{ role: "user", content: "ping" }], "xiaomi/mimo-v2.6-pro")).rejects.toThrow("LLM_HTTP_403");
      // Tanpa header retry-after, jeda retry instan -> panggilan = 1 + LLM_RETRY_429_MAX.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
      expect(bodies.every((body) => !body.model.includes(":free"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
      env.XKIRO_API_KEY = oldKey;
      env.XKIRO_BASE_URL = oldBase;
    }
  });

  it("callFast menggunakan model FAST (mimo-v2.6-flash) dan mencatat penggunaan biaya", async () => {
    const mock = new MockLlmClient();
    const adapter = new XkiroAdapter({ client: mock });

    expect(adapter.getTrackerState().modelFast).toBe("xiaomi/mimo-v2.6-flash");
    const res = await adapter.callFast("Analisa setup cepat BTCUSDT");
    expect(res.content).toBe("Mock LLM output");
    expect(mock.lastModel).toBe(normalizeXkiroModelId(env.XKIRO_MODEL_FAST));

    const tracker = adapter.getTrackerState();
    expect(tracker.totalCalls).toBe(1);
    expect(tracker.dailyCostUsd).toBeGreaterThan(0);
    expect(tracker.isDegraded).toBe(false);
  });

  it("callReason menggunakan model REASON terkonfigurasi dengan max_tokens >= 900", async () => {
    const mock = new MockLlmClient();
    const adapter = new XkiroAdapter({ client: mock });

    expect(adapter.getTrackerState().modelReason).toBe("xiaomi/mimo-v2.6-pro");
    const res = await adapter.callReason("Evaluasi mendalam setup SMC dan liquidity sweep");
    expect(res.content).toBe("Mock LLM output");
    expect(mock.lastModel).toBe(normalizeXkiroModelId(env.XKIRO_MODEL_REASON));
    expect(mock.lastMaxTokens).toBeGreaterThanOrEqual(900);
  });

  it("callReason mencoba fallback terkonfigurasi berurutan dan meneruskan xhigh", async () => {
    const attempted: Array<{ model: string; effort?: string }> = [];
    // Stub rantai fallback eksplisit: perilaku diuji, bukan konfigurasi provider
    // Fallback chain is explicit configuration; production uses Mimo Pro only.
    const prevReason = env.XKIRO_MODEL_REASON;
    const prevFallbacks = env.XKIRO_MODEL_REASON_FALLBACKS;
    env.XKIRO_MODEL_REASON = "xiaomi/mimo-v2.6-pro";
    env.XKIRO_MODEL_REASON_FALLBACKS = ["test/fallback-a", "test/fallback-b"];
    try {
      const primary = normalizeXkiroModelId(env.XKIRO_MODEL_REASON);
      const fallbacks = env.XKIRO_MODEL_REASON_FALLBACKS.map(normalizeXkiroModelId);
      expect(primary).toBe("xiaomi/mimo-v2.6-pro");
      expect(fallbacks).toEqual(["test/fallback-a", "test/fallback-b"]);
    const client: LlmClient = {
      async chat(_messages, model, options) {
        attempted.push({ model, effort: options?.reasoningEffort });
        if (model !== fallbacks[1]) throw new Error("LLM_RESPONSE_UNAVAILABLE: LLM_HTTP_503");
        return {
          content: "Fallback response",
          model,
          reasoningEffortRequested: options?.reasoningEffort,
          usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7, estimatedCostUsd: 0.00001 },
          latencyMs: 80,
        };
      },
    };
    const adapter = new XkiroAdapter({ client, monthlyBudgetUsd: 0 });
    const result = await adapter.callReason("Uji chain fallback", undefined, { reasoningEffort: "xhigh" });

    expect(attempted.map((item) => item.model)).toEqual([primary, ...fallbacks]);
    expect(attempted.every((item) => item.effort === "xhigh")).toBe(true);
    expect(result.model).toBe(fallbacks[1]);
    expect(adapter.getTrackerState().lastSuccessModel).toBe(fallbacks[1]);
    expect(adapter.getTrackerState().modelReasonFallbacks).toEqual(fallbacks);
    } finally {
      env.XKIRO_MODEL_REASON = prevReason;
      env.XKIRO_MODEL_REASON_FALLBACKS = prevFallbacks;
    }
  });

  it("callJson berhasil mem-parse JSON bahkan bila dibungkus blok kode", async () => {
    const mock = new MockLlmClient();
    mock.mockResponseContent = '```json\n{"regime":"TRENDING","score":88}\n```';
    const adapter = new XkiroAdapter({ client: mock });

    const res = await adapter.callJson<{ regime: string; score: number }>("fast", "Karakterisasi market");
    expect(res.data.regime).toBe("TRENDING");
    expect(res.data.score).toBe(88);
  });

  it("isi kosong/terpotong dari Xkiro memenuhi syarat failover DeepSeek (29 Okt)", async () => {
    // 41/72 kegagalan arena adalah LLM_EMPTY_OR_TRUNCATED_RESPONSE — kelas ini
    // harus dapat peluang kedua di DeepSeek, bukan langsung fail-closed.
    const oldKeys = env.DEEPSEEK_API_KEYS;
    const oldEnabled = env.DEEPSEEK_FAILOVER_ENABLED;
    env.DEEPSEEK_API_KEYS = ["key-a"];
    env.DEEPSEEK_FAILOVER_ENABLED = true;
    // Xkiro harus mengembalikan LLM_EMPTY_OR_TRUNCATED_RESPONSE untuk memicu jalur
    // failover; MockLlmClient default mengembalikan konten valid (tidak memicu error).
    // Kita spy defaultHttpClient.chat agar throw LlmCallError code LLM_EMPTY_RESPONSE.
    const emptyErr = new LlmCallError({ code: "LLM_EMPTY_RESPONSE", legacyCode: "LLM_EMPTY_OR_TRUNCATED_RESPONSE", detail: "EMPTY" });
    const xkiroClient: LlmClient = {
      async chat() { throw emptyErr; },
    };
    const dsMock = new MockLlmClient();
    dsMock.mockResponseContent = "ds-recovered";
    const adapter = new XkiroAdapter({ client: xkiroClient, deepseekClient: dsMock, monthlyBudgetUsd: 0 });
    try {
      const res = await adapter.callFast("Analisa setup");
      expect(res.content).toBe("ds-recovered");
      expect(dsMock.lastModel).toBe(env.DEEPSEEK_MODEL);
      const status = adapter.getTrackerState().deepseek;
      expect(status.failoverCalls).toBeGreaterThan(0);
    } finally {
      env.DEEPSEEK_API_KEYS = oldKeys;
      env.DEEPSEEK_FAILOVER_ENABLED = oldEnabled;
    }
  });

  it("NFR-05: Memasuki mode degradasi saat pemakaian mencapai >= 80% anggaran ($48/$60)", async () => {
    const mock = new MockLlmClient();
    const adapter = new XkiroAdapter({
      client: mock,
      monthlyBudgetUsd: 60.0,
      degradeThresholdPct: 80.0,
      initialMonthlyUsedUsd: 48.50, // 80.8% dari $60
    });

    expect(adapter.isDegraded()).toBe(true);

    // Panggilan non-kritis harus ditolak saat mode degradasi
    await expect(adapter.callFast("Chat santai non-kritis")).rejects.toThrow("degradasi aktif");

    // Panggilan kritis (callReason untuk risk/post-mortem) tetap diizinkan
    const criticalRes = await adapter.callReason("Penilaian risiko darurat");
    expect(criticalRes.content).toBe("Mock LLM output");
  });

  it("NFR-05: Menolak seluruh panggilan jika batas anggaran bulanan ($60) tercapai", async () => {
    const mock = new MockLlmClient();
    const adapter = new XkiroAdapter({
      client: mock,
      monthlyBudgetUsd: 60.0,
      initialMonthlyUsedUsd: 60.05,
    });

    await expect(adapter.callReason("Penilaian risiko")).rejects.toThrow("batas anggaran bulanan");
  });

  it("UNLIMITED: budget <= 0 menghapus semua batas (tanpa degradasi, semua call lolos)", async () => {
    const mock = new MockLlmClient();
    const adapter = new XkiroAdapter({
      client: mock,
      monthlyBudgetUsd: 0,
      degradeThresholdPct: 80.0,
      initialMonthlyUsedUsd: 999.99,
    });

    expect(adapter.isUnlimited()).toBe(true);
    expect(adapter.isDegraded()).toBe(false);
    expect(adapter.getTrackerState().unlimited).toBe(true);
    const res = await adapter.callFast("bebas batas");
    expect(res.content).toBe("Mock LLM output");
    const reasonRes = await adapter.callReason("bebas batas reason");
    expect(reasonRes.content).toBe("Mock LLM output");
  });

  it("GET /api/llm/status mengembalikan metrik anggaran dan status degradasi", async () => {
    const app = createApp();
    const res = await request(app).get("/api/llm/status").set("x-api-token", "vitest-mutation-token").expect(200);

    expect(res.body.status).toBeDefined();
    expect(typeof res.body.status.monthlyBudgetUsd).toBe("number");
    expect(typeof res.body.status.isDegraded).toBe("boolean");
    expect(res.body.status.degradeThresholdPct).toBe(80);
  });
});
