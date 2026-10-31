// apps/server/src/lab/labTypes.ts — Tipe Lab Eksperimen (CP-7, T-22).
// Lab = RISET-ONLY: tidak pernah menyentuh jalur trading, order, atau sizing live.
// Semua angka dihitung deterministik di TS (Golden Rules #1).
export type LabInterval = "1m" | "3m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type LabIndicator = "RSI" | "EMA" | "SMA" | "ATR" | "MACD" | "BB" | "PRICE" | "VOLUME";

export interface LabOperand {
  kind: "INDICATOR" | "VALUE";
  indicator?: LabIndicator;
  period?: number;          // utk RSI/EMA/SMA/ATR
  source?: "close" | "high" | "low" | "open" | "hl2";
  line?: "macd" | "signal" | "hist" | "upper" | "lower" | "basis"; // utk MACD/BB
  value?: number;           // utk VALUE murni
}

export type LabOperator = "CROSS_ABOVE" | "CROSS_BELOW" | "GT" | "LT";

export interface LabCondition {
  left: LabOperand;
  op: LabOperator;
  right: LabOperand;
}

export type LabExitSpec =
  | { kind: "ATR_MULT"; atrPeriod: number; mult: number }
  | { kind: "PRICE"; value: number }      // absolute stop/limit price (Pine)
  | { kind: "PCT"; value: number }        // persen dari entry
  | { kind: "R_MULT"; value: number };    // kelipatan jarak SL

export interface LabSpec {
  name: string;
  symbol: string;
  interval: LabInterval;
  /** 14 Okt 2026: MULTI TIME FRAME — 1..7 interval dijalankan sekaligus per run. */
  intervals?: LabInterval[];
  /** 14 Okt 2026: MULTI PAIR — 1..5 pair dijalankan sekaligus per run. */
  symbols?: string[];
  from: string;             // ISO date (UTC)
  to: string;               // ISO date (UTC)
  direction: "LONG" | "SHORT" | "BOTH";
  entryConditions: LabCondition[];  // semua harus TRUE pada bar yang sama (AND)
  sl: LabExitSpec;
  tp: LabExitSpec;
  source: "MANUAL_BLOCK" | "PINE_IMPORT" | "PINE_LINK";
  pineSource?: string;      // sumber Pine asli (kalau ada), untuk audit
  tvUrl?: string;           // link TradingView asal (kalau ada)
}

export interface LabTrade {
  direction: "LONG" | "SHORT";
  entryTime: number;        // epoch ms
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  exitReason: "TP" | "SL" | "EOD";
  rMultiple: number;        // net of fees, dinormalisasi ke risiko posisi
  pnlPct: number;           // % dari entry
  holdBars: number;
}

export type IntrabarBound = "SL_FIRST" | "TP_FIRST";

export interface LabStats {
  sampleCount: number;
  winCount: number;
  winrate: number;          // 0-100
  profitFactor: number;     // gross win / gross loss (R)
  sumR: number;
  avgR: number;
  maxDdR: number;           // drawdown maksimum dalam R (ekuitas R)
  avgHoldBars: number;
  perSide: { LONG: { n: number; winrate: number; sumR: number }; SHORT: { n: number; winrate: number; sumR: number } };
  /** Band intrabar: SL-first (pesimis) dan TP-first (optimis) — keduanya dihitung. */
  intrabarBand: { slFirst: { sumR: number; winrate: number }; tpFirst: { sumR: number; winrate: number } };
  /** Pemeriksaan konsistensi (gate validasi) — semua harus true. */
  validation: { name: string; ok: boolean; detail: string }[];
}

export interface LabEquityPoint { t: number; r: number; }

export interface LabResult {
  spec: LabSpec;
  stats: LabStats;
  trades: LabTrade[];
  equity: LabEquityPoint[];
  /** Downsample candle untuk chart (maks ~240 bar). */
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  markers: { t: number; price: number; kind: "ENTRY" | "EXIT_TP" | "EXIT_SL" | "EXIT_EOD"; direction: "LONG" | "SHORT" }[];
  barsUsed: number;
  barsRequested: number;
  /** Caveat jujur: hal yang tidak termodelkan. */
  caveats: string[];
  runtimeMs: number;
}

export interface LabExperimentRecord {
  id: string;
  createdAt: number;
  spec: LabSpec;
  stats: LabStats;
  notes?: string;
}
