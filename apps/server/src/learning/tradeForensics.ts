import type { TradeForEvaluation } from "./postMortemEvaluator.js";
import { emaSeries, structurePivots, vwapSession } from "../engines/indicatorLibrary.js";

export interface ForensicBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EvidenceFact {
  id: string;
  value: string | number | boolean | null;
  status: "OBSERVED" | "DERIVED" | "UNKNOWN";
  method: string;
}

/** SMB T-07: satu titik timeline beranotasi (bar kunci) untuk studi kasus. */
export interface AnnotatedTimelinePoint {
  label: "ENTRY" | "MAE" | "MFE" | "EXIT";
  /** ID evidence yang sah disitasi (masuk facts dengan id sama). */
  evidenceId: string;
  status: "OBSERVED" | "UNKNOWN";
  openTime?: number;
  close?: number;
  ema9?: number | null;
  vwap?: number | null;
  distEma9Pct?: number | null;
  distVwapPct?: number | null;
  note?: string;
}

export interface TradeForensicBundle {
  schemaVersion: 1;
  source: "BINANCE_USDM_KLINES" | "UNAVAILABLE";
  interval: "1m" | "5m";
  fetchedAt: string;
  coverage: Record<string, { expectedBars: number; receivedBars: number; complete: boolean }>;
  facts: EvidenceFact[];
  /** SMB T-07: walkthrough bar kunci (entry/MAE/MFE/exit) + jarak ke EMA9 & VWAP. */
  annotatedTimeline: AnnotatedTimelinePoint[];
  limitation: string;
}

export interface AgentRoundtable {
  status: "COMPLETED" | "FAILED";
  modelUsed: string | null;
  synthesis: string;
  agreements: string[];
  disagreements: string[];
  commonTests: string[];
  evidenceRefs: string[];
  failureCode?: string;
}

const BENCHMARKS = ["BTCUSDT", "ETHUSDT", "BTCDOMUSDT"] as const;

function validBar(value: ForensicBar): boolean {
  return [value.openTime, value.open, value.high, value.low, value.close, value.volume].every(Number.isFinite)
    && value.open > 0 && value.close > 0 && value.low > 0 && value.volume >= 0
    && value.high >= Math.max(value.open, value.close, value.low)
    && value.low <= Math.min(value.open, value.close, value.high);
}

function coverage(bars: ForensicBar[], from: number, to: number, intervalMs: number) {
  const expectedStart = Math.floor(from / intervalMs) * intervalMs;
  const expectedEnd = Math.ceil(to / intervalMs) * intervalMs;
  const expectedBars = Math.max(0, Math.round((expectedEnd - expectedStart) / intervalMs));
  const clean = bars.filter(validBar).sort((a, b) => a.openTime - b.openTime);
  const unique = clean.filter((bar, index) => index === 0 || clean[index - 1]!.openTime !== bar.openTime);
  const timestamps = new Set(unique.map((bar) => bar.openTime));
  let receivedBars = 0;
  for (let time = expectedStart; time < expectedEnd; time += intervalMs) {
    if (timestamps.has(time)) receivedBars++;
  }
  return { expectedBars, receivedBars, complete: expectedBars > 0 && receivedBars === expectedBars };
}

function atrBeforeEntry(bars: ForensicBar[], entryAt: number | undefined, intervalMs: number, period = 14): number | null {
  if (!entryAt) return null;
  const history = bars.filter((bar) => bar.openTime + intervalMs <= entryAt && validBar(bar)).sort((a, b) => a.openTime - b.openTime);
  if (history.length < period + 1) return null;
  const selected = history.slice(-(period + 1));
  if (selected.some((bar, index) => index > 0 && bar.openTime - selected[index - 1]!.openTime !== intervalMs)) return null;
  const ranges = selected.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - selected[index]!.close),
    Math.abs(bar.low - selected[index]!.close),
  ));
  return ranges.length === period ? ranges.reduce((sum, value) => sum + value, 0) / period : null;
}

function benchmarkReturn(bars: ForensicBar[], from: number, to: number, intervalMs: number): number | null {
  const start = Math.floor(from / intervalMs) * intervalMs;
  const end = Math.ceil(to / intervalMs) * intervalMs;
  const range = bars.filter((bar) => validBar(bar) && bar.openTime >= start && bar.openTime < end)
    .sort((a, b) => a.openTime - b.openTime);
  if (range.length < 2 || range[0]!.open <= 0 || !coverage(bars, from, to, intervalMs).complete
    || range.some((bar, index) => index > 0 && bar.openTime - range[index - 1]!.openTime !== intervalMs)) return null;
  return Number(((range.at(-1)!.close / range[0]!.open - 1) * 100).toFixed(4));
}

function add(facts: EvidenceFact[], id: string, value: EvidenceFact["value"], status: EvidenceFact["status"], method: string) {
  facts.push({ id, value, status, method });
}

export function buildTradeForensicBundle(input: {
  trade: TradeForEvaluation;
  interval: "1m" | "5m";
  barsBySymbol: Record<string, ForensicBar[]>;
  fetchedAt?: Date;
}): TradeForensicBundle {
  const { trade, interval, barsBySymbol } = input;
  const intervalMs = interval === "1m" ? 60_000 : 300_000;
  const openedAt = trade.openedAt?.getTime();
  const closedAt = trade.closedAt?.getTime() ?? trade.createdAt?.getTime();
  const from = openedAt ?? 0;
  const to = closedAt ?? 0;
  const facts: EvidenceFact[] = [];
  const coverageBySymbol: TradeForensicBundle["coverage"] = {};
  const bars = barsBySymbol[trade.symbol] ?? [];

  if (!(from > 0 && to > from)) {
    add(facts, "trade.path_time_window", null, "UNKNOWN", "Position openedAt/closedAt is unavailable or invalid");
  } else {
    for (const symbol of [trade.symbol, ...BENCHMARKS]) {
      const symbolBars = barsBySymbol[symbol] ?? [];
      coverageBySymbol[symbol] = coverage(symbolBars, from, to, intervalMs);
      add(facts, `coverage.${symbol}`, coverageBySymbol[symbol]!.complete, "DERIVED", "Expected UTC candle timestamps compared with unique valid Binance klines");
    }
    // Include candles overlapping the position window. Their high/low can include
    // price action from before entry or after exit, so a touch is only a range
    // observation and never proof that the open position was stopped out.
    const path = bars.filter((bar) => validBar(bar) && bar.openTime < to && bar.openTime + intervalMs > from).sort((a, b) => a.openTime - b.openTime);
    const sl = trade.plannedSlPrice;
    const tp1 = trade.plannedTp1Price;
    const stopKnown = typeof sl === "number" && Number.isFinite(sl) && sl > 0;
    const tp1Known = typeof tp1 === "number" && Number.isFinite(tp1) && tp1 > 0;
    const stopTouched = stopKnown && path.some((bar) => trade.side === "LONG" ? bar.low <= sl : bar.high >= sl);
    const sameBarStopTarget = stopKnown && tp1Known && path.some((bar) =>
      (trade.side === "LONG" ? bar.low <= sl && bar.high >= tp1 : bar.high >= sl && bar.low <= tp1));
    const tradeCoverageComplete = coverageBySymbol[trade.symbol]?.complete === true;
    add(facts, "path.sl_level_touched", stopKnown && tradeCoverageComplete ? stopTouched : stopTouched ? true : null,
      stopTouched ? "DERIVED" : stopKnown && tradeCoverageComplete ? "DERIVED" : "UNKNOWN",
      "OHLC range of candles overlapping the trade crossed original stop; boundary candles may contain pre-entry/post-exit movement and this does not prove an order fill");
    add(facts, "path.stop_tp1_same_bar", stopKnown && tp1Known && tradeCoverageComplete ? sameBarStopTarget : sameBarStopTarget ? true : null,
      sameBarStopTarget ? "DERIVED" : stopKnown && tp1Known && tradeCoverageComplete ? "DERIVED" : "UNKNOWN",
      "OHLC candle range crossed both levels; intrabar sequence and whether crossings occurred while position was open are unknowable from OHLC");

    const atr = atrBeforeEntry(bars, openedAt, intervalMs);
    const slDistance = typeof sl === "number" ? Math.abs(trade.entryAvg - sl) : null;
    add(facts, "entry.atr14", atr === null ? null : Number(atr.toPrecision(8)), atr === null ? "UNKNOWN" : "DERIVED", "ATR(14) from candles strictly before the position opened");
    add(facts, "entry.sl_atr_ratio", atr && slDistance !== null ? Number((slDistance / atr).toFixed(3)) : null,
      atr && slDistance !== null ? "DERIVED" : "UNKNOWN", "Original stop distance divided by pre-entry ATR(14); descriptive, not a causal verdict");

    const afterStart = Math.ceil(to / intervalMs) * intervalMs;
    const after = bars.filter((bar) => validBar(bar) && bar.openTime >= afterStart && bar.openTime < afterStart + intervalMs * 6).sort((a, b) => a.openTime - b.openTime);
    const sixBarsComplete = after.length === 6 && after.every((bar, index) => bar.openTime === afterStart + index * intervalMs);
    const recoveredPastEntry = trade.closeReason === "SL" && sixBarsComplete && after.some((bar) => trade.side === "LONG" ? bar.close > trade.entryAvg : bar.close < trade.entryAvg);
    add(facts, "path.post_stop_entry_reclaim_within_6_bars", trade.closeReason === "SL" && sixBarsComplete ? recoveredPastEntry : null, recoveredPastEntry ? "DERIVED" : trade.closeReason === "SL" && sixBarsComplete ? "DERIVED" : "UNKNOWN",
      "Close after the recorded SL exit crossed back beyond entry; not evidence of intentional stop hunting");

    for (const benchmark of BENCHMARKS) {
      const value = benchmarkReturn(barsBySymbol[benchmark] ?? [], from, to, intervalMs);
      add(facts, `benchmark.${benchmark}.return_pct`, value, value === null ? "UNKNOWN" : "DERIVED",
        "Same-window benchmark candle open-to-close return; context only, not proof of cause");
    }
  }

  // ── SMB T-07 (9 Okt 2026): konteks teknikal pra-entry + timeline beranotasi ──
  // 100% deterministik TS. Indikator di sini PELABEL KONTEKS, bukan gate/sinyal
  // (keputusan permanen 4 Okt 2026: tanpa filter sesi; VWAP anchor UTC hanya konteks).
  const annotatedTimeline: AnnotatedTimelinePoint[] = [];
  const cleanBars = bars.filter(validBar).sort((a, b) => a.openTime - b.openTime);
  if (from > 0 && to > from && cleanBars.length > 0) {
    const preEntry = cleanBars.filter((b) => b.openTime + intervalMs <= from);
    const pivots = structurePivots(preEntry, 2);
    const supports = pivots.lows.filter((lvl) => lvl < trade.entryAvg);
    const resistances = pivots.highs.filter((lvl) => lvl > trade.entryAvg);
    const nearestSupport = supports.length ? Math.max(...supports) : null;
    const nearestResistance = resistances.length ? Math.min(...resistances) : null;
    add(facts, "context.nearest_support_pre_entry", nearestSupport, nearestSupport === null ? "UNKNOWN" : "DERIVED",
      "Pivot low terkonfirmasi terdekat di bawah entry, hanya dari bar yang sudah tutup sebelum entry (strength 2); konteks struktur, bukan sebab");
    add(facts, "context.nearest_resistance_pre_entry", nearestResistance, nearestResistance === null ? "UNKNOWN" : "DERIVED",
      "Pivot high terkonfirmasi terdekat di atas entry, hanya dari bar yang sudah tutup sebelum entry (strength 2); konteks struktur, bukan sebab");

    const ema9Series = emaSeries(cleanBars.map((b) => b.close), 9);
    const barAt = (timeMs: number) => cleanBars.findIndex((b) => b.openTime <= timeMs && timeMs < b.openTime + intervalMs);
    // 13 Okt 2026 (audit live ACC2): MAE/MFE hanya dicari di bar SELAMA posisi
    // terbuka [from, to). Pencarian lama memakai seluruh cleanBars sehingga
    // ekstrem pra-entry bisa terpilih — timestamp timeline MAE/MFE mendahului
    // ENTRY (anomali MAE 18:06 < entry 18:14 pada posisi #3030).
    const liveStart = cleanBars.findIndex((b) => b.openTime + intervalMs > from);
    const liveEndSearch = cleanBars.findIndex((b) => b.openTime >= to); // bar EXIT (memuat `to`) tetap ikut
    const startIdx = liveStart === -1 ? cleanBars.length : liveStart;
    const endIdx = liveEndSearch === -1 ? cleanBars.length : liveEndSearch;
    const extremeBar = (price: number | null | undefined, kind: "low" | "high") => {
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return -1;
      let best = -1;
      let bestDist = Infinity;
      for (let i = startIdx; i < endIdx; i++) {
        const ref = kind === "low" ? cleanBars[i]!.low : cleanBars[i]!.high;
        const dist = Math.abs(ref - price);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      return best;
    };
    const emitPoint = (label: AnnotatedTimelinePoint["label"], barIndex: number, note: string) => {
      const evidenceId = `timeline.${label}`;
      if (barIndex < 0) {
        annotatedTimeline.push({ label, evidenceId, status: "UNKNOWN", note });
        add(facts, evidenceId, null, "UNKNOWN", note);
        return;
      }
      const bar = cleanBars[barIndex]!;
      const ema9Raw = ema9Series[barIndex];
      const ema9Val = typeof ema9Raw === "number" && Number.isFinite(ema9Raw) ? ema9Raw : null;
      const vwapVal = vwapSession(cleanBars, bar.openTime);
      const distEma9Pct = ema9Val ? ((bar.close - ema9Val) / ema9Val) * 100 : null;
      const distVwapPct = vwapVal ? ((bar.close - vwapVal) / vwapVal) * 100 : null;
      annotatedTimeline.push({ label, evidenceId, status: "OBSERVED", openTime: bar.openTime, close: bar.close, ema9: ema9Val, vwap: vwapVal, distEma9Pct, distVwapPct });
      add(facts, evidenceId,
        `t=${new Date(bar.openTime).toISOString()} close=${bar.close} ema9=${ema9Val ?? "n/a"} vwap=${vwapVal === null ? "n/a" : vwapVal.toFixed(8)} distEma9=${distEma9Pct === null ? "n/a" : `${distEma9Pct.toFixed(3)}%`} distVwap=${distVwapPct === null ? "n/a" : `${distVwapPct.toFixed(3)}%`}`,
        "DERIVED", note);
      if (label === "ENTRY") {
        add(facts, "context.ema9_at_entry", ema9Val, ema9Val === null ? "UNKNOWN" : "DERIVED", "EMA(9) pada bar entry; pelabel konteks, bukan sinyal entry");
        add(facts, "context.vwap_at_entry", vwapVal, vwapVal === null ? "UNKNOWN" : "DERIVED", "VWAP anchor UTC 00:00 s/d bar entry; pelabel konteks, bukan gate sesi");
      }
    };
    emitPoint("ENTRY", barAt(from), "Bar yang memuat openedAt posisi");
    // MAE/MFE: LONG = ekstrem low/high; SHORT kebalikannya.
    const maeKind = trade.side === "SHORT" ? "high" : "low";
    const mfeKind = trade.side === "SHORT" ? "low" : "high";
    emitPoint("MAE", extremeBar(trade.maePrice, maeKind), trade.maePrice == null ? "maePrice tidak tercatat; bar MAE tidak bisa dilokalisasi dari OHLC" : "Bar dengan ekstrem terdekat ke maePrice tercatat (floating loss terdalam; aproksimasi bar, bukan tick)");
    emitPoint("MFE", extremeBar(trade.mfePrice, mfeKind), trade.mfePrice == null ? "mfePrice tidak tercatat; bar MFE tidak bisa dilokalisasi dari OHLC" : "Bar dengan ekstrem terdekat ke mfePrice tercatat (floating profit tertinggi; aproksimasi bar, bukan tick)");
    emitPoint("EXIT", barAt(to), "Bar yang memuat closedAt posisi");
  }

  add(facts, "trade.pnl_usd", trade.pnlUsd, "OBSERVED", "Persisted net trade record; PAPER_SIMULATED when accountingQuality is SIMULATED");
  add(facts, "trade.r_multiple", trade.rMultiple, "OBSERVED", "Persisted trade record");
  add(facts, "trade.fee_usd", trade.feeUsd, "OBSERVED", "Persisted trade record; funding only if separately verified");

  const gotTradeBars = bars.some(validBar);
  return {
    schemaVersion: 1,
    source: gotTradeBars ? "BINANCE_USDM_KLINES" : "UNAVAILABLE",
    interval,
    fetchedAt: (input.fetchedAt ?? new Date()).toISOString(),
    coverage: coverageBySymbol,
    facts,
    annotatedTimeline,
    limitation: "Candle highs/lows show level crossings, not intrabar order or trader intent. Same-bar stop/target touches are ambiguous. A stop then rebound is a price-path observation, never proof of stop hunting. BTC/ETH/BTCDOM are same-window context benchmarks, not a representative global universe.",
  };
}

export function validateEvidenceRefs(refs: unknown, allowedIds: Set<string>): string[] | null {
  // 29 Sep 2026: versi lama menolak SELURUH daftar bila satu ref asing atau >12 refs,
  // sehingga review agen yang isinya valid ikut dibuang (INVALID_OR_UNCITED_REVIEW).
  // Kini disanitasi: ref asing tetap dibuang (anti-halusinasi tidak dilonggarkan),
  // daftar dipotong ke 12, dan null hanya dikembalikan bila tidak ada satu pun ref valid.
  if (!Array.isArray(refs)) return null;
  const known = refs.filter((ref): ref is string => typeof ref === "string" && allowedIds.has(ref));
  const unique = [...new Set(known)].slice(0, 12);
  return unique.length ? unique : null;
}
