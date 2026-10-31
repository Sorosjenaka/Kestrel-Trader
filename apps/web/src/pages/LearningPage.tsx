// apps/web/src/pages/LearningPage.tsx - Halaman Learning Journal (FR-27, FR-34, US-11).
// Tahap 3 redesign Tema B "X / ink": chip filter mono, KPI probabilitas, empty big,
// badge seragam. Data binding, endpoint, polling, dan isi entri TIDAK diubah.
import React, { useEffect, useState } from "react";
import { colors, fonts, card } from "../theme.js";
import { Panel, Badge, PageHead } from "../components/ui.js";
import { noDashText } from "../lib/textDash.js";

interface TradeInfo {
  id: number;
  symbol: string;
  mode: string;
  side: string;
  entryAvg: number;
  exitAvg: number;
  pnlUsd: number;
  rMultiple: number;
  holdMinutes: number;
}

interface LearningEntry {
  id: number;
  tradeId: number | null;
  causeCode: string;
  outcome: string;
  narrative: string;
  lesson: string | null;
  agentId: string;
  proposal: string | null;
  createdAt: string;
  trade?: TradeInfo;
}

interface AgentReviewUi {
  agentId: string;
  name: string;
  role: string;
  modelUsed: string | null;
  status: "COMPLETED" | "FAILED";
  finding: string;
  lesson: string | null;
  evidenceRefs: string[];
  hypotheses?: Array<{ code: string; claim: string; status: string; nextTest: string }>;
  failureCode?: string;
}

interface ForensicUi {
  source: string;
  interval: string;
  limitation: string;
  facts?: Array<{ id: string; value: string | number | boolean | null; status: string; method: string }>;
  coverage?: Record<string, { expectedBars: number; receivedBars: number; complete: boolean }>;
}

/**
 * 29 Okt 2026 (fix) — entri learning yang sudah tersimpan di DB sebelum
 * perbaikan server bisa punya fakta dengan id DUPLIKAT (mis. dua fakta
 * "coverage.BTCUSDT" saat simbol trade = BTCUSDT dan BTCUSDT juga benchmark).
 * React sempat melempar "two children with the same key". Server sudah
 * dedup sekarang, tapi data lama tetap ada → filter di sisi klien.
 * Fakta pertama (yang sama nilainya) yang dipertahankan.
 */
function dedupeFacts<T extends { id: string }>(facts: T[]): T[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

interface ObservedProbability {
  sampleCount: number;
  observedWinRatePct: number | null;
  wilson95Pct: { lowerPct: number; upperPct: number } | null;
  breakEvenWinRatePct: number | null;
  netPnlUsd: number;
  predictiveWinProbabilityPct: null;
  outOfSampleValidated: false;
  minimumEvaluationSamples: number;
}

interface ProbabilityReport {
  all: ObservedProbability;
  scalp: ObservedProbability;
}

interface LlmStatus {
  provider: string;
  modelReason: string;
  modelReasonFallbacks: string[];
  reasoningEffortRequested: string;
  lastModelSwitch: string;
  totalCalls: number;
  fallbackCalls: number;
  lastSuccessModel: string;
  modelSwitchCount: number;
  lastFailureReason: string;
  lastSuccessAt: number;
  lastFallbackAt: number;
}

const CAUSE_CODES = [
  "ALL",
  "CHOP_ENTRY",
  "SL_TIGHT",
  "STOP_HUNT",
  "FAKEOUT_TRAP",
  "GIVEBACK",
  "MACRO_FLIP",
  "FEE_DRAG",
  "TP1_DISCIPLINE",
  "OTHER",
] as const;

// 30 Sep 2026: TP2/BE/TIMEOUT dihapus. WIN_TP2/BE hanya dipertahankan sebagai
// label legacy pada data lama; tidak ada trade baru yang memakai outcome ini.
const OUTCOME_FILTERS = ["ALL", "LOSS_SL", "LOSS_TREND_FLIP", "LOSS_OTHER", "LOSS", "WIN_TP1", "WIN_OTHER", "WIN", "UNKNOWN"] as const;

// Label kecil mono uppercase (gaya tema B: 9.5px, tracking lebar).
const microLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 9.5,
  fontWeight: 500,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: colors.textDim,
};

// Badge netral tanpa rgba hardcode: warna netral dari token tema B.
const NEUTRAL_BG = colors.bgInput;

function outcomeStyle(outcome: string): { bg: string; fg: string; label: string } {
  if (outcome === "WIN_TP2") return { bg: colors.sandBg, fg: colors.sand, label: "WIN TP2 (legacy)" };
  if (outcome === "WIN_TP1") return { bg: colors.upBg, fg: colors.up, label: "WIN TP" };
  if (outcome === "BE") return { bg: colors.warnBg, fg: colors.warn, label: "BREAKEVEN (legacy)" };
  if (outcome === "WIN_OTHER" || outcome === "WIN") return { bg: colors.upBg, fg: colors.up, label: "WIN" };
  if (outcome.startsWith("LOSS")) return { bg: colors.downBg, fg: colors.down, label: outcome.replace("_", " ") };
  return { bg: NEUTRAL_BG, fg: colors.textMuted, label: outcome };
}

// Chip filter gaya tema B: aktif = border cyan + teks cyan, non-aktif = hairline netral.
function FilterChip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 9px",
        background: "transparent",
        color: active ? colors.up : colors.textMuted,
        border: `1px solid ${active ? colors.up : colors.border}`,
        borderRadius: 2,
        cursor: "pointer",
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        fontFamily: fonts.mono,
      }}
    >
      {children}
    </button>
  );
}

// Baris KPI mono: label kecil uppercase di kiri, nilai mono di kanan.
function KpiRow({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "4px 0", borderTop: `1px solid ${colors.border}` }}>
      <span style={microLabel}>{label}</span>
      <span style={{ fontFamily: fonts.mono, fontSize: 11.5, color: valueColor ?? colors.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{value}</span>
    </div>
  );
}

export function LearningPage() {
  const [learnings, setLearnings] = useState<LearningEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [probability, setProbability] = useState<ProbabilityReport | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("ALL");
  const [selectedOutcome, setSelectedOutcome] = useState<string>("ALL");
  const [loading, setLoading] = useState(true);

  // 25 Okt 2026 — server memaginasi /api/learning (default 200 baris).
  // "Muat lebih" mengambil halaman berikutnya dan menumpuknya ke daftar.
  const PAGE_SIZE = 200;

  const fetchLearnings = async (code = selectedFilter, outcome = selectedOutcome, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (code !== "ALL") params.set("causeCode", code);
      if (outcome !== "ALL") params.set("outcome", outcome);
      params.set("limit", String(PAGE_SIZE));
      if (append) params.set("offset", String(learnings.length));
      const qs = params.toString();
      const res = await fetch(qs ? `/api/learning?${qs}` : "/api/learning");
      if (res.ok) {
        const json = await res.json();
        const rows: LearningEntry[] = json.learnings || [];
        setLearnings((prev) => (append ? [...prev, ...rows] : rows));
        if (typeof json.total === "number") setTotal(json.total);
      }
    } catch (e) {
      console.error("Gagal mengambil data learning", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLearnings(selectedFilter, selectedOutcome);
  }, [selectedFilter, selectedOutcome]);
  useEffect(() => {
    fetch("/api/learning/probability")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setProbability(data))
      .catch(() => setProbability(null));
  }, []);
  useEffect(() => {
    const refresh = () => fetch("/api/llm/status")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setLlmStatus(data?.status ?? null))
      .catch(() => setLlmStatus(null));
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, []);

  const llmDegraded = llmStatus ? llmStatus.lastFallbackAt > llmStatus.lastSuccessAt : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        eyebrow="RESEARCH / LEARNING"
        title="Jurnal Pembelajaran"
        desc="Bedah kasus trade arsip · aturan baru diusulkan, tidak diterapkan otomatis · entri berasal dari LLM, fallback otomatis, atau arsip lama yang asalnya belum tercatat · ini bukan pelatihan ulang bobot LLM."
      />

      {llmStatus && (
        <div
          style={{
            ...card,
            borderLeft: `3px solid ${llmDegraded ? colors.warn : colors.up}`,
            padding: "10px 14px",
            fontSize: 12,
            color: colors.text,
            lineHeight: 1.6,
          }}
        >
          <span style={{ fontFamily: fonts.mono, fontWeight: 700, color: colors.textStrong }}>LLM {llmStatus.provider}</span>{" "}
          <Badge bg={llmDegraded ? colors.warnBg : colors.upBg} fg={llmDegraded ? colors.warn : colors.up}>
            {llmDegraded ? "DEGRADED" : "OK"}
          </Badge>{" "}
          · {llmStatus.totalCalls} respons berhasil, {llmStatus.fallbackCalls} panggilan gagal sejak server menyala.
          {llmStatus.modelReason ? ` Model REASON: ${llmStatus.modelReason}; fallback: ${llmStatus.modelReasonFallbacks.join(" → ") || "tidak diatur"}; intent reasoning: ${llmStatus.reasoningEffortRequested}.` : ""}
          {llmStatus.lastSuccessModel ? ` Model respons terakhir: ${llmStatus.lastSuccessModel}.` : ""}
          {llmStatus.modelSwitchCount > 0 ? ` Beralih model ${llmStatus.modelSwitchCount} kali; rute terakhir: ${llmStatus.lastModelSwitch || "tidak tercatat"}.` : ""}
          {llmStatus.reasoningEffortRequested !== "provider-default" ? " Effort adalah permintaan; provider/model dapat menyesuaikan atau mengabaikannya." : ""}
          {llmDegraded && llmStatus.lastFailureReason ? ` Kegagalan terakhir: ${llmStatus.lastFailureReason}.` : ""}
        </div>
      )}

      {probability && (
        <Panel
          title="PROBABILITAS TERAMATI"
          extra={<span style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: colors.textDim }}>ARSIP RISET · HISTORIS BUKAN PREDIKSI</span>}
        >
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, lineHeight: 1.6 }}>
            Frekuensi win historis, bukan peluang win trade berikutnya. Interval Wilson 95% hanya gambaran ketidakpastian sampel; model belum tervalidasi out-of-sample. Target evaluasi minimal 500 trade per mode.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            {([["GABUNGAN", probability.all], ["SCALP (RIWAYAT LAMA)", probability.scalp]] as const).map(([label, p]) => (
              <div key={label} style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, borderRadius: 2, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, paddingBottom: 8 }}>
                  <span style={{ ...microLabel, color: colors.textMuted, fontWeight: 600 }}>{label}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.textDim }}>n = {p.sampleCount} trade</span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, paddingBottom: 8 }}>
                  <span style={{ fontFamily: fonts.mono, fontSize: 22, fontWeight: 400, color: colors.textStrong, fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>
                    {p.observedWinRatePct != null ? `${p.observedWinRatePct.toFixed(1)}%` : "·"}
                  </span>
                  <span style={microLabel}>win historis</span>
                </div>
                <KpiRow
                  label="Rentang 95%"
                  value={p.wilson95Pct ? `${p.wilson95Pct.lowerPct.toFixed(1)}% · ${p.wilson95Pct.upperPct.toFixed(1)}%` : "·"}
                />
                <KpiRow label="Impas sesuai payoff" value={p.breakEvenWinRatePct != null ? `${p.breakEvenWinRatePct.toFixed(1)}%` : "·"} />
                <KpiRow label="Net PnL" value={`$${p.netPnlUsd.toFixed(2)}`} valueColor={p.netPnlUsd >= 0 ? colors.up : colors.down} />
                <KpiRow label="Prediksi valid" value="belum ada" valueColor={colors.warn} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Outcome Filter Buttons */}
      <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
        <span style={microLabel}>Filter hasil</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {OUTCOME_FILTERS.map((code) => (
            <FilterChip key={code} active={selectedOutcome === code} onClick={() => setSelectedOutcome(code)}>
              {code === "ALL" ? "SEMUA HASIL" : code.replace("_", " ")}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Cause Code Filter Buttons */}
      <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
        <span style={microLabel}>Kode penyebab</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CAUSE_CODES.map((code) => (
            <FilterChip key={code} active={selectedFilter === code} onClick={() => setSelectedFilter(code)}>
              {code}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Entries List */}
      {loading ? (
        <div style={{ padding: "18px 2px", fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: colors.textDim }}>
          Memuat jurnal pembelajaran...
        </div>
      ) : learnings.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${colors.borderLight}`,
            borderRadius: 2,
            background: colors.bgPanel,
            padding: "56px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontFamily: fonts.disp, fontSize: 24, color: colors.textStrong, marginBottom: 8 }}>Belum Ada Evaluasi</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, lineHeight: 1.6 }}>
            Evaluasi trade arsip akan muncul setelah siklus pembelajaran selesai; loss dan profit sama-sama dicatat.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {learnings.map((entry) => {
            let proposalObj: Record<string, unknown> | null = null;
            if (entry.proposal) {
              try { proposalObj = JSON.parse(entry.proposal); } catch { /* ignore */ }
            }
            const oc = outcomeStyle(entry.outcome || "UNKNOWN");
            const isWin = (entry.outcome || "").startsWith("WIN") || entry.outcome === "BE";
            const legacyFallback = entry.narrative.startsWith("Observasi ") && entry.narrative.endsWith("Penyebab kausal belum terverifikasi.");
            const generationSource = proposalObj?.generationSource === "LLM" ? "LLM"
              : proposalObj?.generationSource === "DETERMINISTIC_FALLBACK" || legacyFallback ? "FALLBACK" : "UNVERIFIED";
            const panel = proposalObj?.agentPanel && typeof proposalObj.agentPanel === "object" ? proposalObj.agentPanel as Record<string, unknown> : null;
            const agentReviews = Array.isArray(panel?.reviews) ? panel.reviews as AgentReviewUi[] : [];
            const roundtable = panel?.roundtable && typeof panel.roundtable === "object" ? panel.roundtable as Record<string, unknown> : null;
            const forensic = proposalObj?.forensic && typeof proposalObj.forensic === "object" ? proposalObj.forensic as ForensicUi : null;

            return (
              <div key={entry.id} style={{ ...card, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: colors.textStrong, fontFamily: fonts.mono }}>
                      #{entry.tradeId ?? "?"} {entry.trade ? `${entry.trade.symbol} (${entry.trade.mode} ${entry.trade.side})` : entry.tradeId ? `Trade #${entry.tradeId}` : "Pelajaran umum"}
                    </span>
                    <Badge bg={oc.bg} fg={oc.fg}>{oc.label}</Badge>
                    <Badge bg={NEUTRAL_BG} fg={colors.textMuted}>{entry.causeCode}</Badge>
                    <Badge
                      bg={generationSource === "LLM" ? colors.upBg : generationSource === "FALLBACK" ? colors.warnBg : NEUTRAL_BG}
                      fg={generationSource === "LLM" ? colors.up : generationSource === "FALLBACK" ? colors.warn : colors.textMuted}
                    >
                      {generationSource === "LLM" ? "ANALISIS LLM" : generationSource === "FALLBACK" ? "TEMPLATE FALLBACK" : "ASAL BELUM TERCATAT"}
                    </Badge>
                    {generationSource === "LLM" && typeof proposalObj?.model === "string" && (
                      <span style={{ fontSize: 9.5, color: colors.up, fontFamily: fonts.mono, letterSpacing: "0.1em" }}>{proposalObj.model}</span>
                    )}
                  </div>

                  <div style={{ fontSize: 10, color: colors.textDim, fontFamily: fonts.mono, letterSpacing: "0.1em", whiteSpace: "nowrap" }}>
                    {new Date(entry.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB
                  </div>
                </div>

                {entry.trade && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, borderTop: `1px solid ${colors.border}`, borderBottom: `1px solid ${colors.border}`, padding: "9px 0", marginBottom: 12 }}>
                    <div>
                      <div style={microLabel}>Entry &rarr; Exit</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text }}>${entry.trade.entryAvg} &rarr; ${entry.trade.exitAvg}</div>
                    </div>
                    <div>
                      <div style={microLabel}>PnL</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 12, color: isWin ? colors.up : colors.down, fontWeight: 700 }}>
                        ${entry.trade.pnlUsd} ({entry.trade.rMultiple}R)
                      </div>
                    </div>
                    <div>
                      <div style={microLabel}>Hold</div>
                      <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text }}>{entry.trade.holdMinutes} mnt</div>
                    </div>
                  </div>
                )}

                {/* Narrative by Sesha */}
                <div
                  style={{
                    background: isWin ? colors.upBg : colors.downBg,
                    padding: 12,
                    borderRadius: 2,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: colors.text,
                    borderLeft: `3px solid ${isWin ? colors.up : colors.down}`,
                    marginBottom: 10,
                  }}
                >
                  <div style={{ ...microLabel, color: isWin ? colors.up : colors.down, marginBottom: 4, fontWeight: 600 }}>
                    {generationSource === "LLM" ? `BEDAH ${isWin ? "KEMENANGAN" : "POST-MORTEM"} OLEH LLM` : generationSource === "FALLBACK" ? "CATATAN OTOMATIS TANPA LLM" : "ARSIP EVALUASI LAMA"} ({(entry.agentId || "post-mortem").toUpperCase()}):
                  </div>
                  "{noDashText(entry.narrative)}"
                </div>

                {/* Hanya pelajaran LLM yang lolos syarat bukti dapat diambil oleh judge. */}
                {entry.lesson && (
                  <div style={{ background: colors.sandBg, border: `1px solid ${colors.sand}`, padding: "8px 12px", borderRadius: 2, fontSize: 12, color: colors.text, marginBottom: 10 }}>
                    <strong style={{ color: colors.sand, fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: "0.1em" }}>
                      {generationSource === "LLM" ? "HIPOTESIS LLM (konteks Arka saat LLM aktif):" : "CATATAN ARSIP (tidak dipakai untuk entry):"}
                    </strong>{" "}
                    {noDashText(entry.lesson)}
                  </div>
                )}

                {forensic && (
                  <details style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: "9px 12px", borderRadius: 2, marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer", color: colors.up, fontFamily: fonts.mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.12em" }}>
                      BUKTI PRICE-PATH &amp; BENCHMARK · {forensic.source} / {forensic.interval}
                    </summary>
                    <p style={{ fontSize: 10, color: colors.textMuted, lineHeight: 1.45 }}>{forensic.limitation}</p>
                    {forensic.coverage && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                        {Object.entries(forensic.coverage).map(([symbol, coverage]) => (
                          <span key={symbol} style={{ padding: "3px 7px", borderRadius: 2, background: coverage.complete ? colors.upBg : colors.warnBg, color: coverage.complete ? colors.up : colors.warn, fontSize: 10, fontFamily: fonts.mono, letterSpacing: "0.08em" }}>
                            {symbol}: {coverage.receivedBars}/{coverage.expectedBars} candle{coverage.complete ? " lengkap" : " tidak lengkap"}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 5 }}>
                      {dedupeFacts(forensic.facts ?? []).map((fact) => (
                        <div key={fact.id} title={fact.method} style={{ background: colors.bg, padding: "5px 7px", borderRadius: 2, fontSize: 10, color: colors.text, fontFamily: fonts.mono }}>
                          <code style={{ color: colors.sand }}>{fact.id}</code>: {fact.value === null ? "UNKNOWN" : String(fact.value)} <span style={{ color: colors.textDim }}>({fact.status})</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {agentReviews.length > 0 && (
                  <details style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: "9px 12px", borderRadius: 2, marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer", color: colors.warn, fontFamily: fonts.mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.12em" }}>
                      REVIEW SEMUA AGEN: {String(panel?.completedAgents ?? 0)}/{String(panel?.expectedAgents ?? 12)} selesai
                    </summary>
                    <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
                      {roundtable && (
                        <div
                          style={{
                            background: roundtable.status === "COMPLETED" ? colors.upBg : colors.warnBg,
                            border: `1px solid ${roundtable.status === "COMPLETED" ? colors.up : colors.warn}`,
                            padding: "10px 12px",
                            borderRadius: 2,
                          }}
                        >
                          <strong style={{ color: roundtable.status === "COMPLETED" ? colors.up : colors.warn, fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.12em" }}>
                            ROUNDTABLE QUANT · {String(roundtable.status)}{typeof roundtable.modelUsed === "string" ? ` · ${roundtable.modelUsed}` : ""}
                          </strong>
                          <div style={{ fontSize: 11, color: colors.text, lineHeight: 1.45, marginTop: 5 }}>{String(roundtable.synthesis ?? "")}</div>
                          {Array.isArray(roundtable.agreements) && roundtable.agreements.length > 0 && <div style={{ fontSize: 10, color: colors.up, marginTop: 5 }}>Kesamaan temuan: {(roundtable.agreements as string[]).join(" · ")}</div>}
                          {Array.isArray(roundtable.disagreements) && roundtable.disagreements.length > 0 && <div style={{ fontSize: 10, color: colors.down, marginTop: 5 }}>Perbedaan: {(roundtable.disagreements as string[]).join(" · ")}</div>}
                          {Array.isArray(roundtable.commonTests) && roundtable.commonTests.length > 0 && <div style={{ fontSize: 10, color: colors.up, marginTop: 5 }}>Tes berikut: {(roundtable.commonTests as string[]).join(" · ")}</div>}
                        </div>
                      )}
                      {agentReviews.map((review) => (
                        <div key={review.agentId} style={{ background: colors.bg, borderLeft: `3px solid ${review.status === "COMPLETED" ? colors.up : colors.down}`, padding: "8px 10px", borderRadius: 2 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10, marginBottom: 4, flexWrap: "wrap" }}>
                            <strong style={{ color: colors.sand, fontFamily: fonts.mono, fontWeight: 600, letterSpacing: "0.08em" }}>
                              {review.name} · {review.agentId} <span style={{ color: colors.textMuted, fontWeight: 400 }}>· {review.role}</span>
                            </strong>
                            <span style={{ color: review.status === "COMPLETED" ? colors.up : colors.down, fontFamily: fonts.mono }}>{review.modelUsed ?? review.failureCode ?? review.status}</span>
                          </div>
                          <div style={{ fontSize: 11, color: colors.text, lineHeight: 1.45 }}>{review.finding}</div>
                          {review.lesson && <div style={{ fontSize: 10, color: colors.warn, marginTop: 4 }}>Lesson: {review.lesson}</div>}
                          {review.evidenceRefs?.length > 0 && <div style={{ fontSize: 9.5, color: colors.up, marginTop: 4, fontFamily: fonts.mono, letterSpacing: "0.06em" }}>Rujukan fakta: {review.evidenceRefs.join(", ")}</div>}
                          {review.hypotheses?.map((hypothesis, index) => (
                            <div key={`${review.agentId}-${index}`} style={{ fontSize: 10, color: colors.warn, marginTop: 4 }}>
                              Hipotesis ({hypothesis.status}): {hypothesis.claim} · Uji: {hypothesis.nextTest}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <p style={{ fontSize: 9.5, color: colors.textDim, marginBottom: 0, lineHeight: 1.5 }}>
                      Panel ini menyimpan/retrieve lesson; tidak melatih ulang bobot model. Semua agen memakai bukti dasar yang sama, bukan 12 konfirmasi independen. Confidence tidak dikalibrasi; sitasi fakta tidak membuktikan sebab kausal. BTC/ETH/BTCDOM hanya konteks pembanding, bukan data global representatif.
                    </p>
                  </details>
                )}

                {/* Proposal Box */}
                {proposalObj && (
                  <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: "8px 12px", borderRadius: 2, fontSize: 11, color: colors.text }}>
                    <strong style={{ color: colors.warn, fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.12em" }}>LANGKAH EVALUASI BERIKUTNYA:</strong>{" "}
                    {noDashText(String(proposalObj.action || ""))} &bull; {noDashText(String(proposalObj.reason || ""))}
                  </div>
                )}
              </div>
            );
          })}
          {/* 25 Okt 2026 · pager: server membatasi 200 baris per request. */}
          {total != null && learnings.length < total && (
            <button
              type="button"
              onClick={() => fetchLearnings(selectedFilter, selectedOutcome, true)}
              disabled={loading}
              style={{
                padding: "9px 14px", borderRadius: 2, cursor: loading ? "wait" : "pointer",
                background: "transparent", border: `1px solid ${colors.borderLight}`,
                color: colors.textMuted, fontSize: 10, fontFamily: fonts.mono, fontWeight: 600,
                letterSpacing: "0.12em", textTransform: "uppercase",
              }}
            >
              {loading ? "MEMUAT..." : `MUAT LEBIH (${learnings.length} / ${total})`}
            </button>
          )}
          {total != null && (
            <div style={{ fontSize: 10, color: colors.textDim, fontFamily: fonts.mono, letterSpacing: "0.1em" }}>
              Menampilkan {learnings.length} dari {total} entri pembelajaran.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
