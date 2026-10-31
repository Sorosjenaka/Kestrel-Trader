import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/db.js", () => ({ db: {} }));
import { PostMortemEvaluator, dedupeLearningEntries, hasCompleteAgentPanel, shouldRetryAgentPanel, type LearningRepo, type TradeForEvaluation, type LearningEntryRow, isTradeLearningEligible, isTradeSpecificAnalysis, selectEligibleLessons } from "../src/learning/postMortemEvaluator.js";
import type { XkiroAdapter } from "../src/agents/llmAdapter.js";
const trade: TradeForEvaluation = { id: 1, positionId: 1, symbol: "BTCUSDT", mode: "SCALP", side: "LONG", riskUsd: 1, entryAvg: 100, exitAvg: 98, rMultiple: -1.05, pnlUsd: -1.05, feeUsd: .05, holdMinutes: 2, win: false, closeReason: "SL", source: "PAPER_AI", accountingQuality: "SIMULATED", fundingVerified: false, excursionsVerified: false, createdAt: new Date("2026-01-01") };
function fixture(value = trade, content = "", agentReviewContent = content, roundtableContent = content) {
 const entries: LearningEntryRow[] = [];
 const callReason = vi.fn(async (user = "") => ({ content: user.startsWith("Roundtable trade") ? roundtableContent : user.startsWith("Bedah trade") ? content : agentReviewContent, model: "test/reason" }));
 const repo: LearningRepo = {
  findTradeById: async () => value,
  findLearningByTradeId: async id => entries.find(e => e.tradeId === id) ?? null,
  createLearningEntry: async data => { const row = { ...data, id: entries.length + 1 }; entries.push(row); return row; },
  updateLearningEntry: async () => {},
  findAllLearnings: async () => entries,
  findRecentLessons: async () => [],
  logEvent: async () => {},
 };
 const callFast = vi.fn(async () => ({ content: agentReviewContent, model: "test/fast" }));
 return { evaluator: new PostMortemEvaluator({ adapter: { callReason, callFast } as unknown as XkiroAdapter, repo }), callReason, callFast, entries };
}
describe("Truthful post-mortem evidence", () => {
 it("loss after TP1 or an incorrect TP2/win flag remains LOSS", () => {
  const { evaluator } = fixture();
  expect(evaluator.determineOutcome({ ...trade, tp1Filled: true, beMoved: true })).toBe("LOSS_SL");
  expect(evaluator.determineOutcome({ ...trade, closeReason: "TP2", win: true })).toBe("LOSS_OTHER");
  expect(evaluator.determineOutcome({ ...trade, pnlUsd: -.001, closeReason: "BE" })).toBe("LOSS_OTHER");
 });
 it("net profit, not exit label, determines WIN and exact net zero BE", () => {
  const { evaluator } = fixture();
  expect(evaluator.determineOutcome({ ...trade, pnlUsd: .5, tp1Filled: true, closeReason: "BE" })).toBe("WIN_TP1");
  expect(evaluator.determineOutcome({ ...trade, pnlUsd: 0 })).toBe("BE");
  expect(evaluator.determineOutcome({ ...trade, pnlUsd: NaN })).toBe("UNKNOWN");
  expect(evaluator.determineOutcome({ ...trade, mode:"SWING", pnlUsd:2.5, closeReason:"TP2", authorizedBreakeven:true })).toBe("WIN_TP2");
 });
 it("does not infer stop-hunt/SL tight/fakeout from endpoint-derived MFE and loss", () => {
  expect(fixture().evaluator.determineHeuristicCause({ ...trade, mfeR: 2, maeR: -.1, excursionsVerified: false }).causeCode).toBe("LOSS_SL");
 });
 it("records all eligible outcomes, labels paper and unknown funding, and never auto-activates a proposal", async () => {
  for (const pnlUsd of [-1, 0, 1]) {
   const { evaluator } = fixture({ ...trade, pnlUsd });
   const entry = await evaluator.evaluateTrade(1);
   expect(entry.lesson).toContain("SIMULATED");
   expect(entry.lesson).toContain("funding unknown");
   expect(JSON.parse(entry.proposal!)).toMatchObject({ evidenceVersion: 2, parameterActivationAllowed: false, hypothesisOnly: true });
   expect(entry.narrative).toContain("belum terverifikasi");
   expect(JSON.parse(entry.proposal!).generationSource).toBe("DETERMINISTIC_FALLBACK");
  }
 });
 it("writes nineteen evidence-cited agent lessons plus a separately labeled quant roundtable", async () => {
  const primary = JSON.stringify({ causeCode: "LOSS_SL", narrative: "BTCUSDT SCALP entry 100 lalu exit 98, rugi -1.05R dan fee 0.05; lintasan penyebab belum terbukti.", lesson: "Periksa OHLC trade #1 BTCUSDT sebelum menguji SL.", proposalAction: "COLLECT_COMPARATIVE_EVIDENCE", proposalReason: "Uji OOS." });
  const reviewer = JSON.stringify({ finding: "trade.pnl_usd mencatat hasil net negatif pada observasi PAPER ini; bukti itu tidak memastikan penyebab teknis.", lesson: "Bandingkan candle dan hasil BTCUSDT pada trade #1 dengan trade se-strategi lain.", evidenceRefs: ["trade.pnl_usd"], hypotheses: [] });
  const roundtable = JSON.stringify({ synthesis: "Para agen sepakat angka hasil trade terlihat di jurnal, tetapi tidak satu pun angka itu membuktikan penyebab kausal tanpa lintasan harga yang terukur.", agreements: ["PnL adalah hasil observasi, bukan sebab"], disagreements: [], commonTests: ["Replay seluruh trade dengan data OHLC kronologis"] , evidenceRefs: ["trade.pnl_usd"] });
  const f = fixture(trade, primary, reviewer, roundtable);
  const entry = await f.evaluator.evaluateTrade(1);
  const panel = JSON.parse(entry.proposal!).agentPanel;
  expect(panel.reviews).toHaveLength(19);
  expect(panel.completedAgents).toBe(19);
  expect(panel.reviews.every((review: { status: string; evidenceRefs: string[] }) => review.status === "COMPLETED" && review.evidenceRefs.length > 0)).toBe(true);
  expect(panel.roundtable).toMatchObject({ status: "COMPLETED", modelUsed: "test/reason" });
  expect(hasCompleteAgentPanel(entry)).toBe(true);
  const calls = f.callReason.mock.calls.length + f.callFast.mock.calls.length;
  await f.evaluator.evaluateTrade(1);
  expect(f.callReason.mock.calls.length + f.callFast.mock.calls.length).toBe(calls);
 });
 it.each([{ source: "DEMO" }, { accountingQuality: "LEGACY" }, { accountingQuality: undefined }, { riskUsd: NaN }, { source: "LIVE_AI" }])("rejects ineligible evidence %j", async (invalid) => {
  const f = fixture({ ...trade, ...invalid });
  await expect(f.evaluator.evaluateTrade(1)).rejects.toThrow("INELIGIBLE_LEARNING_EVIDENCE");
  expect(f.callReason).not.toHaveBeenCalled();
 });
 it("rejects invented causal labels from model while retaining narrative as hypothesis", async () => {
  const f = fixture(trade, JSON.stringify({ causeCode: "STOP_HUNT", narrative: "BTCUSDT SCALP ditutup pada 98 dari entry 100; rugi -1.05R. Kemungkinan stop hunt belum terbukti tanpa data tape.", lesson: "Periksa tape BTCUSDT trade #1 sebelum menyimpulkan penyebab." }));
  const entry = await f.evaluator.evaluateTrade(1);
  expect(entry.causeCode).toBe("LOSS_SL");
  expect(entry.lesson).toContain("hipotesis");
  expect(JSON.parse(entry.proposal!).generationSource).toBe("LLM");
  expect(JSON.parse(entry.proposal!).model).toBe("test/reason");
 });
 it("mencatat error provider sebagai fallback, tanpa menyamar sebagai jawaban LLM", async () => {
  const f = fixture(trade);
  f.callReason.mockRejectedValueOnce(new Error("LLM_RESPONSE_UNAVAILABLE: LLM_HTTP_402"));
  const entry = await f.evaluator.evaluateTrade(1);
  expect(entry.narrative).toContain("Penyebab kausal belum terverifikasi");
  expect(JSON.parse(entry.proposal!)).toMatchObject({ generationSource: "DETERMINISTIC_FALLBACK", failureCode: "LLM_HTTP_402" });
 });
 it("respons LLM tanpa lesson valid tidak disimpan sebagai analisis LLM", async () => {
  const f = fixture(trade, JSON.stringify({ narrative: "Analisis tanpa pelajaran." }));
  const entry = await f.evaluator.evaluateTrade(1);
  expect(JSON.parse(entry.proposal!).generationSource).toBe("DETERMINISTIC_FALLBACK");
 });
 it("respons JSON generik tetap fallback walaupun memiliki narrative dan lesson", async () => {
  const f = fixture(trade, JSON.stringify({ narrative: "Trade ini rugi karena stop hunt dan perlu diperbaiki pada kesempatan berikutnya.", lesson: "Pelajari lagi kapan harus masuk pasar." }));
  const entry = await f.evaluator.evaluateTrade(1);
  expect(JSON.parse(entry.proposal!).generationSource).toBe("DETERMINISTIC_FALLBACK");
  expect(isTradeSpecificAnalysis("BTCUSDT SCALP entry 100 lalu exit 98, tetapi tape belum cukup untuk menyebut stop hunt.", "Periksa lintasan BTCUSDT trade #1 sebelum menyimpulkan.", trade)).toBe(true);
 });
 it("evaluasi serentak dan pengulangan pada trade yang sama hanya membuat satu jurnal", async () => {
   const primary = JSON.stringify({ causeCode: "LOSS_SL", narrative: "BTCUSDT SCALP keluar di 98 dari entry 100 saat SL; penyebab spesifik belum terverifikasi tanpa lintasan candle.", lesson: "Periksa lintasan candle BTCUSDT trade #1 sesudah entry." });
   const reviewer = JSON.stringify({ finding: "trade.pnl_usd mencatat hasil net negatif pada observasi PAPER ini; bukti itu tidak memastikan penyebab teknis.", lesson: "Bandingkan candle dan hasil BTCUSDT pada trade #1 dengan trade se-strategi lain.", evidenceRefs: ["trade.pnl_usd"], hypotheses: [] });
   const roundtable = JSON.stringify({ synthesis: "Para agen sepakat angka hasil trade terlihat di jurnal, tetapi tidak satu pun angka itu membuktikan penyebab kausal tanpa lintasan harga yang terukur.", agreements: ["PnL adalah hasil observasi, bukan sebab"], disagreements: [], commonTests: ["Replay seluruh trade dengan data OHLC kronologis"], evidenceRefs: ["trade.pnl_usd"] });
   const f = fixture(trade, primary, reviewer, roundtable);
   const rows = await Promise.all([f.evaluator.evaluateTrade(1), f.evaluator.evaluateTrade(1), f.evaluator.evaluateTrade(1)]);
   expect(rows.map(r => r.id)).toEqual([1, 1, 1]);
   expect(f.entries).toHaveLength(1);
   await f.evaluator.evaluateTrade(1);
   // Panel lengkap = 19 review agen (katalog 27 Okt 2026: +Mira +Sari/Tala/Giri
   // +Arya/Bayu/Ratih) + 1 roundtable = 20 panggilan LLM, terbagi callReason
   // (tier REASON) dan callFast (tier FAST). Retry tidak boleh menambah.
   // + 2 panggilan 5 Whys (perintah operator 11 Okt: 5 Whys untuk SETIAP SL/TP trade;
   // pada fixture ini lapisan berhenti di guardrail NON_CONVERGENT setelah 2 UNKNOWN).
   const callsAfterFirst = f.callReason.mock.calls.length + f.callFast.mock.calls.length;
   expect(callsAfterFirst).toBe(22);
   expect(f.callReason).toHaveBeenCalledTimes(10);
   expect(f.callFast).toHaveBeenCalledTimes(12);
   await f.evaluator.evaluateTrade(1);
   expect(f.callReason.mock.calls.length + f.callFast.mock.calls.length).toBe(22); // short-circuit
 });
 it("review agen yang gagal validasi diretry sekali sebelum dicatat FAILED", async () => {
   const primary = JSON.stringify({ causeCode: "LOSS_SL", narrative: "BTCUSDT SCALP keluar di 98 dari entry 100 saat SL; penyebab spesifik belum terverifikasi tanpa lintasan candle.", lesson: "Periksa lintasan candle BTCUSDT trade #1 sesudah entry." });
   const f = fixture(trade, primary); // reviewer content = bentuk primary -> bukan review yang sah
   await f.evaluator.evaluateTrade(1);
   const totalCalls = f.callReason.mock.calls.length + f.callFast.mock.calls.length;
   expect(totalCalls).toBeGreaterThan(20); // bukti retry terjadi (baseline tanpa retry = 20)
   const panel = JSON.parse(f.entries[0].proposal!).agentPanel;
   const secondaryFailed = panel.reviews.filter((r: { status: string; agentId: string }) => r.status === "FAILED" && r.agentId !== "post-mortem");
   expect(secondaryFailed).toHaveLength(18);
   expect(secondaryFailed.every((r: { failureCode?: string }) => r.failureCode === "INVALID_OR_UNCITED_REVIEW")).toBe(true);
 });
 it("requires successful agent reviews and a cited roundtable; retries respect provider cooldown", () => {
  const reviews = Array.from({ length: 19 }, (_, index) => ({ agentId: `agent-${index}`, status: "COMPLETED" }));
  const complete = { proposal: JSON.stringify({ agentPanel: { schemaVersion: 1, expectedAgents: 19, reviews, roundtable: { status: "COMPLETED" } } }) };
  const failed = { proposal: JSON.stringify({ agentPanel: { schemaVersion: 1, expectedAgents: 19, lastAttemptAt: new Date(1_000).toISOString(), reviews: reviews.map((r, index) => index === 4 ? { ...r, status: "FAILED" } : r), roundtable: { status: "FAILED" } } }) };
  expect(hasCompleteAgentPanel(complete)).toBe(true);
  expect(shouldRetryAgentPanel(complete, 100_000)).toBe(false);
  expect(shouldRetryAgentPanel({ proposal: null }, 100_000)).toBe(true);
  expect(shouldRetryAgentPanel(failed, 100_000)).toBe(false);
  expect(shouldRetryAgentPanel(failed, 1_000 + 15 * 60_000)).toBe(true);
 });
 it("retrieval excludes legacy, orphans, other-symbol contamination, future observations, and old untagged lessons", () => {
  const base: LearningEntryRow & { trade: TradeForEvaluation | null } = { id: 1, tradeId: 1, causeCode: "LOSS_SL", outcome: "LOSS_SL", narrative: "Observation", lesson: "Observed paper loss", agentId: "post-mortem", proposal: JSON.stringify({ evidenceVersion: 2, generationSource: "LLM", tradeId: 1, accountingQuality: "SIMULATED" }), createdAt: new Date("2026-01-02"), trade };
  const rows = [base,
   { ...base, id: 2, trade: null },
   { ...base, id: 3, trade: { ...trade, symbol: "ETHUSDT" } },
   { ...base, id: 4, proposal: "{}" },
   { ...base, id: 5, createdAt: new Date("2026-02-01") },
   { ...base, id: 6, trade: { ...trade, createdAt: new Date("2026-02-01") } },
   { ...base, id: 7, trade: { ...trade, accountingQuality: "LEGACY" } },
   { ...base, id: 8, proposal: JSON.stringify({ evidenceVersion: 2, generationSource: "DETERMINISTIC_FALLBACK", tradeId: 1, accountingQuality: "SIMULATED" }) },
   { ...base, id: 9 },
  ];
  expect(selectEligibleLessons(rows, "BTCUSDT", 10, new Date("2026-01-03"))).toHaveLength(1);
  expect(selectEligibleLessons(rows, "DOGEUSDT", 10, new Date("2026-01-03"))).toEqual([]);
  expect(isTradeLearningEligible({ ...trade, source: "LIVE_AI", accountingQuality: "VERIFIED" })).toBe(true);
 });
 it("API dapat merapikan kartu ganda tanpa menghapus entri historis", () => {
  const fallback = { tradeId: 1, proposal: JSON.stringify({ generationSource: "DETERMINISTIC_FALLBACK" }) };
  const llm = { tradeId: 1, proposal: JSON.stringify({ generationSource: "LLM" }) };
  const orphan = { tradeId: null, proposal: null };
  expect(dedupeLearningEntries([fallback, llm, orphan])).toEqual([llm, orphan]);
 });
});
