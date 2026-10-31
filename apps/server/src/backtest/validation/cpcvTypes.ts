// apps/server/src/backtest/validation/cpcvTypes.ts
// Definisi tipe data untuk Combinatorial Purged Cross-Validation (CPCV).

import type { ReplayOutput } from "../historicalReplay.js";

export interface CpcvConfig {
  nGroups: number;       // Total jumlah blok kontigu (folds)
  kTestGroups: number;   // Jumlah blok yang di-hold-out untuk testing per kombinasi
  purgeWindowMs: number; // Jendela waktu eksklusi di sekitar batas train/test (embargo)
  embargoMs: number;     // Gap keamanan tambahan antara akhir training dan awal test
}

export interface CpcvFoldResult {
  foldId: number;
  trainIndices: [number, number][]; // Array pasangan [start, end] indeks dalam dataset asli
  testIndices: [number, number][];
  output: ReplayOutput;
  metrics: {
    netPnlUsd: number;
    winRate: number;
    sharpeLike: number; // Metrik sederhana untuk ranking
  };
}

export interface CpcvAggregatedStats {
  meanNetPnl: number;
  stdDevNetPnl: number;
  minNetPnl: number;
  maxNetPnl: number;
  consistencyScore: number; // 1 - (StdDev / Abs(Mean)), dibatasi maks 1
}

export interface CpcvReport {
  config: CpcvConfig;
  folds: CpcvFoldResult[];
  aggregated: CpcvAggregatedStats;
  isValidated: boolean; // True jika SEMUA fold profitabel DAN konsistensi tinggi
  limitations: string[];
}
