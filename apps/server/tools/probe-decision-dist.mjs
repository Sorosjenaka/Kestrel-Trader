// Probe: decision distribution vs positionId linking (T0.3 diagnosis).
import { DatabaseSync } from "node:sqlite";
const path = process.argv[2];
const db = new DatabaseSync(path, { readOnly: true });

const dist = (table) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const hasMode = cols.includes("mode");
  const rows = db.prepare(
    `SELECT decision, COUNT(*) n, SUM(positionId IS NOT NULL) linked, SUM(CASE WHEN positionId IS NULL THEN 1 ELSE 0 END) unlinked FROM ${table} GROUP BY decision`
  ).all();
  process.stdout.write(`\n== ${table} by decision ==\n`);
  for (const r of rows) {
    process.stdout.write(`  ${r.decision}: n=${r.n} linked=${r.linked ?? 0} unlinked=${r.unlinked ?? 0}\n`);
  }
  if (hasMode) {
    const m = db.prepare(`SELECT mode, decision, COUNT(*) n FROM ${table} GROUP BY mode, decision`).all();
    process.stdout.write(`  -- by mode --\n`);
    for (const r of m) process.stdout.write(`  ${r.mode} ${r.decision}: ${r.n}\n`);
  }
};

dist("DecisionLog");
dist("SwingSignalLog");

// Do Position/Trade rows exist that a GO/ENTRY_OPENED should have linked to?
const pos = db.prepare("SELECT COUNT(*) n FROM Position").get();
const tr = db.prepare("SELECT COUNT(*) n FROM Trade").get();
process.stdout.write(`\nPosition=${pos.n} Trade=${tr.n}\n`);

const goLinked = db.prepare(
  "SELECT COUNT(*) n FROM DecisionLog WHERE decision='GO'"
).get();
const eol = db.prepare(
  "SELECT COUNT(*) n FROM SwingSignalLog WHERE decision='ENTRY_OPENED'"
).get();
process.stdout.write(`DecisionLog GO total=${goLinked.n}\n`);
process.stdout.write(`SwingSignalLog ENTRY_OPENED total=${eol.n}\n`);

// Any GO/ENTRY_OPENED that is NOT linked?
const goUnlinked = db.prepare(
  "SELECT id, symbol, positionId FROM DecisionLog WHERE decision='GO' AND positionId IS NULL ORDER BY id DESC LIMIT 10"
).all();
process.stdout.write(`\nGO unlinked (limit 10):\n`);
for (const r of goUnlinked) process.stdout.write(`  #${r.id} ${r.symbol} pos=${r.positionId}\n`);
const eolUnlinked = db.prepare(
  "SELECT id, symbol, positionId FROM SwingSignalLog WHERE decision='ENTRY_OPENED' AND positionId IS NULL ORDER BY id DESC LIMIT 10"
).all();
process.stdout.write(`\nENTRY_OPENED unlinked (limit 10):\n`);
for (const r of eolUnlinked) process.stdout.write(`  #${r.id} ${r.symbol} pos=${r.positionId}\n`);

db.close();
