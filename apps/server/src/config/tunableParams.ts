// apps/server/src/config/tunableParams.ts
// Definisi parameter yang boleh diubah oleh Sensitivity Analyzer.
// Tujuannya: Menghindari hardcode magic numbers di logika backtest/validation.

export interface TunableParam {
  key: string;          // Path unik, misal "slBand.SCALP.min"
  category: "SL" | "TP" | "ZONE" | "SCORE" | "FILTER";
  min: number;
  max: number;
  step: number;         // Increment grid search
  defaultValue: number;
  description: string;
}

export const TUNABLE_PARAMS: TunableParam[] = [
  {
    key: "slBand.SCALP.min",
    category: "SL",
    min: 0.010, // 1.0%
    max: 0.015, // 1.5%
    step: 0.001,
    defaultValue: 0.012,
    description: "Batas bawah jarak SL (% dari entry). Lebih ketat = lebih sering kena noise."
  },
  {
    key: "slBand.SCALP.max",
    category: "SL",
    min: 0.020, // 2.0%
    max: 0.030, // 3.0%
    step: 0.001,
    defaultValue: 0.025,
    description: "Batas atas jarak SL (% dari entry). Lebih longgar = risiko per trade naik jika sizing tetap."
  },
  {
    key: "rrByMode.SCALP.tp1R",
    category: "TP",
    min: 1.7,
    max: 1.7,
    step: 0.1,
    defaultValue: 1.7,
    description: "RR KLASIK dikunci 1.7R (operator 11 Okt 2026). Single-target."
  },
  {
    key: "minZoneScore",
    category: "ZONE",
    min: 40,
    max: 70,
    step: 5,
    defaultValue: 50,
    description: "Skor zona minimum untuk filter entry. Higher score = fewer trades, higher quality?"
  },
  {
    key: "sweepDepthAtrMin", // Khusus S-01 (Liquidity Sweep Reclaim)
    // CATATAN 20 Okt 2026: komentar lama menyebut "S-03" — itu keliru sejak
    // renumber 6 Okt 2026 (S-03 = Fibonacci, param ini milik S-01 Sweep).
    // S-03 Fibonacci sendiri dihapus operator; param ini tetap hidup untuk S-01.
    category: "FILTER",
    min: 0.5,
    max: 2.0,
    step: 0.1,
    defaultValue: 0.8,
    description: "[S-01] Kedalaman sweep minimum dalam satuan ATR."
  }
];