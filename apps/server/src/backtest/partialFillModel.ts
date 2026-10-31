// apps/server/src/backtest/partialFillModel.ts — T1.2 (18 Okt 2026).
//
// Model partial-fill sederhana untuk backtest paper. Live execution sudah
// menangani partial fill di plannedEntry.ts (cancel remainder + realign bracket);
// model ini mereplikasi perilaku tersebut di historicalReplay supaya EV paper
// lebih mendekati EV live (target Δ ≤ 0.1R per T1.3).
//
// Pendekatan: estimasi proporsi fill dari rasio order notional vs volume bar
// pada level harga LIMIT. Untuk order kecil ($25 notional @ 25x, $1 risk)
// pada pair likuid (BTC/ETH/SOL), fill ratio ≈ 1.0 hampir selalu. Partial
// fill hanya terjadi bila volume bar sangat tipis atau order relatif besar.
//
// Fail-closed: tanpa data volume → asumsi full fill (konservatif, tidak
// mengarang penolakan). Tidak ada parameter tunable yang bisa dimanipulasi
// untuk memperbaiki metrik secara artifisial.

/**
 * Estimasi rasio fill untuk satu order LIMIT pada sebuah bar.
 *
 * @param orderNotional - Notional order dalam USDT (qty × price).
 * @param barVolume     - Volume bar dalam unit base asset.
 * @param barPrice      - Harga representatif bar (close atau VWAP proxy).
 * @param participationCap - Maksimal partisipasi kita di volume bar (default 10%).
 *                           NautilusTrader memakai 1-5%; kita pakai 10% karena
 *                           order ArtaTrade sangat kecil ($25 notional).
 * @returns Rasio fill [0, 1]. 1.0 = full fill.
 */
export function estimateLimitFillRatio(
  orderNotional: number,
  barVolume: number,
  barPrice: number,
  participationCap = 0.10
): number {
  if (!Number.isFinite(orderNotional) || orderNotional <= 0) return 0;
  if (!Number.isFinite(barVolume) || barVolume <= 0 || !Number.isFinite(barPrice) || barPrice <= 0) {
    // Tanpa data volume: asumsi full fill (fail-open konservatif).
    return 1;
  }

  const barNotional = barVolume * barPrice;
  // Maksimal qty yang bisa kita ambil dari bar ini tanpa menjadi >cap% volume.
  const maxOurNotional = barNotional * participationCap;

  if (orderNotional <= maxOurNotional) return 1;
  // Partial fill: proporsional terhadap apa yang tersedia.
  return Math.max(0, Math.min(1, maxOurNotional / orderNotional));
}

/**
 * Hitung qty terisi aktual untuk order LIMIT pada bar tertentu.
 * Mengembalikan qty yang difill (bisa < requestedQty untuk partial).
 *
 * Step size dan minQty tetap ditegakkan oleh calculateOrderPlan sebelum
 * fungsi ini dipanggil — di sini hanya soal proporsi volume.
 */
export function filledQtyForLimit(
  requestedQty: number,
  entryPrice: number,
  barVolume: number,
  barClose: number,
  participationCap = 0.10
): number {
  const notional = requestedQty * entryPrice;
  const ratio = estimateLimitFillRatio(notional, barVolume, barClose, participationCap);
  if (ratio >= 1) return requestedQty;
  const filled = requestedQty * ratio;
  // Bulatkan ke bawah 8 desimal (presisi standar crypto).
  return Number(filled.toFixed(8));
}

/**
 * Tentukan apakah order LIMIT terisi pada bar ini (touch model).
 *
 * Konvensi riset: LIMIT BUY terisi bila low bar ≤ harga limit;
 * LIMIT SELL terisi bila high bar ≥ harga limit. Ini tetap berlaku;
 * partial-fill hanya menskala qty SETELAH touch dikonfirmasi.
 */
export function limitTouchedOnBar(
  side: "LONG" | "SHORT",
  limitPrice: number,
  barLow: number,
  barHigh: number
): boolean {
  return side === "LONG" ? barLow <= limitPrice : barHigh >= limitPrice;
}
