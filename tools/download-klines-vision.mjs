// tools/download-klines-vision.mjs
// Downloader dataset historis NYATA dari arsip publik Binance (data.binance.vision)
// + REST fundingRate, untuk replay (FR-14 / NFR-09). TIDAK ADA data sintetis.
//
// Alasan tool ini ada: endpoint /fapi/v1/klines dengan limit=1500 kena rate limit
// HTTP 418 di IP ini, sehingga simbol ke-3 dst gagal dan dataset jadi separuh.
// Arsip data.binance.vision tidak terkena rate limit itu.
//
// Sumber (semua data nyata Binance USDT-M Futures):
//   klines  : monthly/<SYM>/1m/<SYM>-1m-YYYY-MM.zip  dan  daily/.../<SYM>-1m-YYYY-MM-DD.zip
//   funding : /fapi/v1/fundingRate (REST; menyertakan markPrice)
//
// Keluaran: satu file JSON per simbol yang memenuhi validateHistoricalDataset()
// (apps/server/src/backtest/historicalReplay.ts).
//
// Pakai:
//   node tools/download-klines-vision.mjs --symbols SOLUSDT,BNBUSDT \
//     --oos-from 2026-09-01T00:00:00Z --oos-to 2026-09-25T00:00:00Z --days 45
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const VISION = process.env.BINANCE_VISION_BASE ?? "https://data.binance.vision";
const FAPI = process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com";
const MINUTE = 60_000;
const DAY = 86_400_000;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SYMBOLS = String(arg("symbols", "BTCUSDT")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const DAYS = Number(arg("days", 45));
const OUT_DIR = arg("out", "data/history");
const OOS_FROM = Date.parse(arg("oos-from", ""));
const OOS_TO = Date.parse(arg("oos-to", ""));
const EMBARGO_MS = Number(arg("embargo-hours", 24)) * 3_600_000;
const TRAINING_FRACTION = Number(arg("training-fraction", 0.5));
const TMP = process.env.HERMES_SCRATCH ?? process.env.TMPDIR ?? ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP dengan retry. exchangeInfo sempat membalas 418 dan lolos di percobaan
// berikutnya, jadi retry itu wajib, bukan kemewahan.
// ---------------------------------------------------------------------------
async function getJson(path, attempt = 0) {
  const res = await fetch(`${FAPI}${path}`);
  if (res.status === 418 || res.status === 429 || res.status === 403) {
    if (attempt >= 6) throw new Error(`HTTP ${res.status} untuk ${path} (retry habis)`);
    const waitMs = Math.min(60_000, 4_000 * 2 ** attempt);
    console.warn(`[RATE_LIMIT] HTTP ${res.status} ${path} — tunggu ${waitMs}ms (percobaan ${attempt + 1}/6)`);
    await sleep(waitMs);
    return getJson(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Arsip: unduh zip, ekstrak dengan `unzip -p` (tersedia di host ini).
// ---------------------------------------------------------------------------
// CATATAN: unduhan pakai `curl`, bukan fetch(). Di host ini fetch() GET ke
// data.binance.vision sempat membalas 404 walau HEAD/curl membalas 200.
// PENTING: 404 dari Vision TERBUKTI TRANSIEN — URL yang sama bisa 404 di satu
// percobaan lalu 200 di percobaan berikutnya (rate/bot mitigation di edge S3).
// Karena itu 404 TIDAK boleh langsung dianggap "arsip belum ada"; wajib retry
// dulu. Kalau setelah semua retry masih 404, barulah dianggap tidak ada.
//
// CATATAN --oos-to: funding terakhir pada arsip ini jatuh di jam 16:00 UTC hari
// terakhir; fundingCoverage.to < outOfSampleTo akan ditolak validator
// (MISSING_FUNDING_COVERAGE). Pilih --oos-to <= funding terakhir, bukan tengah malam.
const ARCHIVE_ATTEMPTS = 5;
async function fetchArchiveCsv(kind, symbol, period, tag) {
  // Struktur arsip Vision: klines punya segmen interval (…/<SYM>/1m/<SYM>-1m-<tag>.zip)
  // sedangkan fundingRate tidak (…/<SYM>/<SYM>-fundingRate-<tag>.zip).
  // Tanpa segmen interval ini, semua URL klines membalas 404.
  const intervalSegment = kind === "klines" ? "/1m" : "";
  const url = `${VISION}/data/futures/um/${period}/${kind}/${symbol}${intervalSegment}/${symbol}-${tag}.zip`;
  const file = join(TMP, `vision-${symbol}-${kind}-${tag}.zip`);
  let lastCode = "?";
  // stdio dikunci eksplisit: kalau tidak, stderr child bocor ke stderr Node
  // ("stdin is not a tty" dll) dan mengotori log.
  const STDIO = ["ignore", "pipe", "pipe"];
  for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(Math.min(15_000, 1_000 * 2 ** (attempt - 1)));
    try {
      lastCode = execFileSync("curl", ["-sL", "-o", file, "-w", "%{http_code}", url], { maxBuffer: 8 * 1024 * 1024, stdio: STDIO }).toString().trim();
    } catch (err) {
      lastCode = `EXEC_ERR:${err.status ?? err.message}`;
      continue;
    }
    if (lastCode === "200") {
      try {
        return execFileSync("unzip", ["-p", file], { maxBuffer: 512 * 1024 * 1024, stdio: STDIO }).toString("utf8");
      } finally {
        await unlink(file).catch(() => {});
      }
    }
    // 404/403/429/5xx: buang artefak lalu coba lagi.
    await unlink(file).catch(() => {});
  }
  if (lastCode === "404") {
    console.warn(`[ARCHIVE_MISS] 404 setelah ${ARCHIVE_ATTEMPTS} percobaan: ${url}`);
    return null; // barulah sekarang dianggap belum ada arsipnya
  }
  throw new Error(`HTTP ${lastCode} untuk ${url} (setelah ${ARCHIVE_ATTEMPTS} percobaan)`);
}

/** Baris CSV arsip klines: 12 kolom, baris pertama bisa berupa header. */
function parseKlinesCsv(csv) {
  const out = [];
  for (const line of csv.split("\n")) {
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 6) continue;
    const openTime = Number(c[0]);
    if (!Number.isFinite(openTime)) continue; // header
    out.push({
      openTime,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    });
  }
  return out;
}

function monthTag(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function dayTag(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Kumpulkan bar 1m nyata pada [startMs, endMs): bulanan bila ada, harian untuk sisanya. */
async function fetchBars(symbol, startMs, endMs) {
  const byTime = new Map();
  const add = (bars) => {
    for (const b of bars) if (b.openTime >= startMs && b.openTime < endMs) byTime.set(b.openTime, b);
  };

  // Bulan-bulan penuh yang tercakup; bulan berjalan (arsip belum ada) jatuh ke harian.
  const cursor = new Date(Math.floor(startMs / DAY) * DAY);
  const endDate = new Date(endMs);
  const monthlyMisses = [];
  while (cursor < endDate) {
    const tag = monthTag(cursor);
    const csv = await fetchArchiveCsv("klines", symbol, "monthly", `1m-${tag}`);
    if (csv) add(parseKlinesCsv(csv));
    else monthlyMisses.push(tag);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
    await sleep(250);
  }

  if (monthlyMisses.length) {
    console.log(`[INFO] ${symbol}: arsip bulanan belum ada untuk ${monthlyMisses.join(", ")} — pakai arsip harian`);
  }

  // Harian: tutup setiap celah (termasuk hari-hari di bulan tanpa arsip bulanan).
  for (let t = Math.floor(startMs / DAY) * DAY; t < endMs; t += DAY) {
    const d = new Date(t);
    const tag = dayTag(d);
    if (!monthlyMisses.includes(monthTag(d))) continue;
    const csv = await fetchArchiveCsv("klines", symbol, "daily", `1m-${tag}`);
    if (!csv) continue;
    add(parseKlinesCsv(csv));
    await sleep(120);
  }

  const bars = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  return bars;
}

async function fetchFunding(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const rows = await getJson(`/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    // fundingTime dari REST Binance membawa offset milidetik (mis. …T16:00:00.005Z).
    // Validator replay menuntut funding.time % 60000 === 0, jadi dibulatkan ke menit;
    // tanpa ini SEMUA dataset ditolak dengan INVALID_FUNDING.
    for (const r of rows) out.push({ time: Math.floor(Number(r.fundingTime) / MINUTE) * MINUTE, rate: Number(r.fundingRate), markPrice: Number(r.markPrice) });
    const last = Number(rows[rows.length - 1].fundingTime);
    if (rows.length < 1000) break;
    cursor = last + 1;
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

  const windowStart = Math.floor(OOS_FROM / MINUTE) * MINUTE - DAYS * DAY;
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
    const maxLeverage = 25;

    if (summary.length > 0) await sleep(1_000);
    const bars = await fetchBars(symbol, windowStart, windowEnd);
    const funding = await fetchFunding(symbol, windowStart, windowEnd);
    if (bars.length < 10_000) throw new Error(`${symbol}: bar terlalu sedikit (${bars.length}) — batalkan, jangan tulis dataset separuh`);

    // Bar kontigu wajib; kalau ada lubang, hentikan alih-alih mengisi harga karangan.
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].openTime !== bars[i - 1].openTime + MINUTE) {
        throw new Error(`${symbol}: bar tidak kontigu di ${new Date(bars[i].openTime).toISOString()} (${bars.length} bar)`);
      }
    }

    // Validator menuntut STRICT trainingEndedAt + embargoMs < outOfSampleFrom.
    // Tanpa pengurangan 1 menit, split-nya persis sama dengan OOS_FROM → ditolak.
    const trainingEndedAt = Math.floor(OOS_FROM - EMBARGO_MS) - MINUTE;
    const dataset = {
      schemaVersion: 1,
      source: `binance-vision:data/futures/um/{monthly,daily}/klines/${symbol}/1m + fapi:/fapi/v1/fundingRate`,
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
    summary.push({ symbol, bars: bars.length, funding: funding.length, from: new Date(bars[0].openTime).toISOString(), to: new Date(bars.at(-1).openTime).toISOString(), tickSize, stepSize, file });
    console.log(`[OK] ${symbol}: ${bars.length} bar 1m, ${funding.length} funding -> ${file}`);
  }
  console.log(JSON.stringify({ downloaded: summary.length, summary }, null, 2));
}

main().catch((err) => {
  console.error("[FAIL]", err.message);
  // JANGAN process.exit(1) di sini. Saat stdout/stderr di-redirect ke file di
  // Windows, console.log/error masih ada di buffer async; exit() langsung
  // memotongnya sehingga log jadi kosong walau ada error nyata (gejalanya:
  // log hanya berisi "stdin is not a tty" lalu EXIT=1).
  // process.exitCode membuat Node keluar sendiri setelah buffer di-flush.
  process.exitCode = 1;
});