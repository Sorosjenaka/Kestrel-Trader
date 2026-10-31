// apps/server/src/config/timeframes.ts
// PETA TIMEFRAME ANALISIS PER MODE (single source of truth).
//
// SCALP menganalisis 4 timeframe pair + 1 timeframe makro (operator 28 Sep 2026
// menambah 3m sebagai konfirmasi momentum — mode scalp dibuat lebih agresif):
//   1m  -> TRIGGER   : squeeze release / momentum mikro (BB dalam KC, FR-10)
//   3m  -> CONFIRM   : konfirmasi momentum jembatan 1m->5m (trend/regime 3m)
//   5m  -> STRUCTURE : zona SnD / Order Block / FVG + ATR untuk jarak SL struktural (FR-09)
//   15m -> BIAS      : regime pasar + ZLEMA zero-lag + ADX/Choppiness (FR-08, FR-11)
//   1h  -> MAKRO     : BTC/ETH trend + BTC.D (FR-05, FR-06) — bukan pair yang ditradingkan
//
// Limit 90 (perintah operator 26 Sep 2026): bobot REST klines Binance dihitung dari
// LIMIT ([100,500) = weight 2); 90 bar = weight 1 — separuh beban, indikator tetap
// valid (ADX/Chop butuh 28, zona butuh 60, squeeze ~30). Full-fresh scan 117 pair.
// Catatan biaya: menambah 3m = 4 request/pair (weight 1 masing-masing) — +33%
// terhadap kuota REST per siklus; kegagalan fetch tetap "fresh-or-skip".
export type TfInterval = "1m" | "3m" | "5m" | "15m" | "1h" | "4h";
export type TfRole = "TRIGGER" | "CONFIRM" | "STRUCTURE" | "BIAS";
// 13 Okt 2026 — mode SWING kembali (perintah operator): S-05 Swing Breakout
// Pattern menganalisis bar 1h yang SUDAH TUTUP. SCALP tetap utuh seperti sebelumnya.
export type TradingModeName = "SCALP" | "SWING";

export interface TfSpec {
  interval: TfInterval;
  role: TfRole;
  /** Jumlah lilin yang diambil dari Binance. */
  limit: number;
  /** Periode ATR untuk SL struktural pada timeframe ini. */
  atrPeriod: number;
}

export interface ModeTimeframePlan {
  mode: TradingModeName;
  specs: TfSpec[];
  macroIntervals: TfInterval[];
  /** Ringkasan untuk log/UI. */
  summary: string;
  description: string;
}

export const SCALP_TIMEFRAMES: ModeTimeframePlan = {
  mode: "SCALP",
  specs: [
    { interval: "1m", role: "TRIGGER", limit: 90, atrPeriod: 14 },
    { interval: "3m", role: "CONFIRM", limit: 90, atrPeriod: 14 },
    { interval: "5m", role: "STRUCTURE", limit: 90, atrPeriod: 14 },
    { interval: "15m", role: "BIAS", limit: 90, atrPeriod: 14 },
  ],
  macroIntervals: ["1h"],
  summary: "SCALP: 1m (trigger) + 3m (konfirmasi) + 5m (struktur/zona) + 15m (bias) + makro 1h",
  description:
    "SCALP menganalisis 1m untuk trigger squeeze/momentum, 3m untuk konfirmasi momentum jembatan (trend/regime), 5m untuk struktur (demand/supply, order block, FVG) dan jarak SL struktural, 15m untuk bias regime & ZLEMA. Makro BTC/ETH/BTC.D selalu 1h.",
};

// 13 Okt 2026 (perintah operator: "Swing semua untuk Live trading dan paper mode
// backtest di website") — plan timeframe mode SWING: bar 1h yang SUDAH TUTUP.
// Trigger 1h (breakout close) + struktur 1h (ATR20 & pivots mesin channel);
// tidak ada analisis TF bawah. Makro tetap 1h. 300 bar 1h = 12,5 hari (mesin
// channel butuh warmup pivot 5+5 + scan 120 bar + ATR20/volSMA20).
export const SWING_TIMEFRAMES: ModeTimeframePlan = {
  mode: "SWING",
  specs: [
    { interval: "1h", role: "TRIGGER", limit: 300, atrPeriod: 20 },
    { interval: "1h", role: "STRUCTURE", limit: 300, atrPeriod: 20 },
  ],
  macroIntervals: ["1h"],
  summary: "SWING: 1h (trigger breakout, struktur channel) — hanya bar 1h yang sudah tutup + makro 1h",
  description:
    "SWING menganalisis bar 1h yang SUDAH TUTUP: channel pivot konvergen di-trigger breakout close; ATR20 & pivot dari seri 1h yang sama. Makro BTC/ETH/BTC.D tetap 1h.",
};

// Peta mode dihilangkan — getTimeframePlan memilih langsung (lihat bawah).

// 30 Sep 2026 — refactor SCALP-only: peta timeframe tunggal. Semua analisis memakai
// SCALP_TIMEFRAMES. Parameter `mode` dipertahankan agar pemanggil lama tidak
// perlu diubah serentak.
// 13 Okt 2026: mode SWING kembali — SWING memakai SWING_TIMEFRAMES, sisanya
// (termasuk mode tak dikenal) tetap SCALP (fail-closed ke perilaku lama).
export function getTimeframePlan(mode: string): ModeTimeframePlan {
  return mode === "SWING" ? SWING_TIMEFRAMES : SCALP_TIMEFRAMES;
}

export function getTfSpec(mode: string, role: TfRole): TfSpec {
  const plan = getTimeframePlan(mode);
  return plan.specs.find((s) => s.role === role) ?? plan.specs[0]!;
}

/** Total request klines per pair (SCALP: 4 pair TF 1m/3m/5m/15m; makro dihitung terpisah per siklus). */
export const KLINES_REQUESTS_PER_PAIR = 4;
