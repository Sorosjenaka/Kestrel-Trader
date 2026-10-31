// Smooth intrabar interpolation untuk chart Lightweight Charts.
//
// 23 Okt 2026: permintaan operator — pergerakan candle harus "natural" seperti
// demo TradingAgents (Lightweight Charts), bukan melompat (snap) setiap tick.
//
// Lightweight Charts TIDAK menginterpolasi sendiri: `series.update()` menulis
// nilai final seketika. Akibatnya candle terakhir "berkedip"/melompat tiap
// ~250ms. Yangnatural: harga bergerak CONTINUOUS dari nilai lama ke nilai baru
// memakai easing, di-render pada requestAnimationFrame.
//
// Prinsip:
//  - Interpolasi HANYA untuk bar TERAKHIR yang masih berjalan (open bar).
//  - Bar yang sudah tutup TIDAK pernah dianimasikan (angka historis immutable).
//  - Tick baru yang tiba saat animasi berjalan = target baru, animasi berlanjut.
//  - Easing: easeOutCubic — cepat di awal, melambat di akhir (natural, tidak
//    "melompat" di detik terakhir).
//  - Durasi: cukup pendek (~120ms) supaya terasa live, tapi cukup panjang
//    supaya mata membaca sebagai gerak kontinu.

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface InterpState {
  from: Ohlc;
  to: Ohlc;
  startedAt: number;
  durationMs: number;
}

const DEFAULT_DURATION_MS = 120;

function easeOutCubic(t: number): number {
  const x = 1 - t;
  return 1 - x * x * x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpOhlc(from: Ohlc, to: Ohlc, t: number): Ohlc {
  return {
    open: lerp(from.open, to.open, t),
    high: lerp(from.high, to.high, t),
    low: lerp(from.low, to.low, t),
    close: lerp(from.close, to.close, t),
  };
}

/**
 * Mulai (atau lanjutkan) animasi menuju target baru.
 * - Bila animasi berjalan dan target belum tercapai, DURASI disisakan
 *   sehingga tidak ada lompatan: target baru dijangkau dari posisi saat ini.
 * - Bila target sama persis dengan posisi sekarang, tidak ada animasi.
 */
export function beginTransition(
  current: Ohlc,
  target: Ohlc,
  now: number,
  durationMs = DEFAULT_DURATION_MS,
): InterpState | null {
  if (
    current.open === target.open &&
    current.high === target.high &&
    current.low === target.low &&
    current.close === target.close
  ) {
    return null;
  }
  return { from: current, to: target, startedAt: now, durationMs };
}

/**
 * Sample animasi pada waktu `now`.
 * Mengembalikan nilai interpolasi + completed (true bila sudah sampai target).
 */
export function sampleTransition(state: InterpState, now: number): { ohlc: Ohlc; completed: boolean } {
  const elapsed = now - state.startedAt;
  if (elapsed >= state.durationMs) {
    return { ohlc: { ...state.to }, completed: true };
  }
  if (elapsed < 0) {
    return { ohlc: { ...state.from }, completed: false };
  }
  const raw = elapsed / state.durationMs;
  return { ohlc: lerpOhlc(state.from, state.to, easeOutCubic(raw)), completed: false };
}
