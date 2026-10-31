// tools/reset-trade-history.ts - Reset history trading untuk modal segar.
// Menghapus trades + positions + orderExecs. DIPERTAHANKAN: LearningEntry (otak
// deep-learning dari trade nyata) & EventLog (jejak audit, termasuk event reset ini).
// Dipakai operator saat mulai run baru (mis. equity segar $200).
import { db } from "../apps/server/src/core/db";
import { START_EQUITY_USD } from "../apps/server/src/risk/riskEngine";

async function main() {
  const before = {
    trades: await db.trade.count(),
    positions: await db.position.count(),
    orders: await db.orderExec.count(),
    learnings: await db.learningEntry.count(),
  };
  console.log("BEFORE:", before);

  const openCount = await db.position.count({ where: { status: "OPEN" } });
  if (openCount > 0) {
    throw new Error(`BATAL: masih ada ${openCount} posisi OPEN — tutup dulu via POST /api/positions/kill-all`);
  }

  const deletedTrades = await db.trade.deleteMany({});
  const deletedOrders = await db.orderExec.deleteMany({});
  const deletedPositions = await db.position.deleteMany({});

  await db.eventLog.create({
    data: {
      type: "MANUAL_RESET_TRADE_HISTORY",
      severity: "warn",
      payload: JSON.stringify({
        action: "RESET_TRADE_HISTORY_KEEP_LEARNINGS",
        startingEquityUsd: START_EQUITY_USD,
        timestamp: new Date().toISOString(),
        tradesDeleted: deletedTrades.count,
        positionsDeleted: deletedPositions.count,
        ordersDeleted: deletedOrders.count,
      }),
    },
  });

  console.log("DELETED:", {
    trades: deletedTrades.count,
    positions: deletedPositions.count,
    orders: deletedOrders.count,
  });
  console.log("KEPT: learnings =", await db.learningEntry.count());
  console.log(`AFTER: trades=${await db.trade.count()} positions=${await db.position.count()} equity=$${START_EQUITY_USD.toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error("Fatal reset error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
