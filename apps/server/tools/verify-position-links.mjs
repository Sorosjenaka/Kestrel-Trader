// Verify T0.3 applied links + learning-loop JOIN.
import { DatabaseSync } from "node:sqlite";
import { resolveDbPath } from "../../../tools/db-path.mjs";
const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const one = (sql) => JSON.stringify(db.prepare(sql).all());

console.log("ENTRY_OPENED still-null (expect 8 orphans):",
  one(`SELECT COUNT(*) n FROM SwingSignalLog WHERE decision='ENTRY_OPENED' AND positionId IS NULL`));
console.log("JOIN SL->Pos->Trade:",
  one(`SELECT s.id, s.symbol, s.positionId, t.id tradeId, t.strategyId
       FROM SwingSignalLog s JOIN Position p ON p.id=s.positionId JOIN Trade t ON t.positionId=p.id`));
console.log("DecisionLog GO unlinked (expect 0):",
  one(`SELECT COUNT(*) n FROM DecisionLog WHERE decision='GO' AND positionId IS NULL`));
console.log("DecisionLog GO linked (expect 0 rows exist):",
  one(`SELECT COUNT(*) n FROM DecisionLog WHERE decision='GO' AND positionId IS NOT NULL`));
console.log("DL linked total (any decision):",
  one(`SELECT COUNT(*) n FROM DecisionLog WHERE positionId IS NOT NULL`));
db.close();
