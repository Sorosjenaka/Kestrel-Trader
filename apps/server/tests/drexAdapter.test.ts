// apps/server/tests/drexAdapter.test.ts - Uji adapter Drex: kontrak request, parsing,
// latensi, timeout, 429/5xx, malformed, dan tanpa kebocoran kredensial.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/core/env.js";
import {
  DrexAdapter,
  parseDrexAnswers,
  type DrexQuestions,
} from "../src/agents/drexAdapter.js";

const FAKE_KEY = "test-drex-key-not-real";
const QUESTIONS: DrexQuestions = {
  entry_go: { type: "noul", instructions: "Should this setup be executed?", criteria: { true: "edge", false: "no edge" } },
  direction: { type: "choice", instructions: "Which direction?", criteria: { LONG: "up", SHORT: "down" } },
  setup_strength: { type: "score", instructions: "How strong?", criteria: ["very_weak", "weak", "moderate", "strong", "very_strong"] },
};

const OK_BODY = JSON.stringify({
  model: "drex-v1.5",
  answers: {
    entry_go: { type: "noul", noul: 0.63 },
    direction: { type: "choice", choice: "LONG", confidence: 0.71, probabilities: { LONG: 0.68, SHORT: 0.32 } },
    setup_strength: { type: "score", score: 3.2, confidence: 0.66, legend: ["very_weak", "weak", "moderate", "strong", "very_strong"], probabilities: { "0": 0.02, "1": 0.09, "2": 0.21, "3": 0.44, "4": 0.24 } },
  },
  usage: { input_tokens: 127 },
  evaluation_time_ms: 142.6,
  request_id: "req_test_1",
});

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

function adapterWith(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  const sleep = vi.fn(async () => undefined);
  return { adapter: new DrexAdapter({ fetchImpl, sleep }), calls, fetchImpl, sleep };
}

beforeEach(() => {
  env.DREX_ENABLED = true;
  env.DREX_API_KEY = FAKE_KEY;
  env.DREX_BASE_URL = "https://drex.nace.ai";
  env.DREX_MODEL = "drex-v1.5";
  env.DREX_TIMEOUT_MS = 500;
});

describe("DrexAdapter — request construction", () => {
  it("posts model + state + questions to /v1/systemone with Bearer auth from env", async () => {
    const { adapter, calls } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const res = await adapter.evaluate({ symbol: "BTCUSDT" }, QUESTIONS);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://drex.nace.ai/v1/systemone");
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("drex-v1.5");
    expect(body.state).toEqual({ symbol: "BTCUSDT" });
    expect(Object.keys(body.questions)).toEqual(["entry_go", "direction", "setup_strength"]);
  });

  it("refuses to call out when the API key is missing (no fake credential)", async () => {
    env.DREX_API_KEY = "";
    const { adapter, fetchImpl } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_NO_API_KEY" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("DREX_ENABLED=false disables the layer entirely", async () => {
    env.DREX_ENABLED = false;
    const { adapter, fetchImpl } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_DISABLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DrexAdapter — response parsing", () => {
  it("maps noul/choice/score answers and latency fields", async () => {
    const { adapter } = adapterWith(async () => jsonResponse(200, OK_BODY));
    const res = await adapter.evaluate({}, QUESTIONS);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.answers.entry_go).toEqual({ type: "noul", probability: 0.63 });
    expect(res.data.answers.direction).toMatchObject({ type: "choice", choice: "LONG", confidence: 0.71 });
    expect(res.data.answers.setup_strength).toMatchObject({ type: "score", score: 3.2 });
    expect(res.data.requestId).toBe("req_test_1");
    expect(res.data.evaluationTimeMs).toBe(142.6);
    expect(res.data.model).toBe("drex-v1.5");
    expect(res.data.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(res.data.latency.requestMs + res.data.latency.responseMs).toBeLessThanOrEqual(res.data.latency.totalMs + 5);
  });

  it("accepts a bare numeric noul answer field as documented probability", () => {
    const parsed = parseDrexAnswers(
      { answers: { entry_go: { type: "noul", probability: 0.5 }, direction: { type: "choice", choice: "SHORT" }, setup_strength: { type: "score", score: 1 } } },
      QUESTIONS,
    );
    expect(parsed?.entry_go).toEqual({ type: "noul", probability: 0.5 });
  });

  it("rejects malformed answers (wrong type / out of range / missing question)", () => {
    const base = {
      entry_go: { type: "noul", noul: 0.63 },
      direction: { type: "choice", choice: "LONG" },
      setup_strength: { type: "score", score: 3.2 },
    };
    expect(parseDrexAnswers({ answers: { ...base, entry_go: { type: "noul", noul: 1.5 } } }, QUESTIONS)).toBeNull();
    expect(parseDrexAnswers({ answers: { ...base, direction: { type: "choice", choice: "" } } }, QUESTIONS)).toBeNull();
    expect(parseDrexAnswers({ answers: { ...base, setup_strength: { type: "noul", noul: 0.5 } } }, QUESTIONS)).toBeNull();
    expect(parseDrexAnswers({ answers: { entry_go: base.entry_go, direction: base.direction } }, QUESTIONS)).toBeNull();
    expect(parseDrexAnswers({ answers: "nope" }, QUESTIONS)).toBeNull();
    expect(parseDrexAnswers("not-json-object", QUESTIONS)).toBeNull();
  });
});

describe("DrexAdapter — failure handling", () => {
  it("maps timeout (AbortError) and does not retry beyond one attempt", async () => {
    const { adapter, fetchImpl } = adapterWith(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 retry lalu failover
  });

  it("maps 5xx to DREX_UNAVAILABLE with one retry, then fails over", async () => {
    const { adapter, fetchImpl } = adapterWith(async () => jsonResponse(503, "upstream down"));
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps 429 to DREX_RATE_LIMITED, honors retry-after, then fails over", async () => {
    const { adapter, fetchImpl } = adapterWith(async () => jsonResponse(429, "slow down", { "retry-after": "1" }));
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats 4xx validation errors (incl. 422) as non-retryable", async () => {
    const { adapter, fetchImpl } = adapterWith(async () => jsonResponse(422, '{"error":"bad question"}'));
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res).toMatchObject({ ok: false, code: "DREX_BAD_REQUEST" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flags non-JSON and contract-violating bodies as DREX_MALFORMED_RESPONSE without retry", async () => {
    const bad1 = adapterWith(async () => jsonResponse(200, "<html>gateway</html>"));
    expect(await bad1.adapter.evaluate({}, QUESTIONS)).toMatchObject({ ok: false, code: "DREX_MALFORMED_RESPONSE" });
    expect(bad1.fetchImpl).toHaveBeenCalledTimes(1);
    const bad2 = adapterWith(async () => jsonResponse(200, JSON.stringify({ answers: { entry_go: { type: "noul", noul: "?" } } })));
    expect(await bad2.adapter.evaluate({}, QUESTIONS)).toMatchObject({ ok: false, code: "DREX_MALFORMED_RESPONSE" });
    expect(bad2.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers on retry when the first attempt was transient", async () => {
    let n = 0;
    const { adapter } = adapterWith(async () => {
      n += 1;
      return n === 1 ? jsonResponse(500, "boom") : jsonResponse(200, OK_BODY);
    });
    const res = await adapter.evaluate({}, QUESTIONS);
    expect(res.ok).toBe(true);
  });
});

describe("DrexAdapter — no credential leakage", () => {
  it("never returns the API key in results, details, or serialized output", async () => {
    const { adapter } = adapterWith(async () => jsonResponse(500, `server error mentioning ${FAKE_KEY}`));
    const res = await adapter.evaluate({}, QUESTIONS);
    // Body error dipotong 160 char dan key di-redact: tidak boleh muncul dalam bentuk apa pun.
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(res)).not.toContain(`Bearer ${FAKE_KEY}`);
    const ok = adapterWith(async () => jsonResponse(200, OK_BODY));
    const okRes = await ok.adapter.evaluate({}, QUESTIONS);
    expect(JSON.stringify(okRes)).not.toContain(FAKE_KEY);
  });
});
