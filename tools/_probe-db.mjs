// tools/_probe-db.mjs — read-only probe: which SQLite file is the live DB?
import { PrismaClient } from "@prisma/client";

const candidates = [
  "file:C:/Users/FATHUR/Documents/Baru/data/artatrade.db",
  "file:C:/Users/FATHUR/Documents/Baru/data/artatrade.test.db",
  "file:C:/Users/FATHUR/Documents/Baru/apps/server/data/artatrade.db",
];

for (const url of candidates) {
  const p = new PrismaClient({ datasourceUrl: url });
  try {
    const cols = await p.$queryRawUnsafe("PRAGMA table_info('Trade')");
    const cnt = await p.$queryRawUnsafe("SELECT COUNT(*) AS n FROM Trade");
    const rng = await p.$queryRawUnsafe("SELECT MIN(createdAt) AS mn, MAX(createdAt) AS mx FROM Trade");
    const src = await p.$queryRawUnsafe("SELECT source, COUNT(*) AS n FROM Trade GROUP BY source");
    console.log(JSON.stringify({
      url,
      ok: true,
      hasStrategyId: cols.some((c) => c.name === "strategyId"),
      columns: cols.map((c) => c.name),
      tradeCount: cnt[0]?.n,
      range: rng[0],
      bySource: src,
    }));
  } catch (e) {
    console.log(JSON.stringify({ url, ok: false, err: String(e.message).split("\n").filter(Boolean)[0] }));
  } finally {
    await p.$disconnect().catch(() => {});
  }
}