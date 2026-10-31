// tools/dedupe-learnings.ts - Hapus duplikat evaluasi (restore dipanggil > 1x).
import { PrismaClient } from "@prisma/client";
import { resolveDbUrl } from "./db-path.mjs";
const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });

async function main() {
  const before = await db.learningEntry.count();
  const dupes = await db.$queryRawUnsafe<any[]>(`
    SELECT id FROM "LearningEntry"
    WHERE "tradeId" IS NULL
      AND id NOT IN (
        SELECT MIN(id) FROM "LearningEntry" GROUP BY "causeCode", "narrative", "proposal", "createdAt"
      )
  `);
  const ids = dupes.map((d: any) => Number(d.id));
  if (ids.length > 0) {
    await db.learningEntry.deleteMany({ where: { id: { in: ids } } });
  }
  const after = await db.learningEntry.count();
  console.log(`Dedupe evaluasi: sebelum=${before}, duplikat dihapus=${ids.length}, sesudah=${after}`);
  console.log("Distribusi:", await db.learningEntry.groupBy({ by: ["causeCode"], _count: { _all: true } }));
  console.log("trades:", await db.trade.count(), "| positions:", await db.position.count());
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await db.$disconnect(); });
