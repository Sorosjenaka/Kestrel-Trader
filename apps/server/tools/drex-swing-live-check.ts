// apps/server/tools/drex-swing-live-check.ts
// Bukti end-to-end jalur Drex SWING: state builder -> adapter -> HTTP live ->
// parse -> verdict. TIDAK menyentuh exchange, TIDAK membuka/menutup posisi,
// TIDAK menulis ke DB produksi. Hanya memanggil endpoint Drex (read-only
// secara bisnis: request berisi state, jawaban = probabilitas).
//
// Jalankan: npx tsx tools/drex-swing-live-check.ts
import { buildDrexSwingState } from "../src/agents/drexState.js";
import { DecisionRiskLayer, type SwingDrexJudgeInput } from "../src/agents/decisionRiskLayer.js";
import { env } from "../src/core/env.js";

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const cases: Array<{ label: string; input: SwingDrexJudgeInput }> = [
  {
    label: "RSW-01 LONG (setup kuat)",
    input: {
      symbol: "ETHUSDT", side: "LONG", strategyId: "RSW-01", strategyName: "Orion",
      compositeScore: 78, zoneScore: 74, triggerScore: 70,
      entryPrice: 3200, slPrice: 3150, tp1Price: 3300,
      planQuality: 0.85, structureAdx: 26, structureChop: 38, structureAtrPct: 1.8,
      equityUsd: 200, swingOpen: 12, swingCap: 20, regime: "TRENDING",
    },
  },
  {
    label: "RSW-03 SHORT (setup lemah, ADX tinggi)",
    input: {
      symbol: "SOLUSDT", side: "SHORT", strategyId: "RSW-03", strategyName: "Draco",
      compositeScore: 52, zoneScore: 48, triggerScore: 44,
      entryPrice: 180, slPrice: 185, tp1Price: 170,
      planQuality: 0.44, structureAdx: 34, structureChop: 55, structureAtrPct: 3.2,
      equityUsd: 200, swingOpen: 19, swingCap: 20, regime: "RANGING",
    },
  },
];

async function main(): Promise<void> {
  line("KONFIGURASI AKTIF");
  console.log(`DREX_ENABLED=${env.DREX_ENABLED} DREX_SWING_ENABLED=${env.DREX_SWING_ENABLED}`);
  console.log(`DREX_MODEL=${env.DREX_MODEL} DREX_BASE_URL=${env.DREX_BASE_URL}`);
  console.log(`key=${env.DREX_API_KEY ? "SET" : "MISSING"}`);
  console.log(`ambang: p>=${env.DREX_MIN_ENTRY_PROBABILITY} strength>=${env.DREX_MIN_SETUP_STRENGTH}`);

  const layer = new DecisionRiskLayer();

  for (const c of cases) {
    line(c.label);
    const built = buildDrexSwingState(c.input);
    if (!built.ok) {
      console.log(`STATE GAGAL: ${built.reason}`);
      continue;
    }
    const state = built.state;
    console.log(`state: schema=${state.schemaVersion} mode=${state.mode} symbol=${state.symbol} side=${state.side}`);
    console.log(`state JSON: ${JSON.stringify(state)}`);

    const verdict = await layer.runSwingDrexJudge(c.input);
    console.log(`verdict: ${verdict.kind}`);
    if (verdict.kind === "go") {
      console.log(`  p=${verdict.p} direction=${verdict.direction} strength=${verdict.strength}`);
      console.log(`  model=${verdict.data.model} requestId=${verdict.data.requestId}`);
      console.log(`  latency: total=${verdict.data.latency.totalMs}ms request=${verdict.data.latency.requestMs}ms response=${verdict.data.latency.responseMs}ms`);
    } else if (verdict.kind === "reject") {
      console.log(`  reason=${verdict.reason}`);
      console.log(`  p=${verdict.p} direction=${verdict.direction} strength=${verdict.strength}`);
      console.log(`  model=${verdict.data.model} requestId=${verdict.data.requestId}`);
    } else {
      console.log(`  reason=${verdict.reason} (fail-open: entry tidak diblokir)`);
    }
  }

  line("SELESAI");
}

main().catch((err) => {
  console.error("GAGAL:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});