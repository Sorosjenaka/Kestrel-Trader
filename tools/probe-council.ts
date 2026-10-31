// tools/probe-council.ts — probe TERISOLASI untuk membuktikan AI Council
// benar-benar jalan (27 Okt 2026, permintaan operator: council "belum
// berjalan" harus diperbaiki).
//
// Probe ini HANYA memanggil conveneCouncil() dengan konteks sintetis dan
// mencetak hasilnya: TIDAK menulis DB, TIDAK mengirim order, TIDAK menyentuh
// posisi. Panggilan LLM nyata ke Xkiro (satu kali) — itu yang membuktikan
// voting 3 agen (Vega/Arka/Wardha) berjalan end-to-end.
//
// Jalankan: npx tsx tools/probe-council.ts
import { env } from "../apps/server/src/core/env.js";

async function main() {
  console.log("ENABLE_AI_COUNCIL (env terbaca app):", env.ENABLE_AI_COUNCIL);
  if (!env.ENABLE_AI_COUNCIL) {
    console.log("FLAG MATI — council tidak akan dipanggil di loop entry. Set ENABLE_AI_COUNCIL=true dulu.");
    process.exit(2);
  }
  const { conveneCouncil } = await import("../apps/server/src/agents/councilEngine.js");
  const started = Date.now();
  const decision = await conveneCouncil({
    symbol: "BTCUSDT",
    side: "LONG",
    entryPrice: 100000,
    slPrice: 98500,
    tpPrice: 103000,
    atrValue: 1200,
    regimeInfo: "PROBE SINTETIS — bukan trade nyata",
    technicalScore: 70,
  });
  console.log("durasi_ms:", Date.now() - started);
  console.log("finalAction:", decision.finalAction);
  console.log("consensusLevel:", decision.consensusLevel);
  console.log("votes:");
  for (const v of decision.votes) {
    console.log(`  - ${v.agentName} (${v.agentId}): ${v.stance} conf=${v.confidenceScore}`);
    console.log(`    ${String(v.reasoning ?? "").slice(0, 160)}`);
  }
  console.log("summary:", String(decision.summaryNarrative ?? "").slice(0, 300));
  console.log("PROBE_OK");
}

main().catch((e) => {
  console.error("PROBE_FAIL:", (e as Error).message);
  process.exit(1);
});
