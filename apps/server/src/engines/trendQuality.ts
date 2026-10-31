// apps/server/src/engines/trendQuality.ts
// Big Brain Tahap B2 (14 Okt 2026): Trend Quality Score — lapisan di ATAS
// regime engine existing (regimeTrendEngine.ts), bukan pengganti.
//
// Masalah yang ditambal: ADX bisa >= 20 di market yang whipsaw keras, dan CHOP
// snapshot 14-bar itu noisy. Efficiency Ratio (Kaufman) mengukur hal yang
// paling jujur untuk "trending vs sideways": berapa PROPORSI jarak yang
// benar-benar ditempuh searah.
//   ER = |close_now - close_n_lalu| / SUM|perubahan tiap bar|
//   ER = 1  -> pergerakan lurus searah sempurna (trending murni)
//   ER ~ 0  -> bolak-balik, jarak neto nol (sideways murni)
//
// Hysteresis: masuk TRENDING di ER >= enterAt (0,35), keluar di ER < exitAt
// (0,25). Band ini ANGKA AWAL dari plan Big Brain — WAJIB divalidasi dari
// data historis (700k bar 5m) sebelum dipakai sebagai gate entry. Selama
// belum tervalidasi, modul ini hanya FITUR (observability + KNN feature),
// BUKAN gate — konsisten dengan tahapan Big Brain B2.
import { Bar } from "../universe/eligibility.js";

/** Ambang awal plan Big Brain B2. Belum tervalidasi historis -> belum gate. */
export const ER_ENTER_TRENDING = 0.35;
export const ER_EXIT_TRENDING = 0.25;
export const ER_DEFAULT_PERIOD = 30;

export type TrendQuality = "TRENDING" | "SIDEWAYS" | "UNAVAILABLE";

/**
 * Kaufman Efficiency Ratio pada seri close. null bila bar tidak cukup
 * (butuh period+1 bar) atau variasi total nol (harga beku).
 */
export function calculateEfficiencyRatio(bars: Bar[], period = ER_DEFAULT_PERIOD): number | null {
  if (!Number.isFinite(period) || period < 2) return null;
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  let netMove = Math.abs(slice[slice.length - 1]!.close - slice[0]!.close);
  let pathLength = 0;
  for (let i = 1; i < slice.length; i++) {
    pathLength += Math.abs(slice[i]!.close - slice[i - 1]!.close);
  }
  if (pathLength <= 0) return null;
  // netMove dipastikan <= pathLength (segitiga segienam), clamp defensif.
  netMove = Math.min(netMove, pathLength);
  return Number((netMove / pathLength).toFixed(4));
}

/** Hasil klasifikasi satu epoch untuk observability. */
export interface TrendQualitySnapshot {
  quality: TrendQuality;
  er: number | null;
  period: number;
  enterAt: number;
  exitAt: number;
}

/**
 * Klasifikator Trend Quality DENGAN HYSTERESIS (anti-flicker).
 * State machine: TRENDING hanya keluar jika ER turun di bawah exitAt;
 * SIDEWAYS hanya naik jika ER naik ke enterAt atau lebih.
 * Pure class tanpa I/O — seedable dari backtest.
 */
export class TrendQualityClassifier {
  private state: TrendQuality = "SIDEWAYS";
  private readonly enterAt: number;
  private readonly exitAt: number;
  private readonly period: number;

  constructor(opts: { enterAt?: number; exitAt?: number; period?: number; initialState?: TrendQuality } = {}) {
    this.enterAt = opts.enterAt ?? ER_ENTER_TRENDING;
    this.exitAt = opts.exitAt ?? ER_EXIT_TRENDING;
    this.period = opts.period ?? ER_DEFAULT_PERIOD;
    if (opts.initialState === "TRENDING" || opts.initialState === "SIDEWAYS") this.state = opts.initialState;
  }

  /** Masukkan bar lengkap hingga sekarang; kembalikan kualitas saat ini. */
  update(bars: Bar[]): TrendQualitySnapshot {
    const er = calculateEfficiencyRatio(bars, this.period);
    if (er === null) {
      return { quality: "UNAVAILABLE", er: null, period: this.period, enterAt: this.enterAt, exitAt: this.exitAt };
    }
    if (this.state === "SIDEWAYS" && er >= this.enterAt) {
      this.state = "TRENDING";
    } else if (this.state === "TRENDING" && er < this.exitAt) {
      this.state = "SIDEWAYS";
    }
    return { quality: this.state, er, period: this.period, enterAt: this.enterAt, exitAt: this.exitAt };
  }

  /** Paksa state (dipakai seed/backtest). */
  seed(state: TrendQuality): void {
    if (state === "TRENDING" || state === "SIDEWAYS") this.state = state;
  }

  current(): TrendQuality {
    return this.state;
  }
}
