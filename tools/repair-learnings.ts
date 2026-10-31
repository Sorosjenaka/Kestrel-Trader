// tools/repair-learnings.ts
// Perbaiki foreign key LearningEntry agar ON DELETE SET NULL (SQLite tak bisa
// ALTER FK -> tabel dibangun ulang), lalu PULIHKAN evaluasi dari arsip JSON.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { resolveDbUrl } from "./db-path.mjs";

const db = new PrismaClient({ datasourceUrl: resolveDbUrl() });

async function main() {
  const ddl: any[] = await db.$queryRawUnsafe("SELECT sql FROM sqlite_master WHERE name='LearningEntry'");
  console.log("DDL LearningEntry SEBELUM:\n" + (ddl[0]?.sql ?? "(tidak ada)"));

  const needsRebuild = !(ddl[0]?.sql ?? "").includes("SET NULL");
  if (needsRebuild) {
    console.log("\nFK masih CASCADE -> membangun ulang tabel dengan ON DELETE SET NULL...");
    await db.$executeRawUnsafe("PRAGMA foreign_keys=OFF;");
    await db.$executeRawUnsafe(`
      CREATE TABLE "new_LearningEntry" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "tradeId" INTEGER,
        "causeCode" TEXT NOT NULL,
        "narrative" TEXT NOT NULL,
        "proposal" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "LearningEntry_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      );
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "new_LearningEntry" ("id","tradeId","causeCode","narrative","proposal","createdAt")
      SELECT "id", NULL, "causeCode", "narrative", "proposal", "createdAt" FROM "LearningEntry";
    `);
    await db.$executeRawUnsafe(`DROP TABLE "LearningEntry";`);
    await db.$executeRawUnsafe(`ALTER TABLE "new_LearningEntry" RENAME TO "LearningEntry";`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LearningEntry_tradeId_idx" ON "LearningEntry"("tradeId");`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LearningEntry_causeCode_idx" ON "LearningEntry"("causeCode");`);
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON;");
    const after: any[] = await db.$queryRawUnsafe("SELECT sql FROM sqlite_master WHERE name='LearningEntry'");
    console.log("DDL LearningEntry SESUDAH:\n" + after[0].sql);
  } else {
    console.log("\nFK sudah ON DELETE SET NULL (tidak perlu rebuild).");
  }

  // ---------- PULIHKAN EVALUASI DARI ARSIP ----------
  // Pilih arsip yang PALING BANYAK memuat evaluasi (arsip bisa dibuat beberapa kali).
  const dir = path.resolve("data", "eval-archive");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("eval-archive-")).sort();
  let best: { file: string; learnings: any[] } | null = null;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { learnings?: any[] };
      const n = (j.learnings ?? []).length;
      if (!best || n > best.learnings.length) best = { file: f, learnings: j.learnings ?? [] };
    } catch {}
  }
  if (!best || best.learnings.length === 0) {
    console.log("\nTidak ada arsip yang memuat evaluasi untuk dipulihkan.");
    return;
  }
  const learnings = best.learnings;
  console.log(`\nMemulihkan ${learnings.length} evaluasi dari arsip ${best.file}...`);
  let restored = 0;
  for (const l of learnings) {
    try {
      await db.learningEntry.create({
        data: {
          causeCode: l.causeCode || "OTHER",
          narrative: l.narrative || "(narasi tidak tersimpan)",
          proposal: l.proposal ?? null,
          // Trade-nya sudah dihapus sesuai perintah operator -> tradeId = null.
          tradeId: null,
          createdAt: l.createdAt ? new Date(l.createdAt) : new Date(),
        },
      });
      restored++;
    } catch (e) {
      console.log(`  gagal restore learning #${l.id}: ${(e as Error).message}`);
    }
  }
  console.log(`\n=== EVALUASI DIPULIHKAN: ${restored}/${learnings.length} ===`);

  // ---------- PULIHKAN DIGEST EVALUASI KE Setting ----------
  try {
    const bestJson = JSON.parse(fs.readFileSync(path.join(dir, best.file), "utf8")) as { digest?: Record<string, unknown> };
    if (bestJson.digest) {
      await db.setting.upsert({
        where: { key: "evalDigest" },
        update: { value: JSON.stringify(bestJson.digest) },
        create: { key: "evalDigest", value: JSON.stringify(bestJson.digest) },
      });
      fs.writeFileSync(path.join(dir, "eval-digest-latest.json"), JSON.stringify(bestJson.digest, null, 1), "utf8");
      console.log(`Digest evaluasi dipulihkan dari ${best.file} (trades tercatat: ${(bestJson.digest as any).totalTrades}).`);
    }
  } catch {}

  console.log("Total LearningEntry sekarang:", await db.learningEntry.count());
  console.log("Distribusi causeCode:", await db.learningEntry.groupBy({ by: ["causeCode"], _count: { _all: true } }));
  console.log("Trades (harus 0):", await db.trade.count(), "| Positions:", await db.position.count());
}

main()
  .catch((e) => { console.error("Fatal:", e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
