// apps/server/src/lab/labKlines.ts — Pengambil kline read-only untuk Lab (CP-7).
// REST publik Binance Futures (market data saja — tidak pernah menyentuh order).
// Paging startTime/endTime, maks 1500 bar per request.
export interface LabBar { t: number; o: number; h: number; l: number; c: number; v: number; }

const FAPI = process.env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com";

export async function fetchLabKlines(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  maxBars = 60_000,
): Promise<LabBar[]> {
  const out: LabBar[] = [];
  let cursor = fromMs;
  const pages = Math.ceil(maxBars / 1500) + 1;
  for (let p = 0; p < pages && cursor < toMs && out.length < maxBars; p++) {
    const url = `${FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    const res = await fetch(url, { headers: { "User-Agent": "artatrade-lab/1.0" } });
    if (!res.ok) throw new Error(`klines HTTP ${res.status} untuk ${symbol} ${interval}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows as unknown[][]) {
      out.push({
        t: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
        l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      });
    }
    const lastT = Number((rows[rows.length - 1] as unknown[])[0]);
    if (!(lastT > cursor)) break;
    cursor = lastT + 1;
    if (rows.length < 1500) break;
  }
  return out.slice(0, maxBars);
}

/** Interval -> ms, untuk validasi rentang. */
export function intervalMs(interval: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
  };
  return map[interval] ?? 300_000;
}
