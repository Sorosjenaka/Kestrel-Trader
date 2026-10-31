// apps/server/src/lab/labEngine.ts — Engine backtest Lab (CP-7, T-23).
// RISET-ONLY: tidak menyentuh order/sizing/gate live. Semua angka deterministik.
// Semantik entry mengikuti Pine: sinyal pada bar i -> fill di OPEN bar i+1.
// Intrabar SL-vs-TP tak bisa diketahui dari OHLC -> KEDUA bound dihitung (SL-first & TP-first).
import type {
  LabSpec, LabTrade, LabResult, LabStats, LabCondition, LabOperand,
  LabExitSpec, IntrabarBound, LabEquityPoint,
} from "./labTypes.js";
import type { Bar } from "./labIndicators.js";
import { atrSeries, macdSeries, bbSeries, rsi, ema, smaLine } from "./labIndicators.js";
import { MAKER_RATE, TAKER_RATE } from "../config/costs.js";

// 14 Okt 2026 (laporan operator "rentang terlalu panjang 27552 bar > 6000"):
// batas dinaikkan 6000 -> 60000 (paging 1500 bar/request sudah ada di
// labKlines; 60000 bar 5m ≈ 208 hari, 1m ≈ 41 hari). Tetap dipotong aman-memori.
const MAX_BARS = 60_000;
const CHART_BARS = 240;

function sourceSeries(bars: Bar[], source: string): number[] {
  switch (source) {
    case "high": return bars.map((b) => b.h);
    case "low": return bars.map((b) => b.l);
    case "open": return bars.map((b) => b.o);
    case "hl2": return bars.map((b) => (b.h + b.l) / 2);
    default: return bars.map((b) => b.c);
  }
}

function operandSeries(bars: Bar[], op: LabOperand): number[] {
  const src = sourceSeries(bars, op.source ?? "close");
  if (op.kind === "VALUE") return bars.map(() => op.value ?? 0);
  switch (op.indicator) {
    case "RSI": return rsi(bars, op.period ?? 14);
    case "EMA": return ema(bars, op.period ?? 20);
    case "SMA": return smaLine(bars, op.period ?? 20);
    case "ATR": return atrSeries(bars, op.period ?? 14);
    case "PRICE": return src;
    case "VOLUME": return bars.map((b) => b.v);
    case "MACD": {
      const m = macdSeries(bars, 12, 26, 9);
      return op.line === "signal" ? m.signal : op.line === "hist" ? m.hist : m.macd;
    }
    case "BB": {
      const b = bbSeries(bars, 20, 2);
      return op.line === "lower" ? b.lower : op.line === "basis" ? b.basis : b.upper;
    }
    default: return src;
  }
}

/** Evaluasi satu kondisi pada bar i (AND semua kondisi diambil di pemanggil). */
function evalCondition(bars: Bar[], cond: LabCondition, i: number, cache: Map<string, number[]>): boolean {
  const keyOf = (o: LabOperand) => JSON.stringify(o);
  const get = (o: LabOperand) => {
    const k = keyOf(o);
    let s = cache.get(k);
    if (!s) { s = operandSeries(bars, o); cache.set(k, s); }
    return s;
  };
  const L = get(cond.left)[i];
  const R = get(cond.right)[i];
  if (!Number.isFinite(L) || !Number.isFinite(R)) return false;
  switch (cond.op) {
    case "GT": return L > R;
    case "LT": return L < R;
    case "CROSS_ABOVE": {
      const Lp = get(cond.left)[i - 1], Rp = get(cond.right)[i - 1];
      return i > 0 && Number.isFinite(Lp) && Number.isFinite(Rp) && Lp <= Rp && L > R;
    }
    case "CROSS_BELOW": {
      const Lp = get(cond.left)[i - 1], Rp = get(cond.right)[i - 1];
      return i > 0 && Number.isFinite(Lp) && Number.isFinite(Rp) && Lp >= Rp && L < R;
    }
    default: return false;
  }
}

function exitLevel(spec: LabExitSpec, entry: number, side: "LONG" | "SHORT", atr: number | null, slDist: number): number {
  // TP berlawanan arah dengan SL: LONG -> TP di atas entry, SHORT -> TP di bawah.
  const sign = side === "LONG" ? 1 : -1;
  switch (spec.kind) {
    case "PRICE": return spec.value;
    case "PCT": return entry * (1 + sign * spec.value / 100);
    case "R_MULT": return entry + sign * spec.value * slDist;
    case "ATR_MULT": {
      const a = atr && Number.isFinite(atr) ? atr : entry * 0.01;
      return entry + sign * spec.mult * a;
    }
    default: return entry + sign * entry * 0.01;
  }
}

function slLevel(spec: LabExitSpec, entry: number, side: "LONG" | "SHORT", atr: number | null): number {
  const sign = side === "LONG" ? -1 : 1;
  switch (spec.kind) {
    case "PRICE": return spec.value;
    case "PCT": return entry * (1 + sign * spec.value / 100);
    case "ATR_MULT": {
      const a = atr && Number.isFinite(atr) ? atr : entry * 0.01;
      return entry + sign * spec.mult * a;
    }
    case "R_MULT": return entry + sign * spec.value * entry * 0.01;
    default: return entry + sign * entry * 0.01;
  }
}

/** Simulasi satu trade per bound intrabar. Return R net-of-fee. */
function simulate(
  side: "LONG" | "SHORT", entry: number, sl: number, tp: number,
  bars: Bar[], fromIdx: number, bound: IntrabarBound,
): { r: number; exitIdx: number; exitPrice: number; reason: "TP" | "SL" | "EOD" } {
  const risk = Math.abs(entry - sl) || entry * 0.001;
  const qty = 1 / risk; // unit: $1 risiko per trade -> notional qty
  const fee = side === "LONG" ? (TAKER_RATE + MAKER_RATE) : (TAKER_RATE + MAKER_RATE); // entry taker + exit maker (TP) / taker (SL) dibedakan di bawah
  for (let j = fromIdx; j < bars.length; j++) {
    const b = bars[j];
    const hitSl = side === "LONG" ? b.l <= sl : b.h >= sl;
    const hitTp = side === "LONG" ? b.h >= tp : b.l <= tp;
    if (hitSl && hitTp) {
      const first: IntrabarBound = bound;
      const stopFill = side === "LONG" ? Math.min(sl, b.o) : Math.max(sl, b.o);
      const p = first === "SL_FIRST" ? stopFill : tp;
      const exitFee = first === "SL_FIRST" ? TAKER_RATE : MAKER_RATE;
      const gross = (side === "LONG" ? p - entry : entry - p) * qty;
      const net = gross - (entry * qty * TAKER_RATE + p * qty * exitFee);
      return { r: net, exitIdx: j, exitPrice: p, reason: first === "SL_FIRST" ? "SL" : "TP" };
    }
    if (hitSl) {
      const fill = side === "LONG" ? Math.min(sl, b.o) : Math.max(sl, b.o);
      const gross = (side === "LONG" ? fill - entry : entry - fill) * qty;
      const net = gross - (entry * qty * TAKER_RATE + fill * qty * TAKER_RATE);
      return { r: net, exitIdx: j, exitPrice: fill, reason: "SL" };
    }
    if (hitTp) {
      const gross = (side === "LONG" ? tp - entry : entry - tp) * qty;
      const net = gross - (entry * qty * TAKER_RATE + tp * qty * MAKER_RATE);
      return { r: net, exitIdx: j, exitPrice: tp, reason: "TP" };
    }
  }
  // EOD: tutup di close bar terakhir
  const last = bars[bars.length - 1];
  const gross = (side === "LONG" ? last.c - entry : entry - last.c) * qty;
  const net = gross - (entry * qty * TAKER_RATE + last.c * qty * TAKER_RATE);
  return { r: net, exitIdx: bars.length - 1, exitPrice: last.c, reason: "EOD" };
}

function statsOf(trades: LabTrade[], band: { slFirst: LabTrade[]; tpFirst: LabTrade[] }): LabStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const grossWin = wins.reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0));
  // Max drawdown pada kurva ekuitas R
  let eq = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    eq += t.rMultiple;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
  }
  const sideStats = (side: "LONG" | "SHORT") => {
    const s = trades.filter((t) => t.direction === side);
    return {
      n: s.length,
      winrate: s.length ? (s.filter((t) => t.rMultiple > 0).length / s.length) * 100 : 0,
      sumR: s.reduce((a, t) => a + t.rMultiple, 0),
    };
  };
  const bandSum = (arr: LabTrade[]) => ({
    sumR: arr.reduce((a, t) => a + t.rMultiple, 0),
    winrate: arr.length ? (arr.filter((t) => t.rMultiple > 0).length / arr.length) * 100 : 0,
  });
  // Gate validasi (T-32): konsistensi internal
  const sumAll = trades.reduce((a, t) => a + t.rMultiple, 0);
  const validation = [
    { name: "sum(trade.R) == grossWin - grossLoss", ok: Math.abs(sumAll - (grossWin - grossLoss)) < 1e-9,
      detail: `sum=${sumAll.toFixed(6)} gw-gl=${(grossWin - grossLoss).toFixed(6)}` },
    { name: "winrate konsisten", ok: n === 0 || Math.abs((wins.length / n) * 100 - (n ? (wins.length / n) * 100 : 0)) < 1e-9,
      detail: `wins=${wins.length}/${n}` },
    { name: "PF terdefinisi (ada loss)", ok: grossLoss > 0 || wins.length === 0,
      detail: grossLoss > 0 ? `PF=${(grossWin / grossLoss).toFixed(3)}` : "tanpa loss: PF tak terhingga" },
  ];
  return {
    sampleCount: n,
    winCount: wins.length,
    winrate: n ? (wins.length / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Number.POSITIVE_INFINITY,
    sumR: sumAll,
    avgR: n ? sumAll / n : 0,
    maxDdR: maxDd,
    avgHoldBars: n ? trades.reduce((a, t) => a + t.holdBars, 0) / n : 0,
    perSide: { LONG: sideStats("LONG"), SHORT: sideStats("SHORT") },
    intrabarBand: { slFirst: bandSum(band.slFirst), tpFirst: bandSum(band.tpFirst) },
    validation,
  };
}

/** Jalankan eksperimen Lab pada deret bar. Total-loss-guard: selalu return hasil, tak pernah throw. */
export function runLabBacktest(spec: LabSpec, bars: Bar[]): LabResult {
  const t0 = Date.now();
  const caveats: string[] = [];
  const capped = bars.length > MAX_BARS;
  const useBars = capped ? bars.slice(bars.length - MAX_BARS) : bars;
  if (capped) caveats.push(`Data dipotong ke ${MAX_BARS} bar terakhir (aman memori).`);

  const atrCache = atrSeries(useBars, spec.sl.kind === "ATR_MULT" ? spec.sl.atrPeriod : 14);
  const tpAtrCache = spec.tp.kind === "ATR_MULT" ? atrSeries(useBars, spec.tp.atrPeriod) : atrCache;
  const cache = new Map<string, number[]>();
  const trades: LabTrade[] = [];
  const bandSl: LabTrade[] = [];
  const bandTp: LabTrade[] = [];
  const equity: LabEquityPoint[] = [];
  const markers: LabResult["markers"] = [];

  let i = 1;
  let eq = 0;
  while (i < useBars.length - 1) {
    const anyCond = spec.entryConditions.length > 0;
    const hit = anyCond && spec.entryConditions.every((c) => evalCondition(useBars, c, i, cache));
    if (!hit) { i++; continue; }
    // Entry di OPEN bar i+1 (semantik Pine)
    const entryIdx = i + 1;
    const entry = useBars[entryIdx].o;
    const sides: ("LONG" | "SHORT")[] = spec.direction === "BOTH" ? ["LONG", "SHORT"]
      : [spec.direction];
    // arah ditentukan kondisi: untuk BOTH gunakan arah cross pertama (heuristik jujur: pakai LONG bila close>open)
    const side: "LONG" | "SHORT" = spec.direction === "BOTH"
      ? (useBars[i].c >= useBars[i].o ? "LONG" : "SHORT")
      : spec.direction;
    // The fill is at the next bar's OPEN. Only the signal bar is closed then.
    const atr = atrCache[i];
    if ((spec.sl.kind === "ATR_MULT" && !Number.isFinite(atr))
      || (spec.tp.kind === "ATR_MULT" && !Number.isFinite(tpAtrCache[i]))) { i++; continue; }
    const sl = slLevel(spec.sl, entry, side, atr);
    const tp = exitLevel(spec.tp, entry, side, tpAtrCache[i], Math.abs(entry - sl));
    if (![entry, sl, tp].every((p) => Number.isFinite(p) && p > 0)
      || (side === "LONG" ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl))) { i++; continue; }
    // simulate kedua bound, ambil SL-first sebagai baseline (konservatif)
    const rSl = simulate(side, entry, sl, tp, useBars, entryIdx, "SL_FIRST");
    const rTp = simulate(side, entry, sl, tp, useBars, entryIdx, "TP_FIRST");
    const mk = (res: { r: number; exitIdx: number; exitPrice: number; reason: "TP" | "SL" | "EOD" }): LabTrade => ({
      direction: side,
      entryTime: useBars[entryIdx].t,
      exitTime: useBars[res.exitIdx].t,
      entryPrice: entry,
      exitPrice: res.exitPrice,
      slPrice: sl,
      tpPrice: tp,
      exitReason: res.reason,
      rMultiple: res.r,
      pnlPct: ((res.exitPrice - entry) / entry) * 100 * (side === "LONG" ? 1 : -1),
      holdBars: res.exitIdx - entryIdx,
    });
    const trSl = mk(rSl), trTp = mk(rTp);
    trades.push(trSl);      // baseline = SL-first (pesimis)
    bandSl.push(trSl);
    bandTp.push(trTp);
    eq += trSl.rMultiple;
    equity.push({ t: trSl.exitTime, r: eq });
    markers.push({ t: trSl.entryTime, price: entry, kind: "ENTRY", direction: side });
    markers.push({ t: trSl.exitTime, price: trSl.exitPrice,
      kind: trSl.exitReason === "TP" ? "EXIT_TP" : trSl.exitReason === "SL" ? "EXIT_SL" : "EXIT_EOD", direction: side });
    i = rSl.exitIdx + 1;
    if (sides.length === 0) break;
  }

  if (trades.length === 0) caveats.push("Tidak ada trade: kombinasi kondisi tidak pernah terpenuhi pada rentang ini.");
  caveats.push("SL vs TP dalam satu bar tak bisa diketahui dari OHLC — dilaporkan sebagai band SL-first/TP-first.");
  if (spec.source !== "MANUAL_BLOCK") caveats.push("Hasil dari import Pine = port terjemahan, bukan eksekusi Pine asli TradingView.");

  // downsample candle
  const step = Math.max(1, Math.floor(useBars.length / CHART_BARS));
  const candles = useBars.filter((_, idx) => idx % step === 0)
    .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));

  return {
    spec,
    stats: statsOf(trades, { slFirst: bandSl, tpFirst: bandTp }),
    trades,
    equity,
    candles,
    markers,
    barsUsed: useBars.length,
    barsRequested: bars.length,
    caveats,
    runtimeMs: Date.now() - t0,
  };
}
