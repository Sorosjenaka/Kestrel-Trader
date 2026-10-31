// apps/server/tools/probe-drex-vision-live.ts
// 24 Okt 2026 — LIVE PROBE Drex vision (read-only, tanpa order Binance).
//
// Menguji JALUR PRODUKSI yang sebenarnya: DrexAdapter.evaluate() +
// prepareDrexVisionImage() (renderer PNG pure-Node server), bukan fetch
// buatan. Membuktikan 3 hal dengan request NYATA ke API Drex:
//
//   [1] DREX_VISION_ENABLED=0 -> request body TIDAK punya `images`
//   [2] DREX_VISION_ENABLED=1 -> request body PUNYA `images` (PNG chart dari
//        renderer server, BUKAN screenshot browser), usage punya image_tokens>0
//   [3] verdict berubah antara (1) dan (2) => Drex benar-benar MEMBACA chart
//
// Data chart: kline Binance futures NYATA (read-only, /fapi/v1/klines).
// Rahasia: hanya NAMA key yang ditampilkan, nilai tidak pernah dicetak.
//
// Jalankan: cd apps/server && DREX_VISION_ENABLED=1 npx tsx tools/probe-drex-vision-live.ts [SYMBOL] [SIDE] [TF]
import { env } from "../src/core/env.js";
import { DrexAdapter } from "../src/agents/drexAdapter.js";
import { prepareDrexVisionImage } from "../src/agents/drexVision.js";
import { DREX_QUESTIONS } from "../src/agents/drexState.js";
import type { DrexChartBar } from "../src/agents/drexChart.js";

const SYMBOL = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const SIDE = (process.argv[3] === "LONG" ? "LONG" : "SHORT") as "LONG" | "SHORT";
const INTERVAL = process.argv[4] ?? "1h";
const LIMIT = Math.max(30, Math.min(300, env.DREX_VISION_MAX_BARS || 120));

interface ProbeResult {
  ok: boolean;
  ms: number;
  imageCount: number;
  p: number | null;
  direction: string | null;
  strength: number | null;
  imageTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
  detail: string;
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<DrexChartBar[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`klines http ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
    low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
  })).filter((b) => Number.isFinite(b.close) && b.close > 0);
}

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
    note: "PROBE vision - state sintetis untuk menguji kemampuan vision, bukan sinyal trading nyata.",
  };
}

function readUsage(raw: unknown): { imageTokens: number | null; inputTokens: number | null; outputTokens: number | null } {
  const root = (raw ?? {}) as Record<string, unknown>;
  const usage = (root.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { imageTokens: num(usage.image_tokens), inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) };
}

async function main(): Promise<void> {
  console.log("== LIVE PROBE DREX VISION (read-only, tanpa order) ==");
  console.log(`  DREX_API_KEY   : ${env.DREX_API_KEY ? "SET (nilai tidak ditampilkan)" : "MISSING"}`);
  console.log(`  DREX_BASE_URL  : ${env.DREX_BASE_URL}`);
  console.log(`  DREX_MODEL     : ${env.DREX_MODEL}`);
  console.log(`  symbol/side/tf : ${SYMBOL} / ${SIDE} / ${INTERVAL}`);
  console.log(`  flag shell     : DREX_VISION_ENABLED=${process.env.DREX_VISION_ENABLED ?? "unset"}`);
  console.log("");

  if (!env.DREX_API_KEY) {
    console.log("SKIP: DREX_API_KEY kosong - tidak ada panggilan keluar.");
    return;
  }

  const bars = await fetchKlines(SYMBOL, INTERVAL, LIMIT);
  if (bars.length < 2) {
    console.log("SKIP: klines tidak cukup untuk render chart.");
    return;
  }
  const last = bars[bars.length - 1]!;
  console.log(`  data chart     : ${bars.length} bar ${INTERVAL} (last close ${last.close})`);
  console.log("");

  // Jalur produksi: adapter sungguhan + prepareDrexVisionImage.
  const adapter = new DrexAdapter();
  const state = stateOf(SYMBOL, SIDE, last.close);

  const runOnce = async (vision: boolean): Promise<ProbeResult> => {
    env.DREX_VISION_ENABLED = vision;
    const visionRes = prepareDrexVisionImage({
      symbol: SYMBOL,
      timeframe: INTERVAL,
      bars,
      levels: {
        entry: last.close,
        sl: last.close * (SIDE === "LONG" ? 0.98 : 1.02),
        tp: last.close * (SIDE === "LONG" ? 1.04 : 0.96),
      },
    });
    const started = Date.now();
    const res = await adapter.evaluate(state, DREX_QUESTIONS, visionRes.image ? { images: [visionRes.image] } : undefined);
    const ms = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false, ms, imageCount: visionRes.image ? 1 : 0,
        p: null, direction: null, strength: null, imageTokens: null, inputTokens: null, outputTokens: null,
        requestId: null, detail: `${res.code}: ${res.detail}`,
      };
    }
    const answers = res.data.answers as unknown as Record<string, Record<string, unknown>>;
    const usage = readUsage(res.data.raw);
    const noul = answers.entry_go ?? {};
    const dir = answers.direction ?? {};
    const str = answers.setup_strength ?? {};
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      ok: true, ms, imageCount: visionRes.image ? 1 : 0,
      p: num(noul.noul ?? noul.probability),
      direction: typeof dir.choice === "string" ? dir.choice : null,
      strength: num(str.score),
      imageTokens: usage.imageTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      requestId: res.data.requestId,
      detail: `png_bytes=${visionRes.bytes} cached=${visionRes.cached} reason=${visionRes.reason ?? "-"}`,
    };
  };

  console.log("[1] DREX_VISION_ENABLED=0 (tanpa gambar) - jalur produksi");
  const a = await runOnce(false);
  console.log(`    ok=${a.ok} latency=${a.ms}ms imageCount=${a.imageCount}`);
  console.log(`    entry_go p=${a.p}  direction=${a.direction}  strength=${a.strength}`);
  console.log(`    usage: input_tokens=${a.inputTokens} output_tokens=${a.outputTokens} image_tokens=${a.imageTokens}`);
  console.log(`    request_id=${a.requestId}  ${a.detail}`);
  console.log("");

  console.log("[2] DREX_VISION_ENABLED=1 (DENGAN gambar PNG dari renderer server)");
  const b = await runOnce(true);
  console.log(`    ok=${b.ok} latency=${b.ms}ms imageCount=${b.imageCount}`);
  console.log(`    entry_go p=${b.p}  direction=${b.direction}  strength=${b.strength}`);
  console.log(`    usage: input_tokens=${b.inputTokens} output_tokens=${b.outputTokens} image_tokens=${b.imageTokens}`);
  console.log(`    request_id=${b.requestId}  ${b.detail}`);
  console.log("");

  console.log("[3] cache check (panggil lagi flag ON, key sama)");
  const c = await runOnce(true);
  console.log(`    ok=${c.ok} latency=${c.ms}ms  ${c.detail}`);
  console.log("");

  console.log("== RINGKASAN ==");
  console.log(`  tanpa gambar  : ok=${a.ok} ${a.ms}ms image_tokens=${a.imageTokens} p=${a.p} strength=${a.strength}`);
  console.log(`  dengan gambar: ok=${b.ok} ${b.ms}ms image_tokens=${b.imageTokens} p=${b.p} strength=${b.strength}`);
  console.log(`  delta latensi : ${b.ms - a.ms} ms`);
  console.log(`  delta p       : ${a.p !== null && b.p !== null ? (b.p - a.p).toFixed(6) : "n/a"}`);
  console.log(`  IMAGE_TOKENS_GT_0 : ${b.imageTokens !== null && b.imageTokens > 0 ? "YA" : "TIDAK"}`);
  console.log(`  VERDICT_BERUBAH  : ${a.p !== null && b.p !== null && a.p !== b.p ? "YA" : "TIDAK"}`);
  console.log(`  CACHE_REUSED      : ${c.detail.includes("cached=true") ? "YA" : "TIDAK"}`);
}

void main();
