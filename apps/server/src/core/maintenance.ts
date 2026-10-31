// apps/server/src/core/maintenance.ts - Rotasi log & Retensi DB (T-4.4, NFR-07).
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { logger } from "./logger.js";

export interface RetentionOptions {
  eventLogRetentionDays?: number;
  setupCandidateRetentionDays?: number;
  leverageHistoryRetentionDays?: number;
  vacuumDb?: boolean;
}

export interface PruneResult {
  eventLogsDeleted: number;
  setupCandidatesDeleted: number;
  leverageHistoryDeleted: number;
  dbSizeBytes: number;
  timestamp: string;
}

export interface LogRotationOptions {
  logDir: string;
  maxSizeBytes?: number; // default 10MB
  maxBackups?: number;   // default 5
}

export interface LogRotationResult {
  rotatedFiles: string[];
  deletedFiles: string[];
  totalLogSizeBytes: number;
}

export async function pruneDatabase(opts: RetentionOptions = {}): Promise<PruneResult> {
  // 14 Okt 2026: retention diturunkan drastis — EventLog 794k baris/4 hari
  // bikin DB 900MB+ dan Prisma timeout, membunuh SWING funnel.
  const eventDays = opts.eventLogRetentionDays ?? 3;
  const setupDays = opts.setupCandidateRetentionDays ?? 7;
  const leverageDays = opts.leverageHistoryRetentionDays ?? 30;

  const nowMs = Date.now();
  const eventCutoff = new Date(nowMs - eventDays * 24 * 60 * 60 * 1000);
  const setupCutoff = new Date(nowMs - setupDays * 24 * 60 * 60 * 1000);
  const leverageCutoff = new Date(nowMs - leverageDays * 24 * 60 * 60 * 1000);

  const eventRes = await db.eventLog.deleteMany({
    where: { createdAt: { lt: eventCutoff } },
  });

  const setupRes = await db.setupCandidate.deleteMany({
    where: { createdAt: { lt: setupCutoff } },
  });

  const leverageRes = await db.leverageHistory.deleteMany({
    where: { createdAt: { lt: leverageCutoff } },
  });

  // 14 Okt 2026: selalu jalankan wal_checkpoint + VACUUM setelah prune.
  // Tanpa VACUUM, file SQLite tidak menyusut meski ratusan ribu baris dihapus.
  try {
    await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (e) {
    logger.warn({ err: e }, "Gagal mengeksekusi wal_checkpoint saat pemeliharaan DB");
  }
  if (opts.vacuumDb !== false) {
    try {
      await db.$executeRawUnsafe("VACUUM;");
    } catch (e) {
      logger.warn({ err: e }, "Gagal VACUUM DB saat pemeliharaan");
    }
  }

  let dbSizeBytes = 0;
  const dbUrl = process.env.DATABASE_URL || "file:./data/artatrade.db";
  const dbPath = dbUrl.replace(/^file:/, "").split("?")[0];
  try {
    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
  } catch (err) {
    // Abaikan kegagalan baca stat disk
  }

  logger.info(
    {
      eventLogsDeleted: eventRes.count,
      setupCandidatesDeleted: setupRes.count,
      leverageHistoryDeleted: leverageRes.count,
      dbSizeBytes,
    },
    "Pemeliharaan retensi DB selesai"
  );

  return {
    eventLogsDeleted: eventRes.count,
    setupCandidatesDeleted: setupRes.count,
    leverageHistoryDeleted: leverageRes.count,
    dbSizeBytes,
    timestamp: new Date().toISOString(),
  };
}

export function rotateLogFiles(opts: LogRotationOptions): LogRotationResult {
  const maxBytes = opts.maxSizeBytes ?? 10 * 1024 * 1024; // 10 MB
  const maxBackups = opts.maxBackups ?? 5;
  const rotatedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let totalLogSizeBytes = 0;

  if (!fs.existsSync(opts.logDir)) {
    return { rotatedFiles, deletedFiles, totalLogSizeBytes };
  }

  const entries = fs.readdirSync(opts.logDir);
  for (const entry of entries) {
    const fullPath = path.join(opts.logDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    totalLogSizeBytes += stat.size;

    // Hanya rotasi log primer (tanpa ekstensi angka dibelakang)
    if (entry.endsWith(".log") && stat.size >= maxBytes) {
      // Geser file backup yang ada
      for (let i = maxBackups - 1; i >= 1; i--) {
        const oldBackup = `${fullPath}.${i}`;
        const newBackup = `${fullPath}.${i + 1}`;
        if (fs.existsSync(oldBackup)) {
          if (i === maxBackups - 1) {
            fs.unlinkSync(oldBackup);
            deletedFiles.push(oldBackup);
          } else {
            fs.renameSync(oldBackup, newBackup);
          }
        }
      }

      const firstBackup = `${fullPath}.1`;
      fs.renameSync(fullPath, firstBackup);
      fs.writeFileSync(fullPath, "");
      rotatedFiles.push(entry);
    }
  }

  return { rotatedFiles, deletedFiles, totalLogSizeBytes };
}
