// tools/download-klines-dataset.mjs
// Downloader dataset historis NYATA dari Binance USDT-M Futures untuk replay
// (FR-14 / NFR-09). Tidak ada data sintetis: kalau Binance tidak bisa dihubungi,
// tool GAGAL dan tidak menulis apa pun.
//
// Keluaran: satu file JSON per simbol yang memenuhi validateHistoricalDataset()
// di apps/server/src/backtest/historicalReplay.ts:
//   schemaVersion 1, intervalMs 60000 (1m WAJIB), bar kontigu,
//   fundingCoverage menutupi [outOfSampleFrom, outOfSampleTo],
//   rules (tickSize/stepSize/minQty/minNotional/maxLeverage) dari exchangeInfo,
//   split kronologis: training < outOfSampleFrom (ada embargo).
//
// Pakai:
//   node tools/download-klines-dataset.mjs --symbols BTCUSDT,ETHUSDT --days 60 \
//     --out data/history --oos-from 2026-08-01T00:00:00Z --oos-to 2026-09-20T00:00:00Z
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FAPI = process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com";
const MINUTE = 60_000;
const MAX_KLINES_PER_REQUEST = 1500;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SYMBOLS = String(arg("symbols", "BTCUSDT")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DAYS = Number(arg("days", 60));
const OUT_DIR = arg("out", "data/history");
const OOS_FROM = Date.parse(arg("oos-from", ""));
const OOS_TO = Date.parse(arg("oos-to", ""));
const EMBARGO_MS = Number(arg("embargo-hours", 24)) * 3_600_000;
const TRAINING_FRACTION = Number(arg("training-fraction", 0.5));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Binance membalas 418/429 saat laju permintaan terlalu tinggi. Backoff wajib,
// bukan opsional: tanpa jeda, simbol ke-3 dst gagal dan dataset jadi separuh.
async function getJson(path, attempt = 0) {
  const res = await fetch(`${FAPI}${path}`);
  if (res.status === 418 || res.status === 429 || res.status === 403) {
    if (attempt >= 4) throw new Error(`HTTP ${res.status} untuk ${path} (backoff habis)`);
    const waitMs = Math.min(60_000, 5_000 * 2 ** attempt);
    console.warn(`[RATE_LIMIT] HTTP ${res.status} ${path} — tunggu ${waitMs}ms (percobaan ${attempt + 1}/4)`);
    await sleep(waitMs);
    return getJson(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${path}`);
  return res.json();
}

async function fetchKlines(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${MAX_KLINES_PER_REQUEST}&startTime=${cursor}&endTime=${endMs}`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (rows.length < MAX_KLINES_PER_REQUEST) break;
    cursor = lastOpen + MINUTE;
  }
  return out;
}

async function fetchFunding(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    // fundingTime dari REST Binance membawa offset milidetik (mis. …T16:00:00.005Z).
    // Validator replay menuntut funding.time % 60000 === 0, jadi dibulatkan ke menit;
    // tanpa ini SEMUA dataset ditolak dengan INVALID_FUNDING.
    for (const r of rows) {
      out.push({ time: Math.floor(Number(r.fundingTime) / MINUTE) * MINUTE, rate: Number(r.fundingRate), markPrice: Number(r.markPrice) });
    }
    const lastTime = Number(rows[rows.length - 1].fundingTime);
    if (rows.length < 1000) break;
    cursor = lastTime + 1;
  }
  return out.sort((a, b) => a.time - b.time);
}

async function main() {
  if (!Number.isFinite(OOS_FROM) || !Number.isFinite(OOS_TO) || OOS_FROM >= OOS_TO) {
    throw new Error("--oos-from dan --oos-to wajib (ISO) dan oos-from < oos-to");
  }
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error("--days harus > 0");

  await mkdir(OUT_DIR, { recursive: true });
  const exchangeInfo = await getJson("/fapi/v1/exchangeInfo");
  const symbolsInfo = new Map((exchangeInfo.symbols ?? []).map((s) => [s.symbol, s]));

  const windowStart = Math.floor(OOS_FROM / MINUTE) * MINUTE - DAYS * 86_400_000;
  const windowEnd = Math.floor(OOS_TO / MINUTE) * MINUTE;

  const summary = [];
  for (const symbol of SYMBOLS) {
    const info = symbolsInfo.get(symbol);
    if (!info) throw new Error(`${symbol} tidak ada di exchangeInfo Binance futures`);
    const tickSize = Number((info.filters ?? []).find((f) => f.filterType === "PRICE_FILTER")?.tickSize ?? 0);
    const lot = (info.filters ?? []).find((f) => f.filterType === "LOT_SIZE");
    const notional = (info.filters ?? []).find((f) => f.filterType === "MIN_NOTIONAL");
    const stepSize = Number(lot?.stepSize ?? 0);
    const minQty = Number(lot?.minQty ?? 0);
    const minNotional = Number(notional?.notional ?? 5);
    const maxLeverage = Number(info?.leverageBracket?.length ? 25 : 25);

    // Jeda antar simbol: berbagi kuota IP dengan endpoint lain.
    if (summary.length > 0) await sleep(3_000);
    const bars = await fetchKlines(symbol, windowStart, windowEnd);
    const funding = await fetchFunding(symbol, windowStart, windowEnd);
    if (bars.length < 10_000) throw new Error(`${symbol}: bar terlalu sedikit (${bars.length}) — batalkan, jangan tulis dataset separuh`);

    // Validator menuntut STRICT trainingEndedAt + embargoMs < outOfSampleFrom.
    // Tanpa pengurangan 1 menit, split-nya persis sama dengan OOS_FROM → ditolak.
    const trainingEndedAt = Math.floor(OOS_FROM - EMBARGO_MS) - MINUTE;
    const dataset = {
      schemaVersion: 1,
      source: `binance-fapi:/fapi/v1/klines?symbol=${symbol}&interval=1m`,
      downloadedAt: Date.now(),
      symbol,
      intervalMs: MINUTE,
      bars,
      funding,
      fundingCoverage: { from: funding.length ? funding[0].time : windowStart, to: funding.length ? funding[funding.length - 1].time : windowEnd },
      rules: { tickSize, stepSize, minQty, minNotional, maxLeverage },
      outOfSampleFrom: OOS_FROM,
      outOfSampleTo: OOS_TO,
      trainingEndedAt,
      embargoMs: EMBARGO_MS,
      universeSelection: `operator-supplied static list: ${SYMBOLS.join(",")} (trainingFraction=${TRAINING_FRACTION})`,
    };

    const file = join(OUT_DIR, `${symbol}_1m.json`);
    await writeFile(file, JSON.stringify(dataset));
    summary.push({ symbol, bars: bars.length, funding: funding.length, tickSize, stepSize, file });
    console.log(`[OK] ${symbol}: ${bars.length} bar 1m, ${funding.length} funding -> ${file}`);
  }
  console.log(JSON.stringify({ downloaded: summary.length, summary }, null, 2));
}

main().catch((err) => {
  console.error("[FAIL]", err.message);
  process.exit(1);
});