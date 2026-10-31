// Probe: are unlinked ENTRY_OPENED rows historical (predating link code) or active?
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });

process.stdout.write("== SwingSignalLog ENTRY_OPENED (all) ==\n");
for (const r of db.prepare(
  "SELECT id, symbol, side, strategyId, positionId, entryPrice, createdAt FROM SwingSignalLog WHERE decision='ENTRY_OPENED' ORDER BY id"
).all()) {
  process.stdout.write(`  #${r.id} ${r.symbol} ${r.side} ${r.strategyId} pos=${r.positionId} entry=${r.entryPrice} @ ${r.createdAt}\n`);
}

process.stdout.write("\n== Position (all) ==\n");
for (const r of db.prepare(
  "SELECT id, symbol, side, strategyId, status, entryPrice, openedAt FROM Position ORDER BY id"
).all()) {
  process.stdout.write(`  #${r.id} ${r.symbol} ${r.side} ${r.strategyId ?? "-"} ${r.status} entry=${r.entryPrice} @ ${r.openedAt}\n`);
}

process.stdout.write("\n== Trade (all) ==\n");
for (const r of db.prepare(
  "SELECT id, positionId, symbol, strategyId, createdAt FROM Trade ORDER BY id"
).all()) {
  process.stdout.write(`  #${r.id} pos=${r.positionId} ${r.symbol} ${r.strategyId ?? "-"} @ ${r.createdAt}\n`);
}

process.stdout.write("\n== DecisionLog createdAt range ==\n");
const dr = db.prepare("SELECT MIN(createdAt) a, MAX(createdAt) b, COUNT(*) n FROM DecisionLog").get();
process.stdout.write(`  ${dr.n} rows: ${dr.a} .. ${dr.b}\n`);
const sl = db.prepare("SELECT MIN(createdAt) a, MAX(createdAt) b, COUNT(*) n FROM SwingSignalLog").get();
process.stdout.write(`  SwingSignalLog ${sl.n} rows: ${sl.a} .. ${sl.b}\n`);
const eol = db.prepare("SELECT MIN(createdAt) a, MAX(createdAt) b FROM SwingSignalLog WHERE decision='ENTRY_OPENED'").get();
process.stdout.write(`  ENTRY_OPENED range: ${eol.a} .. ${eol.b}\n`);

db.close();
