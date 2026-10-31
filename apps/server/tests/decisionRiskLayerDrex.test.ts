// apps/server/tests/decisionRiskLayerDrex.test.ts - Integrasi Drex di runSetupJudge:
// aturan GO, failover ke judge Xkiro, fail-closed, dan tanpa kebocoran kredensial.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: vi.fn() } } }));
import { env } from "../src/core/env.js";
import { DecisionRiskLayer, type SetupJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const FAKE_KEY = "test-drex-key-not-real";
const XGO = "PUTUSAN: GO\nKEYAKINAN: 80\nALASAN: Bukti konfluensi kuat dari judge fallback.";

const setup: SetupJudgeInput = {
  symbol: "BTCUSDT", side: "LONG", mode: "SCALP",
  zoneScore: 82, triggerScore: 78, knnProb: 0.65, compositeScore: 80, regime: "TRENDING",
  entryPrice: 64250, slPrice: 63610, tp1Price: 65210, slPct: 0.01,
  macroAllowed: true,
};

function drexBody(p: number, dir: string, score = 3.2): string {
  return JSON.stringify({
    model: "drex-v1.5",
    answers: {
      entry_go: { type: "noul", noul: p },
      direction: { type: "choice", choice: dir, confidence: 0.7, probabilities: { LONG: 0.7, SHORT: 0.3 } },
      setup_strength: { type: "score", score, confidence: 0.66, legend: ["very_weak", "weak", "moderate", "strong", "very_strong"], probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.4, "4": 0.2 } },
    },
    evaluation_time_ms: 142.6,
    request_id: "req_it_1",
  });
}

function build(opts: {
  drexResponse?: () => Promise<Response>;
  xkiroText?: string;
  xkiroFails?: boolean;
}) {
  const callReason = vi.fn(async () => {
    if (opts.xkiroFails) throw new Error("offline");
    return { content: opts.xkiroText ?? XGO };
  });
  const fetchImpl = vi.fn(async () => {
    if (!opts.drexResponse) throw new Error("no drex handler");
    return opts.drexResponse();
  });
  const drex = new DrexAdapter({ fetchImpl, sleep: async () => undefined });
  const agent = new DecisionRiskLayer({ callReason } as unknown as XkiroAdapter, drex);
  return { agent, callReason, fetchImpl };
}

const resp = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  env.DREX_ENABLED = true;
  env.DREX_API_KEY = FAKE_KEY;
  env.DREX_MIN_ENTRY_PROBABILITY = 0.55;
  env.DREX_MIN_SETUP_STRENGTH = 2;
  env.DREX_TIMEOUT_MS = 500;
});

describe("runSetupJudge + Drex — aturan keputusan", () => {
  it("GO bila Drex layak + gate deterministik lolos; output terpetakan ke JudgeReason", async () => {
    const { agent, callReason, fetchImpl } = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG")) });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("GO");
    expect(res.decisionSource).toBe("drex");
    expect(res.byLlm).toBe(true);
    expect(res.entryProbability).toBe(0.63);
    expect(res.confidence).toBe(63);
    expect(res.direction).toMatchObject({ choice: "LONG", confidence: 0.7 });
    expect(res.setupStrength).toMatchObject({ score: 3.2 });
    expect(res.drexRequestId).toBe("req_it_1");
    expect(res.drexLatency).toMatchObject({ totalMs: expect.any(Number) });
    expect(res.drexRaw).toBeTruthy();
    expect(res.reason).toContain("DREX_GO");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(callReason).not.toHaveBeenCalled(); // Drex sukses = judge Xkiro tidak dipakai
  });

  it("NO-GO bila probabilitas di bawah ambang — walau paperDeterministicEntry aktif", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.4, "LONG")) });
    const res = await agent.runSetupJudge({ ...setup, paperDeterministicEntry: true });
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("DREX_NO_GO");
    expect(res.reason).toContain("ENTRY_PROB");
  });

  it("ambang tepat 0.55 lulus (>=); 0.549 gagal — dan tidak pernah diturunkan otomatis", async () => {
    const ok = build({ drexResponse: async () => resp(200, drexBody(0.55, "LONG")) });
    expect((await ok.agent.runSetupJudge(setup)).verdict).toBe("GO");
    const shy = build({ drexResponse: async () => resp(200, drexBody(0.549, "LONG")) });
    expect((await shy.agent.runSetupJudge(setup)).verdict).toBe("NO-GO");
  });

  it("NO-GO bila arah Drex tidak cocok dengan side yang sudah direncanakan", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.9, "SHORT")) });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("DIRECTION_SHORT!=LONG");
  });

  // ── Conviction gate (operator 11 Okt 2026, dikembalikan ke 2 oleh operator): moderate ke
  // atas LOLOS; weak & very_weak DITOLAK (ambang DREX_MIN_SETUP_STRENGTH = 2) ──
  it("NO-GO bila conviction very_weak (score 0) — ditolak walau probabilitas tinggi", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.95, "LONG", 0)) });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("SETUP_STRENGTH very_weak<moderate");
  });

  it("NO-GO bila conviction weak (score 1)", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.95, "LONG", 1)) });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("SETUP_STRENGTH weak<moderate");
  });

  it("GO bila conviction moderate (score 2) — lolos ambang 2 (operator kembalikan threshold)", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG", 2)) });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("GO");
    expect(res.reason).toContain("DREX_GO");
  });

  it("GO bila conviction strong / very_strong (score 3 dan 4)", async () => {
    for (const s of [3, 4]) {
      const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG", s)) });
      expect((await agent.runSetupJudge(setup)).verdict).toBe("GO");
    }
  });

  it("conviction score pecahan dibaca ke bawah: 1.9 -> weak (ditolak), 2.0 -> moderate (lolos)", async () => {
    const low = build({ drexResponse: async () => resp(200, drexBody(0.95, "LONG", 1.9)) });
    expect((await low.agent.runSetupJudge(setup)).verdict).toBe("NO-GO");
    const edge = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG", 2.0)) });
    expect((await edge.agent.runSetupJudge(setup)).verdict).toBe("GO");
  });

  // ── KNOWN GAP (dilaporkan ke operator 7 Okt 2026) ────────────────────────
  // Bila DREX MENGIRIM jawaban tetapi setup_strength tidak valid, adapter
  // gagal parse -> decisionSource bukan "drex" -> jatuh ke judge fallback,
  // yang bisa saja bilang GO. Artinya conviction gate di bawah TIDAK kecapai.
  // Ini bertentangan dengan Golden Rule "kegagalan menjawab tidak boleh
  // menjadi izin (fail-closed)". Perbaikannya = keputusan desain (apakah
  // error DREX boleh jatuh ke fallback judge), jadi sengaja belum diubah.
  it("KNOWN GAP: setup_strength rusak saat ini jatuh ke judge fallback, bukan fail-closed", async () => {
    const body = JSON.stringify({
      model: "drex-v1.5",
      answers: {
        entry_go: { type: "noul", noul: 0.95 },
        direction: { type: "choice", choice: "LONG", confidence: 0.7, probabilities: null },
        setup_strength: { type: "score", score: "strong", confidence: null, legend: null, probabilities: null },
      },
      evaluation_time_ms: 1, request_id: "req_bad_str",
    });
    const { agent } = build({ drexResponse: async () => resp(200, body) });
    const res = await agent.runSetupJudge(setup);
    // Perilaku saat ini yang diamati: fallback judge yang memutuskan.
    expect(res.reason).not.toContain("DREX_GO");
    expect(res.reason).not.toContain("DREX_NO_GO");
  });

  it("conviction valid TETAP di-gate saat decisionSource=drex: 0/1 ditolak, >=2 lolos (operator 11 Okt 2026)", async () => {
    for (const s of [0, 1]) {
      const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.95, "LONG", s)) });
      const res = await agent.runSetupJudge(setup);
      expect(res.verdict).toBe("NO-GO");
      expect(res.reason).toContain("DREX_NO_GO");
      expect(res.reason).toContain("SETUP_STRENGTH");
    }
    for (const s of [2, 3, 4]) {
      const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG", s)) });
      expect((await agent.runSetupJudge(setup)).verdict).toBe("GO");
    }
  });

  it("NO-GO bila makro belum PASS (fail-closed, opini tidak mengalahkan hard gate)", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.9, "LONG")) });
    const res = await agent.runSetupJudge({ ...setup, macroAllowed: false });
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("MACRO_NOT_ALLOWED");
  });

  it("gate deterministik tetap wajib — skor di bawah ambang tetap NO-GO tanpa exploration override", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.99, "LONG")) });
    const res = await agent.runSetupJudge({
      ...setup, compositeScore: 40, minScore: 70,
      progressiveLevel: 0, allowExplorationGo: true, explorationMinConfidence: 55,
    });
    expect(res.verdict).toBe("NO-GO");
    expect(res.reason).toContain("DETERMINISTIC_GATE_REJECTED");
  });
});

describe("runSetupJudge + Drex — failover & fail-closed", () => {
  it("Drex 5xx -> fallback judge Xkiro (perilaku lama utuh)", async () => {
    const { agent, callReason } = build({
      drexResponse: async () => resp(503, "upstream down"),
      xkiroText: XGO,
    });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("GO");
    expect(res.decisionSource).toBe("xkiro");
    expect(res.drexNote).toBe("DREX_UNAVAILABLE");
    expect(callReason).toHaveBeenCalledTimes(1);
    expect(res.entryProbability).toBeNull();
  });

  it("Drex malformed -> fallback judge Xkiro", async () => {
    const { agent, callReason } = build({
      drexResponse: async () => resp(200, JSON.stringify({ answers: { entry_go: { type: "noul", noul: "?" } } })),
    });
    const res = await agent.runSetupJudge(setup);
    expect(res.decisionSource).toBe("xkiro");
    expect(res.drexNote).toBe("DREX_MALFORMED_RESPONSE");
    expect(callReason).toHaveBeenCalledTimes(1);
  });

  it("kandidat tanpa plan harga (FASE B) tetap di-judge Drex sebagai primer", async () => {
    const { agent, fetchImpl, callReason } = build({ drexResponse: async () => resp(200, drexBody(0.9, "LONG")) });
    const res = await agent.runSetupJudge({ ...setup, entryPrice: undefined, slPrice: undefined, tp1Price: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Drex tetap dipanggil (tanpa field harga)
    expect(callReason).not.toHaveBeenCalled();
    expect(res.decisionSource).toBe("drex");
    expect(res.verdict).toBe("GO");
  });

  it("state tidak lengkap (skor inti invalid) -> tanpa fabrikasi, fallback Xkiro", async () => {
    const { agent, fetchImpl, callReason } = build({ drexResponse: async () => resp(200, drexBody(0.9, "LONG")) });
    const res = await agent.runSetupJudge({ ...setup, compositeScore: NaN });
    expect(fetchImpl).not.toHaveBeenCalled(); // Drex tidak dipanggil dengan data palsu
    expect(res.drexNote).toContain("DREX_STATE_INCOMPLETE");
    expect(res.decisionSource).toBe("xkiro");
    expect(callReason).toHaveBeenCalledTimes(1);
  });

  it("Drex gagal + Xkiro gagal -> fail-closed NO-GO", async () => {
    const { agent } = build({ drexResponse: async () => resp(500, "boom"), xkiroFails: true });
    const res = await agent.runSetupJudge(setup);
    expect(res.verdict).toBe("NO-GO");
    expect(res.byLlm).toBe(false);
    expect(res.reason).toContain("INSUFFICIENT_DATA");
  });

  it("DREX_ENABLED=false mengembalikan perilaku lama penuh (judge Xkiro)", async () => {
    env.DREX_ENABLED = false;
    const { agent, callReason, fetchImpl } = build({ drexResponse: async () => resp(200, drexBody(0.9, "LONG")) });
    const res = await agent.runSetupJudge(setup);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callReason).toHaveBeenCalledTimes(1);
    expect(res.decisionSource).toBe("xkiro");
    expect(res.verdict).toBe("GO");
    expect(res.drexNote).toBe("DREX_DISABLED");
  });

  it("skipLlm (mode deterministik) tidak memanggil Drex maupun Xkiro", async () => {
    const { agent, callReason, fetchImpl } = build({ drexResponse: async () => resp(200, drexBody(0.9, "LONG")) });
    const res = await agent.runSetupJudge({ ...setup, skipLlm: true, outageFallback: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callReason).not.toHaveBeenCalled();
    expect(res.decisionSource).toBe("deterministic");
    expect(res.byLlm).toBe(false);
  });

  it("tidak ada kredensial yang bocor ke output putusan", async () => {
    const { agent } = build({ drexResponse: async () => resp(200, drexBody(0.63, "LONG")) });
    const res = await agent.runSetupJudge(setup);
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(res.dialog)).not.toContain(FAKE_KEY);
  });
});
