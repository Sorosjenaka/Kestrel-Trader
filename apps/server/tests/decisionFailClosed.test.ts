// T-03 (checklist 2026-10-03): TEST PENGINCI, bukan perbaikan.
// Mengunci perilaku benar yang sudah ada: respons LLM kosong/gagal TIDAK PERNAH
// menjadi izin (fail-closed -> NO-GO) dan label byLlm tidak boleh menyamarkan
// fallback sebagai jawaban LLM. Bila test ini merah = REGRESI NYATA, laporkan dulu.
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: { eventLog: { create: vi.fn() } } }));
import { DecisionRiskLayer, type SetupJudgeInput } from "../src/agents/decisionRiskLayer.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const setup: SetupJudgeInput = {
  symbol: "BTCUSDT", side: "LONG", mode: "SCALP", zoneScore: 82, triggerScore: 78,
  knnProb: 0.65, compositeScore: 80, regime: "TRENDING",
};

function layer(content: string, fails = false) {
  const callReason = vi.fn(async () => {
    if (fails) throw new Error("offline");
    return { content };
  });
  return new DecisionRiskLayer({ callReason } as unknown as XkiroAdapter);
}

describe("fail-closed: kegagalan menjawab bukan izin", () => {
  it("respons kosong -> verdict NO-GO, byLlm=false, reason INSUFFICIENT_DATA", async () => {
    const out = await layer("").runSetupJudge(setup);
    expect(out.verdict).toBe("NO-GO");
    expect(out.byLlm).toBe(false);
    expect(out.reason).toContain("INSUFFICIENT_DATA");
  });

  it("provider melempar error -> verdict NO-GO, byLlm=false", async () => {
    const out = await layer("", true).runSetupJudge(setup);
    expect(out.verdict).toBe("NO-GO");
    expect(out.byLlm).toBe(false);
  });

  it("respons bukan kontrak (tanpa baris PUTUSAN) -> NO-GO berlabel fallback", async () => {
    const out = await layer("kayaknya bagus deh").runSetupJudge(setup);
    expect(out.verdict).toBe("NO-GO");
    expect(out.byLlm).toBe(false);
    expect(out.reason).toContain("INSUFFICIENT_DATA");
  });

  it("dua putusan bertentangan dalam satu respons -> tetap NO-GO", async () => {
    const out = await layer("PUTUSAN: GO\nKEYAKINAN: 80\nALASAN: ok\nPUTUSAN: NO-GO").runSetupJudge(setup);
    expect(out.verdict).toBe("NO-GO");
    expect(out.byLlm).toBe(false);
  });
});
