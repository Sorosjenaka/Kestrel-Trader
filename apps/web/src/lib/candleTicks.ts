export interface ChartCandle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

/**
 * Panjang interval dalam ms dari label timeframe.
 *
 * 23 Okt 2026 (BUG FIX): sebelumnya hanya `Number(timeframe) * 60_000` dan
 * kasus "D" dianggap 86_400_000. Tapi "D" mencapai fungsi ini lewat
 * NativeQuantChart, dan frame SSE/label lain bisa memakai "1d"/"4h"/"1h".
 * Dengan implementasi lama semua label itu jadi NaN -> applyCandleTick
 * mengembalikan candles tanpa perubahan -> chart live MATI (tidak pernah
 * updating) untuk TF non-menit.
 *
 * Sekarang mendukung: 1m/3m/5m/15m/30m/1h/2h/4h/6h/12h/1d/D dan angka
 * menit mentah ("60", "240").
 */
export function intervalMsFor(timeframe: string): number {
  const raw = String(timeframe ?? "").trim().toLowerCase();
  if (!raw) return 0;
  if (raw === "d" || raw === "1d") return 86_400_000;
  const hours = raw.match(/^(\d+)h$/);
  if (hours) return Number(hours[1]) * 3_600_000;
  const minutes = raw.match(/^(\d+)m$/);
  if (minutes) return Number(minutes[1]) * 60_000;
  // Angka mentah = menit (NativeQuantChart kirim "60" untuk 1h, "240" untuk 4h).
  if (/^\d+$/.test(raw)) return Number(raw) * 60_000;
  return 0;
}

/** Append only an observed interval. Missing intervals are not invented. */
export function applyCandleTick<T extends ChartCandle>(candles: T[], price: number, at: number, timeframe: string): T[] {
  if (!candles.length || !Number.isFinite(price) || price <= 0 || !Number.isFinite(at) || at <= 0) return candles;
  const intervalMs = intervalMsFor(timeframe);
  if (!(intervalMs > 0)) return candles;
  const time = Math.floor(at / intervalMs) * intervalMs;
  const last = candles[candles.length - 1]!;
  if (time < last.time) return candles;
  if (time > last.time) {
    // Tick-only volume is unknown until the next authoritative kline refresh.
    return [...candles.slice(-199), { ...last, time, open: price, high: price, low: price, close: price, volume: 0 }];
  }
  return [...candles.slice(0, -1), { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }];
}
