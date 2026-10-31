// apps/server/src/agents/councilEngine.ts
import * as llmAdapterModule from "./llmAdapter.js";
import * as agentCatalogModule from "./agentCatalog.js";
import { getOrderBookStats, type OrderBookSnapshot } from "../marketdata/lightweightOrderFlow.js";
import { buildMicrostructureSummary, gatherMarketContextSnapshot } from "./marketIntel.js";
import { logger } from "../core/logger.js";

const defaultLlmAdapter = llmAdapterModule.defaultLlmAdapter;
const ALL_12_AGENTS = agentCatalogModule.ALL_12_AGENTS;

export interface CouncilVote {
  agentId: string;
  agentName: string;
  stance: "GO" | "HOLD" | "NO_GO";
  confidenceScore: number;
  reasoning: string;
}

export interface CouncilDecision {
  finalAction: "EXECUTE" | "REJECT" | "MODIFY_AND_EXECUTE";
  consensusLevel: number;
  votes: CouncilVote[];
  summaryNarrative: string;
  orderFlowData?: OrderBookSnapshot | null;
}

interface TradeContext {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  atrValue: number;
  regimeInfo: string;
  technicalScore: number;
}

export async function conveneCouncil(context: TradeContext): Promise<CouncilDecision> {
  logger.info(`[Council] Convening for ${context.symbol} ${context.side}...`);

  let obSnapshot: OrderBookSnapshot | null = null;
  try {
    obSnapshot = await getOrderBookStats(context.symbol);
  } catch (err) {
    logger.warn(`[Council] Failed to fetch Order Book for ${context.symbol}: ${(err as Error).message}`);
  }

  const obSummary = obSnapshot
    ? `Imbalance: ${obSnapshot.imbalanceRatio.toFixed(2)}, Spread: ${obSnapshot.spreadPct?.toFixed(3)}%, Best Bid: ${obSnapshot.bestBid}, Best Ask: ${obSnapshot.bestAsk}`
    : "Data Order Book tidak tersedia/stale.";

  // BAGIAN 3 (24 Okt 2026): ambil ringkasan mikrostruktur & order flow.
  let microSummary = "Data mikrostruktur & order flow tidak tersedia.";
  try {
    const snap = await gatherMarketContextSnapshot();
    microSummary = buildMicrostructureSummary(snap.microstructure_and_flow);
  } catch (err) {
    logger.warn(`[Council] Gagal mengambil mikrostruktur: ${(err as Error).message}`);
  }

  const agentsToConsult = [
    { id: "macro-scout", role: "Macro Context" },
    { id: "setup-judge", role: "Technical Confluence & Order Flow" },
    { id: "risk-officer", role: "Risk Management" },
  ];

  const prompts = agentsToConsult.map(({ id, role }) => {
    const agentProfile = ALL_12_AGENTS[id];
    if (!agentProfile) throw new Error(`Agent profile not found: ${id}`);

    const systemPrompt = `Anda adalah ${agentProfile.name} (${agentProfile.id}), ${agentProfile.role} di tim Private Trade AI.
Kepribadian: ${agentProfile.personality}.
Gaya bicara: ${agentProfile.style}.
Tugas Anda sekarang adalah memberikan VOTE (GO/HOLD/NO_GO) dan Confidence Score (0-100) terhadap usulan trade berikut.
Jawaban HARUS dalam format JSON valid:
{
  "stance": "GO" | "HOLD" | "NO_GO",
  "confidence": number,
  "reasoning": "string singkat 1-2 kalimat"
}
Tidak ada teks lain selain JSON.`;

    const userPrompt = `
=== USULAN TRADE ===
Symbol: ${context.symbol}
Side: ${context.side}
Entry: ${context.entryPrice}
SL: ${context.slPrice}
TP: ${context.tpPrice}
ATR: ${context.atrValue}
Skor Teknikal Awal: ${context.technicalScore}/100
Regime Pasar: ${context.regimeInfo}

=== DATA ORDER BOOK REAL-TIME ===
${obSummary}

=== MIKROSTRUKTUR & ORDER FLOW (5 modul) ===
${microSummary}

=== PERINTAH ===
Sebagai ${role}, evaluasi apakah trade ini layak dieksekusi SEKARANG.
Pertimbangkan:
1. Kesesuaian dengan tren makro/regime.
2. Konfirmasi likuiditas/order flow (jika ada).
3. Keamanan risiko (jarak SL vs volatilitas).
Berikan vote dan alasan Anda.`;

    return { id, name: agentProfile.name, systemPrompt, userPrompt };
  });

  const callPromises = prompts.map(async (p) => {
    try {
      // 28 Okt 2026 (audit "trade 2/3 tidak datang"): timeout 8 dtk terlalu ketat
      // untuk latensi Xkiro (terukur 20+ dtk saat probe) -> vote gagal = confidence
      // 0 -> council menolak dengan "keyakinan 0.0%" (5x NO_GO dalam 24 jam).
      // 30 dtk realistis untuk satu vote; batas luar fail-closed 90 dtk di
      // runPreEntryCouncil tetap mengikat.
      const res = await defaultLlmAdapter.callFast(p.userPrompt, p.systemPrompt, { maxTokens: 200, timeoutMs: 30_000 });
      const cleanContent = res.content.trim().replace(/^```json\s*|\s*```$/g, "");
      const parsed = JSON.parse(cleanContent);
      
      return {
        agentId: p.id,
        agentName: p.name,
        stance: parsed.stance || "HOLD",
        confidenceScore: typeof parsed.confidence === "number" ? Math.min(100, Math.max(0, parsed.confidence)) : 50,
        reasoning: parsed.reasoning || "No reasoning provided."
      } as CouncilVote;
    } catch (err) {
      logger.error(`[Council] Agent ${p.name} failed: ${(err as Error).message}`);
      return {
        agentId: p.id,
        agentName: p.name,
        stance: "HOLD",
        confidenceScore: 0,
        reasoning: "AGENT_ERROR_UNAVAILABLE"
      } as CouncilVote;
    }
  });

  const votes = await Promise.all(callPromises);

  const hasHardVeto = votes.some(v => v.stance === "NO_GO" && v.confidenceScore > 70);
  const avgConfidence = votes.reduce((sum, v) => sum + v.confidenceScore, 0) / votes.length;
  const goVotes = votes.filter(v => v.stance === "GO").length;
  const holdVotes = votes.filter(v => v.stance === "HOLD").length;

  let finalAction: CouncilDecision["finalAction"] = "REJECT";
  let summary = "Dewan menolak trade karena ketidaksepakatan atau veto risiko.";

  if (hasHardVeto) {
    finalAction = "REJECT";
    const vetoes = votes.filter(v => v.stance === "NO_GO").map(v => `${v.agentName}: ${v.reasoning}`).join("; ");
    summary = `VETO AKTIF. Alasan: ${vetoes}`;
  } else if (goVotes >= 2 && avgConfidence >= 60) {
    finalAction = "EXECUTE";
    summary = `Konsensus GO (${goVotes}/3). Rata-rata keyakinan: ${avgConfidence.toFixed(1)}%.`;
  } else if (holdVotes >= 2 || avgConfidence < 50) {
    finalAction = "REJECT";
    summary = `Terlalu banyak keraguan (Hold/Vote Rendah). Rata-rata keyakinan: ${avgConfidence.toFixed(1)}%.`;
  } else {
    finalAction = "REJECT";
    summary = `Sinyal campur aduk tanpa konsensus kuat.`;
  }

  return {
    finalAction,
    consensusLevel: avgConfidence,
    votes,
    summaryNarrative: summary,
    orderFlowData: obSnapshot
  };
}

// ── Gerbang council PRA-ENTRY (27 Okt 2026) ─────────────────────────────────
// Dipindah dari level scan (selectBestPlan) ke funnel entry: HANYA kandidat
// yang sudah lolos semua gate deterministik + judge dan siap dieksekusi yang
// di-vote 3 agen. Alasan: di level scan council dipanggil ~61x/menit x 3 agen
// -> provider LLM 503 (159 error/10 menit) -> semua vote gagal -> veto 100%
// entry. Fail-closed: timeout/error = REJECT (hanya bisa MENCEGAH entry, tidak
// pernah menciptakan entry). Setiap keputusan dicatat ke EventLog
// COUNCIL_DECISION — bukti nyata untuk mesh dashboard, bukan klaim UI.

export interface PreEntryCouncilInput {
  symbol: string;
  side: "LONG" | "SHORT";
  mode: string;
  strategyId: string;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  atrValue?: number;
  regimeInfo: string;
  technicalScore: number;
}

export interface PreEntryCouncilResult {
  approved: boolean;
  decision: CouncilDecision;
}

export async function runPreEntryCouncil(
  input: PreEntryCouncilInput,
  timeoutMs = 90_000,
): Promise<PreEntryCouncilResult> {
  let decision: CouncilDecision;
  try {
    decision = await Promise.race([
      conveneCouncil({
        symbol: input.symbol,
        side: input.side,
        entryPrice: input.entryPrice,
        slPrice: input.slPrice,
        tpPrice: input.tpPrice,
        atrValue: input.atrValue ?? 0,
        regimeInfo: input.regimeInfo,
        technicalScore: input.technicalScore,
      }),
      new Promise<CouncilDecision>((resolve) => {
        const t = setTimeout(() => resolve({
          finalAction: "REJECT",
          consensusLevel: 0,
          votes: [],
          summaryNarrative: `TIMEOUT: council tidak memutuskan dalam ${timeoutMs / 1000} dtk — entry ditahan (fail-closed).`,
        }), timeoutMs);
        const u = t as unknown as { unref?: () => void };
        if (typeof u.unref === "function") u.unref();
      }),
    ]);
  } catch (err) {
    decision = {
      finalAction: "REJECT",
      consensusLevel: 0,
      votes: [],
      summaryNarrative: `ERROR: ${(err as Error).message} — entry ditahan (fail-closed).`,
    };
  }
  // Bukti nyata untuk mesh dashboard. Gagal mencatat TIDAK mengubah keputusan.
  try {
    const { db } = await import("../core/db.js");
    await db.eventLog.create({
      data: {
        type: "COUNCIL_DECISION",
        severity: decision.finalAction === "REJECT" ? "warn" : "info",
        payload: JSON.stringify({
          symbol: input.symbol,
          strategyId: input.strategyId,
          mode: input.mode,
          action: decision.finalAction,
          summary: String(decision.summaryNarrative ?? "").slice(0, 200),
        }),
      },
    });
  } catch { /* logging tidak boleh menggagalkan keputusan */ }
  return { approved: decision.finalAction !== "REJECT", decision };
}
