// apps/server/src/agents/aiContracts.ts
// KONTRAK OUTPUT AGEN: pilihan bertipe + probabilitas ternormalisasi + label sumber.
// Aturan keamanan: kegagalan menjawab TIDAK PERNAH menjadi izin (fail-closed),
// dan label `source` tidak boleh menyamarkan fallback sebagai jawaban LLM.
import { cleanJsonText } from "./llmAdapter.js";

export const TYPED_CHOICES = {
  setupJudge: ["GO", "NO-GO"],
  riskOfficer: ["APPROVED", "REJECTED"],
  macroScout: ["PUMP", "DUMP", "STABLE"],
} as const;

export interface TypedChoiceResult {
  choice: string;
  probabilities: Record<string, number>;
  valid: boolean;
  source: "llm" | "fallback";
}

/** Normalisasi probabilitas: negatif -> 0, jumlahkan jadi 1; kosong -> one-hot pilihan. */
export function normalizeProbs(raw: Record<string, number>, choice: string, keys: readonly string[]): Record<string, number> {
  const vals = keys.map((k) => Math.max(0, Number(raw[k]) || (choice === k ? 1 : 0)));
  const sum = vals.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (sum <= 0) {
    const at = keys.indexOf(choice);
    keys.forEach((k, i) => {
      out[k] = at < 0 ? 1 / keys.length : i === at ? 1 : 0;
    });
    return out;
  }
  keys.forEach((k, i) => {
    out[k] = vals[i] / sum;
  });
  return out;
}

/** Teks kosong/rusak/pilihan di luar daftar -> fallback + source "fallback". */
export function parseTypedChoice(text: string, allowed: readonly string[], fallback: string): TypedChoiceResult {
  let obj: { choice?: unknown; probabilities?: unknown } | null = null;
  try {
    obj = JSON.parse(cleanJsonText(text)) as { choice?: unknown; probabilities?: unknown };
  } catch {
    obj = null;
  }
  const picked = typeof obj?.choice === "string" ? obj.choice.trim().toUpperCase() : "";
  const valid = Boolean(obj) && (allowed as readonly string[]).includes(picked);
  const choice = valid ? picked : fallback;
  return {
    choice,
    probabilities: normalizeProbs((obj?.probabilities ?? {}) as Record<string, number>, choice, allowed),
    valid,
    source: valid ? "llm" : "fallback",
  };
}
