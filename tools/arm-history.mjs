// tools/arm-history.mjs — siapa/apa yang mengubah ARM & kapan (audit EventLog)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";
const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
const q = (sql) => db.prepare(sql).all();
const wib = (d) => new Date(d).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",hour12:false});
console.log("== Setting arm_status sekarang ==");
console.log(JSON.stringify(q("SELECT key,value,updatedAt FROM Setting WHERE key='arm_status'")));
console.log("\n== Riwayat event ARM ==");
for (const r of q("SELECT id,type,severity,payload,createdAt FROM EventLog WHERE type LIKE '%ARM%' ORDER BY id DESC LIMIT 20")) {
  console.log(`#${r.id} ${wib(r.createdAt)} ${r.type} :: ${String(r.payload).slice(0,220)}`);
}
console.log("\n== Event KILL / RESET terakhir ==");
for (const r of q("SELECT id,type,payload,createdAt FROM EventLog WHERE type LIKE '%KILL%' OR type LIKE '%RESET%' ORDER BY id DESC LIMIT 8")) {
  console.log(`#${r.id} ${wib(r.createdAt)} ${r.type} :: ${String(r.payload).slice(0,200)}`);
}
db.close();
