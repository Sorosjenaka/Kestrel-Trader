import { db } from "../apps/server/src/core/db.js";

async function main() {
  const trades = await db.trade.findMany({
    orderBy: { id: "desc" },
    take: 20,
    include: { position: true },
  });
  console.log(`Found ${trades.length} recent trades:`);
  for (const t of trades) {
    console.log(
      `Trade #${t.id} ${t.symbol} ${t.side} pnl=$${t.pnlUsd} R=${t.rMultiple} strat=${t.strategyId} closeReason=${t.position?.closeReason} hold=${t.holdMinutes}m`
    );
  }

  const learnings = await db.learningEntry.findMany({
    orderBy: { id: "desc" },
    take: 10,
  });
  console.log(`\nFound ${learnings.length} recent learnings:`);
  for (const l of learnings) {
    console.log(`[#${l.id} ${l.causeCode}] ${l.narrative?.slice(0, 160)}`);
  }
}

main().finally(() => db.$disconnect());

