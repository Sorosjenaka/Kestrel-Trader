// apps/server/src/tools/backfill-research-findings.ts
// Big Brain 16 Okt 2026 — ingestion jurnal ResearchFinding: backfill 5 temuan
// riset 16 Okt (audit: tabel ResearchFinding 0 baris) langsung via
// logResearchFinding — kecil, deterministik, idempoten (skip judul sama),
// tanpa LLM. VONIS ADALAH KEPUTUSAN OPERATOR: script HANYA menulis PENDING —
// jangan panggil decideResearchFinding dari sini (Golden Rule: approval operator).
//
// Jalankan: npx tsx tools/backfill-research-findings.ts [--dry-run]
// Bukti: research/findings/momentum_zone_2026-10-16.md, regime_filter_report.md,
//        regime_variant_report.md, live_edge.json (semua 16 Okt 2026).
import { logResearchFinding, listResearchFindings } from "../src/learning/researchFinding.js";

export interface BackfillFinding {
  title: string;
  hypothesis: string;
  experimentType: "BACKTEST" | "OOS_VALIDATION" | "EVENT_REPLAY" | "LOOKAHEAD_AUDIT";
  verdict: "SUPPORTIVE" | "REFUTED" | "INCONCLUSIVE";
  conclusion: string;
  metrics: Record<string, number | string | boolean | null>;
  runRefs: { kind: string; label: string; hash?: string; id?: number | null }[];
}

/** Angka persis dari laporan riset 16 Okt 2026 (momentum_zone.py). */
export const FINDINGS_2026_10_16: BackfillFinding[] = [
  {
    title: "S-05 Swing Breakout: NO_EDGE pada OOS (ladder sl_first fee-on)",
    hypothesis: "S-05 (breakout channel pivot konvergen 1h) punya profit factor > 1 pada periode out-of-sample.",
    experimentType: "BACKTEST",
    verdict: "REFUTED",
    conclusion: "OOS (Agu-Okt 2026) PF 0.869, WR 30.9%, avgR -0.091 pada 10.501 trade (sl_first, fee-on). INS 18.915 trade PF 0.818. Tidak ada edge di salah satu bound intrabar maupun fee-off. Keputusan strategi = milik operator.",
    metrics: { oosTrades: 10501, oosPf: 0.869, oosWrPct: 30.9, oosAvgR: -0.091, oosAvgHoldBars: 194.8, insTrades: 18915, insPf: 0.818, insWrPct: 34.4, insAvgR: -0.12, bound: "sl_first", feeOn: true },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py backtest 2026-10-16 (S-05, 5 simbol 1h Apr-Okt)" }],
  },
  {
    title: "S-03 Fibonacci Zone: NO_EDGE pada OOS (ladder sl_first fee-on)",
    hypothesis: "S-03 (zona fibo 0.5-0.618 dengan RR/TP gaya S-05) punya profit factor > 1 pada periode out-of-sample.",
    experimentType: "BACKTEST",
    verdict: "REFUTED",
    conclusion: "OOS (Agu-Okt 2026) PF 0.871, WR 36.5%, avgR -0.083 pada 2.138 trade (sl_first, fee-on). INS 3.233 trade PF 0.922. Tidak ada edge pada OOS. Keputusan strategi = milik operator.",
    metrics: { oosTrades: 2138, oosPf: 0.871, oosWrPct: 36.5, oosAvgR: -0.083, oosAvgHoldBars: 56.2, insTrades: 3233, insPf: 0.922, insWrPct: 35.6, insAvgR: -0.051, bound: "sl_first", feeOn: true },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py backtest 2026-10-16 (S-03 fibo, 5 simbol 1h Apr-Okt)" }],
  },
  {
    title: "Filter regime untuk S-05: REFUTED (2/24 sel lebih baik saat ON)",
    hypothesis: "Memblokir entry S-05 saat regime bar i-1 tidak sejalan arah (LONG->BULLISH, SHORT->BEARISH) menaikkan PF OOS.",
    experimentType: "BACKTEST",
    verdict: "REFUTED",
    conclusion: "Hanya 2/24 konfigurasi punya PF OOS lebih baik saat filter ON; terbaik OFF 0.967 vs ON 0.858. Filter utamanya memotong sampel, bukan menambah edge. Tanpa look-ahead (dinilai di bar i-1).",
    metrics: { configsTested: 24, configsBetterOn: 2, bestPfOff: 0.967, bestPfOn: 0.858, lookAhead: false },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py regime-compare 2026-10-16 (regime_filter_results.csv)" }],
  },
  {
    title: "Varian detektor regime untuk S-03: REFUTED (0/18 sel di atas baseline)",
    hypothesis: "Threshold detektor regime (slope x flat) untuk filter S-03 dapat menaikkan PF OOS di atas baseline.",
    experimentType: "BACKTEST",
    verdict: "REFUTED",
    conclusion: "0/18 sel grid threshold punya PF OOS > baseline. Grid threshold = banyak perbandingan statistik (risiko overfitting); SEMUA sel dilaporkan, tidak ada cherry-pick.",
    metrics: { configsTested: 18, configsAboveBaseline: 0, overfittingRiskNoted: true },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py regime-variants 2026-10-16 (regime_variant_results.csv)" }],
  },
  {
    title: "Live edge S-03/S-05: INCONCLUSIVE (1 round-trip nyata, -$4.12)",
    hypothesis: "Hasil live/paper real-fill mengonfirmasi atau membantah arah edge yang ditemukan backtest.",
    experimentType: "EVENT_REPLAY",
    verdict: "INCONCLUSIVE",
    conclusion: "11 real fill, 1 round-trip (RSRUSDT SHORT 20.000 @0.002431 -> 0.002226): gross -$4.10, fee maker $0.019, net -$4.12. n=1 — tidak bisa konfirmasi maupun bantah apa pun. Sampel butuh waktu; jurnal 5 baris lain berasal dari DEMO (bukan bukti edge).",
    metrics: { realFills: 11, roundTrips: 1, netPnlUsd: -4.12, grossPnlUsd: -4.1, feeUsdMaker: 0.019, symbol: "RSRUSDT", sampleAdequate: false },
    runRefs: [{ kind: "EVENT_REPLAY", label: "momentum_zone.py live-edge 2026-10-16 (data/artatrade.db, eksekusi LIMIT all-maker)" }],
  },
];

export async function backfillResearchFindings(dryRun: boolean): Promise<{ inserted: string[]; skipped: string[] }> {
  const existing = new Set((await listResearchFindings(200)).map((r) => String(r.title)));
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const f of FINDINGS_2026_10_16) {
    if (existing.has(f.title)) {
      skipped.push(f.title);
      continue;
    }
    if (dryRun) {
      inserted.push(f.title);
      continue;
    }
    const id = await logResearchFinding({
      title: f.title,
      hypothesis: f.hypothesis,
      experimentType: f.experimentType,
      verdict: f.verdict,
      conclusion: f.conclusion,
      runRefs: f.runRefs,
      metrics: f.metrics,
    });
    if (id !== null) inserted.push(f.title);
    else skipped.push(f.title); // fail-open: gagal tulis = tidak masuk, tidak throw
  }
  return { inserted, skipped };
}

const isDirectRun = process.argv[1]?.includes("backfill-research-findings");
if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  backfillResearchFindings(dryRun)
    .then(({ inserted, skipped }) => {
      console.log(`[backfill-research-findings] mode=${dryRun ? "DRY-RUN" : "TULIS"}`);
      for (const t of inserted) console.log(`  + ${t}`);
      for (const t of skipped) console.log(`  = ${t} (sudah ada / gagal — skip)`);
      console.log(`Total: ${inserted.length} tulis, ${skipped.length} skip. operatorDecision tetap PENDING — vonis = keputusan operator.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[backfill-research-findings] gagal:", err);
      process.exit(1);
    });
}
