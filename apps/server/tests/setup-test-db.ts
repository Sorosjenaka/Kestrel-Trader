// apps/server/tests/setup-test-db.ts — disposable test database bootstrap.
// It runs only after the hard guard says this is a test process. The database
// lives under data/test-runs/<runId>/ and is never the runtime PAPER/LIVE DB.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabaseBoundary, disposableTestDbPath, TEST_ROOT } from "../src/core/test-db-guard.js";

export function testDbUrl(): string {
  return process.env.DATABASE_URL || "";
}

export default async function setup() {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test" && process.env.ARTA_OFFLINE_TEST !== "true") {
    throw new Error("TEST_DB_BOOTSTRAP_REQUIRES_TEST_PROCESS");
  }
  const runId = process.env.ARTA_TEST_RUN_ID || `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(runId)) throw new Error("TEST_RUN_ID_INVALID");
  process.env.ARTA_TEST_RUN_ID = runId;
  fs.mkdirSync(path.join(TEST_ROOT, runId), { recursive: true });

  const testDbFile = disposableTestDbPath(runId, "global");
  const url = assertTestDatabaseBoundary("file:" + testDbFile, "global-setup");
  // Never silently overwrite an inherited runtime/arbitrary URL. A wrong
  // invocation must fail closed before the test DB is created.
  if (process.env.DATABASE_URL) {
    const incoming = assertTestDatabaseBoundary(process.env.DATABASE_URL, "incoming-env");
    if (incoming !== url) throw new Error("TEST_DATABASE_URL_MISMATCH");
  }
  process.env.DATABASE_URL = url;

  // Reset only this run's disposable file; never a runtime/backup database.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(testDbFile + suffix, { force: true });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationRoot = path.resolve(here, "../../../prisma/migrations");
  const connection = new DatabaseSync(testDbFile);
  try {
    connection.exec("PRAGMA foreign_keys=ON");
    for (const folder of fs.readdirSync(migrationRoot).sort()) {
      const sql = path.join(migrationRoot, folder, "migration.sql");
      if (fs.existsSync(sql)) connection.exec(fs.readFileSync(sql, "utf8"));
    }
  } finally { connection.close(); }

  const manifest = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    database: path.relative(TEST_ROOT, testDbFile).replace(/\\/g, "/"),
    databaseSha256: crypto.createHash("sha256").update(fs.readFileSync(testDbFile)).digest("hex"),
    migrationRoot: "prisma/migrations",
    note: "Disposable test DB; never used by PAPER/LIVE runtime.",
  };
  fs.writeFileSync(path.join(TEST_ROOT, runId, "manifest.json"), JSON.stringify(manifest, null, 2));
}
