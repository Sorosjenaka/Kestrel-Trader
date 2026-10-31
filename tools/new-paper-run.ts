// tools/new-paper-run.ts
// Mulai run PAPER baru dari $200 (perintah operator 29 Sep 2026):
//   1) Arsipkan SELURUH data trading ke data/trade-archive/new-run-<stamp>.json
//      (trades, positions, orderExecs, learnings + harga mark saat reset).
//   2) Hapus Trade + Position + OrderExec = history bersih; LearningEntry (otak)
//      dan EventLog DIPERTAHANKAN supaya tidak ada pelajaran yang hilang.
//   3) Posisi OPEN dibuang apa adanya (dicatat di arsip + markAtReset), bukan
//      ditutup palsu di harga entry: run lama dibatalkan, bukan diakuntansi.
//   4) Catat event NEW_PAPER_RUN_STARTED; saldo dasar kembali START_EQUITY_USD.
// PAPER-only (menolak bila BINANCE_EXECUTION_MODE != PAPER).
// Jalankan: npx tsx tools/new-paper-run.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../apps/server/src/core/db.js";
import { env } from "../apps/server/src/core/env.js";
import { START_EQUITY_USD } from "../apps/server/src/risk/riskEngine.js";

async function fetchMarks(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (symbols.length === 0) return out;
  try {
    const url = `http://127.0.0.1:${env.PORT}/api/prices?symbols=${symbols.join(",")}`;
    const r = await fetch(url);
    const j: any = await r.json();
    for (const s of symbols) {
      const q = j?.map?.[s];
      const p = Number(q?.m ?? q?.p ?? 0);
      if (Number.isFinite(p) && p > 0) out[s] = p;
    }
  } catch { /* mark tidak wajib untuk arsip */ }
  return out;
}

async function main() {
  if (env.BINANCE_EXECUTION_MODE !== "PAPER") {
    throw new Error(`BATAL: tool ini PAPER-only (mode aktif ${env.BINANCE_EXECUTION_MODE})`);
  }

  const [positions, trades, orderExecs, learnings] = await Promise.all([
    db.position.findMany({ orderBy: { id: "asc" } }),
    db.trade.findMany({ orderBy: { id: "asc" } }),
    db.orderExec.findMany({ orderBy: { id: "asc" } }),
    db.learningEntry.findMany({ orderBy: { id: "asc" } }),
  ]);
  const openSymbols = positions.filter((p) => p.status === "OPEN").map((p) => p.symbol);
  const marks = await fetchMarks([...new Set(openSymbols)]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = resolve("data", "trade-archive");
  mkdirSync(archiveDir, { recursive: true });
  const archiveFile = resolve(archiveDir, `new-run-${stamp}.json`);
  writeFileSync(archiveFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    reason: "NEW_PAPER_RUN",
    executionMode: env.BINANCE_EXECUTION_MODE,
    startingEquityUsd: START_EQUITY_USD,
    counts: { trades: trades.length, positions: positions.length, orderExecs: orderExecs.length, learnings: learnings.length },
    openPositionsAtReset: positions.filter((p) => p.status === "OPEN").map((p) => ({
      id: p.id, symbol: p.symbol, side: p.side, mode: p.mode, source: p.source,
      entryPrice: p.entryPrice, slPrice: p.slPrice, tp1Price: p.tp1Price, tp2Price: p.tp2Price,
      qty: p.qty, openedAt: p.openedAt, markAtReset: marks[p.symbol] ?? null,
    })),
    marks,
    positions, trades, orderExecs, learnings,
  }, null, 1), "utf8");

  const tDel = await db.trade.deleteMany({});
  const oDel = await db.orderExec.deleteMany({});
  const pDel = await db.position.deleteMany({});

  await db.eventLog.create({
    data: {
      type: "NEW_PAPER_RUN_STARTED",
      severity: "warn",
      payload: JSON.stringify({
        action: "ARCHIVE_AND_WIPE_TRADING_HISTORY",
        startingEquityUsd: START_EQUITY_USD,
        archiveFile,
        tradesArchived: trades.length,
        positionsArchived: positions.length,
        orderExecsArchived: orderExecs.length,
        learningsKept: learnings.length,
        deleted: { trades: tDel.count, positions: pDel.count, orderExecs: oDel.count },
      }),
    },
  });

  console.log(JSON.stringify({
    ok: true,
    archiveFile,
    archived: { trades: trades.length, positions: positions.length, orderExecs: orderExecs.length, learnings: learnings.length },
    deleted: { trades: tDel.count, positions: pDel.count, orderExecs: oDel.count },
    learningsKept: await db.learningEntry.count(),
    startingEquityUsd: START_EQUITY_USD,
  }, null, 2));
}

main()
  .catch((e) => { console.error("Fatal:", e.message); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
