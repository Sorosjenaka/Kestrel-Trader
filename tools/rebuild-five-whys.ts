// tools/rebuild-five-whys.ts
// Audit 5-Why 11 Okt 2026 (perintah operator "fix semua"):
//  1) run ulang diagnosis 5 Whys untuk semua trade ber-kesalahan (jawaban lama terpotong
//     slice(0,600) — 55/70 lapisan putus di tengah kalimat),
//  2) sekalian membuat laporan untuk trade yang BELUM punya (mis. #2682).
// Merge bersifat surgical: hanya key `fiveWhys` (dan `forensic` bila belum ada) yang
// ditulis ulang ke LearningEntry.proposal — field lain tidak disentuh.
// Usage: npx tsx tools/rebuild-five-whys.ts [--trade <id> [<id>...]]
import { defaultLlmAdapter } from "../apps/server/src/agents/llmAdapter.js";
import { extractJsonObject, prismaLearningRepo } from "../apps/server/src/learning/postMortemEvaluator.js";
import { loadBinanceTradeForensics } from "../apps/server/src/learning/postMortemEvaluator.js";
import { runFiveWhysDiagnosis } from "../apps/server/src/learning/fiveWhys.js";

async function main() {
  const argv = process.argv.slice(2);
  const tradeFlag = argv.indexOf("--trade");
  const explicit = tradeFlag >= 0
    ? argv.slice(tradeFlag + 1).map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  // Default: semua LearningEntry ber-kesalahan-eksekusi (pemilik laporan 5 Whys).
  const rows = explicit.length
    ? await Promise.all(explicit.map((id) => prismaLearningRepo.findLearningByTradeId(id)))
    : (await prismaLearningRepo.findAllLearnings()).filter((l) => l.isExecutionMistake);
  const targets = rows.filter((r): r is NonNullable<typeof r> => Boolean(r && r.tradeId));
  console.log(`Target rebuild 5 Whys: ${targets.length} trade`);

  let ok = 0, skipped = 0, failed = 0;
  for (const row of targets) {
    const tradeId = row.tradeId!;
    const trade = await prismaLearningRepo.findTradeById(tradeId);
    if (!trade) {
      console.log(`- trade #${tradeId}: SKIP (trade tidak ada — evaluasi yatim)`);
      skipped += 1;
      continue;
    }
    try {
      const forensic = await loadBinanceTradeForensics(trade);
      const fw = await runFiveWhysDiagnosis({
        adapter: defaultLlmAdapter,
        trade,
        forensic,
        executionMistake: row.executionMistake || "MISTAKE_NONE",
      });
      const merged = extractJsonObject(row.proposal ?? "") ?? {};
      merged.fiveWhys = fw;
      if (!merged.forensic) merged.forensic = forensic;
      await prismaLearningRepo.updateLearningEntry(row.id, { proposal: JSON.stringify(merged) });
      const lens = fw.layers.map((l) => l.answer.length);
      console.log(`- trade #${tradeId} ${trade.symbol}: ${fw.terminated}, ${fw.layers.length} lapis, panjang jawaban ${lens.join("/")}`);
      ok += 1;
    } catch (err) {
      console.log(`- trade #${tradeId}: GAGAL — ${(err as Error).message}`);
      failed += 1;
    }
  }
  console.log(`SELESAI: ok=${ok} skip=${skipped} gagal=${failed}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
