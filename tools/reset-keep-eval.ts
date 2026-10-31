// tools/reset-keep-eval.ts
// RESET BALANCE ke $200 + HAPUS history trade, TAPI PERTAHANKAN EVALUASI.
// Perintah operator 25 Sep 2026.
//
// DIHAPUS   : Trade, OrderExec, Position (posisi OPEN ditutup dulu via KILL)
// DISIMPAN  : LearningEntry (post-mortem: causeCode + narrative + proposal),
//             ParameterVersion, BacktestRun, BacktestTrade, SetupCandidate,
//             EventLog (audit & dialog agen), Setting.
// TAMBAHAN  : arsip JSON + "digest evaluasi" di Setting (rujukan agen).
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { resolveDbUrl } from "./db-path.mjs";

// 3 Okt 2026: path absolut — URL relatif "file:./data/..." terbukti salah resolve
// ke DB kosong (lihat tools/db-which.ts); DB live = path absolut ini (sama dgn .env).
const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });
const START_EQUITY = 200;
const round = (n: number, d = 4) => Number(n.toFixed(d));

async function main() {
  const before = {
    positions: await db.position.count(),
    openPositions: await db.position.count({ where: { status: "OPEN" } }),
    trades: await db.trade.count(),
    learnings: await db.learningEntry.count(),
    parameterVersions: await db.parameterVersion.count(),
    backtestRuns: await db.backtestRun.count(),
    events: await db.eventLog.count(),
    orders: await db.orderExec.count(),
  };
  console.log("=== SEBELUM ===", before);

  const trades = await db.trade.findMany({ include: { position: true }, orderBy: { id: "asc" } });
  const learnings = await db.learningEntry.findMany({ orderBy: { id: "asc" } });
  const params = await db.parameterVersion.findMany({ orderBy: { id: "asc" } });

  const closed = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossProfit = round(wins.reduce((a, t) => a + t.pnlUsd, 0));
  const grossLoss = round(Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0)));
  let peak = 0;
  let run = 0;
  let maxDd = 0;
  for (const t of trades) {
    run += t.pnlUsd;
    if (run > peak) peak = run;
    if (run - peak < maxDd) maxDd = run - peak;
  }
  const byExitReason: Record<string, number> = {};
  const bySymbol: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const t of trades) {
    const reason = t.position?.closeReason ?? "UNKNOWN";
    byExitReason[reason] = (byExitReason[reason] ?? 0) + 1;
    const s = (bySymbol[t.symbol] ??= { trades: 0, pnl: 0, wins: 0 });
    s.trades++;
    s.pnl = round(s.pnl + t.pnlUsd);
    if (t.pnlUsd > 0) s.wins++;
  }
  const byCause: Record<string, number> = {};
  for (const l of learnings) byCause[l.causeCode] = (byCause[l.causeCode] ?? 0) + 1;

  const digest = {
    generatedAt: new Date().toISOString(),
    periode: closed ? { dari: trades[0].createdAt, sampai: trades[closed - 1].createdAt } : null,
    totalTrades: closed,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct: closed ? round((wins.length / closed) * 100, 2) : 0,
    netPnlUsd: round(grossProfit - grossLoss),
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : null,
    avgR: closed ? round(trades.reduce((a, t) => a + t.rMultiple, 0) / closed, 4) : 0,
    avgHoldMinutes: closed ? Math.round(trades.reduce((a, t) => a + t.holdMinutes, 0) / closed) : 0,
    maxDrawdownUsd: round(maxDd),
    byExitReason,
    byCauseCode: byCause,
    bestTrade: closed ? { symbol: trades.reduce((a, b) => (b.pnlUsd > a.pnlUsd ? b : a)).symbol, pnlUsd: round(Math.max(...trades.map((t) => t.pnlUsd))) } : null,
    worstTrade: closed ? { symbol: trades.reduce((a, b) => (b.pnlUsd < a.pnlUsd ? b : a)).symbol, pnlUsd: round(Math.min(...trades.map((t) => t.pnlUsd))) } : null,
    topSymbols: Object.entries(bySymbol)
      .map(([symbol, s]) => ({ symbol, ...s, winRate: round((s.wins / s.trades) * 100, 1) }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10),
    parameterVersions: params.map((p) => ({ version: p.version, status: p.status })),
    learningCount: learnings.length,
    lessonsSample: learnings.slice(-15).map((l) => ({ causeCode: l.causeCode, narrative: l.narrative })),
  };


  const archiveDir = path.resolve("data", "eval-archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveFile = path.join(archiveDir, `eval-archive-${stamp}.json`);
  fs.writeFileSync(archiveFile, JSON.stringify({ digest, trades, learnings, parameterVersions: params }, null, 1), "utf8");
  fs.writeFileSync(path.join(archiveDir, "eval-digest-latest.json"), JSON.stringify(digest, null, 1), "utf8");
  console.log(`\n=== ARSIP EVALUASI: ${archiveFile} ===`);
  console.log(JSON.stringify(digest, null, 1));

  // Digest disimpan juga di DB (Setting) agar bisa dibaca sistem/agen kapan saja.
  await db.setting.upsert({
    where: { key: "evalDigest" },
    update: { value: JSON.stringify(digest) },
    create: { key: "evalDigest", value: JSON.stringify(digest) },
  });

  // ---------- TUTUP SEMUA POSISI OPEN ----------
  const open = await db.position.findMany({ where: { status: "OPEN" }, orderBy: { id: "asc" } });
  console.log(`\nMenutup ${open.length} posisi OPEN (KILL) supaya saldo bersih...`);
  for (const p of open) {
    const fee = round(p.entryPrice * p.qty * 0.0002 + p.entryPrice * p.qty * 0.0005);
    const net = round(Number(p.realizedPnlUsd || 0) - fee);
    const risk = Math.abs(p.tp1Price - p.entryPrice) * p.qty || 1;
    await db.position.update({
      where: { id: p.id },
      data: { status: "CLOSED", closedAt: new Date(), closeReason: "KILL", pnlUsd: net, pnlR: round(net / risk) },
    });
    console.log(`  #${p.id} ${p.symbol} ditutup net=$${net}`);
  }

  // ---------- HAPUS HISTORY TRADE (evaluasi DIPERTAHANKAN) ----------
  // LearningEntry.tradeId otomatis menjadi NULL (onDelete: SetNull).
  const tDel = await db.trade.deleteMany({});
  const oDel = await db.orderExec.deleteMany({});
  const pDel = await db.position.deleteMany({});
  const learningsKept = await db.learningEntry.count();
  const orphan = await db.learningEntry.count({ where: { tradeId: null } });
  console.log(`\n=== HISTORY DIHAPUS: trades=${tDel.count}, orders=${oDel.count}, positions=${pDel.count} ===`);
  console.log(`=== EVALUASI DIPERTAHANKAN: learnings=${learningsKept} (null=${orphan}), params=${await db.parameterVersion.count()}, backtestRuns=${await db.backtestRun.count()} ===`);

  await db.eventLog.create({
    data: {
      type: "MANUAL_RESET_KEEP_EVALUATION",
      severity: "warn",
      payload: JSON.stringify({
        action: "RESET_BALANCE_200_DELETE_HISTORY_KEEP_EVALUATION",
        archiveFile,
        startingEquityUsd: START_EQUITY,
        tradesDeleted: tDel.count,
        positionsDeleted: pDel.count,
        ordersDeleted: oDel.count,
        learningsKept,
        learningsOrphaned: orphan,
        digest,
        timestamp: new Date().toISOString(),
      }),
    },
  });

  console.log("\n=== SESUDAH ===", {
    positions: await db.position.count(),
    trades: await db.trade.count(),
    learningsKept,
    parameterVersions: await db.parameterVersion.count(),
    backtestRuns: await db.backtestRun.count(),
    events: await db.eventLog.count(),
    saldoBasis: `$${START_EQUITY.toFixed(2)}`,
  });
}

main()
  .catch((e) => { console.error("Fatal:", e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
