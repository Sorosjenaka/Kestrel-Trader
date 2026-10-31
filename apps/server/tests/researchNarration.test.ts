// T-19 (checklist 2026-10-03): narasi LLM di brief riset.
// Angka dihitung TS dan tidak pernah diubah/dihitung ulang LLM (Golden Rules #1);
// label byLlm harus jujur — fallback tidak boleh berpura-pura jadi jawaban LLM.
import { describe, expect, it, vi } from "vitest";
import { ResearchLayer } from "../src/agents/researchLayer.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";

const stats = [{ strategyId: "S-04", trades: 4, winRatePct: 25, evUsd: -0.35 }];

describe("narrateResearchBrief", () => {
  it("narasi LLM diterima dengan label byLlm=true", async () => {
    const layer = new ResearchLayer({
      callFast: vi.fn(async () => ({ content: "Performa S-04 masih di bawah target." })),
    } as unknown as XkiroAdapter);
    const r = await layer.narrateResearchBrief(stats, "2026-10-03");
    expect(r.byLlm).toBe(true);
    expect(r.text).toContain("S-04");
  });

  it("provider gagal -> fallback berlabel byLlm=false", async () => {
    const layer = new ResearchLayer({
      callFast: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as XkiroAdapter);
    const r = await layer.narrateResearchBrief(stats, "2026-10-03");
    expect(r.byLlm).toBe(false);
    expect(r.text).toContain("tidak tersedia");
  });

  it("respons kosong -> fallback, bukan narasi kosong berlabel LLM", async () => {
    const layer = new ResearchLayer({
      callFast: vi.fn(async () => ({ content: "   " })),
    } as unknown as XkiroAdapter);
    const r = await layer.narrateResearchBrief(stats, "2026-10-03");
    expect(r.byLlm).toBe(false);
    expect(r.text.length).toBeGreaterThan(10);
  });

  it("prompt memuat angka hasil hitungan TS, LLM disuruh tidak menghitung ulang", async () => {
    const callFast = vi.fn(async () => ({ content: "ok" }));
    const layer = new ResearchLayer({ callFast } as unknown as XkiroAdapter);
    await layer.narrateResearchBrief(stats, "2026-10-03");
    const userPrompt = String(callFast.mock.calls[0]?.[0] ?? "");
    const sysPrompt = String(callFast.mock.calls[0]?.[1] ?? "");
    expect(userPrompt).toContain("S-04");
    expect(userPrompt).toContain("-0.3500");
    expect(userPrompt).toContain("25.0%");
    expect(sysPrompt).toContain("TIDAK BOLEH Anda ubah");
  });

  it("tanpa trade tertutup tetap aman", async () => {
    const callFast = vi.fn(async () => ({ content: "Belum ada data." }));
    const layer = new ResearchLayer({ callFast } as unknown as XkiroAdapter);
    const r = await layer.narrateResearchBrief([], "2026-10-03");
    expect(r.byLlm).toBe(true);
    expect(String(callFast.mock.calls[0]?.[0] ?? "")).toContain("belum ada trade tertutup");
  });
});
