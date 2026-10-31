// Private Trade AI - TREND-REVERSAL EXIT ENGINE (bagian 1: tipe + gerbang angka).
// LLM hanya membaca arah + confidence. Angka (pnl/fee/R) dihitung TS.
export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type PositionSide = "LONG" | "SHORT";

export interface TrendReadingInput {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  currentPrice: number;
  zlemaDirection: TrendDirection;
  zlemaIsFlip: boolean;
  trendScore: number;
  adx: number;
  chg1hPct: number;
  btcTrend: TrendDirection;
  ethTrend: TrendDirection;
  btcDomChg1hPct: number;
  unrealizedNetUsd: number;
  beMoved: boolean;
  holdMinutes: number;
}

export interface TrendReadingResult {
  newTrend: TrendDirection;
  confidence: number;
  againstPosition: boolean;
  strength: "WEAK" | "MODERATE" | "STRONG";
  reason: string;
  agentId: string;
  agentName: string;
  narrative: string;
  byLlm: boolean;
  shouldExit: boolean;
  exitUrgency: "HOLD" | "WATCH" | "EXIT_NOW";
}

export const STRONG_ADX = 25;
export const MIN_TREND_SCORE_EXIT = 60;
export const MIN_CONFIDENCE_EXIT = 0.65;

/** Avoid closing on a one-read macro wobble; the opposing trend must persist. */
export const TREND_FLIP_CONFIRMATION_MIN_MS = 60_000;
export const TREND_FLIP_CONFIRMATION_MAX_GAP_MS = 10 * 60_000;
const TREND_FLIP_CONFIRMATION_MIN_GAP_MS = 30_000;

export function confirmedMacroFlipDirection(input: {
  side: PositionSide;
  btcTrend: TrendDirection;
  ethTrend: TrendDirection;
  btcAdx: number;
  btcChange1hPct: number;
}): TrendDirection | null {
  const target: TrendDirection = input.side === "LONG" ? "BEARISH" : "BULLISH";
  const momentumConfirms = input.side === "LONG"
    ? input.btcChange1hPct <= -0.2
    : input.btcChange1hPct >= 0.2;
  return input.btcTrend === target && input.ethTrend === target &&
    Number.isFinite(input.btcAdx) && input.btcAdx >= STRONG_ADX &&
    Number.isFinite(input.btcChange1hPct) && momentumConfirms
    ? target
    : null;
}

interface PendingTrendFlip {
  direction: TrendDirection;
  firstAtMs: number;
  lastAtMs: number;
  observations: number;
}

/** Two temporally separated opposing readings are required before an exit. */
export class TrendFlipConfirmationGuard {
  private readonly pending = new Map<string, PendingTrendFlip>();

  private key(symbol: string, side: PositionSide): string {
    return `${String(symbol ?? "").toUpperCase()}|${side}`;
  }

  observe(symbol: string, side: PositionSide, direction: TrendDirection, nowMs = Date.now()): boolean {
    const key = this.key(symbol, side);
    if (!Number.isFinite(nowMs) || !isTrendAgainstPosition(side, direction)) {
      this.pending.delete(key);
      return false;
    }

    const previous = this.pending.get(key);
    if (
      !previous || previous.direction !== direction ||
      nowMs - previous.lastAtMs > TREND_FLIP_CONFIRMATION_MAX_GAP_MS || nowMs < previous.lastAtMs
    ) {
      this.pending.set(key, { direction, firstAtMs: nowMs, lastAtMs: nowMs, observations: 1 });
      return false;
    }
    if (nowMs - previous.lastAtMs < TREND_FLIP_CONFIRMATION_MIN_GAP_MS) return false;

    previous.lastAtMs = nowMs;
    previous.observations += 1;
    if (
      previous.observations >= 2 &&
      nowMs - previous.firstAtMs >= TREND_FLIP_CONFIRMATION_MIN_MS
    ) {
      this.pending.delete(key);
      return true;
    }
    return false;
  }

  clear(symbol: string, side: PositionSide): void {
    this.pending.delete(this.key(symbol, side));
  }

  clearAll(): void {
    this.pending.clear();
  }
}

export function isTrendAgainstPosition(side: PositionSide, trend: TrendDirection): boolean {
  if (trend === "NEUTRAL") return false;
  if (side === "LONG") return trend === "BEARISH";
  return trend === "BULLISH";
}

export function classifyFlipStrength(input: {
  zlemaIsFlip: boolean;
  trendScore: number;
  adx: number;
  confidence: number;
}): "WEAK" | "MODERATE" | "STRONG" {
  let points = 0;
  if (input.zlemaIsFlip) points += 2;
  if (input.trendScore >= 70) points += 2;
  else if (input.trendScore >= MIN_TREND_SCORE_EXIT) points += 1;
  if (input.adx >= STRONG_ADX) points += 2;
  else if (input.adx >= 20) points += 1;
  if (input.confidence >= 0.8) points += 2;
  else if (input.confidence >= MIN_CONFIDENCE_EXIT) points += 1;
  if (points >= 6) return "STRONG";
  if (points >= 3) return "MODERATE";
  return "WEAK";
}

export function decideTrendExit(input: {
  side: PositionSide;
  newTrend: TrendDirection;
  strength: "WEAK" | "MODERATE" | "STRONG";
  beMoved: boolean;
  unrealizedNetUsd: number;
}): { shouldExit: boolean; exitUrgency: "HOLD" | "WATCH" | "EXIT_NOW" } {
  const against = isTrendAgainstPosition(input.side, input.newTrend);
  if (!against) return { shouldExit: false, exitUrgency: "HOLD" };
  if (input.strength === "STRONG") return { shouldExit: true, exitUrgency: "EXIT_NOW" };
  if (input.strength === "MODERATE") {
    if (input.beMoved || input.unrealizedNetUsd <= 0) {
      return { shouldExit: true, exitUrgency: "EXIT_NOW" };
    }
    return { shouldExit: false, exitUrgency: "WATCH" };
  }
  return { shouldExit: false, exitUrgency: "HOLD" };
}


// Bagian 2: prompt agen + parser + orkestrasi baca trend.
export function buildTrendReadingPrompt(input: TrendReadingInput): { system: string; user: string } {
  const against = isTrendAgainstPosition(input.side, input.zlemaDirection);
  const system =
    `Kamu analis trend di tim trading Private Trade AI. ` +
    `Tugasmu HANYA membaca arah trend dari fakta angka berikut. ` +
    `DILARANG menghitung nominal uang. Jawab Bahasa Indonesia, 1-2 kalimat, singkat padat on-point, tanpa emoji. ` +
    `Akhiri dengan format: ARAH=[BULLISH|BEARISH|NEUTRAL] KEYAKINAN=[0-100]`;
  const user =
    `Fakta: ${input.symbol} posisi ${input.side} entry ${input.entryPrice}, harga kini ${input.currentPrice}. ` +
    `ZLEMA=${input.zlemaDirection}${input.zlemaIsFlip ? " (FLIP barusan)" : ""} skor=${input.trendScore} ADX=${input.adx} chg1h=${input.chg1hPct}%. ` +
    `Makro BTC=${input.btcTrend} ETH=${input.ethTrend} BTC.D 1h=${input.btcDomChg1hPct}%. ` +
    `Status posisi: ${input.beMoved ? "TP1 parsial sudah tercatat (legacy runner)" : "belum TP"} hold ${input.holdMinutes} mnt. ` +
    `Pertanyaan: apakah trend kini ${against ? "MELAWAN" : "SEARAH"} posisi?`;
  return { system, user };
}

export function parseTrendAnswer(text: string): { newTrend: TrendDirection; confidence: number } {
  const upper = (text || "").toUpperCase();
  let newTrend: TrendDirection = "NEUTRAL";
  if (upper.includes("BEARISH")) newTrend = "BEARISH";
  else if (upper.includes("BULLISH")) newTrend = "BULLISH";
  const m = upper.match(/KEYAKINAN\s*=\s*\[?\s*(\d{1,3})/) || upper.match(/(\d{1,3})\s*%/);
  let confidence = 0.6;
  if (m) {
    const v = Math.max(0, Math.min(100, Number(m[1])));
    confidence = Number((v / 100).toFixed(2));
  }
  return { newTrend, confidence };
}

export async function readTrendWithAgents(
  input: TrendReadingInput,
  llmCall: (system: string, user: string) => Promise<string>,
  agentId = "regime-analyst",
  agentName = "Rhea"
): Promise<TrendReadingResult> {
  const { system, user } = buildTrendReadingPrompt(input);
  let narrative = "";
  let byLlm = false;
  let parsed: { newTrend: TrendDirection; confidence: number };
  try {
    narrative = (await llmCall(system, user)).trim();
    byLlm = narrative.length > 0;
    if (!byLlm) throw new Error("EMPTY_LLM_RESPONSE");
    parsed = parseTrendAnswer(narrative);
  } catch {
    narrative = `ZLEMA ${input.zlemaDirection}${input.zlemaIsFlip ? " flip" : ""} skor ${input.trendScore} ADX ${input.adx}; baca deterministik tanpa LLM.`;
    parsed = {
      newTrend: input.zlemaIsFlip && input.trendScore >= MIN_TREND_SCORE_EXIT ? input.zlemaDirection : "NEUTRAL",
      confidence: input.zlemaIsFlip ? 0.7 : 0.5,
    };
  }
  let newTrend = parsed.newTrend;
  if (
    input.zlemaIsFlip &&
    input.trendScore >= 70 &&
    input.adx >= STRONG_ADX &&
    newTrend !== input.zlemaDirection &&
    input.zlemaDirection !== "NEUTRAL"
  ) {
    newTrend = input.zlemaDirection;
  }
  const strength = classifyFlipStrength({
    zlemaIsFlip: input.zlemaIsFlip,
    trendScore: input.trendScore,
    adx: input.adx,
    confidence: parsed.confidence,
  });
  const againstPosition = isTrendAgainstPosition(input.side, newTrend);
  const decision = decideTrendExit({
    side: input.side,
    newTrend,
    strength,
    beMoved: input.beMoved,
    unrealizedNetUsd: input.unrealizedNetUsd,
  });
  const reason = !againstPosition
    ? `Trend ${newTrend} searah/tidak melawan ${input.side}; HOLD.`
    : decision.shouldExit
      ? `Trend ${newTrend} ${strength} melawan ${input.side} (ZLEMA${input.zlemaIsFlip ? " FLIP" : ""} skor ${input.trendScore} ADX ${input.adx} conf ${(parsed.confidence * 100).toFixed(0)}%); EXIT_NOW.`
      : `Trend ${newTrend} ${strength} melawan ${input.side} tapi belum cukup kuat (conf ${(parsed.confidence * 100).toFixed(0)}%); WATCH.`;
  return {
    newTrend,
    confidence: parsed.confidence,
    againstPosition,
    strength,
    reason,
    agentId,
    agentName,
    narrative: narrative.slice(0, 500),
    byLlm,
    shouldExit: decision.shouldExit,
    exitUrgency: decision.exitUrgency,
  };
}
