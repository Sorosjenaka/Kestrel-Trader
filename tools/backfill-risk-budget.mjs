// tools/backfill-risk-budget.mjs
// Backfill Position.riskBudgetUsd + Trade.riskBudgetUsd dari outlookText lama.
//
// outlookText posisi ditulis di apps/server/src/exec/plannedEntry.ts:
//   "...; final estimated net stop risk $1.0000 with 60bps gap; PAPER"
// Angka itu = plan.estimatedNetRiskUsd (qty x netPerUnit) = budget NET yang
// benar-benar dipakai sizing. Itu denominator R yang diminta operator.
//
// Idempoten: hanya mengisi baris yang masih NULL. Tidak menyentuh rMultiple lama
// (basis jarak harga tetap utuh untuk audit). Cetak hitungan + contoh, bukan nilai rahasia.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";

const DB_PATH = resolveDbPath();
const MARK = "final estimated net stop risk $";

/** Ambil budget dari outlookText; null bila marker tidak ada / angka tidak valid. */
export function parseRiskBudgetFromOutlook(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const i = text.indexOf(MARK);
  if (i < 0) return null;
  const rest = text.slice(i + MARK.length);
  const j = rest.indexOf(" with ");
  if (j < 0) return null;
  const num = Number(rest.slice(0, j));
  return Number.isFinite(num) && num > 0 ? num : null;
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 8000;");

const hasCol = (table, name) =>
  db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === name);
if (!hasCol("Position", "riskBudgetUsd") || !hasCol("Trade", "riskBudgetUsd")) {
  console.error("Kolom riskBudgetUsd belum ada — jalankan migrasi dulu:");
  console.error("  node tools/apply-migration.mjs 20260929000100_risk_budget_normalization");
  db.close();
  process.exit(2);
}

const rows = db
  .prepare(`SELECT id, symbol, outlookText FROM Position WHERE riskBudgetUsd IS NULL`)
  .all();

let filled = 0;
let skipped = 0;
const upd = db.prepare(`UPDATE Position SET riskBudgetUsd = ? WHERE id = ?`);
for (const r of rows) {
  const budget = parseRiskBudgetFromOutlook(r.outlookText);
  if (budget === null) {
    skipped++;
    continue;
  }
  upd.run(budget, r.id);
  filled++;
}

// Turunkan ke Trade lewat relasi 1-1 positionId.
const tradeUpd = db
  .prepare(
    `UPDATE Trade SET riskBudgetUsd = (
       SELECT p.riskBudgetUsd FROM Position p WHERE p.id = Trade.positionId
     )
     WHERE riskBudgetUsd IS NULL
       AND (SELECT p.riskBudgetUsd FROM Position p WHERE p.id = Trade.positionId) IS NOT NULL`
  )
  .run();

const stats = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM Position) AS pos_total,
       (SELECT COUNT(*) FROM Position WHERE riskBudgetUsd IS NOT NULL) AS pos_budget,
       (SELECT COUNT(*) FROM Trade) AS trade_total,
       (SELECT COUNT(*) FROM Trade WHERE riskBudgetUsd IS NOT NULL) AS trade_budget`
  )
  .get();

console.log(`position  : budget terisi ${stats.pos_budget}/${stats.pos_total} (baru ${filled}, dilewati ${skipped})`);
console.log(`trade     : budget terisi ${stats.trade_budget}/${stats.trade_total} (baru ${tradeUpd.changes})`);
console.log(`tanpa marker outlookText = ${skipped} posisi (budget tetap NULL, R fallback ke basis jarak harga)`);
db.close();