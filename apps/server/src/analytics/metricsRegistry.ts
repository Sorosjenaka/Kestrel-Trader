// TAHAP MONITOR (checklist 2026-10-03 T-13). Ambang alert deterministik:
// murni fungsi TS, tanpa LLM dan tanpa angka uang dari LLM (Golden Rules #1).
export interface MetricSnapshot {
  strategyId: string;
  tradesToday: number;
  winsToday: number;
  pnlTodayUsd: number;
  losingStreak: number;
  drawdownUsd: number;
  winRatePct: number;
}

export interface MetricAlert {
  code: "LOSING_STREAK" | "DAILY_DRAWDOWN" | "WINRATE_DROP" | "RECURRING_MISTAKE";
  message: string;
  strategyId: string;
}

// ── SMB T-03 (9 Okt 2026): alert kesalahan eksekusi berulang ──
// Ambang deterministik: >= 3 kejadian tipe kesalahan yang sama dalam jendela trade.
export const RECURRING_MISTAKE_THRESHOLDS = {
  MIN_OCCURRENCES: 3,
  DEFAULT_WINDOW_TRADES: 20,
} as const;

export function buildRecurringMistakeAlert(mistake: string, occurrences: number, windowTrades: number): MetricAlert {
  return {
    code: "RECURRING_MISTAKE",
    strategyId: "PROCESS",
    message: `${mistake} terdeteksi ${occurrences}x dalam ${windowTrades} trade terakhir (ambang ${RECURRING_MISTAKE_THRESHOLDS.MIN_OCCURRENCES})`,
  };
}

export const METRIC_THRESHOLDS = {
  MAX_LOSING_STREAK: 4,
  MAX_DAILY_DD_USD: 6,
  MIN_WINRATE_PCT: 35,
  MIN_TRADES_FOR_WINRATE: 10,
} as const;

export function evaluateThresholds(s: MetricSnapshot): MetricAlert[] {
  const out: MetricAlert[] = [];
  const t = METRIC_THRESHOLDS;
  if (s.losingStreak > t.MAX_LOSING_STREAK) {
    out.push({ code: "LOSING_STREAK", strategyId: s.strategyId, message: `${s.strategyId}: losing streak ${s.losingStreak} > ${t.MAX_LOSING_STREAK}` });
  }
  if (s.drawdownUsd > t.MAX_DAILY_DD_USD) {
    out.push({ code: "DAILY_DRAWDOWN", strategyId: s.strategyId, message: `${s.strategyId}: drawdown harian ${s.drawdownUsd.toFixed(2)} > ${t.MAX_DAILY_DD_USD}` });
  }
  if (s.tradesToday >= t.MIN_TRADES_FOR_WINRATE && s.winRatePct < t.MIN_WINRATE_PCT) {
    out.push({ code: "WINRATE_DROP", strategyId: s.strategyId, message: `${s.strategyId}: WR ${s.winRatePct.toFixed(1)}% < ${t.MIN_WINRATE_PCT}% pada ${s.tradesToday} trade hari ini` });
  }
  return out;
}

/** Satu alert per (kode, strategi) per hari — cegah spam EventLog. */
export class MetricAlertLog {
  private emitted = new Map<string, string>();

  shouldEmit(code: string, strategyId: string, day: string): boolean {
    const key = `${code}:${strategyId}`;
    if (this.emitted.get(key) === day) return false;
    this.emitted.set(key, day);
    return true;
  }

  alreadyEmitted(): number {
    return this.emitted.size;
  }

  clear(): void {
    this.emitted.clear();
  }
}
