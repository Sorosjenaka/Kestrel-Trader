// apps/server/tools/t13-compare-paper-live.ts — T-04 / CP-2 (19 Okt 2026).
//
// Komparator fidelity: EV NET paper vs EV NET live dari DB (Trade + OrderExec).
// READ-ONLY terhadap jalur trading. Angka dihitung di TS dari baris DB — tidak
// ada nominal yang dihitung manual/LLM.
//
// Pemakaian:
//   npx tsx tools/t13-compare-paper-live.ts
//   npx tsx tools/t13-compare-paper-live.ts --min-n 500 --tolerance 0.1 --json /tmp/t13.json
//   npx tsx tools/t13-compare-paper-live.ts --write-finding --dry-run
//   npx tsx tools/t13-compare-paper-live.ts --write-finding
//   opsi: --since YYYY-MM-DD  --strategy S-03,RSW-01
//
// Catatan jujur:
//   - Trade.pnlUsd = NET fee (positionSupervisor); funding terpisah dan paper
//     BELUM memodelkan funding (TIER 1.1) -> funding dilaporkan, bukan dicampur.
//   - Hanya trade fee-covered yang dipakai untuk verdict; trade pra-fee-wiring
//     (feeUsd=0) dilaporkan sebagai as-recorded dan TIDAK dianggap bukti.
//   - operatorDecision ResearchFinding tetap PENDING — vonis = keputusan operator.
import { writeFileSync } from "node:fs";
import { db } from "../src/core/db.js";
import {
  classifyTrade,
  compareByStrategy,
  comparePaperLive,
  toFindingVerdict,
  type ClassifiedTrade,
  type ClosedTradeLite,
} from "../src/analytics/paperLiveEv.js";
import { listResearchFindings, logResearchFinding } from "../src/learning/researchFinding.js";

interface CliOptions {
  toleranceR: number;
  minSamples: number;
  since: number | null;
  strategies: Set<string> | null;
  jsonPath: string | null;
  writeFinding: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const num = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} harus angka > 0`);
    return n;
  };
  const sinceRaw = get("--since");
  let since: number | null = null;
  if (sinceRaw) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t)) throw new Error("--since harus tanggal ISO (YYYY-MM-DD)");
    since = t;
  }
  const strategyRaw = get("--strategy");
  return {
    toleranceR: num("--tolerance", 0.1),
    minSamples: Math.round(num("--min-n", 500)),
    since,
    strategies: strategyRaw ? new Set(strategyRaw.split(",").map((s) => s.trim()).filter(Boolean)) : null,
    jsonPath: get("--json"),
    writeFinding: argv.includes("--write-finding"),
    dryRun: argv.includes("--dry-run"),
  };
}

async function loadRows(opts: CliOptions): Promise<ClosedTradeLite[]> {
  const rows = await db.trade.findMany({
    orderBy: { createdAt: "asc" },
    where: {
      ...(opts.since != null ? { createdAt: { gte: new Date(opts.since) } } : {}),
      ...(opts.strategies ? { strategyId: { in: [...opts.strategies] } } : {}),
    },
    select: {
      id: true, symbol: true, mode: true, side: true, strategyId: true, source: true,
      accountingQuality: true, pnlUsd: true, feeUsd: true, fundingUsd: true,
      riskUsd: true, riskBudgetUsd: true, rMultiple: true, win: true, createdAt: true,
      position: { select: { orders: { select: { simulated: true, binanceOrderId: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, mode: r.mode, side: r.side, strategyId: r.strategyId,
    source: r.source, accountingQuality: r.accountingQuality, pnlUsd: r.pnlUsd,
    feeUsd: r.feeUsd, fundingUsd: r.fundingUsd, riskUsd: r.riskUsd,
    riskBudgetUsd: r.riskBudgetUsd, rMultiple: r.rMultiple, win: r.win,
    createdAt: r.createdAt.getTime(), orders: r.position.orders,
  }));
}

function fmtR(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)}R`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${v.toFixed(1)}%`;
}

function statsLine(label: string, s: ReturnType<typeof comparePaperLive>["paper"], asRecordedN: number): string {
  return `${label.padEnd(6)} fee-covered n=${String(s.n).padStart(4)} · EV=${fmtR(s.meanNetR).padStart(9)} · sd=${fmtR(s.sdNetR)} · median=${fmtR(s.medianNetR)} · WR=${fmtPct(s.wrPct)} · fee=$${s.sumFeeUsd.toFixed(4)} · funding=$${s.sumFundingUsd.toFixed(4)} · as-recorded n=${asRecordedN}`;
}

function exclusionCounts(rows: ClassifiedTrade[]): Record<string, number> {
  const out: Record<string, number> = { DEMO: 0, MANUAL: 0, UNKNOWN_VENUE: 0, MISSING_NET_R: 0 };
  for (const r of rows) {
    if (r.exclusion) out[r.exclusion] += 1;
    else if (r.venue === "UNKNOWN") out.UNKNOWN_VENUE += 1;
    if (r.netR == null) out.MISSING_NET_R += 1;
  }
  return out;
}

function conclusionText(
  res: ReturnType<typeof comparePaperLive>,
  excluded: Record<string, number>,
  sourceNote: string,
): string {
  const ci = res.ci95 ? `[${fmtR(res.ci95[0])}; ${fmtR(res.ci95[1])}]` : "n/a";
  return [
    `Paper fee-covered n=${res.paper.n}, live fee-covered n=${res.live.n} (lantai ${res.minSamples}/venue).`,
    `EV NET paper ${fmtR(res.paper.meanNetR)} vs live ${fmtR(res.live.meanNetR)}; delta ${fmtR(res.deltaR)} (CI95 ${ci}); toleransi ${res.toleranceR.toFixed(3)}R.`,
    `Verdict ${res.verdict}${res.reasons.length ? ` (${res.reasons.join("; ")})` : ""}.`,
    `Dikecualikan: DEMO=${excluded.DEMO}, MANUAL=${excluded.MANUAL}, venue tak dikenal=${excluded.UNKNOWN_VENUE}, NET R tak valid=${excluded.MISSING_NET_R}.`,
    "Funding paper belum dimodelkan (TIER 1.1) — EV di atas fee-inclusive, funding-exclusive; jangan klaim parity penuh.",
    `Sumber: ${sourceNote}. Verdict bukan keputusan strategi; operatorDecision tetap PENDING.`,
  ].join(" ");
}

async function writeFinding(
  res: ReturnType<typeof comparePaperLive>,
  excluded: Record<string, number>,
  sourceNote: string,
  dryRun: boolean,
): Promise<void> {
  const localDay = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const title = `T1.3 Fidelity paper NET vs live EV — run ${localDay}`;
  const existing = new Set((await listResearchFindings(500)).map((r) => String(r.title)));
  if (existing.has(title)) {
    console.log(`[finding] skip — sudah ada: ${title}`);
    return;
  }
  const input = {
    title,
    hypothesis: "EV NET lane paper (eksekusi simulasi) mendekati EV NET live dalam toleransi 0,1R sehingga hasil paper layak dipakai sebagai proxy live.",
    experimentType: "EVENT_REPLAY" as const,
    verdict: toFindingVerdict(res.verdict),
    conclusion: conclusionText(res, excluded, sourceNote),
    runRefs: [{ kind: "EVENT_REPLAY" as const, label: `T1.3 comparator — ${sourceNote}` }],
    metrics: {
      paperN: res.paper.n,
      liveN: res.live.n,
      paperNAsRecorded: res.paperAsRecorded.n,
      liveNAsRecorded: res.liveAsRecorded.n,
      paperEvNetR: res.paper.meanNetR,
      liveEvNetR: res.live.meanNetR,
      deltaR: res.deltaR,
      ci95Low: res.ci95?.[0] ?? null,
      ci95High: res.ci95?.[1] ?? null,
      toleranceR: res.toleranceR,
      minSamples: res.minSamples,
      fidelityVerdict: res.verdict,
      reasons: res.reasons.join("; "),
      paperSumFeeUsd: res.paper.sumFeeUsd,
      liveSumFeeUsd: res.live.sumFeeUsd,
      paperSumFundingUsd: res.paper.sumFundingUsd,
      liveSumFundingUsd: res.live.sumFundingUsd,
      excludedDemo: excluded.DEMO,
      excludedManual: excluded.MANUAL,
      excludedUnknownVenue: excluded.UNKNOWN_VENUE,
      fundingModeledInPaper: false,
    },
  };
  if (dryRun) {
    console.log(`[finding] DRY-RUN — akan tulis: ${title} (verdict ${input.verdict})`);
    return;
  }
  const id = await logResearchFinding(input);
  console.log(id == null ? `[finding] GAGAL tulis: ${title}` : `[finding] ditulis id=${id}: ${title} (verdict ${input.verdict}, operatorDecision PENDING)`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await loadRows(opts);
  const rows = raw.map(classifyTrade);
  const res = comparePaperLive(rows, { toleranceR: opts.toleranceR, minSamples: opts.minSamples });
  const excluded = exclusionCounts(rows);
  const sourceNote = `data/artatrade.db Trade+OrderExec${opts.since ? ` since ${new Date(opts.since).toISOString().slice(0, 10)}` : ""}${opts.strategies ? ` strategi ${[...opts.strategies].join(",")}` : ""}`;

  console.log("== T1.3 PAPER NET vs LIVE EV ==");
  console.log(`Sumber: ${sourceNote}`);
  console.log(`Baris Trade dibaca: ${rows.length}`);
  console.log(statsLine("PAPER", res.paper, res.paperAsRecorded.n));
  console.log(statsLine("LIVE", res.live, res.liveAsRecorded.n));
  console.log(
    `As-recorded (diagnostik; fee belum tentu tercatat): PAPER n=${res.paperAsRecorded.n} EV=${fmtR(res.paperAsRecorded.meanNetR)} · LIVE n=${res.liveAsRecorded.n} EV=${fmtR(res.liveAsRecorded.meanNetR)}`,
  );
  console.log(
    `Delta EV: ${fmtR(res.deltaR)} · CI95 ${res.ci95 ? `[${fmtR(res.ci95[0])}; ${fmtR(res.ci95[1])}]` : "n/a"} · toleransi ${res.toleranceR.toFixed(3)}R · lantai ${res.minSamples}/venue`,
  );
  console.log(`VERDICT: ${res.verdict}${res.reasons.length ? ` — ${res.reasons.join(" | ")}` : ""}`);
  console.log(
    `Dikecualikan: DEMO=${excluded.DEMO} MANUAL=${excluded.MANUAL} UNKNOWN_VENUE=${excluded.UNKNOWN_VENUE} MISSING_NET_R=${excluded.MISSING_NET_R}`,
  );

  const perStrategy = compareByStrategy(rows);
  if (perStrategy.length > 0) {
    console.log("\nPer strategi (fee-covered; delta hanya bila dua venue ada):");
    console.log("  strategi        paper n / EV            live n / EV             delta");
    for (const s of perStrategy) {
      console.log(
        `  ${s.strategyId.padEnd(14)} ${String(s.paper.n).padStart(4)} / ${fmtR(s.paper.meanNetR).padStart(9)}   ${String(s.live.n).padStart(4)} / ${fmtR(s.live.meanNetR).padStart(9)}   ${fmtR(s.deltaR)}`,
      );
    }
  }

  if (opts.jsonPath) {
    writeFileSync(opts.jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), sourceNote, excluded, result: res, perStrategy }, null, 2));
    console.log(`\nJSON: ${opts.jsonPath}`);
  }

  if (opts.writeFinding) {
    await writeFinding(res, excluded, sourceNote, opts.dryRun);
  }
}

main().catch((err) => {
  console.error("[t13-compare-paper-live] gagal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
