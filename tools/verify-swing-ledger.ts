// Independent ledger verifier: reads trades.json + summary metrics and
// recomputes count/WR/PF/EV/DD without calling calculateMetrics.
// PAPER/research only; no DB, exchange, or order path.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type T = { netPnlUsd: number; direction?: "LONG" | "SHORT"; side?: "LONG" | "SHORT"; strategyId?: string };
const root = resolve(process.cwd());
const dir = resolve(root, process.argv[2] ?? "data/swing-9-findings/20261019T073000Z/canonical-1m-rerun");
const outPath = resolve(root, process.argv[3] ?? join(dir, "ledger-verifier.json"));
const ids = ["S-05", "RSW-01", "RSW-02", "RSW-03"];
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).strategies as Record<string, any>;
const EPS = 1e-9;
function metrics(trades: T[]) {
  let wins = 0, losses = 0, be = 0, gp = 0, gl = 0, net = 0, peak = 200, dd = 0, equity = 200;
  for (const t of trades) {
    net += t.netPnlUsd;
    if (t.netPnlUsd > EPS) { wins++; gp += t.netPnlUsd; }
    else if (t.netPnlUsd < -EPS) { losses++; gl += Math.abs(t.netPnlUsd); }
    else be++;
    equity += t.netPnlUsd; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
  }
  return { samples: trades.length, wins, losses, breakeven: be, winratePct: trades.length ? 100 * wins / trades.length : null, netPnlUsd: net, evUsd: trades.length ? net / trades.length : null, profitFactor: gl > EPS ? gp / gl : null, equityEndUsd: equity, maxDdUsd: dd, maxDdPct: peak > 0 ? 100 * dd / peak : null, long: trades.filter((t) => (t.direction ?? t.side) === "LONG").length, short: trades.filter((t) => (t.direction ?? t.side) === "SHORT").length };
}
function close(a: unknown, b: unknown, tolerance = 1e-4): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
}
const report: any = { schemaVersion: 1, kind: "INDEPENDENT_LEDGER_VERIFIER", directory: dir, strategies: {}, status: "PASS" };
for (const id of ids) {
  let tradesPath = join(dir, id, "trades.json");
  try {
    const strategyDir = join(dir, id);
    const candidates: string[] = [];
    for (const ent of (require("node:fs") as typeof import("node:fs")).readdirSync(strategyDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const p = join(strategyDir, ent.name, "trades.json");
        if ((require("node:fs") as typeof import("node:fs")).existsSync(p)) candidates.push(p);
      }
    }
    if (candidates.length) tradesPath = candidates.sort().at(-1)!;
  } catch { /* fallback */ }
  let trades: T[] = [];
  try { trades = JSON.parse(readFileSync(tradesPath, "utf8")); } catch { trades = []; }
  const actual = metrics(trades);
  const actualForChecks = actual.samples === 0 ? { ...actual, winratePct: 0, evUsd: 0 } : actual;
  const claimedAll = summary[id]?.metricsAll ?? summary[id]?.metrics;
  const claimedFirst = summary[id]?.metricsFirstN ?? summary[id]?.metrics;
  const claimed = claimedFirst ?? claimedAll;
  const checks = {
    sampleCount: close(claimed?.sampleCount ?? claimed?.samples, actual.samples),
    winrate: close(claimed?.winrate ?? claimed?.winratePct, actualForChecks.winratePct, 0.01),
    netPnlUsd: close(claimed?.totalNetPnlUsd ?? claimed?.netPnlUsd, actualForChecks.netPnlUsd),
    evUsd: close(claimed?.evUsd, actualForChecks.evUsd, 1e-5),
    profitFactor: claimed?.profitFactor === null || claimed?.profitFactor === undefined ? actual.profitFactor === null : close(claimed.profitFactor, actual.profitFactor, 1e-4),
    long: close(summary[id]?.directionBreakdown?.long, actual.long),
    short: close(summary[id]?.directionBreakdown?.short, actual.short),
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) report.status = "FAIL";
  report.strategies[id] = { path: tradesPath, actual, claimedFirst, claimedAll, checks, status: ok ? "PASS" : "FAIL" };
}
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out: outPath, status: report.status, strategies: Object.fromEntries(Object.entries(report.strategies).map(([k, v]: any) => [k, v.status])) }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
