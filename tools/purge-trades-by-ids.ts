// tools/purge-trades-by-ids.ts - Hapus trade/posisi TERTENTU dari history.
// Pakai: npx tsx tools/purge-trades-by-ids.ts 815,816,817
// Hanya posisi CLOSED yang boleh dihapus (OPEN membatalkan). Learnings & eventLog
// dipertahankan (tradeId yatim -> null). Event purge dicatat untuk audit.
import { db } from "../apps/server/src/core/db";

async function main() {
  const ids = String(process.argv[2] ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error("Pakai: npx tsx tools/purge-trades-by-ids.ts <id1,id2,...>");
    process.exit(2);
  }

  const trades = await db.trade.findMany({
    where: { id: { in: ids } },
    include: { position: { select: { id: true, symbol: true, status: true, closeReason: true } } },
  });
  const found = new Set(trades.map((t) => t.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length > 0) throw new Error(`Trade tidak ditemukan: ${missing.join(",")}`);
  const openHit = trades.filter((t) => t.position?.status !== "CLOSED");
  if (openHit.length > 0) {
    throw new Error(`BATAL: trade ${openHit.map((t) => t.id).join(",")} posisinya tidak CLOSED`);
  }

  console.log(
    "HAPUS:",
    trades.map((t) => `#${t.id} ${t.symbol} R=${t.rMultiple} ${t.position?.closeReason}`).join(" | ")
  );
  const posIds = trades.map((t) => t.positionId);
  await db.trade.deleteMany({ where: { id: { in: ids } } });
  const delPos = await db.position.deleteMany({ where: { id: { in: posIds } } });

  await db.eventLog.create({
    data: {
      type: "MANUAL_PURGE_TRADE_IDS",
      severity: "warn",
      payload: JSON.stringify({ action: "PURGE_TAINTED_TRADES", tradeIds: ids, positionsDeleted: delPos.count, timestamp: new Date().toISOString() }),
    },
  });
  console.log(`OK: ${ids.length} trades + ${delPos.count} posisi dihapus.`);
}

main()
  .catch((e) => {
    console.error("Fatal purge error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
