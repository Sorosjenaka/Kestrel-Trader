// apps/server/tests/panelInsights.test.ts — 26 Okt 2026 (TAHAP 4):
// kontrak murni panelInsights: dedup hash, label fallback jujur (bukan LLM),
// dan read model anti-overwrite per panel+simbol.
import { describe, expect, it } from "vitest";
import { callPanelWithTruncationRetry, evidenceHash, panelLlmCallOptions, panelLlmTruncationRetryOptions, PANEL_AI_SCHEMA_VERSION, type PanelEvidence, type PanelId } from "../src/analysis/panelInsights.js";
import type { LlmResponse } from "../src/agents/llmAdapter.js";

function ev(panel: PanelEvidence["panel"], data: Record<string, unknown>, status: PanelEvidence["status"] = "fresh"): PanelEvidence {
  return {
    panel, schemaVersion: PANEL_AI_SCHEMA_VERSION, snapshotId: `ev_${panel}_test`,
    symbol: "BTC", venue: "test", window: "1h", sourceTsMs: 1793000000000,
    fetchedAtMs: 1793000000100, ageMs: 100, status, missingFields: [], data,
  };
}

describe("evidenceHash", () => {
  it("data sama -> hash sama (dedup)", () => {
    const a = [ev("orderflow", { cvd: 1 }), ev("walls", { active: 2 })];
    const b = [ev("orderflow", { cvd: 1 }), ev("walls", { active: 2 })];
    expect(evidenceHash(a)).toBe(evidenceHash(b));
  });

  it("perubahan material -> hash berbeda (analisis ulang boleh)", () => {
    const a = [ev("orderflow", { cvd: 1 })];
    const b = [ev("orderflow", { cvd: -500 })];
    expect(evidenceHash(a)).not.toBe(evidenceHash(b));
  });

  it("status unavailable ikut ter-hash (sumber error terdeteksi)", () => {
    const a = [ev("liqmap", { source: "vike" })];
    const b = [ev("liqmap", { source: "hyperliquid_onchain" }, "stale")];
    expect(evidenceHash(a)).not.toBe(evidenceHash(b));
  });
});

// TAHAP 6C (26 Okt 2026): regresi "combined" gagal 5/5. Akar masalah terukur:
// finishReason "length" (token reasoning menghabiskan budget output 1200 pada
// effort high/xhigh) + LLM_TIMEOUT di batas default 25 dtk. Opsi per panel
// harus tetap sesuai angka terukur — jangan dikembalikan ke 1200/25s/effort
// default untuk combined.
describe("panelLlmCallOptions (TAHAP 6C)", () => {
  it("combined: headroom reasoning 2400t, timeout 45dtk, effort medium", () => {
    const o = panelLlmCallOptions("combined");
    expect(o.maxTokens).toBeGreaterThanOrEqual(2400);
    expect(o.timeoutMs).toBeGreaterThanOrEqual(45_000);
    expect(o.reasoningEffort).toBe("medium");
  });

  it("panel tunggal: tetap 1200t / 25dtk tanpa override effort", () => {
    const singles: PanelId[] = ["orderflow", "walls", "liqmap", "largetrades_vp", "tierflow"];
    for (const p of singles) {
      const o = panelLlmCallOptions(p);
      expect(o.maxTokens).toBe(1200);
      expect(o.timeoutMs).toBe(25_000);
      expect(o.reasoningEffort).toBeUndefined();
    }
  });

  it("combined TIDAK boleh kembali ke konfigurasi yang terbukti memotong respons", () => {
    const o = panelLlmCallOptions("combined");
    // 1200t + effort high/xhigh = TRUNCATED terukur (E1/E4); 25s = timeout produksi.
    expect(o.maxTokens === 1200 && o.reasoningEffort !== "medium").toBe(false);
    expect(o.timeoutMs).toBeGreaterThan(25_000);
  });
});

// TAHAP 6C: ekor berat token reasoning terukur (combined medium: 1176 tok
// sukses vs >2400 tok terpotong pada prompt sama) -> satu retry truncation
// dengan effort lebih rendah + budget lebih besar. HANYA truncation yang
// punya jalur pemulihan.
describe("callPanelWithTruncationRetry (TAHAP 6C)", () => {
  const fakeRes = (attempts = 1): LlmResponse => ({
    content: "ok", model: "test", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
    latencyMs: 1, attempts,
  });

  const truncErr = () => Object.assign(new Error("LLM_TRUNCATED_RESPONSE"), {
    code: "LLM_TRUNCATED_RESPONSE", attempts: 1,
  });

  it("sukses sekali jalan -> tanpa retry, attempts dari provider", async () => {
    const seen: unknown[] = [];
    const r = await callPanelWithTruncationRetry("combined", async (o) => { seen.push(o); return fakeRes(1); });
    expect(r.usedTruncationRetry).toBe(false);
    expect(r.attempts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reasoningEffort: "medium" });
  });

  it("truncation lalu sukses -> retry terpakai (effort low, budget lebih besar)", async () => {
    const seen: unknown[] = [];
    const r = await callPanelWithTruncationRetry("combined", async (o) => {
      seen.push(o);
      if (seen.length === 1) throw truncErr();
      return fakeRes(1);
    });
    expect(r.usedTruncationRetry).toBe(true);
    expect(r.attempts).toBe(2); // 1 attempt terpotong + 1 retry
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ reasoningEffort: "medium", maxTokens: 2400 });
    expect(seen[1]).toMatchObject({ reasoningEffort: "low", maxTokens: 4000 });
  });

  it("error non-truncation (mis. timeout) diteruskan TANPA retry", async () => {
    let calls = 0;
    const timeoutErr = Object.assign(new Error("LLM_TIMEOUT"), { code: "LLM_TIMEOUT", attempts: 1 });
    await expect(callPanelWithTruncationRetry("combined", async () => {
      calls += 1;
      throw timeoutErr;
    })).rejects.toBe(timeoutErr);
    expect(calls).toBe(1);
  });

  it("retry juga terpotong -> error truncation diteruskan apa adanya", async () => {
    let calls = 0;
    await expect(callPanelWithTruncationRetry("orderflow", async () => {
      calls += 1;
      throw truncErr();
    })).rejects.toMatchObject({ code: "LLM_TRUNCATED_RESPONSE" });
    expect(calls).toBe(2);
  });

  it("opsi retry selalu lebih besar budgetnya daripada opsi utama", () => {
    const panels: PanelId[] = ["orderflow", "walls", "liqmap", "largetrades_vp", "tierflow", "combined"];
    for (const p of panels) {
      const base = panelLlmCallOptions(p);
      const retry = panelLlmTruncationRetryOptions(p);
      expect(retry.maxTokens).toBeGreaterThan(base.maxTokens!);
      expect(retry.reasoningEffort).toBe("low");
    }
  });
});