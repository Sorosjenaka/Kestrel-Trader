// apps/server/src/engines/perceptionB4.ts
// Big Brain Tahap B4 (14 Okt 2026): fitur persepsi L1 yang hilang —
// Open Interest (perubahan OI 30 menit) dan beta terhadap BTC.
//
// KONTRAK:
//  - FITUR SAJA (bukan gate): nilainya mengalir ke DecisionLog untuk kalibrasi
//    Tahap C. Tidak ada keputusan trading yang bergantung padanya di tahap ini.
//  - Fail-open: setiap kegagalan fetch/hitung mengembalikan null — scan tidak
//    boleh gagal karena fitur persepsi.
//  - REST hemat: OI per simbol di-cache TTL 5 menit (hist 5m tidak berubah
//    cepat); bar BTC di-cache TTL 60 detik dan dipakai bersama semua simbol.
//  - Semua angka TS deterministik (Golden Rule §1) — tanpa LLM.
//
// 24 Okt 2026 (BUG FIX kolom kosong di Live Market Scanner):
//  Fungsi lama mengembalikan `number | null` tanpa alasan. UI hanya bisa
//  menulis "—", sehingga operator tidak bisa membedakan "metrik memang tak
//  tersedia" dari "komputasinya mati". Sekarang setiap metrik mengembalikan
//  STATUS eksplisit (`OK` / `NO_DATA` / `INSUFFICIENT_SAMPLES` / `FETCH_FAILED`)
//  beserta nilainya — TIDAK PERNAH mengarang angka.
import type { Bar } from "../universe/eligibility.js";
import { klinesToBars } from "./multiTimeframeAnalyzer.js";

interface OiHistPoint { sumOpenInterest: string; timestamp: number }

/**
 * Status satu metrik persepsi. `value` hanya terisi saat status = "OK".
 * - OK                   : nilai sah, terisi.
 * - NO_DATA              : endpoint menjawab, tapi isi tidak cukup/layak.
 * - INSUFFICIENT_SAMPLES : bar/histori kurang dari ambang statistik.
 * - FETCH_FAILED         : endpoint gagal (jaringan/404/429/host mati).
 */
export type PerceptionStatus = "OK" | "NO_DATA" | "INSUFFICIENT_SAMPLES" | "FETCH_FAILED";

export interface PerceptionResult<T> {
  value: T | null;
  status: PerceptionStatus;
  /** Alasan singkat, aman ditampilkan (tanpa secret/URL penuh). */
  reason: string;
}

const oiCache = new Map<string, { result: PerceptionResult<number>; at: number }>();
let btcBarsCache: { bars: Bar[] | null; at: number; reason: string } | null = null;

const OI_TTL_MS = 5 * 60_000;
const BTC_BARS_TTL_MS = 60_000;

/** Fetcher disuntik (binanceFuturesClient.fetchPublic) agar modul bisa di-test. */
export type FetchPublicFn = <T>(path: string) => Promise<{ data: T }>;

/**
 * Perubahan Open Interest % selama ~30 menit terakhir (6 titik hist 5m).
 * OI naik + harga naik = tren sehat; OI naik + harga turun = tekanan short.
 * Fail-open: kegagalan TIDAK melempar, hanya reported lewat `status`.
 */
export async function fetchOpenInterestChangePct(
  symbol: string,
  fetchPublic: FetchPublicFn,
  nowMs = Date.now()
): Promise<PerceptionResult<number>> {
  const cached = oiCache.get(symbol);
  if (cached && nowMs - cached.at < OI_TTL_MS) return cached.result;
  const result = await computeOiChange(symbol, fetchPublic);
  oiCache.set(symbol, { result, at: nowMs });
  return result;
}

async function computeOiChange(symbol: string, fetchPublic: FetchPublicFn): Promise<PerceptionResult<number>> {
  try {
    const res = await fetchPublic<{ data: OiHistPoint[] }>(
      `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=7`
    );
    const pts = res.data;
    if (!Array.isArray(pts) || pts.length < 2) {
      return { value: null, status: "NO_DATA", reason: `OI_HIST_EMPTY(${Array.isArray(pts) ? pts.length : 0})` };
    }
    const first = Number(pts[0]!.sumOpenInterest);
    const last = Number(pts[pts.length - 1]!.sumOpenInterest);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) {
      return { value: null, status: "NO_DATA", reason: "OI_HIST_NON_NUMERIC" };
    }
    const pct = ((last - first) / first) * 100;
    if (!Number.isFinite(pct)) {
      return { value: null, status: "NO_DATA", reason: "OI_PCT_NOT_FINITE" };
    }
    return { value: pct, status: "OK", reason: "OI_HIST_OK" };
  } catch (e) {
    // Endpoint 404/403/429/host mati semuanya berakhir di sini. Nama error
    // dinormalisasi supaya UI bisa menampilkan "OI n/a (fetch gagal)".
    const msg = e instanceof Error ? e.message : String(e);
    const code = /\b(4\d\d|5\d\d)\b/.exec(msg)?.[1];
    return { value: null, status: "FETCH_FAILED", reason: code ? `OI_FETCH_HTTP_${code}` : "OI_FETCH_FAILED" };
  }
}

/**
 * Beta simbol terhadap BTC: cov(r_s, r_btc) / var(r_btc) dari return log
 * per-bar 5m (maks 200 bar terakhir, min 50 bar agar bermakna).
 * Beta > 1 = mengikuti BTC dengan amplifikasi; ~0 = bergerak sendiri.
 *
 * 24 Okt 2026: versi lama mengembalikan `null` tanpa alasan sehingga UI
 * menulis "—". Sekarang statusnya eksplisit (lihat PerceptionStatus).
 */
export function calculateBetaBtc(symBars: Bar[], btcBars: Bar[] | null): PerceptionResult<number> {
  if (!btcBars) {
    return { value: null, status: "FETCH_FAILED", reason: "BETA_NO_BTC_REFERENCE" };
  }
  if (btcBars.length < 51) {
    return { value: null, status: "INSUFFICIENT_SAMPLES", reason: `BETA_BTC_BARS_${btcBars.length}_LT_51` };
  }
  if (symBars.length < 51) {
    // Kandidat ini datang dari TF STRUKTUR 5m dengan limit 90 bar, jadi 51 bar
    // SEHARUSNYA ada. reaching sini = fetch klines gagal/kurang (fail-open).
    return { value: null, status: "INSUFFICIENT_SAMPLES", reason: `BETA_SYM_BARS_${symBars.length}_LT_51` };
  }
  const n = Math.min(symBars.length, btcBars.length, 200);
  const symRet = logReturns(symBars.slice(-n));
  const btcRet = logReturns(btcBars.slice(-n));
  if (symRet.length !== btcRet.length || symRet.length < 50) {
    return { value: null, status: "INSUFFICIENT_SAMPLES", reason: `BETA_RETURNS_${symRet.length}_LT_50` };
  }
  const meanS = avg(symRet);
  const meanB = avg(btcRet);
  let cov = 0, varB = 0;
  for (let i = 0; i < symRet.length; i++) {
    const ds = symRet[i]! - meanS;
    const db = btcRet[i]! - meanB;
    cov += ds * db;
    varB += db * db;
  }
  if (varB <= 0) {
    return { value: null, status: "NO_DATA", reason: "BETA_ZERO_VARIANCE_BTC" };
  }
  const beta = cov / varB;
  if (!Number.isFinite(beta)) {
    return { value: null, status: "NO_DATA", reason: "BETA_NOT_FINITE" };
  }
  return { value: beta, status: "OK", reason: "BETA_OK" };
}

function logReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const cur = bars[i]!.close;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

function avg(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length > 0 ? s / xs.length : 0;
}

/**
 * Bar BTC 5m untuk beta — di-cache 60 detik, dipakai bersama semua simbol.
 *
 * 24 Okt 2026: ikut membawa status agar UI bisa bilang "BETA n/a (ref BTC
 * tak termuat)" alih-alih "—" yang ambigu.
 */
export async function getBtcReferenceBars(
  fetchKlines: (s: string, i: string, l: number) => Promise<unknown[]>,
  nowMs = Date.now()
): Promise<{ bars: Bar[] | null; status: PerceptionStatus; reason: string }> {
  if (btcBarsCache && nowMs - btcBarsCache.at < BTC_BARS_TTL_MS) {
    return {
      bars: btcBarsCache.bars,
      status: btcBarsCache.bars ? "OK" : "FETCH_FAILED",
      reason: btcBarsCache.reason,
    };
  }
  let bars: Bar[] | null = null;
  let status: PerceptionStatus = "OK";
  let reason = "BTC_REF_OK";
  try {
    const raw = await fetchKlines("BTCUSDT", "5m", 201);
    const mapped = klinesToBars(raw);
    if (mapped.length >= 51) {
      bars = mapped;
    } else {
      status = "INSUFFICIENT_SAMPLES";
      reason = `BTC_REF_BARS_${mapped.length}_LT_51`;
    }
  } catch {
    bars = null;
    status = "FETCH_FAILED";
    reason = "BTC_REF_FETCH_FAILED";
  }
  btcBarsCache = { bars, at: nowMs, reason };
  return { bars, status, reason };
}

/** Hanya untuk test. */
export function resetPerceptionCaches(): void {
  oiCache.clear();
  btcBarsCache = null;
}
