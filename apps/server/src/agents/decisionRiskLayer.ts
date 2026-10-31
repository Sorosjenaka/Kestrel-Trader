// apps/server/src/agents/decisionRiskLayer.ts - Agen Lapis Keputusan & Risiko: Setup Judge & Risk Officer (FR-26, US-06).
import { XkiroAdapter, defaultLlmAdapter } from "./llmAdapter.js";
import { AgentDialog, AgentProfile } from "./researchLayer.js";
import { DrexAdapter, defaultDrexAdapter, type DrexChoiceAnswer, type DrexErrorCode, type DrexEvaluateOk, type DrexLatency, type DrexNoulAnswer, type DrexScoreAnswer } from "./drexAdapter.js";
import { buildDrexState, buildDrexSwingState, buildDrexSwingStateV2, DREX_QUESTIONS, DREX_SWING_QUESTIONS, drexStrengthLabel } from "./drexState.js";
import { renderDrexPanelBrief } from "../analysis/drexPanelEvidence.js";
import { prepareDrexVisionImage } from "./drexVision.js";
import type { DrexChartBar } from "./drexChart.js";
import type { MicrostructureFlowBlock } from "./marketIntel.js";
import { buildMicrostructureBlock } from "./marketIntel.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { createHash } from "node:crypto";
import { db } from "../core/db.js";
import { logDecision } from "../learning/decisionLog.js";
import { TRADING_EVIDENCE_POLICY } from "./tradingPolicy.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

export const DECISION_AGENTS: Record<string, AgentProfile> = {
  "setup-judge": {
    id: "setup-judge",
    name: "Arka",
    personality: "Skeptis, adil, minta bukti",
    style: "Skor 78, tapi KNN 54 persen. NO-GO; data belum cukup kuat.",
    colors: ["#94A3B8", "#D4A017"], // slate + emas tua
    model: "REASON",
  },
  "risk-officer": {
    id: "risk-officer",
    name: "Wardha",
    personality: "Protektif, hati-hati, bicara batas angka",
    style: "Margin $5,31 dari cap $8. Lolos; risiko tetap $1.",
    colors: ["#F97316", "#E5E7EB"], // oranye + gading
    model: "REASON",
  },
};

export interface SetupJudgeInput {
  symbol: string;
  side: "LONG" | "SHORT";
  // 30 Sep 2026 — refactor SCALP-only: mode tunggal.
  mode: "SCALP";
  zoneScore: number;
  triggerScore: number;
  knnProb: number | null;
  compositeScore: number;
  regime: string;
  strategyId?: string | null;
  strategyName?: string | null;
  slPct?: number | null;
  entryPrice?: number;
  slPrice?: number;
  tp1Price?: number;
  // Ambang adaptif:
  minScore?: number;   // default 70
  minKnn?: number;     // default 0.55
  emptySlots?: number; // slot posisi kosong saat ini
  maxPositions?: number;
  // ── Konteks keputusan LLM (T-5.23): makro, likuiditas, pelajaran jurnal ──
  macroDetail?: string | null;
  macroObserverText?: string | null;
  macroAllowed?: boolean;
  strategyEvidence?: string[];
  structureAdx?: number | null;
  structureChop?: number | null;
  biasAdx?: number | null;
  biasChop?: number | null;
  structureAtrPct?: number | null;
  // ── Big Brain Tahap B2/B3/B4 (14 Okt 2026): fitur persepsi untuk memori
  // keputusan — semua opsional, null = tak terdata (tanpa fabrikasi).
  trendScore?: number | null;
  er?: number | null;
  pocDistanceBins?: number | null;
  oiChangePct?: number | null;
  betaBtc?: number | null;
  volumeUsd?: number | null;
  fundingRate?: number | null;
  lessons?: string[] | null;
  /** Status market-fit untuk membedakan strict PASS dari BORDERLINE_REVIEW. */
  marketFilterStatus?: string | null;
  /** true = lewati panggilan LLM (throttle budget) -> putusan deterministik. */
  skipLlm?: boolean;
  // ── Eksplorasi progresif (28 Sep 2026): LLM menilai semua, ambang naik bertahap ──
  /** true = mode deterministik karena LLM outage (vonis tanpa LLM, berlabel jujur). */
  outageFallback?: boolean;
  /**
   * PAPER-only (perintah operator 30 Sep 2026: "isi slot sampai 20/20").
   * Saat true, gate deterministik (skor/KNN) yang menentukan verdict dan
   * keputusan Arka menjadi advisory, sehingga slot benar-benar terisi di
   * simulasi. Di LIVE flag ini TIDAK berlaku (verdict LLM tetap wajib).
   */
  paperDeterministicEntry?: boolean;
  /** Level progresif aktif (0 = eksplorasi longgar, 5 = disiplin ketat). */
  progressiveLevel?: number;
  /** true = LLM GO boleh override skor/KNN di bawah ambang (EXPLORATION_GO). */
  allowExplorationGo?: boolean;
  /** Keyakinan LLM minimum agar exploration GO sah (default 60). */
  explorationMinConfidence?: number;
  /**
   * Blok mikrostruktur & order flow (BAGIAN 3, 24 Okt 2026).
   * Opsional — null = data belum tersedia. Arka WAJIB memeriksa CVD,
   * wall pulled vs eaten, volume profile POC/VAH/VAL, dan magnet likuidasi
   * sebelum memutuskan GO.
   */
  microstructure?: MicrostructureFlowBlock | null;
  /**
   * Menu SL/TP deterministik (Opsi 2 Hybrid, 2 Okt 2026). Saat ada, Arka WAJIB
   * memilih ID varian pada baris PILIHAN_SL/PILIHAN_TP; seluruh angka harga tetap
   * milik kode. Menu tidak ada -> kontrak 3 baris lama (tanpa pilihan).
   */
  slTpMenu?: {
    sl: Array<{ id: string; label: string; slPrice: number; slPct: number; basis: string }>;
    tp: Array<{ id: string; label: string; r: number }>;
    defaultSlId: string;
    defaultTpId: string;
  } | null;
}

/** Input judge Drex lane SWING (23 Okt 2026) — hanya field yang benar-benar
 *  ada di titik keputusan fillSwingSlotsOnce; tanpa knnProb (tidak dihitung
 *  lane SWING) dan tanpa macro gate (tidak ada gate makro deterministik SWING). */
export interface SwingDrexJudgeInput {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyId: string;
  strategyName?: string | null;
  compositeScore: number;
  zoneScore?: number | null;
  triggerScore?: number | null;
  trendScore?: number | null;
  regime?: string | null;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  slPct?: number | null;
  planQuality?: number | null;
  entryType?: string | null;
  zoneType?: string | null;
  tfSummary?: string | null;
  structureAdx?: number | null;
  structureChop?: number | null;
  structureAtrPct?: number | null;
  volumeUsd?: number | null;
  equityUsd?: number | null;
  swingOpen?: number;
  swingCap?: number;
  /** Level TP2/final dari plan sebenarnya (RR23 3R) — untuk state Drex v2. */
  tp2Price?: number | null;
  /**
   * TAHAP 6B + DREX v2 (26 Okt 2026): snapshot evidence LIMA PANEL yang
   * diambil SESUDAH gate deterministik tapi SEBELUM verdict v1. Dipakai HANYA
   * oleh shadow v2 (non-mengikat). null = snapshot gagal diambil -> shadow
   * mencatat SKIPPED_DATA_QUALITY, jalur v1 tidak berubah.
   */
  panelSnapshot?: import("../analysis/drexPanelEvidence.js").DrexPanelSnapshot | null;
  /**
   * Bar OHLC tertutup untuk chart PNG (Drex vision, 24 Okt 2026).
   * OPSIONAL: kalau kosong, Drex menilai dari angka saja (tanpa gambar).
   * Bila diisi DAN DREX_VISION_ENABLED=true, bar ini dirender jadi PNG dan
   * dikirim ke Drex lewat field `images`.
   */
  chartBars?: DrexChartBar[] | null;
}

export type SwingDrexVerdict =
  | { kind: "go"; data: DrexEvaluateOk; p: number | null; direction: string | null; strength: number | null }
  | { kind: "reject"; reason: string; data: DrexEvaluateOk; p: number | null; direction: string | null; strength: number | null }
  | { kind: "skip"; reason: string };

export interface JudgeReason {
  verdict: "GO" | "NO-GO";
  confidence: number;
  confidenceKind: "SUBJECTIVE_NOT_CALIBRATED";
  winProbability: null;
  /** Alasan 1-2 kalimat dari LLM (atau deterministik bila LLM dilewati). */
  reason: string;
  /** true bila putusan ditulis model nyata — judge Xkiro ATAU lapisan Drex (bukan fallback). */
  byLlm: boolean;
  /** ID varian SL yang dipilih LLM dari menu deterministik (null = tidak ada/fallback). */
  slChoice?: string | null;
  /** ID varian TP yang dipilih LLM dari menu deterministik (null = tidak ada/fallback). */
  tpChoice?: string | null;
  /** true bila menu ditawarkan tapi pilihannya tidak valid/kosong -> default deterministik. */
  menuFallback?: boolean;
  // ── Integrasi Drex (3 Okt 2026) — field opsional, kontrak lama tetap utuh ──
  /** Sumber vonis: lapisan Drex, judge Xkiro, atau deterministik (skipLlm/outage). */
  decisionSource?: "drex" | "xkiro" | "deterministic";
  /** Probabilitas GO dari Drex (noul 0..1); null bila Drex tidak menjadi sumber. */
  entryProbability?: number | null;
  /** Jawaban arah Drex (hanya label+distribusi — TIDAK PERNAH harga/ukuran). */
  direction?: { choice: string; confidence: number | null; probabilities: Record<string, number> | null } | null;
  /** Kekuatan setup dari Drex (score + distribusi level). */
  setupStrength?: { score: number; confidence: number | null; legend: string[] | null; probabilities: Record<string, number> | null } | null;
  drexRequestId?: string | null;
  /** Latensi terukur per permintaan Drex (request/response/total, ms). */
  drexLatency?: DrexLatency | null;
  /** Blok mentah jawaban Drex untuk replay ambang — bukan untuk eksekusi. */
  drexRaw?: unknown;
  /** Catatan jalur Drex (skip/error) saat failover ke Xkiro terjadi. */
  drexNote?: string | null;
  /** Big Brain B1 (14 Okt 2026): id baris DecisionLog untuk di-link ke Position saat entry nyata. */
  decisionLogId?: number | null;
}

export interface RiskOfficerInput {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  equityUsd: number;
  targetRiskUsd?: number;
  leverageTarget?: number;
  maxLeverageSnapshot?: number;
  finalPlan?: {
    qty: number; notionalUsd: number; marginUsd: number; leverage: number;
    effectiveRiskUsd: number; estimatedNetRiskUsd?: number;
    allowed: boolean; rejectReason?: string | null;
  };
// Konteks "isi slot" (perintah operator 25 Sep 2026):
  emptySlots?: number;
  maxPositions?: number;
  skipLlm?: boolean;
  /** Blok mikrostruktur (BAGIAN 3, 24 Okt 2026): Wardha memeriksa SL di belakang POC/wall bid. */
  microstructure?: MicrostructureFlowBlock | null;
}

function parseJudgeLlmVerdict(text: string): boolean | null {
  const match = text.match(/^PUTUSAN:\s*(GO|NO-GO)\s*$/im);
  if (!match || !/^ALASAN:\s*\S.+$/im.test(text) || !/^KEYAKINAN:\s*(?:[0-9]|[1-9][0-9])\s*$/im.test(text)) return null;
  if ((text.match(/^PUTUSAN:/gim) ?? []).length !== 1) return null;
  return match[1].toUpperCase() === "GO";
}

function parseJudgeReason(text: string): string {
  const m = text.match(/ALASAN\s*:\s*(.+)/i);
  if (m?.[1]) return m[1].trim().split("\n")[0].trim().slice(0, 300);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const nonHeader = lines.filter((l) => !/^(PUTUSAN|KEYAKINAN|ALASAN)\s*:/i.test(l));
  return (nonHeader[0] ?? lines[0] ?? text).slice(0, 300);
}

function parseJudgeConfidence(text: string, fallback: number): number {
  const m = text.match(/KEYAKINAN\s*[:=]\s*\[?\s*(\d{1,3})/i) || text.match(/(\d{1,3})\s*%/);
  if (m?.[1]) return Math.max(0, Math.min(99, Number(m[1])));
  return fallback;
}

/**
 * Parser pilihan menu yang ketat (Opsi 2 Hybrid). Hanya menerima SATU baris
 * "PILIHAN_SL: X" / "PILIHAN_TP: X" dengan X di dalam `allowed`. Apa pun yang
 * ambigu (duplikat, di luar menu, kosong) -> null -> pemanggil pakai default
 * deterministik. LLM tidak pernah bisa menyelundupkan angka/harga lewat jalur ini.
 */
function parseMenuChoice(text: string, field: "PILIHAN_SL" | "PILIHAN_TP", allowed: readonly string[]): string | null {
  const pick = text.match(new RegExp(`^${field}\\s*[:=]\\s*\\[?\\s*([A-Za-z])\\s*\\]?\\s*$`, "im"));
  if (!pick?.[1]) return null;
  if ((text.match(new RegExp(`^${field}\\s*:`, "gim")) ?? []).length !== 1) return null;
  const id = pick[1].toUpperCase();
  return allowed.includes(id) ? id : null;
}

function parseRiskOfficerLlmApproval(text: string): boolean | null {
  const match = text.match(/^PUTUSAN:\s*(APPROVED|REJECTED)\s*$/im);
  if (!match || !/^ALASAN:\s*\S.+$/im.test(text) || (text.match(/^PUTUSAN:/gim) ?? []).length !== 1) return null;
  return match[1].toUpperCase() === "APPROVED";
}

export class DecisionRiskLayer {
  private readonly adapter: XkiroAdapter;
  private readonly drex: DrexAdapter;
  private readonly memory = new Map<string, string[]>();
  /**
   * TAHAP 6B: dedup invocation shadow per kandidat/plan. Satu kandidat =
   * satu evaluasi v2 (hook baru tidak boleh menggandakan).
   */
  private readonly shadowSeen = new Map<string, number>();

  constructor(adapter?: XkiroAdapter, drex?: DrexAdapter) {
    this.adapter = adapter ?? defaultLlmAdapter;
    this.drex = drex ?? defaultDrexAdapter;
  }

  private appendMemory(agentId: string, text: string) {
    const list = this.memory.get(agentId) ?? [];
    list.push(text);
    if (list.length > 10) list.shift();
    this.memory.set(agentId, list);
  }

  /** Jalankan lapisan Drex bila aktif; hasil selalu Result (tanpa lempar-liar). */
  private async runDrexJudge(input: SetupJudgeInput): Promise<
    { kind: "ok"; data: DrexEvaluateOk } | { kind: "error"; code: DrexErrorCode } | { kind: "skip"; reason: string }
  > {
    if (!this.drex.enabled) {
      return { kind: "skip", reason: env.DREX_ENABLED ? "DREX_NO_API_KEY" : "DREX_DISABLED" };
    }
    const built = buildDrexState(input);
    if (!built.ok) return { kind: "skip", reason: built.reason };
    const res = await this.drex.evaluate(built.state, DREX_QUESTIONS);
    return res.ok ? { kind: "ok", data: res.data } : { kind: "error", code: res.code };
  }

  /** Syarat GO Drex (fail-closed): probabilitas >= ambang, arah cocok plan,
   *  conviction >= ambang, makro PASS. */
  private drexGoRule(
    input: SetupJudgeInput,
    p: number | null,
    direction: DrexChoiceAnswer | null,
    strength: DrexScoreAnswer | null,
  ): boolean {
    if (p === null || !(p >= env.DREX_MIN_ENTRY_PROBABILITY)) return false;
    if (!direction || direction.choice !== input.side) return false;
    // Conviction gate (operator 7 Okt 2026): very_weak & weak DITOLAK.
    // Skor hilang/non-numerik = tolak (fail-closed), bukan dianggap lolos.
    if (strength === null || !Number.isFinite(strength.score)) return false;
    if (!(strength.score >= env.DREX_MIN_SETUP_STRENGTH)) return false;
    return input.macroAllowed === true;
  }

  private drexRejectReason(
    input: SetupJudgeInput, p: number | null,
    direction: DrexChoiceAnswer | null,
    strength: DrexScoreAnswer | null, deterministicPass: boolean,
  ): string {
    const why: string[] = [];
    if (!deterministicPass) why.push("DETERMINISTIC_GATE_REJECTED");
    if (p === null || !(p >= env.DREX_MIN_ENTRY_PROBABILITY)) why.push(`ENTRY_PROB ${(p ?? 0).toFixed(2)}<${env.DREX_MIN_ENTRY_PROBABILITY}`);
    if (!direction || direction.choice !== input.side) why.push(`DIRECTION_${direction?.choice ?? "UNKNOWN"}!=${input.side}`);
    if (strength === null || !Number.isFinite(strength.score) || !(strength.score >= env.DREX_MIN_SETUP_STRENGTH)) {
      const got = strength && Number.isFinite(strength.score)
        ? (drexStrengthLabel(strength.score) ?? String(strength.score))
        : "UNKNOWN";
      const need = drexStrengthLabel(env.DREX_MIN_SETUP_STRENGTH) ?? String(env.DREX_MIN_SETUP_STRENGTH);
      why.push(`SETUP_STRENGTH ${got}<${need}`);
    }
    if (input.macroAllowed !== true) why.push("MACRO_NOT_ALLOWED");
    return why.join("; ") || "DREX_RULE_REJECTED";
  }

  /** Teks vonis Drex untuk dialog/jurnal — deterministik, tanpa harga, tanpa fabrikasi. */
  private formatDrexVerdict(
    input: SetupJudgeInput, data: DrexEvaluateOk, p: number | null,
    direction: DrexChoiceAnswer | null, strength: DrexScoreAnswer | null, go: boolean,
  ): string {
    const pStr = p === null ? "n/a" : p.toFixed(2);
    const confStr = p === null ? "0" : String(Math.round(p * 100));
    const dirStr = direction
      ? `${direction.choice}${direction.probabilities ? ` ${JSON.stringify(direction.probabilities)}` : ""}`
      : "UNKNOWN";
    const strengthStr = strength ? strength.score.toFixed(2) : "n/a";
    return `PUTUSAN: ${go ? "GO" : "NO-GO"}\nKEYAKINAN: ${confStr}\nDREX: entry_go p=${pStr}, direction ${dirStr}, setup_strength ${strengthStr}\nALASAN: Drex ${data.model} (request ${data.requestId ?? "n/a"}): ${go ? `setup ${input.symbol} ${input.side} memenuhi syarat GO lapisan Drex` : "setup ditolak lapisan Drex (fail-closed)"}.`;
  }

  /**
   * Arka = PENGAMBIL KEPUTUSAN entry (perintah operator T-5.23).
   * Explicit skipLlm selects deterministic research mode. Failed/malformed LLM
   * calls never silently become approvals. All numeric gates remain binding.
   */
  async runSetupJudge(input: SetupJudgeInput): Promise<JudgeReason & { dialog: AgentDialog }> {
    const profile = DECISION_AGENTS["setup-judge"];
    const minScore = input.minScore ?? 70;
    const minKnn = input.minKnn ?? 0.55;
    const emptySlots = input.emptySlots ?? 0;
    const progLevel = Number.isFinite(input.progressiveLevel) ? Math.max(0, Math.min(5, Math.floor(input.progressiveLevel!))) : null;
    const allowExplorationGo = input.allowExplorationGo ?? (progLevel !== null && progLevel <= 2);
    const explorationMinConf = Number.isFinite(input.explorationMinConfidence) ? Math.max(0, Math.min(99, Math.floor(input.explorationMinConfidence!))) : 60;

    const lessons = (input.lessons ?? []).filter(Boolean).slice(0, 5);
    const lessonBlock =
      lessons.length > 0
        ? `- OBSERVASI JURNAL (perhatikan label provenance/estimasi):\n${lessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}\n`
        : "";

    const explorationBlock = allowExplorationGo && progLevel !== null
      ? `MODE EKSPLORASI PROGRESIF L${progLevel}: Anda menilai SEMUA kandidat — ambang angka LUNAK (skor>=${minScore}). GO boleh untuk setup borderline yang konfluensinya menjanjikan (tulis KEYAKINAN>=${explorationMinConf} dengan jujur); NO-GO bila likuiditas/risiko/makro tidak meyakinkan. Setiap GO/NO-GO Anda adalah data latih yang menaikkan ambang bertahap menuju trading bagus.\n`
      : `Anda trader futures crypto profesional: skeptis terhadap jebakan market (stop-hunt, fakeout/bull-bear trap,\nchop sideways, divergence). Kualitas & winrate di atas segalanya — slot kosong BUKAN alasan memaksakan entry.\n`;
    // Menu SL/TP deterministik: hanya bila tersedia. Arka memilih ID; angka tetap
    // milik kode. Tanpa menu, kontrak 3 baris lama dipertahankan (backward compat).
    const menu = input.slTpMenu ?? null;
    const slIds = menu ? menu.sl.map((v) => v.id) : [];
    const tpIds = menu ? menu.tp.map((v) => v.id) : [];
    const menuBlock = menu
      ? `MENU SL/TP DETERMINISTIK (pilih ID saja; DILARANG menulis harga/angka sendiri - SL/TP final milik calculator):\n`
        + menu.sl.map((v) => `- SL ${v.id} (${v.label}): harga ${v.slPrice} (${(v.slPct * 100).toFixed(2)}% dari entry), basis ${v.basis}`).join("\n") + "\n"
        + menu.tp.map((v) => `- TP ${v.id}: ${v.r}R`).join("\n") + "\n"
      : "";
    const answerContract = menu
      ? `Jawab TEPAT 5 baris:
PUTUSAN: [GO | NO-GO]
KEYAKINAN: [0-99]
PILIHAN_SL: [${slIds.join(" | ")}]
PILIHAN_TP: [${tpIds.join(" | ")}]
ALASAN: [1-2 kalimat analitis berbasis bukti, Bahasa Indonesia, tanpa emoji]`
      : `Jawab TEPAT 3 baris:
PUTUSAN: [GO | NO-GO]
KEYAKINAN: [0-99]
ALASAN: [1-2 kalimat analitis berbasis bukti, Bahasa Indonesia, tanpa emoji]`;
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), PENGAMBIL KEPUTUSAN entry di Private Trade AI.
Kepribadian: ${profile.personality}.
Gaya bicara: ${profile.style}.
${explorationBlock}${TRADING_EVIDENCE_POLICY}
${menuBlock}${answerContract}`;

    const stratLine = input.strategyId
      ? `- Strategi: ${input.strategyId} (${input.strategyName ?? "n/a"}), SL ${(Number(input.slPct ?? 0) * 100).toFixed(2)}%\n`
      : "";
    const macroLine = input.macroDetail
      ? `- Gate makro deterministik: ${input.macroAllowed === true ? "PASS" : "status belum diketahui"}; ${input.macroDetail}. BTC RANGING/NEUTRAL saja bukan veto bila gate PASS; tetap nilai risiko pair.\n`
      : "";
    const observerLine = input.macroObserverText
      ? `- Observasi Vega (opini agen, tidak dapat mengubah hard gate): ${input.macroObserverText.slice(0, 400)}\n`
      : "";
    const evidenceLine = input.strategyEvidence?.length
      ? `- Bukti setup ${input.strategyId ?? "terpilih"}: ${input.strategyEvidence.slice(0, 6).join(", ")} (plan deterministik MATCH).\n`
      : "";
    const marketFilterLine = input.marketFilterStatus
      ? `Filter anti-sideways: ${input.marketFilterStatus}.`
      : "Filter anti-sideways telah PASS.";
    const marketLine = [input.structureAdx, input.structureChop, input.biasAdx, input.biasChop].every((v) => v != null && Number.isFinite(v))
      ? `- Chart pair: ADX struktur ${input.structureAdx}, CHOP struktur ${input.structureChop}; ADX bias ${input.biasAdx}, CHOP bias ${input.biasChop}; ATR% struktur ${input.structureAtrPct ?? "n/a"}. ${marketFilterLine}\n`
      : "";
    const knnLine = input.knnProb === null
      ? "- KNN: belum ada probabilitas terkalibrasi. Ini bukan hard gate dan tidak boleh menjadi satu-satunya alasan NO-GO; jangan mengarang angkanya.\n"
      : `- KNN: ${(input.knnProb * 100).toFixed(1)}% win dari 5 analog terdekat (ambang heuristik ${(minKnn * 100).toFixed(0)}%). Ini BUKAN probabilitas menang terkalibrasi; jangan sebut sebagai prediksi.\n`;
    const liqLine =
      input.volumeUsd !== undefined && input.volumeUsd !== null
        ? `- Volume futures 24h: $${Number(input.volumeUsd).toFixed(0)} (syarat bot: di atas $${env.VOLUME_MIN_USD.toLocaleString("en-US")})\n`
        : "";
    const fundLine =
      input.fundingRate !== undefined && input.fundingRate !== null
        ? `- Funding rate: ${(Number(input.fundingRate) * 100).toFixed(4)}%\n`
        : "";
    // BAGIAN 3 (24 Okt 2026): konteks mikrostruktur & order flow untuk Arka.
    const micro = input.microstructure;
    const microLine = micro && micro.status !== "UNAVAILABLE"
      ? `- MIKROSTRUKTUR & ORDER FLOW (status: ${micro.status}):\n`
        + `  CVD semua venue: ${micro.orderFlowCvd?.allVenues != null ? `$${(micro.orderFlowCvd.allVenues / 1e6).toFixed(2)}M` : "n/a"} (${micro.orderFlowCvd?.venuesTrading ?? "?"}/${micro.orderFlowCvd?.venuesExpected ?? "?"} venue).\n`
        + `  Wall: aktif=${micro.wallLifelines?.active ?? "?"}, pulled=${micro.wallLifelines?.pulled ?? "?"}, eaten=${micro.wallLifelines?.eaten ?? "?"}, rasio pull/eat=${micro.wallLifelines?.pullEatRatio != null ? micro.wallLifelines.pullEatRatio.toFixed(2) : "n/a"}.\n`
        + `  Volume Profile: POC=$${micro.volumeProfile?.pocPrice != null ? micro.volumeProfile.pocPrice.toFixed(2) : "n/a"}, harga ${micro.volumeProfile?.priceVsValueArea ?? "?"} terhadap VA, total $${((micro.volumeProfile?.totalUsd ?? 0) / 1e6).toFixed(1)}M.\n`
        + `  Likuidasi: magnet=${micro.liquidationMap?.magnetDirection ?? "NONE"}, near long=$${((micro.liquidationMap?.nearLongUsd ?? 0) / 1e6).toFixed(2)}M, near short=$${((micro.liquidationMap?.nearShortUsd ?? 0) / 1e6).toFixed(2)}M.\n`
        + `  Tier flow: bias=${micro.tierAndExchangeFlow?.whaleBias ?? "UNKNOWN"}, whale delta=$${((micro.tierAndExchangeFlow?.whaleDeltaUsd ?? 0) / 1e6).toFixed(2)}M, retail=$${((micro.tierAndExchangeFlow?.retailDeltaUsd ?? 0) / 1e6).toFixed(2)}M.\n`
      : "";

    const userPrompt = `Putuskan setup ${input.symbol} (${input.side} ${input.mode}):
${stratLine}- Zone Score: ${input.zoneScore}/100
- Trigger Score: ${input.triggerScore}/100
- Skor Gabungan: ${input.compositeScore}/100 (ambang ${minScore})
- Regime: ${input.regime}
${knnLine}${evidenceLine}${marketLine}${macroLine}${observerLine}${liqLine}${fundLine}${microLine}${lessonBlock}Trigger Score umum adalah konteks, bukan ambang wajib terpisah; untuk pullback retest lihat bukti retest dan tren pada plan. GO hanya bila bukti konfluensi, risiko, dan likuiditas meyakinkan ANDA.`;

    const scoresValid = [input.zoneScore, input.triggerScore, input.compositeScore, minScore].every((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    const knnValid = input.knnProb === null || (Number.isFinite(input.knnProb) && input.knnProb >= 0 && input.knnProb <= 1);
    const deterministicPass = scoresValid && knnValid && Number.isFinite(minKnn) && minKnn >= 0 && minKnn <= 1 && input.compositeScore >= minScore && (input.knnProb === null || input.knnProb >= minKnn);
    let text = "";
    let byLlm = false;
    let decisionSource: "drex" | "xkiro" | "deterministic" = "deterministic";
    let drexData: DrexEvaluateOk | null = null;
    let entryProbability: number | null = null;
    let drexDirection: DrexChoiceAnswer | null = null;
    let drexStrength: DrexScoreAnswer | null = null;
    let drexRulePass = false;
    let drexNote: string | null = null;
    if (!input.skipLlm) {
      // (1) Lapisan keputusan Drex (3 Okt 2026). Urutan failover:
      // Drex -> judge Xkiro -> fail-closed NO-GO. Gate deterministik tetap di atas.
      const drexRun = await this.runDrexJudge(input);
      if (drexRun.kind === "ok") {
        drexData = drexRun.data;
        entryProbability = (drexRun.data.answers.entry_go as DrexNoulAnswer).probability;
        drexDirection = drexRun.data.answers.direction as DrexChoiceAnswer;
        drexStrength = drexRun.data.answers.setup_strength as DrexScoreAnswer;
        drexRulePass = this.drexGoRule(input, entryProbability, drexDirection, drexStrength);
        decisionSource = "drex";
        // Vonis model nyata (bukan fallback): bookkeeping streak/veto di bot
        // memakai byLlm, dan Drex adalah pengganti verdict judge Xkiro.
        byLlm = true;
        text = this.formatDrexVerdict(input, drexRun.data, entryProbability, drexDirection, drexStrength, drexRulePass && deterministicPass);
      } else {
        drexNote = drexRun.kind === "skip" ? drexRun.reason : drexRun.code;
        // (2) Fallback: judge Xkiro — perilaku lama 100% dipertahankan.
        try {
          const res = await this.adapter.callReason(userPrompt, sysPrompt, {
            maxTokens: 4096,
            // Reasoning responses can exceed 8s when several review candidates
            // arrive together. The bot bounds queue fan-out separately and keeps
            // this timeout finite so a provider stall still fails closed.
            timeoutMs: 15_000,
            // TAHAP 6B: judge entry = jalur KRITIS. Slot cadangan LLM
            // dicadangkan untuk kelas ini supaya narasi panel AI yang lambat
            // tidak pernah menahan proses verdict.
            queuePriority: "critical",
            fairnessKey: `judge:${input.symbol}`,
          });
          text = res.content.trim();
          byLlm = parseJudgeLlmVerdict(text) !== null;
          if (byLlm) decisionSource = "xkiro";
        } catch {
          byLlm = false;
        }
      }
    }
    if (!byLlm) {
      const outageTag = input.outageFallback ? "DETERMINISTIC_GO_NO_LLM (provider 402/outage): " : "";
      text = input.skipLlm
        ? `PUTUSAN: ${deterministicPass ? "GO" : "NO-GO"}\nKEYAKINAN: 0\nALASAN: ${outageTag}Mode deterministik eksplisit; skor ${input.compositeScore}, KNN ${input.knnProb ?? "UNKNOWN"}. Tidak ada probabilitas menang terkalibrasi.`
        : "PUTUSAN: NO-GO\nKEYAKINAN: 0\nALASAN: INSUFFICIENT_DATA: respons LLM gagal, kosong, atau tidak sesuai kontrak.";
    }

    this.appendMemory(profile.id, text);

    const llmPass = parseJudgeLlmVerdict(text);
    const confidence = byLlm
      ? (decisionSource === "drex" && entryProbability !== null ? Math.round(entryProbability * 100) : parseJudgeConfidence(text, 0))
      : 0;
    // EXPLORATION_GO (28 Sep 2026): di level rendah, LLM GO yang valid + keyakinan
    // cukup boleh override skor/KNN lunak — inilah "LLM menilai semua". Data
    // numerik INVALID (NaN/out-of-range) tetap NO-GO di semua level.
    // Jalur Drex TIDAK punya exploration override: syarat GO Drex wajib
    // deterministik pass + probabilitas + arah cocok + makro lolos (fail-closed).
    const numericSane = scoresValid && knnValid && Number.isFinite(minKnn) && minKnn >= 0 && minKnn <= 1;
    const explorationGo = decisionSource !== "drex" && allowExplorationGo && numericSane && !deterministicPass &&
      (input.skipLlm || (byLlm && llmPass === true)) && confidence >= explorationMinConf;
    // PAPER-only (perintah operator 30 Sep 2026): saat flag aktif, keputusan
    // Arka menjadi advisory — gate deterministik (skor/KNN) yang menentukan
    // agar slot 20/20 benar-benar terisi di simulasi. Di LIVE flag tidak
    // berlaku: verdict LLM tetap wajib (fail-closed).
    // Catatan integrasi Drex: paperDeterministic TIDAK dapat melewati NO-GO Drex.
    const paperDeterministic = input.paperDeterministicEntry === true;
    const verdict: "GO" | "NO-GO" = decisionSource === "drex"
      ? (drexRulePass && deterministicPass ? "GO" : "NO-GO")
      : ((deterministicPass && (paperDeterministic || input.skipLlm || (byLlm && llmPass)))
        || explorationGo) ? "GO" : "NO-GO";
    const reason = decisionSource === "drex"
      ? (verdict === "GO"
        ? `DREX_GO: p(entry)=${(entryProbability ?? 0).toFixed(2)} >= ambang ${env.DREX_MIN_ENTRY_PROBABILITY}, arah ${drexDirection?.choice} cocok, makro PASS.`
        : `DREX_NO_GO: ${this.drexRejectReason(input, entryProbability, drexDirection, drexStrength, deterministicPass)}`)
      : deterministicPass || explorationGo ? (explorationGo
        ? `EXPLORATION_GO_L${progLevel ?? "?"}: ${parseJudgeReason(text)}`
        : paperDeterministic && !input.skipLlm
          ? `PAPER_DETERMINISTIC_GO (Arka advisory): ${parseJudgeReason(text)}`
          : parseJudgeReason(text)) : "DETERMINISTIC_GATE_REJECTED: skor/probabilitas di bawah ambang atau data numerik invalid.";

    // Pilihan menu hanya sah bila datang dari jawaban LLM yang valid (byLlm).
    // Deterministik/outage/malformed -> null -> pemanggil memakai plan default.
    // Jalur Drex tidak memilih menu (Drex tak pernah memberi harga/ID varian);
    // default deterministik (SL A / TP A) yang berlaku.
    const slChoice = menu && byLlm && decisionSource !== "drex" ? parseMenuChoice(text, "PILIHAN_SL", slIds) : null;
    const tpChoice = menu && byLlm && decisionSource !== "drex" ? parseMenuChoice(text, "PILIHAN_TP", tpIds) : null;
    const menuFallback = menu !== null && (slChoice === null || tpChoice === null);

    const drexContext = drexData
      ? {
        requestId: drexData.requestId,
        evaluationTimeMs: drexData.evaluationTimeMs,
        latency: drexData.latency,
        entryProbability,
        direction: drexDirection ? { choice: drexDirection.choice, confidence: drexDirection.confidence, probabilities: drexDirection.probabilities } : null,
        setupStrength: drexStrength ? { score: drexStrength.score, confidence: drexStrength.confidence, legend: drexStrength.legend, probabilities: drexStrength.probabilities } : null,
        rulePass: drexRulePass,
      }
      : null;
    const drexDirectionOut = drexDirection
      ? { choice: drexDirection.choice, confidence: drexDirection.confidence, probabilities: drexDirection.probabilities }
      : null;
    const drexStrengthOut = drexStrength
      ? { score: drexStrength.score, confidence: drexStrength.confidence, legend: drexStrength.legend, probabilities: drexStrength.probabilities }
      : null;

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { verdict, confidence, confidenceKind: "SUBJECTIVE_NOT_CALIBRATED", winProbability: null, reason, byLlm, decisionSource, compositeScore: input.compositeScore, minScore, minKnn, emptySlots, progressiveLevel: progLevel, allowExplorationGo, explorationGo, outageFallback: Boolean(input.skipLlm && input.outageFallback), slChoice, tpChoice, menuFallback, drex: drexContext, drexNote },
    };

    await this.logDialog(dialog);
    // Big Brain Tahap B1 (14 Okt 2026): memori keputusan — GO dan NO-GO
    // sama-sama di-log (NO-GO = data negatif untuk kalibrasi). Fail-open:
    // kegagalan tulis TIDAK mengubah verdict. ID kembalian dilempar ke pemanggil
    // (bot) via decisionLogId agar bisa di-link ke Position saat entry nyata.
    const decisionLogId = await logDecision({
      symbol: input.symbol,
      side: input.side,
      mode: input.mode,
      strategyId: input.strategyId ?? null,
      decision: verdict === "GO" ? "GO" : "NO_GO",
      rejectReason: verdict === "GO" ? null : reason,
      knnProb: input.knnProb ?? null,
      knnN: null,
      drexProb: entryProbability,
      drexStrength: drexStrengthOut?.score ?? null,
      compositeScore: input.compositeScore,
      // Big Brain B2/B3/B4 (14 Okt 2026): fitur persepsi sekarang ada di
      // SetupJudgeInput dan mengalir dari jalur scan — null tetap berarti
      // tak terdata (tanpa fabrikasi).
      trendScore: input.trendScore ?? null,
      regime: input.regime,
      er: input.er ?? null,
      pocDistanceBins: input.pocDistanceBins ?? null,
      oiChangePct: input.oiChangePct ?? null,
      betaBtc: input.betaBtc ?? null,
      choppiness: input.structureChop ?? null,
      adx: input.structureAdx ?? null,
      atrPct: input.structureAtrPct ?? null,
      macroAllowed: input.macroAllowed ?? null,
    });
    return {
      verdict, confidence, confidenceKind: "SUBJECTIVE_NOT_CALIBRATED", winProbability: null,
      reason, byLlm, slChoice, tpChoice, menuFallback,
      decisionSource, entryProbability, direction: drexDirectionOut, setupStrength: drexStrengthOut,
      decisionLogId,
      drexRequestId: drexData?.requestId ?? null, drexLatency: drexData?.latency ?? null,
      drexRaw: drexData?.raw, drexNote, dialog,
    };
  }
  async runRiskOfficer(input: RiskOfficerInput): Promise<{
    approved: boolean;
    reason: string;
    byLlm: boolean;
    sizing: { notionalUsd: number; marginUsd: number; effectiveRiskUsd: number; leverage: number };
    dialog: AgentDialog;
  }> {
    const profile = DECISION_AGENTS["risk-officer"];
    const slDist = Math.abs(input.entryPrice - input.slPrice);
    const slPct = slDist / input.entryPrice;
    const baseRiskUsd = input.targetRiskUsd ?? 1;
    const leverage = Math.min(25, input.leverageTarget ?? 25, input.maxLeverageSnapshot ?? NaN);
    const plan = input.finalPlan;
    const notional = plan?.notionalUsd ?? baseRiskUsd / slPct;
    const margin = plan?.marginUsd ?? notional / leverage;
    const effectiveRiskUsd = plan?.effectiveRiskUsd ?? notional * slPct;
    const netRiskUsd = plan?.estimatedNetRiskUsd ?? effectiveRiskUsd;
    const marginCap = 0.4 * input.equityUsd;
    const positive = (v: number) => Number.isFinite(v) && v > 0;
    const closeEnough = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-4);
    const errors: string[] = [];
    if (![input.entryPrice, input.slPrice, input.equityUsd, baseRiskUsd, leverage, notional, margin, effectiveRiskUsd, netRiskUsd].every(positive)) errors.push("INVALID_NUMERIC_INPUT_OR_LEVERAGE_SNAPSHOT");
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 25) errors.push("INVALID_LEVERAGE");
    if (!(input.side === "LONG" ? input.slPrice < input.entryPrice : input.slPrice > input.entryPrice)) errors.push("SL_WRONG_SIDE");
    if (!(slPct > 0 && slPct <= 0.025 + 1e-12)) errors.push("SL_DISTANCE_LIMIT");
    if (margin > marginCap + 1e-8) errors.push("MARGIN_CAP");
    const allowedOverhang = (plan && plan.effectiveRiskUsd > baseRiskUsd && plan.effectiveRiskUsd <= baseRiskUsd * 1.25)
      ? (plan.estimatedNetRiskUsd ?? plan.effectiveRiskUsd) + 1e-8
      : Math.min(1, baseRiskUsd) + 1e-8;
    if (baseRiskUsd > 1 || netRiskUsd > allowedOverhang) errors.push("RISK_BUDGET");
    if (plan) {
      if (!plan.allowed) errors.push(plan.rejectReason ?? "FINAL_PLAN_REJECTED");
      if (!positive(plan.qty) || plan.leverage !== leverage || !closeEnough(notional, plan.qty * input.entryPrice) || !closeEnough(margin, notional / leverage) || !closeEnough(effectiveRiskUsd, plan.qty * slDist) || netRiskUsd < effectiveRiskUsd) errors.push("FINAL_PLAN_INCONSISTENT");
    }
    const deterministicApproved = errors.length === 0;
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), perwira risiko di Private Trade AI.
${TRADING_EVIDENCE_POLICY}
Tinjau angka calculator yang diberikan; tidak membuat sizing alternatif. Sizing menggunakan model klasik RR ($1.00 base risk) dengan batas toleransi overhang kuantisasi stepSize s/d $1.25. Jika kalkulator menghasilkan risiko nominal $1.00 - $1.25 dan Hard gate PASS, putusan Anda WAJIB APPROVED.
Jawab tepat dua baris:\nPUTUSAN: APPROVED atau REJECTED\nALASAN: alasan berbasis bukti.`;
// BAGIAN 3 (24 Okt 2026): Wardha memeriksa SL di belakang POC / bid wall.
    const micro = input.microstructure;
    const wardhaMicroLine = micro && micro.status !== "UNAVAILABLE"
      ? `\nKONTEKS MIKROSTRUKTUR:\n`
        + `- POC Volume Profile: $${micro.volumeProfile?.pocPrice?.toFixed(2) ?? "n/a"} (harga saat ini ${micro.volumeProfile?.priceVsValueArea ?? "?"}).\n`
        + `- Wall BID aktif terbesar: $${((micro.wallLifelines?.largestActiveUsd ?? 0) / 1e3).toFixed(0)}K di $${micro.wallLifelines?.largestActivePrice?.toFixed(2) ?? "n/a"} (side=${micro.wallLifelines?.largestActiveSide ?? "n/a"}).\n`
        + `- Magnet likuidasi: ${micro.liquidationMap?.magnetDirection ?? "NONE"}.\n`
        + `Periksa: apakah SL terlindungi oleh POC atau wall BID? Jika SL berada di zona tanpa likuiditas pendukung, risiko lebih tinggi.\n`
      : "";
    const userPrompt = `Verifikasi risiko ${input.symbol} (${input.side}):
Entry ${input.entryPrice}, SL ${input.slPrice}, jarak ${(slPct * 100).toFixed(4)}%.
Notional ${notional}, leverage ${leverage}, margin ${margin}, cap ${marginCap}.
Risiko gross ${effectiveRiskUsd}, estimasi net ${netRiskUsd}; budget ${Math.min(1, baseRiskUsd)} (toleransi kuantisasi lot overhang s/d ${allowedOverhang.toFixed(2)}: sah dan lolos jika gross/net <= ${allowedOverhang.toFixed(2)}).
Hard gate: ${deterministicApproved ? "PASS" : errors.join(", ")}. Persetujuan tidak dapat mengalahkan hard gate.${wardhaMicroLine}`;
    let text = "";
    let byLlm = false;
    if (deterministicApproved && !input.skipLlm) {
      try {
        // Perintah Operator 2 Okt 2026: Naikkan timeout ke 20s untuk mengurangi false-reject akibat latensi API.
        // Scalping butuh kecepatan, tapi 12s terlalu ketat untuk beberapa provider LLM saat peak hours.
        const res = await this.adapter.callReason(userPrompt, sysPrompt, { maxTokens: 2048, timeoutMs: 20_000 });
        text = res.content.trim();
        byLlm = parseRiskOfficerLlmApproval(text) !== null;
      } catch { /* Fail closed when the risk reviewer is unavailable. */ }
    }
    const approved = deterministicApproved && (input.skipLlm || (byLlm && parseRiskOfficerLlmApproval(text) === true));
    const reason = !deterministicApproved ? errors.join(", ") : !byLlm && !input.skipLlm ? "RISK_REVIEW_UNAVAILABLE_OR_MALFORMED" : parseJudgeReason(text);
    if (!byLlm) text = `PUTUSAN: ${approved ? "APPROVED" : "REJECTED"}\nALASAN: ${reason}`;
    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { approved, reason, byLlm, notional, margin, effectiveRiskUsd },
    };

    await this.logDialog(dialog);

    return {
      approved,
      reason,
      byLlm,
      sizing: { notionalUsd: notional, marginUsd: margin, effectiveRiskUsd, leverage },
      dialog,
    };
  }

  private async logDialog(dialog: AgentDialog) {
    try {
      await db.eventLog.create({
        data: {
          type: "AGENT_DIALOG",
          severity: "info",
          payload: JSON.stringify(dialog),
        },
      });
    } catch {
      // toleransi mock
    }
  }

  /**
   * 23 Okt 2026 (perintah operator): Drex Max menilai kandidat SWING.
   * Semantik deliberately BEDA dari SCALP:
   *  - Drex TERSEDIA: putusannya mengikat (reject = entry dibatalkan).
   *  - Drex TIDAK tersedia (disabled/no-key/error/malformed): fail-open —
   *    entry lanjut lewat gate deterministik yang sudah ada, dengan log jujur.
   *    Lane SWING tidak punya judge LLM fallback, jadi outage Drex tidak boleh
   *    membekukan riset forward PAPER.
   * Tidak ada macro gate: lane SWING tidak menghitung macroAllowed (jujur,
   * tanpa fabrikasi). Ambang memakai env DREX yang sama dengan SCALP.
   */
  async runSwingDrexJudge(input: SwingDrexJudgeInput): Promise<SwingDrexVerdict> {
    if (!env.DREX_SWING_ENABLED) return { kind: "skip", reason: "DREX_SWING_DISABLED" };
    if (!this.drex.enabled) {
      return { kind: "skip", reason: env.DREX_ENABLED ? "DREX_NO_API_KEY" : "DREX_DISABLED" };
    }
    const built = buildDrexSwingState(input);
    if (!built.ok) return { kind: "skip", reason: built.reason };
    // Drex vision (24 Okt 2026): kalau flag menyala dan bar tersedia, render
    // chart PNG (dengan cache) lalu kirim lewat field `images`. Kegagalan
    // render/gambar TIDAK memblokir penilaian (fail-open ke mode JSON).
    const vision = prepareDrexVisionImage({
      symbol: input.symbol,
      timeframe: env.DREX_VISION_TIMEFRAME,
      bars: input.chartBars ?? [],
      levels: {
        entry: input.entryPrice ?? null,
        sl: input.slPrice ?? null,
        tp: input.tp1Price ?? null,
      },
    });
    const images = vision.image ? [vision.image] : null;
    const res = await this.drex.evaluate(built.state, DREX_QUESTIONS, images ? { images } : undefined);
    if (!res.ok) {
      logger.warn({ code: res.code, symbol: input.symbol, strategyId: input.strategyId },
        "DREX_SWING_UNAVAILABLE: entry lanjut tanpa lapisan Drex (fail-open)");
      return { kind: "skip", reason: res.code };
    }
    const data = res.data;
    const noul = data.answers.entry_go as DrexNoulAnswer | undefined;
    const direction = (data.answers.direction as DrexChoiceAnswer | undefined) ?? null;
    const strength = (data.answers.setup_strength as DrexScoreAnswer | undefined) ?? null;
    const p = noul && Number.isFinite(noul.probability) ? noul.probability : null;
    const dirOk = !!direction && direction.choice === input.side;
    const strengthOk = !!strength && Number.isFinite(strength.score) && strength.score >= env.DREX_MIN_SETUP_STRENGTH;
    const probOk = p !== null && p >= env.DREX_MIN_ENTRY_PROBABILITY;
    let verdict: SwingDrexVerdict;
    if (probOk && dirOk && strengthOk) {
      verdict = { kind: "go", data, p, direction: direction!.choice, strength: strength!.score };
    } else {
      const why: string[] = [];
      if (!probOk) why.push(`ENTRY_PROB ${(p ?? 0).toFixed(2)}<${env.DREX_MIN_ENTRY_PROBABILITY}`);
      if (!dirOk) why.push(`DIRECTION_${direction?.choice ?? "UNKNOWN"}!=${input.side}`);
      if (!strengthOk) {
        const got = strength && Number.isFinite(strength.score)
          ? (drexStrengthLabel(strength.score) ?? String(strength.score))
          : "UNKNOWN";
        const need = drexStrengthLabel(env.DREX_MIN_SETUP_STRENGTH) ?? String(env.DREX_MIN_SETUP_STRENGTH);
        why.push(`SETUP_STRENGTH ${got}<${need}`);
      }
      verdict = {
        kind: "reject", reason: why.join("; ") || "DREX_RULE_REJECTED", data,
        p, direction: direction?.choice ?? null, strength: strength && Number.isFinite(strength.score) ? strength.score : null,
      };
    }
    // TAHAP 5 (26 Okt 2026): SHADOW v2 — fire-and-forget, TIDAK mengikat,
    // tidak pernah mengubah verdict produksi di atas (go/reject/skip tetap v1).
    void this.runSwingDrexShadow(input, verdict).catch((err) =>
      logger.warn({ err: (err as Error)?.message }, "DREX_SWING_SHADOW_FAILED"));
    return verdict;
  }

  /** TAHAP 5 SHADOW: jalankan Drex SWING v2 (state v2 + pertanyaan horizon SWING
   *  + evidence mikrostruktur kandidat & BTC macro terpisah) pada kandidat yang
   *  SAMA dengan verdict v1 (termasuk yang ditolak), lalu catat perbandingan.
   *  Tidak menambah veto produksi, tidak menyentuh entry/sizing/SL/TP/posisi.
   *
   *  TAHAP 6B + DREX v2 (26 Okt 2026): input v2 sekarang memakai SNAPSHOT
   *  evidence lima panel yang diambil SEBELUM verdict v1 (pra-keputusan).
   *  - Snapshot tidak pernah diperbarui oleh data yang datang belakangan.
   *  - Freshness dicek ULANG sebelum request dikirim (evidence bisa basi
   *    selama antre) -> kalau basi, shadow dicatat SKIPPED_DATA_QUALITY.
   *  - Dedup per kandidat/plan: satu kandidat = satu invocation shadow.
   *  - Produksi TIDAK menunggu shadow: v2 boleh selesai setelah v1. */
  private async runSwingDrexShadow(input: SwingDrexJudgeInput, v1: SwingDrexVerdict): Promise<void> {
    if (!env.DREX_SWING_SHADOW) return;
    const base = {
      symbol: input.symbol, side: input.side, strategyId: input.strategyId, v1Kind: v1.kind,
      correlationId: input.panelSnapshot?.correlationId ?? `${input.symbol}:${input.side}:${input.strategyId}`,
    };
    if (!this.drex.enabled) {
      await this.logSwingShadow(base, v1, { skipped: "DREX_UNAVAILABLE", outcome: "SKIPPED_DATA_QUALITY" });
      return;
    }
    // Dedup per kandidat/plan — hook baru tidak boleh menggandakan invocation.
    const dedupKey = input.panelSnapshot?.candidateId
      ?? `${input.symbol}:${input.side}:${input.strategyId}:${input.entryPrice}`;
    if (this.shadowSeen.has(dedupKey)) {
      await this.logSwingShadow(base, v1, { skipped: "DUPLICATE_INVOCATION", outcome: "SKIPPED_DATA_QUALITY" });
      return;
    }
    this.shadowSeen.set(dedupKey, Date.now());
    // Jaga map tetap kecil (batas 200 kandidat terakhir).
    if (this.shadowSeen.size > 200) {
      const oldest = [...this.shadowSeen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.shadowSeen.delete(oldest[0]);
    }

    const started = Date.now();
    // Evidence kandidat & BTC macro — blok terpisah, fail-open per blok.
    let candidateMicro: MicrostructureFlowBlock | null = null;
    let btcMicro: MicrostructureFlowBlock | null = null;
    let btcChg24: number | null = null;
    try { candidateMicro = await buildMicrostructureBlock(input.symbol.replace(/USDT$/i, "")); } catch { /* missing */ }
    try { btcMicro = await buildMicrostructureBlock("BTC"); } catch { /* missing */ }
    try { btcChg24 = binanceFuturesClient.getHubChg24(["BTCUSDT"])["BTCUSDT"] ?? null; } catch { /* missing */ }

    // TAHAP 6B: brief panel dari snapshot pra-keputusan + pemeriksaan freshness
    // ULANG (evidence bisa basi selama snapshot->dispatch).
    let panelEvidence: {
      brief: string; capturedAtMs: number; inputHash: string;
      coverage: Record<string, number>; stalePanels: string[]; unavailablePanels: string[];
      evidenceSymbol: string;
    } | null = null;
    let panelFreshness = "unknown";
    if (input.panelSnapshot) {
      const rendered = renderDrexPanelBrief(input.panelSnapshot, Date.now());
      panelFreshness = rendered.freshness.status;
      if (!rendered.freshness.usable) {
        await this.logSwingShadow(base, v1, {
          skipped: "SKIPPED_DATA_QUALITY",
          outcome: "SKIPPED_DATA_QUALITY",
          panelFreshness,
          stalePanels: rendered.freshness.stalePanels,
          capturedAtMs: input.panelSnapshot.capturedAtMs,
          panelInputHash: input.panelSnapshot.inputHash,
          coverage: input.panelSnapshot.coverage,
        });
        return;
      }
      panelEvidence = {
        brief: rendered.brief,
        capturedAtMs: input.panelSnapshot.capturedAtMs,
        inputHash: input.panelSnapshot.inputHash,
        coverage: input.panelSnapshot.coverage as unknown as Record<string, number>,
        stalePanels: input.panelSnapshot.stalePanels.map(String),
        unavailablePanels: input.panelSnapshot.unavailablePanels.map(String),
        evidenceSymbol: input.panelSnapshot.evidenceSymbol,
      };
    } else {
      await this.logSwingShadow(base, v1, {
        skipped: "SKIPPED_DATA_QUALITY", outcome: "SKIPPED_DATA_QUALITY",
        note: "snapshot evidence pra-keputusan tidak tersedia",
      });
      return;
    }

    const builtV2 = buildDrexSwingStateV2({
      ...input, microstructure: candidateMicro,
      btcMacro: { chg24hPct: btcChg24, microstructure: btcMicro },
      tp2Price: input.tp2Price ?? null,
      panelEvidence,
    });
    if (!builtV2.ok) { await this.logSwingShadow(base, v1, { skipped: builtV2.reason, outcome: "SHADOW_ERROR" }); return; }
    const inputHash = createHash("sha256").update(JSON.stringify(builtV2.state)).digest("hex").slice(0, 16);
    const dispatchedAt = Date.now();
    try {
      const res = await this.drex.evaluate(builtV2.state, DREX_SWING_QUESTIONS);
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        await this.logSwingShadow(base, v1, {
          skipped: res.code, outcome: "SHADOW_ERROR",
          inputHash, latencyMs, timeoutMs: env.DREX_TIMEOUT_MS,
          capturedAtMs: panelEvidence.capturedAtMs, dispatchedAt,
          panelInputHash: panelEvidence.inputHash, panelFreshness,
          coverage: panelEvidence.coverage,
        });
        return;
      }
      const data = res.data;
      const noul = data.answers.entry_go as DrexNoulAnswer | undefined;
      const direction = data.answers.direction as DrexChoiceAnswer | undefined;
      const strength = data.answers.setup_strength as DrexScoreAnswer | undefined;
      const p = noul && Number.isFinite(noul.probability) ? noul.probability : null;
      const dirOk = !!direction && direction.choice === input.side;
      const strengthOk = !!strength && Number.isFinite(strength.score) && strength.score >= env.DREX_MIN_SETUP_STRENGTH;
      const probOk = p !== null && p >= env.DREX_MIN_ENTRY_PROBABILITY;
      const v2Kind = probOk && dirOk && strengthOk ? "go" : "reject";
      const v2Why: string[] = [];
      if (!probOk) v2Why.push(`ENTRY_PROB ${(p ?? 0).toFixed(2)}<${env.DREX_MIN_ENTRY_PROBABILITY}`);
      if (!dirOk) v2Why.push(`DIRECTION_${direction?.choice ?? "UNKNOWN"}!=${input.side}`);
      if (!strengthOk) v2Why.push(`SETUP_STRENGTH ${strength && Number.isFinite(strength.score) ? strength.score : "UNKNOWN"}<${env.DREX_MIN_SETUP_STRENGTH}`);
      // Status perbandingan: v1 vs v2 (AGREE / DISAGREE).
      const v1Kind = v1.kind === "skip" ? "skip" : v1.kind;
      const outcome = v1Kind === "skip" ? "NOT_OBSERVED"
        : v1Kind === v2Kind ? "AGREE" : "DISAGREE";
      await this.logSwingShadow(base, v1, {
        inputHash, latencyMs, timeoutMs: env.DREX_TIMEOUT_MS,
        model: data.model, requestId: data.requestId,
        schemaVersion: "artatrade-swing-state-v2",
        outcome,
        capturedAtMs: panelEvidence.capturedAtMs,
        dispatchedAt,
        panelInputHash: panelEvidence.inputHash,
        panelFreshness,
        coverage: panelEvidence.coverage,
        evidenceSymbol: panelEvidence.evidenceSymbol,
        v2: { kind: v2Kind, reason: v2Why.join("; ") || null, p, direction: direction?.choice ?? null,
          strength: strength && Number.isFinite(strength.score) ? strength.score : null },
      });
    } catch (err) {
      await this.logSwingShadow(base, v1, {
        skipped: `ERROR_${(err as Error).message}`.slice(0, 100), outcome: "SHADOW_ERROR",
        latencyMs: Date.now() - started, capturedAtMs: panelEvidence.capturedAtMs, dispatchedAt,
        panelInputHash: panelEvidence.inputHash, panelFreshness,
      });
    }
  }

  private async logSwingShadow(
    base: { symbol: string; side: string; strategyId: string; v1Kind: string },
    v1: SwingDrexVerdict,
    shadow: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.eventLog.create({
        data: {
          type: "DREX_SWING_SHADOW_COMPARE", severity: "info",
          payload: JSON.stringify({
            ...base, generatedAt: new Date().toISOString(),
            v1: { kind: v1.kind, reason: v1.kind === "reject" ? v1.reason : v1.kind === "skip" ? v1.reason : null,
              p: v1.kind !== "skip" ? v1.p : null, direction: v1.kind !== "skip" ? v1.direction : null,
              strength: v1.kind !== "skip" ? v1.strength : null },
            shadow,
          }),
        },
      });
    } catch { /* observasi tidak boleh gagal-gating */ }
  }
}

export const defaultDecisionRiskLayer = new DecisionRiskLayer();

