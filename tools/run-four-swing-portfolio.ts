// One-wallet chronological portfolio study over already-produced trade ledgers.
// This is a REPORTING SIMULATOR, not a new signal evaluator and not a substitute
// for the canonical engine. It enforces one $200 cash wallet, three shared
// pending/reserved/open slots and six net-loss closes per Asia/Jakarta day.
// Funding coverage is inherited from each source ledger and never invented.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Side = "LONG" | "SHORT";
interface SourceTrade {
  symbol: string; strategyId?: string; direction?: Side; side?: Side;
  entryAt?: string; exitAt?: string; entryTime?: number; exitTime?: number;
  netPnlUsd: number; feesUsd?: number; fundingUsd?: number; fundingCoverage?: string;
  exitReason?: string;
}
interface Trade extends SourceTrade {
  strategyId: string; side: Side; entryMs: number; exitMs: number;
  accepted: boolean; reject?: string; closeDay?: string;
}
const root = resolve(process.cwd());
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const mode = arg("mode", "research15m") as "canonical" | "research15m" | "research15mFunded";
const runId = arg("run-id", `PORTFOLIO-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15)}`)!;
const out = resolve(root, arg("out", `data/swing-9-findings/${runId}/portfolio`)!);
const base = resolve(root, "data/swing-500-history-200usd");
const initialCash = 200;
const maxSlots = 3;
const maxDailyLosses = 6;
const strategyIds = ["S-05", "RSW-01", "RSW-02", "RSW-03"];

export function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // The two supported schemas are epoch milliseconds and epoch seconds.
    if (value > 10_000_000_000) return Math.trunc(value);
    if (value > 1_000_000_000) return Math.trunc(value * 1000);
    throw new Error("TIMESTAMP_OUT_OF_RANGE");
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error("INVALID_TIMESTAMP");
}
function jakartaDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function pct(n: number, d: number): number | null { return d ? Number(((100 * n) / d).toFixed(4)) : null; }
function latestTrades(strategyId: string): SourceTrade[] {
  const roots = mode === "canonical"
    ? [join(base, strategyId), join(base, strategyId, "CANONICAL-20261019T045725Z")]
    : mode === "research15mFunded"
      ? [join(root, "data/swing-9-findings/20261019T073000Z/research-15m-funded", strategyId)]
      : [join(base, "research-15m", strategyId)];
  const candidates: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth < 0) return;
    try {
      for (const ent of (require("node:fs") as typeof import("node:fs")).readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p, depth - 1);
        else if (ent.name === "trades.json") candidates.push(p);
      }
    } catch { /* absent */ }
  };
  for (const r of roots) walk(r, 3);
  const usable = candidates.map((p) => ({ p, mtime: (require("node:fs") as typeof import("node:fs")).statSync(p).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const c of usable) {
    try {
      const rows = JSON.parse(readFileSync(c.p, "utf8"));
      if (Array.isArray(rows) && rows.length) return rows;
    } catch { /* invalid candidate is not a success */ }
  }
  return [];
}
function normalized(rows: SourceTrade[], strategyId: string): Trade[] {
  return rows.map((r, i) => {
    const side = (r.side ?? r.direction) as Side;
    if (side !== "LONG" && side !== "SHORT") throw new Error(`INVALID_SIDE:${strategyId}:${i}`);
    const entryMs = parseTimestamp(r.entryAt ?? r.entryTime);
    const exitMs = parseTimestamp(r.exitAt ?? r.exitTime);
    if (!Number.isFinite(r.netPnlUsd) || exitMs < entryMs) throw new Error(`INVALID_TRADE:${strategyId}:${i}`);
    return {
      ...r, strategyId: r.strategyId ?? strategyId, side, entryMs, exitMs,
      accepted: false,
    };
  });
}
function main() {
  const byStrategy: Record<string, Trade[]> = {};
  for (const sid of strategyIds) byStrategy[sid] = normalized(latestTrades(sid), sid);
  const all = Object.values(byStrategy).flat().sort((a, b) => a.entryMs - b.entryMs || a.exitMs - b.exitMs || a.strategyId.localeCompare(b.strategyId) || a.symbol.localeCompare(b.symbol));
  // Events: exits before entries at identical timestamp, so a slot released at
  // the boundary can be reused deterministically.
  type Event = { time: number; kind: "entry" | "exit"; t: Trade };
  const events: Event[] = [];
  for (const t of all) { events.push({ time: t.entryMs, kind: "entry", t }); events.push({ time: t.exitMs, kind: "exit", t }); }
  events.sort((a, b) => a.time - b.time || (a.kind === b.kind ? 0 : a.kind === "exit" ? -1 : 1) || a.t.strategyId.localeCompare(b.t.strategyId));
  const live = new Set<Trade>();
  const symbolLive = new Set<string>();
  const lossByDay = new Map<string, number>();
  let cash = initialCash;
  let peak = cash;
  let maxDd = 0;
  const rejects: Record<string, number> = {};
  for (const e of events) {
    if (e.kind === "exit") {
      if (!live.delete(e.t)) continue;
      symbolLive.delete(e.t.symbol);
      cash += e.t.netPnlUsd;
      peak = Math.max(peak, cash);
      maxDd = Math.max(maxDd, peak - cash);
      if (e.t.netPnlUsd < -1e-9) {
        const d = jakartaDay(e.time);
        lossByDay.set(d, (lossByDay.get(d) ?? 0) + 1);
        e.t.closeDay = d;
      }
      continue;
    }
    const day = jakartaDay(e.time);
    let reason: string | null = null;
    if (cash <= 0) reason = "CASH_EXHAUSTED";
    else if (live.size >= maxSlots) reason = "SLOT_FULL";
    else if (symbolLive.has(e.t.symbol)) reason = "SYMBOL_CONFLICT";
    else if ((lossByDay.get(day) ?? 0) >= maxDailyLosses) reason = "DAILY_LOSS_LIMIT";
    if (reason) { e.t.reject = reason; rejects[reason] = (rejects[reason] ?? 0) + 1; continue; }
    e.t.accepted = true; live.add(e.t); symbolLive.add(e.t.symbol);
  }
  const accepted = all.filter((t) => t.accepted);
  const closed = accepted.filter((t) => t.closeDay || t.exitMs <= Date.now());
  const net = closed.reduce((s, t) => s + t.netPnlUsd, 0);
  const wins = closed.filter((t) => t.netPnlUsd > 1e-9);
  const losses = closed.filter((t) => t.netPnlUsd < -1e-9);
  const gp = wins.reduce((s, t) => s + t.netPnlUsd, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0));
  const per: Record<string, unknown> = {};
  for (const sid of strategyIds) {
    const rows = closed.filter((t) => t.strategyId === sid);
    const l = rows.filter((t) => t.side === "LONG"); const s = rows.filter((t) => t.side === "SHORT");
    const w = rows.filter((t) => t.netPnlUsd > 1e-9); const lo = rows.filter((t) => t.netPnlUsd < -1e-9);
    const sgp = w.reduce((a, t) => a + t.netPnlUsd, 0);
    const sgl = Math.abs(lo.reduce((a, t) => a + t.netPnlUsd, 0));
    per[sid] = {
      closed: rows.length, accepted: accepted.filter((t) => t.strategyId === sid).length,
      long: l.length, short: s.length,
      netPnlUsd: Number(rows.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(6)),
      longNetPnlUsd: Number(l.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(6)),
      shortNetPnlUsd: Number(s.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(6)),
      winratePct: pct(w.length, rows.length),
      profitFactor: sgl > 0 ? Number((sgp / sgl).toFixed(6)) : null,
      fundingCoverage: [...new Set(rows.map((t) => t.fundingCoverage ?? "UNKNOWN"))],
    };
  }
  const report = {
    schemaVersion: 1, runId, mode: mode === "canonical" ? "CANONICAL_LEDGER_PORTFOLIO_SIM" : mode === "research15mFunded" ? "RESEARCH15M_FUNDED_LEDGER_PORTFOLIO_SIM" : "RESEARCH15M_LEDGER_PORTFOLIO_SIM",
    source: mode === "canonical" ? "data/swing-500-history-200usd/*/CANONICAL-*" : mode === "research15mFunded" ? "data/swing-9-findings/20261019T073000Z/research-15m-funded/*" : "data/swing-500-history-200usd/research-15m/*",
    validity: mode === "canonical" ? "RESEARCH_ONLY_SMALL_SAMPLE" : mode === "research15mFunded" ? "RESEARCH_ONLY_FUNDED_15M_NOT_CANONICAL" : "RESEARCH_ONLY_FUNDING_UNMODELED",
    initialCashUsd: initialCash, maxSlots, maxDailyNetLosses: maxDailyLosses,
    tieBreak: "timestamp asc; exits before entries at equal timestamp; strategyId; symbol",
    inputTrades: all.length, accepted: accepted.length, closed: closed.length,
    counts: { wins: wins.length, losses: losses.length, breakeven: closed.length - wins.length - losses.length },
    direction: { long: closed.filter((t) => t.side === "LONG").length, short: closed.filter((t) => t.side === "SHORT").length },
    netPnlUsd: Number(net.toFixed(6)), grossProfitUsd: Number(gp.toFixed(6)), grossLossUsd: Number(gl.toFixed(6)),
    profitFactor: gl > 0 ? Number((gp / gl).toFixed(6)) : null,
    winratePct: pct(wins.length, closed.length), cashEndUsd: Number(cash.toFixed(6)), peakCashUsd: Number(peak.toFixed(6)),
    maxDdUsd: Number(maxDd.toFixed(6)), maxDdPct: peak > 0 ? Number((100 * maxDd / peak).toFixed(4)) : null,
    lossDays: Object.fromEntries([...lossByDay.entries()].sort()),
    rejects, perStrategy: per,
    limitations: ["One-wallet report simulation over already-produced ledgers; not an independent signal replay.", "Funding and execution detail are inherited from each source ledger; UNMODELED is not treated as zero.", "The canonical source has fewer than 500 closed trades; 500 target is not met."],
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "summary.md"), `# Portfolio one-wallet ${runId}\n\nMode: ${report.mode}\nInitial cash: $${initialCash}; slots: ${maxSlots}; max net-loss closes/day Asia/Jakarta: ${maxDailyLosses}.\n\n| Strategy | Accepted | Closed | LONG | SHORT | Net PnL | WR | PF |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${strategyIds.map((s) => { const x = per[s] as any; return `| ${s} | ${x.accepted} | ${x.closed} | ${x.long} | ${x.short} | $${x.netPnlUsd.toFixed(4)} | ${x.winratePct ?? "—"}% | ${x.profitFactor ?? "—"} |`; }).join("\n")}\n\nNet: $${report.netPnlUsd.toFixed(4)}; cash end: $${report.cashEndUsd.toFixed(2)}; PF: ${report.profitFactor ?? "N/A"}; rejects: ${JSON.stringify(rejects)}.\n\nThis is ${report.validity}; it is not a gate result and not four wallets summed.\n`);
  console.log(JSON.stringify({ out, runId, mode, inputTrades: report.inputTrades, accepted: report.accepted, closed: report.closed, netPnlUsd: report.netPnlUsd, perStrategy: per }, null, 2));
}
main();
