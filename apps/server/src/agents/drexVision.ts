// apps/server/src/agents/drexVision.ts
// Drex vision: menyiapkan screenshot chart PNG untuk dikirim ke Drex-Max.
//
// ALUR (semua fail-open, tidak pernah melempar ke jalur entry):
//   1. Gate env DREX_VISION_ENABLED (default false) -> kalau mati, TIDAK ada
//      gambar yang dibuat maupun dikirim (perilaku produksi tidak berubah).
//   2. Data bar HARUS dari caller (bar tertutup) — modul ini tidak fetch sendiri
//      supaya tidak ada jalur jaringan tersembunyi dan anti-lookahead tetap
//      milik caller.
//   3. Render chart (pure-Node PNG, src/agents/drexChart.ts) di-cache per
//      (symbol, timeframe, lastBarTime) supaya tidak render ulang tiap request
//      (budget latensi Drex = DREX_TIMEOUT_MS, default 4000 ms).
//   4. Hasil: string base64 PNG, atau null kalau tidak bisa disiapkan.
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import {
  drexChartCache,
  drexChartCacheKey,
  renderChartBase64,
  type DrexChartBar,
  type DrexChartLevels,
} from "./drexChart.js";

export interface DrexVisionRequest {
  symbol: string;
  timeframe: string;
  /** Bar OHLC yang SUDAH TUTUP (diberikan caller). */
  bars: DrexChartBar[];
  /** Level plan (entry/SL/TP) digambar sebagai garis; opsional. */
  levels?: DrexChartLevels | null;
}

export interface DrexVisionResult {
  /** Base64 PNG, atau null bila vision tidak aktif/gagal. */
  image: string | null;
  /** Alasan null (untuk log jujur; tidak pernah exception). */
  reason: string | null;
  /** true = dipakai dari cache (tidak render ulang). */
  cached: boolean;
  /** Ukuran PNG dalam byte (base64 length * 3/4 kira-kira). */
  bytes: number;
}

/** Aktif hanya bila flag vision menyala (default false). */
export function drexVisionEnabled(): boolean {
  return env.DREX_VISION_ENABLED === true;
}

/**
 * Siapkan satu gambar chart untuk dikirim ke Drex.
 * Tidak pernah melempar: semua kegagalan -> { image: null, reason }.
 */
export function prepareDrexVisionImage(req: DrexVisionRequest): DrexVisionResult {
  if (!drexVisionEnabled()) {
    return { image: null, reason: "DREX_VISION_DISABLED", cached: false, bytes: 0 };
  }
  const bars = Array.isArray(req.bars) ? req.bars : [];
  if (bars.length < 2) {
    return { image: null, reason: "DREX_VISION_BARS_INSUFFICIENT", cached: false, bytes: 0 };
  }
  const lastBar = bars[bars.length - 1]!;
  const lastBarTime = Number.isFinite(lastBar.openTime) ? lastBar.openTime : 0;
  const key = drexChartCacheKey(req.symbol, req.timeframe, lastBarTime);

  const cached = drexChartCache.get(key);
  if (cached) {
    return { image: cached, reason: null, cached: true, bytes: Math.ceil((cached.length * 3) / 4) };
  }

  try {
    const base64 = renderChartBase64(bars, {
      symbol: req.symbol,
      timeframe: req.timeframe,
      maxBars: env.DREX_VISION_MAX_BARS,
      levels: req.levels ?? null,
    });
    drexChartCache.set(key, base64);
    logger.info(
      { symbol: req.symbol, timeframe: req.timeframe, bars: bars.length, bytes: Math.ceil((base64.length * 3) / 4) },
      "DREX_VISION_RENDERED",
    );
    return { image: base64, reason: null, cached: false, bytes: Math.ceil((base64.length * 3) / 4) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "DREX_VISION_RENDER_FAILED";
    logger.warn({ symbol: req.symbol, timeframe: req.timeframe, reason }, "DREX_VISION_RENDER_FAILED");
    return { image: null, reason, cached: false, bytes: 0 };
  }
}

/** Statistik cache render (untuk log/diagnostics). */
export function drexVisionCacheStats(): { size: number; hits: number; misses: number } {
  return drexChartCache.stats();
}
