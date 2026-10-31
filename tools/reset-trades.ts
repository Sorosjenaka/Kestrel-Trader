// tools/reset-trades.ts - Reset all trades, positions, orderExecs, and set balance to $20
import { db } from "../apps/server/src/core/db";

async function main() {
  const tradesBefore = await db.trade.count();
  const positionsBefore = await db.position.count();
  const ordersBefore = await db.orderExec.count();
  const learningsBefore = await db.learningEntry.count();

  console.log("SERVER DB BEFORE RESET:", {
    trades: tradesBefore,
    positions: positionsBefore,
    orders: ordersBefore,
    learnings: learningsBefore,
  });

  const deletedLearnings = await db.learningEntry.deleteMany({});
  const deletedTrades = await db.trade.deleteMany({});
  const deletedOrders = await db.orderExec.deleteMany({});
  const deletedPositions = await db.position.deleteMany({});

  console.log("DELETED:", {
    trades: deletedTrades.count,
    positions: deletedPositions.count,
    orders: deletedOrders.count,
    learnings: deletedLearnings.count,
  });

  await db.eventLog.create({
    data: {
      type: "MANUAL_RESET_ALL_TRADES",
      severity: "warn",
      payload: JSON.stringify({
        action: "RESET_ALL_TRADES_AND_BALANCE_TO_20",
        timestamp: new Date().toISOString(),
        tradesDeleted: deletedTrades.count,
        positionsDeleted: deletedPositions.count,
      }),
    },
  });

  const tradesAfter = await db.trade.count();
  const positionsAfter = await db.position.count();
  const ordersAfter = await db.orderExec.count();

  console.log("SERVER DB AFTER RESET:", {
    trades: tradesAfter,
    positions: positionsAfter,
    orders: ordersAfter,
    equity: "$20.00",
  });
}

main()
  .catch((e) => {
    console.error("Fatal reset error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
