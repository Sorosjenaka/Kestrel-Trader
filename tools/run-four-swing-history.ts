// Four-strategy historical study runner. PAPER ONLY. This script never imports
// exchange clients, credentials, or LIVE/SCALP code. It uses the canonical
// single-symbol historical replay engine and reports every funnel/ledger row.
//
// Usage:
//   npx tsx tools/run-four-swing-history.ts --target 500 --out data/swing-500-history-200usd
//
// The engine is SINGLE_SYMBOL at this boundary. The report is therefore a
// pooled study of independent symbol ledgers, not a portfolio replay. The
// separate portfolio report must enforce shared slots/losses.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runStrategyBacktest,
  calculateMetrics,
  type TradeResult,
} from "../apps/server/src/backtest/backtestEngine.js";
import {
  aggregateClosedBars,
  validateHistoricalDataset,
  type HistoricalDataset,
} from "../apps/server/src/backtest/historicalReplay.js";

const root = resolve(process.cwd());
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const TARGET = Number(arg("target", "500"));
const OUT = resolve(root, arg("out", "data/swing-500-history-200usd")!);
const HISTORY = resolve(root, arg("history", "data/history")!);
const ONLY = (arg("symbols", "") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const STRATEGIES = ["S-05", "RSW-01", "RSW-02", "RSW-03"];
const RUN_ID = arg("run-id", `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15)}`)!;

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function main() {
  const files = (() => {
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readdirSync(HISTORY).filter((f) => f.endsWith("_1m.json")).sort();
  })();
  const wanted = ONLY.length ? new Set(ONLY) : null;
  const datasets: Array<{ symbol: string; data: HistoricalDataset; file: string; sha256: string }> = [];
  for (const file of files) {
    const symbol = file.replace(/_1m\.json$/, "");
    if (wanted && !wanted.has(symbol)) continue;
    const raw = readFileSync(join(HISTORY, file), "utf8");
    const data = JSON.parse(raw) as HistoricalDataset;
    const errors = validateHistoricalDataset(data);
    if (errors.length) throw new Error(`${symbol}: ${errors.join(",")}`);
    datasets.push({ symbol, data, file, sha256: createHash("sha256").update(raw).digest("hex") });
  }
  if (!datasets.length) throw new Error("NO_VALID_HISTORY_DATASETS");
  const btc = datasets.find((d) => d.symbol === "BTCUSDT");
  const btcDailyBars = btc
    ? aggregateClosedBars(btc.data.bars, 86_400_000, btc.data.outOfSampleTo, btc.data.intervalMs)
    : [];

  mkdirSync(OUT, { recursive: true });
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    mode: "PAPER",
    liveReady: false,
    initialEquityUsd: 200,
    targetClosedPerStrategy: TARGET,
    riskUsd: 1,
    feeModel: { makerRate: 0.0002, takerRate: 0.0005, entry: "taker", exits: "RR23 replay convention" },
    marginMode: "CROSS",
    leverage: 25,
    dataRoot: HISTORY,
    symbols: datasets.map((d) => d.symbol),
    datasetManifest: datasets.map((d) => ({
      symbol: d.symbol, file: d.file, sha256: d.sha256,
      bars: d.data.bars.length, funding: d.data.funding.length,
      oosFrom: d.data.outOfSampleFrom, oosTo: d.data.outOfSampleTo,
      source: d.data.source,
    })),
    strategies: {},
  };

  for (const strategyId of STRATEGIES) {
    const runDir = join(OUT, strategyId, RUN_ID);
    mkdirSync(runDir, { recursive: true });
    const trades: TradeResult[] = [];
    const perSymbol: unknown[] = [];
    const errors: string[] = [];
    const started = Date.now();
    for (const d of datasets) {
      try {
        const result = runStrategyBacktest({
          strategyId,
          mode: "SWING",
          dataset: d.data,
          initialEquityUsd: 200,
          targetRiskUsd: 1,
          marginMode: "CROSS",
          maxDrawdownUsd: 1e9,
          minSamples: 1,
          minWinrate: 0,
          fees: { makerRate: 0.0002, takerRate: 0.0005 },
          slippageBps: 0,
          btcDailyBars,
        });
        const symbolTrades = result.trades ?? [];
        trades.push(...symbolTrades);
        perSymbol.push({
          symbol: d.symbol,
          trades: symbolTrades.length,
          plans: result.diagnostics?.funnel?.plans ?? 0,
          planLong: result.diagnostics?.funnel?.planLong ?? 0,
          planShort: result.diagnostics?.funnel?.planShort ?? 0,
          orderAllowed: result.diagnostics?.funnel?.orderAllowed ?? 0,
          orderRejected: result.diagnostics?.funnel?.orderRejected ?? 0,
          rejectReasons: result.diagnostics?.funnel?.orderRejectedReasons ?? {},
          closed: result.diagnostics?.funnel?.closedTrades ?? symbolTrades.length,
          openAtEnd: result.diagnostics?.funnel?.openTradesExcluded ?? 0,
          fundingCoverage: result.diagnostics?.funnel?.fundingCoverage ?? "UNKNOWN",
          errors: result.failedGateReasons,
        });
        if (result.failedGateReasons?.length) errors.push(`${d.symbol}:${result.failedGateReasons.join(",")}`);
      } catch (e) {
        errors.push(`${d.symbol}:${e instanceof Error ? e.message : "FAILED"}`);
      }
    }
    trades.sort((a, b) => a.entryAt.getTime() - b.entryAt.getTime() || a.symbol.localeCompare(b.symbol));
    const metrics = calculateMetrics(trades);
    const first500 = trades.slice(0, TARGET);
    const first500Metrics = calculateMetrics(first500);
    const equity = [200];
    for (const t of first500) equity.push(equity.at(-1)! + t.netPnlUsd);
    const longs = first500.filter((t) => t.direction === "LONG").length;
    const shorts = first500.filter((t) => t.direction === "SHORT").length;
    const status = first500.length >= TARGET ? "TARGET_MET" : trades.length === 0 ? "DATA_EXHAUSTED_NO_TRADES" : "DATA_EXHAUSTED_BELOW_TARGET";
    const report = {
      schemaVersion: 1,
      runId: RUN_ID,
      strategyId,
      mode: "SWING",
      engine: "canonical historicalReplay/runStrategyBacktest, $200, risk $1, CROSS 25x, RR23",
      status,
      target: TARGET,
      actualClosed: trades.length,
      firstN: first500.length,
      directionBreakdown: { long: longs, short: shorts, longPct: first500.length ? (100 * longs / first500.length) : null, shortPct: first500.length ? (100 * shorts / first500.length) : null },
      metricsAll: metrics,
      metricsFirstN: first500Metrics,
      equityStartUsd: 200,
      equityFirstNEndUsd: equity.at(-1),
      equityCurve: equity.map((value, i) => ({ n: i, equityUsd: Number(value.toFixed(6)) })),
      perSymbol,
      errors,
      elapsedMs: Date.now() - started,
      provenance: {
        singleSymbol: true,
        portfolioReplayed: false,
        llmReplayed: false,
        openTradesNotClosed: metrics.sampleCount !== trades.length,
        btcDailyContext: btcDailyBars.length,
        datasetHashes: datasets.map((d) => ({ symbol: d.symbol, sha256: d.sha256 })),
      },
    };
    writeFileSync(join(runDir, "trades.json"), JSON.stringify(trades, null, 2));
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
      runId: RUN_ID, strategyId, generatedAt: new Date().toISOString(),
      engine: "apps/server/src/backtest/backtestEngine.ts:runStrategyBacktest",
      files: ["trades.json", "manifest.json", "metrics.json", "funnel.json", "equity.csv"],
      sourceHashes: { engine: sha(readFileSync(join(root, "apps/server/src/backtest/backtestEngine.ts"), "utf8")), replay: sha(readFileSync(join(root, "apps/server/src/backtest/historicalReplay.ts"), "utf8")) },
    }, null, 2));
    writeFileSync(join(runDir, "metrics.json"), JSON.stringify({ status, metricsAll: metrics, metricsFirstN: first500Metrics, directionBreakdown: report.directionBreakdown }, null, 2));
    writeFileSync(join(runDir, "funnel.json"), JSON.stringify(perSymbol, null, 2));
    writeFileSync(join(runDir, "equity.csv"), "n,equityUsd\n" + report.equityCurve.map((x) => `${x.n},${x.equityUsd}`).join("\n") + "\n");
    summary.strategies = { ...(summary.strategies as Record<string, unknown>), [strategyId]: report };
    writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(OUT, "summary.md"), [
      `# Four SWING historical study — ${RUN_ID}`,
      ``,
      `Mode: PAPER. Initial equity: $200 per strategy. Risk: $1. CROSS 25x. RR23 50% @2R / BE / 50% @3R.`,
      `Engine: canonical single-symbol historical replay, **not** a portfolio replay.`,
      ``,
      `| Strategy | Status | Closed | First N | LONG | SHORT | WR | PF | EV USD | Net PnL | Max DD | End equity |`,
      `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
      ...Object.values(summary.strategies as Record<string, any>).map((r) => `| ${r.strategyId} | ${r.status} | ${r.actualClosed} | ${r.firstN} | ${r.directionBreakdown.long} | ${r.directionBreakdown.short} | ${r.metricsFirstN.winrate.toFixed(2)}% | ${r.metricsFirstN.profitFactor == null ? "—" : r.metricsFirstN.profitFactor.toFixed(2)} | $${r.metricsFirstN.evUsd.toFixed(4)} | $${r.metricsFirstN.totalNetPnlUsd.toFixed(4)} | $${r.metricsFirstN.maxDdUsd.toFixed(4)} | $${r.equityFirstNEndUsd.toFixed(2)} |`),
      ``,
      `Canonical history currently available: ${datasets.length} symbols. Target is reported honestly; a shortfall is DATA_EXHAUSTED, not a fabricated fill.`,
    ].join("\n") + "\n");
  }
  console.log(JSON.stringify({ out: OUT, runId: RUN_ID, target: TARGET, datasets: datasets.length, strategies: Object.fromEntries(Object.entries(summary.strategies as Record<string, any>).map(([k, v]) => [k, { status: v.status, actualClosed: v.actualClosed, firstN: v.firstN, long: v.directionBreakdown.long, short: v.directionBreakdown.short, wr: v.metricsFirstN.winrate, evUsd: v.metricsFirstN.evUsd }])) }, null, 2));
}

main();
