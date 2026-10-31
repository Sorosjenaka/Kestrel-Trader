import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Only the dedicated local sandbox database may be created/migrated here. */
export async function prepareLocalDatabase(root) {
  const target = path.resolve(root, "data/local/artatrade.db");
  const migrationRoot = path.resolve(root, "prisma/migrations");
  const migrations = fs.readdirSync(migrationRoot).sort().filter(name => fs.existsSync(path.join(migrationRoot, name, "migration.sql")))
    .map(name => {
      const sql = fs.readFileSync(path.join(migrationRoot, name, "migration.sql"), "utf8");
      return { name, sql, hash: createHash("sha256").update(sql).digest("hex") };
    });
  if (!migrations.length) throw new Error("LOCAL_MIGRATIONS_MISSING");
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length && !tables.some(table => table.name === "_arta_local_migrations")) {
      throw new Error("LOCAL_DATABASE_UNMANAGED: existing database left unchanged");
    }
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS _arta_local_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)");
      const applied = new Map(db.prepare("SELECT name, hash FROM _arta_local_migrations").all().map(row => [row.name, row.hash]));
      for (const migration of migrations) {
        if (applied.has(migration.name)) {
          if (applied.get(migration.name) !== migration.hash) throw new Error("LOCAL_MIGRATION_CHECKSUM_MISMATCH");
          continue;
        }
        db.exec(migration.sql);
        db.prepare("INSERT INTO _arta_local_migrations (name, hash) VALUES (?, ?)").run(migration.name, migration.hash);
      }
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
  } finally { db.close(); }
  return target;
}
