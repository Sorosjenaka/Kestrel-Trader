// Probe: DecisionLog / SwingSignalLog positionId link state (T0.3 audit).
import { DatabaseSync } from "node:sqlite";

const dbs = process.argv.slice(2);
for (const path of dbs) {
  process.stdout.write(`=== ${path} ===\n`);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    process.stdout.write(`  open err: ${e.message}\n`);
    continue;
  }
  try {
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('DecisionLog','SwingSignalLog','Trade','Position')"
    ).all();
    process.stdout.write(`  tables: ${t.map((x) => x.name).join(",") || "(none)"}\n`);
    for (const name of ["DecisionLog", "SwingSignalLog"]) {
      if (!t.some((x) => x.name === name)) continue;
      const r = db.prepare(`SELECT COUNT(*) total, SUM(positionId IS NOT NULL) linked FROM ${name}`).get();
      process.stdout.write(`  ${name}: total=${r.total} linked=${r.linked ?? 0}\n`);
      const recent = db.prepare(
        `SELECT id, symbol, decision, positionId FROM ${name} ORDER BY id DESC LIMIT 3`
      ).all();
      for (const row of recent) {
        process.stdout.write(`    #${row.id} ${row.symbol} ${row.decision} pos=${row.positionId}\n`);
      }
    }
  } catch (e) {
    process.stdout.write(`  query err: ${e.message}\n`);
  } finally {
    db.close();
  }
}
