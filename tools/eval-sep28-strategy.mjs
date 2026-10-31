// tools/eval-sep28-strategy.mjs
// Evaluasi trade 28 Sep 2026 00:00 UTC -> sekarang + breakdown strategi (winrate < 50%).
// Read-only. Exclude source=DEMO (pipeline uji).
import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";

const prisma = new PrismaClient({ datasourceUrl: resolveDbUrl() });

const FROM = new Date(Date.UTC(2026, 8, 28, 0, 0, 0, 0));
const now = new Date();

function fmt(n, d = 4) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : 0;
}

const trades = await prisma.trade.findMany({
  where: { createdAt: { gte: FROM }, source: { not: "DEMO" } },
  orderBy: { createdAt: "asc" },
  select: {
    id: true, symbol: true, mode: true, side: true, strategyId: true, zoneType: true,
    pnlUsd: true, rMultiple: true, win: true, feeUsd: true, holdMinutes: true,
    source: true, accountingQuality: true, createdAt: true,
    position: { select: { closeReason: true, strategyName: true } },
  },
});

const openPositions = await prisma.position.findMany({
  where: { status: "OPEN", source: { not: "DEMO" } },
  select: { id: true, symbol: true, mode: true, strategyId: true, openedAt: true, realizedPnlUsd: true, tp1FilledAt: true },
});

console.log(`=== WINDOW: ${FROM.toISOString()} -> ${now.toISOString()} ===`);
console.log(`closed trades = ${trades.length} ; open positions = ${openPositions.length}`);

// ---- overall ----
let wins = 0, losses = 0, grossP = 0, grossL = 0, sumR = 0, equity = 200, peak = 200, maxDD = 0;
for (const t of trades) {
  if (t.win) { wins++; grossP += t.pnlUsd; } else { losses++; grossL += Math.abs(t.pnlUsd); }
  sumR += t.rMultiple ?? 0;
  equity += t.pnlUsd;
  if (equity > peak) peak = equity;
  const dd = peak - equity;
  if (dd > maxDD) maxDD = dd;
}
const n = trades.length;
console.log("\n--- OVERALL (closed, non-DEMO) ---");
console.log(JSON.stringify({
  trades: n,
  wins,
  losses,
  winRatePct: n ? fmt((wins / n) * 100, 2) : 0,
  netPnlUsd: fmt(grossP - grossL, 4),
  grossProfit: fmt(grossP, 4),
  grossLoss: fmt(grossL, 4),
  profitFactor: grossL > 0 ? fmt(grossP / grossL, 3) : (grossP > 0 ? "inf" : 1),
  avgR: n ? fmt(sumR / n, 3) : 0,
  expectancyUsd: n ? fmt((grossP - grossL) / n, 4) : 0,
  maxDrawdownUsd: fmt(maxDD, 4),
  endEquityUsd: fmt(equity, 4),
}, null, 2));

// ---- per strategy ----
const byStrat = new Map();
for (const t of trades) {
  const k = t.strategyId && t.strategyId !== "S-N/A" ? t.strategyId : "S-00";
  if (!byStrat.has(k)) byStrat.set(k, { id: k, trades: 0, wins: 0, pnl: 0, sumR: 0, grossP: 0, grossL: 0 });
  const s = byStrat.get(k);
  s.trades++;
  if (t.win) { s.wins++; s.grossP += t.pnlUsd; } else { s.grossL += Math.abs(t.pnlUsd); }
  s.pnl += t.pnlUsd;
  s.sumR += t.rMultiple ?? 0;
}

console.log("\n--- PER STRATEGY (window) ---");
const rows = [...byStrat.values()].map((s) => ({
  id: s.id,
  trades: s.trades,
  wins: s.wins,
  losses: s.trades - s.wins,
  winRatePct: s.trades ? fmt((s.wins / s.trades) * 100, 2) : 0,
  netPnlUsd: fmt(s.pnl, 4),
  avgR: s.trades ? fmt(s.sumR / s.trades, 3) : 0,
  profitFactor: s.grossL > 0 ? fmt(s.grossP / s.grossL, 3) : (s.grossP > 0 ? "inf" : 1),
})).sort((a, b) => b.trades - a.trades);
for (const r of rows) console.log(JSON.stringify(r));

const below50 = rows.filter((r) => r.winRatePct < 50);
console.log("\n--- STRATEGI WINRATE < 50% ---");
if (!below50.length) console.log("(tidak ada)");
for (const r of below50) console.log(JSON.stringify(r));

// ---- per symbol (top losers) ----
const bySym = new Map();
for (const t of trades) {
  if (!bySym.has(t.symbol)) bySym.set(t.symbol, { symbol: t.symbol, trades: 0, wins: 0, pnl: 0 });
  const s = bySym.get(t.symbol);
  s.trades++; if (t.win) s.wins++; s.pnl += t.pnlUsd;
}
console.log("\n--- TOP 10 SYMBOL BY NET PNL (worst) ---");
[...bySym.values()].sort((a, b) => a.pnl - b.pnl).slice(0, 10)
  .forEach((s) => console.log(JSON.stringify({ ...s, pnl: fmt(s.pnl, 4), wr: fmt((s.wins / s.trades) * 100, 1) })));

// ---- exit reason distribution ----
const byExit = new Map();
for (const t of trades) {
  const k = t.position?.closeReason ?? "(null)";
  byExit.set(k, (byExit.get(k) ?? 0) + 1);
}
console.log("\n--- EXIT REASON ---");
console.log(JSON.stringify(Object.fromEntries(byExit), null, 2));

// ---- open positions (unrealized book) ----
console.log("\n--- OPEN POSITIONS ---");
for (const p of openPositions) {
  console.log(JSON.stringify({ id: p.id, symbol: p.symbol, mode: p.mode, strategyId: p.strategyId, openedAt: p.openedAt, realizedPnlUsd: p.realizedPnlUsd, tp1: !!p.tp1FilledAt }));
}

await prisma.$disconnect();