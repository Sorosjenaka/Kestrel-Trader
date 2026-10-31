// apps/server/src/types/hypothesis.ts
// Formalisasi Hipotesis Strategi untuk Validasi Ilmiah.
// Setiap strategi aktif (S-01..S-03, renumber 6 Okt 2026) harus memiliki objek ini.

export type TestMetric = 'winRate' | 'expectancy' | 'maeDistribution' | 'timeToTarget';

export interface TradeHypothesis {
  strategyId: string; // "S-01", "S-02", "S-03"
  claim: string;      // Deskripsi klaim positif (Alternative Hypothesis H1)
  nullHypothesis: string; // Deskripsi kondisi acak/random walk (Null Hypothesis H0)
  testMetric: TestMetric;
  significanceLevel: number; // alpha, biasanya 0.05
  minSampleSize: number;     // n minimum agar uji statistik valid
}

/** Katalog hipotesis eksplisit untuk strategi aktif saat ini. */
export const STRATEGY_HYPOTHESES: Record<string, TradeHypothesis> = {
  "S-01": {
    strategyId: "S-01",
    claim: "Setelah sweep ekstrem sesi (>X ATR), probabilitas reclaim level >Y% dalam Z bar meningkat signifikan dibandingkan random walk.",
    nullHypothesis: "Reclaim terjadi secara acak; tidak ada edge prediktif dari kedalaman sweep atau timing killzone.",
    testMetric: "winRate",
    significanceLevel: 0.05,
    minSampleSize: 300,
  },
  "S-02": {
    strategyId: "S-02",
    claim: "Harga bergerak menuju magnet likuiditas terdekat dengan kecepatan proporsional terhadap intensitas pull bias; target tercapai sebelum invalidasi.",
    nullHypothesis: "Gerakan harga independen dari peta likuiditas; pergerakan adalah noise pasar biasa tanpa arah magnetik.",
    testMetric: 'expectancy',
    significanceLevel: 0.05,
    minSampleSize: 300,
  },
  // CATATAN 20 Okt 2026: hipotesis "S-03" (Fibonacci Zone 0.5-0.618) DIHAPUS
  // bersama strateginya (perintah operator). Trade S-03 yang sudah terjadi
  // tetap punya baris ledger sendiri; hipotesisnya tidak lagi diuji.
};