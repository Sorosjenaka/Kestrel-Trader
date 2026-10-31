import { defaultLlmAdapter, type XkiroAdapter } from "./llmAdapter.js";
import { ALL_12_AGENTS } from "./agentCatalog.js";
import type { MicrostructureFlowBlock } from "./marketIntel.js";
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

export type BattleSide = "LONG" | "SHORT";
export type BattleStance = "SUPPORT" | "NEUTRAL" | "REJECT";

export interface DirectionBattleInput {
  symbol: string;
  mode?: string;
  proposedSide: BattleSide;
  trendScore: number | null;
  regime: string | null;
  adx: number | null;
  chop: number | null;
  macroAllowed: boolean;
  macroAllowedBySide?: Partial<Record<BattleSide, boolean>>;
  macroDetail: string;
  compositeScore: number;
  knnProb: number | null;
  microstructure: MicrostructureFlowBlock | null;
}

export interface DirectionBattleVote {
  agentId: string;
  side: BattleSide;
  stance: BattleStance;
  confidence: number;
  reasoning: string;
  byLlm: boolean;
}

export interface DirectionBattleDecision {
  status: "GO" | "REJECT";
  winner: BattleSide | null;
  margin: number;
  longScore: number;
  shortScore: number;
  trendSide: BattleSide | null;
  votes: DirectionBattleVote[];
  reasons: string[];
  battleId: string;
  dataQuality: "USABLE" | "UNAVAILABLE";
}

const AGENTS = [
  { id: "macro-scout", role: "macro regime and BTC context" },
  { id: "setup-judge", role: "technical structure, trend and confluence" },
  { id: "risk-officer", role: "liquidity, invalidation and risk quality" },
] as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function trendSide(input: DirectionBattleInput): BattleSide | null {
  if (!Number.isFinite(input.trendScore)) return null;
  if ((input.trendScore as number) >= 55) return "LONG";
  if ((input.trendScore as number) <= 45) return "SHORT";
  return null;
}

function microDataQuality(m: MicrostructureFlowBlock | null): "USABLE" | "UNAVAILABLE" {
  return m && m.status !== "UNAVAILABLE" ? "USABLE" : "UNAVAILABLE";
}

function microSummary(m: MicrostructureFlowBlock | null): string {
  if (!m || m.status === "UNAVAILABLE") return "unavailable";
  return JSON.stringify({
    status: m.status,
    cvd: m.orderFlowCvd,
    walls: m.wallLifelines,
    liquidation: m.liquidationMap,
    volumeProfile: m.volumeProfile,
    tierFlow: m.tierAndExchangeFlow,
  });
}

function parseVote(raw: string): { stance: BattleStance; confidence: number; reasoning: string } | null {
  try {
    const clean = raw.trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    const stance = String(parsed.stance ?? "").toUpperCase();
    if (stance !== "SUPPORT" && stance !== "NEUTRAL" && stance !== "REJECT") return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
    const reasoning = String(parsed.reasoning ?? "").trim();
    if (!reasoning) return null;
    return { stance, confidence, reasoning: reasoning.slice(0, 400) };
  } catch {
    return null;
  }
}

function score(v: DirectionBattleVote): number {
  const signed = v.stance === "SUPPORT" ? 1 : v.stance === "REJECT" ? -1 : 0;
  return signed * v.confidence;
}

/**
 * Integrasi agen LLM (27 Okt 2026): setiap voter battle menulis AGENT_DIALOG
 * miliknya sendiri, sehingga kartu agen di dashboard (liveMesh membaca
 * payload.agentId) menampilkan bukti battle sama seperti riset/judge lain.
 * Satu dialog per agen (mencakup penilaian LONG + SHORT miliknya). Fail-open:
 * kegagalan log tidak pernah mengubah keputusan battle.
 */
async function recordBattleAgentDialogs(
  input: DirectionBattleInput,
  decision: DirectionBattleDecision,
): Promise<void> {
  for (const agent of AGENTS) {
    const mine = decision.votes.filter((v) => v.agentId === agent.id);
    if (mine.length === 0) continue;
    const profile = ALL_12_AGENTS[agent.id];
    const line = (v: DirectionBattleVote) =>
      `${v.side} ${v.stance} ${v.confidence} (${v.byLlm ? v.reasoning : "LLM tidak tersedia"})`;
    const verdict = decision.status === "GO" ? `GO ${decision.winner}` : "REJECT";
    const text = `Battle arah ${input.symbol}: LONG ${decision.longScore} vs SHORT ${decision.shortScore} -> ${verdict}. Penilaian saya: ${mine.map(line).join("; ")}.`;
    try {
      await db.eventLog.create({
        data: {
          type: "AGENT_DIALOG",
          severity: "info",
          payload: JSON.stringify({
            agentId: agent.id,
            name: profile?.name ?? agent.id,
            text,
            timestamp: new Date().toISOString(),
            context: {
              kind: "direction_battle",
              battleId: decision.battleId,
              symbol: input.symbol,
              status: decision.status,
              winner: decision.winner,
              longScore: decision.longScore,
              shortScore: decision.shortScore,
            },
          }),
        },
      });
    } catch {
      // toleransi mock DB
    }
  }
}

/**
 * Independent LONG-vs-SHORT review. This is deliberately disabled by default;
 * callers must opt in with DIRECTION_BATTLE_ENABLED and still pass every normal
 * deterministic/risk gate. The arena selects a direction, never prices an order.
 */
export async function runDirectionBattle(
  input: DirectionBattleInput,
  adapter: XkiroAdapter = defaultLlmAdapter,
): Promise<DirectionBattleDecision> {
  const battleId = `${input.symbol}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const tSide = trendSide(input);
  const dataQuality = microDataQuality(input.microstructure);
  const base = `Symbol: ${input.symbol}\nRegime: ${input.regime ?? "UNKNOWN"}\nTrend score: ${input.trendScore ?? "UNKNOWN"}\nADX: ${input.adx ?? "UNKNOWN"}; CHOP: ${input.chop ?? "UNKNOWN"}\nMacro allowed: ${input.macroAllowed} (${input.macroDetail})\nComposite score: ${input.compositeScore}; KNN: ${input.knnProb ?? "UNKNOWN"}\nFive evidence panels: ${microSummary(input.microstructure)}`;

  const prompts = AGENTS.flatMap((agent) => (["LONG", "SHORT"] as BattleSide[]).map((side) => ({ agent, side })));
  const votes = await Promise.all(prompts.map(async ({ agent, side }): Promise<DirectionBattleVote> => {
    // Integrasi agen LLM (27 Okt 2026): persona diambil dari katalog 12 agen
    // (agentCatalog) supaya voter battle adalah agen yang SAMA dengan yang tampil
    // di dashboard — bukan persona lepas yang hanya ada di file ini.
    const profile = ALL_12_AGENTS[agent.id];
    const identity = profile
      ? `You are ${profile.name} (${profile.id}), ${profile.role} on the Private Trade AI team.\nPersonality: ${profile.personality}.\n`
      : `You are ${agent.id}, the ${agent.role}.\n`;
    const system = identity +
      `You are in an independent LONG vs SHORT battle arena.\n` +
      `Evaluate only the ${side} proposal. Do not invent missing data. Return JSON only: ` +
      `{"stance":"SUPPORT|NEUTRAL|REJECT","confidence":0-100,"reasoning":"brief evidence-based reason"}.`;
    const user = `${base}\nProposal side: ${side}\nCompare this side against its opposite, using trend alignment, regime, macro, order flow, wall lifelines, liquidation map, volume profile/large trades, and tier flow.`;
    try {
      const res = await adapter.callFast(user, system, { maxTokens: 240, timeoutMs: 8_000, queuePriority: "critical", fairnessKey: `battle:${input.symbol}` });
      const parsed = parseVote(res.content);
      if (parsed) return { agentId: agent.id, side, ...parsed, byLlm: true };
    } catch (err) {
      logger.warn({ symbol: input.symbol, side, agent: agent.id, err: (err as Error).message }, "DIRECTION_BATTLE_AGENT_FAIL");
    }
    return { agentId: agent.id, side, stance: "REJECT", confidence: 0, reasoning: "AGENT_UNAVAILABLE_OR_MALFORMED", byLlm: false };
  }));

  const longScore = votes.filter((v) => v.side === "LONG").reduce((a, v) => a + score(v), 0);
  const shortScore = votes.filter((v) => v.side === "SHORT").reduce((a, v) => a + score(v), 0);
  const margin = Math.abs(longScore - shortScore);
  const winner: BattleSide | null = longScore === shortScore ? null : longScore > shortScore ? "LONG" : "SHORT";
  const validLlm = votes.filter((v) => v.byLlm).length >= 4;
  const reasons: string[] = [];
  if (!validLlm) reasons.push("INSUFFICIENT_ARENA_VOTES");
  if (!winner) reasons.push("NO_DIRECTIONAL_CONSENSUS");
  if (tSide && winner && tSide !== winner) reasons.push(`TREND_CONTRADICTION_${tSide}`);
  const winnerMacroAllowed = winner
    ? (input.macroAllowedBySide?.[winner] ?? input.macroAllowed)
    : input.macroAllowed;
  if (!winnerMacroAllowed) reasons.push("MACRO_NOT_ALLOWED");
  if (dataQuality === "UNAVAILABLE") reasons.push("MICROSTRUCTURE_UNAVAILABLE");

  // Trend is an explicit tie-breaker/guard: the arena cannot approve a side
  // that directly contradicts a clear trend signal.
  const status = validLlm && winner !== null && margin >= 120 && !reasons.some((r) =>
    r.startsWith("TREND_CONTRADICTION") || r === "MACRO_NOT_ALLOWED" || r === "MICROSTRUCTURE_UNAVAILABLE")
    ? "GO" : "REJECT";
  const decision: DirectionBattleDecision = { status, winner: status === "GO" ? winner : null, margin, longScore, shortScore, trendSide: tSide, votes, reasons, battleId, dataQuality };
  await recordBattleAgentDialogs(input, decision).catch(() => undefined);

  try {
    const row = await db.directionBattle.create({
      data: {
        battleId,
        symbol: input.symbol,
        mode: input.mode ?? "SWING",
        proposedSide: input.proposedSide,
        trendSide: tSide,
        winner: decision.winner,
        status,
        longScore,
        shortScore,
        margin,
        trendScore: Number.isFinite(input.trendScore) ? input.trendScore : null,
        regime: input.regime,
        adx: Number.isFinite(input.adx) ? input.adx : null,
        choppiness: Number.isFinite(input.chop) ? input.chop : null,
        compositeScore: Number.isFinite(input.compositeScore) ? input.compositeScore : null,
        knnProb: Number.isFinite(input.knnProb) ? input.knnProb : null,
        macroAllowed: winnerMacroAllowed,
        dataQuality,
        reasons: JSON.stringify(reasons),
        inputSnapshot: JSON.stringify({ ...input, microstructure: input.microstructure ? { status: input.microstructure.status } : null }),
        votes: { create: votes.map((vote) => ({ agentId: vote.agentId, side: vote.side, stance: vote.stance, confidence: vote.confidence, reasoning: vote.reasoning, byLlm: vote.byLlm })) },
      },
    });
    logger.info({ symbol: input.symbol, battleId, battleRecordId: row.id, status }, "DIRECTION_BATTLE_RECORDED");
  } catch (err) {
    logger.error({ symbol: input.symbol, err: (err as Error).message }, "DIRECTION_BATTLE_LOG_FAIL");
  }
  try {
    await db.eventLog.create({ data: { type: "DIRECTION_BATTLE", severity: status === "GO" ? "info" : "warn", payload: JSON.stringify({ ...decision, input: { ...input, microstructure: input.microstructure ? { status: input.microstructure.status } : null }, generatedAt: new Date().toISOString(), outcome: "PENDING_TRADE_RESULT" }) } });
  } catch (err) {
    logger.error({ symbol: input.symbol, err: (err as Error).message }, "DIRECTION_BATTLE_EVENT_LOG_FAIL");
  }
  return decision;
}
