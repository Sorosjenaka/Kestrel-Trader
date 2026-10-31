// apps/server/src/config/costs.ts
// SATU-SATUNYA tempat keputusan biaya.
//
// 8 Okt 2026 (perintah operator: "sekarang pakai fee, hitung total dengan fee
// Binance futures exchange"): model fee DINYALAKAN dengan rate asli Binance
// USDⓈ-M Futures. Sumber: https://www.binance.com/en/fee/futureFee , tabel
// "Regular User", kolom USDT Maker/Taker (dilihat 8 Okt 2026):
//   maker 0.0200% = 0.0002
//   taker 0.0500% = 0.0005
// Diskon BNB 10% (0.018%/0.045%) TIDAK dipakai — akun tidak dinyatakan pegang BNB.
// Riwayat: FEE_RATE=0 (instruksi operator 3 Okt 2026) DIBATALKAN 8 Okt 2026.
export const MAKER_RATE = 0.0002;
export const TAKER_RATE = 0.0005;

// Turunan tunggal untuk model satu-rate lama (netOfFee/grossOfFee, default
// riskEngine entryFeeRate/exitFeeRate): semua sisi dianggap taker (konservatif).
export const FEE_RATE = TAKER_RATE;

/**
 * Fee satu trade dari notional: qty*entry*TAKER (entry market) + qty*exit*rateOut.
 * exitIsMaker = true untuk exit limit (TP), false untuk SL/market (taker).
 * Tidak ada fee yang dikarang: input non-finit/negatif -> 0.
 */
export function estimateTradeFeeUsd(input: {
  entryAvg: number;
  exitAvg: number;
  qty: number;
  exitIsMaker: boolean;
}): number {
  const { entryAvg, exitAvg, qty } = input;
  if (![entryAvg, exitAvg, qty].every((n) => Number.isFinite(n) && n >= 0)) return 0;
  const rateOut = input.exitIsMaker ? MAKER_RATE : TAKER_RATE;
  return Number((qty * (entryAvg * TAKER_RATE + exitAvg * rateOut)).toFixed(4));
}

/** Bersih-fee dengan pembulatan eksplisit 4 desimal (Rules.md Bagian 2). */
export function netOfFee(amountUsd: number): number {
  return Number((amountUsd * (1 - FEE_RATE)).toFixed(4));
}

export function grossOfFee(amountUsd: number): number {
  return Number((amountUsd * (1 + FEE_RATE)).toFixed(4));
}

/**
 * Maker/taker dari tipe order (model fee Binance futures).
 * LIMIT & TAKE_PROFIT (limit) = maker (0,02%). MARKET, STOP_MARKET,
 * TAKE_PROFIT_MARKET = taker (0,05%). Cocok dgn pemetaan executor:
 * TP dieksekusi LIMIT (maker), SL/BE/entry market (taker).
 */
export function isMakerOrderType(orderType: string): boolean {
  const t = String(orderType).toUpperCase();
  return t === "LIMIT" || t === "TAKE_PROFIT";
}

/**
 * Fee satu FILL dari notional: qty*price*(maker|taker). Dipakai executor utk
 * mengisi feeUsd per order (paper & provisional live) — menggantikan "Perintah
 * Operator: Hapus Fee" (dicabut 18 Okt 2026). Input non-finit/negatif -> 0
 * (fail-closed, tidak ada fee yang dikarang).
 */
export function estimateFillFeeUsd(input: { qty: number; price: number; isMaker: boolean }): number {
  const { qty, price } = input;
  if (![qty, price].every((n) => Number.isFinite(n) && n >= 0)) return 0;
  const rate = input.isMaker ? MAKER_RATE : TAKER_RATE;
  return Number((qty * price * rate).toFixed(6));
}

/**
 * KONVENSI DB `Trade` (18 Okt 2026, fee penuh) — SATU sumber kebenaran:
 *   `pnlUsd`  = NET = grossUsd - feeUsd + fundingUsd  (fee & funding SUDAH termasuk).
 *               Lihat app.ts "pnlUsd di DB sudah NET (gross - fee). feeUsd hanya
 *               info, JANGAN dikurangi lagi" dan exitAccounting "NET direkonsiliasi
 *               sebagai: realizedPnlUsd - feeUsd + fundingUsd".
 *   `feeUsd`  = total fee (entry + exit) — rincian informasi/audit. JANGAN dikurangi
 *               lagi dari `pnlUsd` (double-deduction).
 *   `fundingUsd` = funding bertanda (negatif = kita bayar) — informasi/audit.
 *   `rMultiple` = R basis jarak harga (GROSS) = grossUsd / riskUsd — utk ladder 2R/3R.
 * Rekonstruksi gross = pnlUsd + feeUsd - fundingUsd (dipakai riset/postMortem).
 */
export function netRealizedPnlUsd(grossUsd: number, feeUsd: number, fundingUsd = 0): number {
  return Number((grossUsd - feeUsd + fundingUsd).toFixed(6));
}
