// SMB T-04 (9 Okt 2026): mesin diagnosis "5 Whys" — loop rekursif maksimal 5
// lapis untuk mencari akar masalah di balik gejala/deviasi eksekusi.
//
// Kepatuhan TRADING_EVIDENCE_POLICY:
//  - Setiap lapisan berstatus HYPOTHESIS (tidak pernah klaim kausal pasti).
//  - Setiap lapisan WAJIB mensitasi evidenceId dari bundle forensik
//    (facts + annotatedTimeline); tanpa sitasi valid -> status UNKNOWN.
//  - Guardrail: budget token per lapisan + terminasi paksa bila 2 lapis
//    beruntun tidak konvergen (UNKNOWN semua).
// LLM hanya menghasilkan teks hipotesis; tidak ada angka uang dari model.
import type { XkiroAdapter } from "../agents/llmAdapter.js";
import type { TradeForensicBundle } from "./tradeForensics.js";
import { validateEvidenceRefs } from "./tradeForensics.js";
import type { TradeForEvaluation } from "./postMortemEvaluator.js";
import type { ExecutionMistake } from "./executionMistakes.js";

export const FIVE_WHYS_LAYER_FOCUS = [
  "GEJALA_DEVIASI_EKSEKUSI",
  "ALASAN_TAKTIKAL_CHART",
  "ASUMSI_DATA_INDIKATOR",
  "PARAMETER_SIZING_BIAS",
  "CELAH_PLAYBOOK_ATURAN",
] as const;

export const FIVE_WHYS_LIMITS = {
  MAX_LAYERS: 5,
  // 11 Okt 2026 (perintah operator "fix semua"): batas jawaban dinaikkan — potongan
  // slice(0,600) lama memotong 55/70 jawaban di tengah kalimat (temuan audit).
  MAX_TOKENS_PER_LAYER: 1000,
  MAX_ANSWER_CHARS: 4000,
  TIMEOUT_MS: 40_000,
  MIN_ANSWER_CHARS: 30,
  MAX_CONSECUTIVE_UNKNOWN: 2,
} as const;

export interface WhyLayer {
  layer: number;
  focus: string;
  question: string;
  answer: string;
  evidenceRefs: string[];
  status: "HYPOTHESIS" | "UNKNOWN";
  failureCode?: string;
}

export interface FiveWhysResult {
  schemaVersion: 1;
  tradeId: number;
  executionMistake: ExecutionMistake | string;
  layers: WhyLayer[];
  terminated: "COMPLETE" | "NON_CONVERGENT" | "FAILED";
  /** Seluruh rantai adalah hipotesis — bukan kesimpulan kausal (evidence policy). */
  status: "HYPOTHESIS";
}

function layerQuestion(focus: string, trade: TradeForEvaluation, mistake: string, previous: WhyLayer[]): string {
  const prev = previous.length
    ? `Jawaban lapisan sebelumnya:\n${previous.map((p) => `  L${p.layer} [${p.focus}] ${p.answer}`).join("\n")}\n\n`
    : "";
  const base = `Trade #${trade.id} ${trade.symbol} ${trade.side} ${trade.mode}; hasil ${trade.pnlUsd} (${trade.rMultiple}R); kesalahan eksekusi terdeteksi: ${mistake}.\n${prev}`;
  switch (focus) {
    case "GEJALA_DEVIASI_EKSEKUSI":
      return `${base}WHY-1: Apa deviasi eksekusi/plan yang TERAMATI pada trade ini (gejala, bukan penilaian)? Jawab dari bukti yang diberikan.`;
    case "ALASAN_TAKTIKAL_CHART":
      return `${base}WHY-2: Mengapa deviasi itu terjadi secara taktikal di chart (struktur harga, level, momentum)? Hanya berdasar evidence yang tersedia.`;
    case "ASUMSI_DATA_INDIKATOR":
      return `${base}WHY-3: Asumsi data/indikator apa yang meleset sehingga alasan taktikal di atas gagal?`;
    case "PARAMETER_SIZING_BIAS":
      return `${base}WHY-4: Parameter, sizing, atau bias keputusan apa yang memperkuat kegagalan tersebut?`;
    default:
      return `${base}WHY-5: Celah aturan/playbook apa yang memungkinkan rangkaian ini terjadi, dan aturan If-Then apa yang bisa mencegahnya?`;
  }
}

/**
 * Jalankan diagnosis 5 Whys. Adapter LLM boleh gagal per-lapis: lapisan gagal
 * dicatat UNKNOWN + failureCode, loop lanjut sampai guardrail terminasi.
 */
export async function runFiveWhysDiagnosis(opts: {
  adapter: XkiroAdapter;
  trade: TradeForEvaluation;
  forensic: TradeForensicBundle;
  executionMistake: ExecutionMistake | string;
  maxLayers?: number;
  maxTokensPerLayer?: number;
  timeoutMs?: number;
}): Promise<FiveWhysResult> {
  const maxLayers = Math.min(opts.maxLayers ?? FIVE_WHYS_LIMITS.MAX_LAYERS, FIVE_WHYS_LIMITS.MAX_LAYERS);
  const maxTokens = opts.maxTokensPerLayer ?? FIVE_WHYS_LIMITS.MAX_TOKENS_PER_LAYER;
  const timeoutMs = opts.timeoutMs ?? FIVE_WHYS_LIMITS.TIMEOUT_MS;
  const allowed = new Set([
    ...opts.forensic.facts.map((f) => f.id),
    ...opts.forensic.annotatedTimeline.map((p) => p.evidenceId),
  ]);
  const layers: WhyLayer[] = [];
  let consecutiveUnknown = 0;
  let terminated: FiveWhysResult["terminated"] = "COMPLETE";

  const system = `Anda analis pasca-trade yang disiplin. Jawab HANYA JSON valid:
{"answer":"<2-3 kalimat hipotesis spesifik trade ini, Bahasa Indonesia>","evidenceRefs":["<id bukti>"]}
Aturan: status jawaban selalu hipotesis — dilarang mengklaim sebab pasti dari satu trade. evidenceRefs HANYA boleh memakai ID yang persis ada di daftar bukti; tanpa bukti yang cocok, tulis answer apa adanya dan evidenceRefs kosong. Dilarang mengarang angka, indikator, atau kejadian di luar bukti.`;

  for (let layer = 1; layer <= maxLayers; layer += 1) {
    const focus = FIVE_WHYS_LAYER_FOCUS[layer - 1] ?? "CELAH_PLAYBOOK_ATURAN";
    const question = layerQuestion(focus, opts.trade, String(opts.executionMistake), layers);
    const evidenceList = `Daftar evidence ID yang sah: ${[...allowed].join(", ")}`;
    const user = `${question}\n\n${evidenceList}\nCakupan forensik: ${opts.forensic.source}; limitasi: ${opts.forensic.limitation}`;
    let answer = "";
    let refs: string[] = [];
    let failureCode: string | undefined;
    try {
      const res = await opts.adapter.callReason(user, system, { maxTokens, timeoutMs });
      const raw = (res.content ?? "").trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
          if (typeof parsed.answer === "string" && parsed.answer.trim().length >= FIVE_WHYS_LIMITS.MIN_ANSWER_CHARS) {
            answer = parsed.answer.trim().slice(0, FIVE_WHYS_LIMITS.MAX_ANSWER_CHARS);
          }
          refs = validateEvidenceRefs(parsed.evidenceRefs, allowed) ?? [];
        } catch {
          failureCode = "WHY_INVALID_JSON";
        }
      } else {
        failureCode = "WHY_NO_JSON";
      }
    } catch (err) {
      failureCode = err instanceof Error
        ? (err.message.match(/LLM_HTTP_\d{3}|LLM_TIMEOUT|LLM_NETWORK_ERROR|LLM_EMPTY_OR_TRUNCATED_RESPONSE|LLM_API_KEY_NOT_CONFIGURED/)?.[0] ?? "WHY_LLM_UNAVAILABLE")
        : "WHY_LLM_UNAVAILABLE";
    }
    const status: WhyLayer["status"] = answer && refs.length > 0 ? "HYPOTHESIS" : "UNKNOWN";
    layers.push({ layer, focus, question: `WHY-${layer} (${focus})`, answer: answer || "Tidak ada jawaban valid yang tersitasi bukti.", evidenceRefs: refs, status, failureCode });
    consecutiveUnknown = status === "UNKNOWN" ? consecutiveUnknown + 1 : 0;
    if (consecutiveUnknown >= FIVE_WHYS_LIMITS.MAX_CONSECUTIVE_UNKNOWN) {
      terminated = "NON_CONVERGENT";
      break;
    }
  }

  if (layers.length === 0) terminated = "FAILED";
  return { schemaVersion: 1, tradeId: opts.trade.id, executionMistake: opts.executionMistake, layers, terminated, status: "HYPOTHESIS" };
}