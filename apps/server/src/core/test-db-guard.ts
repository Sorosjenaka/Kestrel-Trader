// Hard boundary for test databases. This module is intentionally dependency-free:
// it must be importable before Prisma, env loading, migrations or test setup.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..", "..");
export const TEST_ROOT = path.join(PROJECT_ROOT, "data", "test-runs");

function rawPath(url: string): string {
  const stripped = url.trim().replace(/^file:/i, "").split("?")[0]!;
  if (!stripped) throw new Error("TEST_DB_URL_EMPTY");
  return path.isAbsolute(stripped) ? stripped : path.resolve(PROJECT_ROOT, "prisma", stripped);
}

function isTestProcess(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test" || process.env.ARTA_OFFLINE_TEST === "true";
}

function realParent(file: string): string {
  // Resolve the parent, not the DB file: the file may not exist yet. This catches
  // symlinked directories and relative escapes before a client can create it.
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  return fs.realpathSync(parent);
}

export function assertTestDatabaseBoundary(rawUrl = process.env.DATABASE_URL, label = "database"): string {
  if (!isTestProcess()) return rawUrl ?? "";
  if (!rawUrl) throw new Error(`TEST_DB_URL_REQUIRED:${label}: refusing to open a database without an explicit test URL`);
  const file = rawPath(rawUrl);
  const parent = realParent(file);
  const rootReal = fs.realpathSync(TEST_ROOT);
  const relative = path.relative(rootReal, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`TEST_DB_OUTSIDE_DISPOSABLE_ROOT:${label}:${path.relative(rootReal, parent)}`);
  }
  if (path.basename(file) === "artatrade.db" || /(^|[\\/])artatrade\.test\.db$/.test(file)) {
    throw new Error(`TEST_DB_ACTIVE_OR_LEGACY_NAME_REJECTED:${label}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(path.basename(file))) {
    throw new Error(`TEST_DB_UNSAFE_FILENAME:${label}`);
  }
  const resolved = path.join(parent, path.basename(file));
  return "file:" + resolved.replace(/\\/g, "/");
}

export function disposableTestDbPath(runId = process.env.ARTA_TEST_RUN_ID, workerId = process.env.VITEST_POOL_ID ?? "0"): string {
  if (!runId || !/^[A-Za-z0-9._-]{8,80}$/.test(runId)) throw new Error("TEST_RUN_ID_REQUIRED");
  const safeWorker = String(workerId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20) || "0";
  return path.join(TEST_ROOT, runId, `artatrade-test-w${safeWorker}.db`);
}

export function assertCleanupPath(file: string): void {
  const parent = realParent(file);
  const rootReal = fs.realpathSync(TEST_ROOT);
  const relative = path.relative(rootReal, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TEST_DB_CLEANUP_OUTSIDE_DISPOSABLE_ROOT");
}
