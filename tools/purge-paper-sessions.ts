// tools/purge-paper-sessions.ts
// Hapus data PAPER yang sudah tutup pada sesi (hari paper) tertentu dari
// history portfolio — perintah operator 25 Okt 2026.
//
// Definisi sesi identik dengan paperDailySnapshot.ts: label = tanggal UTC baris
// trade (cutover 00:00 UTC = 07:00 WIB). Contoh: sesi "2026-10-23" =
// 23 Okt 07:00 WIB -> 24 Okt 07:00 WIB.
//
// YANG DIJAGA (tidak pernah ikut terhapus):
//   - posisi OPEN (hanya status CLOSED yang boleh dihapus)
//   - trade source LIVE_AI / DEMO
//   - LearningEntry (otak) — tradeId jadi null, baris\paragraph tetap tersimpan
//   - DecisionLog / SwingSignalLog — positionId jadi null, data keputusan tetap
//   - OrderExec — positionId jadi null, jejak order tetap tersimpan
//   - EventLog — riwayat audit tidak pernah dihapus
// Yang terhapus: baris Position + Trade (Trade cascade dari Position).
//
// Pemakaian:
//   npx tsx tools/purge-paper-sessions.ts --sessions=2026-10-22,2026-10-23
//   npx tsx tools/purge-paper-sessions.ts --sessions=2026-10-22,2026-10-23 --apply
// Default = dry-run (tidak ada yang ditulis). --apply untuk eksekusi.
import { db } from "../apps/server/src/core/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAPER_SOURCES = ["PAPER_AI", "PAPER_MANUAL"];

function parseArgs(argv: string[]): { sessions: string[]; apply: boolean } {
  const sessions: string[] = [];
  let apply = false;
  for (const arg of argv) {
    if (arg.startsWith("--sessions=")) {
      for (const part of arg.slice("--sessions=".length).split(",")) {
        const s = part.trim();
        if (!s) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`SESSION_LABEL_INVALID: ${s}`);
        sessions.push(s);
      }
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx tools/purge-paper-sessions.ts --sessions=YYYY-MM-DD[,YYYY-MM-DD] [--apply]");
      process.exit(0);
    } else {
      throw new Error(`ARG_UNKNOWN: ${arg}`);
    }
  }
  if (sessions.length === 0) throw new Error("SESSIONS_REQUIRED");
  sessions.sort();
  return { sessions, apply };
}

/** Jendela [start, end) UTC untuk satu label sesi paper. */
function sessionWindow(label: string): { from: Date; to: Date } {
  const from = new Date(`${label}T00:00:00.000Z`);
  if (!Number.isFinite(from.getTime())) throw new Error(`SESSION_LABEL_INVALID: ${label}`);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

async function main() {
  const { sessions, apply } = parseArgs(process.argv.slice(2));
  const windows = sessions.map((label) => ({ label, ...sessionWindow(label) }));

  // Kumpulkan target: trade PAPER yang tutup di salah satu sesi.
  const targets = await db.trade.findMany({
    where: {
      source: { in: PAPER_SOURCES },
      accountingQuality: "SIMULATED",
      createdAt: { gte: windows[0]!.from, lt: windows[windows.length - 1]!.to },
    },
    orderBy: { id: "asc" },
    include: { position: { select: { id: true, status: true, closeReason: true, source: true } } },
  });

  const inSession = (createdAt: Date) =>
    windows.find((w) => createdAt >= w.from && createdAt < w.to)?.label ?? "?";

  const rows = targets.map((t) => ({
    tradeId: t.id,
    positionId: t.positionId,
    symbol: t.symbol,
    strategyId: t.strategyId,
    mode: t.mode,
    session: inSession(t.createdAt),
    closedAt: t.createdAt.toISOString(),
    pnlUsd: t.pnlUsd,
    rMultiple: t.rMultiple,
    closeReason: t.position?.closeReason ?? null,
    positionStatus: t.position?.status ?? null,
  }));

  console.log(`TARGET SESI: ${sessions.join(", ")}`);
  console.log(`MODE: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`trade cocok: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  #${r.tradeId} pos${r.positionId} ${r.symbol.padEnd(13)} ${String(r.strategyId).padEnd(7)} ${r.mode} ` +
      `sesi=${r.session} ${String(r.closeReason).padEnd(6)} pnl=${r.pnlUsd.toFixed(4)} R=${r.rMultiple.toFixed(3)} ` +
      `posStatus=${r.positionStatus}`,
    );
  }

  // Kekamanan: posisi yang tidak CLOSED TIDAK boleh ikut terhapus.
  const notClosed = rows.filter((r) => r.positionStatus !== "CLOSED");
  if (notClosed.length > 0) {
    console.error(`ABORT: ${notClosed.length} posisi bukan CLOSED — tidak dihapus: ` +
      notClosed.map((r) => `#${r.tradeId}/${r.symbol}:${r.positionStatus}`).join(", "));
    await db.$disconnect();
    process.exit(2);
  }

  const positionIds = rows.map((r) => r.positionId);
  const tradesBefore = await db.trade.count();
  const positionsBefore = await db.position.count();
  const learningsBefore = await db.learningEntry.count();
  const decisionLogsBefore = await db.decisionLog.count();
  const swingLogsBefore = await db.swingSignalLog.count();

  if (!apply) {
    console.log("\nDRY-RUN: tidak ada perubahan. Tambahkan --apply untuk eksekusi.");
    await db.$disconnect();
    return;
  }

  // Hapus Position -> Trade cascade; DecisionLog/SwingSignalLog/OrderExec/LearningEntry
  // hanya kehilangan relasi (SetNull), datanya tetap tersimpan.
  const deleted = await db.position.deleteMany({ where: { id: { in: positionIds } } });

  const tradesAfter = await db.trade.count();
  const positionsAfter = await db.position.count();
  const learningsAfter = await db.learningEntry.count();
  const decisionLogsAfter = await db.decisionLog.count();
  const swingLogsAfter = await db.swingSignalLog.count();

  await db.eventLog.create({
    data: {
      type: "MANUAL_PURGE_PAPER_SESSION",
      severity: "warn",
      payload: JSON.stringify({
        action: "PURGE_PAPER_SESSION_HISTORY",
        sessions,
        timestamp: new Date().toISOString(),
        positionsDeleted: deleted.count,
        tradesDeleted: tradesBefore - tradesAfter,
        learningEntriesPreserved: learningsAfter - learningsBefore,
        decisionLogsPreserved: decisionLogsAfter - decisionLogsBefore,
        swingSignalLogsPreserved: swingLogsAfter - swingLogsBefore,
        rows: rows.map((r) => ({ tradeId: r.tradeId, positionId: r.positionId, symbol: r.symbol, session: r.session, closeReason: r.closeReason, pnlUsd: r.pnlUsd })),
      }),
    },
  });

  console.log("\nHASIL:");
  console.log(`  posisi dihapus : ${deleted.count}`);
  console.log(`  trade dihapus  : ${tradesBefore - tradesAfter} (total ${tradesBefore} -> ${tradesAfter})`);
  console.log(`  posisi total   : ${positionsBefore} -> ${positionsAfter}`);
  console.log(`  LearningEntry  : ${learningsBefore} -> ${learningsAfter} (harus sama)`);
  console.log(`  DecisionLog    : ${decisionLogsBefore} -> ${decisionLogsAfter} (harus sama)`);
  console.log(`  SwingSignalLog : ${swingLogsBefore} -> ${swingLogsAfter} (harus sama)`);
  console.log("  EventLog audit : MANUAL_PURGE_PAPER_SESSION ditulis");

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("PURGE_FAILED:", err instanceof Error ? err.message : String(err));
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
