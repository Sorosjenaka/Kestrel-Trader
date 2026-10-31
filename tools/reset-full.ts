// tools/reset-full.ts - Tutup SEMUA posisi + hapus SELURUH history trading.
// Perintah operator 25 Sep 2026:
//   1) Tutup semua posisi OPEN (harga pasar live bila tersedia)
//   2) Hapus semua Trade, LearningEntry, OrderExec, Position (history bersih)
//   3) Saldo dasar kembali ke $200 (START_EQUITY_USD) karena history dikosongkan
import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";

const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });

async function fetchMark(symbol: string): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:8787/api/prices?symbols=${symbol}`);
    const j: any = await r.json();
    return Number(j?.map?.[symbol]?.p ?? 0);
  } catch {
    return 0;
  }
}

async function main() {
  console.log("=== SEBELUM RESET ===");
  console.log({
    positions: await db.position.count(),
    openPositions: await db.position.count({ where: { status: "OPEN" } }),
    trades: await db.trade.count(),
    learnings: await db.learningEntry.count(),
    orders: await db.orderExec.count(),
  });

  // 1) Tutup semua posisi OPEN pada harga pasar terakhir yang tersedia.
  const open = await db.position.findMany({ where: { status: "OPEN" }, orderBy: { id: "asc" } });
  console.log(`\nMenutup ${open.length} posisi OPEN...`);
  for (const p of open) {
    const mark = await fetchMark(p.symbol);
    const exitPrice = mark > 0 ? mark : p.entryPrice;
    const isLong = p.side === "LONG";
    const gross = isLong ? (exitPrice - p.entryPrice) * p.qty : (p.entryPrice - exitPrice) * p.qty;
    const fee = Number((p.entryPrice * p.qty * 0.0002 + exitPrice * p.qty * 0.0005).toFixed(4));
    const net = Number((gross + Number(p.realizedPnlUsd || 0) - fee).toFixed(4));
    const risk = Math.abs(p.tp1Price - p.entryPrice) * p.qty || 1;
    const r = Number((net / risk).toFixed(4));
    const now = new Date();
    const hold = Math.max(1, Math.round((now.getTime() - p.openedAt.getTime()) / 60000));
    await db.$transaction(async (tx) => {
      await tx.position.update({
        where: { id: p.id },
        data: { status: "CLOSED", closedAt: now, closeReason: "KILL", pnlUsd: net, pnlR: r },
      });
      await tx.trade.create({
        data: {
          positionId: p.id, symbol: p.symbol, mode: p.mode, side: p.side,
          riskUsd: Number(risk.toFixed(4)), entryAvg: p.entryPrice, exitAvg: exitPrice,
          rMultiple: r, pnlUsd: net, feeUsd: fee, fundingUsd: 0, win: net > 0,
          mfeR: 0, maeR: Math.abs(r), holdMinutes: hold, createdAt: now,
        },
      });
      await tx.eventLog.create({
        data: {
          type: "POSITION_CLOSED", severity: "warn",
          payload: JSON.stringify({ symbol: p.symbol, positionId: p.id, closeReason: "KILL", exitAvg: exitPrice, netPnlUsd: net, rMultiple: r, win: net > 0, note: "MANUAL_CLOSE_ALL_OPERATOR_RESET" }),
        },
      });
    });
    console.log(`  #${p.id} ${p.symbol} ${p.side} ditutup @${exitPrice} net=$${net}`);
  }

  // 2) Hapus seluruh history trading.
  const lDel = await db.learningEntry.deleteMany({});
  const tDel = await db.trade.deleteMany({});
  const oDel = await db.orderExec.deleteMany({});
  const pDel = await db.position.deleteMany({});
  console.log("\n=== HAPUS HISTORY ===");
  console.log({ learnings: lDel.count, trades: tDel.count, orders: oDel.count, positions: pDel.count });

  // 3) Event audit.
  await db.eventLog.create({
    data: {
      type: "MANUAL_RESET_ALL_TRADES", severity: "warn",
      payload: JSON.stringify({
        action: "CLOSE_ALL_POSITIONS_AND_WIPE_HISTORY",
        closedPositions: open.length,
        tradesDeleted: tDel.count,
        learningsDeleted: lDel.count,
        ordersDeleted: oDel.count,
        positionsDeleted: pDel.count,
        startingEquityUsd: 200,
        timestamp: new Date().toISOString(),
      }),
    },
  });

  console.log("\n=== SESUDAH RESET ===");
  console.log({
    positions: await db.position.count(),
    openPositions: await db.position.count({ where: { status: "OPEN" } }),
    trades: await db.trade.count(),
    learnings: await db.learningEntry.count(),
    orders: await db.orderExec.count(),
    saldoDasar: "$200.00",
  });
}

main()
  .catch((e) => { console.error("Fatal:", e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
