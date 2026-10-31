// apps/server/src/agents/drexState.ts
// Pembangun state Drex (kontrak artatrade-scalp-state-v1, audit 3 Okt 2026 §12).
// Prinsip: HANYA nilai yang benar-benar ada di SetupJudgeInput/konfigurasi kode.
// Nilai kosong DILEWATI (key tidak ditulis) — tanpa placeholder 0, tanpa fabrikasi.
// Data order-book TIDAK disertakan (audit M1: merge @depth5 belum reliable).
import type { SetupJudgeInput } from "./decisionRiskLayer.js";
import type { MicrostructureFlowBlock } from "./marketIntel.js";
import { getTimeframePlan } from "../config/timeframes.js";
import { rrPolicyForMode } from "../config/setupEngine.js";
import { env } from "../core/env.js";
import type { DrexQuestions } from "./drexAdapter.js";

export const DREX_STATE_SCHEMA_VERSION = "artatrade-scalp-state-v1";

/**
 * Tiga keputusan Drex (kontrak pertanyaan docs.drex.nace.ai):
 * - noul  : instructions + criteria {true,false}
 * - choice: criteria = map label -> kriteria (bukan "options")
 * - score : criteria = array label terurut rendah -> tinggi (bukan "levels")
 */
/**
 * Label conviction Drex terurut rendah -> tinggi. INDEX ARRAY = SKOR.
 * Dipakai bersama oleh DREX_QUESTIONS (di bawah) dan gate conviction di
 * decisionRiskLayer — satu sumber kebenaran, jangan duplikat literal.
 */
export const DREX_STRENGTH_LABELS = [
  "very_weak",
  "weak",
  "moderate",
  "strong",
  "very_strong",
] as const;
export type DrexStrengthLabel = (typeof DREX_STRENGTH_LABELS)[number];

/** Label conviction -> index skor (-1 bila label tak dikenal). */
export function drexStrengthIndex(label: string): number {
  return (DREX_STRENGTH_LABELS as readonly string[]).indexOf(label);
}

/** Skor index -> label conviction. Skor pecahan dibulatkan ke bawah
 *  (Drex bisa mengirim 3.2 = "strong"); null bila di luar rentang. */
export function drexStrengthLabel(score: number): string | null {
  if (!Number.isFinite(score)) return null;
  const idx = Math.floor(score);
  return idx >= 0 && idx < DREX_STRENGTH_LABELS.length
    ? DREX_STRENGTH_LABELS[idx]
    : null;
}

export const DREX_QUESTIONS: DrexQuestions = {
  entry_go: {
    type: "noul",
    instructions: "Based on the provided market state, should this setup be executed?",
    criteria: {
      true: "The setup has a positive expected edge right now given scores, regime, structure, macro and session context.",
      false: "The setup is late, crowded, contradicted by macro/structure, or low quality.",
    },
  },
  direction: {
    type: "choice",
    instructions: "Which position direction is better supported by the current market state?",
    criteria: {
      LONG: "Structure and liquidity favor upside over the next few minutes.",
      SHORT: "Structure and liquidity favor downside over the next few minutes.",
    },
  },
  setup_strength: {
    type: "score",
    instructions: "How strong is the current trading setup?",
    criteria: [...DREX_STRENGTH_LABELS],
  },
};

export type DrexStateBuild =
  | { ok: true; state: Record<string, unknown> }
  | { ok: false; reason: string };

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const pct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

function timeframeBlock(mode: "SCALP" | "SWING"): Record<string, unknown> {
  const plan = getTimeframePlan(mode);
  const block: Record<string, unknown> = {};
  for (const spec of plan.specs) block[spec.role.toLowerCase()] = spec.interval;
  block.macro = plan.macroIntervals.join(",");
  return block;
}

function putIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

/**
 * Rakit state Drex dari nilai nyata di call site runSetupJudge.
 * Gagal (fail-closed, tanpa fabrikasi) bila field inti hilang/invalid:
 * symbol, side, mode, skor 0..100, atau harga entry/SL/TP code-owned.
 */
export function buildDrexState(input: SetupJudgeInput): DrexStateBuild {
  const missing: string[] = [];
  if (!input.symbol?.trim()) missing.push("symbol");
  if (input.side !== "LONG" && input.side !== "SHORT") missing.push("side");
  if (input.mode !== "SCALP") missing.push("mode");
  if (!pct(input.zoneScore)) missing.push("zoneScore");
  if (!pct(input.triggerScore)) missing.push("triggerScore");
  if (!pct(input.compositeScore)) missing.push("compositeScore");
  // Harga entry/SL/TP TIDAK wajib: di FASE B banyak kandidat belum punya plan
  // (harga dihitung ulang di FASE C saat live). Tidak ada = key dilewatkan,
  // TANPA fabrikasi/placeholder — Drex tetap menilai (dia primer, bukan Xkiro).
  if (missing.length > 0) {
    return { ok: false, reason: `DREX_STATE_INCOMPLETE: ${missing.join(",")}` };
  }

  const scores: Record<string, unknown> = {
    zoneScore: input.zoneScore,
    triggerScore: input.triggerScore,
    compositeScore: input.compositeScore,
    // Label jujur: KNN = similaritas analog heuristik, BUKAN probabilitas menang terkalibrasi.
    knnProbCalibrated: false,
  };
  putIfDefined(scores, "knnProb", typeof input.knnProb === "number" && Number.isFinite(input.knnProb) && input.knnProb >= 0 && input.knnProb <= 1 ? input.knnProb : undefined);

  const strategy: Record<string, unknown> = { rr: rrPolicyForMode("SCALP", input.strategyId ?? undefined).tp1R };
  putIfDefined(strategy, "id", input.strategyId ?? undefined);
  putIfDefined(strategy, "name", input.strategyName ?? undefined);
  if (input.strategyEvidence?.length) strategy.evidence = input.strategyEvidence.slice(0, 6);

  const levels: Record<string, unknown> = {};
  putIfDefined(levels, "entryPrice", pos(input.entryPrice) ? input.entryPrice : undefined);
  putIfDefined(levels, "slPrice", pos(input.slPrice) ? input.slPrice : undefined);
  putIfDefined(levels, "tp1Price", pos(input.tp1Price) ? input.tp1Price : undefined);
  putIfDefined(levels, "slPct", typeof input.slPct === "number" && Number.isFinite(input.slPct) && input.slPct > 0 ? input.slPct : undefined);

  const marketContext: Record<string, unknown> = {};
  putIfDefined(marketContext, "volumeUsd", input.volumeUsd ?? undefined);
  putIfDefined(marketContext, "fundingRate", input.fundingRate ?? undefined);
  putIfDefined(marketContext, "structureAdx", input.structureAdx ?? undefined);
  putIfDefined(marketContext, "structureChop", input.structureChop ?? undefined);
  putIfDefined(marketContext, "biasAdx", input.biasAdx ?? undefined);
  putIfDefined(marketContext, "biasChop", input.biasChop ?? undefined);
  putIfDefined(marketContext, "structureAtrPct", input.structureAtrPct ?? undefined);

  // BAGIAN 3 (24 Okt 2026): mikrostruktur & order flow untuk Drex.
  if (input.microstructure && input.microstructure.status !== "UNAVAILABLE") {
    const m = input.microstructure;
    const microBlock: Record<string, unknown> = { status: m.status };
    if (m.orderFlowCvd) microBlock.cvd = { allVenues: m.orderFlowCvd.allVenues, venuesTrading: m.orderFlowCvd.venuesTrading };
    if (m.wallLifelines) microBlock.walls = { active: m.wallLifelines.active, pulled: m.wallLifelines.pulled, eaten: m.wallLifelines.eaten, pullEatRatio: m.wallLifelines.pullEatRatio };
    if (m.liquidationMap) microBlock.liquidation = { magnet: m.liquidationMap.magnetDirection, nearLongUsd: m.liquidationMap.nearLongUsd, nearShortUsd: m.liquidationMap.nearShortUsd };
    if (m.volumeProfile) microBlock.volumeProfile = { pocPrice: m.volumeProfile.pocPrice, priceVsVa: m.volumeProfile.priceVsValueArea };
    if (m.tierAndExchangeFlow) microBlock.tierFlow = { whaleBias: m.tierAndExchangeFlow.whaleBias, whaleDelta: m.tierAndExchangeFlow.whaleDeltaUsd };
    marketContext.microstructure = microBlock;
  }

  const macro: Record<string, unknown> = {};
  putIfDefined(macro, "allowed", input.macroAllowed);
  putIfDefined(macro, "detail", input.macroDetail ?? undefined);
  putIfDefined(macro, "observerText", (input.macroObserverText ?? undefined) ? String(input.macroObserverText).slice(0, 400) : undefined);

  const session: Record<string, unknown> = {
    paperMode: env.BINANCE_EXECUTION_MODE === "PAPER",
    paperDeterministicEntry: input.paperDeterministicEntry === true,
  };
  putIfDefined(session, "minScore", input.minScore);
  putIfDefined(session, "minKnn", input.minKnn);
  putIfDefined(session, "emptySlots", input.emptySlots);
  putIfDefined(session, "maxPositions", input.maxPositions);
  putIfDefined(session, "progressiveLevel", input.progressiveLevel);
  putIfDefined(session, "marketFilterStatus", input.marketFilterStatus ?? undefined);

  const state: Record<string, unknown> = {
    schemaVersion: DREX_STATE_SCHEMA_VERSION,
    symbol: input.symbol,
    side: input.side,
    mode: input.mode,
    timeframes: timeframeBlock("SCALP"),
    scores,
    strategy,
    levels,
    marketContext,
    macro,
    session,
  };
  const lessons = (input.lessons ?? []).filter((l): l is string => Boolean(l)).slice(0, 5);
  if (lessons.length > 0) state.lessons = lessons;
  return { ok: true, state };
}

// ── SWING state (23 Okt 2026, perintah operator: Drex Max menilai lane SWING) ──
// Prinsip sama dengan SCALP: HANYA nilai yang benar-benar ada di titik
// keputusan; field kosong DILEWATI (tanpa placeholder, tanpa fabrikasi).
// knnProb TIDAK ada di lane SWING — sengaja tidak ditulis.

export const DREX_SWING_STATE_SCHEMA_VERSION = "artatrade-swing-state-v1";

export interface SwingDrexStateInput {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyId: string;
  strategyName?: string | null;
  compositeScore: number;
  zoneScore?: number | null;
  triggerScore?: number | null;
  trendScore?: number | null;
  regime?: string | null;
  entryPrice?: number | null;
  slPrice?: number | null;
  tp1Price?: number | null;
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
}

export function buildDrexSwingState(input: SwingDrexStateInput): DrexStateBuild {
  const missing: string[] = [];
  if (!input.symbol?.trim()) missing.push("symbol");
  if (input.side !== "LONG" && input.side !== "SHORT") missing.push("side");
  if (!input.strategyId?.trim()) missing.push("strategyId");
  if (!pct(input.compositeScore)) missing.push("compositeScore");
  if (missing.length > 0) {
    return { ok: false, reason: `DREX_SWING_STATE_INCOMPLETE: ${missing.join(",")}` };
  }

  const scores: Record<string, unknown> = { compositeScore: input.compositeScore };
  if (pct(input.zoneScore)) scores.zoneScore = input.zoneScore;
  if (pct(input.triggerScore)) scores.triggerScore = input.triggerScore;
  if (pct(input.trendScore)) scores.trendScore = input.trendScore;

  const strategy: Record<string, unknown> = {
    id: input.strategyId,
    // RR23 dikunci operator untuk SWING; angka milik config, bukan Drex.
    rr: rrPolicyForMode("SWING", input.strategyId).tp1R,
    exitPolicy: "SWING RR23: TP1 50% @2R, BE, TP2/final 50% @3R",
  };
  putIfDefined(strategy, "name", input.strategyName ?? undefined);
  putIfDefined(strategy, "quality", typeof input.planQuality === "number" && Number.isFinite(input.planQuality) ? input.planQuality : undefined);
  putIfDefined(strategy, "entryType", input.entryType ?? undefined);
  putIfDefined(strategy, "zoneType", input.zoneType ?? undefined);

  const levels: Record<string, unknown> = {};
  putIfDefined(levels, "entryPrice", pos(input.entryPrice) ? input.entryPrice : undefined);
  putIfDefined(levels, "slPrice", pos(input.slPrice) ? input.slPrice : undefined);
  putIfDefined(levels, "tp1Price", pos(input.tp1Price) ? input.tp1Price : undefined);
  putIfDefined(levels, "slPct", typeof input.slPct === "number" && Number.isFinite(input.slPct) && input.slPct > 0 ? input.slPct : undefined);

  const structure: Record<string, unknown> = {};
  putIfDefined(structure, "adx", typeof input.structureAdx === "number" && Number.isFinite(input.structureAdx) ? input.structureAdx : undefined);
  putIfDefined(structure, "choppiness", typeof input.structureChop === "number" && Number.isFinite(input.structureChop) ? input.structureChop : undefined);
  putIfDefined(structure, "atrPct", typeof input.structureAtrPct === "number" && Number.isFinite(input.structureAtrPct) ? input.structureAtrPct : undefined);
  putIfDefined(structure, "volumeUsd", pos(input.volumeUsd) ? input.volumeUsd : undefined);

  const session: Record<string, unknown> = {
    lane: "SWING",
    paperMode: env.BINANCE_EXECUTION_MODE === "PAPER",
  };
  putIfDefined(session, "equityUsd", pos(input.equityUsd) ? input.equityUsd : undefined);
  putIfDefined(session, "swingOpen", Number.isFinite(input.swingOpen) ? input.swingOpen : undefined);
  putIfDefined(session, "swingCap", Number.isFinite(input.swingCap) ? input.swingCap : undefined);

  const state: Record<string, unknown> = {
    schemaVersion: DREX_SWING_STATE_SCHEMA_VERSION,
    symbol: input.symbol,
    side: input.side,
    mode: "SWING",
    timeframes: timeframeBlock("SWING"),
    scores,
    strategy,
    levels,
    structure,
    session,
  };
  if (input.regime) state.regime = input.regime;
  if (input.tfSummary) state.tfSummary = input.tfSummary;
  return { ok: true, state };
}

// ── SWING v2 (26 Okt 2026, TAHAP 5): pertanyaan & state versi baru — horizon
// SWING H1/H4 (bukan "beberapa menit"), evidence mikrostruktur simbol kandidat
// dan BTC macro sebagai blok TERPISAH, penanganan missing/stale eksplisit.
// Dijalankan SHADOW dulu (tidak mengikat; log DREX_SWING_SHADOW_COMPARE). ──

export const DREX_SWING_STATE_SCHEMA_VERSION_V2 = "artatrade-swing-state-v2";

/** Pertanyaan Drex khusus lane SWING: horizon jam-harian, bukan menit. */
export const DREX_SWING_QUESTIONS: DrexQuestions = {
  entry_go: {
    type: "noul",
    instructions: "Based on the provided multi-hour/daily market state (H1/H4 swing context), should this swing setup be executed?",
    criteria: {
      true: "The setup has a positive expected edge over the coming hours/days given structure, regime, liquidity and macro context.",
      false: "The setup is late, contradicted by regime/macro, low quality, or its invalidation is too close.",
    },
  },
  direction: {
    type: "choice",
    instructions: "Which direction is better supported over the swing horizon (hours to days, H1/H4)?",
    criteria: {
      LONG: "Structure, liquidity and macro favor upside over the coming hours to days.",
      SHORT: "Structure, liquidity and macro favor downside over the coming hours to days.",
    },
  },
  setup_strength: {
    type: "score",
    instructions: "How strong is this swing setup on the H1/H4 horizon?",
    criteria: [...DREX_STRENGTH_LABELS],
  },
};

export interface SwingDrexStateV2Input extends SwingDrexStateInput {
  /** Mikrostruktur simbol KANDIDAT (blok terpisah; null = tidak tersedia). */
  microstructure?: MicrostructureFlowBlock | null;
  /** Konteks makro BTC (blok terpisah; null = tidak tersedia). */
  btcMacro?: { chg24hPct: number | null; microstructure?: MicrostructureFlowBlock | null } | null;
  /** Level TP2/final dari plan sebenarnya (RR23 3R). */
  tp2Price?: number | null;
  /**
   * TAHAP 6B + DREX v2: snapshot evidence LIMA PANEL (terstruktur, immutable).
   * Berisi brief deterministik + ringkasan coverage/freshness. null = tidak
   * ada -> state v2 menandai blok panel sebagai UNAVAILABLE.
   */
  panelEvidence?: {
    brief: string;
    capturedAtMs: number;
    inputHash: string;
    coverage: Record<string, number>;
    stalePanels: string[];
    unavailablePanels: string[];
    evidenceSymbol: string;
  } | null;
}

export function buildDrexSwingStateV2(input: SwingDrexStateV2Input): DrexStateBuild {
  const base = buildDrexSwingState(input);
  if (!base.ok) return base;
  const state = base.state as Record<string, unknown>;
  state.schemaVersion = DREX_SWING_STATE_SCHEMA_VERSION_V2;

  // Level & exit policy sesuai plan sebenarnya.
  const levels = (state.levels ?? {}) as Record<string, unknown>;
  if (typeof input.tp2Price === "number" && Number.isFinite(input.tp2Price) && input.tp2Price > 0) levels.tp2Price = input.tp2Price;
  state.levels = levels;
  (state.strategy as Record<string, unknown>).horizon = "H1/H4 swing (hours to days)";

  // Blok mikrostruktur kandidat — jujur soal missing/stale per sub-modul.
  const m = input.microstructure;
  if (m && m.status !== "UNAVAILABLE") {
    const microBlock: Record<string, unknown> = { status: m.status };
    if (m.orderFlowCvd) microBlock.cvd = { allVenues: m.orderFlowCvd.allVenues, perpSum: m.orderFlowCvd.perpSum, spotSum: m.orderFlowCvd.spotSum, venuesTrading: m.orderFlowCvd.venuesTrading, venuesExpected: m.orderFlowCvd.venuesExpected };
    if (m.wallLifelines) microBlock.walls = { active: m.wallLifelines.active, pulled: m.wallLifelines.pulled, eaten: m.wallLifelines.eaten, pullEatRatio: m.wallLifelines.pullEatRatio };
    if (m.liquidationMap) microBlock.liquidation = { source: m.liquidationMap.source, magnet: m.liquidationMap.magnetDirection, stale: m.liquidationMap.stale, note: m.liquidationMap.note };
    if (m.volumeProfile) microBlock.volumeProfile = { pocPrice: m.volumeProfile.pocPrice, priceVsVa: m.volumeProfile.priceVsValueArea, partialWindow: m.volumeProfile.partialWindow };
    if (m.tierAndExchangeFlow) microBlock.tierFlow = { whaleBias: m.tierAndExchangeFlow.whaleBias, whaleDelta: m.tierAndExchangeFlow.whaleDeltaUsd, retailDelta: m.tierAndExchangeFlow.retailDeltaUsd };
    state.candidateMicrostructure = microBlock;
  } else {
    state.candidateMicrostructure = { status: "UNAVAILABLE", note: "mikrostruktur kandidat tidak tersedia — jangan dianggap nol atau netral" };
  }

  // Blok evidence LIMA PANEL (TAHAP 6B + DREX v2). Brief deterministik — bukan
  // narasi LLM. Jika snapshot tidak ada, blok ditandai UNAVAILABLE (bukan nol).
  const pe = input.panelEvidence;
  if (pe) {
    state.panelEvidence = {
      capturedAtMs: pe.capturedAtMs,
      inputHash: pe.inputHash,
      evidenceSymbol: pe.evidenceSymbol,
      coverage: pe.coverage,
      stalePanels: pe.stalePanels,
      unavailablePanels: pe.unavailablePanels,
      brief: pe.brief,
    };
  } else {
    state.panelEvidence = {
      status: "UNAVAILABLE",
      note: "snapshot evidence lima panel tidak tersedia (pra-keputusan) — jangan dianggap nol atau netral",
    };
  }

  // Blok BTC macro TERPISAH dari kandidat.
  const b = input.btcMacro;
  if (b) {
    const btcBlock: Record<string, unknown> = {};
    if (Number.isFinite(b.chg24hPct)) btcBlock.chg24hPct = b.chg24hPct;
    if (b.microstructure && b.microstructure.status !== "UNAVAILABLE") {
      btcBlock.microstructure = {
        status: b.microstructure.status,
        cvd: b.microstructure.orderFlowCvd ? { allVenues: b.microstructure.orderFlowCvd.allVenues, perpSum: b.microstructure.orderFlowCvd.perpSum, spotSum: b.microstructure.orderFlowCvd.spotSum } : null,
        liqMagnet: b.microstructure.liquidationMap?.magnetDirection ?? null,
        tierBias: b.microstructure.tierAndExchangeFlow?.whaleBias ?? null,
      };
    }
    state.btcMacro = Object.keys(btcBlock).length > 0 ? btcBlock : { status: "UNAVAILABLE" };
  } else {
    state.btcMacro = { status: "UNAVAILABLE", note: "konteks BTC tidak tersedia" };
  }
  return { ok: true, state };
}
