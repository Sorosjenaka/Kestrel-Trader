// tools/backfill-research-findings-edge.ts
// Rencana edge 16 Okt 2026 — Fase 0/1/2 (side-split, grid fitur, konfirmasi).
// 3 temuan utama ditulis PENDING; vonis ADOPTED/REJECTED = keputusan operator.
// Script TIDAK memanggil decideResearchFinding. Idempoten per judul.
// Jalankan: npx tsx tools/backfill-research-findings-edge.ts [--dry-run]
import { logResearchFinding, listResearchFindings } from "../src/learning/researchFinding.js";

export const FINDINGS_EDGE_2026_10_16 = [
  {
    title: "Side-split S-05/S-03: SHORT adalah sumber drag — LONG OOS PF 1.59/1.15",
    hypothesis: "Performa S-05/S-03 tidak simetris antar sisi; pecahan LONG vs SHORT mengungkap sumber kerugian yang tersembunyi di agregat ALL.",
    experimentType: "BACKTEST" as const,
    verdict: "SUPPORTIVE" as const,
    conclusion: "S-05 LONG OOS PF 1.592 (n=2837, WR 40.1%, avgR +0.357) vs SHORT PF 0.281 (n=2444, WR 22.1%). S-03 LONG PF 1.153 (n=968) vs SHORT 0.668 (n=1170). Pola konsisten di INS/OOS dan kedua bound intrabar. Filter regime slope tidak diperlukan — masalahnya sisi. Catatan: OOS Agu-Okt, bias periode belum diuji holdout penuh. Keputusan LONG-only = operator.",
    metrics: { s05LongOosPf: 1.592, s05LongOosN: 2837, s05ShortOosPf: 0.281, s03LongOosPf: 1.153, s03ShortOosPf: 0.668, universeSymbols: 187 },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py side-split 2026-10-16 (side_split_report.md, side_split_aggregate.csv)" }],
  },
  {
    title: "Grid fitur kualitas sinyal H1-H7: mayoritas tak membaiki ALL; kandidat via pecahan sisi",
    hypothesis: "Filter kualitas sinyal (volume ekspansi, ER, ADX, chop, ZLEMA slope, HTF agree, jarak PoC) menaikkan PF OOS di atas baseline S-05 0.899 / S-03 0.871.",
    experimentType: "BACKTEST" as const,
    verdict: "REFUTED" as const,
    conclusion: "26 sel dilaporkan SEMUA. Pada agregat ALL tidak ada filter mencapai PF 1.3; terbaik: S-05 volr>=2.0 PF 1.024 (n=420), S-03 ER>=0.35 PF 1.079 (n=386). ZLEMA slope & HTF agreement justru memburukkan (0.722-0.904). Nilai filter muncul hanya pada pecahan LONG (volr>=2.0 LONG PF 2.196 n=218; ER>=0.35 LONG PF 2.114 n=235) — diuji di eksperimen konfirmasi terpisah. H6/ZLEMA REFUTED.",
    metrics: { cellsReported: 26, bestAllPf: 1.079, s05Volr2AllPf: 1.024, s03Er35AllPf: 1.079, htfAgreeS05Pf: 0.722 },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py feature-variants 2026-10-16 (feature_filter_results.csv)" }],
  },
  {
    title: "Konfirmasi Fase 2: S-03 LONG + ER>=0.35 lolos protokol — S-05 varian gagal replikasi",
    hypothesis: "Kandidat LONG-only + filter yang lolos screening (PF>=1.0, n>=100, kedua bound) bertahan pada holdout ketiga (cut 1 Jun 2026) dan replikasi universe 5 simbol fixture.",
    experimentType: "BACKTEST" as const,
    verdict: "SUPPORTIVE" as const,
    conclusion: "C5 S-03 LONG+ER>=0.35: OOS(1 Agu) PF 1.531 / WR 45.0% / n=191; holdout(1 Jun) PF 1.207 / n=329; kedua bound identik; fixture5 OOS PF 3.15 (n=7 — sampel kecil). GAGAL: C3 S-05 LONG+ER>=0.35 (fixture PF 0.013 — overfit tertangkap protokol); C2 S-05 LONG+volr2.0 miss tipis WR (44.98<45) tapi PF 2.196 & holdout 1.478 — kandidat observasi; C1 LONG-only WR 40.1<45; C4 holdout 0.979. Rekomendasi riset: S-03 LONG+ER>=0.35 layak dipertimbangkan operator; C2 dipantau. TIDAK diadopsi otomatis.",
    metrics: { c5OosPf: 1.531, c5OosN: 191, c5HoldoutPf: 1.207, c3FixturePf: 0.013, c2OosPf: 2.196, c2Wr: 44.98 },
    runRefs: [{ kind: "BACKTEST", label: "momentum_zone.py edge-confirm 2026-10-16 (edge_confirm_results.csv)" }],
  },
];

export async function backfillEdgeFindings(dryRun: boolean): Promise<{ inserted: string[]; skipped: string[] }> {
  const existing = new Set((await listResearchFindings(200)).map((r) => String(r.title)));
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const f of FINDINGS_EDGE_2026_10_16) {
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
    else skipped.push(f.title);
  }
  return { inserted, skipped };
}

const isDirectRun = process.argv[1]?.includes("backfill-research-findings-edge");
if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  backfillEdgeFindings(dryRun)
    .then(({ inserted, skipped }) => {
      console.log(`[backfill-edge] mode=${dryRun ? "DRY-RUN" : "TULIS"}`);
      for (const t of inserted) console.log(`  + ${t}`);
      for (const t of skipped) console.log(`  = ${t} (sudah ada / gagal — skip)`);
      console.log(`Total: ${inserted.length} tulis, ${skipped.length} skip. operatorDecision tetap PENDING.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[backfill-edge] gagal:", err);
      process.exit(1);
    });
}
