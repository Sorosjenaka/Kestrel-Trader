// Supplementary long-history study (15m bars, 38-symbol frozen dataset).
// This is NOT the canonical 1m replay and is NOT gate-grade: funding is
// unmodeled. It exists to measure whether the frozen evaluators have enough
// historical signals for a 500-trade study when the 1m cache is too small.
// PAPER ONLY; no exchange/client/env imports.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAlgoModel, rswHistoricalAlgoSignals, rswHistoricalH4Signals } from "../apps/server/src/strategies/researchSwing/rswSignals.js";
import { aggregate, DAY, HOUR, type Bar as RswBar } from "../apps/server/src/strategies/researchSwing/rswPrimitives.js";
import { runSwingBreakoutSignals } from "../apps/server/src/strategies/swingBreakoutEngine.js";

type Bar = { openTime: number; open: number; high: number; low: number; close: number; volume: number };
type Signal = { time: number; side: "LONG" | "SHORT"; entry: number; sl: number; strategyId: string; symbol: string };
type Trade = { symbol: string; strategyId: string; side: "LONG" | "SHORT"; entryTime: number; exitTime: number; entryPrice: number; exitPrice: number; qty: number; grossPnlUsd: number; feesUsd: number; fundingUsd: number; netPnlUsd: number; netR: number; exitReason: string; ambiguous: boolean; tp1Time?: number; tp2Time?: number; fundingCoverage: "ACTUAL_EVENTS" | "PARTIAL"; };

const root = resolve(process.cwd());
const barsDir = join(root, "data", "swing-v16", "bars-long-history");
const outRoot = join(root, process.argv.find((x) => x.startsWith("--out="))?.slice(6) ?? "data/swing-9-findings/20261019T073000Z/research-15m-funded");
const RUN_ID = process.argv.find((x) => x.startsWith("--run-id="))?.slice(9) ?? `RESEARCH15M-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15)}`;
const TARGET = 500;
const HOUR_MS = 3_600_000;
const FUNDING_FILE = join(root, "data", "swing-v16", "long-history-funding.json");
const fundingBySymbol = JSON.parse(readFileSync(FUNDING_FILE, "utf8")) as Record<string, Array<[number, number]>>;
const fundingCache = new Map<string, Array<{ time: number; rate: number }>>();
function fundingEvents(symbol: string): Array<{ time: number; rate: number }> {
  const cached = fundingCache.get(symbol); if (cached) return cached;
  const out = (fundingBySymbol[symbol] ?? []).map(([time, rate]) => ({ time, rate })).filter((x) => Number.isFinite(x.time) && Number.isFinite(x.rate)).sort((a, b) => a.time - b.time);
  fundingCache.set(symbol, out); return out;
}
function barCloseAt(bars: Bar[], time: number): number | null {
  let lo = 0, hi = bars.length - 1, found: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const b = bars[mid]!;
    if (b.openTime <= time) { found = b; lo = mid + 1; } else hi = mid - 1;
  }
  return found && time < found.openTime + 900_000 ? found.close : null;
}

function load15m(file: string): RswBar[] {
  const text = readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => line.split(",")).filter((x) => x.length >= 6 && Number.isFinite(Number(x[0]))).map((x) => ({
    time: Number(x[0]), openTime: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]), volume: Number(x[5]),
  }));
}

function sha(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function simulate(signal: Signal, bars: Bar[], funding: Array<{ time: number; rate: number }>): Trade | null {
  const signalIndex = bars.findIndex((b) => b.openTime >= signal.time);
  if (signalIndex < 1 || signalIndex + 1 >= bars.length) return null;
  const entryBar = bars[signalIndex]!;
  const entry = entryBar.open;
  if (!(entry > 0) || Math.abs(entry - signal.entry) / signal.entry > 0.01) return null;
  const risk = Math.abs(entry - signal.sl);
  if (!(risk > 0) || risk / entry < 0.0001) return null;
  const qty = 1 / risk; // $1 planned price risk
  if (entry * qty < 5) return null;
  const sign = signal.side === "LONG" ? 1 : -1;
  const tp1 = entry + sign * 2 * risk;
  const tp2 = entry + sign * 3 * risk;
  let stop = signal.sl;
  let remaining = qty;
  let gross = 0;
  let fees = 0;
  let exitPrice = entry;
  let exitTime = entryBar.openTime + 900_000;
  let exitReason = "OPEN";
  let tp1Done = false;
  let tp1Time: number | undefined;
  let tp2Time: number | undefined;
  let ambiguous = false;
  // Conservative: stop is checked before targets in every 15m bar.
  for (let i = signalIndex + 1; i < bars.length; i++) {
    const b = bars[i]!;
    const stopHit = signal.side === "LONG" ? b.low <= stop : b.high >= stop;
    const tp1Hit = !tp1Done && (signal.side === "LONG" ? b.high >= tp1 : b.low <= tp1);
    const tp2Hit = tp1Done && (signal.side === "LONG" ? b.high >= tp2 : b.low <= tp2);
    if (stopHit && (tp1Hit || tp2Hit)) ambiguous = true;
    if (stopHit) {
      const px = signal.side === "LONG" ? Math.min(stop, b.open) : Math.max(stop, b.open);
      gross += sign * (px - entry) * remaining;
      fees += px * remaining * 0.0005;
      remaining = 0;
      exitPrice = px; exitTime = b.time + 900_000; exitReason = tp1Done ? "BE" : "SL";
      break;
    }
    if (tp1Hit) {
      const half = remaining / 2;
      gross += sign * (tp1 - entry) * half;
      fees += tp1 * half * 0.0002;
      remaining -= half;
      tp1Done = true;
      tp1Time = b.time + 900_000;
      stop = entry;
      exitPrice = tp1; exitTime = b.time + 900_000; exitReason = "TP1";
    }
    if (tp2Hit && remaining > 0) {
      gross += sign * (tp2 - entry) * remaining;
      fees += tp2 * remaining * 0.0002;
      remaining = 0;
      tp2Time = b.time + 900_000;
      exitPrice = tp2; exitTime = b.time + 900_000; exitReason = "TP2";
      break;
    }
    if (remaining <= 1e-12) break;
  }
  if (remaining > 1e-12) return null; // do not force-close at data end
  fees += entry * qty * 0.0005; // entry taker (conservative)
  // Funding is a signed cashflow: positive = received. LONG pays a positive
  // rate; SHORT receives it. Residual quantity drops after TP1/TP2.
  let fundingUsd = 0;
  let missingFunding = false;
  for (const f of funding) {
    if (f.time <= entryBar.openTime || f.time >= exitTime) continue;
    const qtyOpen = (tp1Time !== undefined && f.time >= tp1Time)
      ? (tp2Time !== undefined && f.time >= tp2Time ? 0 : qty / 2)
      : qty;
    if (qtyOpen <= 0) continue;
    const close = barCloseAt(bars, f.time);
    if (close === null) { missingFunding = true; continue; }
    fundingUsd += -sign * f.rate * close * qtyOpen;
  }
  const net = gross - fees + fundingUsd;
  return { symbol: signal.symbol, strategyId: signal.strategyId, side: signal.side, entryTime: entryBar.openTime, exitTime, entryPrice: entry, exitPrice, qty, grossPnlUsd: gross, feesUsd: fees, fundingUsd, netPnlUsd: net, netR: net, exitReason, ambiguous, tp1Time, tp2Time, fundingCoverage: missingFunding ? "PARTIAL" : "ACTUAL_EVENTS" };
}

function metrics(trades: Trade[]) {
  const wins = trades.filter((t) => t.netPnlUsd > 1e-9);
  const losses = trades.filter((t) => t.netPnlUsd < -1e-9);
  const grossWin = wins.reduce((a, t) => a + t.netPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnlUsd, 0));
  const net = trades.reduce((a, t) => a + t.netPnlUsd, 0);
  const longs = trades.filter((t) => t.side === "LONG").length;
  let equity = 200, peak = 200, dd = 0;
  for (const t of trades) { equity += t.netPnlUsd; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  return { samples: trades.length, wins: wins.length, losses: losses.length, breakeven: trades.length - wins.length - losses.length, winratePct: trades.length ? 100 * wins.length / trades.length : null, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, netPnlUsd: net, evUsd: trades.length ? net / trades.length : null, evR: trades.length ? trades.reduce((a, t) => a + t.netR, 0) / trades.length : null, totalFeesUsd: trades.reduce((a, t) => a + t.feesUsd, 0), totalFundingUsd: trades.reduce((a, t) => a + t.fundingUsd, 0), maxDdUsd: dd, equityEndUsd: equity, long: longs, short: trades.length - longs, fundingCoverage: trades.every((t) => t.fundingCoverage === "ACTUAL_EVENTS") ? "ACTUAL_EVENTS" : "PARTIAL", ambiguousBars: trades.filter((t) => t.ambiguous).length };
}

function main() {
  const files = readdirSync(barsDir).filter((f) => f.endsWith("-15m.csv")).sort();
  const btcFile = join(barsDir, "BTCUSDT-15m.csv");
  const btc = load15m(btcFile);
  const btcDaily = aggregate(btc, DAY);
  const seed = JSON.parse(readFileSync(join(root, "research", "swing_paper_algo_seed.json"), "utf8"));
  const model = parseAlgoModel(seed);
  const byStrategy: Record<string, Trade[]> = { "S-05": [], "RSW-01": [], "RSW-02": [], "RSW-03": [] };
  const coverage: Record<string, unknown> = {};
  for (const file of files) {
    const symbol = file.replace("-15m.csv", "");
    const b = load15m(join(barsDir, file));
    const h4 = aggregate(b, 4 * HOUR);
    const h1 = aggregate(b, HOUR);
    const h1Engine = aggregate(b, HOUR).map((x) => ({ openTime: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
    const rswH4 = rswHistoricalH4Signals(symbol, h4, btcDaily);
    const rswAlgo = rswHistoricalAlgoSignals(symbol, h1, h4, model);
    const s05 = runSwingBreakoutSignals(h1Engine).map((s) => ({ time: s.time, side: s.side, entry: s.entry, sl: s.sl, strategyId: "S-05", symbol }));
    // RswSignal has time/open semantics; map to the shared simulator contract.
    const rsw = [...rswH4, ...rswAlgo].map((s) => ({ time: s.time, side: s.side, entry: s.entry, sl: s.sl, strategyId: s.strategyId, symbol }));
    const all = [...s05, ...rsw] as Signal[];
    for (const sid of Object.keys(byStrategy)) {
      const signals = all.filter((s) => s.strategyId === sid).sort((a, b) => a.time - b.time || a.side.localeCompare(b.side));
      let busyUntil = -1;
      for (const s of signals) {
        if (s.time < busyUntil) continue;
        const t = simulate(s, b, fundingEvents(symbol));
        if (!t) continue;
        byStrategy[sid]!.push(t);
        busyUntil = t.exitTime;
      }
    }
    coverage[symbol] = { bars: b.length, h4: h4.length, h1: h1.length, s05Signals: s05.length, rswSignals: rsw.length };
    console.log(`[${symbol}] bars=${b.length} s05=${s05.length} rsw=${rsw.length}`);
  }
  mkdirSync(outRoot, { recursive: true });
  const summary: Record<string, unknown> = { schemaVersion: 2, runId: RUN_ID, generatedAt: new Date().toISOString(), mode: "PAPER_RESEARCH_ONLY_FUNDED_EVENTS", liveReady: false, engine: "frozen TS signal evaluators + deterministic 15m RR23 simulator + signed funding cashflow events", initialEquityUsd: 200, targetPerStrategy: TARGET, fundingCoverage: "ACTUAL_EVENTS", fundingSource: "data/swing-v16/long-history-funding.json", fundingMarkBasis: "bar close at settlement (research approximation)", feeModel: { entryTaker: 0.0005, tpMaker: 0.0002, slTaker: 0.0005 }, data: { root: barsDir, symbols: files.length, fingerprint: sha(btcFile), btcDailyBars: btcDaily.length }, strategies: {}, coverage };
  for (const [sid, allTrades] of Object.entries(byStrategy)) {
    allTrades.sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));
    const first = allTrades.slice(0, TARGET);
    const dir = join(outRoot, sid, RUN_ID);
    mkdirSync(dir, { recursive: true });
    const m = metrics(first);
    const report = { schemaVersion: 1, runId: RUN_ID, strategyId: sid, status: first.length >= TARGET ? "TARGET_MET_RESEARCH_FUNDED" : allTrades.length ? "BELOW_TARGET_RESEARCH_FUNDED" : "NO_TRADES", target: TARGET, actualClosed: allTrades.length, firstN: first.length, metrics: m, directionBreakdown: { long: m.long, short: m.short, longPct: first.length ? 100 * m.long / first.length : null, shortPct: first.length ? 100 * m.short / first.length : null }, equityStartUsd: 200, equityEndUsd: m.equityEndUsd, fundingCoverage: m.fundingCoverage, feeCoverage: "RECORDED", provenance: { singleSymbol: true, portfolioReplayed: false, fundingReplayed: true, fundingMarkBasis: "bar close at settlement", evaluationIsOOS: false, note: "Supplementary 15m study with signed funding events; still not a canonical 1m gate result." } };
    writeFileSync(join(dir, "trades.json"), JSON.stringify(first, null, 2));
    writeFileSync(join(dir, "all-trades.json"), JSON.stringify(allTrades, null, 2));
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(dir, "equity.csv"), "n,equityUsd\n" + first.reduce((rows, t, i) => rows + `${i + 1},${(200 + first.slice(0, i + 1).reduce((a, x) => a + x.netPnlUsd, 0)).toFixed(4)}\n`, "0,200.0000\n"));
    summary.strategies = { ...(summary.strategies as Record<string, unknown>), [sid]: report };
  }
  writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outRoot, "summary.md"), `# Supplementary 15m history study ${RUN_ID}\n\nStatus: **PAPER_RESEARCH_ONLY_FUNDED_EVENTS**, signed funding events from the public long-history file. This is not the canonical 1m replay and must not be presented as a gate result.\n\n| Strategy | Status | Closed | First N | LONG | SHORT | WR | PF | EV | Net | DD | End equity |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${Object.values(summary.strategies as Record<string, any>).map((r) => `| ${r.strategyId} | ${r.status} | ${r.actualClosed} | ${r.firstN} | ${r.directionBreakdown.long} | ${r.directionBreakdown.short} | ${r.metrics.winratePct?.toFixed(2) ?? "—"}% | ${r.metrics.profitFactor?.toFixed(2) ?? "—"} | $${r.metrics.evUsd?.toFixed(4) ?? "—"} | $${r.metrics.netPnlUsd.toFixed(4)} | $${r.metrics.maxDdUsd.toFixed(4)} | $${r.equityEndUsd.toFixed(2)} |`).join("\n")}\n\nData: ${files.length} symbols, 15m frozen cache; no funding replay. Do not use this to claim gate PASS.\n`);
  console.log(JSON.stringify({ out: outRoot, runId: RUN_ID, strategies: Object.fromEntries(Object.entries(summary.strategies as Record<string, any>).map(([k, v]) => [k, { status: v.status, actual: v.actualClosed, first: v.firstN, metrics: v.metrics }])) }, null, 2));
}

main();
