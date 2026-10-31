// ArtaTrade AI - Prisma client singleton (FR-25, NFR-07).
// DATABASE_URL bisa diberikan opsional sebagai path absolut Windows,
// relatif ("file:../data/..."), atau URL sqlite penuh ("file:/...").
import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";
import { resolveDatabaseUrl } from "./paths.js";
import { assertTestDatabaseBoundary } from "./test-db-guard.js";
import { logger } from "./logger.js";

// Env priority is resolved once by env.ts. Relative SQLite URLs always use the
// schema directory, independent of npm workspace CWD. Foreign paths fail closed.
const resolvedDatabaseUrl = resolveDatabaseUrl(env.DATABASE_URL);
const guardedDatabaseUrl = assertTestDatabaseBoundary(resolvedDatabaseUrl, "prisma-client");
process.env.DATABASE_URL = guardedDatabaseUrl || resolvedDatabaseUrl;

const globalForPrisma = globalThis as unknown as { __artaDb?: PrismaClient };
export const db =
  globalForPrisma.__artaDb ?? new PrismaClient();

// ── 15 Okt 2026 — TAHAP 2 rencana audit: SQLite WAL + busy_timeout ────────
// WAL mengurangi SQLITE_BUSY antar koneksi (reader tidak blokir writer) dan
// busy_timeout 5000ms memberi retry otomatis saat lock singkat. Dijalankan
// sekali di startup; VACUUM tetap di maintenance.ts (jam sepi).
let _pragmaApplied: Promise<void> | null = null;
export function applySqlitePragmas(): Promise<void> {
  if (!_pragmaApplied) {
    _pragmaApplied = (async () => {
      try {
        // PRAGMA SQLite mengembalikan hasil -> $queryRawUnsafe, bukan executeRaw.
        const mode = await db.$queryRawUnsafe<{ journal_mode?: string }>("PRAGMA journal_mode=WAL;");
        await db.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
        await db.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
        logger.info({ mode }, "SQLite PRAGMA diterapkan: journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL");
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "PRAGMA SQLite gagal diterapkan (bukan fatal)");
        _pragmaApplied = null; // coba lagi di pemanggilan berikutnya
      }
    })();
  }
  return _pragmaApplied;
}
void applySqlitePragmas();
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__artaDb = db;
}
