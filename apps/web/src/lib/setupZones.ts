/**
 * 23 Okt 2026 (ZONE ENTRY/SL/TP) — geometri zona setup.
 *
 * Permintaan operator (referensi video setup trading): level Entry/SL/TP
 * harus digambar sebagai AREA/shaded zone, bukan garis horizontal saja.
 *
 * Modul ini dipisah supaya kontraknya bisa diuji langsung (tanpa mount
 * React) dan dipakai oleh TradingChartPanel.
 */

export interface SetupZone {
  /** koordinat y atas dalam piksel (sudah di-clip ke area chart) */
  top: number;
  /** tinggi pita dalam piksel (sudah di-clip) */
  h: number;
  fill: string;
  stroke: string;
  label: string;
  dash: string;
  /** true kalau pita aslinya keluar dari area chart */
  clipped: boolean;
}

/**
 * Bentuk satu pita zone dari dua koordinat y, di-clip ke area chart.
 * Mengembalikan null kalau pita tidak valid atau tak terlihat (< 0.5px).
 */
export function buildZone(
  a: number | null,
  b: number | null,
  chartHeight: number,
  fill: string,
  stroke: string,
  label: string,
  dash = "none",
): SetupZone | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const top = Math.min(a, b);
  const height = Math.abs(b - a);
  if (height < 0.5) return null;
  const clippedTop = Math.max(0, top);
  const clippedBottom = Math.min(chartHeight, top + height);
  if (clippedBottom - clippedTop < 0.5) return null;
  return {
    top: clippedTop,
    h: clippedBottom - clippedTop,
    fill,
    stroke,
    label,
    dash,
    clipped: top < 0 || top + height > chartHeight,
  };
}

/** Style per zona (string, bukan literal — agar bisa di-pass antar key). */
export interface SetupZoneStyle {
  fill: string;
  stroke: string;
  label: string;
  dash: string;
}

/** Warna & label default zona setup. */
export const SETUP_ZONE_STYLE: Record<"risk" | "tp1" | "tp2" | "entry", SetupZoneStyle> = {
  risk: { fill: "rgba(242,65,74,.22)", stroke: "rgba(242,65,74,.75)", label: "RISK → SL", dash: "4 3" },
  tp1: { fill: "rgba(58,168,242,.20)", stroke: "rgba(58,168,242,.7)", label: "TP1", dash: "none" },
  tp2: { fill: "rgba(120,201,232,.18)", stroke: "rgba(120,201,232,.65)", label: "TP2", dash: "none" },
  entry: { fill: "rgba(58,168,242,.35)", stroke: "rgba(58,168,242,1)", label: "ENTRY", dash: "none" },
};
