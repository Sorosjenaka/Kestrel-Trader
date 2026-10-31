// apps/server/tools/probe-drex-vision.ts
// 23 Okt 2026 — LIVE PROBE (read-only, tanpa order Binance): apakah Drex-Max
// benar-benar bisa membaca CHART dari gambar (field `images`)?
//
// Mengirim screenshot chart NYATA (BTCUSDT 1h, di-crop dari app yang berjalan)
// lalu membandingkan jawaban Drex: dengan gambar vs tanpa gambar.
//
// Tidak mengirim order, tidak mengubah state engine, tidak menulis DB.
import { readFileSync, existsSync } from "node:fs";
import { env } from "../src/core/env.js";

const BASE = env.DREX_BASE_URL ?? "https://drex.nace.ai";
const KEY = env.DREX_API_KEY ?? "";
const CHART_B64 = "/tmp/chart_b64.json";
const CHART_PNG = "apps/server/tools/_probe-chart.png";

const QUESTIONS = {
  entry_go: {
    type: "noul",
    instructions: "Based on the provided market state, should this setup be executed?",
    criteria: {
      true: "The setup has a positive expected edge right now given scores, regime, structure, macro and session context.",
      false: "The setup is late, crowded, contradicted by macro/structure, or low quality.",
    },
  },
  direction: {
    type: "choice",
    instructions: "Which position direction is better supported by the current market state?",
    criteria: {
      LONG: "Structure and liquidity favor upside over the next few minutes.",
      SHORT: "Structure and liquidity favor downside over the next few minutes.",
    },
  },
  setup_strength: {
    type: "score",
    instructions: "How strong is the current trading setup?",
    criteria: ["very_weak", "weak", "moderate", "strong", "very_strong"],
  },
} as const;

function stateOf(symbol: string, side: "LONG" | "SHORT", price: number) {
  return {
    schemaVersion: "artatrade-swing-state-v1",
    symbol,
    side,
    mode: "SWING",
    scores: { compositeScore: 70, zoneScore: 65, triggerScore: 60, trendScore: 62 },
    strategy: { id: "RSW-01", name: "Orion", quality: 74, rr: 2 },
    levels: {
      entryPrice: price,
      slPrice: price * (side === "LONG" ? 0.98 : 1.02),
      tp1Price: price * (side === "LONG" ? 1.04 : 0.96),
    },
    structure: { adx: 26.5, choppiness: 38.2, atrPct: 1.4, volumeUsd: 9_608_723_881 },
    session: { lane: "SWING", paperMode: true, equityUsd: 198, swingOpen: 4, swingCap: 20 },
    note: "PROBE vision — state sintetis untuk menguji kemampuan vision, bukan sinyal trading nyata.",
  };
}

async function callDrex(state: unknown, images?: string[]): Promise<{ ok: boolean; ms: number; body: string; code: string }> {
  const payload: Record<string, unknown> = { model: env.DREX_MODEL ?? "drex-max", state, questions: QUESTIONS };
  if (images && images.length) payload.images = images;
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return { ok: res.ok, ms: Date.now() - started, body: text.slice(0, 1200), code: String(res.status) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, body: (e as Error).message, code: "NETWORK" };
  }
}

function chartBase64(): string | null {
  if (existsSync(CHART_B64)) {
    const raw = JSON.parse(readFileSync(CHART_B64, "utf8")) as { b64: string };
    return raw.b64;
  }
  if (existsSync(CHART_PNG)) {
    return readFileSync(CHART_PNG).toString("base64");
  }
  return null;
}

async function main(): Promise<void> {
  if (!KEY) {
    console.log("SKIP: DREX_API_KEY kosong di env yang dimuat");
    return;
  }
  const symbol = process.argv[2] ?? "BTCUSDT";
  const side = (process.argv[3] === "LONG" ? "LONG" : "SHORT") as "LONG" | "SHORT";
  const price = Number(process.argv[4] ?? 0) || 81719;
  const b64 = chartBase64();

  console.log(`== PROBE VISION Drex | symbol=${symbol} side=${side} model=${env.DREX_MODEL}`);
  console.log(`   chart png: ${b64 ? `ada (base64 ${b64.length} char)` : "TIDAK ADA"}`);
  console.log("");

  console.log("[1] request TANPA gambar (state JSON saja)");
  const a = await callDrex(stateOf(symbol, side, price));
  console.log(`    http=${a.code} ok=${a.ok} latency=${a.ms}ms`);
  console.log(`    body: ${a.body.slice(0, 400)}`);
  console.log("");

  console.log("[2] request DENGAN gambar (field images, base64 PNG chart nyata)");
  const b = await callDrex(stateOf(symbol, side, price), b64 ? [b64] : undefined);
  console.log(`    http=${b.code} ok=${b.ok} latency=${b.ms}ms`);
  console.log(`    body: ${b.body.slice(0, 700)}`);
  console.log("");

  console.log("== RINGKASAN ==");
  console.log(`  tanpa gambar : http=${a.code} ok=${a.ok} ${a.ms}ms`);
  console.log(`  dengan gambar: http=${b.code} ok=${b.ok} ${b.ms}ms`);
  if (b.ok && !a.ok) console.log("  -> field images DITERIMA (vision aktif).");
  if (b.code === "422") console.log("  -> field images DITOLAK: " + b.body.slice(0, 250));
}

void main();
