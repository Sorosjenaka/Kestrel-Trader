// tools/purge-nonstrategy-trades.ts - Hapus jejak NON-STRATEGI dari history.
// Menghapus posisi CLOSED dengan closeReason TIMEOUT/FUNDING beserta trade-nya
// (cascade). DIPERTAHANKAN: LearningEntry (otak deep-learning) & EventLog.
// Alasan operator 26 Sep 2026: hanya data real strategi (TP2/SL/BE/TREND_FLIP)
// yang boleh masuk data backtest; TIMEOUT/FUNDING mencemari winrate.
import { db } from "../apps/server/src/core/db";

const IMPURE = ["TIMEOUT", "FUNDING"];

async function main() {
  const targets = await db.position.findMany({
    where: { status: "CLOSED", closeReason: { in: IMPURE } },
    select: { id: true, symbol: true, closeReason: true, status: true },
  });
  console.log(`Kandidat hapus: ${targets.length}`, IMPURE);

  const openHit = targets.filter((p) => p.status !== "CLOSED");
  if (openHit.length > 0) {
    throw new Error(`BATAL: ${openHit.length} posisi tidak CLOSED ikut kena — abort`);
  }

  const tradesBefore = await db.trade.count();
  const delPositions = await db.position.deleteMany({
    where: { id: { in: targets.map((p) => p.id) } },
  });
  const tradesAfter = await db.trade.count();

  await db.eventLog.create({
    data: {
      type: "MANUAL_PURGE_NONSTRATEGY",
      severity: "warn",
      payload: JSON.stringify({
        action: "PURGE_TIMEOUT_FUNDING_HISTORY",
        timestamp: new Date().toISOString(),
        reasons: IMPURE,
        positionsDeleted: delPositions.count,
        tradesDeleted: tradesBefore - tradesAfter,
        symbols: targets.map((p) => `${p.symbol}:${p.closeReason}`),
      }),
    },
  });

  console.log("DELETED positions:", delPositions.count);
  console.log(`TRADES: ${tradesBefore} -> ${tradesAfter}`);
  console.log("KEPT learnings:", await db.learningEntry.count());
}

main()
  .catch((e) => {
    console.error("Fatal purge error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
