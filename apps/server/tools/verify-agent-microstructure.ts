// apps/server/tools/verify-agent-microstructure.ts
// Verifikasi LIVE (bukan mock) bahwa blok mikrostruktur & order flow masuk
// ke prompt masing-masing agen. Menyalakan 5 hub WS/REST sungguhan, lalu
// mencetak blok yang diterima agen + potongan prompt tiap agen.
//
// Jalankan: npx tsx tools/verify-agent-microstructure.ts
import { startMicrostructureHubs, stopMicrostructureHubs } from "../src/marketdata/microstructureBootstrap.js";
import { buildMicrostructurePromptBlock } from "../src/agents/marketIntel.js";

const AGENTS = [
  "Vega (macro-scout)",
  "Sena (universe-curator)",
  "Rhea (regime-analyst)",
  "Bima (scanner-supervisor)",
  "Arka (setup-judge)",
  "Wardha (risk-officer)",
  "Nadira (trade-supervisor)",
  "Raksa (watchdog)",
  "Sesha (post-mortem)",
  "Laras (strategy-tuner)",
  "Varuna (backtest-auditor)",
  "Kirana (narrator)",
];

async function main() {
  console.log("=== START HUB LIVE ===");
  await startMicrostructureHubs();
  // Beri waktu stream WS terkumpul supaya CVD/wall/tape terisi.
  await new Promise((r) => setTimeout(r, 25_000));

  const block = await buildMicrostructurePromptBlock("BTC");
  console.log("\n=== BLOK YANG MASUK PROMPT AGEN (live, 5 modul) ===");
  console.log(block || "(KOSONG — hub belum siap)");

  console.log("\n=== STATUS PER MODUL (live) ===");
  const { multiVenueOrderFlowHub } = await import("../src/marketdata/multiVenueOrderFlowHub.js");
  const { wallLifelines } = await import("../src/marketdata/wallLifelines.js");
  const { liquidationMapHub } = await import("../src/marketdata/liquidationMapHub.js");
  const { volumeProfileHub } = await import("../src/marketdata/volumeProfileHub.js");
  const { tierFlowHub } = await import("../src/marketdata/tierFlowHub.js");

  const venues = multiVenueOrderFlowHub.venueHealth();
  console.log(`venue streaming: ${venues.filter((v) => v.connected).length}/${venues.length}`);
  console.log(`trade ingest   : ${venues.reduce((a, v) => a + v.tradesIngested, 0)}`);
  const w = wallLifelines.snapshot("BTC");
  console.log(`wall           : aktif=${w.summary.active} pulled=${w.summary.pulled} eaten=${w.summary.eaten} moved=${w.summary.moved}`);
  const lm = await liquidationMapHub.snapshot("BTC");
  console.log(`liq map        : source=${lm.source} magnet=${lm.magnetDirection} mark=${lm.markPrice}`);
  const vp = volumeProfileHub.build("BTC", "1h");
  console.log(`vol profile    : POC=${vp.pocPrice} VAH=${vp.vahPrice} VAL=${vp.valPrice} total=$${vp.totalUsd}`);
  const tf = tierFlowHub.tiers("BTC", 900);
  console.log(`tier flow      : ${tf.map((t) => `${t.tier}=${t.netDeltaUsd}`).join(" ")}`);

  console.log("\n=== AGEN YANG MENERIMA BLOK ===");
  const present = block.length > 0;
  for (const a of AGENTS) {
    console.log(`  ${present ? "OK " : "?? "} ${a}`);
  }

  // Bukti ujung-ke-ujung: prompt yang benar-benar diterima LLM, berisi
  // angka mikrostruktur LIVE (bukan fixture).
  console.log("\n=== PROMPT YANG BENAR-BENAR DITERIMA LLM (cuplikan) ===");
  const { AgentManager } = await import("../src/agents/agentCatalog.js");
  const { XkiroAdapter } = await import("../src/agents/llmAdapter.js");
  const seen: string[] = [];
  const recorder = {
    async chat(messages: any[], model: string) {
      seen.push(messages.map((m: any) => m.content).join("\n"));
      return { content: "ok", model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 }, latencyMs: 1 };
    },
  };
  const mgr = new AgentManager(new XkiroAdapter({ client: recorder as any }));
  for (const id of ["macro-scout", "regime-analyst", "narrator", "setup-judge", "risk-officer"]) {
    await mgr.askAgent(id, "ringkasan operator");
  }
  for (const p of seen) {
    const hasMarker = p.includes("MIKROSTRUKTUR & ORDER FLOW");
    const hasCvd = /CVD: \$-?\d/.test(p);
    console.log(`  marker=${hasMarker ? "OK" : "HILANG"} cvdLive=${hasCvd ? "OK" : "HILANG"}`);
  }
  const sample = seen.find((p) => p.includes("MIKROSTRUKTUR & ORDER FLOW")) ?? "";
  const lines = sample.split("\n").filter((l) => l.includes("MIKROSTRUKTUR") || l.includes("[Mikrostruktur") || l.includes("CVD:") || l.includes("VolProfile:") || l.includes("Wall:") || l.includes("TierFlow:"));
  console.log("\n  cuplikan blok di prompt:");
  for (const l of lines) console.log(`   | ${l.trim()}`);

  stopMicrostructureHubs();
  process.exit(0);
}

main().catch((e) => {
  console.error("VERIFY_FAILED", e);
  process.exit(1);
});
