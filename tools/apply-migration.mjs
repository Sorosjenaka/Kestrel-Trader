// tools/apply-migration.mjs <nama_folder_migrasi>
// Menerapkan 1 migrasi SQLite secara IDEMPOTEN ke DB AKTIF (path dari tools/db-path.mjs):
//  - ALTER TABLE ... ADD COLUMN  -> dilewati bila kolom sudah ada
//  - CREATE INDEX ...            -> dilewati bila index sudah ada
//  - UPDATE / DELETE             -> selalu dijalankan (backfill/normalisasi)
// lalu mencatatnya di _prisma_migrations supaya `prisma migrate deploy` tidak mengulang.
// Dipakai karena DB lama belum di-baseline (P3005) dan `prisma migrate dev` interaktif.
// Contoh: node tools/apply-migration.mjs 20260925070000_t5_16_trade_provenance
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";

const folder = process.argv[2];
if (!folder) {
  console.error("Pakai: node tools/apply-migration.mjs <nama_folder_migrasi>");
  process.exit(2);
}
const MIGRATION = folder;
const DB_PATH = resolveDbPath();
const SQL_PATH = path.resolve(`prisma/migrations/${folder}/migration.sql`);
const sql = fs.readFileSync(SQL_PATH, "utf8");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 8000;");
console.log(`DB aktif : ${DB_PATH}`);
console.log(`Migrasi  : ${MIGRATION}`);

const hasColumn = (table, name) => {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === name);
  } catch {
    return false;
  }
};
const hasIndex = (name) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(name) !== undefined;

const statements = sql
  .split(";")
  .map((s) => s.replace(/--[^\n]*/g, "").trim())
  .filter(Boolean);

let applied = 0;
let skipped = 0;
for (const stmt of statements) {
  const addCol = stmt.match(/^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i);
  if (addCol && hasColumn(addCol[1], addCol[2])) {
    console.log(`  = skip kolom ${addCol[1]}.${addCol[2]}`);
    skipped++;
    continue;
  }
  const idx = stmt.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i);
  if (idx && hasIndex(idx[1])) {
    console.log(`  = skip index ${idx[1]}`);
    skipped++;
    continue;
  }
  db.exec(stmt + ";");
  applied++;
  console.log(`  + ${stmt.split("\n")[0].slice(0, 90)}`);
}

const checksum = crypto.createHash("sha256").update(sql).digest("hex");
const existing = db.prepare("SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?").get(MIGRATION);
if (!existing) {
  // 25 Okt 2026: started_at/finished_at ditulis sebagai INTEGER epoch-ms.
  // Sebelumnya `new Date().toISOString()` -> string ISO-8601, yang di SQLite
  // disimpan sebagai TEXT (kolom DATETIME punya NUMERIC affinity, tapi string
  // non-numerik TIDAK dikonversi otomatis). Mixed-type itu membuat
  // `prisma migrate status` crash: "ConversionError(input contains invalid
  // characters)" — dan menggeser urutan `ORDER BY createdAt` (TEXT selalu di
  // atas INTEGER, jadi event LAMA jadi "terbaru").
  const nowMs = Date.now();
  db.prepare(
    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`
  ).run(crypto.randomUUID(), checksum, nowMs, MIGRATION, nowMs);
  console.log(`  + migrasi dicatat: ${MIGRATION}`);
} else {
  console.log(`  = migrasi sudah tercatat: ${MIGRATION}`);
}
console.log(`\nSelesai. diterapkan=${applied} dilewati=${skipped}`);
db.close();
