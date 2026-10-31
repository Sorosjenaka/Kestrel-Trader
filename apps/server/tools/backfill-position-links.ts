// tools/backfill-position-links.ts — T0.3 (18 Okt 2026): pemulihan kaitan positionId.
//
// Hanya MENGISSI kolom positionId yang masih NULL pada DecisionLog & SwingSignalLog.
// Tidak pernah menimpa kaitan yang sudah ada, tidak pernah menyentuh Position/Trade,
// tidak pernah mengarang kaitan saat kandidat ambigu / tidak ada (lihat
// linkPositionIds.ts). Default = DRY-RUN (cetak rencana, tanpa tulis). Tambah
// argumen --apply untuk benar-benar menulis. Argumen kedua = path DB.
//
//   npx tsx tools/backfill-position-links.ts                       # dry-run DB app
//   npx tsx tools/backfill-position-links.ts --apply               # tulis DB app
//   npx tsx tools/backfill-position-links.ts --apply <path.db>     # tulis DB eksplisit
//
// Hanya baris decision yang BENAR-BENAR membuka posisi yang ditautkan:
//   SwingSignalLog: decision='ENTRY_OPENED'
//   DecisionLog   : decision='GO'
// (NO_GO / SKIPPED / ENTRY_REJECTED / SKIP_ENTRY_GAP / SIGNAL_NO_PLAN tidak pernah
//  membuka posisi -> dibiarkan NULL, itu memang benar.)

import { DatabaseSync } from "node:sqlite";
import { planLinks, toEpochMs, type LinkableLogRow, type LinkablePositionRow } from "../src/learning/linkPositionIds.js";
import { resolveDbPath } from "../../../tools/db-path.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPath = args.find((a) => !a.startsWith("--"));

function resolveDefaultDb(): string {
  // Pakai DATABASE_URL bila disetel; selain itu lokasi data/ standar repo.
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("file:")) return url.slice("file:".length);
  return resolveDbPath();
}

const target = dbPath ?? resolveDefaultDb();
process.stdout.write(`DB        : ${target}\n`);
process.stdout.write(`Mode      : ${apply ? "APPLY (menulis)" : "DRY-RUN (tidak menulis)"}\n`);

const db = new DatabaseSync(target);
try {
  // Baca kandidat posisi sekali.
  const positions: LinkablePositionRow[] = db
    .prepare("SELECT id, symbol, side, strategyId, entryPrice, openedAt FROM Position")
    .all()
    .map((r: any) => ({
      id: Number(r.id),
      symbol: String(r.symbol),
      side: String(r.side),
      strategyId: r.strategyId == null ? null : String(r.strategyId),
      entryPrice: Number(r.entryPrice),
      openedAtMs: toEpochMs(r.openedAt),
    }));
  process.stdout.write(`Position  : ${positions.length} kandidat\n`);

  const jobs = [
    {
      table: "SwingSignalLog",
      select: "SELECT id, symbol, side, strategyId, entryPrice, createdAt FROM SwingSignalLog WHERE decision='ENTRY_OPENED' AND positionId IS NULL",
      toRow: (r: any): LinkableLogRow => ({
        id: Number(r.id), symbol: String(r.symbol), side: String(r.side),
        strategyId: r.strategyId == null ? null : String(r.strategyId),
        entryPrice: r.entryPrice == null ? null : Number(r.entryPrice),
        createdAtMs: toEpochMs(r.createdAt), positionId: null,
      }),
    },
    {
      table: "DecisionLog",
      select: "SELECT id, symbol, side, strategyId, createdAt FROM DecisionLog WHERE decision='GO' AND positionId IS NULL",
      toRow: (r: any): LinkableLogRow => ({
        id: Number(r.id), symbol: String(r.symbol), side: String(r.side),
        strategyId: r.strategyId == null ? null : String(r.strategyId),
        entryPrice: null,
        createdAtMs: toEpochMs(r.createdAt), positionId: null,
      }),
    },
  ];

  let totalWrites = 0;
  for (const job of jobs) {
    const rows: LinkableLogRow[] = db.prepare(job.select).all().map(job.toRow);
    process.stdout.write(`\n== ${job.table} ==\n`);
    process.stdout.write(`  baris perlu taut (decision terkait + positionId NULL): ${rows.length}\n`);
    if (rows.length === 0) continue;

    const { updates, unlinked } = planLinks(rows, positions);
    process.stdout.write(`  MATCHED   : ${updates.length}\n`);
    for (const u of updates) process.stdout.write(`    log#${u.logId} -> Position#${u.positionId}\n`);
    const byReason = new Map<string, number>();
    for (const u of unlinked) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
    process.stdout.write(`  UNLINKED  : ${unlinked.length} (${[...byReason].map(([k, v]) => `${k}=${v}`).join(", ")})\n`);

    if (apply && updates.length > 0) {
      const stmt = db.prepare(`UPDATE ${job.table} SET positionId = ? WHERE id = ? AND positionId IS NULL`);
      db.exec("BEGIN");
      try {
        for (const u of updates) stmt.run(u.positionId, u.logId);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      totalWrites += updates.length;
    }
  }

  process.stdout.write(`\n${apply ? `Selesai. ${totalWrites} baris ditautkan.` : "Dry-run selesai. Tidak ada yang ditulis. Jalankan lagi dengan --apply."}\n`);
} finally {
  db.close();
}
