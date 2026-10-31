// apps/server/src/learning/swingDecisionFeatures.ts
// Big Brain 16 Okt 2026 — jembatan lane SWING ke DecisionLog (audit: tabel
// DecisionLog 0 baris karena satu-satunya call site logDecision hanya tercapai
// lewat runSetupJudge di jalur SCALP yang early-return saat
// SCALP_LANE_ENABLED=false). Opsi A: logDecision dipanggil langsung tanpa
// judge/LLM — nol perubahan perilaku trading, knn/drex jujur null.
//
// Pemetaan keputusan (4 situs fillSwingSlotsOnce):
//   ENTRY_OPENED   -> GO      + link positionId
//   ENTRY_REJECTED -> NO_GO   (kandidat terbentuk lalu ditolak = sampel negatif kalibrasi)
//   SKIP_ENTRY_GAP -> SKIPPED
//   SIGNAL_NO_PLAN -> SKIPPED (tidak ada plan = bukan veto atas setup)
import type { MtfAnalysis } from "../engines/multiTimeframeAnalyzer.js";
import type { Bar } from "../universe/eligibility.js";
import { calculateEfficiencyRatio } from "../engines/trendQuality.js";
import { buildVolumeProfile, distanceFromPocInBins } from "../engines/volumeProfile.js";
import type { DecisionFeatures } from "./decisionLog.js";

export type SwingDecision = "GO" | "NO_GO" | "SKIPPED";

/** Peta keputusan swing -> keputusan DecisionLog (dokumen Big Brain Tahap B). */
export function mapSwingDecisionToDecisionLog(
  swingDecision: "ENTRY_OPENED" | "ENTRY_REJECTED" | "SKIP_ENTRY_GAP" | "SIGNAL_NO_PLAN" | "SKIP_VOLUME_BELOW_MIN"
): SwingDecision {
  switch (swingDecision) {
    case "ENTRY_OPENED": return "GO";
    case "ENTRY_REJECTED": return "NO_GO";
    default: return "SKIPPED";
  }
}

/** Fitur keputusan SWING dari yang sudah tersedia di titik keputusan —
 *  TANPA fabrikasi: field yang tidak dihitung lane SWING tetap null. */
export function buildSwingDecisionFeatures(input: {
  symbol: string;
  side: "LONG" | "SHORT";
  strategyId: string | null;
  decision: SwingDecision;
  rejectReason?: string | null;
  analysis: MtfAnalysis;
  h1Bars: Bar[];
  price: number;
}): DecisionFeatures {
  const { analysis, h1Bars, price } = input;
  const finite = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const er = finite(calculateEfficiencyRatio(h1Bars));
  const pocDistanceBins = h1Bars.length > 0 && Number.isFinite(price) && price > 0
    ? finite(distanceFromPocInBins(buildVolumeProfile(h1Bars), price))
    : null;
  return {
    symbol: input.symbol,
    side: input.side,
    mode: "SWING",
    strategyId: input.strategyId,
    decision: input.decision,
    rejectReason: input.rejectReason ?? null,
    // knn/drex/oi/beta/macro/cooldown = null — lane SWING tidak menghitungnya
    // (jujur, tanpa fabrikasi; menjadi fitur Tahap C bila nanti dihitung).
    compositeScore: finite(analysis.compositeScore),
    trendScore: finite(analysis.trendScore),
    regime: analysis.bias?.regime ?? null,
    er,
    choppiness: finite(analysis.structure?.chop),
    adx: finite(analysis.structure?.adx),
    atrPct: finite(analysis.trigger?.atrPct),
    pocDistanceBins,
    oiChangePct: null,
    betaBtc: null,
    macroAllowed: null,
    cooldownAgeMs: null,
  };
}
