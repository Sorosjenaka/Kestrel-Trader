// tools/trade-audit.mjs - Audit provenance trade/posisi: cari data dummy/mock + rincian entry & exit.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";

const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);

console.log("=== Ringkasan ===");
console.log({
  positions: db.prepare("SELECT COUNT(*) c FROM Position").get().c,
  trades: db.prepare("SELECT COUNT(*) c FROM Trade").get().c,
  orders: db.prepare("SELECT COUNT(*) c FROM OrderExec").get().c,
});

console.log("\n=== Kandidat DUMMY (harga mock / teks demo / simbol test) ===");
const dummy = q(
  `SELECT id, symbol, entryPrice, slPrice, tp1Price, tp2Price, status, closeReason, outlookText
   FROM Position
   WHERE entryPrice IN (3000, 60000, 62000, 100, 50000, 1000)
      OR symbol LIKE 'TEST%' OR symbol LIKE 'MOCK%' OR symbol LIKE 'DEMO%'
      OR outlookText LIKE '%tervalidasi%'
      OR outlookText = ''`
);
for (const r of dummy) console.log(` #${r.id} ${r.symbol} entry=${r.entryPrice} status=${r.status} reason=${r.closeReason} :: ${String(r.outlookText).slice(0, 60)}`);
console.log(`total kandidat dummy: ${dummy.length}`);

console.log("\n=== Event demo/mock ===");
for (const r of q(`SELECT type, COUNT(*) c FROM EventLog WHERE type LIKE '%DEMO%' OR type LIKE '%MOCK%' OR type LIKE '%PIPELINE%' OR type LIKE '%DISARMED%' GROUP BY type`)) {
  console.log(` ${r.type}: ${r.c}`);
}

console.log("\n=== Rincian 3 trade terakhir (entry & exit) ===");
for (const t of q(`SELECT * FROM Trade ORDER BY id DESC LIMIT 3`)) {
  console.log(`\nTrade #${t.id} ${t.symbol} ${t.side} ${t.mode} | strategy=${t.strategyId ?? "-"} | win=${t.win} r=${t.rMultiple} net=$${t.pnlUsd} fee=$${t.feeUsd} hold=${t.holdMinutes}m`);
  const pos = db.prepare("SELECT * FROM Position WHERE id = ?").get(t.positionId);
  if (pos) {
    console.log(`  Position #${pos.id} entry=${pos.entryPrice} sl=${pos.slPrice} tp1=${pos.tp1Price} tp2=${pos.tp2Price}`);
    console.log(`  exit=${t.exitAvg} reason=${pos.closeReason} beMoved=${pos.beMoved} tp1Fill=${pos.tp1FillPrice} realized=${pos.realizedPnlUsd}`);
    console.log(`  strategi=${pos.strategyId ?? "-"} POI=${pos.zoneType ?? "-"} ${pos.zoneBottom ?? ""}-${pos.zoneTop ?? ""} trail=${pos.trailActive}`);
  }
  for (const o of db.prepare("SELECT * FROM OrderExec WHERE positionId = ? ORDER BY id").all(t.positionId)) {
    console.log(`  fill: ${o.side} ${o.type} qty=${o.qty} @ ${o.fillPrice ?? o.price} reduceOnly=${o.reduceOnly ? 1 : 0} fee=$${o.feeUsd} status=${o.status} id=${o.binanceOrderId}`);
  }
}
db.close();
