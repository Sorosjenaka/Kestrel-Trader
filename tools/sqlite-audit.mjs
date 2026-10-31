// tools/sqlite-audit.mjs - Audit DB langsung via node:sqlite (tanpa Prisma): tentukan DB aktif & isi tabel.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";

// Path DB dari resolver tunggal. SEBELUMNYA: path.resolve("data/artatrade.db")
// -> relatif ke CWD, jadi dari /tmp tool ini baca file yang salah / bikin 0-byte.
const ACTIVE_DB = resolveDbPath();
const files = [
  ACTIVE_DB,
  path.join(path.dirname(ACTIVE_DB), "..", "prisma", "data", "artatrade.db"),
];

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  let db;
  try {
    db = new DatabaseSync(f, { readOnly: true });
  } catch (e) {
    console.log("  BUKA GAGAL:", e.message.slice(0, 140));
    continue;
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    console.log("  tabel:", tables.join(", ").slice(0, 300));
    const count = (t) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
      } catch {
        return "n/a";
      }
    };
    console.log(
      `  trades=${count("Trade")} positions=${count("Position")} openPositions=${(() => {
        try {
          return db.prepare('SELECT COUNT(*) AS c FROM "Position" WHERE status = \'OPEN\'').get().c;
        } catch {
          return "n/a";
        }
      })()} learnings=${count("LearningEntry")} params=${count("ParameterVersion")} candidates=${count("SetupCandidate")}`
    );
    try {
      const cols = db.prepare('PRAGMA table_info("Position")').all().map((c) => c.name);
      console.log("  Position punya trailActive:", cols.includes("trailActive"), "| strategi:", cols.includes("strategyId"));
    } catch {}
    try {
      const migs = db.prepare('SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at').all();
      console.log("  migrasi tercatat:", migs.map((m) => `${m.migration_name}${m.finished_at ? "" : "(BELUM SELESAI)"}`).join(", ") || "KOSONG");
    } catch {
      console.log("  migrasi tercatat: (tabel _prisma_migrations tidak ada)");
    }
  } finally {
    db.close();
  }
}
