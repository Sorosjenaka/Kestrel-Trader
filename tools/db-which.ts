// tools/db-which.ts - Tentukan DB mana yang dipakai app/tools (audit cepat).
import { PrismaClient } from "@prisma/client";

async function inspect(label: string, url: string) {
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const [trades, positions, learnings, open, params] = await Promise.all([
      db.trade.count(),
      db.position.count(),
      db.learningEntry.count(),
      db.position.count({ where: { status: "OPEN" } }),
      db.parameterVersion.count(),
    ]);
    let hasCol = false;
    try {
      await db.$queryRawUnsafe(`SELECT "trailActive" FROM "Position" LIMIT 1`);
      hasCol = true;
    } catch {
      hasCol = false;
    }
    console.log(`${label} :: trades=${trades} positions=${positions} open=${open} learnings=${learnings} params=${params} kolomTrail=${hasCol}`);
  } catch (e) {
    console.log(`${label} :: ERROR ${(e as Error).message.slice(0, 120)}`);
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  await inspect("cwd-data      ", "file:./data/artatrade.db");
  await inspect("prisma-data   ", "file:./prisma/data/artatrade.db");
  const abs = "file:" + process.cwd().replace(/\\/g, "/") + "/data/artatrade.db";
  await inspect("abs-cwd-data  ", abs);
}
main();
