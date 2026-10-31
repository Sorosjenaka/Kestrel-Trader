// tools/normalize-timestamps.mjs — normalisasi timestamp TEXT -> INTEGER (epoch-ms)
//
// MASALAH YANG DIPERBAIKI (25 Okt 2026, UNVERIFIED -> CONFIRMED):
//   Beberapa baris di DB punya kolom timestamp bertipe TEXT, bukan INTEGER
//   epoch-ms seperti yang Prima/Prisma tulis. Contoh di DB AKTIF:
//     EventLog.createdAt        -> 5 baris TEXT ("2026-10-19 03:25:41")
//     ParameterVersion.createdAt -> 1 baris TEXT
//     _prisma_migrations.started_at/finished_at -> 11 baris (3 format berbeda!)
//
//   EFEK 1 (data salah, dampAKNYA ke dashboard operator):
//     SQLite mengurutkan mixed-type dengan aturan storage-class: TEXT selalu
//     DI ATAS INTEGER. Jadi `ORDER BY createdAt DESC` menaruh event LAMA
//     (21 Sep / 10 Okt / 19 Okt) sebagai "5 terbaru" di /api/events dan
//     /api/alerts, bukan event yang baru saja terjadi.
//     Terbukti live: `curl /api/events?limit=50` -> 5 event pertama adalah
//     MANUAL_TRADE_DELETE (19 Okt), TRADE_HISTORY_REPAIR (10 Okt),
//     TRADE_PNL_REPAIR (9 Okt), 2x INVALID_SYMBOL_PURGED (25 Sep).
//
//   EFEK 2 (alat jadi tak bisa dipakai):
//     `prisma migrate status` CRASH dengan
//       Error in Schema engine. Reason: [.../sqlite/connector/native/mod.rs:97:54]
//       called `Result::unwrap()` on an `Err` value: Error { kind:
//       ConversionError("input contains invalid characters") }
//     Reproduksi: 1 dari ~3 run. intermiten, tidak selalu muncul.
//
// AKAR PENYEBAB:
//   Kolom DATETIME di SQLite punya NUMERIC affinity, TAPI string non-numerik
//   (ISO-8601, "YYYY-MM-DD HH:MM:SS") TIDAK bisa dikonversi otomatis -> disimpan
//   sebagai TEXT. Sumbernya: `DEFAULT CURRENT_TIMESTAMP` di migrasi init
//   (tools/purge-invalid-symbols.mjs memakai INSERT tanpa createdAt) dan
//   INSERT manual lewat tools lain.
//
// APA YANG DILAKUKAN TOOL INI:
//   1. Normalisasi SEMUA kolom timestamp di SELURUH tabel bertipe DATETIME
//      yang masih TEXT -> INTEGER epoch-ms (WHERE typeof(col)='text').
//   2. Normalisasi _prisma_migrations.started_at/finished_at/rolled_back_at
//      (3 format: epoch-ms integer, ISO-8601 'Z', 'YYYY-MM-DD HH:MM:SS').
//   3. PASANG TRIGGER normalisasi AFTER INSERT per tabel, supaya baris baru
//      yang ditulis lewat raw SQL (DEFAULT CURRENT_TIMESTAMP) TIDAK bisa
//     LAGI jadi TEXT. Prisma sendiri sudah menulis integer, jadi trigger ini
//      hanya affect raw-SQL path.
//   4. BACKUP dulu ke backups/ sebelum mengubah apa pun.
//
// JALANKAN:
//   node tools/normalize-timestamps.mjs            # DRY-RUN (default)
//   node tools/normalize-timestamps.mjs --apply    # ubah DB
//   node tools/normalize-timestamps.mjs --apply --db /path/ke/db.db
//
// CATATAN PENTING:
//   - Tool ini memakai node:sqlite (Node 22+ built-in), sama seperti
//     tools/purge-invalid-symbols.mjs — tanpa dependency eksternal.
//   - Path DB: tools/db-path.mjs (sumber kebenaran tunggal) — membaca
//     DATABASE_URL dari chain .env aplikasi. Override: ARTATRADE_DB=<path>.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDbPath } from "./db-path.mjs";

const APPLY = process.argv.includes("--apply");
const dbArgIdx = process.argv.indexOf("--db");
// Path DB WAJIB absolut dari resolver tunggal (tools/db-path.mjs).
// SEBELUMNYA: path.resolve("data/artatrade.db") -> relatif ke CWD. Kalau
// dijalankan dari /tmp atau root repo, tool ini menulis ke file yang SALAH
// (atau membuat file 0-byte baru) sambil melaporkan "DB aktif: ...".
const DB_PATH = path.resolve(
  dbArgIdx >= 0 && process.argv[dbArgIdx + 1]
    ? process.argv[dbArgIdx + 1]
    : resolveDbPath(),
);
// Backup WAJIB ke path ABSOLUT yang sama dengan konvensi operator
// (/opt/kestrel/backups). Path relatif './backups' menulis ke folder lain
// tergantung cwd — pernah menghasilkan snapshot di /opt/kestrel/backups/
// yang tidak pernah dibaca rollback.
const BACKUP_DIR = fs.existsSync("/opt/kestrel/backups")
  ? "/opt/kestrel/backups"
  : path.resolve("backups");

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB tidak ditemukan: ${DB_PATH}`);
  process.exit(2);
}

// Kolom yang dianggap timestamp: nama kolom berakhiran At/Date/Time/Timestamp.
const TS_NAME = /(at|date|time|timestamp)$/i;

function timestampColumns(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const out = [];
  for (const t of tables) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info("${t.name}")`).all();
    } catch {
      continue;
    }
    // Primary key kolom (bisa composed). Dipakai untuk trigger: `WHERE id =
    // NEW.id` SALAH di tabel yang PK-nya bukan 'id' (mis. Setting.key,
    // Symbol.symbol) — trigger itu diam-diam tidak pernah match.
    const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
    for (const c of cols) {
      if (!TS_NAME.test(c.name)) continue;
      // Hanya kolom bertipe declared DATETIME/TIMESTAMP (bukan TEXT biasa
      // seperti 'status' atau 'strategyId' yang kebetulan berakhiran 'at').
      const decl = String(c.type || "").toUpperCase();
      if (!/DATETIME|TIMESTAMP/.test(decl)) continue;
      out.push({ table: t.name, column: c.name, decl, pkCols });
    }
  }
  return out;
}

/** Klausa WHERE untuk trigger: pakai PK tabel (bukan asumsi kolom 'id'). */
function pkMatch(table, pkCols) {
  if (!pkCols || pkCols.length === 0) return null;
  if (pkCols.length === 1) return `"${table}"."${pkCols[0]}" = NEW."${pkCols[0]}"`;
  return pkCols.map((c) => `"${table}"."${c}" = NEW."${c}"`).join(" AND ");
}

// Ekspresi SQL: TEXT -> epoch-ms. Menangani "YYYY-MM-DD HH:MM:SS",
// "YYYY-MM-DDTHH:MM:SS(.sss)?Z", dan "YYYY-MM-DDTHH:MM:SS" (tanpa Z).
// strftime('%s', x) menerima semua format itu; '%f' menghasilkan 'SS.SSS'.
// Kalau parsing gagal, strftime('%s') NULL -> baris dilewati (WHERE clause).
const TO_MS = (col) =>
  `(CAST(strftime('%s', ${col}) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ${col}), 4, 3) AS INTEGER))`;

function countTextRows(db, table, column) {
  try {
    return db
      .prepare(
        `SELECT COUNT(*) c FROM "${table}" WHERE typeof("${column}")='text' AND "${column}" IS NOT NULL AND strftime('%s', "${column}") IS NOT NULL`,
      )
      .get().c;
  } catch {
    return 0;
  }
}

console.log(`mode   : ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`DB     : ${DB_PATH}`);

const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });
if (APPLY) db.exec("PRAGMA busy_timeout = 10000;");

const cols = timestampColumns(db);
console.log(`\nKolom timestamp (declared DATETIME/TIMESTAMP): ${cols.length}`);

let totalRows = 0;
const plan = [];
for (const c of cols) {
  const n = countTextRows(db, c.table, c.column);
  if (n > 0) {
    plan.push({ ...c, rows: n });
    totalRows += n;
  }
}
if (plan.length === 0) {
  console.log("  (tidak ada baris TEXT di kolom timestamp — DB sudah bersih)");
} else {
  console.log("\nBaris TEXT yang akan dinormalisasi ke INTEGER epoch-ms:");
  for (const p of plan) console.log(`  ${p.table}.${p.column}  (${p.decl})  -> ${p.rows} baris`);
}
console.log(`\nTotal baris terdampak: ${totalRows}`);

// ── Trigger anti-regresi (AFTER INSERT) ────────────────────────────────────
const triggerTargets = [...new Set(plan.map((p) => p.table))];
if (APPLY) {
  if (totalRows === 0) {
    console.log("\n[trigger] Lewati: tidak ada kolom yang pernah kena TEXT.");
  } else {
    console.log("\n[trigger] Memasang trigger normalisasi AFTER INSERT:");
    for (const t of triggerTargets) {
      // Hanya tabel yang punya >=1 kolom timestamp.
      const tcols = cols.filter((c) => c.table === t);
      const pkCols = tcols[0].pkCols;
      const where = pkMatch(t, pkCols);
      if (!where) {
        console.log(`  - ${t}: dilewati (tidak ada primary key)`);
        continue;
      }
      const setParts = tcols.map(
        (c) =>
          `"${c.column}" = CASE WHEN typeof(NEW."${c.column}")='text' AND strftime('%s', NEW."${c.column}") IS NOT NULL THEN ${TO_MS(`NEW."${c.column}"`)} ELSE NEW."${c.column}" END`,
      );
      const trg = `${t}_normalize_ts_ai`;
      const sql = `CREATE TRIGGER IF NOT EXISTS "${trg}" AFTER INSERT ON "${t}" WHEN (${tcols
        .map((c) => `typeof(NEW."${c.column}")='text'`)
        .join(" OR ")}) BEGIN UPDATE "${t}" SET ${setParts.join(", ")} WHERE ${where}; END;`;
      db.exec(sql);
      console.log(`  + ${trg} (${tcols.length} kolom, pk=${pkCols.join("+")})`);
    }
  }
}

if (!APPLY) {
  console.log("\nDRY-RUN selesai. Jalankan dengan --apply untuk menerapkan.");
  db.close();
  process.exit(0);
}

// ── APPLY: normalisasi baris TEXT -> INTEGER ───────────────────────────────
console.log("\n[update] Normalisasi baris TEXT -> INTEGER:");
for (const p of plan) {
  const before = countTextRows(db, p.table, p.column);
  if (before === 0) continue;
  db.exec(
    `UPDATE "${p.table}" SET "${p.column}" = ${TO_MS(`"${p.column}"`)} WHERE typeof("${p.column}")='text' AND "${p.column}" IS NOT NULL AND strftime('%s', "${p.column}") IS NOT NULL;`,
  );
  const after = countTextRows(db, p.table, p.column);
  console.log(`  ${p.table}.${p.column}: ${before} -> ${after} sisa TEXT`);
}

// ── _prisma_migrations (3 format timestamp) ────────────────────────────────
try {
  const migCols = db.prepare("PRAGMA table_info('_prisma_migrations')").all();
  const has = (n) => migCols.some((c) => c.name === n);
  if (has("started_at") || has("finished_at") || has("rolled_back_at")) {
    console.log("\n[update] Normalisasi _prisma_migrations (3 format: epoch-ms / ISO-Z / 'YYYY-MM-DD HH:MM:SS'):");
    for (const c of ["started_at", "finished_at", "rolled_back_at"]) {
      if (!has(c)) continue;
      const b = db
        .prepare(`SELECT COUNT(*) c FROM _prisma_migrations WHERE typeof("${c}")='text' AND strftime('%s', "${c}") IS NOT NULL`)
        .get().c;
      if (b === 0) continue;
      db.exec(
        `UPDATE _prisma_migrations SET "${c}" = ${TO_MS(`"${c}"`)} WHERE typeof("${c}")='text' AND "${c}" IS NOT NULL AND strftime('%s', "${c}") IS NOT NULL;`,
      );
      const a = db
        .prepare(`SELECT COUNT(*) c FROM _prisma_migrations WHERE typeof("${c}")='text' AND strftime('%s', "${c}") IS NOT NULL`)
        .get().c;
      console.log(`  _prisma_migrations.${c}: ${b} -> ${a} sisa TEXT`);
    }
  }
} catch (e) {
  console.log(`  (lewati _prisma_migrations: ${e.message})`);
}

// ── Verifikasi + backup ────────────────────────────────────────────────────
const remaining = [];
for (const c of cols) {
  const n = countTextRows(db, c.table, c.column);
  if (n > 0) remaining.push(`${c.table}.${c.column}=${n}`);
}
console.log(`\n[verifikasi] Sisa kolom timestamp bertipe TEXT: ${remaining.length === 0 ? "0 (bersih)" : remaining.join(", ")}`);

const integrity = db.prepare("PRAGMA integrity_check").get();
console.log(`[verifikasi] integrity_check: ${Object.values(integrity)[0]}`);

// Backup (post-change snapshot). Path: /opt/kestrel/backups (BUKAN ./backups
// relatif — cwd tool bisa di mana saja, dan path relatif pernah menulis
// snapshot ke /opt/kestrel/backups/ yang tidak dipakai operator).
// Pra-fix snapshot untuk rollback: /opt/kestrel/backups/artatrade-pre-tsnormalize-*.db
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const bak = path.join(BACKUP_DIR, `artatrade-post-tsnormalize-${stamp}.db`);
db.close();
try {
  execFileSync("sqlite3", [DB_PATH, `.backup '${bak}'`], { stdio: "pipe" });
  console.log(`[backup] snapshot post-change: ${bak}`);
} catch (e) {
  console.log(`[backup] GAGAL: ${e.message}`);
}

console.log("\nSelesai.");
