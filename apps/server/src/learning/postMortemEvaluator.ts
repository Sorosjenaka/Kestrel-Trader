// Evidence-tagged post-trade journal. This is retrieval, not LLM weight training.
// Mengevaluasi SEMUA hasil trade (loss, TP1, TP2, BEP) lewat agen LLM (Sesha) +
// heuristik deterministik: bedah penyebab, tulis pelajaran 1 kalimat, usulkan perbaikan.
// Hanya pelajaran dengan respons LLM valid dipakai sebagai konteks Setup Judge.
// Penyimpanan jurnal bukan pelatihan ulang bobot model.
import { XkiroAdapter, defaultLlmAdapter } from "../agents/llmAdapter.js";
import { ALL_12_AGENTS } from "../agents/agentCatalog.js";
import { db } from "../core/db.js";
import { TRADING_EVIDENCE_POLICY } from "../agents/tradingPolicy.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { buildTradeForensicBundle, type AgentRoundtable, type ForensicBar, type TradeForensicBundle, validateEvidenceRefs } from "./tradeForensics.js";
// SMB Capital Momentum Model (9 Okt 2026): kesalahan eksekusi + 5 Whys + playbook/friction.
import { detectExecutionMistake, detectRecurringMistakes, TARGET_RISK_BASELINE_USD } from "./executionMistakes.js";
import { usesSwingRr23 } from "../strategies/swing/researchExitPolicy.js";
import { loadApprovedRules, proposeRuleFromRecurringMistake, recordRuleFriction } from "./playbookRules.js";
import { runFiveWhysDiagnosis } from "./fiveWhys.js";
import { buildRecurringMistakeAlert } from "../analytics/metricsRegistry.js";
import { buildMicrostructurePromptBlock } from "../agents/marketIntel.js";

export type LossCauseCode =
  | "CHOP_ENTRY"
  | "SL_TIGHT"
  | "STOP_HUNT"
  | "FAKEOUT_TRAP"
  | "GIVEBACK"
  | "MACRO_FLIP"
  | "LATE_ENTRY"
  | "FEE_DRAG"
  | "NEWS_SPIKE"
  | "LOSS_SL"
  | "LOSS_TREND_FLIP"
  | "LOSS_TIMEOUT"
  | "TP2_PERFECT"
  | "TP1_DISCIPLINE"
  | "BE_SAVED"
  | "EDGE_HELD"
  | "OTHER";

export type TradeOutcome =
  | "LOSS_SL"
  | "LOSS_TREND_FLIP"
  | "LOSS_TIMEOUT"
  | "LOSS_OTHER"
  | "WIN_TP2"
  | "WIN_TP1"
  | "BE"
  | "WIN_OTHER"
  | "LOSS"
  | "WIN"
  | "UNKNOWN";

export interface LearningEntryRow {
  id: number;
  // null = evaluasi "yatim" yang dipertahankan setelah trade-nya dihapus (reset history).
  tradeId: number | null;
  causeCode: LossCauseCode | string;
  outcome: TradeOutcome | string;
  narrative: string;
  /** Hipotesis yang hanya masuk konteks judge bila sumbernya LLM valid. */
  lesson: string | null;
  agentId: string;
  proposal: string | null;
    /** SMB T-01: klasifikasi kesalahan eksekusi (allowlist EXECUTION_MISTAKES). */
    executionMistake: string;
    isExecutionMistake: boolean;
    planDeviationRatio: number | null;
    mistakeNotes: string | null;
    createdAt: Date;
  }

  export interface TradeForEvaluation {
  id: number;
  positionId: number;
  symbol: string;
  mode: string;
  side: string;
  riskUsd: number;
  entryAvg: number;
  exitAvg: number;
  rMultiple: number;
  pnlUsd: number;
  feeUsd: number;
  /** Funding cost recorded separately; only subtract when fundingVerified=true. */
  fundingUsd?: number;
  holdMinutes: number;
  win: boolean;
  mfeR?: number;
  maeR?: number;
  strategyId?: string | null;
  closeReason?: string | null;
  beMoved?: boolean;
  tp1Filled?: boolean;
  source?: string | null;
  accountingQuality?: string;
  fundingVerified?: boolean;
  excursionsVerified?: boolean;
  plannedSlPrice?: number | null;
  authorizedBreakeven?: boolean;
    /** SL yang benar-benar terpasang saat close (Position.slPrice) — deteksi pergeseran SL. */
    executedSlPrice?: number | null;
    plannedTp1Price?: number | null;
  plannedTp2Price?: number | null;
  zoneType?: string | null;
  zoneTop?: number | null;
  zoneBottom?: number | null;
  entryType?: string | null;
  leverage?: number | null;
  marginUsd?: number | null;
  createdAt?: Date;
  openedAt?: Date | null;
  closedAt?: Date | null;
  /** 8 Okt 2026: qty derivasi (deriveTradeQty) untuk perhitungan fee notional. */
  qty?: number | null;
  /** SMB T-07 (9 Okt 2026): harga ekstrem floating dari Position, untuk lokalisasi bar MAE/MFE. */
  maePrice?: number | null;
  mfePrice?: number | null;
}

export interface LearningRepo {
  findTradeById(id: number): Promise<TradeForEvaluation | null>;
  findLearningByTradeId(id: number): Promise<LearningEntryRow | null>;
  createLearningEntry(data: Omit<LearningEntryRow, "id">): Promise<LearningEntryRow>;
  updateLearningEntry(id: number, data: Partial<Pick<LearningEntryRow, "narrative" | "lesson" | "proposal">>): Promise<void>;
  findAllLearnings(causeCode?: string): Promise<Array<LearningEntryRow & { trade?: TradeForEvaluation }>>;
  /** SMB T-01: trade simbol sama sebelum tradeId (deteksi revenge). Opsional. */
  findPriorSymbolTrades?(symbol: string, tradeId: number): Promise<Array<{ closedAt: Date | null; closeReason: string | null; win: boolean; openedAt: Date | null }>>;
  findRecentLessons(symbol: string, take?: number, decisionTime?: Date): Promise<Array<Pick<LearningEntryRow, "causeCode" | "outcome" | "lesson" | "narrative" | "createdAt"> & { symbol: string }>>;
  logEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void>;
}

export interface AgentTradeReview {
  agentId: string;
  name: string;
  role: string;
  modelUsed: string | null;
  status: "COMPLETED" | "FAILED";
  finding: string;
  lesson: string | null;
  evidenceRefs: string[];
  hypotheses: Array<{
    code: string;
    claim: string;
    evidenceFor: string[];
    evidenceAgainst: string[];
    missingEvidence: string[];
    status: "HYPOTHESIS" | "UNKNOWN";
    confidenceScore: number | null;
    nextTest: string;
  }>;
  failureCode?: string;
}

const AGENT_REVIEW_TASK: Record<string, string> = {
  "macro-scout": "Bandingkan return BTC, ETH, dan BTCDOM pada jendela posisi; jelaskan jika benchmark tidak lengkap.",
  "universe-curator": "Audit apakah data yang tersedia cukup untuk menyimpulkan kelayakan simbol; jangan mengarang volume atau listing history.",
  "regime-analyst": "Nilai volatilitas/path candle dan jarak SL terhadap ATR pra-entry; ATR bukan sebab kausal dengan sendirinya.",
  "scanner-supervisor": "Tinjau kecocokan pemilihan kandidat dan ketersediaan data; jangan menganggap ranking scanner sebagai bukti kualitas.",
  "setup-judge": "Uji apakah alasan setup punya bukti sebelum entry dan tunjukkan bukti yang menyangkalnya.",
  "risk-officer": "Audit risiko terencana, jarak SL/ATR, fee, dan PnL tercatat; jangan menghitung ulang uang secara spekulatif.",
  "trade-supervisor": "Rekonstruksi urutan level exit sebatas resolusi candle; soroti candle yang menyentuh beberapa level sekaligus.",
  watchdog: "Periksa integritas/freshness/cakupan data yang diberikan dan bukti apa yang hilang.",
  "strategy-tuner": "Ajukan eksperimen parameter sebagai hipotesis lintas trade, bukan perubahan dari satu sampel.",
  "backtest-auditor": "Rancang pembandingan baseline-kandidat out-of-sample yang menghindari lookahead dan pengulangan holdout.",
  narrator: "Rangkum perbedaan fakta, dugaan, dan langkah uji; jangan mengubah hipotesis menjadi kesimpulan pasti.",
};

function failedAgentReview(agentId: string, failureCode: string): AgentTradeReview {
  const agent = ALL_12_AGENTS[agentId]!;
  return { agentId, name: agent.name, role: agent.role, modelUsed: null, status: "FAILED", finding: "Agen tidak menghasilkan review yang lolos validasi bukti.", lesson: null, evidenceRefs: [], hypotheses: [], failureCode };
}

function safeLlmFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.match(/LLM_(?:HTTP_\d{3}|TIMEOUT|NETWORK_ERROR|EMPTY_OR_TRUNCATED_RESPONSE|API_KEY_NOT_CONFIGURED)/)?.[0] ?? "LLM_REVIEW_UNAVAILABLE";
}

function validateHypotheses(value: unknown, refs: Set<string>): AgentTradeReview["hypotheses"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hypothesis = item as Record<string, unknown>;
    const evidenceFor = validateEvidenceRefs(hypothesis.evidenceFor ?? [], refs);
    const evidenceAgainst = validateEvidenceRefs(hypothesis.evidenceAgainst ?? [], refs);
    if (typeof hypothesis.claim !== "string" || hypothesis.claim.trim().length < 12 || !evidenceFor || !evidenceAgainst) return [];
    const confidence = typeof hypothesis.confidenceScore === "number" && Number.isFinite(hypothesis.confidenceScore)
      ? Math.max(0, Math.min(100, hypothesis.confidenceScore)) : null;
    return [{
      code: typeof hypothesis.code === "string" ? hypothesis.code.slice(0, 60) : "UNCLASSIFIED",
      claim: hypothesis.claim.trim().slice(0, 500), evidenceFor, evidenceAgainst,
      missingEvidence: Array.isArray(hypothesis.missingEvidence) ? hypothesis.missingEvidence.filter((v): v is string => typeof v === "string").slice(0, 5) : [],
      // OHLC cannot prove intent or intrabar event order; model assertions never get promoted to fact.
      status: hypothesis.status === "UNKNOWN" ? "UNKNOWN" as const : "HYPOTHESIS" as const,
      confidenceScore: confidence,
      nextTest: typeof hypothesis.nextTest === "string" ? hypothesis.nextTest.slice(0, 300) : "Bandingkan pada replay kronologis out-of-sample.",
    }];
  });
}

function matchingPrimaryEvidence(narrative: string, forensic: TradeForensicBundle): string[] {
  const numbers = (narrative.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const matched = forensic.facts.flatMap((fact) => {
    const value = fact.value;
    return typeof value === "number" && numbers.some((n) => Math.abs(n - value) <= Math.max(1e-6, Math.abs(value) * 0.005)) ? [fact.id] : [];
  });
  return [...new Set([...matched, ...forensic.facts.filter((fact) => fact.status === "DERIVED").slice(0, 2).map((fact) => fact.id)])].slice(0, 12);
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

function parseBinanceKlines(rows: unknown[]): ForensicBar[] {
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const bar = { openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
    return Object.values(bar).every(Number.isFinite) ? [bar] : [];
  });
}

async function fetchKlineWindow(symbol: string, interval: "1m" | "5m", from: number, to: number, intervalMs: number): Promise<ForensicBar[]> {
  const rows: unknown[] = [];
  let cursor = from;
  for (let page = 0; page < 4 && cursor < to; page++) {
    const pageRows = await binanceFuturesClient.fetchKlinesRange(symbol, interval, cursor, to, 1000);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    const lastTime = Number((pageRows.at(-1) as unknown[] | undefined)?.[0]);
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;
    cursor = lastTime + intervalMs;
  }
  return parseBinanceKlines(rows);
}

export async function loadBinanceTradeForensics(trade: TradeForEvaluation): Promise<TradeForensicBundle> {
  // 30 Sep 2026 — refactor SCALP-only: forensik memakai TF trigger 1m.
  const interval: "1m" | "5m" = "1m";
  const intervalMs = interval === "1m" ? 60_000 : 300_000;
  const openedAt = trade.openedAt?.getTime();
  const closedAt = trade.closedAt?.getTime() ?? trade.createdAt?.getTime();
  if (!(openedAt && closedAt && closedAt > openedAt)) return unavailableForensics(trade, interval);
  // Binance startTime is inclusive by candle open time. Align range bounds so
  // the first overlapping bar isn't silently skipped when entry is mid-candle.
  // 13 Okt 2026 (audit live ACC2): 15 bar pra-entry WAJIB — atrBeforeEntry()
  // butuh 15 bar kontinu (period 14 + 1 bar shift) supaya entry.atr14 dan
  // entry.sl_atr_ratio tidak UNKNOWN permanen (window 14 bar lama selalu
  // gagal syarat length >= period+1).
  const from = Math.floor((openedAt - 15 * intervalMs) / intervalMs) * intervalMs;
  const to = Math.ceil((closedAt + 6 * intervalMs) / intervalMs) * intervalMs;
  const symbols = [...new Set([trade.symbol.toUpperCase(), "BTCUSDT", "ETHUSDT", "BTCDOMUSDT"])];
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchKlineWindow(symbol, interval, from, to, intervalMs)] as const));
  return buildTradeForensicBundle({ trade, interval, barsBySymbol: Object.fromEntries(entries) });
}

function unavailableForensics(trade: TradeForEvaluation, interval: "1m" | "5m" = "1m"): TradeForensicBundle {
  return buildTradeForensicBundle({ trade, interval, barsBySymbol: {} });
}

export class PostMortemEvaluator {
  private readonly adapter: XkiroAdapter;
  private readonly repo: LearningRepo;
  private readonly forensicLoader: (trade: TradeForEvaluation) => Promise<TradeForensicBundle>;
  private readonly inFlight = new Map<number, Promise<LearningEntryRow>>();

  constructor(options?: { adapter?: XkiroAdapter; repo?: LearningRepo; forensicLoader?: (trade: TradeForEvaluation) => Promise<TradeForensicBundle> }) {
    this.adapter = options?.adapter ?? defaultLlmAdapter;
    this.repo = options?.repo ?? prismaLearningRepo;
    this.forensicLoader = options?.forensicLoader ?? loadBinanceTradeForensics;
  }

  /**
   * Klasifikasi HASIL trade dari closeReason posisi + R + flag TP1/BE.
   * TP1/TP2/BEP dipahami eksplisit sesuai perintah operator.
   */
  determineOutcome(trade: TradeForEvaluation): TradeOutcome {
    // The sign of total net PnL takes precedence over TP/BE labels or stale win flags.
    if (!Number.isFinite(trade.pnlUsd)) return "UNKNOWN";
    const reason = String(trade.closeReason ?? "").toUpperCase();
    if (trade.pnlUsd < -1e-8) {
      if (reason === "SL") return "LOSS_SL";
      if (reason === "TREND_FLIP") return "LOSS_TREND_FLIP";
      if (reason === "TIMEOUT") return "LOSS_TIMEOUT";
      return "LOSS_OTHER";
    }
    if (Math.abs(trade.pnlUsd) <= 1e-8) return "BE";
    if (trade.authorizedBreakeven && reason === "TP2") return "WIN_TP2";
    // Legacy labels retain their historical meaning; partial TP1+BE is still a win.
    if (trade.tp1Filled || reason === "TP1" || reason === "TP2") return "WIN_TP1";
    return "WIN_OTHER";
  }

  determineHeuristicCause(trade: TradeForEvaluation): { causeCode: LossCauseCode; proposal: Record<string, unknown>; lesson: string } {
    const outcome = this.determineOutcome(trade);
    const proposal = { action: "COLLECT_COMPARATIVE_EVIDENCE", hypothesisOnly: true, reason: "Tidak mengubah parameter dari satu hasil; perlu replay pembanding baseline dan kandidat." };
    if (outcome.startsWith("WIN")) return {
      causeCode: outcome === "WIN_TP2" ? "TP2_PERFECT" : outcome === "WIN_TP1" ? "TP1_DISCIPLINE" : "EDGE_HELD",
      proposal, lesson: "Trade ini net positif; satu observasi belum membuktikan edge atau kualitas keputusan. Bandingkan pola yang sama pada semua outcome.",
    };
    if (outcome === "BE") return { causeCode: "BE_SAVED", proposal, lesson: "Total PnL tercatat impas; teliti biaya dan jalur harga sebelum menyimpulkan efektivitas kebijakan exit." };
    if (trade.tp1Filled) return { causeCode: "GIVEBACK", proposal, lesson: "Total trade tetap LOSS walaupun TP1 terisi. Audit semua fill dan biaya serta sisa posisi; jangan melabelinya impas." };
    if (trade.pnlUsd < 0 && trade.feeUsd > 0 && trade.pnlUsd + trade.feeUsd >= 0) return {
      causeCode: "FEE_DRAG", proposal, lesson: "Biaya yang tercatat mengubah hasil menjadi negatif; evaluasi expectancy sesudah seluruh biaya, termasuk funding yang belum terverifikasi.",
    };
    return {
      causeCode: outcome === "LOSS_SL" ? "LOSS_SL" : outcome === "LOSS_TREND_FLIP" ? "LOSS_TREND_FLIP" : outcome === "LOSS_TIMEOUT" ? "LOSS_TIMEOUT" : "OTHER",
      proposal, lesson: "Loss adalah observasi. Stop-hunt, fakeout, SL terlalu sempit, dan perubahan makro belum terbukti tanpa data struktur dan lintasan harga.",
    };
  }

  /**
   * Evaluasi penuh SATU trade (semua outcome) oleh Sesha: bedah + pelajaran + usulan.
   * Respons LLM valid menulis narasi & pelajaran; fallback deterministik ditandai eksplisit.
   */
  evaluateTrade(tradeId: number, agentId = "post-mortem"): Promise<LearningEntryRow> {
    const pending = this.inFlight.get(tradeId);
    if (pending) return pending;
    const task = this.evaluateTradeOnce(tradeId, agentId).finally(() => this.inFlight.delete(tradeId));
    this.inFlight.set(tradeId, task);
    return task;
  }

  private async evaluateTradeOnce(tradeId: number, agentId: string): Promise<LearningEntryRow> {
    const existing = await this.repo.findLearningByTradeId(tradeId);
    if (existing && hasCompleteAgentPanel(existing)) return existing;
    const trade = await this.repo.findTradeById(tradeId);
    if (!trade) {
      throw new Error(`Trade #${tradeId} tidak ditemukan`);
    }

    if (!isTradeLearningEligible(trade)) throw new Error(`Trade #${tradeId}: INELIGIBLE_LEARNING_EVIDENCE (DEMO, legacy, atau akuntansi tidak valid)`);
    const outcome = this.determineOutcome(trade);
    const heur = this.determineHeuristicCause(trade);
    const agent = ALL_12_AGENTS[agentId] ?? ALL_12_AGENTS["post-mortem"];
    const forensic = await this.forensicLoader(trade).catch(() => unavailableForensics(trade));

    const sysPrompt = `Anda adalah ${agent.name} (${agent.id}), evaluator trading profesional di Private Trade AI.
Kepribadian: ${agent.personality}.
Gaya bicara: ${agent.style}.
${TRADING_EVIDENCE_POLICY}
    Tugas: evaluasi observasi ini, jelaskan hipotesis dan bukti yang belum tersedia. Narasi wajib menyebut simbol, strategi/mode, dan sedikitnya dua fakta numerik yang diberikan; pelajaran harus berupa langkah uji yang spesifik untuk trade ini. Jangan mengulang nasihat umum untuk semua trade. Jangan mengklaim sebab kausal atau rekomendasi parameter pasti dari satu trade. Bila lintasan OHLC/intratick tidak tersedia, katakan penyebab teknikal belum bisa dibuktikan. Pisahkan benchmark lintas pasar dari klaim sebab trade.
Jawab HANYA dalam JSON valid tanpa penjelasan lain:
{"causeCode":"<KODE>","narrative":"<2-3 kalimat bedah>","lesson":"<1 kalimat pelajaran>","proposalAction":"<AKSI>","proposalReason":"<ALASAN>"}
Kode valid: STOP_HUNT, FAKEOUT_TRAP, GIVEBACK, CHOP_ENTRY, SL_TIGHT, MACRO_FLIP, LATE_ENTRY, FEE_DRAG, NEWS_SPIKE, LOSS_SL, LOSS_TREND_FLIP, LOSS_TIMEOUT, OTHER, TP2_PERFECT, TP1_DISCIPLINE, BE_SAVED, EDGE_HELD.`;

    const userPrompt = `Bedah trade #${trade.id} (${trade.symbol} ${trade.side} ${trade.mode}, strategi ${trade.strategyId ?? "n/a"}):
- HASIL: ${outcome} | Entry $${trade.entryAvg} -> Exit $${trade.exitAvg} | Alasan close: ${trade.closeReason ?? "n/a"}
- PnL $${trade.pnlUsd} (${trade.rMultiple}R), fee $${trade.feeUsd}, hold ${trade.holdMinutes} mnt, TP tersentuh: ${trade.tp1Filled ? "YA" : "TIDAK"}; exit policy: ${trade.authorizedBreakeven ? "PAPER SWING 50% at 2R, authorized SL to entry, runner 50% at 3R" : trade.mode === "SWING" ? "legacy SWING: verify stored ladder and fill evidence" : "SCALP single target"}
- Provenance: ${trade.source}; kualitas akuntansi ${trade.accountingQuality}; funding ${trade.fundingVerified ? "VERIFIED" : "UNKNOWN_NOT_VERIFIED"}
- Rencana entry: SL ${trade.plannedSlPrice ?? "UNKNOWN"}, TP1 ${trade.plannedTp1Price ?? "UNKNOWN"}, TP2 ${trade.plannedTp2Price ?? "UNKNOWN"}; zona ${trade.zoneType ?? "UNKNOWN"} ${trade.zoneBottom ?? "?"}-${trade.zoneTop ?? "?"}; tipe ${trade.entryType ?? "UNKNOWN"}; leverage ${trade.leverage ?? "UNKNOWN"}x; margin $${trade.marginUsd ?? "UNKNOWN"}
- MFE/MAE: ${trade.excursionsVerified ? `OBSERVED_SAMPLED ${trade.mfeR}R / ${trade.maeR}R (bukan seluruh intratick)` : "UNKNOWN: jangan gunakan angka legacy sebagai bukti"}
- Dugaan awal sistem: ${heur.causeCode} — setujui atau koreksi dengan bukti.
- BUKTI PRICE-PATH & BENCHMARK (fakta sistem; referensi ID wajib dalam review agen lain): ${JSON.stringify(forensic.facts)}
- Cakupan sumber: ${forensic.source}; interval ${forensic.interval}; coverage ${JSON.stringify(forensic.coverage)}.
- Batas analisis: ${forensic.limitation}
${await buildMicrostructurePromptBlock(trade.symbol)}`;

    let causeCode: LossCauseCode | string = heur.causeCode;
    let narrative = "";
    let lesson: string | null = heur.lesson;
    let proposal: Record<string, unknown> = heur.proposal;
    let generationSource: "LLM" | "DETERMINISTIC_FALLBACK" = "DETERMINISTIC_FALLBACK";
    let failureCode = "LLM_INVALID_RESPONSE";
    let model: string | null = null;
    try {
      const res = await this.adapter.callReason(userPrompt, sysPrompt, { maxTokens: 2000, timeoutMs: 45_000 });
      const raw = (res.content ?? "").trim();
      const parsed = extractJsonObject(raw);
      if (parsed && typeof parsed.narrative === "string" && typeof parsed.lesson === "string"
        && isTradeSpecificAnalysis(parsed.narrative, parsed.lesson, trade)) {
        generationSource = "LLM";
        failureCode = "";
        model = res.model;
        // Cause codes remain factual; model hypotheses are retained only as narrative.
        if (typeof parsed.causeCode === "string" && parsed.causeCode === heur.causeCode) causeCode = parsed.causeCode;
        narrative = parsed.narrative.trim().slice(0, 1200);
        lesson = parsed.lesson.trim().slice(0, 500);
        const pAction = typeof parsed.proposalAction === "string" ? parsed.proposalAction : undefined;
        const pReason = typeof parsed.proposalReason === "string" ? parsed.proposalReason : undefined;
        if (pAction || pReason) proposal = { action: pAction ?? heur.proposal.action, reason: pReason ?? heur.proposal.reason };
      }
    } catch (err) {
      // Store only a safe error code; never persist provider response bodies or credentials.
      const message = err instanceof Error ? err.message : "";
      failureCode = message.match(/LLM_HTTP_\d{3}|LLM_TIMEOUT|LLM_NETWORK_ERROR|LLM_EMPTY_OR_TRUNCATED_RESPONSE|LLM_API_KEY_NOT_CONFIGURED/)?.[0] ?? "LLM_UNAVAILABLE";
    }
    if (!narrative) narrative = `Observasi ${outcome}, net tercatat $${trade.pnlUsd}. ${heur.lesson} Penyebab kausal belum terverifikasi.`;
    const provenanceLabel = trade.accountingQuality === "SIMULATED" ? "SIMULATED: biaya/fill estimasi, bukan bukti profit live" : "VERIFIED_FILLS";
    lesson = `[${provenanceLabel}; funding ${trade.fundingVerified ? "verified" : "unknown"}; hipotesis] ${lesson}`;
    // SMB T-01: klasifikasi kesalahan eksekusi deterministik (GR #1) — terpisah
    // dari causeCode pasar dan tidak menghapus konteks apa pun.
    const priorSymbolTrades = this.repo.findPriorSymbolTrades
      ? await this.repo.findPriorSymbolTrades(trade.symbol, trade.id).catch(() => [])
      : [];
    const mistakeResult = detectExecutionMistake({
      riskUsd: trade.riskUsd,
      targetRiskUsd: TARGET_RISK_BASELINE_USD,
      closeReason: trade.closeReason ?? null,
      entryAvg: trade.entryAvg,
      exitAvg: trade.exitAvg,
      plannedSlPrice: trade.plannedSlPrice ?? null,
      executedSlPrice: trade.executedSlPrice ?? null,
      authorizedBreakeven: trade.authorizedBreakeven,
      plannedTp1Price: trade.plannedTp1Price ?? null,
      side: trade.side,
      priorSymbolTrades,
      openedAt: trade.openedAt ?? null,
    });

    const existingPanel = extractJsonObject(existing?.proposal ?? "")?.agentPanel;
    const reviewedPanel = await this.reviewWithAllAgents(trade, outcome, forensic, agent.id, generationSource === "LLM" ? { narrative, lesson: lesson ?? "", causeCode } : null, model, existingPanel);
    const completedAgentCount = reviewedPanel.reviews.filter((review) => review.status === "COMPLETED").length;
    proposal = {
      ...proposal, hypothesisOnly: true, evidenceVersion: 2,
      source: trade.source, accountingQuality: trade.accountingQuality,
      fundingVerified: trade.fundingVerified === true, excursionsVerified: trade.excursionsVerified === true,
      strategyId: trade.strategyId ?? null, tradeId: trade.id,
      observedOutcome: outcome, parameterActivationAllowed: false,
      generationSource, failureCode: generationSource === "LLM" ? null : failureCode,
      model,
      forensic,
      agentPanel: { schemaVersion: 1, expectedAgents: Object.keys(ALL_12_AGENTS).length, completedAgents: completedAgentCount, lastAttemptAt: new Date().toISOString(), reviews: reviewedPanel.reviews, roundtable: reviewedPanel.roundtable },
    };

    const entryData: Omit<LearningEntryRow, "id"> = {
      tradeId: trade.id,
      causeCode,
      outcome,
      narrative,
      lesson,
      agentId: agent.id,
      proposal: JSON.stringify(proposal),
            executionMistake: mistakeResult.mistake,
            isExecutionMistake: mistakeResult.isMistake,
            planDeviationRatio: mistakeResult.planDeviationRatio,
            mistakeNotes: mistakeResult.notes.join(" | "),
            createdAt: existing?.createdAt ?? new Date(),
          };
    const entry = existing
      ? (await this.repo.updateLearningEntry(existing.id, { narrative: entryData.narrative, lesson: entryData.lesson, proposal: entryData.proposal }), { ...existing, ...entryData })
      : await this.repo.createLearningEntry(entryData);

    await this.repo.logEvent("POST_MORTEM_SAVED", "info", {
          learningId: entry.id,
          tradeId: trade.id,
          causeCode,
          outcome,
          lesson,
          narrative,
          generationSource,
          failureCode: generationSource === "LLM" ? null : failureCode,
        });

        // ── SMB pipeline (T-01..T-06, 9 Okt 2026): whyChain untuk kesalahan nyata,
        // deteksi kesalahan berulang -> aturan PROPOSED, friction aturan APPROVED.
        // Fail-safe: kegagalan di sini tidak membatalkan jurnal yang sudah sah. ──
        try {
          const additions: Record<string, unknown> = { executionMistake: mistakeResult };
          // 11 Okt 2026 — perintah operator: "5 why selalu mencakup setiap SL dan TP trade".
          // Diagnosis 5 Whys dijalankan untuk SETIAP trade yang keluar via SL maupun TP,
          // bukan hanya yang ber-kesalahan-eksekusi (sebelumnya: if mistakeResult.isMistake).
          const closeReason = String(trade.closeReason ?? "").toUpperCase();
          const isSlTpExit = closeReason.startsWith("SL") || closeReason.startsWith("TP");
          if (mistakeResult.isMistake || isSlTpExit) {
            additions.fiveWhys = await runFiveWhysDiagnosis({ adapter: this.adapter, trade, forensic, executionMistake: mistakeResult.mistake });
          }
          const codes = (await this.repo.findAllLearnings()).map((l) => l.executionMistake ?? null);
          for (const finding of detectRecurringMistakes(codes)) {
            const alert = buildRecurringMistakeAlert(finding.mistake, finding.occurrences, finding.windowTrades);
            await this.repo.logEvent("RECURRING_MISTAKE", "warn", { tradeId: trade.id, mistake: finding.mistake, occurrences: finding.occurrences, windowTrades: finding.windowTrades, message: alert.message });
            const proposed = await proposeRuleFromRecurringMistake(finding.mistake, finding.occurrences, finding.windowTrades);
            if (proposed.created) await this.repo.logEvent("PLAYBOOK_RULE_PROPOSED", "info", { ruleId: proposed.rule.id, mistake: finding.mistake, status: "PROPOSED" });
          }
          if (mistakeResult.mistake !== "MISTAKE_NONE") {
            const friction = await recordRuleFriction(await loadApprovedRules(), mistakeResult.mistake, trade.id);
            additions.friction = friction.map((f) => ({ ruleId: f.rule.id, outcome: f.outcome }));
          }
          const merged = { ...(extractJsonObject(entry.proposal ?? "") ?? {}), ...additions };
          const newProposal = JSON.stringify(merged);
          await this.repo.updateLearningEntry(entry.id, { proposal: newProposal });
          entry.proposal = newProposal;
        } catch {
          /* SMB pipeline best-effort; jurnal utama tetap sah. */
        }

        return entry;
      }

  private async reviewWithAllAgents(
    trade: TradeForEvaluation,
    outcome: TradeOutcome,
    forensic: TradeForensicBundle,
    primaryAgentId: string,
    primary: { narrative: string; lesson: string; causeCode: string } | null,
    primaryModel: string | null,
    previousPanel?: unknown,
  ): Promise<{ reviews: AgentTradeReview[]; roundtable: AgentRoundtable }> {
    const primaryAgent = ALL_12_AGENTS[primaryAgentId] ?? ALL_12_AGENTS["post-mortem"];
    const refs = new Set(forensic.facts.map((fact) => fact.id));
    const previous = previousPanel && typeof previousPanel === "object" ? previousPanel as Record<string, unknown> : {};
    const reusable = new Map<string, AgentTradeReview>();
    for (const value of Array.isArray(previous.reviews) ? previous.reviews : []) {
      if (!value || typeof value !== "object") continue;
      const review = value as AgentTradeReview;
      if (!Object.hasOwn(ALL_12_AGENTS, review.agentId) || review.status !== "COMPLETED"
        || typeof review.finding !== "string" || typeof review.lesson !== "string"
        || !validateEvidenceRefs(review.evidenceRefs, refs)?.length) continue;
      reusable.set(review.agentId, review);
    }
    const result: AgentTradeReview[] = [];
    result.push(reusable.get(primaryAgent.id) ?? (primary
      ? { agentId: primaryAgent.id, name: primaryAgent.name, role: primaryAgent.role, modelUsed: primaryModel, status: "COMPLETED", finding: primary.narrative, lesson: primary.lesson, evidenceRefs: matchingPrimaryEvidence(primary.narrative, forensic), hypotheses: [{ code: primary.causeCode, claim: primary.narrative, evidenceFor: matchingPrimaryEvidence(primary.narrative, forensic), evidenceAgainst: [], missingEvidence: [forensic.limitation], status: "HYPOTHESIS", confidenceScore: null, nextTest: "Uji hipotesis pada seluruh trade se-strategi/mode dengan replay OOS; jangan ubah parameter dari satu trade." }] }
      : { agentId: primaryAgent.id, name: primaryAgent.name, role: primaryAgent.role, modelUsed: null, status: "FAILED", finding: "Review utama tidak lolos validasi atau provider tidak tersedia.", lesson: null, evidenceRefs: [], hypotheses: [], failureCode: "PRIMARY_REVIEW_UNAVAILABLE" }));

    const secondary = Object.values(ALL_12_AGENTS).filter((candidate) => candidate.id !== primaryAgent.id && !reusable.has(candidate.id));
    const reviews = await mapConcurrent(secondary, 4, async (profile): Promise<AgentTradeReview> => {
      const task = AGENT_REVIEW_TASK[profile.id] ?? "Audit bukti trade dari sudut peranmu; katakan eksplisit jika bidangmu tidak punya data cukup.";
      const system = `Anda ${profile.name} (${profile.id}), ${profile.role}. ${TRADING_EVIDENCE_POLICY}
Tugas khusus: ${task}
Hanya simpulkan fakta dari daftar evidence ID yang diberikan. Pisahkan observasi dari dugaan. Tidak ada bukti tunggal yang membuktikan niat pasar (stop-hunt). Jangan mengarang angka, indikator, berita, funding, atau lintasan harga. Jangan menyarankan perubahan parameter dari satu trade. Arahkan ke uji lintas sampel, termasuk pembanding pasar pada jendela waktu yang sama bila relevan.
Jawab JSON saja: {"finding":"temuan spesifik trade","lesson":"langkah belajar spesifik","evidenceRefs":["id"],"hypotheses":[{"code":"...","claim":"...","evidenceFor":["id"],"evidenceAgainst":["id"],"missingEvidence":["..."],"status":"HYPOTHESIS|UNKNOWN","confidenceScore":0,"nextTest":"..."}]}. Confidence score adalah penilaian model yang tidak terkalibrasi, bukan probabilitas kejadian.`;
      const user = `Trade #${trade.id}; ${trade.symbol} ${trade.side} ${trade.mode}; strategy=${trade.strategyId ?? "UNKNOWN"}; outcome=${outcome}; entry=${trade.entryAvg}; exit=${trade.exitAvg}; netPnL=${trade.pnlUsd}; R=${trade.rMultiple}; fee=${trade.feeUsd}; holdMinutes=${trade.holdMinutes}; close=${trade.closeReason ?? "UNKNOWN"}; fundingVerified=${trade.fundingVerified === true}.\nEvidence facts: ${JSON.stringify(forensic.facts)}\nSource=${forensic.source}; interval=${forensic.interval}; coverage=${JSON.stringify(forensic.coverage)}.\nLimitations: ${forensic.limitation}`;
      // 29 Sep 2026: jatah lama (FAST 600 tok/16 dtk, REASON 800 tok/22 dtk) membuat
      // 10 dari 12 agen gagal (LLM_EMPTY_OR_TRUNCATED_RESPONSE / LLM_TIMEOUT) karena
      // model reasoning menghabiskan max_tokens sebelum menulis konten JSON.
      // Diukur langsung ke provider: FAST ~2700 completion token (36-56 dtk),
      // REASON ~2400 (13 dtk). Jatah dinaikkan; ambang validasi bukti tidak diubah.
      // Tambahan: satu retry terarah bila review gagal struktur/bukti, supaya agen
      // benar-benar "dipaksa" menulis finding+lesson+refs yang sah.
      const options = { maxTokens: profile.model === "REASON" ? 1600 : 3000, timeoutMs: profile.model === "REASON" ? 45_000 : 90_000 };
      let lastFailure = "INVALID_OR_UNCITED_REVIEW";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptSystem = attempt === 1 ? system
          : `${system}\n\nPENGINGAT RETRY: respons pertamamu tidak lolos validasi. WAJIB: finding >=35 karakter spesifik trade ini, lesson >=20 karakter berisi langkah uji, dan evidenceRefs HANYA ID yang persis tercantum di daftar "Evidence facts" (maks 12). Jangan menambah ID karangan.`;
        try {
          const response = profile.model === "REASON"
            ? await this.adapter.callReason(user, attemptSystem, options)
            : await this.adapter.callFast(user, attemptSystem, options);
          const parsed = extractJsonObject(response.content);
          const evidenceRefs = validateEvidenceRefs(parsed?.evidenceRefs, refs);
          if (parsed && typeof parsed.finding === "string" && parsed.finding.trim().length >= 35
            && typeof parsed.lesson === "string" && parsed.lesson.trim().length >= 20 && evidenceRefs?.length) {
            return {
              agentId: profile.id, name: profile.name, role: profile.role, modelUsed: response.model,
              status: "COMPLETED", finding: parsed.finding.trim().slice(0, 900), lesson: parsed.lesson.trim().slice(0, 500), evidenceRefs,
              hypotheses: validateHypotheses(parsed.hypotheses, refs),
            };
          }
        } catch (error) {
          lastFailure = safeLlmFailureCode(error);
        }
      }
      return failedAgentReview(profile.id, lastFailure);
    });
    result.push(...reviews);
    for (const profile of Object.values(ALL_12_AGENTS)) {
      if (profile.id !== primaryAgent.id && reusable.has(profile.id)) result.push(reusable.get(profile.id)!);
    }
    const sortedReviews = result.sort((a, b) => Object.keys(ALL_12_AGENTS).indexOf(a.agentId) - Object.keys(ALL_12_AGENTS).indexOf(b.agentId));
    const priorRoundtable = previous.roundtable as AgentRoundtable | undefined;
    const roundtable = priorRoundtable?.status === "COMPLETED" && validateEvidenceRefs(priorRoundtable.evidenceRefs, refs)?.length
      ? priorRoundtable
      : await this.synthesizeRoundtable(trade, forensic, sortedReviews, refs);
    return { reviews: sortedReviews, roundtable };
  }

  private async synthesizeRoundtable(trade: TradeForEvaluation, forensic: TradeForensicBundle, reviews: AgentTradeReview[], refs: Set<string>): Promise<AgentRoundtable> {
    const agent = ALL_12_AGENTS["backtest-auditor"];
    const completed = reviews.filter((review) => review.status === "COMPLETED");
    const user = `Roundtable trade #${trade.id} ${trade.symbol} ${trade.side} ${trade.mode}; strategy=${trade.strategyId ?? "UNKNOWN"}; netPnL=${trade.pnlUsd}; R=${trade.rMultiple}; outcome=${this.determineOutcome(trade)}.\nReview agen: ${JSON.stringify(completed.map(({ agentId, role, finding, lesson, evidenceRefs, hypotheses }) => ({ agentId, role, finding, lesson, evidenceRefs, hypotheses })))}\nEvidence: ${JSON.stringify(forensic.facts)}\nCoverage=${JSON.stringify(forensic.coverage)}; source=${forensic.source}; limitation=${forensic.limitation}`;
    const system = `Anda ${agent.name} sebagai moderator quant roundtable 12 agen. Bandingkan kesepakatan dan perbedaan; jumlah suara bukan probabilitas atau bukti sebab. Hanya gunakan evidence ID yang tersedia, tandai unknown, dan utamakan tes lintas sampel. Benchmark BTC/ETH/BTCDOM hanya konteks lintas pasar pada jendela trade, bukan fakta global universal atau sebab langsung. Jangan sarankan perubahan parameter dari satu trade. Jawab JSON: {"synthesis":"...","agreements":["..."],"disagreements":["..."],"commonTests":["..."],"evidenceRefs":["id"]}.`;
    // 29 Sep 2026: strings() versi lama all-or-nothing (satu butir cacat -> seluruh
    // sintesis dibuang), identik dengan bug validateEvidenceRefs yang membunuh 8/12
    // review agen. Kini disanitasi per-butir + satu retry terarah.
    const strings = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length >= 8).slice(0, 6).map((item) => item.trim().slice(0, 350))
      : null;
    let lastRoundtableFailure = "INVALID_OR_UNCITED_ROUNDTABLE";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptSystem = attempt === 1 ? system
        : `${system}\n\nPENGINGAT RETRY: sintesis pertamamu tidak lolos validasi. WAJIB: synthesis >=50 karakter, agreements >=1 butir, commonTests >=1 butir, disagreements boleh kosong, dan evidenceRefs HANYA ID dari daftar evidence yang diberikan (maks 12).`;
      try {
        const response = await this.adapter.callReason(user, attemptSystem, { maxTokens: 1600, timeoutMs: 45_000 });
        const parsed = extractJsonObject(response.content);
        const evidenceRefs = validateEvidenceRefs(parsed?.evidenceRefs, refs);
        const agreements = strings(parsed?.agreements);
        const disagreements = strings(parsed?.disagreements);
        const commonTests = strings(parsed?.commonTests);
        if (typeof parsed?.synthesis === "string" && parsed.synthesis.trim().length >= 50 && evidenceRefs?.length
          && agreements?.length && disagreements && commonTests?.length) {
          return { status: "COMPLETED", modelUsed: response.model, synthesis: parsed.synthesis.trim().slice(0, 1200), agreements, disagreements, commonTests, evidenceRefs };
        }
      } catch (error) {
        lastRoundtableFailure = safeLlmFailureCode(error);
      }
    }
    return { status: "FAILED", modelUsed: null, synthesis: "Roundtable gagal validasi struktur/bukti; review individual tetap terpisah dan bukan konsensus.", agreements: [], disagreements: [], commonTests: [], evidenceRefs: [], failureCode: lastRoundtableFailure };
  }

  /** Kompatibilitas: endpoint & loop lama memanggil nama ini (kini mengevaluasi semua outcome). */
  async evaluateLossTrade(tradeId: number): Promise<LearningEntryRow> {
    return this.evaluateTrade(tradeId);
  }
}

/** Refuse generic text even when the provider returned syntactically valid JSON. */
export function isTradeSpecificAnalysis(narrative: string, lesson: string, trade: TradeForEvaluation): boolean {
  const analysis = narrative.trim();
  const nextStep = lesson.trim();
  if (analysis.length < 60 || nextStep.length < 25) return false;
  if (!analysis.toUpperCase().includes(trade.symbol.toUpperCase())) return false;
  if (!analysis.toUpperCase().includes(trade.mode.toUpperCase())
    && !(trade.strategyId && analysis.toUpperCase().includes(trade.strategyId.toUpperCase()))) return false;
  const observedNumbers = (analysis.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
  const facts = [trade.entryAvg, trade.exitAvg, trade.pnlUsd, trade.rMultiple, trade.feeUsd,
    trade.holdMinutes, trade.riskUsd, trade.plannedSlPrice, trade.plannedTp1Price,
    trade.plannedTp2Price, trade.marginUsd, trade.leverage, trade.mfeR, trade.maeR]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0);
  const matchedFacts = facts.filter((fact) => observedNumbers.some((observed) =>
    Math.abs(observed - fact) <= Math.max(0.000001, Math.abs(fact) * 0.005)));
  if (new Set(matchedFacts.map((fact) => fact.toPrecision(5))).size < 2) return false;
  return nextStep.includes(`#${trade.id}`) || nextStep.toUpperCase().includes(trade.symbol.toUpperCase())
    || (trade.strategyId ? nextStep.toUpperCase().includes(trade.strategyId.toUpperCase()) : false);
}

/** Ambil objek JSON pertama dari teks (toleran terhadap fence/prosa di sekitarnya). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function hasCompleteAgentPanel(entry: Pick<LearningEntryRow, "proposal">): boolean {
  const panel = extractJsonObject(entry.proposal ?? "")?.agentPanel;
  if (!panel || typeof panel !== "object") return false;
  const value = panel as Record<string, unknown>;
  const reviews = Array.isArray(value.reviews) ? value.reviews as Array<{ status?: unknown }> : [];
  const roundtable = value.roundtable as { status?: unknown } | undefined;
  return value.schemaVersion === 1 && value.expectedAgents === Object.keys(ALL_12_AGENTS).length
    && reviews.length === Object.keys(ALL_12_AGENTS).length
    && reviews.every((review) => review.status === "COMPLETED")
    && roundtable?.status === "COMPLETED";
}

/** Continue through historical rows while failed provider calls cool down. */
export function shouldRetryAgentPanel(entry: Pick<LearningEntryRow, "proposal">, now = Date.now(), retryAfterMs = 15 * 60_000): boolean {
  if (hasCompleteAgentPanel(entry)) return false;
  const panel = extractJsonObject(entry.proposal ?? "")?.agentPanel;
  if (!panel || typeof panel !== "object") return true;
  const lastAttemptAt = (panel as Record<string, unknown>).lastAttemptAt;
  if (typeof lastAttemptAt !== "string") return true;
  const timestamp = Date.parse(lastAttemptAt);
  return !Number.isFinite(timestamp) || now - timestamp >= retryAfterMs;
}

/** Reject legacy endpoint-derived accounting and keep paper observations explicit. */
export function isTradeLearningEligible(trade: TradeForEvaluation): boolean {
  if (!trade.source || trade.source === "DEMO" || !["VERIFIED", "SIMULATED"].includes(trade.accountingQuality ?? "")) return false;
  if (trade.accountingQuality === "SIMULATED" && !["PAPER_AI", "PAPER_MANUAL"].includes(trade.source)) return false;
  return [trade.entryAvg, trade.exitAvg, trade.riskUsd].every((v) => Number.isFinite(v) && v > 0)
    && [trade.pnlUsd, trade.rMultiple, trade.feeUsd].every(Number.isFinite) && trade.feeUsd >= 0;
}

type LearningWithTrade = LearningEntryRow & { trade: TradeForEvaluation | null };
export function selectEligibleLessons(rows: LearningWithTrade[], symbol: string, take = 3, decisionTime = new Date()) {
  const cutoff = decisionTime.getTime();
  const seenTrades = new Set<number>();
  return rows.filter((row) => {
    const trade = row.trade;
    if (!trade || !row.tradeId || trade.symbol.toUpperCase() !== symbol.toUpperCase() || !isTradeLearningEligible(trade)) return false;
    if (!(new Date(row.createdAt).getTime() <= cutoff) || !trade.createdAt || !(new Date(trade.createdAt).getTime() <= cutoff)) return false;
    const evidence = extractJsonObject(row.proposal ?? "");
    return evidence?.evidenceVersion === 2 && evidence.generationSource === "LLM" && evidence.tradeId === trade.id && evidence.accountingQuality === trade.accountingQuality && typeof row.lesson === "string" && row.lesson.length > 0;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).filter((row) => {
    if (seenTrades.has(row.tradeId!)) return false;
    seenTrades.add(row.tradeId!);
    return true;
  }).slice(0, Math.max(0, Math.min(10, take))).map((row) => ({
    causeCode: row.causeCode, outcome: row.outcome, lesson: row.lesson,
    narrative: row.narrative, createdAt: row.createdAt, symbol: row.trade!.symbol.toUpperCase(),
  }));
}

/** Preserve old rows in storage while showing at most one journal card per trade. */
export function dedupeLearningEntries<T extends Pick<LearningEntryRow, "tradeId" | "proposal">>(rows: T[]): T[] {
  const selected = new Map<number, T>();
  for (const row of rows) {
    if (row.tradeId === null) continue;
    const current = selected.get(row.tradeId);
    if (!current || (extractJsonObject(row.proposal ?? "")?.generationSource === "LLM" && extractJsonObject(current.proposal ?? "")?.generationSource !== "LLM")) {
      selected.set(row.tradeId, row);
    }
  }
  return rows.filter((row) => row.tradeId === null || selected.get(row.tradeId) === row);
}

export const prismaLearningRepo: LearningRepo = {
  async findLearningByTradeId(id: number): Promise<LearningEntryRow | null> {
    return await db.learningEntry.findFirst({ where: { tradeId: id }, orderBy: { id: "desc" } }) as LearningEntryRow | null;
  },
  async findTradeById(id: number): Promise<TradeForEvaluation | null> {
    const row = await db.trade.findUnique({
      where: { id },
      include: { position: true },
    });
    if (!row) return null;
    const pos = row.position as unknown as {
      closeReason?: string | null;
      beMoved?: boolean;
      tp1FilledAt?: Date | null;
      strategyId?: string | null;
      originalSlPrice?: number | null;
      slPrice?: number;
      tp1Price?: number;
      tp2Price?: number;
      zoneType?: string | null;
      zoneTop?: number | null;
      zoneBottom?: number | null;
      entryType?: string | null;
      leverage?: number;
      marginUsd?: number;
      openedAt?: Date | null;
      closedAt?: Date | null;
      maePrice?: number | null;
      mfePrice?: number | null;
    } | null;
    return {
      ...(row as unknown as TradeForEvaluation),
      strategyId: row.strategyId ?? pos?.strategyId ?? null,
      closeReason: pos?.closeReason ?? null,
      beMoved: Boolean(pos?.beMoved),
      tp1Filled: Boolean(pos?.tp1FilledAt),
      plannedSlPrice: pos?.originalSlPrice ?? pos?.slPrice ?? null,
      executedSlPrice: pos?.slPrice ?? null,
      authorizedBreakeven: usesSwingRr23({ mode: row.mode, source: row.source, entryAttrs: row.entryAttrs }) && Boolean(pos?.tp1FilledAt),
      plannedTp1Price: pos?.tp1Price ?? null,
      plannedTp2Price: pos?.tp2Price ?? null,
      zoneType: pos?.zoneType ?? null,
      zoneTop: pos?.zoneTop ?? null,
      zoneBottom: pos?.zoneBottom ?? null,
      entryType: pos?.entryType ?? null,
      leverage: pos?.leverage ?? null,
      marginUsd: pos?.marginUsd ?? null,
      openedAt: pos?.openedAt ?? null,
      closedAt: pos?.closedAt ?? null,
      maePrice: pos?.maePrice ?? null,
      mfePrice: pos?.mfePrice ?? null,
    };
  },

  async createLearningEntry(data: Omit<LearningEntryRow, "id">): Promise<LearningEntryRow> {
    const row = await db.learningEntry.create({
      data: {
        tradeId: data.tradeId,
        causeCode: data.causeCode,
        outcome: data.outcome,
        narrative: data.narrative,
        lesson: data.lesson,
        agentId: data.agentId,
                proposal: data.proposal,
                executionMistake: data.executionMistake,
                isExecutionMistake: data.isExecutionMistake,
                planDeviationRatio: data.planDeviationRatio,
                mistakeNotes: data.mistakeNotes,
                createdAt: data.createdAt,
      },
    });
    return row as unknown as LearningEntryRow;
  },

  async updateLearningEntry(id, data) {
    await db.learningEntry.update({ where: { id }, data });
  },

  async findAllLearnings(causeCode?: string): Promise<Array<LearningEntryRow & { trade?: TradeForEvaluation }>> {
    const rows = await db.learningEntry.findMany({
      where: causeCode ? { causeCode } : undefined,
      include: { trade: true },
      orderBy: { createdAt: "desc" },
    });
    return rows as unknown as Array<LearningEntryRow & { trade?: TradeForEvaluation }>;
  },

  async findPriorSymbolTrades(symbol: string, tradeId: number) {
    const rows = await db.trade.findMany({
      where: { symbol, id: { lt: tradeId } },
      include: { position: true },
      orderBy: { id: "desc" },
      take: 5,
    });
    return rows.reverse().map((r) => {
      const pos = r.position as unknown as { closedAt?: Date | null; closeReason?: string | null; openedAt?: Date | null } | null;
      return { closedAt: pos?.closedAt ?? null, closeReason: pos?.closeReason ?? null, win: r.win, openedAt: pos?.openedAt ?? null };
    });
  },

  async findRecentLessons(symbol: string, take = 3, decisionTime = new Date()) {
    const rows = await db.learningEntry.findMany({
      where: { tradeId: { not: null }, createdAt: { lte: decisionTime }, proposal: { contains: '"generationSource":"LLM"' }, trade: { is: { symbol: symbol.toUpperCase() } } },
      include: { trade: true },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    return selectEligibleLessons(rows as unknown as LearningWithTrade[], symbol, take, decisionTime);
  },

  async logEvent(type: string, severity: string, payload: Record<string, unknown>): Promise<void> {
    await db.eventLog.create({
      data: {
        type,
        severity,
        payload: JSON.stringify(payload),
      },
    });
  },
};

export const defaultPostMortemEvaluator = new PostMortemEvaluator();
