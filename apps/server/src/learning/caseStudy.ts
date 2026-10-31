// SMB T-08 (9 Okt 2026): bedah studi kasus teknis per trade — merender
// timeline beranotasi (entry/MAE/MFE/exit + level S/R + EMA9 + VWAP) dari
// bundle forensik ke markdown/teks. 100% berbasis data TS; tanpa halusinasi:
// angka hanya dari bundle, bagian yang tidak terukur ditulis UNKNOWN/n-a.
// Dipakai CLI tools/export-case-study.ts (read-only terhadap jurnal).
import type { TradeForensicBundle, AnnotatedTimelinePoint, EvidenceFact } from "./tradeForensics.js";

export interface CaseStudyTradeHeader {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  strategyId?: string | null;
  entryAvg: number;
  exitAvg: number;
  pnlUsd: number;
  rMultiple: number;
  feeUsd: number;
  holdMinutes: number;
  closeReason?: string | null;
  plannedSlPrice?: number | null;
  plannedTp1Price?: number | null;
  executionMistake?: string;
  causeCode?: string;
}

const fmtPrice = (v: number | null | undefined, digits = 6) =>
  typeof v === "number" && Number.isFinite(v) ? v.toPrecision(digits) : "n/a";
const fmtTime = (ms: number | null | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "n/a";

function pointLine(p: AnnotatedTimelinePoint): string {
  if (p.status === "UNKNOWN") return `- ${p.label} [UNKNOWN] ${p.note ?? "bar tidak dapat dilokalisasi dari data yang tersedia"}`;
  const ema = typeof p.ema9 === "number" ? p.ema9.toPrecision(6) : "n/a";
  const vwap = typeof p.vwap === "number" ? p.vwap.toPrecision(6) : "n/a";
  const dEma = typeof p.distEma9Pct === "number" ? `${p.distEma9Pct.toFixed(3)}%` : "n/a";
  const dVwap = typeof p.distVwapPct === "number" ? `${p.distVwapPct.toFixed(3)}%` : "n/a";
  return `- ${p.label} t=${fmtTime(p.openTime)} close=${fmtPrice(p.close)} | EMA9=${ema} (jarak ${dEma}) | VWAP(UTC)=${vwap} (jarak ${dVwap}) | evidence:${p.evidenceId}`;
}

export function renderTradeCaseStudy(header: CaseStudyTradeHeader, bundle: TradeForensicBundle): string {
  const fact = (id: string): EvidenceFact | undefined => bundle.facts.find((f) => f.id === id);
  const factLine = (id: string, label: string): string => {
    const f = fact(id);
    if (!f) return `- ${label}: n/a (fakta tidak tersedia)`;
    return `- ${label}: ${f.value === null || f.value === undefined ? "UNKNOWN" : String(f.value)} [${f.status}] (${id})`;
  };
  const lines: string[] = [];
  lines.push(`# STUDI KASUS TEKNIS — Trade #${header.id} ${header.symbol} ${header.side} ${header.mode}`);
  lines.push("");
  lines.push("## 1. Identitas trade");
  lines.push(`- Strategi: ${header.strategyId ?? "n/a"} | Entry ${fmtPrice(header.entryAvg)} -> Exit ${fmtPrice(header.exitAvg)}`);
  lines.push(`- Hasil: ${header.pnlUsd.toFixed(4)} USD (${header.rMultiple.toFixed(2)}R), fee ${header.feeUsd.toFixed(6)} USD, hold ${header.holdMinutes} mnt, close=${header.closeReason ?? "n/a"}`);
  lines.push(`- Level rencana: SL ${fmtPrice(header.plannedSlPrice ?? null)} | TP1 ${fmtPrice(header.plannedTp1Price ?? null)}`);
  lines.push(`- Klasifikasi: causeCode=${header.causeCode ?? "n/a"} (pasar) | executionMistake=${header.executionMistake ?? "n/a"} (proses)`);
  lines.push("");
  lines.push(`## 2. Konteks teknikal pra-entry (evidence bundle ${bundle.source}, interval ${bundle.interval})`);
  lines.push(factLine("context.nearest_support_pre_entry", "Support pivot terdekat (pra-entry)"));
  lines.push(factLine("context.nearest_resistance_pre_entry", "Resistance pivot terdekat (pra-entry)"));
  lines.push(factLine("entry.atr14", "ATR(14) pre-entry"));
  lines.push(factLine("entry.sl_atr_ratio", "Jarak SL / ATR"));
  lines.push(factLine("context.ema9_at_entry", "EMA(9) saat entry"));
  lines.push(factLine("context.vwap_at_entry", "VWAP anchor UTC saat entry"));
  lines.push("");
  lines.push("## 3. Timeline beranotasi (bar kunci)");
  if (bundle.annotatedTimeline.length === 0) {
    lines.push("- (tidak tersedia: klines tidak lengkap atau jendela posisi invalid)");
  } else {
    for (const p of bundle.annotatedTimeline) lines.push(pointLine(p));
  }
  lines.push("");
  lines.push("## 4. Path harga & benchmark");
  lines.push(factLine("path.sl_level_touched", "Level SL tersentuh"));
  lines.push(factLine("path.stop_tp1_same_bar", "SL & TP1 dalam satu bar (urutan intrabar TIDAK terukur)"));
  lines.push(factLine("path.post_stop_entry_reclaim_within_6_bars", "Reclaim entry 6 bar setelah SL"));
  for (const bench of ["BTCUSDT", "ETHUSDT", "BTCDOMUSDT"]) lines.push(factLine(`benchmark.${bench}.return_pct`, `Return ${bench} sejendela`));
  lines.push("");
  lines.push("## 5. Coverage data");
  for (const [sym, cov] of Object.entries(bundle.coverage)) {
    lines.push(`- ${sym}: ${cov.receivedBars}/${cov.expectedBars} bar ${cov.complete ? "(lengkap)" : "(TIDAK LENGKAP)"}`);
  }
  lines.push("");
  lines.push(`> Batasan: ${bundle.limitation}`);
  lines.push("> Semua angka dihasilkan kode deterministik dari data yang tersedia; tanpa klaim kausal (TRADING_EVIDENCE_POLICY).");
  return lines.join("\n");
}