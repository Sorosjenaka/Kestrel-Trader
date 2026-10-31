// tools/purge-invalid-symbols.mjs — hapus posisi dgn simbol INVALID (non-alfanumerik/CJK/emoji)
// Contoh nyata 25 Sep 2026: "龙虾USDT" (lobster) lolos feed & dibuka bot S-00.
// Order Exec PAPER SIM_* — bukan order bursa nyata. Aman dihapus total.
// JALANKAN: node tools/purge-invalid-symbols.mjs [--apply]
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync(resolveDbPath(), { readOnly: !APPLY });
if (APPLY) db.exec("PRAGMA busy_timeout = 8000;");
const q = (sql) => db.prepare(sql).all();
const okFmt = (s) => /^[A-Z0-9]{2,12}USDT$/.test(String(s));
console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
const bad = q("SELECT id,symbol,status FROM Position").filter(r=>!okFmt(r.symbol));
console.log(`posisi simbol INVALID: ${bad.length}`);
for (const r of bad) {
  const fills = q(`SELECT id,side,type,qty,price FROM OrderExec WHERE positionId=${r.id}`);
  console.log(`  #${r.id} ${r.symbol} ${r.status} fills=${fills.length}`, JSON.stringify(fills.slice(0,4)));
}
if (!APPLY) { console.log("DRY-RUN selesai. --apply utk hapus."); db.close(); process.exit(0); }
for (const r of bad) {
  db.prepare("DELETE FROM OrderExec WHERE positionId=?").run(r.id);
  const t = db.prepare("DELETE FROM Trade WHERE positionId=?").run(r.id);
  db.prepare("DELETE FROM Position WHERE id=?").run(r.id);
  console.log(`  HAPUS posisi #${r.id} ${r.symbol} (+${t.changes} trade)`);
  db.prepare("INSERT INTO EventLog (type,severity,payload,createdAt) VALUES (?,?,?,?)").run("INVALID_SYMBOL_PURGED","warn",JSON.stringify({positionId:r.id,symbol:r.symbol,reason:"SYMBOL_FORMAT_INVALID_CJK",action:"CLOSE_AND_PURGE_INVALID"}), Date.now());
}
console.log("OPEN sekarang:", db.prepare("SELECT COUNT(*) c FROM Position WHERE status='OPEN'").get().c);
db.close();
