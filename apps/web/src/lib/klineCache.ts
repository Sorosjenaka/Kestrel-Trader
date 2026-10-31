// Shared public-kline request cache. This is a read-only browser cache for
// chart panels with the same venue/symbol/interval/window; it never touches
// account, order, or execution state.
//
// 29 Okt 2026 (fix "chart stuck"): sebelumnya fetch tanpa timeout — satu
// request yang menggantung membuat semua retry berikut untuk key yang sama
// ikut menggantung selamanya (inflight map mengembalikan promise mati).
// Sekarang: AbortController timeout 8 dtk per request dan inflight dibersihkan
// di finally tanpa syarat (kontrak tes: abort 8s membersihkan inflight).
type Entry = { at: number; rows: unknown[] };
const CACHE_TTL_MS = 4_000;
const FETCH_TIMEOUT_MS = 8_000;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown[]>>();

function key(symbol: string, interval: string, limit: number, endTime?: number): string {
  return `${symbol.toUpperCase()}|${interval}|${limit}|${endTime ?? "latest"}`;
}

/** Ekspor untuk tes: apakah masih ada request yang belum selesai untuk key tsb. */
export function hasInflight(symbol: string, interval: string, limit: number, endTime?: number): boolean {
  return inflight.has(key(symbol, interval, limit, endTime));
}

export async function fetchKlineRows(symbol: string, interval: string, limit: number, endTime?: number): Promise<unknown[]> {
  const k = key(symbol, interval, limit, endTime);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = (async () => {
    const range = endTime !== undefined ? `&endTime=${Math.floor(endTime)}` : "";
    // Timeout 8 dtk: request gantung dibatalkan sehingga pemanggil bisa retry,
    // bukan menunggu selamanya (sumber "chart load stuck").
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/binance/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}${range}`, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = Array.isArray(json?.klines) ? json.klines : [];
      cache.set(k, { at: Date.now(), rows });
      return rows;
    } finally {
      clearTimeout(timer);
      // Inflight SELALU dibersihkan — termasuk saat abort/throw — supaya
      // percobaan berikut tidak menggantung di belakang promise mati.
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}
