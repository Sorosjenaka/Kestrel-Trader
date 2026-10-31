import type { Bar } from "../universe/eligibility.js";

/** Mode is persisted on the position; shared strategy IDs cannot identify a lane. */
export function countPositionsByMode(positions: ReadonlyArray<{ mode?: string | null }>): { SCALP: number; SWING: number } {
  const counts = { SCALP: 0, SWING: 0 };
  for (const position of positions) counts[position.mode?.toUpperCase() === "SWING" ? "SWING" : "SCALP"]++;
  return counts;
}

type MrvContext = { m5Bars: Bar[]; dailyBars: Bar[] };
type Fetcher = (symbol: string, interval: string, limit: number) => Promise<unknown[]>;
const mrvCache = new Map<string, { expiresAt: number; value: Promise<MrvContext> }>();
const toBars = (rows: unknown[]): Bar[] => rows.map((row) => {
  const values = row as unknown[];
  return { openTime: Number(values[0]), open: Number(values[1]), high: Number(values[2]),
    low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]) };
}).filter((bar) => Object.values(bar).every(Number.isFinite) && bar.openTime > 0 && bar.close > 0);

/** Dedicated data leaves the normal 90-bar MTF indicators unchanged. Failed fetches stay fail-closed. */
export async function loadScalpMrvContext(symbol: string, allowedIds: string[], fetcher: Fetcher,
  now = Date.now()): Promise<MrvContext | undefined> {
  if (!allowedIds.includes("S-04")) return undefined;
  const cached = mrvCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = Promise.all([fetcher(symbol, "5m", 300), fetcher(symbol, "1d", 100)])
    .then(([m5, daily]) => ({ m5Bars: toBars(m5), dailyBars: toBars(daily) }))
    .catch(() => { mrvCache.delete(symbol); return { m5Bars: [], dailyBars: [] }; });
  if (mrvCache.size >= 512) mrvCache.delete(mrvCache.keys().next().value!);
  mrvCache.set(symbol, { expiresAt: now + 60_000, value });
  return value;
}

// ── T0.6 (19 Okt 2026): data RSW untuk lane SWING ─────────────────────────────
// buildRswPlans (strategies/researchSwing/rswPlans.ts) butuh h4Bars (>= 200),
// h1BarsLong (>= 801 utk RSW-03) dan btcDailyBars (gate BTC_D1_ALIGN kaki BOS
// RSW-01). Tanpa field ini RSW gagal TERTUTUP (tidak pernah mengarang sinyal).
// Loader ini memasoknya dari fetchKlines dengan cache + anti-lookahead (bar
// berjalan dipotong), konsisten dengan analyzeSwingTimeframe.

type RswContext = { h4Bars?: Bar[]; h1BarsLong?: Bar[]; btcDailyBars?: Bar[] };

const rswCache = new Map<string, { expiresAt: number; value: Promise<RswContext> }>();
let btcD1Cache: { expiresAt: number; value: Promise<Bar[]> } | null = null;

const TF_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/** Konversi kline mentah (array Binance ATAU object {openTime}) + buang bar berjalan. */
function toClosedBars(rows: unknown[], intervalMs: number, now: number): Bar[] {
  const raw = Array.isArray(rows) ? [...rows] : [];
  const last = raw[raw.length - 1] as unknown;
  const lastOpenTime = Array.isArray(last)
    ? Number(last[0])
    : Number((last as { openTime?: unknown } | undefined)?.openTime);
  if (raw.length && Number.isFinite(lastOpenTime) && now - lastOpenTime < intervalMs) raw.pop();
  return raw.map((row) => {
    const values = Array.isArray(row) ? row : (row as Record<string, unknown>);
    const get = (i: number, k: string) => (Array.isArray(values) ? values[i] : values[k]);
    return {
      openTime: Number(get(0, "openTime")), open: Number(get(1, "open")),
      high: Number(get(2, "high")), low: Number(get(3, "low")),
      close: Number(get(4, "close")), volume: Number(get(5, "volume")),
    };
  }).filter((bar) => Object.values(bar).every(Number.isFinite) && bar.openTime > 0 && bar.close > 0);
}

/** BTC D1 dibagi semua simbol (satu fetch untuk seluruh funnel SWING). */
async function loadBtcDailyBars(fetcher: Fetcher, now: number): Promise<Bar[]> {
  if (btcD1Cache && btcD1Cache.expiresAt > now) return btcD1Cache.value;
  const value = fetcher("BTCUSDT", "1d", 1000)
    .then((rows) => toClosedBars(rows, TF_MS["1d"]!, now))
    .catch(() => [] as Bar[]);
  btcD1Cache = { expiresAt: now + 600_000, value };
  return value;
}

/**
 * Data khusus RSW: H4 (RSW-01/02/03), H1 panjang (RSW-03), BTC D1 (RSW-01).
 * Hanya fetch yang dibutuhkan allowlist (hemat rate limit). Fetch gagal/kosong
 * = field kosong = leg terkait gagal TERTUTUP di buildRswPlans — tidak pernah
 * mengarang sinyal. Tanpa RSW di allowlist: return undefined, nol fetch.
 */
export async function loadSwingRswContext(
  symbol: string,
  allowedIds: string[],
  fetcher: Fetcher,
  now = Date.now()
): Promise<RswContext | undefined> {
  const allow = new Set(allowedIds.map((s) => s.trim().toUpperCase()));
  const wantRsw = [...allow].some((id) => id.startsWith("RSW-"));
  if (!wantRsw) return undefined;
  const cached = rswCache.get(symbol);
  if (cached && cached.expiresAt > now) return cached.value;
  const needH1Long = allow.has("RSW-03");
  const needBtc = allow.has("RSW-01");
  // H4: 1000 (maks API -> 999 bar tertutup). Probe 19 Okt: generateH4 punya
  // gate warmup ~800 bar — window < itu tidak pernah emit; 999 bar mereproduksi
  // 297/297 sinyal fixture parity (identik dengan full history). JANGAN diperkecil.
  // BTC D1: 1000 hari (bukan 250 — probe 19 Okt: EMA200 pada regime BTC butuh
  // >= ~500 bar hangat; suplai 250 hari membuat gate BTC_D1_ALIGN kaki BOS_LONG
  // RSW-01 meleset dari oracle riset).
  const value = Promise.all([
    fetcher(symbol, "4h", 1000).catch(() => [] as unknown[]),
    needH1Long ? fetcher(symbol, "1h", 900).catch(() => [] as unknown[]) : Promise.resolve([] as unknown[]),
    needBtc ? loadBtcDailyBars(fetcher, now) : Promise.resolve([] as Bar[]),
  ]).then(([h4Raw, h1Raw, btcBars]) => ({
    h4Bars: toClosedBars(h4Raw, TF_MS["4h"]!, now),
    ...(needH1Long ? { h1BarsLong: toClosedBars(h1Raw, TF_MS["1h"]!, now) } : {}),
    ...(needBtc ? { btcDailyBars: btcBars } : {}),
  })).catch(() => { rswCache.delete(symbol); return {}; });
  if (rswCache.size >= 512) rswCache.delete(rswCache.keys().next().value!);
  rswCache.set(symbol, { expiresAt: now + 60_000, value });
  return value;
}
