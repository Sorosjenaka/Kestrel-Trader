// apps/server/src/learning/strategyProposal.ts
// TAHAP BUILD (loop 8 tahap). AI TIDAK menulis kode - hanya memilih dari allowlist.
// Hasil divalidasi deterministik sebelum menjadi ParameterVersion CANDIDATE,
// lalu tetap harus lolos gate backtest (Golden Rules #1 dan #9).
import { cleanJsonText } from "../agents/llmAdapter.js";
import type { StrategyStat } from "./researchBrief.js";

export interface ParamBand {
  min: number;
  max: number;
}

export const ALLOWED_PARAMS: Record<string, ParamBand> = {
  tp1R: { min: 1.2, max: 2.5 },
  pullBiasThreshold: { min: 0.5, max: 3 },
};

export interface Proposal {
  strategyId: string;
  param: keyof typeof ALLOWED_PARAMS;
  from: number;
  to: number;
  rationale: string;
}

export function buildProposalPrompt(stats: StrategyStat[]): string {
  const table = stats
    .map((s) => `${s.strategyId}: trade ${s.trades}, WR ${s.winRatePct.toFixed(1)}%, EV ${s.evUsd.toFixed(4)}, PF ${s.profitFactor.toFixed(2)}`)
    .join("\n");
  return [
    "Anda menilai statistik strategi trading. Jangan menghitung nominal uang.",
    "Parameter yang boleh diusulkan: " + Object.keys(ALLOWED_PARAMS).join(", ") + ".",
    "Statistik:",
    table,
    'Balas HANYA JSON: {"action":"propose","strategyId":"...","param":"...","from":<angka>,"to":<angka>,"rationale":"..."} atau {"action":"hold"}',
  ].join("\n");
}

export function validateProposal(raw: unknown): { ok: boolean; proposal: Proposal | null; reason: string } {
  const p = raw as Partial<Proposal> | null;
  if (!p || typeof p !== "object") return { ok: false, proposal: null, reason: "NOT_AN_OBJECT" };
  const band = ALLOWED_PARAMS[String(p.param)];
  if (!band) return { ok: false, proposal: null, reason: "PARAM_NOT_ALLOWED" };
  const from = Number(p.from);
  const to = Number(p.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, proposal: null, reason: "NOT_A_NUMBER" };
  if (from < band.min || from > band.max || to < band.min || to > band.max) {
    return { ok: false, proposal: null, reason: "OUT_OF_BAND" };
  }
  if (typeof p.strategyId !== "string" || !p.strategyId.trim()) return { ok: false, proposal: null, reason: "NO_STRATEGY" };
  return {
    ok: true,
    proposal: { strategyId: p.strategyId, param: p.param as Proposal["param"], from, to, rationale: String(p.rationale ?? "") },
    reason: "OK",
  };
}

export function parseProposal(text: string): { ok: boolean; proposal: Proposal | null; reason: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(cleanJsonText(text));
  } catch {
    return { ok: false, proposal: null, reason: "BAD_JSON" };
  }
  if ((obj as { action?: string })?.action === "hold") return { ok: true, proposal: null, reason: "HOLD" };
  return validateProposal(obj);
}
