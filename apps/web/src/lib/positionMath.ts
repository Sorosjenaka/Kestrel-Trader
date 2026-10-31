// apps/web/src/lib/positionMath.ts
//
// Fungsi murni untuk chart posisi live (spec fix/live-chart-binance-style):
// merge bar REST, format sumbu WIB, R-multiple PnL, dan rentang autoscale
// dengan sakelar FIT LEVELS. Semua fungsi bebas DOM supaya bisa diuji vitest
// tanpa canvas.
import type { Candle } from "./chartMath.js";

/** Offset WIB = UTC+7 (server & chart pakai Unix SECONDS). */
export const WIB_OFFSET_MS = 7 * 3_600_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Tanggal-bulan WIB, mis. "29 Okt". */
export function fmtDayMonthWib(epochSec: number): string {
  const d = new Date(epochSec * 1000 + WIB_OFFSET_MS);
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()] ?? ""}`;
}

/**
 * Label intraday WIB "HH:MM" (tickFmt sesuai kontrak tes: 1793215800 -> "02:30").
 * Dipakai untuk TickMarkType.Time.
 */
export function tickFmt(epochSec: number): string {
  const d = new Date(epochSec * 1000 + WIB_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * tickMarkFormatter berdasar TickMarkType dengan offset WIB.
 * kind: "year" | "month" | "day" | "time".
 */
export function tickMarkFmtWib(epochSec: number, kind: "year" | "month" | "day" | "time"): string {
  const d = new Date(epochSec * 1000 + WIB_OFFSET_MS);
  switch (kind) {
    case "year": return String(d.getUTCFullYear());
    case "month": return `${fmtDayMonthWib(epochSec)} ${d.getUTCFullYear()}`;
    case "day": return fmtDayMonthWib(epochSec);
    default: return tickFmt(epochSec);
  }
}

/** Format crosshair: "29 Okt 02:30 WIB". */
export function crosshairFmtWib(epochSec: number): string {
  return `${fmtDayMonthWib(epochSec)} ${tickFmt(epochSec)} WIB`;
}

/**
 * Gabung dua set bar: dedup by time (b — snapshot lebih baru — menang),
 * lalu urut menaik. Dipakai refresh REST supaya tidak menimpa bar hasil
 * stream dengan data yang lebih basi.
 */
export function mergeBars(a: Candle[], b: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of a) byTime.set(c.time, c);
  for (const c of b) byTime.set(c.time, c);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

export interface PositionGeom {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  qty: number;
}

/** Jarak risiko (entry->SL). Null bila SL tidak diketahui. */
export function riskDistance(pos: Pick<PositionGeom, "entryPrice" | "slPrice">): number | null {
  if (pos.slPrice == null || !Number.isFinite(pos.slPrice) || pos.slPrice === pos.entryPrice) return null;
  return Math.abs(pos.slPrice - pos.entryPrice);
}

/** R-multiple untuk sebuah harga terhadap posisi (positif = searah profit). */
export function rMultiple(pos: PositionGeom, price: number): number | null {
  const risk = riskDistance(pos);
  if (risk == null || !Number.isFinite(price)) return null;
  const dir = pos.side === "LONG" ? 1 : -1;
  return (price - pos.entryPrice) * dir / risk;
}

/** Alias kontrak tes: pnlR = R-multiple harga terakhir. */
export function pnlR(pos: PositionGeom, lastPrice: number): number | null {
  return rMultiple(pos, lastPrice);
}

/** PnL dolar belum terealisasi (SHORT: untung bila harga turun). */
export function unrealizedUsd(pos: PositionGeom, lastPrice: number): number | null {
  if (!Number.isFinite(lastPrice)) return null;
  const dir = pos.side === "LONG" ? 1 : -1;
  return (lastPrice - pos.entryPrice) * dir * pos.qty;
}

/** Ubah harga ke persen terhadap entry (mis. SL SHORT +5.27%). */
export function pctFromEntry(entryPrice: number, price: number): number {
  if (!entryPrice) return 0;
  return ((price - entryPrice) / entryPrice) * 100;
}

export interface AutoscaleResult {
  minValue: number;
  maxValue: number;
}

/**
 * Rentang autoscale chart.
 * - fitLevels ON (default): mencakup candle + entry/SL/TP1/TP2 (seluruh
 *   position box terlihat) + padding 6% di atas level tertinggi & di bawah
 *   level terendah supaya pill label tidak terpotong.
 * - fitLevels OFF ATAU tanpa level (tidak ada posisi): range candle saja.
 */
export function computeAutoscaleRange(
  candleMin: number,
  candleMax: number,
  levels: Array<number | null | undefined>,
  fitLevels: boolean,
): AutoscaleResult {
  const vals = fitLevels
    ? levels.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
  if (!vals.length) return { minValue: candleMin, maxValue: candleMax };
  const min = Math.min(candleMin, ...vals);
  const max = Math.max(candleMax, ...vals);
  const span = max - min;
  const pad = span > 0 ? span * 0.06 : Math.abs(max) * 0.001;
  return { minValue: min - pad, maxValue: max + pad };
}

/** Label footer panel chart sesuai mode posisi (kontrak tes: "footer LIVE"). */
export function positionFooterLabel(mode: string | undefined | null, hasPosition: boolean): string {
  if (!hasPosition) return "NO POSITION INSTRUMENT";
  return `${String(mode ?? "").toUpperCase() === "LIVE" ? "POSISI LIVE" : "POSISI"} · LEVEL ENGINE`;
}
