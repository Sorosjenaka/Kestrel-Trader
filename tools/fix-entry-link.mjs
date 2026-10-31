// tools/fix-entry-link.mjs
// PERBAIKAN (bukan hapus histori valid):
// 1. Hapus 1 order DUMMY BTCUSDT @60000 (harga mock, posisi MANUAL BTC @84080.8) — TIDAK tersambung ke posisi manapun.
// 2. Sambungkan kembali (relink) fill ENTRY (BUY MARKET, positionId NULL krn bug executor)
//    ke Position yg cocok 1:1 (simbol + harga persis) — berlaku utk posisi CLOSED maupun OPEN.
//    Tanpa ini panel DETAIL entry kosong (entryAvg jatuh ke recordedPrice).
// 3. Backfill Trade.source NULL -> 'LIVE_AI' (posisinya LIVE_AI), supaya lolos filter Prisma {not:DEMO} dan tampil di dashboard.
// JALANKAN: node tools/fix-entry-link.mjs [--apply]
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveDbPath } from "./db-path.mjs";
const APPLY = process.argv.includes("--apply");
const file = resolveDbPath();
const db = new DatabaseSync(file, { readOnly: !APPLY });
if (APPLY) db.exec("PRAGMA busy_timeout = 8000;");
const q = (sql) => db.prepare(sql).all();
console.log(`DB: ${file} | mode: ${APPLY ? "APPLY (menulis)" : "DRY-RUN (cek saja)"}`);

// 1) dummy BTC 60000
const dummies = q("SELECT id,clientOrderId,symbol,price,qty FROM OrderExec WHERE symbol='BTCUSDT' AND price=60000");
console.log(`\n[1] kandidat DUMMY BTC@60000: ${dummies.length}`);
for (const d of dummies) console.log("   ", JSON.stringify(d));
const manualBtc = db.prepare("SELECT id,symbol,entryPrice,status FROM Position WHERE symbol='BTCUSDT'").get();
console.log("    posisi BTC aktual:", JSON.stringify(manualBtc));

// 2) relink orphan BUY MARKET ke posisi (simbol+harga persis 1:1)
const orphans = q("SELECT id,symbol,price FROM OrderExec WHERE positionId IS NULL AND side='BUY' AND type='MARKET' AND NOT (symbol='BTCUSDT' AND price=60000)");
const positions = q("SELECT id,symbol,entryPrice,status FROM Position ORDER BY id");
const byKey = new Map();
for (const p of positions) {
  const k = `${p.symbol}|${p.entryPrice}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(p);
}
let ok = 0; const multi = []; const nolink = [];
for (const o of orphans) {
  const cands = byKey.get(`${o.symbol}|${o.price}`) ?? [];
  if (cands.length === 1) ok++;
  else if (cands.length === 0) nolink.push(o);
  else multi.push({ o, cands });
}
console.log(`\n[2] orphan BUY MARKET (non-dummy): ${orphans.length} -> relink 1:1 = ${ok}, multi = ${multi.length}, nolink = ${nolink.length}`);
for (const m of multi.slice(0,10)) console.log("    MULTI:", JSON.stringify({ ord: m.o.id, sym: m.o.symbol, price: m.o.price, pos: m.cands.map(c=>c.id) }));
for (const o of nolink.slice(0,10)) console.log("    NOLINK:", JSON.stringify(o));

// 3) backfill trade source NULL
const nullTrades = q("SELECT t.id,t.symbol,p.source psrc FROM Trade t JOIN Position p ON p.id=t.positionId WHERE t.source IS NULL");
console.log(`\n[3] Trade.source NULL: ${nullTrades.length}`);
for (const t of nullTrades) console.log("   ", JSON.stringify(t));

if (!APPLY) { console.log("\nDRY-RUN selesai. Jalankan ulang dengan --apply untuk menulis."); db.close(); process.exit(0); }

// --- APPLY ---
const del = db.prepare("DELETE FROM OrderExec WHERE symbol='BTCUSDT' AND price=60000").run();
console.log(`\nHAPUS dummy BTC@60000: ${del.changes} baris`);
let relinked = 0;
const upd = db.prepare("UPDATE OrderExec SET positionId=? WHERE id=?");
for (const o of orphans) {
  const cands = byKey.get(`${o.symbol}|${o.price}`) ?? [];
  if (cands.length === 1) { upd.run(cands[0].id, o.id); relinked++; }
}
console.log(`RELINK entry fills: ${relinked} baris tersambung ke posisinya`);
const bf = db.prepare("UPDATE Trade SET source='LIVE_AI' WHERE source IS NULL").run();
console.log(`BACKFILL Trade.source NULL->LIVE_AI: ${bf.changes} baris`);
// verifikasi
console.log("\n== VERIFIKASI ==");
console.log("dummy sisa:", q("SELECT COUNT(*) c FROM OrderExec WHERE symbol='BTCUSDT' AND price=60000")[0].c);
console.log("orphan BUY sisa:", q("SELECT COUNT(*) c FROM OrderExec WHERE positionId IS NULL AND side='BUY'")[0].c);
console.log("Trade NULL sisa:", q("SELECT COUNT(*) c FROM Trade WHERE source IS NULL")[0].c);
console.log("counts:", JSON.stringify({ trade: q("SELECT COUNT(*) c FROM Trade")[0].c, pos: q("SELECT COUNT(*) c FROM Position")[0].c, ord: q("SELECT COUNT(*) c FROM OrderExec")[0].c }));
db.close();
